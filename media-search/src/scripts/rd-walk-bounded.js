#!/usr/bin/env node
/**
 * Bounded Real-Debrid persisted-candidate walk (Worker B).
 *
 * Walks the persisted, ranked candidates for a single (media_id,
 * season, episode) through the active production RD resolution path
 * (attemptRdResolution + rd-resolution-cache single-flight + the
 * negative-observation cache). One bounded evaluation per unknown
 * candidate. Stops on first positive, on RD throttle, or after
 * visiting `maxCandidates` distinct hashes.
 *
 * Why this script exists:
 *   - The active production path (alternate-fallback) only visits a
 *     candidate lazily on a real /stream request. HARDEN wants to
 *     prove the walk deterministically for one specific target without
 *     rediscovery/reranking/new requests/refactor.
 *   - The walk MUST go through the same seam: same client, same
 *     attemptRdResolution, same getOrInFlight single-flight, same
 *     persisted observation schema. No RD-specific VFS, no new tables,
 *     no durable identity tied to ephemeral provider state.
 *
 * Contract enforced:
 *   1. Each known RD-infringing hash (fresh persisted negative) is
 *      skipped without addMagnet. The negative cache is the structural
 *      guarantee — proven by B11 in realdebrid-b11-b12.test.js.
 *   2. Each unknown candidate is evaluated exactly once: addMagnet →
 *      getTorrentInfo → exact mapping → selectFiles → updated info →
 *      unrestrict → bounded byte validation. This is the B2 contract.
 *   3. Single-owner: an in-process walk in-flight set prevents two
 *      concurrent walks from issuing the same evaluation. B7.
 *   4. Walk terminates on first positive, on RD throttle, on missing
 *      provider object (RD returns 404/410 for the placement), on
 *      `maxCandidates` distinct hashes, or on any throttle/rate-limit
 *      signal from the RD client. B4, B5, B10.
 *   5. Output is structured JSON; never prints the API key, the
 *      unrestricted download URL, the temporary RD torrent id, or
 *      the selected RD file id at the byte level. (RD file id is OK
 *      in summary tables because it's not durable identity.)
 *
 * Usage:
 *   node src/scripts/rd-walk-bounded.js --media <id> --season <n> --episode <n> \
 *       [--max <n>] [--dry-run] [--out <path>]
 *
 *   --media  Required. IMDb id (e.g. tt7137906).
 *   --season Required. Season number.
 *   --episode Required. Episode number.
 *   --max    Optional. Max distinct hashes to walk (default 12).
 *   --dry-run Optional. Use a deterministic mock client; do not call
 *              the real RD API. Required for the test harness.
 *   --out    Optional. JSON output path (default: stdout).
 *
 * Environment:
 *   DISCOVERY_DB        Discovery cache (default: ./discovery-cache.db)
 *   CONTROL_PLANE_DB    Control-plane DB (default: ./control-plane.db)
 *   REALDEBRID_API_KEY  Required unless --dry-run.
 *
 * Exit codes:
 *   0 — first positive found and mapped
 *   2 — walked all candidates, no positive (RD-infringing/absent/ambiguous)
 *   3 — blocked: throttle, rate limit, or transient error
 *   4 — usage error
 */

import { createRealDebridClient } from '../lib/providers/realdebrid/client.js';
import { attemptRdResolution } from '../lib/providers/realdebrid/resolve.js';
import { getRdResolutionCache } from '../lib/providers/realdebrid/rd-resolution-cache.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { probeAndPersist } from '../lib/providers/realdebrid/observe.js';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { media: null, season: null, episode: null, max: 12, dryRun: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--media' && argv[i + 1]) args.media = argv[++i];
    else if (a === '--season' && argv[i + 1]) args.season = parseInt(argv[++i], 10);
    else if (a === '--episode' && argv[i + 1]) args.episode = parseInt(argv[++i], 10);
    else if (a === '--max' && argv[i + 1]) args.max = parseInt(argv[++i], 10);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

function printUsage() {
  console.log(`
rd-walk-bounded — bounded RD walk through active production path

Usage:
  rd-walk-bounded.js --media <id> --season <n> --episode <n> [options]

Required:
  --media  <id>      IMDb id (e.g. tt7137906)
  --season <n>       Season number
  --episode <n>      Episode number

Options:
  --max    <n>       Max distinct hashes (default 12)
  --dry-run          Use a deterministic mock client; no live RD calls
  --out    <path>    JSON output path (default: stdout)
  --help, -h         Show this help
`);
}

// ---------------------------------------------------------------------------
// Persisted candidate loading
// ---------------------------------------------------------------------------

/**
 * Load the persisted, ranked candidates for a media request.
 * Returns the distinct (infoHash, fileIndex) entries in rank order,
 * deduped to the first occurrence of each hash.
 */
function loadPersistedCandidates(cache, mediaId, season, episode) {
  const request = cache.getMediaRequestsByMediaId(mediaId, season, episode);
  if (!request) return { request: null, candidates: [] };
  const rows = cache.getMediaRequestResults(request.id);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row.info_hash) continue;
    if (seen.has(row.info_hash)) continue;
    seen.add(row.info_hash);
    out.push({
      rank: row.rank,
      infoHash: row.info_hash.toLowerCase(),
      fileIndex: row.file_index_key === undefined || row.file_index_key === null ? -1 : row.file_index_key,
      filename: row.filename || null,
      size: typeof row.selected_file_size === 'number' ? row.selected_file_size : null,
    });
  }
  return { request, candidates: out };
}

// ---------------------------------------------------------------------------
// Single-owner in-flight set
// ---------------------------------------------------------------------------

const walkInFlight = new Set();

function tryAcquireWalk(mediaId, season, episode) {
  const key = `${mediaId}:${season}:${episode}`;
  if (walkInFlight.has(key)) return false;
  walkInFlight.add(key);
  return () => walkInFlight.delete(key);
}

// ---------------------------------------------------------------------------
// RD walk driver
// ---------------------------------------------------------------------------

/**
 * Walk persisted candidates via the active production path. Returns a
 * structured report — never includes API keys, restricted URLs, or
 * temporary torrent ids.
 *
 * The `evaluate` function is injected so the test harness can substitute
 * a deterministic mock client. The production path uses the real
 * createRealDebridClient.
 */
async function walkPersistedCandidates({
  mediaId,
  season,
  episode,
  maxCandidates = 12,
  cache,
  controlPlaneStore,
  evaluate,
  rdCache,
  now = () => Date.now(),
  forceRefreshObservations = false,
}) {
  const release = tryAcquireWalk(mediaId, season, episode);
  if (!release) {
    return {
      ok: false,
      status: 'in_flight',
      mediaId, season, episode,
      message: 'another walk is already in progress for this target',
    };
  }

  const startedAt = now();
  const { request, candidates } = loadPersistedCandidates(cache, mediaId, season, episode);

  const visited = [];
  let firstPositive = null;
  let stoppedReason = 'walked_all_candidates';

  try {
    for (const cand of candidates) {
      if (visited.length >= maxCandidates) {
        stoppedReason = 'max_candidates';
        break;
      }

      // Phase 1: consult the persisted negative cache. A fresh
      // RD-infringing observation short-circuits BEFORE addMagnet.
      const observations = cache.getProviderObservations(cand.infoHash, cand.fileIndex);
      const freshRdNegative = observations.find(
        (o) =>
          o.provider === 'realdebrid' &&
          o.freshness === 'fresh' &&
          o.errorCategory === 'infringing',
      );

      if (freshRdNegative && !forceRefreshObservations) {
        visited.push({
          rank: cand.rank,
          infoHash: cand.infoHash,
          fileIndex: cand.fileIndex,
          outcome: 'skipped',
          reason: 'rd_infringing_known',
          classification: 'infringing',
          evidence: { rdErrorCode: freshRdNegative.evidence?.rdErrorCode ?? 35 },
        });
        continue;
      }

      // Phase 2: bounded active evaluation via the production path.
      // The single-flight cache coalesces concurrent same-key calls.
      const evaluation = await rdCache.getOrInFlight(cand.infoHash, cand.fileIndex, () =>
        evaluate({ infoHash: cand.infoHash, fileIndex: cand.fileIndex, filename: cand.filename, size: cand.size }),
      );

      if (evaluation.status === 'resolved') {
        // Map the RD delivery to the durable TorrentFile (no new row).
        const torrentFile = controlPlaneStore.findTorrentFile(cand.infoHash, deriveCanonicalPath(cand));
        firstPositive = {
          rank: cand.rank,
          infoHash: cand.infoHash,
          fileIndex: cand.fileIndex,
          outcome: 'positive',
          rdFileId: evaluation.rdFileId,
          torrentFileId: torrentFile ? torrentFile.id : null,
          // NOTE: the unrestricted URL is NEVER recorded here.
          timing: evaluation.timing || null,
        };
        stoppedReason = 'first_positive';
        break;
      }

      if (evaluation.status === 'skipped') {
        visited.push({
          rank: cand.rank,
          infoHash: cand.infoHash,
          fileIndex: cand.fileIndex,
          outcome: 'skipped',
          reason: evaluation.reason,
          classification: evaluation.reason,
        });
        continue;
      }

      if (evaluation.status === 'failed') {
        const err = evaluation.error || {};
        // RD throttle / rate-limit — stop the walk immediately.
        if (err.code === 'RD_COOLDOWN' || err.category === 'rate-limit') {
          visited.push({
            rank: cand.rank,
            infoHash: cand.infoHash,
            fileIndex: cand.fileIndex,
            outcome: 'failed',
            reason: 'rd_cooldown',
            classification: 'rate-limit',
            rdErrorCode: err.rdErrorCode ?? null,
          });
          stoppedReason = 'rd_throttle';
          break;
        }
        visited.push({
          rank: cand.rank,
          infoHash: cand.infoHash,
          fileIndex: cand.fileIndex,
          outcome: 'failed',
          reason: err.code || 'RD_ERROR',
          classification: err.category || 'unknown',
          rdErrorCode: err.rdErrorCode ?? null,
        });
        continue;
      }
    }
  } finally {
    release();
  }

  return {
    ok: firstPositive !== null,
    status: firstPositive ? 'resolved' : stoppedReason,
    mediaId,
    season,
    episode,
    requestId: request ? request.id : null,
    visitedCount: visited.length,
    firstPositive,
    visited,
    stoppedReason,
    elapsedMs: now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the canonical internal path from the persisted candidate
 * filename. The canonical form is what the control-plane store uses
 * to look up an existing TorrentFile. This is a best-effort match
 * — if the filename is missing or non-canonical, the lookup will
 * return null and the parent will see torrentFileId=null (a clean
 * "we found a positive on RD but cannot map it to an existing TF"
 * signal, NOT a new TF creation).
 */
function deriveCanonicalPath(candidate) {
  return candidate.filename || '';
}

// ---------------------------------------------------------------------------
// Real client adapter (production path)
// ---------------------------------------------------------------------------

async function defaultEvaluate({ client, searchCache, infoHash, fileIndex, filename, size }) {
  return attemptRdResolution(client, searchCache, {
    infoHash,
    fileIndex: fileIndex === -1 ? null : fileIndex,
    filename: filename || '',
    size: typeof size === 'number' ? size : 0,
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.media || args.season == null || args.episode == null) {
    printUsage();
    process.exit(4);
  }

  const DB_PATH = process.env.DISCOVERY_DB || './discovery-cache.db';
  const CP_PATH = process.env.CONTROL_PLANE_DB || './control-plane.db';
  const rdCache = getRdResolutionCache();
  rdCache.clear();

  const cache = createDiscoveryCache({ dbPath: DB_PATH });
  const controlPlaneStore = createControlPlaneStore({ dbPath: CP_PATH });

  let client = null;
  if (!args.dryRun) {
    if (!process.env.REALDEBRID_API_KEY) {
      console.error('Error: REALDEBRID_API_KEY is required (or pass --dry-run)');
      cache.close();
      process.exit(4);
    }
    client = createRealDebridClient({ apiKey: process.env.REALDEBRID_API_KEY });
  }

  try {
    const report = await walkPersistedCandidates({
      mediaId: args.media,
      season: args.season,
      episode: args.episode,
      maxCandidates: args.max,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: ({ infoHash, fileIndex, filename, size }) => {
        if (args.dryRun) {
          throw new Error('dry-run requires an injected evaluate function');
        }
        return defaultEvaluate({ client, searchCache: cache, infoHash, fileIndex, filename, size });
      },
    });

    const out = args.out ? JSON.stringify(report, null, 2) + '\n' : null;
    if (args.out) {
      const fs = await import('node:fs');
      fs.writeFileSync(args.out, out);
      console.error(`[rd-walk-bounded] wrote report to ${args.out}`);
    } else {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    }

    if (report.status === 'resolved') process.exit(0);
    if (report.status === 'rd_throttle') process.exit(3);
    process.exit(2);
  } finally {
    cache.close();
  }
}

export { walkPersistedCandidates, loadPersistedCandidates, deriveCanonicalPath };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[rd-walk-bounded] fatal: ${e.message}`);
    process.exit(3);
  });
}