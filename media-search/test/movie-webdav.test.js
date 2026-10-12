import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function persistMovie(cache, {
  mediaId,
  infoHash,
  filename,
  selectedAt = 1_700_000_000_000,
}) {
  const releaseKey = `${infoHash}:torrent`;
  const requestId = cache.persistMediaRequest({
    mediaId,
    mediaType: 'movie',
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey,
    infoHash,
    fileIndex: null,
    filename,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt,
  });
}

function createRdResolutionCache() {
  const entries = new Map();
  const deleted = [];
  return {
    deleted,
    get(infoHash, fileIndex) {
      return entries.get(`${infoHash}:${fileIndex ?? 'torrent'}`) || null;
    },
    set(infoHash, fileIndex, url, torrentId, rdFileId) {
      entries.set(`${infoHash}:${fileIndex ?? 'torrent'}`, { url, torrentId, rdFileId });
    },
    delete(infoHash, fileIndex) {
      deleted.push(`${infoHash}:${fileIndex ?? 'torrent'}`);
      entries.delete(`${infoHash}:${fileIndex ?? 'torrent'}`);
    },
    async getOrInFlight(_infoHash, _fileIndex, factory) {
      return factory();
    },
  };
}

function createControlPlane(infoHash, size = null) {
  return {
    findPlacementByInfoHash(provider, hash) {
      return provider === 'torbox' && hash === infoHash
        ? { id: 'placement-1', providerResourceId: 'torrent-1' }
        : null;
    },
    findFileMapping(releaseKey, placementId) {
      return releaseKey === `${infoHash}:torrent` && placementId === 'placement-1'
        ? { state: 'mapped', providerFileId: 'file-1' }
        : null;
    },
    listProviderFiles(placementId) {
      return placementId === 'placement-1'
        ? [{ providerFileId: 'file-1', size }]
        : [];
    },
  };
}

function createRequest(handler) {
  return async (url, { method = 'GET', headers = {} } = {}) => {
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

function providerResponse(status, {
  body = '',
  contentRange = null,
} = {}) {
  const headers = new Headers();
  if (contentRange) headers.set('content-range', contentRange);
  return new Response(body, { status, headers });
}

test('movie VFS materializes two durable handoffs without movie-specific branches', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  persistMovie(cache, {
    mediaId: 'tt0000000',
    infoHash: HASH_A,
    filename: 'Oppenheimer.2023.2160p.mkv',
  });
  persistMovie(cache, {
    mediaId: 'tt10000000',
    infoHash: HASH_B,
    filename: 'Companion.2025.2160p.mkv',
  });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: null,
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
  });
  const request = createRequest(handler);
  const response = await request('/vfs/Movies', {
    method: 'PROPFIND',
    headers: { depth: '1' },
  });

  assert.equal(response.status, 207);
  const xml = response.body.toString('utf8');
  assert.match(xml, /Oppenheimer%20\(2023\)\//);
  assert.match(xml, /Companion%20\(2025\)\//);

  const entries = cache.listVfsMovieEntries();
  assert.deepEqual(entries.map((entry) => entry.canonicalPath), [
    'Movies/Companion (2025)/Companion (2025).mkv',
    'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv',
  ]);
  assert.ok(entries.every((entry) => entry.size == null));
  assert.ok(entries.every((entry) => !Object.hasOwn(entry, 'url')));
  assert.doesNotMatch(xml, /<d:getcontentlength>null<\/d:getcontentlength>/);
  assert.doesNotMatch(xml, /<d:getcontentlength>/);
});

test('movie VFS ignores malformed legacy handoffs instead of failing the catalog', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  persistMovie(cache, {
    mediaId: 'tt0000000',
    infoHash: HASH_A,
    filename: 'Oppenheimer.2023.2160p.mkv',
  });
  const requestId = cache.persistMediaRequest({
    mediaId: 'tt-invalid',
    mediaType: 'movie',
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt-invalid',
    mediaType: 'movie',
    releaseKey: `${HASH_B}:`,
    infoHash: HASH_B,
    fileIndex: null,
    filename: 'Invalid.2024.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'legacy test',
    selectedAt: 1,
  });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: null,
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
  });
  const response = await createRequest(handler)('/vfs/Movies', {
    method: 'PROPFIND',
    headers: { depth: '1' },
  });

  assert.equal(response.status, 207);
  const xml = response.body.toString('utf8');
  assert.match(xml, /Oppenheimer%20\(2023\)\//);
  assert.doesNotMatch(xml, /Invalid/);
});

test('movie VFS persists exact provider range size and reuses it across handler recreation', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  persistMovie(cache, {
    mediaId: 'tt0000000',
    infoHash: HASH_A,
    filename: 'Oppenheimer.2023.2160p.mkv',
  });
  const fetchRanges = [];
  const fetchFn = async (_url, options) => {
    fetchRanges.push(options.headers.range);
    return providerResponse(206, {
      body: 'x',
      contentRange: 'bytes 0-0/4099958870',
    });
  };
  const dependencies = {
    searchCache: cache,
    controlPlaneStore: createControlPlane(HASH_A),
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
    // Stub seam — these tests assert metadata probe / range read behavior,
    // not the TorBox delivery lifecycle. The seam just returns a stub URL.
    resolveTorBoxDeliverySeam: async () => ({ url: 'https://provider.test/file', size: null, recovered: false }),
    torBoxDownloadUrlCache: { get() { return null; }, set() {}, delete() {}, async getOrInFlight() { throw new Error('unused'); } },
    fetchFn,
    torBoxRedirectOptions: { apiKey: 'test-token', apiBase: 'https://provider.test' },
  };

  let request = createRequest(createMovieWebDav(dependencies));
  const first = await request('/vfs/Movies/Oppenheimer%20(2023)/Oppenheimer%20(2023).mkv', {
    method: 'HEAD',
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-length'], '4099958870');
  assert.deepEqual(fetchRanges, ['bytes=0-0']);
  assert.equal(cache.getVfsMovieEntry('tt0000000').size, 4099958870);

  request = createRequest(createMovieWebDav(dependencies));
  const reopened = await request('/vfs/Movies/Oppenheimer%20(2023)/Oppenheimer%20(2023).mkv', {
    method: 'HEAD',
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.headers['content-length'], '4099958870');
  assert.deepEqual(fetchRanges, ['bytes=0-0']);
});

test('movie VFS retries once after stale range metadata and returns fresh bytes', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  persistMovie(cache, {
    mediaId: 'tt0000000',
    infoHash: HASH_A,
    filename: 'Oppenheimer.2023.2160p.mkv',
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt0000000',
    releaseKey: `${HASH_A}:torrent`,
    infoHash: HASH_A,
    fileIndex: null,
    canonicalPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv',
    size: 100,
    createdAt: 1,
    updatedAt: 1,
  });

  const resolutionCache = createRdResolutionCache();
  let calls = 0;
  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: createControlPlane(HASH_A, 100),
    rdClient: null,
    rdResolutionCache: resolutionCache,    resolveTorBoxDeliverySeam: async () => ({ url: 'https://provider.test/file', size: null, recovered: false }),
    torBoxDownloadUrlCache: { get() { return null; }, set() {}, delete() {}, async getOrInFlight() { throw new Error('unused'); } },    resolveTorBoxDeliverySeam: async () => ({ url: 'https://provider.test/file', size: null, recovered: false }),
    torBoxDownloadUrlCache: { get() { return null; }, set() {}, delete() {}, async getOrInFlight() { throw new Error('unused'); } },
    torBoxRedirectOptions: { apiKey: 'test-token', apiBase: 'https://provider.test' },
    fetchFn: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers.range, 'bytes=10-19');
      if (calls === 1) {
        return providerResponse(206, {
          body: 'old-range!',
          contentRange: 'bytes 10-19/99',
        });
      }
      return providerResponse(206, {
        body: 'freshbytes',
        contentRange: 'bytes 10-19/100',
      });
    },
  });
  const request = createRequest(handler);
  const response = await request('/vfs/Movies/Oppenheimer%20(2023)/Oppenheimer%20(2023).mkv', {
    method: 'GET',
    headers: { range: 'bytes=10-19' },
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], 'bytes 10-19/100');
  assert.equal(response.body.toString('utf8'), 'freshbytes');
  assert.equal(calls, 2);
  assert.deepEqual(resolutionCache.deleted, [`${HASH_A}:torrent`]);
});

test('movie VFS coalesces concurrent initial metadata probes per entry', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  persistMovie(cache, {
    mediaId: 'tt0000000',
    infoHash: HASH_A,
    filename: 'Oppenheimer.2023.2160p.mkv',
  });

  let probeCount = 0;
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: createControlPlane(HASH_A),
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
    resolveTorBoxDeliverySeam: async () => ({ url: 'https://provider.test/file', size: null, recovered: false }),
    torBoxDownloadUrlCache: { get() { return null; }, set() {}, delete() {}, async getOrInFlight() { throw new Error('unused'); } },
    torBoxRedirectOptions: { apiKey: 'test-token', apiBase: 'https://provider.test' },
    fetchFn: async () => {
      probeCount += 1;
      await probeGate;
      return providerResponse(206, {
        body: 'x',
        contentRange: 'bytes 0-0/4099958870',
      });
    },
  });
  const request = createRequest(handler);
  const url = '/vfs/Movies/Oppenheimer%20(2023)/Oppenheimer%20(2023).mkv';
  const first = request(url, { method: 'HEAD' });
  const second = request(url, { method: 'HEAD' });
  await Promise.resolve();
  releaseProbe();

  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(probeCount, 1);
});

test('movie VFS byte integrity: beginning, distant seek, and near-EOF ranges hash-match provider bytes', async (t) => {
  // Part 9: the bytes Plex receives must equal the provider bytes for the
  // same ranges. The stub provider serves a deterministic pattern; the
  // test recomputes the expected slices locally and compares hashes.
  const crypto = await import('node:crypto');
  const SIZE = 1_000_000;
  const byteAt = (i) => i % 251;
  const expectedSlice = (start, end) => {
    const buf = Buffer.alloc(end - start + 1);
    for (let i = start; i <= end; i++) buf[i - start] = byteAt(i);
    return buf;
  };
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  persistMovie(cache, {
    mediaId: 'tt0000000',
    infoHash: HASH_A,
    filename: 'Oppenheimer.2023.2160p.mkv',
  });
  const fetchFn = async (_url, options) => {
    const m = String(options?.headers?.range || options?.headers?.Range || '').match(/bytes=(\d+)-(\d*)/);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] !== '' ? parseInt(m[2], 10) : SIZE - 1;
    const body = expectedSlice(start, Math.min(end, SIZE - 1));
    return providerResponse(206, {
      body,
      contentRange: `bytes ${start}-${Math.min(end, SIZE - 1)}/${SIZE}`,
    });
  };
  const dependencies = {
    searchCache: cache,
    controlPlaneStore: createControlPlane(null),
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
    resolveTorBoxDeliverySeam: async () => ({ url: 'https://provider.test/file', size: SIZE, recovered: false }),
    torBoxDownloadUrlCache: { get() { return null; }, set() {}, delete() {}, async getOrInFlight() { throw new Error('unused'); } },
    fetchFn,
    torBoxRedirectOptions: { apiKey: 'test-token', apiBase: 'https://provider.test' },
  };
  const request = createRequest(createMovieWebDav(dependencies));
  const url = '/vfs/Movies/Oppenheimer%20(2023)/Oppenheimer%20(2023).mkv';
  for (const [start, end] of [[0, 999], [500000, 500999], [SIZE - 1000, SIZE - 1]]) {
    const res = await request(url, { method: 'GET', headers: { range: `bytes=${start}-${end}` } });
    assert.equal(res.status, 206, `range ${start}-${end} serves 206`);
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${SIZE}`);
    const expected = expectedSlice(start, end);
    assert.equal(sha(res.body), sha(expected), `range ${start}-${end} bytes hash-match provider bytes`);
    assert.equal(res.body.length, expected.length, `range ${start}-${end} length exact`);
  }
});
