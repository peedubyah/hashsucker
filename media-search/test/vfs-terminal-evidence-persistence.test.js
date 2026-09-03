// One-bounded-RED-GREEN proof that the VFS byte path actually persists
// terminal delivery evidence to the control-plane store.
//
// Background: the bounded fresh-capability retry inside tv-webdav and
// movie-webdav was designed to record a terminal row when both attempts
// fail protocol validation. A local `const state = 'terminal'` shadowed
// the outer `state` parameter (which has `.entry`); every read of
// `state.entry.infoHash` then threw, and the surrounding try/catch
// swallowed the throw as a warning — so terminal evidence was NEVER
// recorded from the VFS byte path. This test fails closed: an end-to-end
// reproduction that drives the real VFS handlers and asserts a terminal
// row exists in the control-plane evidence table.
//
// RED would have failed: terminal row missing. GREEN passes: terminal
// row is persisted exactly once and carries the expected (provider,
// placement_id, provider_file_id, info_hash, file_index_key).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createTerminalDeliveryEvidenceStore } from '../src/lib/resolver/terminal-delivery-evidence.js';
import { createTvWebDav } from '../src/lib/vfs/tv-webdav.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';

const HASH = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const TOTAL_SIZE = 100;
const RANGE = 'bytes=10-19';
const EPISODE_URL = new URL(
  'http://localhost/vfs/TV/When%20They%20See%20Us/Season%2001/When%20They%20See%20Us%20-%20S01E02.mkv',
);
const MOVIE_URL = new URL('http://localhost/vfs/Movies/Movie/movie.mkv');

function makeRangeRequest(range) {
  const request = Readable.from([]);
  request.method = 'GET';
  request.headers = { range };
  return request;
}

function makeResponse() {
  const response = new Writable({ write(_c, _e, cb) { cb(); } });
  let status = null;
  let headers = null;
  let body = Buffer.alloc(0);
  response.writeHead = function writeHead(s, h) { status = s; headers = h; };
  const origWrite = response.write.bind(response);
  response.write = function write(c) {
    body = Buffer.concat([body, Buffer.isBuffer(c) ? c : Buffer.from(String(c))]);
    return origWrite(c);
  };
  const origEnd = response.end.bind(response);
  response.end = function end(c) {
    if (c) body = Buffer.concat([body, Buffer.isBuffer(c) ? c : Buffer.from(String(c))]);
    return origEnd(c);
  };
  response._capture = () => ({ status, headers, body });
  return response;
}

function persistTv(cache) {
  const requestId = cache.persistMediaRequest({
    mediaId: 'tt7577910',
    mediaType: 'series',
    season: 1,
    episode: 2,
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt7577910',
    mediaType: 'series',
    season: 1,
    episode: 2,
    releaseKey: `${HASH}:torrent`,
    infoHash: HASH,
    fileIndex: null,
    filename: 'When They See Us - S01E02.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed',
    selectionReason: 'shadow-repro-tv',
    selectedAt: 1_700_000_000_000,
  });
  cache.createVfsTvEntry({
    mediaId: 'tt7577910',
    season: 1,
    episode: 2,
    releaseKey: `${HASH}:torrent`,
    infoHash: HASH,
    fileIndex: null,
    canonicalPath: 'TV/When They See Us/Season 01/When They See Us - S01E02.mkv',
    size: TOTAL_SIZE,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
}

function persistMovie(cache) {
  const requestId = cache.persistMediaRequest({
    mediaId: 'tt1',
    mediaType: 'movie',
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt1',
    mediaType: 'movie',
    releaseKey: `${HASH}:1`,
    infoHash: HASH,
    fileIndex: 1,
    filename: 'movie.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed',
    selectionReason: 'shadow-repro-movie',
    selectedAt: 1_700_000_000_000,
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt1',
    releaseKey: `${HASH}:1`,
    infoHash: HASH,
    fileIndex: 1,
    canonicalPath: 'Movies/Movie/movie.mkv',
    size: TOTAL_SIZE,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
}

function makeTvHarness({ controlPlaneStore, terminalEvidenceStore, fetchFn }) {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  persistTv(cache);
  return {
    cache,
    handler: createTvWebDav({
      searchCache: cache,
      controlPlaneStore,
      rdClient: null,
      rdResolutionCache: {
        delete() {},
        get() { return null; },
        async getOrInFlight() { throw new Error('unused'); },
      },
      resolveTorBoxDeliverySeam: async () => ({
        url: 'https://provider.test/e02',
        size: TOTAL_SIZE,
        placementId: 'pl_tv_shadow',
        providerFileId: 'pf_tv_shadow',
        accountScope: 'default',
        recovered: false,
      }),
      torBoxDownloadUrlCache: {
        delete() {},
        get() { return null; },
        async getOrInFlight() { throw new Error('unused'); },
        invalidateByCapability() {},
      },
      terminalEvidenceStore,
      fetchFn,
    }),
  };
}

function makeMovieHarness({ controlPlaneStore, terminalEvidenceStore, fetchFn }) {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  persistMovie(cache);
  return {
    cache,
    handler: createMovieWebDav({
      searchCache: cache,
      controlPlaneStore,
      rdClient: null,
      rdResolutionCache: {
        delete() {},
        get() { return null; },
        async getOrInFlight() { throw new Error('unused'); },
      },
      resolveTorBoxDeliverySeam: async () => ({
        url: 'https://provider.test/movie-e02',
        size: TOTAL_SIZE,
        placementId: 'pl_movie_shadow',
        providerFileId: 'pf_movie_shadow',
        accountScope: 'default',
        recovered: false,
      }),
      torBoxDownloadUrlCache: {
        delete() {},
        get() { return null; },
        async getOrInFlight() { throw new Error('unused'); },
        invalidateByCapability() {},
      },
      terminalEvidenceStore,
      fetchFn,
    }),
  };
}

test('TV: bounded fresh-capability retry after protocol-invalid PERSISTS terminal evidence (shadow repair)', async (t) => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  controlPlaneStore.recordPlacement({
    id: 'pl_tv_shadow',
    provider: 'torbox',
    accountScope: 'default',
    infoHash: HASH,
    providerResourceId: 'pl_tv_shadow',
    state: 'ready',
    ownership: 'owned',
    provenance: 'shadow-test',
    observedAt: 1_700_000_000_000,
  });
  const terminalEvidenceStore = createTerminalDeliveryEvidenceStore({
    controlPlaneStore,
    terminalTtlMs: 10 * 60 * 1000,
    now: () => 1_700_000_000_000,
  });
  let providerCalls = 0;
  const { cache, handler } = makeTvHarness({
    controlPlaneStore,
    terminalEvidenceStore,
    fetchFn: async () => {
      providerCalls += 1;
      // 401 forces the header validator to return STATUS_NOT_206
      // (and classifies as 'stale' → firstFailureDefinitive=true on
      // attempt 0), so the byte path enters the bounded fresh-retry
      // branch. Attempt 1 also returns 401 → terminal evidence
      // recording block runs.
      return new Response('', { status: 401 });
    },
  });
  t.after(() => cache.close());

  await assert.rejects(
    handler(makeRangeRequest(RANGE), makeResponse(), EPISODE_URL),
    (error) => error.status === 502,
  );
  // Both attempts must be made (cached + fresh).
  assert.equal(providerCalls, 2);

  // THE BUG would have left the evidence table empty. With the repair
  // the row is recorded exactly once with the correct (provider,
  // accountScope, placementId, providerFileId, infoHash, fileIndexKey).
  const rows = controlPlaneStore.listDeliveryEvidenceForHash(HASH, -1);
  assert.equal(rows.length, 1, 'exactly one terminal evidence row should be persisted');
  const row = rows[0];
  assert.equal(row.state, 'terminal');
  assert.equal(row.provider, 'torbox');
  assert.equal(row.accountScope, 'default');
  assert.equal(row.placementId, 'pl_tv_shadow');
  assert.equal(row.providerFileId, 'pf_tv_shadow');
  assert.equal(row.infoHash, HASH);
  assert.equal(row.fileIndexKey, -1);
  assert.match(row.reason, /protocol-invalid-after-fresh-retry/);
});

test('MOVIE: bounded fresh-capability retry after protocol-invalid PERSISTS terminal evidence (shadow repair)', async (t) => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  controlPlaneStore.recordPlacement({
    id: 'pl_movie_shadow',
    provider: 'torbox',
    accountScope: 'default',
    infoHash: HASH,
    providerResourceId: 'pl_movie_shadow',
    state: 'ready',
    ownership: 'owned',
    provenance: 'shadow-test',
    observedAt: 1_700_000_000_000,
  });
  const terminalEvidenceStore = createTerminalDeliveryEvidenceStore({
    controlPlaneStore,
    terminalTtlMs: 10 * 60 * 1000,
    now: () => 1_700_000_000_000,
  });
  let providerCalls = 0;
  const { cache, handler } = makeMovieHarness({
    controlPlaneStore,
    terminalEvidenceStore,
    fetchFn: async () => {
      providerCalls += 1;
      return new Response('', { status: 401 });
    },
  });
  t.after(() => cache.close());

  // Movie-webdav sends the byte-path failure as a 502 response
  // (PROVIDER_RANGE_FAILED) rather than re-throwing.
  const res = makeResponse();
  await handler(makeRangeRequest(RANGE), res, MOVIE_URL);
  const captured = res._capture();
  assert.equal(captured.status, 502);
  assert.equal(providerCalls, 2);

  const rows = controlPlaneStore.listDeliveryEvidenceForHash(HASH, 1);
  assert.equal(rows.length, 1, 'exactly one terminal evidence row should be persisted');
  const row = rows[0];
  assert.equal(row.state, 'terminal');
  assert.equal(row.provider, 'torbox');
  assert.equal(row.placementId, 'pl_movie_shadow');
  assert.equal(row.providerFileId, 'pf_movie_shadow');
  assert.equal(row.infoHash, HASH);
  assert.equal(row.fileIndexKey, 1);
  assert.match(row.reason, /protocol-invalid-after-fresh-retry/);
});
