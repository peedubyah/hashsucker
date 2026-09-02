#!/usr/bin/env node
/**
 * Canary: cold-start discovery + physical identity for a MOVIE.
 *
 * Drives the full production vertical for a single movie, against the real
 * production DBs:
 *   - live discovery (Stremio/Comet)
 *   - ranking + identity eligibility
 *   - TorBox availability check (real account, real API)
 *   - cached-only placement, authoritative inventory, TorrentFile row
 *   - playback handoff with non-null torrent_file_id
 *   - VFS publication (materializeVfsEntry, allowLegacy=false)
 *   - legacy convergence: if a legacy vfs_movie_entries row already exists
 *     for the same media_id with torrent_file_id IS NULL, the new
 *     authoritative publication atomically supersedes it in place. The
 *     existing canonical_path is preserved verbatim so the published
 *     library alias (and any downstream WebDAV / Plex / Jellyfin
 *     references) remains stable.
 *   - idempotency: re-running with the same target on the same DB is a
 *     no-op against the durable handoff/VFS state.
 *
 * KEEPS REAL: discovery, ranking, provider cache checks, provider APIs,
 * cached-only placement creation, authoritative inventory, control-plane
 * persistence, TorrentFile identity, playback handoff, VFS publication.
 *
 * NOT synthesizing: candidate torrent, TorBox response, TorrentFile,
 * binding.
 *
 * Required env: DISCOVERY_DB, CONTROL_PLANE_DB, TORBOX_API_KEY
 *
 * Usage:
 *   node src/scripts/canary-movie-cold-start.js <imdbId>
 *   node src/scripts/canary-movie-cold-start.js --replay <imdbId>
 *
 * Flags:
 *   --replay     Re-run against the existing production DB without
 *                forcing any new placements. Useful for verifying the
 *                idempotency contract: the durable handoff and VFS row
 *                must converge to the same identity on every run.
 *
 * Exit codes:
 *   0 — success
 *   1 — invalid arguments
 *   2 — canary failure (see stderr for details)
 */

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createTorBoxInventoryProvider } from '../lib/providers/torbox-inventory.js';
import { createTorBoxProvider } from '../lib/providers/torbox.js';
import { ensureTorBoxFileIdentity } from '../lib/resolver/torbox-file-identity.js';
import { searchByMedia } from '../api/media-request.js';

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';
const CP_PATH = process.env.CONTROL_PLANE_DB || ':memory:';

function parseArgs(argv) {
  const out = { target: null, replay: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--replay') {
      out.replay = true;
      continue;
    }
    if (!a.startsWith('--') && !out.target) out.target = a;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target || !/^tt\d+$/.test(args.target)) {
    console.error('Usage: canary-movie-cold-start.js [--replay] <imdbId>');
    process.exit(1);
  }
  const imdbId = args.target;
  const startedAt = Date.now();

  console.log(`[canary-movie] target=${imdbId} replay=${args.replay}`);
  console.log(`[canary-movie] DISCOVERY_DB=${DB_PATH}`);
  console.log(`[canary-movie] CONTROL_PLANE_DB=${CP_PATH}`);

  const cache = createDiscoveryCache({ dbPath: DB_PATH });
  const controlPlaneStore = createControlPlaneStore({ dbPath: CP_PATH });

  // Capture pre-canary VFS state to detect legacy→authoritative convergence.
  const preVfs = cache.getVfsMovieEntry(imdbId);
  if (preVfs) {
    const isLegacy = preVfs.torrentFileId == null;
    console.log(
      `[canary-movie] pre-canary VFS: media=${preVfs.mediaId} ` +
      `path="${preVfs.canonicalPath}" ` +
      `release=${preVfs.releaseKey} ` +
      `torrentFileId=${preVfs.torrentFileId ?? 'null'} ` +
      `size=${preVfs.size ?? 'null'} ` +
      `legacy=${isLegacy}`,
    );
  } else {
    console.log(`[canary-movie] pre-canary VFS: no row for ${imdbId}`);
  }

  const torBoxInventoryProvider = process.env.TORBOX_API_KEY
    ? createTorBoxInventoryProvider({ apiKey: process.env.TORBOX_API_KEY })
    : null;
  const torBoxProvider = process.env.TORBOX_API_KEY
    ? createTorBoxProvider({ apiKey: process.env.TORBOX_API_KEY })
    : null;

  const ensureTorBoxFileIdentityFn = async ({ infoHash, controlPlaneStore: cp, skipSizeMatch }) => {
    return ensureTorBoxFileIdentity({
      infoHash,
      controlPlaneStore: cp,
      torBoxInventoryProvider,
      torBoxProvider,
      skipSizeMatch: skipSizeMatch === true,
    });
  };

  try {
    const result = await searchByMedia(cache, {
      mediaId: imdbId,
      mediaType: 'movie',
      season: null,
      episode: null,
      source: 'canary-movie',
      sourceType: 'canary',
      sourceId: `canary-movie-${imdbId}`,
      sourceLabel: 'movie cold-start canary',
      persist: !args.replay,
      controlPlaneStore,
      ensureTorBoxFileIdentity: ensureTorBoxFileIdentityFn,
    });

    const elapsedMs = Date.now() - startedAt;
    const sel = result.selection || {};
    const binding = sel.selected?._binding || null;

    console.log(`[canary-movie] completed in ${elapsedMs}ms`);
    console.log(`[canary-movie] total candidates: ${result.total}`);
    console.log(`[canary-movie] request id: ${result.requestId}`);
    console.log(
      `[canary-movie] selected: ${sel.selected?.infoHash || 'null'} ` +
      `reason=${sel.reason}`,
    );
    console.log(`[canary-movie] binding: ${JSON.stringify(binding)}`);
    console.log(`[canary-movie] handoff: ${result.handoff ? 'present' : 'null'}`);

    if (result.handoff) {
      console.log(`[canary-movie] handoff.torrentFileId: ${result.handoff.torrentFileId || 'null'}`);
      console.log(`[canary-movie] handoff.mediaType: ${result.handoff.mediaType}`);
      console.log(`[canary-movie] handoff.releaseKey: ${result.handoff.releaseKey}`);
    }

    // Capture post-canary VFS state to confirm legacy convergence or
    // fresh publication.
    const postVfs = cache.getVfsMovieEntry(imdbId);
    if (postVfs) {
      console.log(
        `[canary-movie] post-canary VFS: media=${postVfs.mediaId} ` +
        `path="${postVfs.canonicalPath}" ` +
        `release=${postVfs.releaseKey} ` +
        `torrentFileId=${postVfs.torrentFileId ?? 'null'} ` +
        `size=${postVfs.size ?? 'null'}`,
      );

      // Convergence invariant: any post-canary row must be authoritative
      // (torrent_file_id NOT NULL). The legacy branch was atomically
      // upgraded in place; the canonical_path is preserved when an
      // authoritative successor arrives.
      if (postVfs.torrentFileId == null) {
        console.error(
          `[canary-movie] FAILED: VFS row for ${imdbId} still has ` +
          `torrent_file_id IS NULL after cold-start.`,
        );
        process.exit(2);
      }

      if (preVfs && preVfs.canonicalPath !== postVfs.canonicalPath) {
        console.error(
          `[canary-movie] FAILED: canonical_path mutated during legacy ` +
          `supersede: pre="${preVfs.canonicalPath}" post="${postVfs.canonicalPath}". ` +
          `The library alias must be preserved verbatim.`,
        );
        process.exit(2);
      }
    } else {
      console.log(`[canary-movie] post-canary VFS: no row for ${imdbId}`);
    }

    // Idempotency: a replay run must not change the durable handoff
    // row's identity. We surface this as a final log line; the caller
    // decides whether to assert strict equality.
    if (args.replay && preVfs && postVfs) {
      const converged = preVfs.torrentFileId === postVfs.torrentFileId
        && preVfs.releaseKey === postVfs.releaseKey
        && preVfs.canonicalPath === postVfs.canonicalPath
        && preVfs.size === postVfs.size;
      console.log(`[canary-movie] idempotency: ${converged ? 'converged' : 'diverged'}`);
      if (!converged) {
        console.error(
          `[canary-movie] FAILED: replay diverged. ` +
          `pre=${JSON.stringify(preVfs)} post=${JSON.stringify(postVfs)}`,
        );
        process.exit(2);
      }
    }
  } catch (err) {
    console.error(`[canary-movie] FAILED: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(2);
  } finally {
    cache.close();
    controlPlaneStore.close();
  }
}

main();