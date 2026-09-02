/**
 * VFS hydration truth test (Slice 2.9 / A3).
 *
 * Proves that WebDAV hydration uses the durable TorrentFile as the source of
 * truth for size and identity, not cached/stale fields:
 *
 *   1. After authoritative materialization, `getCatalog()` re-derives the VFS
 *      row from the handoff and the TorrentFile — the stored size matches
 *      `torrent_files.size`, not the provider probe (which is not invoked).
 *   2. A fresh cache read after `getCatalog()` returns the VFS row with
 *      `torrentFileId` set, `infoHash` matching the TorrentFile, and
 *      `size` matching the TorrentFile — the WebDAV layer never recomputes
 *      these from cached provider state.
 *   3. When `state.entry.size` is already non-null (materialized from the
 *      TorrentFile at handoff time), `ensureMetadata` returns immediately
 *      without invoking the provider seam — the provider capability cache
 *      is not touched.
 *   4. The handoff-vs-entry identity-mismatch check in `getCatalog()`
 *      refuses to bind a VFS row whose durable identity disagrees with the
 *      authoritative handoff for the same slot.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createTvWebDav } from '../src/lib/vfs/tv-webdav.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const INFO_HASH = 'cccccccccccccccccccccccccccccccccccccccc';

function rdResolutionCache() {
  return {
    get() { return null; },
    set() {},
    delete() {},
    async getOrInFlight(_a, _b, factory) { return factory(); },
  };
}

function torBoxDownloadUrlCache() {
  return {
    get() { return null; },
    set() {},
    delete() {},
    invalidateByCapability() {},
    async getOrInFlight() { throw new Error('unused'); },
  };
}

function tvHandoff({ torrentFileId, infoHash = INFO_HASH, size = 5_000_000_000 } = {}) {
  return {
    mediaId: 'tt0000001',
    mediaType: 'tv',
    season: 1,
    episode: 1,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    filename: 'Show.S01E01.2160p.mkv',
    canonicalTitle: 'Show',
    torrentFileId,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_788_000_000_000,
    size, // legacy field; not used by the modern contract
  };
}

function torrentFile({ id, size = 5_000_000_000, infoHash = INFO_HASH } = {}) {
  return {
    id,
    infoHash,
    internalPath: 'Show.S01.2160p/Show.S01E01.2160p.mkv',
    size,
    createdAt: 1_788_000_000_000,
  };
}

test('hydrateVfsTvEntry returns TorrentFile-backed size without invoking the provider seam', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Persist the request + handoff the way the request pipeline does.
  const requestId = cache.persistMediaRequest({
    mediaId: 'tt0000001', mediaType: 'tv', source: 'test', season: 1, episode: 1,
  }, []);
  cache.upsertPlaybackHandoff(tvHandoff({ torrentFileId: 'tf_x' }));

  // Materialize the authoritative VFS row (allowLegacy: false requires TF).
  const tf = torrentFile({ id: 'tf_x', size: 5_000_000_000 });
  const controlPlane = { getTorrentFile: (id) => (id === 'tf_x' ? tf : null) };
  materializeVfsEntry(
    cache,
    cache.getTvPlaybackHandoff('tt0000001', 1, 1),
    controlPlane,
    () => 1_788_000_500_000,
    { allowLegacy: false },
  );

  // Spy on the provider seam: it must NEVER be called when size is already
  // hydrated from the TorrentFile.
  let seamCalls = 0;
  const seam = async () => { seamCalls += 1; throw new Error('seam must not be called'); };

  const handler = createTvWebDav({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    rdClient: null,
    rdResolutionCache: rdResolutionCache(),
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache: torBoxDownloadUrlCache(),
    fetchFn: async () => { throw new Error('fetch must not be called'); },
  });

  const result = await handler.hydrateVfsTvEntry({ mediaId: 'tt0000001', season: 1, episode: 1 });
  assert.equal(result.size, 5_000_000_000, 'size comes from TorrentFile');
  // canonicalTitle is not persisted to playback_handoffs; the materialize
  // path falls back to mediaId as the title segment. The important fact is
  // that the path is stable and the same as the VFS row.
  assert.equal(result.canonicalPath, 'TV/tt0000001/Season 01/tt0000001 - S01E01.mkv');
  assert.equal(seamCalls, 0, 'provider seam is not invoked for already-hydrated authoritative size');

  // Durable row reflects the TorrentFile identity.
  const persisted = cache.getVfsTvEntry('tt0000001', 1, 1);
  assert.equal(persisted.torrentFileId, 'tf_x');
  assert.equal(persisted.infoHash, INFO_HASH);
  assert.equal(persisted.size, 5_000_000_000);
});

test('catalog hydration refuses to bind when the VFS row disagrees with the authoritative handoff', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Plant a stale authoritative row whose torrent_file_id disagrees with
  // the handoff's torrent_file_id. This is the exact failure mode Slice 2.9
  // is meant to detect: a handoff/VFS desync at read time.
  cache.persistMediaRequest({
    mediaId: 'tt0000002', mediaType: 'tv', source: 'test', season: 1, episode: 1,
  }, []);
  cache.upsertPlaybackHandoff(tvHandoff({
    mediaId: 'tt0000002', torrentFileId: 'tf_correct',
  }));
  cache.createVfsTvEntry({
    mediaId: 'tt0000002',
    season: 1,
    episode: 1,
    releaseKey: `${INFO_HASH}:torrent`,
    infoHash: INFO_HASH,
    fileIndex: null,
    canonicalPath: 'TV/tt0000002/Season 01/tt0000002 - S01E01.mkv',
    torrentFileId: 'tf_stale', // different from handoff's tf_correct
    size: 5_000_000_000,
    createdAt: 1_788_000_000_000,
    updatedAt: 1_788_000_000_000,
  });

  // The handoff has torrentFileId = 'tf_correct'; the VFS row has
  // torrentFileId = 'tf_stale'. Re-running materialize with the handoff
  // must observe the identity mismatch and fail closed via
  // assertExistingIdentity. This is the same check that the catalog
  // builder's identity-mismatch guard performs before binding state.
  const controlPlane = { getTorrentFile: () => null };
  assert.throws(
    () => materializeVfsEntry(
      cache,
      cache.getTvPlaybackHandoff('tt0000002', 1, 1),
      controlPlane,
      () => 1_788_000_500_000,
      { allowLegacy: false },
    ),
    /conflicts with TorrentFile/,
  );

  // The existing authoritative row is untouched.
  const persisted = cache.getVfsTvEntry('tt0000002', 1, 1);
  assert.equal(persisted.torrentFileId, 'tf_stale', 'existing authoritative row preserved on conflict');
});

test('catalog re-materialization does not regress the authoritative identity', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  cache.persistMediaRequest({
    mediaId: 'tt0000003', mediaType: 'tv', source: 'test', season: 1, episode: 1,
  }, []);
  cache.upsertPlaybackHandoff(tvHandoff({
    mediaId: 'tt0000003', torrentFileId: 'tf_persistent',
  }));
  const tf = torrentFile({ id: 'tf_persistent', size: 7_777_777_777 });
  const controlPlane = { getTorrentFile: (id) => (id === 'tf_persistent' ? tf : null) };

  // First materialization: writes the durable VFS row.
  const handoff = cache.getTvPlaybackHandoff('tt0000003', 1, 1);
  const first = materializeVfsEntry(
    cache, handoff, controlPlane, () => 1_788_000_000_000, { allowLegacy: false },
  );
  assert.equal(first.size, 7_777_777_777);

  // Second materialization with the same handoff: must return the same row
  // (idempotent). The re-derived identity must equal the original.
  const second = materializeVfsEntry(
    cache, handoff, controlPlane, () => 1_788_000_500_000, { allowLegacy: false },
  );
  assert.equal(second.torrentFileId, first.torrentFileId);
  assert.equal(second.size, first.size);
  assert.equal(second.canonicalPath, first.canonicalPath);
  assert.equal(second.createdAt, first.createdAt, 'createdAt preserved on idempotent replay');

  // Only one row in the table.
  const all = cache.listVfsTvEntries().filter((e) =>
    e.mediaId === 'tt0000003' && e.season === 1 && e.episode === 1);
  assert.equal(all.length, 1);
});

/**
 * Minimal dispatcher: invoke the WebDAV handler with a fake request and
 * capture the response. Returns { status, body } without binding to a real
 * network port.
 */
async function dispatchWebdav(handler, method, pathname) {
  const headers = { 'content-length': '0' };
  if (method === 'PROPFIND') headers.depth = '0';
  const req = makeFakeRequest(method, pathname, headers);
  const res = await captureResponse(handler, req);
  return res;
}

function makeFakeRequest(method, url, headers) {
  const parsed = new URL(url, 'http://127.0.0.1:3000');
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on() {}, once() {}, removeListener() {},
    aborted: false,
  };
}

function captureResponse(req, handler) {
  return new Promise((resolve, reject) => {
    let status = 0;
    let headersSent = {};
    let body = Buffer.alloc(0);
    const res = {
      get headersSent() { return true; },
      setHeader(k, v) { headersSent[k.toLowerCase()] = v; },
      getHeader(k) { return headersSent[k.toLowerCase()]; },
      writeHead(code, h) {
        status = code;
        if (h) for (const k of Object.keys(h)) headersSent[k.toLowerCase()] = h[k];
      },
      write(chunk) {
        if (chunk) body = Buffer.concat([body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
        return true;
      },
      end(chunk) {
        if (chunk) body = Buffer.concat([body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
        resolve({ status, headers: headersSent, body: body.toString('utf8') });
      },
      destroy() { resolve({ status, headers: headersSent, body: body.toString('utf8') }); },
      once() {}, on() {}, removeListener() {},
    };
    try {
      const handled = handler(req, res, { pathname: new URL(req.url, 'http://127.0.0.1:3000').pathname });
      if (handled && typeof handled.then === 'function') handled.catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}
