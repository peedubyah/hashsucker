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
    mediaId: 'tt0000001',
    infoHash: HASH_A,
    filename: 'Oppenheimer.2023.2160p.mkv',
  });
  persistMovie(cache, {
    mediaId: 'tt0000002',
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
    mediaId: 'tt0000001',
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
    mediaId: 'tt0000001',
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
  assert.equal(cache.getVfsMovieEntry('tt0000001').size, 4099958870);

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
    mediaId: 'tt0000001',
    infoHash: HASH_A,
    filename: 'Oppenheimer.2023.2160p.mkv',
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt0000001',
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
    rdResolutionCache: resolutionCache,
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
    mediaId: 'tt0000001',
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
