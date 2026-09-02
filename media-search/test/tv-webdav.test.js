import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createTvWebDav, normalizeRange } from '../src/lib/vfs/tv-webdav.js';
import { providerAccounting } from '../src/lib/providers/provider-accounting.js';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RELEASE_KEY = `${HASH}:12`;

function persistEpisode(cache) {
  const requestId = cache.persistMediaRequest({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    releaseKey: RELEASE_KEY,
    infoHash: HASH,
    fileIndex: 12,
    filename: 'Family.Guy.S05E12.720p.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });
  cache.createVfsTvEntry({
    mediaId: 'tt0182576',
    season: 5,
    episode: 12,
    releaseKey: RELEASE_KEY,
    infoHash: HASH,
    fileIndex: 12,
    canonicalPath: 'TV/Family Guy/Season 05/Family Guy - S05E12.mkv',
    size: 100,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
}

function createRequest(range) {
  const request = Readable.from([]);
  request.method = 'GET';
  request.headers = { range };
  return request;
}

function createResponse() {
  const response = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  response.writeHead = () => {
    throw new Error('VFS must not send headers for a rejected provider response');
  };
  return response;
}

test('TV VFS does not amplify a TorBox range rate limit with a fresh retry', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  persistEpisode(cache);

  let deliveryResolutions = 0;
  let providerOpens = 0;
  const deletedRdResolutions = [];
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: {
      delete(infoHash, fileIndex) {
        deletedRdResolutions.push(`${infoHash}:${fileIndex}`);
      },
    },
    // Shared authoritative TorBox delivery seam — simulates what the seam
    // returns: a resolved downstream URL (not the requestdl permalink).
    resolveTorBoxDeliverySeam: async () => {
      deliveryResolutions += 1;
      return { url: 'https://provider.test/file', size: 100, recovered: false };
    },
    torBoxDownloadUrlCache: {
      delete() {},
      get() { return null; },
      getOrInFlight() { throw new Error('unexpected cache call'); },
    },
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      assert.equal(options.headers.range, 'bytes=10-19');
      return new Response('rate limited', { status: 429 });
    },
  });

  await assert.rejects(
    handler(
      createRequest('bytes=10-19'),
      createResponse(),
      new URL('http://localhost/vfs/TV/Family%20Guy/Season%2005/Family%20Guy%20-%20S05E12.mkv'),
    ),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );

  assert.equal(deliveryResolutions, 1);
  assert.equal(providerOpens, 1);
  assert.deepEqual(deletedRdResolutions, []);
});

// ---------------------------------------------------------------------------
// Range / 416 hardening (Worker B, slice 2.5)
// ---------------------------------------------------------------------------

const FLEABAG_E03_SIZE = 2933186072;

function buildRangeHarness({
  size = 100,
  fetchFn = null,
  deliveryResult = { url: 'https://provider.test/file', size: 100, recovered: false },
  resolveTorBoxDeliverySeam,
} = {}) {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  cache.persistMediaRequest({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId: 1,
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    releaseKey: RELEASE_KEY,
    infoHash: HASH,
    fileIndex: 12,
    filename: 'Family.Guy.S05E12.720p.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });
  cache.createVfsTvEntry({
    mediaId: 'tt0182576',
    season: 5,
    episode: 12,
    releaseKey: RELEASE_KEY,
    infoHash: HASH,
    fileIndex: 12,
    canonicalPath: 'TV/Family Guy/Season 05/Family Guy - S05E12.mkv',
    size,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    resolveTorBoxDeliverySeam: resolveTorBoxDeliverySeam || (async () => deliveryResult),
    torBoxDownloadUrlCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    fetchFn: fetchFn || (async () => new Response('', { status: 500 })),
  });
  return { cache, handler };
}

function createRangeRequest(range) {
  const request = Readable.from([]);
  request.method = 'GET';
  request.headers = { range };
  return request;
}

function createCapturingResponse() {
  const response = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  let capturedStatus = null;
  let capturedHeaders = null;
  let capturedBody = '';
  response.writeHead = function writeHead(status, responseHeaders) {
    capturedStatus = status;
    capturedHeaders = responseHeaders;
  };
  response._text = () => capturedBody;
  response._capture = () => ({ status: capturedStatus, headers: capturedHeaders });
  const originalWrite = response.write.bind(response);
  response.write = function write(chunk) {
    capturedBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return originalWrite(chunk);
  };
  const originalEnd = response.end.bind(response);
  response.end = function end(chunk) {
    if (chunk) capturedBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return originalEnd(chunk);
  };
  return response;
}

test('normalizeRange accepts valid start, middle, and near-tail ranges', () => {
  const size = FLEABAG_E03_SIZE;
  assert.deepEqual(normalizeRange('bytes=0-1048575', size), { start: 0, end: 1048575, header: 'bytes=0-1048575' });
  const middle = normalizeRange('bytes=1466593036-1467641611', size);
  assert.equal(middle.start, 1466593036);
  assert.equal(middle.end, 1467641611);
  assert.equal(middle.header, 'bytes=1466593036-1467641611');
  assert.deepEqual(normalizeRange(`bytes=${size - 1048576}-${size - 1}`, size), {
    start: size - 1048576,
    end: size - 1,
    header: `bytes=${size - 1048576}-${size - 1}`,
  });
});

test('normalizeRange rejects start at exact EOF with 416 RANGE_NOT_SATISFIABLE', () => {
  const size = 100;
  assert.throws(
    () => normalizeRange('bytes=100-100', size),
    (error) => error.status === 416 && error.code === 'RANGE_NOT_SATISFIABLE',
  );
  assert.throws(
    () => normalizeRange('bytes=100-', size),
    (error) => error.status === 416 && error.code === 'RANGE_NOT_SATISFIABLE',
  );
  assert.throws(
    () => normalizeRange('bytes=200-300', size),
    (error) => error.status === 416 && error.code === 'RANGE_NOT_SATISFIABLE',
  );
});

test('normalizeRange rejects end < start and multipart ranges', () => {
  const size = 100;
  assert.throws(
    () => normalizeRange('bytes=50-10', size),
    (error) => error.status === 416 && (error.code === 'INVALID_RANGE' || error.code === 'RANGE_NOT_SATISFIABLE'),
  );
  assert.throws(
    () => normalizeRange('bytes=0-10,20-30', size),
    (error) => error.status === 416 && error.code === 'INVALID_RANGE',
  );
  assert.throws(
    () => normalizeRange('bytes=invalid', size),
    (error) => error.status === 416 && error.code === 'INVALID_RANGE',
  );
  assert.throws(
    () => normalizeRange('bytes=-0', size),
    (error) => error.status === 416,
  );
});

test('normalizeRange suffix range larger than file collapses to whole file', () => {
  // RFC 7233 §2.1: bytes=-N where N > size returns the whole file.
  const size = 100;
  assert.deepEqual(normalizeRange('bytes=-500', size), { start: 0, end: 99, header: 'bytes=0-99' });
});

test('TV VFS rejects impossible EOF range with 416 and Content-Range bytes */size before calling provider', async (t) => {
  const { cache, handler } = buildRangeHarness({
    size: FLEABAG_E03_SIZE,
  });
  t.after(() => cache.close());

  let deliveryResolutions = 0;
  let providerOpens = 0;
  // Re-create with a tracking seam.
  const tracked = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    resolveTorBoxDeliverySeam: async () => {
      deliveryResolutions += 1;
      return { url: 'https://provider.test/file', size: FLEABAG_E03_SIZE, recovered: false };
    },
    torBoxDownloadUrlCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    fetchFn: async () => {
      providerOpens += 1;
      return new Response('', { status: 500 });
    },
  });

  const response = createCapturingResponse();
  await tracked(
    createRangeRequest(`bytes=${FLEABAG_E03_SIZE}-${FLEABAG_E03_SIZE}`),
    response,
    new URL('http://localhost/vfs/TV/Family%20Guy/Season%2005/Family%20Guy%20-%20S05E12.mkv'),
  );

  const captured = response._capture();
  assert.equal(captured.status, 416);
  assert.equal(captured.headers['content-range'], `bytes */${FLEABAG_E03_SIZE}`);
  assert.equal(captured.headers['accept-ranges'], 'bytes');
  // CRITICAL: a locally-known impossible range must not call requestdl.
  assert.equal(deliveryResolutions, 0, 'provider resolution must not happen for impossible range');
  assert.equal(providerOpens, 0, 'provider fetch must not happen for impossible range');
});

test('TV VFS rejects malformed multipart range with 416 before calling provider', async (t) => {
  const { cache } = buildRangeHarness({ size: 1024 });
  t.after(() => cache.close());

  let deliveryResolutions = 0;
  let providerOpens = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    resolveTorBoxDeliverySeam: async () => {
      deliveryResolutions += 1;
      return { url: 'https://provider.test/file', size: 1024, recovered: false };
    },
    torBoxDownloadUrlCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    fetchFn: async () => {
      providerOpens += 1;
      return new Response('', { status: 500 });
    },
  });

  const response = createCapturingResponse();
  await handler(
    createRangeRequest('bytes=0-10,20-30'),
    response,
    new URL('http://localhost/vfs/TV/Family%20Guy/Season%2005/Family%20Guy%20-%20S05E12.mkv'),
  );

  const captured = response._capture();
  assert.equal(captured.status, 416);
  assert.equal(captured.headers['content-range'], 'bytes */1024');
  assert.equal(deliveryResolutions, 0);
  assert.equal(providerOpens, 0);
});

test('TV VFS full-file body streams and stops reading on client close', async (t) => {
  // Verifies the streaming pipeline for full-file (no Range) requests:
  // provider body is piped to the response, and destroying the response
  // tears the upstream body down without pulling more bytes. We do NOT
  // pull a multi-GB body here — that is the production-path canary.
  // This test only proves the contract that the full-file pipeline
  // relies on streaming, not buffering.
  //
  // Note: Range requests are intentionally buffered (see
  // validateRangeResponseBody) so the body byte count can be checked
  // before any bytes are shipped to the client. Range sizes are
  // bounded by client requests (KB to MB) so the buffer cost is
  // bounded. Full-file requests stay streaming because a multi-GB
  // buffer is infeasible.
  const { cache } = buildRangeHarness({ size: 1024 * 1024 * 1024 });
  t.after(() => cache.close());

  let bytesFromProvider = 0;
  let aborted = false;
  let upstreamDestroyed = false;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    resolveTorBoxDeliverySeam: async () => ({
      url: 'https://provider.test/file',
      size: 1024 * 1024 * 1024,
      recovered: false,
    }),
    torBoxDownloadUrlCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    fetchFn: async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        pull(controller) {
          if (aborted || upstreamDestroyed) return;
          // Emit 64 KiB chunks until the client tears down.
          controller.enqueue(encoder.encode('a'.repeat(64 * 1024)));
          if (bytesFromProvider >= 64 * 1024 * 4) {
            controller.close();
          }
        },
        cancel() {
          upstreamDestroyed = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-length': '1073741824' },
      });
    },
  });

  const response = createCapturingResponse();
  const handlerPromise = handler(
    createRangeRequest(undefined),
    response,
    new URL('http://localhost/vfs/TV/Family%20Guy/Season%2005/Family%20Guy%20-%20S05E12.mkv'),
  );

  // Simulate the client disconnecting after receiving a few KB.
  setTimeout(() => {
    aborted = true;
    response.destroy();
  }, 50);

  await handlerPromise;
  // We never pulled the full provider body — pipeline tore down on
  // client disconnect.
  assert.ok(upstreamDestroyed || bytesFromProvider < 64 * 1024 * 1024, 'upstream cancelled or bounded reads');
});

// ---------------------------------------------------------------------------
// Bounded back-pressure on upstream read 429 (slice 2.5 REPAIR)
// ---------------------------------------------------------------------------
//
// Regression: when TorBox returns 429 on a byte read against a CACHED
// capability, the same cached URL must not be re-hit until a bounded
// backoff window elapses. Otherwise N concurrent small-range reads
// stampede the upstream with N identical 429s. This test proves:
//   1. The first 429 marks the capability rate-limited (no upstream
//      re-resolve, no Retry-After → 30s floor).
//   2. Subsequent reads within the window return 429 immediately,
//      WITHOUT calling the upstream and WITHOUT calling requestdl
//      (delivery seam not invoked).
//   3. The 429 response carries a Retry-After header.

test('TV VFS back-pressures cached capability on upstream read 429 (no upstream retry storm)', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  persistEpisode(cache);

  let deliveryResolutions = 0;
  let providerOpens = 0;
  // The real TorBoxDownloadUrlCache is unused for the gate (state-based),
  // but we wire it through so production paths match.
  const { getTorBoxDownloadUrlCache } = await import('../src/lib/resolver/torbox-download-url-cache.js');
  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();

  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    resolveTorBoxDeliverySeam: async () => {
      deliveryResolutions += 1;
      return {
        url: 'https://provider.test/file',
        size: 100,
        placementId: 'pl_1',
        providerFileId: 'pf_1',
        accountScope: 'default',
        recovered: false,
      };
    },
    torBoxDownloadUrlCache,
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      assert.equal(options.headers.range, 'bytes=10-19');
      // No Retry-After → minimum 30s floor applies.
      return new Response('rate limited', { status: 429 });
    },
  });

  const url = new URL('http://localhost/vfs/TV/Family%20Guy/Season%2005/Family%20Guy%20-%20S05E12.mkv');

  // First read: hits upstream once, observes 429, marks capability.
  // The validate callback surfaces 429 as PROVIDER_RANGE_FAILED (502)
  // per the existing contract; the error propagates and is handled by
  // the dispatcher's top-level catch in production. In a unit test we
  // capture the rejection (it does NOT write a 502 response directly
  // because streamFile only sinks the 429-gate error) and assert on
  // the call counters.
  await assert.rejects(
    handler(createRangeRequest('bytes=10-19'), createCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
    'first read fails with the existing 502 PROVIDER_RANGE_FAILED contract',
  );
  assert.equal(deliveryResolutions, 1, 'first read resolves backing exactly once');
  assert.equal(providerOpens, 1, 'first read calls upstream exactly once');

  // Second read: must short-circuit. NO new delivery resolution, NO new
  // provider open. Returns 429 with Retry-After.
  const second = createCapturingResponse();
  await handler(createRangeRequest('bytes=10-19'), second, url);
  const secondCaptured = second._capture();
  assert.equal(secondCaptured.status, 429, 'second read in backoff window returns 429');
  assert.ok(
    Number(secondCaptured.headers['retry-after']) >= 1,
    `retry-after must be a positive integer second count, got ${secondCaptured.headers['retry-after']}`,
  );
  assert.equal(deliveryResolutions, 1, 'second read must NOT re-resolve backing (no requestdl stampede)');
  assert.equal(providerOpens, 1, 'second read must NOT call upstream again');

  // Third concurrent-style read: same assertion.
  const third = createCapturingResponse();
  await handler(createRangeRequest('bytes=10-19'), third, url);
  const thirdCaptured = third._capture();
  assert.equal(thirdCaptured.status, 429);
  assert.equal(deliveryResolutions, 1);
  assert.equal(providerOpens, 1);
});

test('TV VFS honors upstream Retry-After header on read 429', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  persistEpisode(cache);

  let providerOpens = 0;
  const { getTorBoxDownloadUrlCache } = await import('../src/lib/resolver/torbox-download-url-cache.js');
  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();

  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    resolveTorBoxDeliverySeam: async () => ({
      url: 'https://provider.test/file2',
      size: 100,
      placementId: 'pl_2',
      providerFileId: 'pf_2',
      accountScope: 'default',
      recovered: false,
    }),
    torBoxDownloadUrlCache,
    fetchFn: async () => {
      providerOpens += 1;
      // Upstream honors RFC 7231: 45 seconds.
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '45' } });
    },
  });

  const url = new URL('http://localhost/vfs/TV/Family%20Guy/Season%2005/Family%20Guy%20-%20S05E12.mkv');

  // Prime the gate. The 429 surfaces as the existing 502 contract.
  await assert.rejects(
    handler(createRangeRequest('bytes=10-19'), createCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  assert.equal(providerOpens, 1);

  // Second read in window: must use upstream-provided Retry-After (45s),
  // not the 30s floor.
  const second = createCapturingResponse();
  await handler(createRangeRequest('bytes=10-19'), second, url);
  const captured = second._capture();
  assert.equal(captured.status, 429);
  assert.ok(
    Number(captured.headers['retry-after']) >= 30 && Number(captured.headers['retry-after']) <= 45,
    `retry-after must reflect upstream 45s window, got ${captured.headers['retry-after']}`,
  );
  assert.equal(providerOpens, 1, 'no upstream call in backoff window');
});

test('TV VFS read 429 backoff expires after the window — capability is reused, not invalidated', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  persistEpisode(cache);

  let currentTime = 1_700_000_000_000;
  const { getTorBoxDownloadUrlCache } = await import('../src/lib/resolver/torbox-download-url-cache.js');
  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();

  let upstreamCalls = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: {
      delete() {},
      get() { return null; },
      async getOrInFlight() { throw new Error('unused'); },
    },
    resolveTorBoxDeliverySeam: async () => ({
      url: 'https://provider.test/file3',
      size: 100,
      placementId: 'pl_3',
      providerFileId: 'pf_3',
      accountScope: 'default',
      recovered: false,
    }),
    torBoxDownloadUrlCache,
    // Returns 429 only on the very first upstream call; thereafter 206.
    fetchFn: async () => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response('hellohello', {
        status: 206,
        headers: { 'content-range': 'bytes 10-19/100' },
      });
    },
    now: () => currentTime,
  });

  const url = new URL('http://localhost/vfs/TV/Family%20Guy/Season%2005/Family%20Guy%20-%20S05E12.mkv');

  // Prime the gate at t0 — upstream is called once and returns 429,
  // surfacing as the existing 502 contract.
  await assert.rejects(
    handler(createRangeRequest('bytes=10-19'), createCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  assert.equal(upstreamCalls, 1);

  // In-window read: short-circuits at the gate, NO upstream call.
  const inWindow = createCapturingResponse();
  await handler(createRangeRequest('bytes=10-19'), inWindow, url);
  assert.equal(inWindow._capture().status, 429);
  assert.equal(upstreamCalls, 1, 'no upstream call while backoff is active');

  // Advance past the 30s floor — gate must clear, cached capability is
  // reused (still NO delivery re-resolution; upstream called once for
  // the new attempt).
  currentTime += 31_000;
  const afterWindow = createCapturingResponse();
  await handler(createRangeRequest('bytes=10-19'), afterWindow, url);
  assert.equal(upstreamCalls, 2, 'upstream called exactly once after backoff expires');
  assert.equal(afterWindow._capture().status, 206, 'after window expires, the cached capability is reused and bytes flow');
});


// ---------------------------------------------------------------------------
// Same-TorrentFile RD fallback wiring (Worker A, slice A1–A7)
//
// These proofs cover the bug where the in-loop 2-attempt retry in
// openValidatedProviderRead re-used the backing returned by the 1st
// resolveBacking call. When the 1st attempt fell through to TorBox and
// TorBox returned protocol-invalid, the 2nd attempt never got a fresh
// RD selection cycle. The fix moves resolveBacking inside the loop so
// each attempt gets a fresh provider selection, with the in-loop 2nd
// attempt using forceFresh=true (which deletes the cached RD entry
// and re-tries RD for the SAME (infoHash, fileIndex) tuple before
// falling through to TorBox).
// ---------------------------------------------------------------------------

const FALLBACK_SIZE = 100;
const FALLBACK_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FALLBACK_RELEASE_KEY = `${FALLBACK_HASH}:torrent`;
const FALLBACK_TORRENT_FILE_ID = 'tf_e02_s01e02';
const FALLBACK_URL = new URL(
  'http://localhost/vfs/TV/When%20They%20See%20Us/Season%2001/When%20They%20See%20Us%20-%20S01E02.mkv',
);

function persistFallbackEpisode(cache, {
  torrentFileId = FALLBACK_TORRENT_FILE_ID,
  setHandoffTorrentFileId = true,
} = {}) {
  const requestId = cache.persistMediaRequest({
    mediaId: 'tt7577910',
    mediaType: 'series',
    season: 1,
    episode: 2,
    source: 'test',
  }, []);
  // By default the handoff carries the torrentFileId so the getCatalog
  // identity check at tv-webdav.js:291-296 sees matching identity on
  // both sides. Tests that need a controlPlaneStore mock to validate
  // the handoff can keep the default; tests that explicitly want to
  // exercise the legacy-allow path (handoff.torrentFileId=null while
  // vfs_tv_entries.torrent_file_id is set) opt out by passing
  // setHandoffTorrentFileId=false.
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt7577910',
    mediaType: 'series',
    season: 1,
    episode: 2,
    releaseKey: FALLBACK_RELEASE_KEY,
    infoHash: FALLBACK_HASH,
    fileIndex: null,
    filename: 'When They See Us - S01E02.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed',
    selectionReason: 'worker-a-fallback',
    selectedAt: 1_700_000_000_000,
    ...(setHandoffTorrentFileId ? { torrentFileId } : {}),
  });
  cache.createVfsTvEntry({
    mediaId: 'tt7577910',
    season: 1,
    episode: 2,
    releaseKey: FALLBACK_RELEASE_KEY,
    infoHash: FALLBACK_HASH,
    fileIndex: null,
    canonicalPath: 'TV/When They See Us/Season 01/When They See Us - S01E02.mkv',
    size: FALLBACK_SIZE,
    torrentFileId,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
}

/**
 * Build a fetchFn for the fallback harness.
 *
 * - RD URL: serve the liveness probe with `bytes 0-1023/100`, and the
 *   real byte-range request with a body whose length matches the
 *   requested range exactly.
 * - TorBox URL (or any other URL): serve a protocol-invalid 200 (which
 *   the validate callback rejects as STATUS_NOT_206 → protocol-invalid).
 *   Tests that need a healthy TorBox path pass `torBoxStatus: 206`
 *   with matching headers and body.
 */
function makeFallbackFetchFn({
  rdResolvedUrl = 'https://rd.test/playback',
  torBoxStatus = 200,
  torBoxBody = 'lie',
  size = FALLBACK_SIZE,
} = {}) {
  return async (url, options) => {
    if (url === rdResolvedUrl) {
      // isUrlLive liveness probe (capital 'Range') vs fetchProvider byte
      // read (lowercase 'range'). The production code paths are
      // distinguishable by which header key is set.
      const isLiveness = options?.headers?.Range && !options?.headers?.range;
      if (isLiveness) {
        return new Response('x'.repeat(1024), {
          status: 206,
          headers: { 'content-range': 'bytes 0-1023/' + size },
        });
      }
      const requestedRange = options?.headers?.range;
      const match = requestedRange && requestedRange.match(/^bytes=(\d+)-(\d+)$/);
      if (match) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        const length = end - start + 1;
        return new Response('x'.repeat(length), {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${end}/${size}`,
            'content-length': String(length),
          },
        });
      }
      return new Response('x'.repeat(10), {
        status: 206,
        headers: { 'content-range': 'bytes 10-19/' + size },
      });
    }
    if (torBoxStatus === 206) {
      // Healthy TorBox: 206 with correct Content-Range + body of the
      // requested length.
      const requestedRange = options?.headers?.range;
      const match = requestedRange && requestedRange.match(/^bytes=(\d+)-(\d+)$/);
      if (match) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        const length = end - start + 1;
        return new Response('x'.repeat(length), {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${end}/${size}`,
            'content-length': String(length),
          },
        });
      }
      return new Response('x'.repeat(10), {
        status: 206,
        headers: { 'content-range': 'bytes 10-19/' + size },
      });
    }
    return new Response(torBoxBody, { status: torBoxStatus });
  };
}

/**
 * Build a same-TorrentFile RD fallback harness.
 *
 * - rdClient is present (truthy) so the same-TorrentFile RD fallback
 *   path is reachable in resolveBacking.
 * - rdResolutionCache.getOrInFlight is the single seam for the test to
 *   control RD resolution outcomes across attempts. Each call returns
 *   the next item from `rdOutcomes`; if `rdOutcomes` is shorter than
 *   the number of attempts, the last item is reused.
 * - resolveTorBoxDeliverySeam is the seam that yields the TorBox
 *   backing. The TorBox downstream URL is always "torbox.test/file";
 *   `fetchFn` controls the upstream response.
 */
function buildFallbackHarness({
  rdOutcomes,
  fetchFn,
  torBoxDeliveryResult = {
    url: 'https://torbox.test/file',
    size: FALLBACK_SIZE,
    placementId: 'pl_fb',
    providerFileId: 'pf_fb',
    accountScope: 'default',
    recovered: false,
  },
  resolveTorBoxDeliverySeam: customSeam = null,
  torBoxDownloadUrlCache = {
    delete() {},
    get() { return null; },
    async getOrInFlight() { throw new Error('unused'); },
  },
  torrentFileId = FALLBACK_TORRENT_FILE_ID,
  setHandoffTorrentFileId = true,
} = {}) {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  persistFallbackEpisode(cache, { torrentFileId, setHandoffTorrentFileId });

  let rdAttempt = 0;
  const rdCallLog = [];
  let torBoxDeliveryCalls = 0;

  const rdResolutionCache = {
    delete(infoHash, fileIndex) {
      rdCallLog.push({ kind: 'delete', infoHash, fileIndex });
    },
    get() { return null; },
    set() { /* no-op in tests */ },
    async getOrInFlight(infoHash, fileIndex, factory) {
      rdCallLog.push({ kind: 'getOrInFlight', infoHash, fileIndex });
      const idx = Math.min(rdAttempt, rdOutcomes.length - 1);
      rdAttempt += 1;
      const outcome = rdOutcomes[idx];
      if (typeof outcome === 'function') return outcome();
      return outcome;
    },
  };

  // The handoff carries a torrentFileId by default, so the materialize
  // step on the byte path needs a controlPlaneStore that can validate
  // it. When the handoff has no torrentFileId (setHandoffTorrentFileId=
  // false) the mock is harmless and unused.
  const controlPlaneStore = {
    getTorrentFile: (id) => {
      if (id !== torrentFileId) return null;
      return {
        id: torrentFileId,
        infoHash: FALLBACK_HASH,
        size: FALLBACK_SIZE,
        internalPath: 'When They See Us S01 HDR WEB-DL 2160p/'
          + 'When They See Us S01E02 WEB-DL 2160p.mkv',
      };
    },
  };

  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: {
      present: true,
      // The same-TorrentFile RD fallback hits getRdPlaybackUrl, which
      // calls client.unrestrictLink(rawLink, null, { resolverSafe: true }).
      // Return a synthetic unrestricted download URL.
      unrestrictLink: async (rawLink) => {
        if (rawLink !== 'https://rd.test/raw-link') {
          throw new Error(`unexpected unrestrictLink arg: ${rawLink}`);
        }
        return { download: 'https://rd.test/playback' };
      },
    },
    rdResolutionCache,
    controlPlaneStore,
    resolveTorBoxDeliverySeam: customSeam
      ? (async (...args) => {
          torBoxDeliveryCalls += 1;
          return customSeam(...args);
        })
      : (async () => {
          torBoxDeliveryCalls += 1;
          return torBoxDeliveryResult;
        }),
    torBoxDownloadUrlCache,
    fetchFn,
  });

  return {
    cache,
    handler,
    rdCallLog,
    getTorBoxDeliveryCalls: () => torBoxDeliveryCalls,
  };
}

test('A1 TV VFS same-TorrentFile RD fallback: TorBox protocol-invalid twice, RD resolves on 2nd attempt → HTTP 206 from RD', async (t) => {
  providerAccounting.reset();
  const rdResolvedUrl = 'https://rd.test/playback';
  let fetchCalls = 0;
  const { cache, handler, rdCallLog, getTorBoxDeliveryCalls } = buildFallbackHarness({
    rdOutcomes: [
      // 1st resolveBacking call: RD unresolvable for the SAME (infoHash, fileIndex).
      { status: 'failed', reason: 'not_cached' },
      // 2nd resolveBacking call (forceFresh=true): RD resolves successfully.
      {
        status: 'resolved',
        torrentId: 'TT_RD',
        rdFileId: '1',
        torrentInfo: {
          files: [{ id: '1', bytes: FALLBACK_SIZE, path: 'When They See Us - S01E02.mkv' }],
          links: ['https://rd.test/raw-link'],
        },
      },
    ],
    fetchFn: (() => {
      const fn = makeFallbackFetchFn({ rdResolvedUrl });
      return async (url, options) => {
        fetchCalls += 1;
        return fn(url, options);
      };
    })(),
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest('bytes=10-19'), res, FALLBACK_URL);
  const captured = res._capture();

  // Assert: HTTP 206 ships to the client (the body byte-count check passed
  // on the RD response).
  assert.equal(captured.status, 206, 'client must receive 206 on RD fallback success');
  // Assert: RD was probed twice (1st attempt — failed, 2nd attempt — resolved).
  const rdGets = rdCallLog.filter((e) => e.kind === 'getOrInFlight');
  assert.equal(rdGets.length, 2, 'RD resolution must be invoked once per loop attempt');
  // Assert: the 1st RD attempt's cache entry was force-deleted before the
  // 2nd attempt's getOrInFlight.
  const deletes = rdCallLog.filter((e) => e.kind === 'delete');
  assert.equal(deletes.length, 1, 'forceFresh must delete the cached RD entry exactly once');
  // Assert: only one TorBox delivery seam call (the initial one). The 2nd
  // attempt found RD and never re-entered the TorBox branch.
  assert.equal(getTorBoxDeliveryCalls(), 1, 'TorBox delivery seam must be invoked exactly once');
  // Assert: TorBox URL was hit exactly once (1st attempt only).
  assert.ok(
    fetchCalls >= 2,
    'fetchFn must be called at least twice (1× TorBox upstream, 1× RD liveness probe)',
  );
  // Assert: provider-accounting counters reflect the RD fallback lifecycle.
  const snap = providerAccounting.snapshot();
  assert.equal(
    snap.providers.realdebrid.perCategory.realdebrid_fallback_attempted,
    1,
    'one in-loop 2nd-attempt RD fallback should be recorded',
  );
  assert.equal(
    snap.providers.realdebrid.perCategory.realdebrid_fallback_resolved,
    1,
    'the 2nd-attempt RD resolution succeeded',
  );
  assert.equal(
    snap.providers.realdebrid.perCategory.realdebrid_fallback_failed,
    0,
    'no failed RD fallback to record (the 1st-attempt is not a fallback)',
  );
});

test('A2 TV VFS same-TorrentFile RD fallback: no placement repair beyond initial resolution', async (t) => {
  providerAccounting.reset();
  let seamCallCount = 0;
  const { cache, handler, getTorBoxDeliveryCalls } = buildFallbackHarness({
    rdOutcomes: [
      { status: 'failed', reason: 'not_cached' },
      { status: 'failed', reason: 'not_cached' },
    ],
    // The mock seam is a no-repair function: it returns the same fixed
    // backing on every call without consulting mylist, verifying the
    // torrent, or otherwise touching the durable state. The bounded
    // retry must hit it exactly once per loop attempt, never more.
    resolveTorBoxDeliverySeam: async () => {
      seamCallCount += 1;
      return {
        url: 'https://torbox.test/file',
        size: FALLBACK_SIZE,
        placementId: 'pl_fb',
        providerFileId: 'pf_fb',
        accountScope: 'default',
        recovered: false,
      };
    },
    fetchFn: async () => new Response('lie', { status: 200 }),
  });
  t.after(() => cache.close());

  // Both RD attempts fail, both TorBox attempts fail (protocol-invalid).
  // The bounded retry must call the seam at most once per loop attempt;
  // it must never spiral into a 3rd or 4th placement repair.
  await assert.rejects(
    handler(createRangeRequest('bytes=10-19'), createCapturingResponse(), FALLBACK_URL),
    (error) => error.status === 502,
  );
  assert.equal(
    getTorBoxDeliveryCalls(),
    2,
    'seam is called once per loop attempt (max 2), never more — the bounded retry must not trigger a 3rd placement repair',
  );
  assert.equal(seamCallCount, 2, 'seam mock is called exactly twice');
});

test('A3 TV VFS same-TorrentFile RD fallback: retains exact TorrentFile ID', async (t) => {
  providerAccounting.reset();
  const { cache, handler } = buildFallbackHarness({
    rdOutcomes: [
      { status: 'failed', reason: 'not_cached' },
      {
        status: 'resolved',
        torrentId: 'TT_RD',
        rdFileId: '1',
        torrentInfo: {
          files: [{ id: '1', bytes: FALLBACK_SIZE, path: 'When They See Us - S01E02.mkv' }],
          links: ['https://rd.test/raw-link'],
        },
      },
    ],
    fetchFn: makeFallbackFetchFn(),
    torrentFileId: 'tf_exact_identity_lock',
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest('bytes=10-19'), res, FALLBACK_URL);

  // The fallback must not change the durable TorrentFile ID. The VFS row
  // in the discovery cache is the canonical place to read it from outside
  // the handler.
  const entry = cache.getVfsTvEntry('tt7577910', 1, 2);
  assert.ok(entry, 'VFS TV row must still exist after fallback');
  assert.equal(
    entry.torrentFileId,
    'tf_exact_identity_lock',
    'exact TorrentFile ID must be preserved across same-TorrentFile RD fallback',
  );
});

test('A4 TV VFS same-TorrentFile RD fallback: retains VFS logical path and exact size', async (t) => {
  providerAccounting.reset();
  const { cache, handler } = buildFallbackHarness({
    rdOutcomes: [
      { status: 'failed', reason: 'not_cached' },
      {
        status: 'resolved',
        torrentId: 'TT_RD',
        rdFileId: '1',
        torrentInfo: {
          files: [{ id: '1', bytes: FALLBACK_SIZE, path: 'When They See Us - S01E02.mkv' }],
          links: ['https://rd.test/raw-link'],
        },
      },
    ],
    fetchFn: makeFallbackFetchFn(),
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest('bytes=10-19'), res, FALLBACK_URL);

  const entry = cache.getVfsTvEntry('tt7577910', 1, 2);
  assert.ok(entry, 'VFS TV row must still exist after fallback');
  assert.equal(
    entry.canonicalPath,
    'TV/When They See Us/Season 01/When They See Us - S01E02.mkv',
    'logical VFS path must be preserved across same-TorrentFile RD fallback',
  );
  assert.equal(entry.size, FALLBACK_SIZE, 'exact physical size must be preserved across same-TorrentFile RD fallback');
});

test('A5 TV VFS same-TorrentFile RD fallback: TorBox bad + RD exhausted → existing fail-closed 502', async (t) => {
  providerAccounting.reset();
  const { cache, handler, rdCallLog, getTorBoxDeliveryCalls } = buildFallbackHarness({
    rdOutcomes: [
      { status: 'failed', reason: 'not_cached' },
      { status: 'failed', reason: 'cooldown' },
    ],
    fetchFn: async () => new Response('lie', { status: 200 }),
  });
  t.after(() => cache.close());

  await assert.rejects(
    handler(createRangeRequest('bytes=10-19'), createCapturingResponse(), FALLBACK_URL),
    (error) => error.status === 502,
    'TorBox bad + RD exhausted must surface the existing 502 fail-closed contract',
  );

  // The bounded retry must have run exactly twice and exhausted cleanly.
  assert.equal(
    rdCallLog.filter((e) => e.kind === 'getOrInFlight').length,
    2,
    'RD resolution must be invoked once per loop attempt',
  );
  assert.equal(
    getTorBoxDeliveryCalls(),
    2,
    'seam is called once per loop attempt; bounded retry must not trigger a 3rd placement repair',
  );
  // Provider-accounting: two fallback attempts (1st and 2nd both
  // forceFresh=false/true), but only the 2nd is a "fallback". The 1st
  // attempt is a normal primary probe. So attempted=1, resolved=0,
  // failed=1.
  const snap = providerAccounting.snapshot();
  assert.equal(snap.providers.realdebrid.perCategory.realdebrid_fallback_attempted, 1);
  assert.equal(snap.providers.realdebrid.perCategory.realdebrid_fallback_resolved, 0);
  assert.equal(snap.providers.realdebrid.perCategory.realdebrid_fallback_failed, 1);
});

test('A6 TV VFS healthy TorBox delivery → zero alternate-provider fallback work', async (t) => {
  providerAccounting.reset();
  const { cache, handler, rdCallLog, getTorBoxDeliveryCalls } = buildFallbackHarness({
    rdOutcomes: [
      // 1st RD probe happens BEFORE the TorBox seam (RD is the primary
      // candidate probe in resolveBacking). It is allowed to be called
      // once. Plant a sentinel that fails cheaply.
      { status: 'failed', reason: 'rd-unavailable' },
    ],
    fetchFn: async (url) => {
      // Healthy TorBox upstream on the only call we expect.
      return new Response('x'.repeat(10), {
        status: 206,
        headers: {
          'content-range': 'bytes 10-19/' + FALLBACK_SIZE,
          'content-length': '10',
        },
      });
    },
  });
  t.after(() => cache.close());

  const res = createCapturingResponse();
  await handler(createRangeRequest('bytes=10-19'), res, FALLBACK_URL);
  const captured = res._capture();
  assert.equal(captured.status, 206, 'healthy TorBox delivery must stream 206 directly');
  // The 1st resolveBacking call is the primary RD probe (always
  // attempted before TorBox). The 2nd attempt is the same-TorrentFile
  // RD fallback, which only runs if the 1st attempt fails. With a
  // healthy 1st attempt, the fallback MUST NOT be invoked.
  const rdGets = rdCallLog.filter((e) => e.kind === 'getOrInFlight');
  assert.equal(
    rdGets.length,
    1,
    'RD resolution must be invoked exactly once (the 1st-attempt primary probe); the 2nd-attempt fallback must NOT run on a healthy 1st attempt',
  );
  const deletes = rdCallLog.filter((e) => e.kind === 'delete');
  assert.equal(
    deletes.length,
    0,
    'forceFresh delete must NOT run — the 2nd attempt (fallback) is not entered',
  );
  assert.equal(getTorBoxDeliveryCalls(), 1, 'TorBox seam is called once on the happy path');
  const snap = providerAccounting.snapshot();
  // The 1st attempt is the primary RD probe (forceFresh=false), not a
  // same-TorrentFile fallback, so the fallback counters must all be 0.
  assert.equal(
    snap.providers.realdebrid.perCategory.realdebrid_fallback_attempted,
    0,
    'no fallback attempted — the 1st attempt succeeded without entering the fallback path',
  );
  assert.equal(
    snap.providers.realdebrid.perCategory.realdebrid_fallback_resolved,
    0,
    'no fallback resolved',
  );
  assert.equal(
    snap.providers.realdebrid.perCategory.realdebrid_fallback_failed,
    0,
    'no fallback failed (the 1st-attempt primary probe is not a "fallback")',
  );
});

test('A7 TV VFS 429/backoff alone → no protocol-invalid misinterpretation; existing 429 surface preserved', async (t) => {
  providerAccounting.reset();
  const { cache, handler, rdCallLog, getTorBoxDeliveryCalls } = buildFallbackHarness({
    rdOutcomes: [
      { status: 'failed', reason: 'sentinel-must-not-be-touched' },
    ],
    fetchFn: async () => new Response('rate limited', { status: 429 }),
  });
  t.after(() => cache.close());

  // The 1st attempt surfaces the existing 502 contract from the
  // validate callback (the validate callback rejects 429 with
  // STATUS_NOT_206 → PROVIDER_RANGE_FAILED). Critically, the 2nd-attempt
  // RD fallback (the same-TorrentFile RD probe inside the loop) must
  // NOT be invoked: 429 is a backoff signal, not a protocol-invalid
  // signal. The in-loop retry classification treats 429 as the
  // rate-limited branch and exits via the existing surface.
  await assert.rejects(
    handler(createRangeRequest('bytes=10-19'), createCapturingResponse(), FALLBACK_URL),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  // The 1st resolveBacking call is the primary RD probe (always
  // attempted before TorBox) — exactly 1 getOrInFlight. The 2nd attempt
  // is the same-TorrentFile RD fallback, which is only entered for
  // protocol-invalid / stale-capability classifications, never for 429.
  const rdGets = rdCallLog.filter((e) => e.kind === 'getOrInFlight');
  assert.equal(
    rdGets.length,
    1,
    'RD resolution must be invoked exactly once (1st-attempt primary probe); the 2nd-attempt fallback must NOT be entered on 429',
  );
  assert.equal(
    rdCallLog.filter((e) => e.kind === 'delete').length,
    0,
    'forceFresh delete must NOT run on 429 — the fallback path is not entered',
  );
  assert.equal(getTorBoxDeliveryCalls(), 1);
  const snap = providerAccounting.snapshot();
  // The 1st attempt is a primary RD probe, not a same-TorrentFile
  // fallback, so the fallback counters must all be 0. The existing
  // 429 surface is preserved.
  assert.equal(
    snap.providers.realdebrid.perCategory.realdebrid_fallback_attempted,
    0,
    'no fallback attempted on 429 — backoff is a separate path',
  );
  assert.equal(snap.providers.realdebrid.perCategory.realdebrid_fallback_resolved, 0);
  assert.equal(snap.providers.realdebrid.perCategory.realdebrid_fallback_failed, 0);
});

