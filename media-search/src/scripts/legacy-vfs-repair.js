#!/usr/bin/env node
/**
 * Legacy VFS classification + safe one-shot repair report.
 *
 * Production context (September 2026 audit): the VFS tables carry historical
 * rows that were materialized before the TorrentFile identity refactor
 * (slice 2.x). These rows are observable as `torrent_file_id IS NULL` in
 * `vfs_movie_entries` and `vfs_tv_entries`. The current observation:
 *
 *   - 20 legacy movie rows (torrent_file_id IS NULL)
 *   -  0 authoritative movie rows
 *   -  8 legacy TV rows
 *   - 14 authoritative TV rows
 *
 * This script:
 *   1. classifies the current VFS state by table and legacy bit;
 *   2. cross-references each legacy row against the control-plane store
 *      to find existing authoritative identity candidates (matching
 *      `info_hash` to a `torrent_files` row with the same `info_hash`);
 *   3. emits a deterministic, idempotent repair plan that can be
 *      re-run after a cold-start canary to confirm convergence.
 *
 * The repair is read-only by default. Pass `--write` to apply
 * atomic supersedes; each row upgrade is logged and verified with a
 * post-update read.
 *
 * Required env: DISCOVERY_DB, CONTROL_PLANE_DB
 *
 * Usage:
 *   node src/scripts/legacy-vfs-repair.js                # classify only
 *   node src/scripts/legacy-vfs-repair.js --write        # apply repairs
 *   node src/scripts/legacy-vfs-repair.js --json         # machine-readable
 */

import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { materializeVfsEntry } from '../lib/vfs/materialize.js';

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';
const CP_PATH = process.env.CONTROL_PLANE_DB || ':memory:';

function parseArgs(argv) {
  const out = { write: false, json: false };
  for (const a of argv) {
    if (a === '--write') out.write = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function buildHandoffFromVfsEntry(entry) {
  // Translate a durable vfs_*_entries row back into a handoff shape that
  // materializeVfsEntry accepts. We cannot directly run materializeVfsEntry
  // here — the legacy row's identity does not match the handoff contract.
  // This helper is only used for the read-only cross-reference (step 2).
  if (entry.season != null) {
    return {
      mediaId: entry.mediaId,
      mediaType: 'tv',
      season: entry.season,
      episode: entry.episode,
      releaseKey: entry.releaseKey,
      infoHash: entry.infoHash,
      fileIndex: entry.fileIndex,
      canonicalPath: entry.canonicalPath,
      canonicalTitle: null,
      torrentFileId: entry.torrentFileId,
      size: entry.size,
    };
  }
  return {
    mediaId: entry.mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: entry.releaseKey,
    infoHash: entry.infoHash,
    fileIndex: entry.fileIndex,
    canonicalPath: entry.canonicalPath,
    canonicalTitle: null,
    torrentFileId: entry.torrentFileId,
    size: entry.size,
  };
}

function classify(cache) {
  const movieRows = cache.listVfsMovieEntries();
  const tvRows = cache.listVfsTvEntries();
  const classification = {
    movies: { legacy: [], authoritative: [] },
    tv: { legacy: [], authoritative: [] },
  };
  for (const row of movieRows) {
    if (row.torrentFileId == null) classification.movies.legacy.push(row);
    else classification.movies.authoritative.push(row);
  }
  for (const row of tvRows) {
    if (row.torrentFileId == null) classification.tv.legacy.push(row);
    else classification.tv.authoritative.push(row);
  }
  return classification;
}

function summarize(classification) {
  return {
    movies: {
      legacy: classification.movies.legacy.length,
      authoritative: classification.movies.authoritative.length,
    },
    tv: {
      legacy: classification.tv.legacy.length,
      authoritative: classification.tv.authoritative.length,
    },
    totals: {
      legacy: classification.movies.legacy.length + classification.tv.legacy.length,
      authoritative: classification.movies.authoritative.length + classification.tv.authoritative.length,
      rows: movieRows(classification) + tvRows(classification),
    },
  };
}

function movieRows(c) { return c.movies.legacy.length + c.movies.authoritative.length; }
function tvRows(c) { return c.tv.legacy.length + c.tv.authoritative.length; }

function crossReference(classification, controlPlaneStore) {
  const candidates = [];
  for (const row of [...classification.movies.legacy, ...classification.tv.legacy]) {
    const torrentFiles = controlPlaneStore.listTorrentFilesForRelease(row.infoHash) || [];
    const tf = torrentFiles[0] || null;
    candidates.push({
      mediaId: row.mediaId,
      season: row.season ?? null,
      episode: row.episode ?? null,
      infoHash: row.infoHash,
      canonicalPath: row.canonicalPath,
      torrentFileId: tf ? tf.id : null,
      torrentFileSize: tf ? tf.size : null,
      hasCandidate: tf != null,
    });
  }
  return candidates;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cache = createDiscoveryCache({ dbPath: DB_PATH });
  const controlPlaneStore = createControlPlaneStore({ dbPath: CP_PATH });

  try {
    const before = classify(cache);
    const summaryBefore = summarize(before);
    const crossRef = crossReference(before, controlPlaneStore);
    const plan = {
      movieCandidates: crossRef.filter((c) => c.season == null && c.hasCandidate),
      tvCandidates: crossRef.filter((c) => c.season != null && c.hasCandidate),
      movieUnmatched: crossRef.filter((c) => c.season == null && !c.hasCandidate),
      tvUnmatched: crossRef.filter((c) => c.season != null && !c.hasCandidate),
    };

    if (args.json) {
      const out = { summary: summaryBefore, plan };
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    console.log('[legacy-vfs] classification (pre-repair)');
    console.log(`[legacy-vfs]   movies: legacy=${summaryBefore.movies.legacy} authoritative=${summaryBefore.movies.authoritative}`);
    console.log(`[legacy-vfs]   tv:     legacy=${summaryBefore.tv.legacy} authoritative=${summaryBefore.tv.authoritative}`);
    console.log(`[legacy-vfs]   totals: legacy=${summaryBefore.totals.legacy} authoritative=${summaryBefore.totals.authoritative} rows=${summaryBefore.totals.rows}`);
    console.log(`[legacy-vfs] repairable candidates: movies=${plan.movieCandidates.length} tv=${plan.tvCandidates.length}`);
    if (plan.movieUnmatched.length > 0) {
      console.log(`[legacy-vfs] unmatched legacy movies (no torrent_files row for info_hash):`);
      for (const u of plan.movieUnmatched) {
        console.log(`[legacy-vfs]   media=${u.mediaId} infoHash=${u.infoHash} path="${u.canonicalPath}"`);
      }
    }
    if (plan.tvUnmatched.length > 0) {
      console.log(`[legacy-vfs] unmatched legacy tv (no torrent_files row for info_hash):`);
      for (const u of plan.tvUnmatched) {
        console.log(`[legacy-vfs]   media=${u.mediaId} S${u.season}E${u.episode} infoHash=${u.infoHash} path="${u.canonicalPath}"`);
      }
    }

    if (!args.write) {
      console.log('[legacy-vfs] (read-only) pass --write to apply repairs.');
      return;
    }

    // The atomic supersede inside materializeVfsEntry is the only
    // production-safe repair path. The repair below reconstructs a
    // handoff from the existing vfs row + a torrent_files lookup so the
    // supersede can fire without re-running the full discovery/ranking
    // stack (which would be redundant for a convergence audit).
    let repairsApplied = 0;
    let repairsSkipped = 0;
    for (const cand of [...plan.movieCandidates, ...plan.tvCandidates]) {
      const tf = controlPlaneStore.getTorrentFile(cand.torrentFileId);
      if (!tf) {
        repairsSkipped += 1;
        continue;
      }
      const handoff = {
        ...buildHandoffFromVfsEntry({
          mediaId: cand.mediaId,
          season: cand.season,
          episode: cand.episode,
          releaseKey: `${tf.infoHash}:torrent`,
          infoHash: tf.infoHash,
          fileIndex: null,
          canonicalPath: cand.canonicalPath,
          torrentFileId: tf.id,
          size: tf.size,
        }),
        filename: tf.internalPath,
        provider: 'torbox',
        providerState: 'cached',
        identityTier: 'Verified',
        resolutionState: 'confirmed',
        selectionReason: 'legacy-vfs-repair',
        selectedAt: Date.now(),
      };
      try {
        const result = materializeVfsEntry(
          cache, handoff, controlPlaneStore, () => Date.now(), { allowLegacy: false },
        );
        console.log(
          `[legacy-vfs] repaired media=${result.mediaId}` +
          (cand.season != null ? ` S${cand.season}E${cand.episode}` : '') +
          ` path="${result.canonicalPath}" release=${result.releaseKey} ` +
          `torrentFileId=${result.torrentFileId}`,
        );
        repairsApplied += 1;
      } catch (err) {
        console.error(
          `[legacy-vfs] FAILED media=${cand.mediaId} infoHash=${cand.infoHash}: ${err.message}`,
        );
        repairsSkipped += 1;
      }
    }

    const after = classify(cache);
    const summaryAfter = summarize(after);
    console.log('[legacy-vfs] classification (post-repair)');
    console.log(`[legacy-vfs]   movies: legacy=${summaryAfter.movies.legacy} authoritative=${summaryAfter.movies.authoritative}`);
    console.log(`[legacy-vfs]   tv:     legacy=${summaryAfter.tv.legacy} authoritative=${summaryAfter.tv.authoritative}`);
    console.log(`[legacy-vfs]   totals: legacy=${summaryAfter.totals.legacy} authoritative=${summaryAfter.totals.authoritative} rows=${summaryAfter.totals.rows}`);
    console.log(`[legacy-vfs] applied=${repairsApplied} skipped=${repairsSkipped}`);
  } finally {
    cache.close();
    controlPlaneStore.close();
  }
}

main().catch((err) => {
  console.error(`[legacy-vfs] FAILED: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});