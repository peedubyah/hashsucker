/**
 * VFS stale TorBox placement recovery.
 *
 * Production failure (Batman Knightfall / tt32333324): VFS /vfs/Movies reads
 * inherited the same defect that the /stream seam fixed in 5fe7bb4. The VFS
 * path used a raw ensureTorBoxDelivery dependency and fetched the requestdl
 * URL itself. When the upstream resource was deleted, the placement was
 * reused, the requestdl returned HTTP 500, and VFS retried the same stale
 * permalink — a 502 was emitted to the media server.
 *
 * This slice routes VFS through the same authoritative delivery seam. The
 * seam is responsible for repair; VFS only requests a backing URL through
 * it. This test exercises the VFS path through the seam to confirm the
 * VFS contract is preserved.
 */

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { TorBoxDownloadUrlError } from '../src/lib/resolver/torbox-download-url-cache.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const FILENAME = 'Movie.2024.1080p.mkv';
const RELEASE_KEY = `${HASH}:0`;
const FILE_INDEX = 0;
const NOW = 10_000;
const MEDIA_ID = 'tt1234567';

function persistMovie(cache, handoffInput) {
  const requestId = cache.persistMediaRequest(
    {
      mediaId: handoffInput.mediaId,
      mediaType: 'movie',
      season: null,
      episode: null,
      source: 'test',
    },
    [{
      infoHash: handoffInput.infoHash,
      fileIndex: handoffInput.fileIndex,
      filename: handoffInput.filename,
      score: 0.9,
      rank: 1,
      release: {
        infoHash: handoffInput.infoHash,
        fileIndex: handoffInput.fileIndex,
        releaseKey: handoffInput.releaseKey,
      },
    }]
  );
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: handoffInput.mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: handoffInput.releaseKey,
    infoHash: handoffInput.infoHash,
    fileIndex: handoffInput.fileIndex,
    filename: handoffInput.filename,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: NOW,
  });
}

function makeCacheMock() {
  const entries = new Map();
  return {
    get(releaseKey, providerFileId) {
      const key = `${releaseKey}:${providerFileId}`;
      const entry = entries.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        entries.delete(key);
        return null;
      }
      return { url: entry.url };
    },
    set(releaseKey, providerFileId, url) {
      entries.set(`${releaseKey}:${providerFileId}`, { url, expiresAt: Date.now() + 60_000 });
    },
    delete(releaseKey, providerFileId) {
      entries.delete(`${releaseKey}:${providerFileId}`);
    },
    async getOrInFlight(releaseKey, providerFileId, factory) {
      const cached = this.get(releaseKey, providerFileId);
      if (cached) return cached.url;
      const url = await factory();
      this.set(releaseKey, providerFileId, url);
      return url;
    },
  };
}

function makeRequest(handler) {
  return (url, { method = 'GET', headers = {} } = {}) => {
    const request = Readable.from([]);
    request.method = method;
    request.headers = headers;
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
      handler(request, response, new URL(url, 'http://localhost')).catch(reject);
    });
  };
}

test('VFS requestdl failure flows through authoritative seam: stale placement recovered, read succeeds', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  persistMovie(cache, {
    mediaId: MEDIA_ID,
    infoHash: HASH,
    fileIndex: FILE_INDEX,
    releaseKey: RELEASE_KEY,
    filename: FILENAME,
  });

  // Pre-existing stale local placement.
  const controlPlane = createControlPlaneStore({ now: () => NOW });
  const stalePlacement = controlPlane.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: HASH,
    providerResourceId: '1111111',
    state: 'ready',
    ownership: 'owned',
    provenance: 'test',
    observedAt: NOW,
    expiresAt: NOW + 300_000,
  });
  controlPlane.replaceProviderFileInventory(stalePlacement.id, [{
    providerFileId: 'file-1',
    path: `/${FILENAME}`,
    name: FILENAME,
    size: 1_000_000,
    selected: true,
  }], { authoritative: true, complete: true, observedAt: NOW, expiresAt: NOW + 300_000 });
  controlPlane.recordFileMapping({
    infoHash: HASH,
    fileIndex: FILE_INDEX,
    releaseKey: RELEASE_KEY,
    placementId: stalePlacement.id,
    providerFileId: 'file-1',
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    mappedAt: NOW,
  });

  // Mock seam: simulates the real seam behavior. On every call, the seam
  // returns a downstream URL. If the placement is the stale one (resource
  // id 1111111), the seam performs the recovery: mylist absent → mark
  // removed → cached-only createtorrent → exact mapping → requestdl
  // succeeds → return recovered URL.
  let seamCallCount = 0;
  const seam = async () => {
    seamCallCount += 1;
    const existing = controlPlane.findPlacementByInfoHash('torbox', HASH);
    let activePlacement = existing;
    if (activePlacement && activePlacement.providerResourceId === '1111111') {
      controlPlane.markPlacementRemoved(activePlacement.id, { reason: 'upstream-resource-absent', observedAt: NOW + 1_000 });
      activePlacement = controlPlane.recordPlacement({
        provider: 'torbox',
        accountScope: 'default',
        infoHash: HASH,
        providerResourceId: '2222222',
        state: 'ready',
        ownership: 'owned',
        provenance: 'torbox-delivery-resolver',
        observedAt: NOW + 1_000,
        expiresAt: NOW + 300_000,
      });
      controlPlane.replaceProviderFileInventory(activePlacement.id, [{
        providerFileId: 'file-1',
        path: `/${FILENAME}`,
        name: FILENAME,
        size: 1_000_000,
        selected: true,
      }], { authoritative: true, complete: true, observedAt: NOW + 1_000, expiresAt: NOW + 300_000 });
      controlPlane.recordFileMapping({
        infoHash: HASH,
        fileIndex: FILE_INDEX,
        releaseKey: RELEASE_KEY,
        placementId: activePlacement.id,
        providerFileId: 'file-1',
        state: 'mapped',
        method: 'provider-filename-exact',
        authoritative: true,
        mappedAt: NOW + 1_000,
      });
    }
    return {
      url: 'https://cdn.example.test/recovered-' + seamCallCount,
      placementId: activePlacement.id,
      providerFileId: 'file-1',
      size: 1_000_000,
      recovered: true,
    };
  };

  // fetchFn: simulates the CDN. The seam's recovered URL is a real
  // downstream URL. First call (stale requestdl) returns 500; the VFS
  // retry uses the seam's recovery outcome (which has a new URL).
  let fetchCalls = 0;
  const fetchFn = async (url) => {
    fetchCalls += 1;
    assert.ok(!url.includes('torrents/requestdl'), 'seam should hand VFS a downstream URL');
    if (fetchCalls === 1) {
      // First read uses the stale URL. Simulate requestdl 500.
      return new Response('forbidden', { status: 500 });
    }
    return new Response('movie-bytes', {
      status: 206,
      headers: { 'content-range': 'bytes 0-10/1000000' },
    });
  };

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    rdClient: null,
    rdResolutionCache: { delete() {}, get() { return null; }, getOrInFlight() { throw new Error('unused'); } },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache: makeCacheMock(),
    fetchFn,
    now: () => NOW + 5_000,
  });

  const request = makeRequest(handler);
  const response = await request(`/vfs/Movies/Movie%20(2024)/${encodeURIComponent('Movie (2024).mkv')}`, {
    method: 'GET',
    headers: { range: 'bytes=0-10' },
  });

  assert.equal(response.status, 206, 'VFS read must succeed after seam repair');
  assert.ok(seamCallCount >= 1, 'seam was called at least once');
  assert.ok(fetchCalls >= 1, 'fetchFn was called');

  const handoff = cache.getPlaybackHandoffByReleaseKey(MEDIA_ID, RELEASE_KEY);
  assert.equal(handoff.infoHash, HASH);
  assert.equal(handoff.fileIndex, FILE_INDEX);
  assert.equal(handoff.releaseKey, RELEASE_KEY);
  const newPlacement = controlPlane.findPlacementByInfoHash('torbox', HASH);
  assert.notEqual(newPlacement.id, stalePlacement.id, 'new placement should replace the stale one');
  assert.equal(newPlacement.providerResourceId, '2222222');
  const staleRow = controlPlane.db.prepare(
    'SELECT state, failure_category FROM provider_placements WHERE id = ?'
  ).get(stalePlacement.id);
  assert.equal(staleRow.state, 'removed');
  assert.equal(staleRow.failure_category, 'upstream-resource-absent');
});
