/**
 * Cinemeta Enrichment Source Tests
 *
 * Proves the media identity enrichment pipeline:
 *   release_attributes → Cinemeta search → candidate_media
 *
 * Tests:
 * - Exact movie match
 * - Exact TV episode match
 * - Ambiguous title (multiple associations)
 * - Failed lookup (no results, no forced association)
 * - Rerun/idempotency (re-enrichment preserves or updates)
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { enrichWithCinemeta } from '../src/lib/discovery/enrichment-sources/cinemeta.js';
import { enrichCandidate } from '../src/lib/discovery/enrichment.js';
import { computeConfidence, titleMatchQuality, yearMatch } from '../src/lib/discovery/enrichment-sources/confidence.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

// Helper to create a candidate with release attributes
function setupCandidate(cache, infoHash, attrs) {
  cache.upsertCandidate({
    infoHash,
    fileIndex: null,
    filename: attrs.filename,
    title: attrs.title,
  });
  storeReleaseAttributes(cache, {
    infoHash,
    fileIndex: null,
    filename: attrs.filename,
    source: 'ptn-regex',
    confidence: attrs.confidence || 0.85,
    parsed: {
      title: attrs.title,
      year: attrs.year,
      season: attrs.season,
      episode: attrs.episode,
      resolution: attrs.resolution,
      sourceType: attrs.sourceType,
      codec: attrs.codec,
    },
    evidence: ['title_extracted'],
  });
}

// =============================================================================
// Confidence Module Tests
// =============================================================================

test('computeConfidence: exact match with year gets highest score', () => {
  const score = computeConfidence({
    titleMatch: 'exact',
    yearMatch: true,
    seasonMatch: true,
    episodeMatch: true,
  });
  assert.equal(score, 0.95);  // 0.5 + 0.2 + 0.1 + 0.15 = 0.95
});

test('computeConfidence: no match gets base score', () => {
  const score = computeConfidence({ titleMatch: 'none' });
  assert.equal(score, 0.5);
});

test('computeConfidence: includes match gets small bonus', () => {
  const score = computeConfidence({ titleMatch: 'includes' });
  assert.equal(score, 0.55);
});

test('computeConfidence: starts match gets medium bonus', () => {
  const score = computeConfidence({ titleMatch: 'starts' });
  assert.equal(score, 0.6);
});

test('computeConfidence: clamps to [0.0, 1.0]', () => {
  const score = computeConfidence({
    titleMatch: 'exact',
    yearMatch: true,
    seasonMatch: true,
    episodeMatch: true,
  });
  assert.ok(score <= 1.0);
  assert.ok(score >= 0.0);
});

test('titleMatchQuality: exact match returns exact', () => {
  assert.equal(titleMatchQuality('Breaking Bad', 'Breaking Bad'), 'exact');
});

test('titleMatchQuality: case insensitive exact match', () => {
  assert.equal(titleMatchQuality('breaking bad', 'Breaking Bad'), 'exact');
});

test('titleMatchQuality: prefix match returns starts', () => {
  assert.equal(titleMatchQuality('Breaking', 'Breaking Bad'), 'starts');
});

test('titleMatchQuality: substring match returns includes', () => {
  assert.equal(titleMatchQuality('Bad', 'Breaking Bad'), 'includes');
});

test('titleMatchQuality: no match returns none', () => {
  assert.equal(titleMatchQuality('Completely Different', 'Breaking Bad'), 'none');
});

test('yearMatch: matching years return true', () => {
  assert.equal(yearMatch(2024, 2024), true);
});

test('yearMatch: mismatched years return false', () => {
  assert.equal(yearMatch(2024, 2023), false);
});

test('yearMatch: null years return false', () => {
  assert.equal(yearMatch(null, 2024), false);
  assert.equal(yearMatch(2024, null), false);
});

// =============================================================================
// Cinemeta Enrichment Adapter Tests
// =============================================================================

test('enrichWithCinemeta: exact movie match', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'The.Matrix.1999.1080p.BluRay.x264-TEST.mkv',
    title: 'The Matrix',
    year: 1999,
    resolution: '1080p',
    confidence: 0.9,
  });

  // Mock Cinemeta searchCatalog (returns different results for movie vs series)
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      if (url.includes('/series/')) return { metas: [] };
      return { metas: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix', year: 1999 }] };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });

  assert.ok(result);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].mediaId, 'tt0133093');
  assert.ok(result.matches[0].confidence >= 0.7);  // exact title + year
  assert.equal(result.source, 'cinemeta');
  assert.ok(result.evidence.includes('title_exact_match'));
  assert.ok(result.evidence.includes('year_match'));

  cache.close();
});

test('enrichWithCinemeta: exact TV episode match', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv',
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    resolution: '1080p',
    confidence: 0.9,
  });

  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      if (url.includes('/movie/')) return { metas: [] };
      return { metas: [{ id: 'tt0903747', type: 'series', name: 'Breaking Bad', year: 2008 }] };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });

  assert.ok(result);
  assert.equal(result.matches.length, 1);
  // For series with season/episode, media ID includes season:episode
  assert.equal(result.matches[0].mediaId, 'tt0903747:5:14');
  assert.ok(result.matches[0].confidence >= 0.5);
  assert.ok(result.evidence.includes('title_exact_match'));

  cache.close();
});

test('enrichWithCinemeta: ambiguous title returns multiple associations', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Batman.1989.1080p.mkv',
    title: 'Batman',
    year: 1989,
    resolution: '1080p',
    confidence: 0.85,
  });

  // Cinemeta returns multiple Batman movies
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return {
        metas: [
          { id: 'tt0096895', type: 'movie', name: 'Batman', year: 1989 },
          { id: 'tt0468569', type: 'movie', name: 'The Dark Knight', year: 2008 },
          { id: 'tt0112462', type: 'movie', name: 'Batman Forever', year: 1995 },
        ],
      };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });

  assert.ok(result);
  // Should return the 1989 Batman as a match (exact title + year)
  const batman1989 = result.matches.find(m => m.mediaId === 'tt0096895');
  assert.ok(batman1989);
  assert.ok(batman1989.confidence >= 0.7);

  cache.close();
});

test('enrichWithCinemeta: failed lookup returns null (no forced association)', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Some.Release.2024.mkv',
    title: 'Some Release',
    year: 2024,
    confidence: 0.8,
  });

  // Cinemeta returns no results
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return { metas: [] };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });

  assert.equal(result, null);

  // Verify no associations were created
  const associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(associations.length, 0);

  cache.close();
});

test('enrichWithCinemeta: API error returns null (no forced association)', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Test.Movie.mkv',
    title: 'Test Movie',
    confidence: 0.8,
  });

  // Cinemeta API fails
  const fetchImpl = async () => {
    throw new Error('Cinemeta service unavailable');
  };

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });

  assert.equal(result, null);

  cache.close();
});

test('enrichWithCinemeta: no release_attributes returns null', async () => {
  const cache = createDiscoveryCache();
  // Candidate without release attributes
  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'No.Attributes.mkv',
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null));

  assert.equal(result, null);

  cache.close();
});

test('enrichWithCinemeta: short title returns null', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'AB.mkv',
    title: 'AB',  // Less than 3 characters
    confidence: 0.5,
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null));

  assert.equal(result, null);

  cache.close();
});

test('enrichWithCinemeta: low confidence results are filtered out', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Unknown.Movie.2024.mkv',
    title: 'Very Specific Title That Matches Nothing',
    confidence: 0.8,
  });

  // Cinemeta returns unrelated results
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return {
        metas: [
          { id: 'tt9999999', type: 'movie', name: 'Completely Different Movie', year: 2020 },
        ],
      };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });

  // Should return null because no results meet confidence threshold
  assert.equal(result, null);

  cache.close();
});

// =============================================================================
// Integration Tests (enrichCandidate + enrichWithCinemeta)
// =============================================================================

test('integration: enrichCandidate writes candidate_media from Cinemeta result', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'The.Matrix.1999.1080p.mkv',
    title: 'The Matrix',
    year: 1999,
    confidence: 0.9,
  });

  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      if (url.includes('/series/')) return { metas: [] };
      return { metas: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix', year: 1999 }] };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });
  assert.ok(result);

  // Write through enrichment boundary
  const enrichResult = enrichCandidate(cache, result);
  assert.equal(enrichResult.associated, 1);

  // Verify candidate_media was written
  const associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].mediaId, 'tt0133093');
  assert.equal(associations[0].source, 'cinemeta');
  assert.ok(associations[0].confidence >= 0.7);

  cache.close();
});

test('integration: re-enrichment is idempotent (same media, higher confidence wins)', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'The.Matrix.1999.1080p.mkv',
    title: 'The Matrix',
    year: 1999,
    confidence: 0.9,
  });

  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return { metas: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix', year: 1999 }] };
    },
  });

  // First enrichment
  const result1 = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });
  enrichCandidate(cache, result1);

  // Second enrichment (should update with equal or higher confidence)
  const result2 = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });
  const enrichResult2 = enrichCandidate(cache, result2);

  // Should still have only one association (updated, not duplicated)
  const associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].mediaId, 'tt0133093');

  cache.close();
});

test('integration: multiple media associations preserved for ambiguous titles', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Batman.mkv',
    title: 'Batman',
    confidence: 0.85,
  });

  // Cinemeta returns multiple Batman movies
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return {
        metas: [
          { id: 'tt0096895', type: 'movie', name: 'Batman', year: 1989 },
          { id: 'tt0112462', type: 'movie', name: 'Batman Forever', year: 1995 },
          { id: 'tt0371746', type: 'movie', name: 'Iron Man', year: 2008 },  // Unrelated, should be filtered
        ],
      };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });
  if (result) {
    enrichCandidate(cache, result);
  }

  // Should have associations for Batman movies (exact or high-confidence matches)
  const associations = cache.getMediaAssociations(HASH1, null);
  // At least one Batman association
  assert.ok(associations.length >= 1);
  assert.ok(associations.some(a => a.mediaId === 'tt0096895'));

  cache.close();
});

test('integration: candidate identity is not mutated by enrichment', async () => {
  const cache = createDiscoveryCache();
  const originalFilename = 'The.Matrix.1999.1080p.mkv';

  setupCandidate(cache, HASH1, {
    filename: originalFilename,
    title: 'The Matrix',
    year: 1999,
    confidence: 0.9,
  });

  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return { metas: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix', year: 1999 }] };
    },
  });

  await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });

  // Verify candidate identity unchanged
  const candidate = cache.getCandidate(HASH1, null);
  assert.equal(candidate.infoHash, HASH1);
  assert.equal(candidate.fileIndex, null);
  assert.equal(candidate.filename, originalFilename);

  cache.close();
});

test('integration: provider observations are not created by enrichment', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'The.Matrix.1999.1080p.mkv',
    title: 'The Matrix',
    year: 1999,
    confidence: 0.9,
  });

  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return { metas: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix', year: 1999 }] };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });
  enrichCandidate(cache, result);

  // Verify no provider observations created
  const observations = cache.getProviderObservations(HASH1, null);
  assert.equal(observations.length, 0);

  cache.close();
});

// =============================================================================
// Season/Episode Specific Tests
// =============================================================================

test('season/episode match: series with season/episode gets correct media ID', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Breaking.Bad.S05E14.1080p.mkv',
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    confidence: 0.9,
  });

  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return { metas: [{ id: 'tt0903747', type: 'series', name: 'Breaking Bad', year: 2008 }] };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });

  assert.ok(result);
  // For series with season/episode, media ID should be imdb_id:season:episode
  assert.equal(result.matches[0].mediaId, 'tt0903747:5:14');

  cache.close();
});

test('season/episode match: movie without season/episode gets simple media ID', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'The.Matrix.1999.1080p.mkv',
    title: 'The Matrix',
    year: 1999,
    confidence: 0.9,
  });

  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return { metas: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix', year: 1999 }] };
    },
  });

  const result = await enrichWithCinemeta(cache, cache.getCandidate(HASH1, null), { fetchImpl });

  assert.ok(result);
  // For movies, media ID is just the imdb ID
  assert.equal(result.matches[0].mediaId, 'tt0133093');

  cache.close();
});
