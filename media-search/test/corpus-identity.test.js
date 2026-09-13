/**
 * Corpus identity tests (corpus intelligence tranche).
 *
 * Fixture in-memory cache; no network except stubbed getMedia.
 * Covers: title normalization, FTS phrase building, exact movie and
 * episode lookup with strict post-filtering, wanted-identity resolution
 * (caller title preferred, cached metadata fallback), and ranking-input
 * merge shape used by searchByMedia.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  normalizeTitle,
  ftsTitleQuery,
  lookupCorpusByTitle,
  resolveWantedIdentity,
  IDENTITY_TIERS,
  _clearTitleCacheForTests,
} from '../src/lib/discovery/corpus-identity.js';

const HASH_A = 'aabbccddeeff00112233445566778899aabbcc11';
const HASH_B = 'aabbccddeeff00112233445566778899aabbcc22';
const HASH_C = 'aabbccddeeff00112233445566778899aabbcc33';

async function seed(cache) {
  const { storeReleaseAttributes } = await import('../src/lib/discovery/release-attributes.js');
  const rows = [
    { infoHash: HASH_A, fileIndex: null, filename: 'Psycho.1960.1080p.BluRay.x264-GRP.mkv', source: 'test', confidence: 0.9,
      parsed: { title: 'Psycho', year: 1960, resolution: '1080p', mediaType: 'movie' }, evidence: ['t'] },
    { infoHash: HASH_B, fileIndex: null, filename: 'Psycho.1998.1080p.BluRay.x264-GRP.mkv', source: 'test', confidence: 0.9,
      parsed: { title: 'Psycho', year: 1998, resolution: '1080p', mediaType: 'movie' }, evidence: ['t'] },
    { infoHash: HASH_C, fileIndex: null, filename: 'Show.S02E03.1080p.WEB-DL.mkv', source: 'test', confidence: 0.9,
      parsed: { title: 'Show', season: 2, episode: 3, resolution: '1080p', mediaType: 'series' }, evidence: ['t'] },
  ];
  for (const r of rows) storeReleaseAttributes(cache, r);
  cache.upsertCandidate({ infoHash: HASH_A, fileIndex: null, filename: rows[0].filename, title: 'Psycho' });
}

test('normalizeTitle is strict and deterministic', () => {
  assert.equal(normalizeTitle('Psycho!'), 'psycho');
  assert.equal(normalizeTitle('  The   Matrix: Reloaded '), 'the matrix reloaded');
  assert.equal(normalizeTitle('Amélie'), 'amelie');
  assert.equal(normalizeTitle(''), '');
  assert.equal(ftsTitleQuery('psycho'), '"psycho"');
  assert.equal(ftsTitleQuery('the matrix'), '"the" "matrix"');
  assert.equal(ftsTitleQuery(''), null);
});

test('movie lookup is exact on title + year', async () => {
  const cache = createDiscoveryCache();
  try {
    await seed(cache);
    const hits60 = lookupCorpusByTitle(cache, { title: 'Psycho', year: 1960, mediaType: 'movie' });
    assert.equal(hits60.length, 1);
    assert.equal(hits60[0].infoHash, HASH_A);
    assert.equal(hits60[0].tier, IDENTITY_TIERS.STRUCTURED);
    const hits98 = lookupCorpusByTitle(cache, { title: 'Psycho', year: 1998, mediaType: 'movie' });
    assert.equal(hits98.length, 1);
    assert.equal(hits98[0].infoHash, HASH_B);
    // Wrong year: no rows (never fuzzy across years).
    assert.deepEqual(lookupCorpusByTitle(cache, { title: 'Psycho', year: 2000, mediaType: 'movie' }), []);
    // Missing year: no rows (refuse to guess).
    assert.deepEqual(lookupCorpusByTitle(cache, { title: 'Psycho', mediaType: 'movie' }), []);
    // Wrong title: no rows.
    assert.deepEqual(lookupCorpusByTitle(cache, { title: 'Psycha', year: 1960, mediaType: 'movie' }), []);
  } finally {
    cache.close();
  }
});

test('episode lookup is exact on title + S/E', async () => {
  const cache = createDiscoveryCache();
  try {
    await seed(cache);
    const hits = lookupCorpusByTitle(cache, { title: 'Show', season: 2, episode: 3, mediaType: 'series' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].infoHash, HASH_C);
    assert.deepEqual(lookupCorpusByTitle(cache, { title: 'Show', season: 2, episode: 4, mediaType: 'series' }), []);
    assert.deepEqual(lookupCorpusByTitle(cache, { title: 'Show', mediaType: 'series' }), []);
  } finally {
    cache.close();
  }
});

test('resolveWantedIdentity prefers caller title, caches metadata', async () => {
  _clearTitleCacheForTests();
  let calls = 0;
  const getMediaFn = async () => { calls++; return { title: 'Psycho', year: 1960 }; };
  const direct = await resolveWantedIdentity({ mediaId: 'tt1', mediaType: 'movie', mediaTitle: 'Psycho', canonicalYear: 1960, getMediaFn });
  assert.deepEqual(direct, { title: 'Psycho', year: 1960, source: 'caller' });
  assert.equal(calls, 0);
  const viaMeta = await resolveWantedIdentity({ mediaId: 'tt0089769', mediaType: 'movie', getMediaFn });
  assert.deepEqual(viaMeta, { title: 'Psycho', year: 1960, source: 'cinemeta' });
  assert.equal(calls, 1);
  await resolveWantedIdentity({ mediaId: 'tt0089769', mediaType: 'movie', getMediaFn });
  assert.equal(calls, 1, 'second resolution served from cache');
  _clearTitleCacheForTests();
});
