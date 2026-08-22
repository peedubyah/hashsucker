/**
 * Episode Coverage Eligibility Tests
 *
 * Proves Stage 2 explicit TV episode coverage + hard eligibility:
 *
 * 1. SINGLE EPISODE
 *    S01E03 requested, S01E03 release => eligible
 *    S01E03 requested, S01E02 release => rejected
 *    S01E03 requested, S02E03 release => rejected
 *
 * 2. EPISODE RANGE
 *    request E03, range E01-E05 => eligible
 *    request E01, range E01-E05 => eligible
 *    request E05, range E01-E05 => eligible
 *    request E06, range E01-E05 => rejected
 *    malformed/reversed range => rejected
 *
 * 3. SEASON PACK
 *    request S01E03, explicit S01 season pack => eligible
 *    request S01E03, explicit S02 season pack => rejected
 *    missing episode data without pack evidence => NOT eligible
 *
 * 4. EXACT IDENTITY
 *    same hash, different file indexes covering different episodes => independent
 *    null index vs zero remains distinct
 *
 * 5. ASSOCIATION + COVERAGE
 *    correct episode coverage but association only to another mediaId => rejected
 *    selected-media association but wrong episode coverage => rejected
 *    selected-media association + valid coverage => eligible
 *
 * 6. EMPTY QUERY
 *    still returns only selected-media-associated AND episode-compatible local candidates
 *
 * 7. MOVIE REGRESSION
 *    movie retrieval behavior unchanged
 *
 * 8. LIVE REGRESSION
 *    valid live candidate survives combined search as before
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { searchReleases, combinedSearch } from '../src/lib/discovery/search-engine.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { coversEpisode, parseEpisodeRange } from '../src/lib/discovery/episode-coverage.js';
import { episodeMatchScore } from '../src/lib/discovery/ranking.js';

// =============================================================================
// Fixtures
// =============================================================================
const HASH_EP = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // exact episode
const HASH_WRONG_EP = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // wrong episode
const HASH_WRONG_SEASON = 'cccccccccccccccccccccccccccccccccccccccc'; // wrong season
const HASH_RANGE = 'dddddddddddddddddddddddddddddddddddddddd'; // episode range
const HASH_RANGE_OUT = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // range doesn't contain E
const HASH_PACK_S1 = '1111111111111111111111111111111111111111'; // season 1 pack
const HASH_PACK_S2 = '2222222222222222222222222222222222222222'; // season 2 pack
const HASH_MOVIE = '3333333333333333333333333333333333333333'; // movie
const HASH_LIVE = '4444444444444444444444444444444444444444'; // live candidate

const MEDIA_SHOW = 'tt2085059'; // Black Mirror
const MEDIA_OTHER = 'tt0000001'; // some other media

/**
 * Helper: store release attributes with episode evidence
 */
function storeEpisodeAttrs(cache, infoHash, fileIndex, attrs) {
  storeReleaseAttributes(cache, {
    infoHash,
    fileIndex,
    filename: attrs.filename,
    source: 'ptn-regex',
    confidence: attrs.confidence || 0.9,
    parsed: {
      title: attrs.title,
      year: attrs.year || 2024,
      season: attrs.season,
      episode: attrs.episode,
      episodeRange: attrs.episodeRange,
      mediaType: attrs.mediaType,
      resolution: attrs.resolution || '1080p',
    },
    evidence: ['title_extracted'],
  });
}

/**
 * Helper: associate candidate with media
 */
function associate(cache, infoHash, fileIndex, mediaId, confidence = 0.9) {
  cache.associateMedia(infoHash, fileIndex, mediaId, { confidence, source: 'search' });
}

// =============================================================================
// parseEpisodeRange unit tests
// =============================================================================
test('parseEpisodeRange: valid range "1-5"', () => {
  const r = parseEpisodeRange('1-5');
  assert.deepEqual(r, { start: 1, end: 5 });
});

test('parseEpisodeRange: valid range with whitespace " 3 - 7 "', () => {
  const r = parseEpisodeRange(' 3 - 7 ');
  assert.deepEqual(r, { start: 3, end: 7 });
});

test('parseEpisodeRange: reversed range "5-1" returns null', () => {
  assert.equal(parseEpisodeRange('5-1'), null);
});

test('parseEpisodeRange: single number "5" returns null', () => {
  assert.equal(parseEpisodeRange('5'), null);
});

test('parseEpisodeRange: non-numeric "a-b" returns null', () => {
  assert.equal(parseEpisodeRange('a-b'), null);
});

test('parseEpisodeRange: empty string returns null', () => {
  assert.equal(parseEpisodeRange(''), null);
});

test('parseEpisodeRange: null input returns null', () => {
  assert.equal(parseEpisodeRange(null), null);
});

test('parseEpisodeRange: zero start "0-5" returns null', () => {
  assert.equal(parseEpisodeRange('0-5'), null);
});

// =============================================================================
// parseEpisodeRange strict-rejection fixtures (Stage 2 invariant:
// "Malformed ranges must not accidentally become eligible")
// =============================================================================
test('parseEpisodeRange: trailing garbage "1x-5" returns null', () => {
  assert.equal(parseEpisodeRange('1x-5'), null);
});

test('parseEpisodeRange: trailing garbage "1-5x" returns null', () => {
  assert.equal(parseEpisodeRange('1-5x'), null);
});

test('parseEpisodeRange: decimal "1.5-5" returns null', () => {
  assert.equal(parseEpisodeRange('1.5-5'), null);
});

test('parseEpisodeRange: double-dash "1--5" returns null', () => {
  assert.equal(parseEpisodeRange('1--5'), null);
});

test('parseEpisodeRange: empty left bound "-5" returns null', () => {
  assert.equal(parseEpisodeRange('-5'), null);
});

test('parseEpisodeRange: empty right bound "1-" returns null', () => {
  assert.equal(parseEpisodeRange('1-'), null);
});

test('parseEpisodeRange: negative "-3-5" returns null', () => {
  assert.equal(parseEpisodeRange('-3-5'), null);
});

test('parseEpisodeRange: negative "1--5" returns null', () => {
  assert.equal(parseEpisodeRange('1--5'), null);
});

test('parseEpisodeRange: negative end "1--3" returns null', () => {
  assert.equal(parseEpisodeRange('1--3'), null);
});

test('parseEpisodeRange: hex-looking "0x1-0x5" returns null', () => {
  assert.equal(parseEpisodeRange('0x1-0x5'), null);
});

test('parseEpisodeRange: leading-zero bounds "01-05" parse (start 1, end 5)', () => {
  const r = parseEpisodeRange('01-05');
  assert.deepEqual(r, { start: 1, end: 5 });
});

test('parseEpisodeRange: coversEpisode rejects "1x-5" range as malformed', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1x-5' }, 1, 1);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'malformed-range');
});

test('parseEpisodeRange: coversEpisode rejects "1.5-5" range as malformed', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1.5-5' }, 1, 1);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'malformed-range');
});

test('parseEpisodeRange: coversEpisode rejects "1--5" range as malformed', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1--5' }, 1, 1);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'malformed-range');
});

test('parseEpisodeRange: coversEpisode still accepts valid "1-5"', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1-5' }, 1, 3);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'in-range');
});

test('parseEpisodeRange: coversEpisode still accepts boundary start', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1-5' }, 1, 1);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'in-range');
});

test('parseEpisodeRange: coversEpisode still accepts boundary end', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1-5' }, 1, 5);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'in-range');
});

test('parseEpisodeRange: episodeMatchScore rejects "1x-5" (defensive)', () => {
  const score = episodeMatchScore(
    { season: 1, episodeRange: '1x-5' },
    { season: 1, episode: 3 },
  );
  assert.equal(score, 0.0);
});

test('parseEpisodeRange: episodeMatchScore rejects "1--5" (defensive)', () => {
  const score = episodeMatchScore(
    { season: 1, episodeRange: '1--5' },
    { season: 1, episode: 3 },
  );
  assert.equal(score, 0.0);
});

test('parseEpisodeRange: episodeMatchScore still accepts valid "1-5"', () => {
  const score = episodeMatchScore(
    { season: 1, episodeRange: '1-5' },
    { season: 1, episode: 3 },
  );
  assert.equal(score, 0.8);
});

// =============================================================================
// coversEpisode unit tests — SINGLE EPISODE
// =============================================================================
test('coversEpisode: exact single episode S01E03 vs S01E03 => eligible', () => {
  const result = coversEpisode({ season: 1, episode: 3 }, 1, 3);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'exact-episode');
});

test('coversEpisode: S01E02 release for S01E03 request => ineligible', () => {
  const result = coversEpisode({ season: 1, episode: 2 }, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'wrong-episode');
});

test('coversEpisode: S02E03 release for S01E03 request => ineligible (wrong season)', () => {
  const result = coversEpisode({ season: 2, episode: 3 }, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'wrong-season');
});

// =============================================================================
// coversEpisode unit tests — EPISODE RANGE
// =============================================================================
test('coversEpisode: request E03, range E01-E05 => eligible', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1-5' }, 1, 3);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'in-range');
});

test('coversEpisode: request E01, range E01-E05 => eligible (boundary start)', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1-5' }, 1, 1);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'in-range');
});

test('coversEpisode: request E05, range E01-E05 => eligible (boundary end)', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1-5' }, 1, 5);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'in-range');
});

test('coversEpisode: request E06, range E01-E05 => ineligible', () => {
  const result = coversEpisode({ season: 1, episodeRange: '1-5' }, 1, 6);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'out-of-range');
});

test('coversEpisode: request E03, range E05-E01 (reversed) => ineligible', () => {
  const result = coversEpisode({ season: 1, episodeRange: '5-1' }, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'malformed-range');
});

test('coversEpisode: request E03, malformed range "abc" => ineligible', () => {
  const result = coversEpisode({ season: 1, episodeRange: 'abc' }, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'malformed-range');
});

test('coversEpisode: wrong season with valid range => ineligible', () => {
  const result = coversEpisode({ season: 2, episodeRange: '1-5' }, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'wrong-season');
});

// =============================================================================
// coversEpisode unit tests — SEASON PACK
// =============================================================================
test('coversEpisode: request S01E03, explicit S01 season pack (seasonOnly) => eligible', () => {
  const result = coversEpisode({ season: 1, seasonOnly: true }, 1, 3);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'season-pack');
});

test('coversEpisode: request S01E03, explicit S01 season pack (mediaType=season) => eligible', () => {
  const result = coversEpisode({ season: 1, mediaType: 'season' }, 1, 3);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'season-pack');
});

test('coversEpisode: request S01E03, explicit S02 season pack => ineligible', () => {
  const result = coversEpisode({ season: 2, seasonOnly: true }, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'wrong-season');
});

test('coversEpisode: season present but no episode/range/pack => ineligible (unknown coverage)', () => {
  const result = coversEpisode({ season: 1 }, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unknown-episode-coverage');
});

test('coversEpisode: no season evidence at all => ineligible', () => {
  const result = coversEpisode({}, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'no-season-evidence');
});

// =============================================================================
// episodeMatchScore preference tiers (among eligible candidates)
// =============================================================================
test('episodeMatchScore: exact episode match => 1.0', () => {
  const score = episodeMatchScore({ season: 1, episode: 3 }, { season: 1, episode: 3 });
  assert.equal(score, 1.0);
});

test('episodeMatchScore: episode range containing requested => 0.8', () => {
  const score = episodeMatchScore({ season: 1, episodeRange: '1-5' }, { season: 1, episode: 3 });
  assert.equal(score, 0.8);
});

test('episodeMatchScore: season pack for correct season => 0.6', () => {
  const score = episodeMatchScore({ season: 1, seasonOnly: true }, { season: 1, episode: 3 });
  assert.equal(score, 0.6);
});

test('episodeMatchScore: wrong season => 0.0', () => {
  const score = episodeMatchScore({ season: 2, episode: 3 }, { season: 1, episode: 3 });
  assert.equal(score, 0.0);
});

test('episodeMatchScore: no query intent => neutral', () => {
  const score = episodeMatchScore({ season: 1, episode: 3 }, {});
  assert.equal(score, 0.5);
});

// =============================================================================
// search-engine integration: SINGLE EPISODE
// =============================================================================
test('search single episode: S01E03 requested, S01E03 release => eligible', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_EP, null, {
    filename: 'Show.S01E03.1080p.mkv',
    title: 'Show S01E03',
    season: 1, episode: 3,
  });
  associate(cache, HASH_EP, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].hash, HASH_EP);
  assert.equal(result.results[0].fileIndex, null);
  cache.close();
});

test('search single episode: S01E03 requested, S01E02 release => rejected', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_WRONG_EP, null, {
    filename: 'Show.S01E02.1080p.mkv',
    title: 'Show S01E02',
    season: 1, episode: 2,
  });
  associate(cache, HASH_WRONG_EP, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 0);
  cache.close();
});

test('search single episode: S01E03 requested, S02E03 release => rejected', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_WRONG_SEASON, null, {
    filename: 'Show.S02E03.1080p.mkv',
    title: 'Show S02E03',
    season: 2, episode: 3,
  });
  associate(cache, HASH_WRONG_SEASON, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 0);
  cache.close();
});

// =============================================================================
// search-engine integration: EPISODE RANGE
// =============================================================================
test('search episode range: request E03, range E01-E05 => eligible', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_RANGE, null, {
    filename: 'Show.S01E01-E05.1080p.mkv',
    title: 'Show S01E01-E05',
    season: 1, episodeRange: '1-5',
  });
  associate(cache, HASH_RANGE, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].hash, HASH_RANGE);
  cache.close();
});

test('search episode range: request E06, range E01-E05 => rejected', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_RANGE_OUT, null, {
    filename: 'Show.S01E01-E05.1080p.mkv',
    title: 'Show S01E01-E05',
    season: 1, episodeRange: '1-5',
  });
  associate(cache, HASH_RANGE_OUT, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 6,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 0);
  cache.close();
});

test('search episode range: malformed/reversed range => rejected', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_RANGE_OUT, null, {
    filename: 'Show.S01E05-E01.1080p.mkv',
    title: 'Show S01E05-E01',
    season: 1, episodeRange: '5-1',
  });
  associate(cache, HASH_RANGE_OUT, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 0);
  cache.close();
});

// =============================================================================
// search-engine integration: SEASON PACK
// =============================================================================
test('search season pack: request S01E03, explicit S01 season pack => eligible', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_PACK_S1, null, {
    filename: 'Show.S01.Complete.1080p.mkv',
    title: 'Show S01 Complete',
    season: 1, mediaType: 'season',
  });
  associate(cache, HASH_PACK_S1, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].hash, HASH_PACK_S1);
  cache.close();
});

test('search season pack: request S01E03, explicit S02 season pack => rejected', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_PACK_S2, null, {
    filename: 'Show.S02.Complete.1080p.mkv',
    title: 'Show S02 Complete',
    season: 2, mediaType: 'season',
  });
  associate(cache, HASH_PACK_S2, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 0);
  cache.close();
});

// =============================================================================
// EXACT IDENTITY: same hash, different file indexes
// =============================================================================
test('exact identity: same hash, fileIndex 0 = S01E03, fileIndex 1 = S01E04', () => {
  const cache = createDiscoveryCache();
  const hash = 'ffffffffffffffffffffffffffffffffffffffff';

  // fileIndex 0 covers S01E03
  storeEpisodeAttrs(cache, hash, 0, {
    filename: 'Show.S01E03.1080p.mkv',
    title: 'Show S01E03',
    season: 1, episode: 3,
  });
  associate(cache, hash, 0, MEDIA_SHOW);

  // fileIndex 1 covers S01E04
  storeEpisodeAttrs(cache, hash, 1, {
    filename: 'Show.S01E04.1080p.mkv',
    title: 'Show S01E04',
    season: 1, episode: 4,
  });
  associate(cache, hash, 1, MEDIA_SHOW);

  // Request S01E03 — only fileIndex 0 should be eligible
  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].fileIndex, 0);
  assert.equal(result.results[0].releaseKey, `${hash}:0`);
  cache.close();
});

test('exact identity: null fileIndex vs zero fileIndex remain distinct', () => {
  const cache = createDiscoveryCache();
  const hash = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

  // null fileIndex (torrent-level) covers S01E03
  storeEpisodeAttrs(cache, hash, null, {
    filename: 'Show.S01E03.1080p.mkv',
    title: 'Show S01E03',
    season: 1, episode: 3,
  });
  associate(cache, hash, null, MEDIA_SHOW);

  // fileIndex 0 covers S01E04
  storeEpisodeAttrs(cache, hash, 0, {
    filename: 'Show.S01E04.1080p.mkv',
    title: 'Show S01E04',
    season: 1, episode: 4,
  });
  associate(cache, hash, 0, MEDIA_SHOW);

  // Request S01E03 — only null fileIndex should be eligible
  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].fileIndex, null);
  assert.equal(result.results[0].releaseKey, `${hash}:torrent`);
  cache.close();
});

// =============================================================================
// ASSOCIATION + COVERAGE
// =============================================================================
test('association + coverage: correct episode but associated only to OTHER mediaId => rejected', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_EP, null, {
    filename: 'Show.S01E03.1080p.mkv',
    title: 'Show S01E03',
    season: 1, episode: 3,
  });
  // Associate with OTHER media, not MEDIA_SHOW
  associate(cache, HASH_EP, null, MEDIA_OTHER);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 0);
  cache.close();
});

test('association + coverage: selected-media association but wrong episode => rejected', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_WRONG_EP, null, {
    filename: 'Show.S01E02.1080p.mkv',
    title: 'Show S01E02',
    season: 1, episode: 2,
  });
  associate(cache, HASH_WRONG_EP, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 0);
  cache.close();
});

test('association + coverage: selected-media association + valid coverage => eligible', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_EP, null, {
    filename: 'Show.S01E03.1080p.mkv',
    title: 'Show S01E03',
    season: 1, episode: 3,
  });
  associate(cache, HASH_EP, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].hash, HASH_EP);
  cache.close();
});

// =============================================================================
// EMPTY QUERY: selected-media + episode-compatible only
// =============================================================================
test('empty query: returns only selected-media-associated AND episode-compatible', () => {
  const cache = createDiscoveryCache();

  // Candidate associated with MEDIA_SHOW, correct episode
  storeEpisodeAttrs(cache, HASH_EP, null, {
    filename: 'Show.S01E03.1080p.mkv',
    title: 'Show S01E03',
    season: 1, episode: 3,
  });
  associate(cache, HASH_EP, null, MEDIA_SHOW);

  // Candidate associated with MEDIA_SHOW, wrong episode
  storeEpisodeAttrs(cache, HASH_WRONG_EP, null, {
    filename: 'Show.S01E02.1080p.mkv',
    title: 'Show S01E02',
    season: 1, episode: 2,
  });
  associate(cache, HASH_WRONG_EP, null, MEDIA_SHOW);

  // Candidate associated with OTHER media, correct episode
  storeEpisodeAttrs(cache, HASH_WRONG_SEASON, null, {
    filename: 'Show.S01E03.other.1080p.mkv',
    title: 'Show S01E03 other',
    season: 1, episode: 3,
  });
  associate(cache, HASH_WRONG_SEASON, null, MEDIA_OTHER);

  const result = searchReleases(cache, {
    query: '',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  // Only HASH_EP should appear (associated with MEDIA_SHOW AND covers S01E03)
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].hash, HASH_EP);
  cache.close();
});

// =============================================================================
// MOVIE REGRESSION
// =============================================================================
test('movie regression: movie retrieval unchanged (no episode intent)', () => {
  const cache = createDiscoveryCache();
  storeEpisodeAttrs(cache, HASH_MOVIE, null, {
    filename: 'Movie.2024.1080p.mkv',
    title: 'Movie 2024',
    year: 2024,
  });
  associate(cache, HASH_MOVIE, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Movie',
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].hash, HASH_MOVIE);
  cache.close();
});

// =============================================================================
// LIVE REGRESSION
// =============================================================================
test('live regression: valid live candidate survives combined search', async () => {
  const cache = createDiscoveryCache();

  // Corpus candidate
  storeEpisodeAttrs(cache, HASH_EP, null, {
    filename: 'Show.S01E03.1080p.mkv',
    title: 'Show S01E03',
    season: 1, episode: 3,
  });
  associate(cache, HASH_EP, null, MEDIA_SHOW);

  // Mock live discovery
  const mockLiveDiscovery = async () => [
    {
      infoHash: HASH_LIVE,
      fileIndex: null,
      releaseKey: `${HASH_LIVE}:torrent`,
      filename: 'Show.S01E03.Live.720p.mkv',
      title: 'Show S01E03 Live',
      season: 1, episode: 3,
      resolution: '720p',
      confidence: 0.8,
    },
  ];

  const result = await combinedSearch(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
    includeLive: true,
    liveDiscoveryFn: mockLiveDiscovery,
    mode: 'raw',
  });

  // Corpus candidate (eligible) + live candidate (no corpus association required)
  const hashes = result.results.map(r => r.hash.toLowerCase());
  assert.ok(hashes.includes(HASH_EP.toLowerCase()), 'Corpus candidate must be present');
  assert.ok(hashes.includes(HASH_LIVE.toLowerCase()), 'Live candidate must survive');
  cache.close();
});

// =============================================================================
// PREFERENCE TIER: exact episode ranks above range, range above season pack
// =============================================================================
test('preference tier: exact episode (1.0) > range (0.8) > season pack (0.6)', () => {
  const cache = createDiscoveryCache();

  // Exact episode
  storeEpisodeAttrs(cache, HASH_EP, null, {
    filename: 'Show.S01E03.1080p.mkv',
    title: 'Show S01E03',
    season: 1, episode: 3,
  });
  associate(cache, HASH_EP, null, MEDIA_SHOW);

  // Episode range
  storeEpisodeAttrs(cache, HASH_RANGE, null, {
    filename: 'Show.S01E01-E05.1080p.mkv',
    title: 'Show S01E01-E05',
    season: 1, episodeRange: '1-5',
  });
  associate(cache, HASH_RANGE, null, MEDIA_SHOW);

  // Season pack
  storeEpisodeAttrs(cache, HASH_PACK_S1, null, {
    filename: 'Show.S01.Complete.1080p.mkv',
    title: 'Show S01 Complete',
    season: 1, mediaType: 'season',
  });
  associate(cache, HASH_PACK_S1, null, MEDIA_SHOW);

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1, episode: 3,
    mediaId: MEDIA_SHOW,
  });

  // All three should be eligible
  assert.equal(result.results.length, 3);

  // Exact episode should rank highest (episodeMatch = 1.0)
  assert.equal(result.results[0].hash, HASH_EP);
  assert.equal(result.results[0].components.episodeMatch, 1.0);

  // Range should be second (episodeMatch = 0.8)
  const rangeResult = result.results.find(r => r.hash === HASH_RANGE);
  assert.equal(rangeResult.components.episodeMatch, 0.8);

  // Season pack should be third (episodeMatch = 0.6)
  const packResult = result.results.find(r => r.hash === HASH_PACK_S1);
  assert.equal(packResult.components.episodeMatch, 0.6);

  cache.close();
});
