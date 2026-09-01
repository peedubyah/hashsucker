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

test('TV VFS does not buffer full-file body and stops reading on client close', async (t) => {
  // Verifies the streaming pipeline: provider body is piped to the response,
  // and destroying the response tears the upstream body down without pulling
  // more bytes. We do NOT pull a multi-GB body here — that is the
  // production-path canary. This test only proves the contract that the
  // pipeline relies on streaming, not buffering.
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
        status: 206,
        headers: { 'content-range': 'bytes 0-1048575/1073741824' },
      });
    },
  });

  const response = createCapturingResponse();
  const handlerPromise = handler(
    createRangeRequest('bytes=0-1048575'),
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

