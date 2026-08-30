#!/usr/bin/env node
/**
 * Prove RD URL survival after torrent deletion.
 *
 * Replicates the exact attemptRdResolution flow:
 *   1. Add magnet
 *   2. Select file
 *   3. Get unrestricted URL (from torrentInfo.links, before deletion)
 *   4. Delete the torrent
 *   5. Make a tiny range request against the unrestricted URL
 *
 * Usage:
 *   REALDEBRID_API_KEY=xxx node scripts/prove-rd-url-survival.js --hash <infoHash>
 */

import { createRealDebridClient } from '../lib/providers/realdebrid/client.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';

const API_KEY = process.env.REALDEBRID_API_KEY;
const DB_PATH = process.env.DISCOVERY_DB || './discovery-cache.db';

function parseArgs(argv) {
  const args = { hash: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hash' && argv[i + 1]) args.hash = argv[++i];
    else if (a === '--verbose' || a === '-v') args.verbose = true;
  }
  return args;
}

const PLAYABLE_VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts',
]);

function mapCandidateToRdFile(rdFiles, candidateMetadata = {}) {
  if (!Array.isArray(rdFiles) || rdFiles.length === 0) return null;
  const playableFiles = rdFiles.filter(f => {
    const path = (f.path || f.filename || '').toLowerCase();
    return Array.from(PLAYABLE_VIDEO_EXTENSIONS).some(ext => path.endsWith(ext));
  });
  if (playableFiles.length === 0) return null;
  if (playableFiles.length === 1) return String(playableFiles[0].id);
  const { filename, size } = candidateMetadata;
  if (filename) {
    const normalizedFilename = filename.toLowerCase();
    const basenameFilename = normalizedFilename.split('/').pop().split('\\').pop();
    const exactMatch = playableFiles.find(f => {
      const rdPath = (f.path || f.filename || '').toLowerCase();
      return rdPath === normalizedFilename || rdPath === basenameFilename;
    });
    if (exactMatch) return String(exactMatch.id);
    const basenameMatch = playableFiles.find(f => {
      const rdPath = (f.path || f.filename || '').toLowerCase();
      const rdBasename = rdPath.split('/').pop().split('\\').pop();
      return rdBasename === basenameFilename;
    });
    if (basenameMatch) return String(basenameMatch.id);
  }
  if (size != null) {
    const sizeMatches = playableFiles.filter(f => f.bytes === size);
    if (sizeMatches.length === 1) return String(sizeMatches[0].id);
  }
  return null;
}

async function main() {
  if (!API_KEY) {
    console.error('ERROR: REALDEBRID_API_KEY required');
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.hash || !/^[0-9a-f]{40}$/i.test(args.hash)) {
    console.error('ERROR: --hash <40-hex-chars> required');
    process.exit(1);
  }

  const infoHash = args.hash.toLowerCase();
  const client = createRealDebridClient({ apiKey: API_KEY });
  const cache = createDiscoveryCache({ dbPath: DB_PATH });

  const candidate = cache.getCandidate(infoHash, null);
  console.log('Candidate:', candidate?.filename || candidate?.title || 'unknown');
  console.log('Size:', candidate?.size ?? 'unknown');

  let torrentId = null;
  let unrestrictedUrl = null;

  try {
    // Step 1: Add magnet
    console.log('\n[1] Adding magnet...');
    const magnetUri = `magnet:?xt=urn:btih:${infoHash}`;
    const addResult = await client.addMagnet(magnetUri, { resolverSafe: true });
    torrentId = addResult.id;
    console.log('    torrentId:', torrentId);

    // Step 2: Get torrent info
    console.log('[2] Getting torrent info...');
    const torrentInfo = await client.getTorrentInfo(torrentId, { resolverSafe: true });
    console.log('    RD status:', torrentInfo.status);
    console.log('    files:', torrentInfo.files?.length ?? 0);

    // Step 3: Map and select file
    console.log('[3] Mapping candidate to RD file...');
    const rdFileId = mapCandidateToRdFile(torrentInfo.files || [], {
      filename: candidate?.filename ?? null,
      size: candidate?.size ?? null,
    });
    if (!rdFileId) {
      console.error('    FAILED: Cannot map candidate to RD file');
      process.exit(1);
    }
    console.log('    rdFileId:', rdFileId);

    console.log('[4] Selecting file...');
    await client.selectFiles(torrentId, rdFileId, { resolverSafe: true });

    // Step 5: Re-fetch torrent info
    console.log('[5] Re-fetching torrent info after selection...');
    const updatedInfo = await client.getTorrentInfo(torrentId, { resolverSafe: true });
    console.log('    RD status:', updatedInfo.status);

    if (updatedInfo.status !== 'downloaded') {
      console.error('    FAILED: Torrent not cached (status:', updatedInfo.status + ')');
      process.exit(1);
    }

    // Step 6: Get unrestricted URL BEFORE deletion
    console.log('[6] Getting unrestricted URL (BEFORE deletion)...');
    const links = updatedInfo.links || [];
    console.log('    links count:', links.length);
    if (links.length === 0) {
      console.error('    FAILED: No hoster links');
      process.exit(1);
    }

    let link = links[0];
    if (links.length > 1) {
      const selectedFileIndex = (updatedInfo.files || []).findIndex(f => String(f.id) === rdFileId);
      if (selectedFileIndex >= 0 && selectedFileIndex < links.length) {
        link = links[selectedFileIndex];
      }
    }

    const unrestricted = await client.unrestrictLink(link, null, { resolverSafe: true });
    unrestrictedUrl = unrestricted?.download;
    if (!unrestrictedUrl) {
      console.error('    FAILED: No download URL from unrestrict');
      process.exit(1);
    }
    console.log('    URL obtained (length:', unrestrictedUrl.length, 'chars)');

    // Step 7: Delete the torrent
    console.log('[7] Deleting torrent...');
    await client.deleteTorrent(torrentId, { resolverSafe: true });
    console.log('    Torrent deleted');
    torrentId = null; // mark as deleted

    // Step 8: Range request AFTER deletion
    console.log('[8] Making range request AFTER deletion...');
    const rangeSize = 1024; // 1KB — just enough to prove the URL works
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(unrestrictedUrl, {
        headers: { Range: `bytes=0-${rangeSize - 1}` },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);
      console.log('    HTTP status:', response.status);
      console.log('    content-range:', response.headers.get('content-range'));
      console.log('    content-length:', response.headers.get('content-length'));

      if (response.status === 200 || response.status === 206) {
        const body = await response.arrayBuffer();
        console.log('    bytes received:', body.byteLength);
        console.log('\n=== RESULT: RD URL SURVIVES AFTER DELETION ===');
        console.log('Post-delete range access: SUCCESS');
      } else {
        console.log('\n=== RESULT: RD URL DOES NOT SURVIVE AFTER DELETION ===');
        console.log('Post-delete range access: FAILED (HTTP', response.status + ')');
      }
    } catch (fetchError) {
      clearTimeout(timeout);
      console.log('\n=== RESULT: RD URL DOES NOT SURVIVE AFTER DELETION ===');
      console.log('Post-delete range access: FAILED (' + fetchError.message + ')');
    }

  } finally {
    // Cleanup if something went wrong before deletion
    if (torrentId) {
      try {
        await client.deleteTorrent(torrentId, { resolverSafe: true });
      } catch {
        // ignore
      }
    }
    cache.close();
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
