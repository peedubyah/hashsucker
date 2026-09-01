#!/usr/bin/env node
/**
 * Canary: cold-start discovery + physical identity.
 *
 * Drives the full production vertical for a single TV episode, against the
 * real production DBs:
 *   - live discovery (Stremio/Comet)
 *   - ranking + identity eligibility
 *   - TorBox availability check (real account, real API)
 *   - PATH B: TorBox cached-only placement, authoritative inventory,
 *     replaceProviderFileInventory, TorrentFile row
 *   - playback handoff with non-null torrent_file_id
 *   - VFS publication (materializeVfsEntry)
 *
 * KEEPS REAL: discovery, ranking, provider cache checks, provider APIs,
 * cached-only placement creation, authoritative inventory, control-plane
 * persistence, TorrentFile identity, playback handoff, VFS publication.
 *
 * NOT synthesizing: candidate torrent, TorBox response, TorrentFile, binding.
 *
 * Required env: DISCOVERY_DB, CONTROL_PLANE_DB, TORBOX_API_KEY
 *
 * Usage:
 *   node src/scripts/canary-cold-start.js <imdbId:season:episode>
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
  const out = { target: null };
  for (const a of argv) {
    if (!a.startsWith('--') && !out.target) out.target = a;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target || !/^tt\d+:\d+:\d+$/.test(args.target)) {
    console.error('Usage: canary-cold-start.js <imdbId:season:episode>');
    process.exit(1);
  }
  const [imdbId, seasonStr, episodeStr] = args.target.split(':');
  const season = parseInt(seasonStr, 10);
  const episode = parseInt(episodeStr, 10);

  console.log(`[canary] target=${imdbId} S${season}E${episode}`);
  console.log(`[canary] DISCOVERY_DB=${DB_PATH}`);
  console.log(`[canary] CONTROL_PLANE_DB=${CP_PATH}`);

  const cache = createDiscoveryCache({ dbPath: DB_PATH });
  const controlPlaneStore = createControlPlaneStore({ dbPath: CP_PATH });

  const torBoxInventoryProvider = process.env.TORBOX_API_KEY
    ? createTorBoxInventoryProvider({ apiKey: process.env.TORBOX_API_KEY })
    : null;
  const torBoxProvider = process.env.TORBOX_API_KEY
    ? createTorBoxProvider({ apiKey: process.env.TORBOX_API_KEY })
    : null;

  // Slice 1.75: pre-publication TorBox file identity binding. PATH B uses
  // skipSizeMatch=true (no exact file size) so we can resolve TV S/E from
  // the authoritative TorrentFiles.
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
    const startedAt = Date.now();
    const result = await searchByMedia(cache, {
      mediaId: imdbId,
      mediaType: 'series',
      season,
      episode,
      source: 'canary',
      sourceType: 'canary',
      sourceId: `canary-${imdbId}:${season}:${episode}`,
      sourceLabel: 'cold-start canary',
      persist: true,
      controlPlaneStore,
      ensureTorBoxFileIdentity: ensureTorBoxFileIdentityFn,
    });
    const elapsedMs = Date.now() - startedAt;

    const sel = result.selection || {};
    const binding = sel.selected?._binding || null;
    console.log(`[canary] completed in ${elapsedMs}ms`);
    console.log(`[canary] total candidates: ${result.total}`);
    console.log(`[canary] request id: ${result.requestId}`);
    console.log(`[canary] selected: ${sel.selected?.infoHash || 'null'} reason=${sel.reason}`);
    console.log(`[canary] binding: ${JSON.stringify(binding)}`);
    console.log(`[canary] handoff: ${result.handoff ? 'present' : 'null'}`);
    if (result.handoff) {
      console.log(`[canary] handoff.torrentFileId: ${result.handoff.torrentFileId || 'null'}`);
    }
  } catch (err) {
    console.error(`[canary] FAILED: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(2);
  } finally {
    cache.close();
    controlPlaneStore.close();
  }
}

main();
