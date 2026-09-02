// Protocol-invalid 206 reproduction and fix proof for movie/TV WebDAV.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createTvWebDav } from '../src/lib/vfs/tv-webdav.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';
import { RANGE_VALIDATION_REASONS } from '../src/lib/vfs/range-response-validator.js';

const HASH = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const RANGE_HEADER = 'bytes=10-19';
const TOTAL_SIZE = 100;
const EPISODE_URL = new URL(
  'http://localhost/vfs/TV/When%20They%20See%20Us/Season%2001/When%20They%20See%20Us%20-%20S01E02.mkv',
);

function persistEpisode(cache) {
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
    selectionReason: 'e02-repro',
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
    size: 100,
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
    releaseKey: `${HASH}:torrent`,
    infoHash: HASH,
    fileIndex: null,
    filename: 'movie.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed',
    selectionReason: 'e02-movie-repro',
    selectedAt: 1_700_000_000_000,
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt1',
    releaseKey: `${HASH}:torrent`,
    infoHash: HASH,
    fileIndex: null,
    canonicalPath: 'Movies/Movie/movie.mkv',
    size: 100,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
}

function createRangeRequest(range) {
  const request = Readable.from([]);
  request.method = 'GET';
  request.headers = { range };
  return request;
}

function createCapturingResponse() {
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

function makeTvHarness({ fetchFn }) {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  persistEpisode(cache);
  return {
    cache,
    handler: createTvWebDav({
      searchCache: cache,
      rdClient: null,
      rdResolutionCache: {
        delete() {},
        get() { return null; },
        async getOrInFlight() { throw new Error('unused'); },
      },
      resolveTorBoxDeliverySeam: async () => ({
        url: 'https://provider.test/e02',
        size: TOTAL_SIZE,
        placementId: 'pl_e02',
        providerFileId: 'pf_e02',
        accountScope: 'default',
        recovered: false,
      }),
      torBoxDownloadUrlCache: {
        delete() {},
        get() { return null; },
        async getOrInFlight() { throw new Error('unused'); },
      },
      fetchFn,
    }),
  };
}

function makeMovieHarness({ fetchFn }) {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  persistMovie(cache);
  return {
    cache,
    handler: createMovieWebDav({
      searchCache: cache,
      rdClient: null,
      rdResolutionCache: {
        delete() {},
        get() { return null; },
        async getOrInFlight() { throw new Error('unused'); },
      },
      resolveTorBoxDeliverySeam: async () => ({
        url: 'https://provider.test/movie-e02',
        size: TOTAL_SIZE,
        placementId: 'pl_m',
        providerFileId: 'pf_m',
        accountScope: 'default',
        recovered: false,
      }),
      torBoxDownloadUrlCache: {
        delete() {},
        get() { return null; },
        async getOrInFlight() { throw new Error('unused'); },
      },
      fetchFn,
    }),
  };
}

// ---------------------------------------------------------------------------
// E02 reproduction: protocol-invalid 206 with correct headers but wrong body
// ---------------------------------------------------------------------------

test('E02 PROOF TV: 206 with correct Content-Range but empty body returns 502 (was: 206 + 0 bytes shipped)', async (t) => {
  let providerCalls = 0;
  const { cache, handler } = makeTvHarness({
    fetchFn: async () => {
      providerCalls += 1;
      return new Response('', {
        status: 206,
        headers: { 'content-range': 'bytes 10-19/100', 'content-length': '10' },
      });
    },
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest(RANGE_HEADER), res, EPISODE_URL);
  const captured = res._capture();

  assert.equal(captured.status, 502, 'must NOT ship 206 to the client');
  const body = JSON.parse(captured.body.toString('utf8'));
  assert.equal(body.code, 'PROVIDER_RANGE_MISMATCH');
  const humanMsg = body.error || body.message;
  assert.ok(humanMsg && typeof humanMsg === 'string', 'must have a human-readable error/message');
  assert.equal(providerCalls, 1);
});

test('E02 PROOF TV: 206 with correct Content-Range but body shorter than advertised returns 502', async (t) => {
  let providerCalls = 0;
  const { cache, handler } = makeTvHarness({
    fetchFn: async () => {
      providerCalls += 1;
      return new Response('ABCDE', {
        status: 206,
        headers: { 'content-range': 'bytes 10-19/100', 'content-length': '10' },
      });
    },
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest(RANGE_HEADER), res, EPISODE_URL);
  const captured = res._capture();

  assert.equal(captured.status, 502);
  const body = JSON.parse(captured.body.toString('utf8'));
  assert.equal(body.code, 'PROVIDER_RANGE_MISMATCH');
  assert.equal(providerCalls, 1);
});

test('E02 PROOF TV: 206 with correct Content-Range but body LONGER than advertised returns 502', async (t) => {
  const { cache, handler } = makeTvHarness({
    fetchFn: async () => new Response('ABCDEFGHIJKLMNOP', {
      status: 206,
      headers: { 'content-range': 'bytes 10-19/100', 'content-length': '10' },
    }),
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest(RANGE_HEADER), res, EPISODE_URL);
  const captured = res._capture();
  assert.equal(captured.status, 502);
});

// ---------------------------------------------------------------------------
// Classification: every header-validation branch is reachable
// (these surface as thrown errors because openValidatedProviderRead does
// the validate-then-retry dance and the retry also fails).
// ---------------------------------------------------------------------------

test('CLASSIFY TV: status 200 instead of 206 returns 502 STATUS_NOT_206', async (t) => {
  const { cache, handler } = makeTvHarness({
    fetchFn: async () => new Response('abcdefghij', { status: 200 }),
  });
  t.after(() => cache.close());
  await assert.rejects(
    handler(createRangeRequest(RANGE_HEADER), createCapturingResponse(), EPISODE_URL),
    (error) => error.status === 502
      && error.code === 'PROVIDER_RANGE_FAILED'
      && error.validationReason === 'STATUS_NOT_206',
  );
  assert.equal(RANGE_VALIDATION_REASONS.STATUS_NOT_206, 'STATUS_NOT_206');
});

test('CLASSIFY TV: 206 with mismatched Content-Range start returns 502', async (t) => {
  const { cache, handler } = makeTvHarness({
    fetchFn: async () => new Response('abcdefghij', {
      status: 206,
      headers: { 'content-range': 'bytes 0-9/100' },
    }),
  });
  t.after(() => cache.close());
  await assert.rejects(
    handler(createRangeRequest(RANGE_HEADER), createCapturingResponse(), EPISODE_URL),
    (error) => error.status === 502
      && error.code === 'PROVIDER_RANGE_MISMATCH'
      && error.validationReason === 'CONTENT_RANGE_START_MISMATCH',
  );
});

test('CLASSIFY TV: 206 with mismatched Content-Range total returns 502', async (t) => {
  const { cache, handler } = makeTvHarness({
    fetchFn: async () => new Response('abcdefghij', {
      status: 206,
      headers: { 'content-range': 'bytes 10-19/200' },
    }),
  });
  t.after(() => cache.close());
  await assert.rejects(
    handler(createRangeRequest(RANGE_HEADER), createCapturingResponse(), EPISODE_URL),
    (error) => error.status === 502
      && error.code === 'PROVIDER_RANGE_MISMATCH'
      && error.validationReason === 'CONTENT_RANGE_TOTAL_MISMATCH',
  );
});

test('CLASSIFY TV: 206 with valid Content-Range + correct body length passes and ships 206', async (t) => {
  const { cache, handler } = makeTvHarness({
    fetchFn: async () => new Response('0123456789', {
      status: 206,
      headers: { 'content-range': 'bytes 10-19/100' },
    }),
  });
  t.after(() => cache.close());
  const res = createCapturingResponse();
  await handler(createRangeRequest(RANGE_HEADER), res, EPISODE_URL);
  const captured = res._capture();
  assert.equal(captured.status, 206, 'valid range passes through');
  assert.equal(captured.headers['content-range'], 'bytes 10-19/100');
  assert.equal(captured.body.toString('utf8'), '0123456789', 'body bytes flow');
});

// ---------------------------------------------------------------------------
// Movie path: same fix applies.
// ---------------------------------------------------------------------------

test('E02 PROOF MOVIE: 206 with correct Content-Range but empty body returns 502', async (t) => {
  const { cache, handler } = makeMovieHarness({
    fetchFn: async () => new Response('', {
      status: 206,
      headers: { 'content-range': 'bytes 10-19/100', 'content-length': '10' },
    }),
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest(RANGE_HEADER), res, new URL('http://localhost/vfs/Movies/Movie/movie.mkv'));
  const captured = res._capture();
  assert.equal(captured.status, 502);
  const body = JSON.parse(captured.body.toString('utf8'));
  assert.equal(body.code, 'PROVIDER_RANGE_MISMATCH');
});

test('E02 PROOF MOVIE: 206 with correct Content-Range but short body returns 502', async (t) => {
  const { cache, handler } = makeMovieHarness({
    fetchFn: async () => new Response('ABCDE', {
      status: 206,
      headers: { 'content-range': 'bytes 10-19/100', 'content-length': '10' },
    }),
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest(RANGE_HEADER), res, new URL('http://localhost/vfs/Movies/Movie/movie.mkv'));
  const captured = res._capture();
  assert.equal(captured.status, 502);
});

test('E02 PROOF MOVIE: valid 206 passes through', async (t) => {
  const { cache, handler } = makeMovieHarness({
    fetchFn: async () => new Response('0123456789', {
      status: 206,
      headers: { 'content-range': 'bytes 10-19/100' },
    }),
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest(RANGE_HEADER), res, new URL('http://localhost/vfs/Movies/Movie/movie.mkv'));
  const captured = res._capture();
  assert.equal(captured.status, 206);
  assert.equal(captured.body.toString('utf8'), '0123456789');
});
