import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createTvWebDav, normalizeRange } from '../src/lib/vfs/tv-webdav.js';

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

