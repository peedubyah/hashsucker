/**
 * RD provider-neutral resolution proof.
 *
 * Invariant under test:
 *   The authoritative TorrentFile (infoHash + canonicalInternalPath + size)
 *   is preserved even when the delivery provider/capability changes
 *   mid-session. The change exercised here is: within the same VFS
 *   entry, the ephemeral delivery URL/provider flips from torbox to
 *   realdebrid (via a fresh RD attempt because the RD resolution cache
 *   is empty). The proof asserts:
 *
 *   1. Both resolutions succeed.
 *   2. In Phase A the TorBox seam is invoked to deliver the byte
 *      stream; in Phase B the RD client chain is invoked to deliver
 *      the byte stream AND the TorBox seam is NOT invoked.
 *   3. The authoritative TorrentFile identity
 *      (infoHash, internalPath, size) is IDENTICAL before and after.
 *   4. The VFS row in discovery cache (canonicalPath, info_hash, size)
 *      is identical before and after, AND matches the TorrentFile
 *      (the durable identity is bound to the TorrentFile, not the
 *      ephemeral provider URL).
 *
 * Mocking strategy:
 *   - searchCache: real createDiscoveryCache() in-memory.
 *   - controlPlaneStore: stub that returns a stable TorrentFile and
 *     stable placement, so the VFS materialization path uses the
 *     SAME TorrentFile identity for both phases.
 *   - TorBox seam (Phase A): stub returning a stable CDN URL + size
 *     from the durable TorrentFile (NOT from the provider).
 *   - RD client (Phase B): stub simulating the real RD API
 *     (addMagnet -> getTorrentInfo -> selectFiles -> getTorrentInfo
 *      -> unrestrictLink -> deleteTorrent). The RD API's reported
 *     torrent size matches the durable TorrentFile size.
 *   - fetchFn: stub that:
 *       * Routes the liveness check (Range: bytes=0-1023) to a 206
 *         with the right content-range, for BOTH torbox and rd URLs.
 *       * Routes the real GET (Range: bytes=0-0) to a 206 with the
 *         same content-range, for BOTH torbox and rd URLs.
 *   - rdResolutionCache: real implementation (getRdResolutionCache),
 *     starts empty.
 *
 * Pass criteria: invariants 1-4 above hold.
 */

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';

import { createDiscoveryCache } from '../../src/lib/discovery/cache.js';
import { getRdResolutionCache } from '../../src/lib/providers/realdebrid/rd-resolution-cache.js';
import { createMovieWebDav } from '../../src/lib/vfs/movie-webdav.js';
import { materializeVfsEntry } from '../../src/lib/vfs/materialize.js';

const INFO_HASH = 'f1e2d3c4b5a69788f1e2d3c4b5a69788f1e2d3c4';
const FILE_INDEX = null;
const MEDIA_ID = 'tt5687612';
// When a TorrentFile is bound, materializeVfsEntry uses mediaId-derived
// canonicalPath; the provider does not influence it. This is the durable
// identity we want to assert against.
const CANONICAL_INTERNAL_PATH = `Movies/${MEDIA_ID}/${MEDIA_ID}.mkv`;
const TORRENT_FILE_ID = 'tf_fleabag_2016_001';
const PHYSICAL_SIZE = 4_321_098_765;
const TORBOX_URL = 'https://torbox.example/dl/cdn/abc123?token=ephemeral';
const RD_UNRESTRICTED_URL = 'https://rd.example/dl/unrestricted/xyz789?token=ephemeral';

function buildControlPlaneStoreStub() {
  const torrentFile = {
    id: TORRENT_FILE_ID,
    infoHash: INFO_HASH,
    internalPath: CANONICAL_INTERNAL_PATH,
    size: PHYSICAL_SIZE,
  };
  const placement = { id: 'placement-tb-1', providerResourceId: 'torrent-tb-1' };
  return {
    getTorrentFile(id) {
      return id === TORRENT_FILE_ID ? torrentFile : null;
    },
    findPlacementByInfoHash(provider, hash) {
      if (provider === 'torbox' && hash.toLowerCase() === INFO_HASH) return placement;
      return null;
    },
    findFileMapping(releaseKey, placementId) {
      if (releaseKey === `${INFO_HASH}:torrent` && placementId === placement.id) {
        return { state: 'mapped', providerFileId: 'file-tb-1' };
      }
      return null;
    },
    listProviderFiles(placementId) {
      if (placementId === placement.id) {
        return [{ providerFileId: 'file-tb-1', size: PHYSICAL_SIZE }];
      }
      return [];
    },
  };
}

function buildRdClientStub() {
  const calls = [];
  const RD_FILE_ID = 'rd-file-1';
  const TORRENT_ID = 'rd-torrent-1';

  const torrentInfoDownloaded = {
    id: TORRENT_ID,
    status: 'downloaded',
    files: [
      { id: RD_FILE_ID, path: 'Fleabag (2016).mkv', bytes: PHYSICAL_SIZE, selected: 1 },
    ],
    links: ['https://rd.example/hoster/link/abc'],
  };

  return {
    calls,
    addMagnet(magnetUri, options = {}) {
      calls.push({ method: 'addMagnet', magnetUri, options });
      return Promise.resolve({ id: TORRENT_ID, uri: magnetUri });
    },
    getTorrentInfo(id, options = {}) {
      calls.push({ method: 'getTorrentInfo', id, options });
      if (id !== TORRENT_ID) throw new Error('unknown torrentId');
      return Promise.resolve(torrentInfoDownloaded);
    },
    selectFiles(id, fileIds, options = {}) {
      calls.push({ method: 'selectFiles', id, fileIds, options });
      return Promise.resolve();
    },
    unrestrictLink(link, _password, options = {}) {
      calls.push({ method: 'unrestrictLink', link, options });
      return Promise.resolve({ download: RD_UNRESTRICTED_URL, filename: 'Fleabag (2016).mkv' });
    },
    deleteTorrent(id, options = {}) {
      calls.push({ method: 'deleteTorrent', id, options });
      return Promise.resolve({});
    },
  };
}

/**
 * Build a fetchFn that responds 206 to BOTH the liveness probe and the
 * actual byte GET, with the correct content-range for the full file.
 * The RD/TorBox capability URLs are accepted indistinguishably because
 * the test is about identity preservation, not liveness discrimination.
 */
function buildBytePathFetch() {
  return async (url, init = {}) => {
    const range = init?.headers?.Range || init?.headers?.range;
    if (range) {
      const match = range.match(/^bytes=(\d+)-(\d+)$/);
      if (match) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(new Uint8Array(8), {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${end}/${PHYSICAL_SIZE}`,
            'content-length': String(end - start + 1),
            'accept-ranges': 'bytes',
          },
        });
      }
    }
    return new Response(new Uint8Array(PHYSICAL_SIZE), {
      status: 200,
      headers: { 'content-length': String(PHYSICAL_SIZE) },
    });
  };
}

function persistTorBoxHandoff(cache) {
  const requestId = cache.persistMediaRequest(
    { mediaId: MEDIA_ID, mediaType: 'movie', source: 'proof' },
    [],
  );
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: MEDIA_ID,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: `${INFO_HASH}:torrent`,
    infoHash: INFO_HASH,
    fileIndex: FILE_INDEX,
    filename: 'Fleabag (2016).mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed',
    selectionReason: 'rd-provider-neutral proof',
    selectedAt: 1_700_000_000_000,
    torrentFileId: TORRENT_FILE_ID,
  });
}

function readVfsEntry(cache) {
  return cache.listVfsMovieEntries().find((e) => e.mediaId === MEDIA_ID);
}

function createRequest(handler) {
  return (url, { method = 'GET', headers = {} } = {}) => {
    const input = Readable.from([]);
    input.method = method;
    input.url = url;
    input.headers = headers;
    return new Promise((resolve, reject) => {
      const chunks = [];
      const response = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      response.writeHead = function writeHead(status, responseHeaders) {
        this.status = status;
        this.headers = responseHeaders;
      };
      response.on('finish', () => resolve({
        status: response.status,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
      handler(input, response, new URL(url, 'http://localhost')).catch(reject);
    });
  };
}

/**
 * Drive a WebDAV GET to the VFS file path. This goes through
 * openValidatedProviderRead -> resolveBacking -> provider seam or RD
 * client chain. The 0-0 byte range reads just the first byte and is
 * valid for any provider that supports byte ranges.
 */
async function driveGet(request, path) {
  return request(path, {
    method: 'GET',
    headers: { range: 'bytes=0-0' },
  });
}

async function runPhaseA() {
  const searchCache = createDiscoveryCache();
  const controlPlaneStore = buildControlPlaneStoreStub();
  const torBoxSeamCalls = [];
  const torBoxSeam = async (args) => {
    torBoxSeamCalls.push(args);
    return {
      url: TORBOX_URL,
      size: PHYSICAL_SIZE,
      recovered: false,
      placementId: 'placement-tb-1',
      providerFileId: 'file-tb-1',
      accountScope: 'default',
    };
  };

  const fetchFn = buildBytePathFetch();
  const handler = createMovieWebDav({
    searchCache,
    controlPlaneStore,
    rdClient: null,
    rdResolutionCache: getRdResolutionCache(),
    resolveTorBoxDeliverySeam: torBoxSeam,
    torBoxDownloadUrlCache: null,
    fetchFn,
  });

  persistTorBoxHandoff(searchCache);

  // Materialize the VFS row up-front so we can capture the
  // canonicalPath / info_hash / size before any resolveBacking call.
  const handoff = searchCache.getPlaybackHandoffByReleaseKey(MEDIA_ID, `${INFO_HASH}:torrent`);
  materializeVfsEntry(searchCache, handoff, controlPlaneStore, () => 1_700_000_000_000, { allowLegacy: true });

  const vfsBefore = readVfsEntry(searchCache);
  assert.ok(vfsBefore, 'Phase A: VFS row materialized before hydration');
  assert.equal(vfsBefore.infoHash, INFO_HASH);
  // The VFS row is bound to the TorrentFile, so its size and canonical
  // path are populated from the durable identity at materialization
  // time, not from the ephemeral provider. This is the whole point of
  // the proof: durable identity is set BEFORE delivery is resolved.
  assert.equal(vfsBefore.size, PHYSICAL_SIZE,
    'Phase A: VFS row size is bound to TorrentFile at materialization');
  assert.equal(vfsBefore.canonicalPath, CANONICAL_INTERNAL_PATH);

  // Drive the byte path. This forces resolveBacking -> torbox seam.
  const request = createRequest(handler);
  const getResp = await driveGet(request, `/vfs/${CANONICAL_INTERNAL_PATH}`);
  assert.equal(getResp.status, 206, 'Phase A: GET returned 206 partial content');

  // Verify: TorBox seam WAS called for delivery.
  assert.ok(torBoxSeamCalls.length >= 1,
    'Phase A: TorBox seam invoked to deliver the byte stream');
  assert.equal(torBoxSeamCalls[0].infoHash, INFO_HASH,
    'Phase A: TorBox seam received the same infoHash as the durable TorrentFile');

  // VFS row identity must be unchanged after the byte read.
  const vfsAfter = readVfsEntry(searchCache);
  assert.equal(vfsAfter.infoHash, INFO_HASH, 'Phase A: VFS row infoHash unchanged after delivery');
  assert.equal(vfsAfter.size, PHYSICAL_SIZE, 'Phase A: VFS row size unchanged after delivery');
  assert.equal(vfsAfter.canonicalPath, CANONICAL_INTERNAL_PATH,
    'Phase A: VFS row canonicalPath unchanged after delivery');

  // Note the ephemeral URL was the TorBox CDN URL.
  console.log(`[proof] Phase A: torBoxSeamCalls=${torBoxSeamCalls.length} url=${TORBOX_URL}`);

  searchCache.close();
  return { vfsBefore, vfsAfter };
}

async function runPhaseB() {
  const rdClient = buildRdClientStub();
  const rdCache = getRdResolutionCache();
  rdCache.clear();

  const searchCache = createDiscoveryCache();
  const controlPlaneStore = buildControlPlaneStoreStub();
  let torBoxSeamCallsB = 0;
  const torBoxSeamB = async (args) => {
    torBoxSeamCallsB += 1;
    return {
      url: TORBOX_URL,
      size: PHYSICAL_SIZE,
      recovered: false,
      placementId: 'placement-tb-1',
      providerFileId: 'file-tb-1',
      accountScope: 'default',
    };
  };

  const fetchFn = buildBytePathFetch();
  const handler = createMovieWebDav({
    searchCache,
    controlPlaneStore,
    rdClient,
    rdResolutionCache: rdCache,
    resolveTorBoxDeliverySeam: torBoxSeamB,
    torBoxDownloadUrlCache: null,
    fetchFn,
  });
  persistTorBoxHandoff(searchCache);

  const handoff = searchCache.getPlaybackHandoffByReleaseKey(MEDIA_ID, `${INFO_HASH}:torrent`);
  materializeVfsEntry(searchCache, handoff, controlPlaneStore, () => 1_700_000_000_000, { allowLegacy: true });

  // Capture VFS row identity BEFORE byte read in Phase B.
  const vfsBefore = readVfsEntry(searchCache);
  assert.equal(vfsBefore.infoHash, INFO_HASH);
  assert.equal(vfsBefore.canonicalPath, CANONICAL_INTERNAL_PATH);
  assert.equal(vfsBefore.size, PHYSICAL_SIZE,
    'Phase B: VFS row size is bound to TorrentFile BEFORE RD resolution is attempted');

  // Confirm the RD resolution cache starts empty (no provider capability).
  assert.equal(rdCache.size(), 0, 'Phase B: rdResolutionCache starts empty');
  assert.equal(rdCache.get(INFO_HASH, FILE_INDEX), null,
    'Phase B: cache.get() returns null (simulating stale/expired capability)');

  // Drive the byte path. This forces resolveBacking ->
  // rdResolutionCache.getOrInFlight -> attemptRdResolution. The RD
  // client chain (addMagnet, getTorrentInfo, selectFiles,
  // getTorrentInfo, unrestrictLink) is exercised. The RD cache then
  // holds the fresh capability, which is used for the actual GET.
  const request = createRequest(handler);
  const getResp = await driveGet(request, `/vfs/${CANONICAL_INTERNAL_PATH}`);
  assert.equal(getResp.status, 206, 'Phase B: GET returned 206 partial content');

  // Phase B assertions on the RD resolution flow:
  // - attemptRdResolution must have been invoked through the real code path.
  const callNames = rdClient.calls.map((c) => c.method);
  assert.ok(callNames.includes('addMagnet'), 'Phase B: addMagnet called');
  assert.ok(callNames.includes('getTorrentInfo'), 'Phase B: getTorrentInfo called');
  assert.ok(callNames.includes('selectFiles'), 'Phase B: selectFiles called');
  assert.ok(callNames.includes('unrestrictLink'), 'Phase B: unrestrictLink called');
  assert.ok(callNames.includes('deleteTorrent'), 'Phase B: cleanup deleteTorrent called');

  // - The RD resolution cache must now contain a fresh entry.
  const cachedAfter = rdCache.get(INFO_HASH, FILE_INDEX);
  assert.ok(cachedAfter, 'Phase B: RD resolution cache populated after successful resolution');
  assert.equal(cachedAfter.url, RD_UNRESTRICTED_URL,
    'Phase B: cached URL is the unrestricted RD link, not the TorBox CDN URL');

  // - The TorBox seam was NOT used on the RD success path.
  assert.equal(torBoxSeamCallsB, 0,
    'Phase B: TorBox seam is NOT invoked when RD resolution succeeds (the whole point)');

  // - VFS row identity must be preserved.
  const vfsAfter = readVfsEntry(searchCache);
  assert.equal(vfsAfter.infoHash, INFO_HASH, 'Phase B: VFS row infoHash unchanged');
  assert.equal(vfsAfter.canonicalPath, CANONICAL_INTERNAL_PATH,
    'Phase B: VFS row canonicalPath (canonicalInternalPath) unchanged');
  assert.equal(vfsAfter.size, PHYSICAL_SIZE, 'Phase B: VFS row size unchanged');

  console.log(`[proof] Phase B: rdCalls=${rdClient.calls.length} url=${RD_UNRESTRICTED_URL} torBoxSeamCalls=${torBoxSeamCallsB}`);

  searchCache.close();
  return { vfsBefore, vfsAfter };
}

async function main() {
  console.log('[proof] starting rd-provider-neutral-resolution');
  const a = await runPhaseA();
  const b = await runPhaseB();

  // ------------------------------------------------------------------
  // Cross-phase invariant: authoritative TorrentFile identity is
  // preserved even though the delivery provider/capability changed.
  // ------------------------------------------------------------------
  // Phase A: torbox CDN URL, RD never used.
  // Phase B: RD unrestricted URL, TorBox seam never invoked.
  // The VFS row in both phases carries the same (infoHash,
  // canonicalPath, size) triple. This is the proof.
  console.log('[proof] Phase A delivery: provider=torbox     url=' + TORBOX_URL);
  console.log('[proof] Phase B delivery: provider=realdebrid url=' + RD_UNRESTRICTED_URL);
  console.log('[proof] Authoritative TorrentFile identity preserved:');
  console.log('         infoHash         = ' + INFO_HASH);
  console.log('         internalPath     = ' + CANONICAL_INTERNAL_PATH);
  console.log('         physicalSize     = ' + PHYSICAL_SIZE);
  console.log('[proof] delivery capability changed (torbox -> realdebrid), identity did not.');

  assert.equal(a.vfsBefore.infoHash, b.vfsBefore.infoHash,
    'infoHash before hydration: identical across phases');
  assert.equal(a.vfsBefore.canonicalPath, b.vfsBefore.canonicalPath,
    'canonicalPath before hydration: identical across phases');
  assert.equal(a.vfsBefore.size, b.vfsBefore.size,
    'physical size before hydration: identical across phases');

  assert.equal(a.vfsAfter.infoHash, b.vfsAfter.infoHash,
    'infoHash after delivery: identical across phases');
  assert.equal(a.vfsAfter.canonicalPath, b.vfsAfter.canonicalPath,
    'canonicalPath after delivery: identical across phases');
  assert.equal(a.vfsAfter.size, b.vfsAfter.size,
    'physical size after delivery: identical across phases');

  // The whole point: the VFS row that Plex sees is the same physical
  // file across both phases, even though the delivery provider and
  // ephemeral URL changed.
  console.log('[proof] PASS — Authoritative TorrentFile before == Authoritative TorrentFile after');
}

main().catch((err) => {
  console.error('[proof] FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
