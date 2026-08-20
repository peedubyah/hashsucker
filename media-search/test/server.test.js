import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

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
    searchMedia: async (intent) => ({ intent, providerStatus: { torbox: 'known' }, results: [{
      key: `ih:${HASH}`, infoHash: HASH, title: 'Season pack', raw: { secret: 'TORBOX_SECRET' },
      providers: { torbox: { cached: true } }, sources: [],
    }] }),
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

test('server serves UI and secret-free release API', async () => {
  const { request } = createHarness();
  const ui = await request('/');
  assert.match(ui.text, /Media Search/);
  assert.match(ui.text, /styles\.css\?v=20260819-movie1/);
  assert.match(ui.text, /app\.js\?v=20260819-movie1/);
  assert.match((await request('/app.js')).text, /release-model\.js\?v=20260819-movie1/);
  assert.match(ui.text, /id="drilldown"/);
  assert.match(ui.text, /id="intent-bar"/);
  assert.equal(ui.headers['cache-control'], 'no-cache');
  const uiModule = await request('/release-model.js');
  assert.match(uiModule.text, /prepareReleases/);
  assert.equal(uiModule.headers['cache-control'], 'no-cache');
  const response = await request('/api/releases?type=series&mediaId=tt2085059:7:3');
  assert.equal(response.status, 200);
  const text = response.text;
  assert.match(text, /"cached":true/);
  assert.doesNotMatch(text, /TORBOX_SECRET|"raw"/);
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
    searchMedia: async (intent) => ({
      intent,
      providerStatus: { torbox: 'known' },
      results: [{
        key: `ih:${HASH}`,
        infoHash: HASH,
        title: 'Test Release',
        magnet: `magnet:?xt=urn:btih:${HASH}&dn=secret`,
        downloadUrl: 'https://torznab.example.com/api?apikey=SECRET123&callback=foo',
        behaviorHints: { videoSize: 5000 },
        raw: { upstream: 'RAW_SECRET' },
        torznab: { seeders: 5 },
        sources: [{
          id: 's1',
          kind: 'torznab',
          instance: 'i1',
          indexer: 'idx',
          role: 'discovery',
          capability: 'dl',
          provider: 'torbox',
          downloadUrl: 'https://other.example.com/api?apikey=SECRET456',
        }],
        providers: { torbox: { cached: true } },
      }],
    }),
  });

  const input = Readable.from([]);
  input.method = 'GET'; input.url = '/api/releases?type=series&mediaId=tt2085059:7:3';
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
  // Source objects are sanitized (no downloadUrl)
  const body = JSON.parse(text);
  const src = body.results[0].sources[0];
  assert.equal(src.downloadUrl, undefined, 'source downloadUrl should be stripped');
  assert.equal(src.id, 's1');
  assert.equal(src.kind, 'torznab');
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
