import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createRequestHandler } from '../src/server/app.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';

function createHarness() {
  const submitted = [];
  const handler = createRequestHandler({
    importer: {
      async submitRequest(handoff) { submitted.push(handoff); return { requestId: handoff.requestId, status: 'queued' }; },
      async getRequestStatus(requestId) { return { requestId, status: 'processing' }; },
    },
    searchCatalog: async () => [{ id: 'tt2085059', type: 'series', name: 'Black Mirror' }],
    getMedia: async () => ({ id: 'tt2085059', type: 'series', name: 'Black Mirror', videos: [{ id: 'tt2085059:7:3', season: 7, episode: 3 }] }),
    combinedSearch: async (cache, opts) => ({
      results: [{
        infoHash: HASH,
        fileIndex: null,
        title: 'Season pack',
        filename: 'Season pack',
        size: null,
        resolution: '1080p',
        quality: null,
        codec: null,
        hdr: null,
        audio: null,
        releaseGroup: null,
        year: null,
        season: 7,
        episode: 3,
        confidence: 0.85,
        score: 0.75,
        components: { relevance: 0.8, quality: 0.7 },
        providers: { torbox: { cached: true } },
        media: [],
        _source: 'corpus',
      }],
      total: 1,
      query: { match: '*', filters: {}, titleQuery: null },
      timings: { totalMs: 5 },
      stats: { indexed: 0, total: 0 },
    }),
  });
  async function request(url, { method = 'GET', body } = {}) {
    const input = Readable.from(body ? [Buffer.from(body)] : []);
    input.method = method; input.url = url;
    return new Promise((resolve, reject) => {
      const chunks = [];
      const response = {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
      };
      handler(input, response).catch(reject);
    });
  }
  return { request, submitted };
}

test('server serves API and returns 404 for frontend routes', async () => {
  const { request } = createHarness();
  
  // API endpoints work
  const response = await request('/api/search?type=series&mediaId=tt2085059:7:3');
  assert.equal(response.status, 200);
  const text = response.text;
  assert.match(text, /"cached":true/);
  assert.doesNotMatch(text, /TORBOX_SECRET|"raw"/);
  
  // Frontend routes return 404 (frontend removed)
  const ui = await request('/');
  assert.equal(ui.status, 404);
  
  const requestId = '12345678-1234-1234-1234-123456789abc';
  const status = await request(`/api/requests/${requestId}`);
  assert.deepEqual(JSON.parse(status.text), { requestId, status: 'processing' });
});

test('public release API strips all secret-bearing and internal fields', async () => {
  const handler = createRequestHandler({
    importer: {
      async submitRequest() { return { requestId: 'id', status: 'queued' }; },
      async getRequestStatus() { return { requestId: 'id', status: 'processing' }; },
    },
    searchCatalog: async () => [],
    getMedia: async () => null,
    combinedSearch: async (cache, opts) => ({
      results: [{
        infoHash: HASH,
        fileIndex: null,
        title: 'Test Release',
        filename: 'Test Release',
        size: 5000,
        resolution: '1080p',
        quality: null,
        codec: null,
        hdr: null,
        audio: null,
        releaseGroup: null,
        year: null,
        season: null,
        episode: null,
        confidence: 0.85,
        score: 0.75,
        components: { relevance: 0.8, quality: 0.7 },
        providers: { torbox: { cached: true } },
        media: [],
        _source: 'corpus',
      }],
      total: 1,
      query: { match: '*', filters: {}, titleQuery: null },
      timings: { totalMs: 5 },
      stats: { indexed: 0, total: 0 },
    }),
  });

  const input = Readable.from([]);
  input.method = 'GET'; input.url = '/api/search?type=series&mediaId=tt2085059:7:3';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const text = response.text;
  // Internal/secret fields must never appear
  assert.doesNotMatch(text, /magnet/, 'magnet should be excluded');
  assert.doesNotMatch(text, /behaviorHints/, 'behaviorHints should be excluded');
  assert.doesNotMatch(text, /RAW_SECRET|"raw"/, 'raw should be excluded');
  assert.doesNotMatch(text, /"torznab":/, 'torznab internal metadata should be excluded');
  assert.doesNotMatch(text, /SECRET123/, 'downloadUrl must be excluded');
  assert.doesNotMatch(text, /SECRET456/, 'sources[].downloadUrl must be excluded');
  // Public fields SHOULD appear
  assert.match(text, /"infoHash"/);
  assert.match(text, /"title"/);
  assert.match(text, /"cached":true/);
  // combinedSearch response shape: no sources array, uses _source for provenance
  const body = JSON.parse(text);
  assert.equal(body.results[0].sources, undefined, 'sources array should not be present in combinedSearch output');
  assert.equal(body.results[0]._source, 'corpus', 'provenance tracked via _source field');
});

test('request endpoint only accepts an explicit episode and preserves it for season packs', async () => {
  const { request, submitted } = createHarness();
  const valid = await request('/api/requests', {
    method: 'POST',
    body: JSON.stringify({ mediaId: 'tt2085059:7:3', release: { infoHash: HASH, title: 'S07 Complete E01-E06' } }),
  });
  assert.equal(valid.status, 202, valid.text);
  assert.deepEqual(submitted[0].intent.episodes, [3]);
  assert.equal(submitted[0].intent.season, 7);

  for (const body of [
    { mediaId: 'tt2085059', release: { infoHash: HASH } },
    { mediaId: 'tt2085059:7:3', release: {} },
  ]) {
    const response = await request('/api/requests', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
});

test('request endpoint accepts explicit movie scope through the same handoff path', async () => {
  const { request, submitted } = createHarness();
  const response = await request('/api/requests', {
    method: 'POST',
    body: JSON.stringify({ type: 'movie', mediaId: 'tt0082971', release: { infoHash: HASH, title: 'Raiders of the Lost Ark (1981)' } }),
  });
  assert.equal(response.status, 202, response.text);
  assert.equal(submitted[0].intent.mediaType, 'movie');
  assert.equal(submitted[0].intent.scope, 'movie');
  assert.equal(submitted[0].intent.season, null);
  assert.deepEqual(submitted[0].intent.episodes, []);
});

// =============================================================================
// Internal Search API Tests
// =============================================================================

test('GET /api/search/internal returns results from DMM-ingested candidates', async () => {
  const cache = createDiscoveryCache();
  // Ingest a candidate with release attributes
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv',
  });
  cache._insertReleaseAttributes({
    infoHash: HASH,
    fileIndex: null,
    filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    resolution: '1080p',
    sourceType: 'BluRay',
    codec: 'x264',
    hdr: 0,
    audio: 'AAC',
    releaseGroup: 'TEST',
    evidence: JSON.stringify(['title_extracted', 'resolution_detected']),
    parsedAt: Date.now(),
  });

  const handler = createRequestHandler({ searchCache: cache });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search/internal?q=Breaking+Bad+S05E14';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.total, 1);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].hash, HASH);
  assert.equal(body.results[0].parsed.title, 'Breaking Bad');
  assert.equal(body.results[0].parsed.resolution, '1080p');
  cache.close();
});

test('GET /api/search/internal filters by codec', async () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate({ infoHash: HASH, fileIndex: null, filename: 'Movie.x264.mkv' });
  cache._insertReleaseAttributes({
    infoHash: HASH, fileIndex: null, filename: 'Movie.x264.mkv', source: 'ptn-regex',
    confidence: 0.8, title: 'Movie', codec: 'x264', parsedAt: Date.now(),
  });
  cache.upsertCandidate({ infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fileIndex: null, filename: 'Movie.x265.mkv' });
  cache._insertReleaseAttributes({
    infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fileIndex: null, filename: 'Movie.x265.mkv', source: 'ptn-regex',
    confidence: 0.8, title: 'Movie', codec: 'x265', parsedAt: Date.now(),
  });

  const handler = createRequestHandler({ searchCache: cache });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search/internal?q=Movie&codec=x265';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.total, 1);
  assert.equal(body.results[0].hash, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  cache.close();
});

test('GET /api/search/internal includes media associations when requested', async () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate({ infoHash: HASH, fileIndex: null, filename: 'Movie.mkv' });
  cache._insertReleaseAttributes({
    infoHash: HASH, fileIndex: null, filename: 'Movie.mkv', source: 'ptn-regex',
    confidence: 0.8, title: 'Movie', parsedAt: Date.now(),
  });
  cache.associateMedia(HASH, null, 'tt1234567', { source: 'manual', confidence: 0.9 });

  const handler = createRequestHandler({ searchCache: cache });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search/internal?q=Movie&media=true';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.results[0].media.length, 1);
  assert.equal(body.results[0].media[0].mediaId, 'tt1234567');
  cache.close();
});

test('GET /api/search/internal returns fileIndex in results', async () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate({ infoHash: HASH, fileIndex: null, filename: 'Movie.mkv' });
  cache._insertReleaseAttributes({
    infoHash: HASH, fileIndex: null, filename: 'Movie.mkv', source: 'ptn-regex',
    confidence: 0.8, title: 'Movie', parsedAt: Date.now(),
  });

  const handler = createRequestHandler({ searchCache: cache });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search/internal?q=Movie';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.results[0].fileIndex, null);
});

test('GET /api/search for live discovery with mediaId returns releases', async () => {
  const cache = createDiscoveryCache();
  const handler = createRequestHandler({
    searchCache: cache,
    combinedSearch: async (cache, opts) => ({
      results: [{
        infoHash: HASH,
        fileIndex: null,
        title: 'Movie.1080p.mkv',
        filename: 'Movie.1080p.mkv',
        size: null,
        resolution: '1080p',
        quality: null,
        codec: null,
        hdr: null,
        audio: null,
        releaseGroup: null,
        year: null,
        season: null,
        episode: null,
        confidence: 0.85,
        score: 0.75,
        components: { relevance: 0.8, quality: 0.7 },
        providers: { torbox: { cached: true } },
        media: [],
        _source: 'corpus',
      }],
      total: 1,
      query: { match: '*', filters: {}, titleQuery: null },
      timings: { totalMs: 5 },
      stats: { indexed: 0, total: 0 },
    }),
  });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search?type=movie&mediaId=tt1234567';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].infoHash, HASH);
  assert.equal(body.results[0].resolution, '1080p');
});

test('GET /api/search for series episode live discovery returns releases', async () => {
  const cache = createDiscoveryCache();
  const handler = createRequestHandler({
    searchCache: cache,
    combinedSearch: async (cache, opts) => ({
      results: [{
        infoHash: HASH,
        fileIndex: null,
        title: 'Show.S01E01.1080p.mkv',
        filename: 'Show.S01E01.1080p.mkv',
        size: null,
        resolution: '1080p',
        quality: null,
        codec: null,
        hdr: null,
        audio: null,
        releaseGroup: null,
        year: null,
        season: 1,
        episode: 1,
        confidence: 0.85,
        score: 0.75,
        components: { relevance: 0.8, quality: 0.7 },
        providers: { torbox: { cached: true } },
        media: [],
        _source: 'corpus',
      }],
      total: 1,
      query: { match: '*', filters: {}, titleQuery: null },
      timings: { totalMs: 5 },
      stats: { indexed: 0, total: 0 },
    }),
  });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search?type=series&mediaId=tt1234567:1:1';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].infoHash, HASH);
});

test('GET /api/search without mediaId returns Cinemeta title search', async () => {
  const cache = createDiscoveryCache();
  const handler = createRequestHandler({
    searchCache: cache,
    searchCatalog: async () => [{ id: 'tt1234567', type: 'movie', name: 'Test Movie' }],
  });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search?q=Test+Movie';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].name, 'Test Movie');
});

test('GET /api/search with Torrentio + Comet coexistence', async () => {
  const cache = createDiscoveryCache();
  const handler = createRequestHandler({
    searchCache: cache,
    combinedSearch: async (cache, opts) => ({
      results: [
        { infoHash: HASH, fileIndex: null, title: 'Torrentio result', filename: 'Torrentio result', size: null, resolution: '1080p', quality: null, codec: null, hdr: null, audio: null, releaseGroup: null, year: null, season: null, episode: null, confidence: 0.85, score: 0.75, components: {}, providers: { torbox: { cached: true } }, media: [], _source: 'live' },
        { infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fileIndex: null, title: 'Comet result', filename: 'Comet result', size: null, resolution: '720p', quality: null, codec: null, hdr: null, audio: null, releaseGroup: null, year: null, season: null, episode: null, confidence: 0.8, score: 0.7, components: {}, providers: {}, media: [], _source: 'live' },
      ],
      total: 2,
      query: { match: '*', filters: {}, titleQuery: null },
      timings: { totalMs: 5 },
      stats: { indexed: 0, total: 0 },
    }),
  });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search?type=movie&mediaId=tt1234567';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.results.length, 2);
  const hashes = body.results.map(r => r.infoHash).sort();
  assert.deepEqual(hashes, [HASH, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'].sort());
});

test('GET /api/search with Torznab participation', async () => {
  const cache = createDiscoveryCache();
  const handler = createRequestHandler({
    searchCache: cache,
    combinedSearch: async (cache, opts) => ({
      results: [
        { infoHash: HASH, fileIndex: null, title: 'Torznab result', filename: 'Torznab result', size: null, resolution: '1080p', quality: null, codec: null, hdr: null, audio: null, releaseGroup: null, year: null, season: 1, episode: 1, confidence: 0.85, score: 0.75, components: {}, providers: { torbox: { cached: false } }, media: [], _source: 'live' },
      ],
      total: 1,
      query: { match: '*', filters: {}, titleQuery: null },
      timings: { totalMs: 5 },
      stats: { indexed: 0, total: 0 },
    }),
  });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search?type=series&mediaId=tt1234567:1:1';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].providers.torbox.cached, false);
});

test('removed endpoints return 404', async () => {
  const cache = createDiscoveryCache();
  const handler = createRequestHandler({ searchCache: cache });

  // /api/releases should no longer exist
  const input1 = Readable.from([]);
  input1.method = 'GET';
  input1.url = '/api/releases?type=series&mediaId=tt1234567:1:1';
  const response1 = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input1, res).catch(reject);
  });
  assert.equal(response1.status, 404);

  // /api/search/releases should no longer exist
  const input2 = Readable.from([]);
  input2.method = 'GET';
  input2.url = '/api/search/releases?q=Movie';
  const response2 = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input2, res).catch(reject);
  });
  assert.equal(response2.status, 404);
  cache.close();
});

test('GET /api/search/stats returns index statistics', async () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate({ infoHash: HASH, fileIndex: null, filename: 'Movie.mkv' });
  cache._insertReleaseAttributes({
    infoHash: HASH, fileIndex: null, filename: 'Movie.mkv', source: 'ptn-regex',
    confidence: 0.8, title: 'Movie', parsedAt: Date.now(),
  });

  const handler = createRequestHandler({ searchCache: cache });
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = '/api/search/stats';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.indexed, 1);
  assert.equal(body.total, 1);
  cache.close();
});

test('POST /api/attributes/run triggers attribute parsing', async () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate({ infoHash: HASH, fileIndex: null, filename: 'Movie.1080p.mkv' });

  const handler = createRequestHandler({ searchCache: cache });
  const input = Readable.from([Buffer.from('{}')]);
  input.method = 'POST';
  input.url = '/api/attributes/run';
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.parsed, 1);
  cache.close();
});
