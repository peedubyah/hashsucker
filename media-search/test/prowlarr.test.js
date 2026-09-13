/**
 * Prowlarr adapter tests (Prowlarr/Torznab tranche).
 *
 * Stub client only; no network. Covers: hash extraction (explicit field,
 * magnet: fallback, http-URL rejection), secret hygiene (no URLs/keys
 * retained), imdbId mapping, size semantics (never per-file), search
 * mapping (parser integration, relevance, evidence), disabled behavior,
 * and failure isolation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProwlarrClient,
  extractRowHash,
  normalizeProwlarrRows,
  searchProwlarr,
} from '../src/lib/discovery/prowlarr.js';

const HASH = 'ed0da850c273e3e15a819bdcbbf418bc85107ec0';
const HASH2 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function row(overrides = {}) {
  return {
    title: 'Dune.2021.1080p.BluRay.x264-GRP.mkv',
    fileName: 'Dune.2021.1080p.BluRay.x264-GRP.mkv',
    infoHash: HASH,
    magnetUrl: 'http://prowlarr.local/1/download?apikey=SECRETKEY123&link=xyz',
    size: 2947989023,
    seeders: 724,
    publishDate: '2021-10-17T15:00:53Z',
    imdbId: 1160419,
    tmdbId: 0,
    indexer: 'The Pirate Bay',
    categories: [{ name: 'Movies' }],
    ...overrides,
  };
}

test('extractRowHash prefers explicit field, falls back to magnet:, rejects http URLs', () => {
  assert.equal(extractRowHash(row()), HASH);
  assert.equal(
    extractRowHash(row({ infoHash: null, magnetUrl: `magnet:?xt=urn:btih:${HASH2}&dn=x` })),
    HASH2,
  );
  assert.equal(extractRowHash(row({ infoHash: 'short', magnetUrl: 'http://x/y?apikey=k' })), null);
  assert.equal(extractRowHash(row({ infoHash: 'ZZZ-not-hex-value-00000000000000000000' })), null);
  assert.equal(extractRowHash(null), null);
});

test('normalize drops key-bearing URLs and maps identity fields', () => {
  const { rows, invalid } = normalizeProwlarrRows([
    row(),
    row({ infoHash: null, magnetUrl: 'http://x/?apikey=k' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(invalid, 1);
  const r = rows[0];
  assert.equal(r.infoHash, HASH);
  assert.equal(r.imdbId, 'tt1160419');
  assert.equal(r.size, 2947989023);
  assert.equal(r.seeders, 724);
  assert.ok(!('magnetUrl' in r) && !('guid' in r) && !('infoUrl' in r), 'no URL fields retained');
  assert.ok(!JSON.stringify(r).includes('SECRETKEY123'), 'no key material retained');
  assert.equal(normalizeProwlarrRows([row({ imdbId: 0 })]).rows[0].imdbId, null);
});

test('searchProwlarr maps parser fields, relevance, and evidence', async () => {
  const client = {
    search: async (params) => {
      assert.equal(params.type, 'movie');
      assert.match(params.query, /Dune/);
      return [row()];
    },
  };
  const out = await searchProwlarr({
    type: 'movie', title: 'Dune', year: 2021, wantedImdbId: 'tt1160419', client,
  });
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.infoHash, HASH);
  assert.equal(c.relevance, 0.7);
  assert.equal(c.selectedFileSize, null, 'torrent size never presented as per-file size');
  assert.equal(c.hasLiveDiscovery, true);
  assert.equal(c.selectedMediaId, 'tt1160419');
  assert.equal(c.sources[0].origin, 'live', 'live-scoped tier mechanics apply');
  assert.equal(c.sources[1].origin, 'prowlarr', 'tracker provenance preserved');
  assert.ok(c.sources[1].evidence.includes('prowlarr-imdb-corroborated'));
  assert.equal(c.resolution, '1080p');
  assert.ok(c.releaseKey.includes(HASH));
});

test('searchProwlarr TV passes season/episode hints and parses S/E', async () => {
  let seen = null;
  const client = {
    search: async (params) => {
      seen = params;
      return [row({ title: 'Show.S01E01.1080p.WEB-DL.mkv', fileName: 'Show.S01E01.1080p.WEB-DL.mkv', infoHash: HASH2, imdbId: 0 })];
    },
  };
  const out = await searchProwlarr({ type: 'series', title: 'Show', season: 1, episode: 1, client });
  assert.equal(seen.season, 1);
  assert.equal(seen.episode, 1, 'internal client contract uses domain names');
  assert.equal(out.length, 1);
  assert.equal(out[0].season, 1);
  assert.equal(out[0].episode, 1);
});

test('factory client translates season/episode to Torznab-style HTTP params', async () => {
  let url = null;
  const client = createProwlarrClient({
    baseUrl: 'http://prowlarr.local:9696',
    apiKey: 'k',
    fetchFn: async (u) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  await client.search({ query: 'Show', type: 'tv', season: 1, episode: 2 });
  assert.match(url, /season=1/);
  assert.match(url, /ep=2/);
  assert.doesNotMatch(url, /episode=/);
});

test('disabled client and failures resolve to empty, never throw', async () => {
  assert.deepEqual(await searchProwlarr({ type: 'movie', title: 'Dune', client: null }), []);
  assert.deepEqual(await searchProwlarr({ type: 'movie', title: '', client: {} }), []);
  const failing = { search: async () => { throw new Error('tracker down'); } };
  assert.deepEqual(await searchProwlarr({ type: 'movie', title: 'Dune', client: failing }), []);
  await assert.rejects(searchProwlarr({ type: 'bogus', title: 'x', client: {} }), /Invalid Prowlarr type/);
});

test('unconfigured client factory throws a typed error', async () => {
  const client = createProwlarrClient({ baseUrl: null, apiKey: null });
  assert.equal(client.isConfigured(), false);
  await assert.rejects(client.search({ query: 'x' }), (err) => err.code === 'PROWLARR_DISABLED');
  const ok = createProwlarrClient({ baseUrl: 'http://x:9696', apiKey: 'k' });
  assert.equal(ok.isConfigured(), true);
  assert.equal(ok.addonId, 'prowlarr');
});

test('prowlarr rows tier exactly like equivalent live rows', async () => {
  const { classifyIdentityTier } = await import('../src/lib/discovery/ranking.js');
  const client = { search: async () => [row()] };
  const [pw] = await searchProwlarr({ type: 'movie', title: 'Dune', year: 2021, wantedImdbId: 'tt1160419', client });
  const liveTwin = {
    ...pw,
    relevance: 0.8,
    sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    selectedMediaId: 'tt1160419',
  };
  const intent = { season: null, episode: null, mediaTitle: 'Dune' };
  const a = classifyIdentityTier(pw, intent, 'tt1160419');
  const b = classifyIdentityTier(liveTwin, intent, 'tt1160419');
  assert.equal(a.IdentityTier, b.IdentityTier, `same tier (pw=${a.IdentityTier} live=${b.IdentityTier})`);
});
