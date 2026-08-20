/**
 * Ranking Engine Tests
 *
 * Proves the ranking module:
 * - Pure function (no I/O, no API calls, no mutations)
 * - Correct component scoring
 * - Correct composite weighting
 * - Unknown provider state is neutral (not a penalty)
 * - Episode match bonus works
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rankHit,
  rankHits,
  qualityScore,
  identityConfidenceScore,
  providerAvailabilityScore,
  episodeMatchScore,
  getWeights,
} from '../src/lib/discovery/ranking.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

// =============================================================================
// Component Score Tests
// =============================================================================

test('qualityScore: 2160p BluRay HDR x265 gets highest score', () => {
  const score = qualityScore({
    resolution: '2160p',
    sourceType: 'BluRay',
    codec: 'x265',
    hdr: true,
  });
  assert.ok(score >= 0.9);
  assert.ok(score <= 1.0);
});

test('qualityScore: 480p DVD gets low score', () => {
  const score = qualityScore({
    resolution: '480p',
    sourceType: 'DVD',
    codec: 'x264',
    hdr: false,
  });
  assert.ok(score < 0.5);
});

test('qualityScore: 1080p WEB-DL gets medium score', () => {
  const score = qualityScore({
    resolution: '1080p',
    sourceType: 'WEB-DL',
    codec: 'x264',
  });
  assert.ok(score >= 0.6);
  assert.ok(score <= 0.9);
});

test('qualityScore: unknown attributes get zero', () => {
  const score = qualityScore({});
  assert.equal(score, 0);
});

test('identityConfidenceScore: no associations returns neutral', () => {
  const score = identityConfidenceScore([]);
  assert.equal(score, 0.5);
});

test('identityConfidenceScore: one high confidence association', () => {
  const score = identityConfidenceScore([{ mediaId: 'tt123', confidence: 0.9 }]);
  assert.equal(score, 0.9);
});

test('identityConfidenceScore: multiple associations uses highest', () => {
  const score = identityConfidenceScore([
    { mediaId: 'tt123', confidence: 0.6 },
    { mediaId: 'tt456', confidence: 0.9 },
    { mediaId: 'tt789', confidence: 0.7 },
  ]);
  assert.equal(score, 0.9);
});

test('providerAvailabilityScore: no observations returns neutral', () => {
  const score = providerAvailabilityScore([]);
  assert.equal(score, 0.5);  // Neutral, not a penalty
});

test('providerAvailabilityScore: all cached returns 1.0', () => {
  const score = providerAvailabilityScore([
    { provider: 'torbox', cached: true },
    { provider: 'rd', cached: true },
  ]);
  assert.equal(score, 1.0);
});

test('providerAvailabilityScore: all uncached returns 0.0', () => {
  const score = providerAvailabilityScore([
    { provider: 'torbox', cached: false },
    { provider: 'rd', cached: false },
  ]);
  assert.equal(score, 0.0);
});

test('providerAvailabilityScore: mixed returns proportional', () => {
  const score = providerAvailabilityScore([
    { provider: 'torbox', cached: true },
    { provider: 'rd', cached: false },
  ]);
  assert.equal(score, 0.5);
});

test('providerAvailabilityScore: integer cached values work', () => {
  const score = providerAvailabilityScore([
    { provider: 'torbox', cached: 1 },
    { provider: 'rd', cached: 0 },
  ]);
  assert.equal(score, 0.5);
});

test('episodeMatchScore: no query intent returns neutral', () => {
  const score = episodeMatchScore({ season: 5, episode: 14 }, {});
  assert.equal(score, 0.5);
});

test('episodeMatchScore: exact match returns 1.0', () => {
  const score = episodeMatchScore(
    { season: 5, episode: 14 },
    { season: 5, episode: 14 }
  );
  assert.equal(score, 1.0);
});

test('episodeMatchScore: right season wrong episode returns 0.5', () => {
  const score = episodeMatchScore(
    { season: 5, episode: 14 },
    { season: 5, episode: 10 }
  );
  assert.equal(score, 0.5);
});

test('episodeMatchScore: wrong season returns 0.0', () => {
  const score = episodeMatchScore(
    { season: 5, episode: 14 },
    { season: 3, episode: 14 }
  );
  assert.equal(score, 0.0);
});

// =============================================================================
// Composite Ranking Tests
// =============================================================================

test('rankHit: produces score and components', () => {
  const result = rankHit({
    hash: HASH1,
    fileIndex: null,
    filename: 'test.mkv',
    relevance: 0.8,
    releaseAttributes: {
      resolution: '1080p',
      sourceType: 'BluRay',
      codec: 'x264',
    },
    parserConfidence: 0.85,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.9 }],
    providerObservations: [],
  });

  assert.equal(result.hash, HASH1);
  assert.ok(result.score > 0);
  assert.ok(result.score <= 1.0);
  assert.ok(result.components);
  assert.ok(result.components.relevance === 0.8);
  assert.ok(result.components.quality > 0);
});

test('rankHit: missing data uses neutral values', () => {
  const result = rankHit({
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.5,
  });

  assert.equal(result.score > 0, true);
  // Neutral values should not crash
  assert.ok(result.components.identityConfidence === 0.5);
  assert.ok(result.components.providerAvailability === 0.5);
});

test('rankHits: sorts by score descending', () => {
  const hits = [
    {
      hash: HASH1,
      filename: 'low.mkv',
      relevance: 0.3,
      releaseAttributes: { resolution: '480p', sourceType: 'DVD' },
      parserConfidence: 0.5,
    },
    {
      hash: HASH2,
      filename: 'high.mkv',
      relevance: 0.9,
      releaseAttributes: { resolution: '2160p', sourceType: 'BluRay', hdr: true },
      parserConfidence: 0.95,
    },
    {
      hash: HASH3,
      filename: 'medium.mkv',
      relevance: 0.6,
      releaseAttributes: { resolution: '1080p', sourceType: 'WEB-DL' },
      parserConfidence: 0.8,
    },
  ];

  const ranked = rankHits(hits);

  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].hash, HASH2);  // Highest quality
  assert.equal(ranked[1].hash, HASH3);  // Medium
  assert.equal(ranked[2].hash, HASH1);  // Lowest
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[1].score > ranked[2].score);
});

// =============================================================================
// Scenario Tests
// =============================================================================

test('scenario: same episode, different quality ranks higher quality first', () => {
  const hits = [
    {
      hash: HASH1,
      filename: 'S05E14.480p.DVD.mkv',
      relevance: 0.9,  // Same relevance
      releaseAttributes: { season: 5, episode: 14, resolution: '480p', sourceType: 'DVD' },
      parserConfidence: 0.8,
    },
    {
      hash: HASH2,
      filename: 'S05E14.2160p.BluRay.HDR.mkv',
      relevance: 0.9,  // Same relevance
      releaseAttributes: { season: 5, episode: 14, resolution: '2160p', sourceType: 'BluRay', hdr: true },
      parserConfidence: 0.8,
    },
  ];

  const ranked = rankHits(hits, { season: 5, episode: 14 });

  // 2160p HDR should rank higher despite same relevance
  assert.equal(ranked[0].hash, HASH2);
  assert.ok(ranked[0].components.quality > ranked[1].components.quality);
});

test('scenario: same quality, different confidence ranks higher confidence first', () => {
  const hits = [
    {
      hash: HASH1,
      filename: 'low_conf.mkv',
      relevance: 0.8,
      releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
      parserConfidence: 0.5,  // Low confidence
    },
    {
      hash: HASH2,
      filename: 'high_conf.mkv',
      relevance: 0.8,
      releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
      parserConfidence: 0.95,  // High confidence
    },
  ];

  const ranked = rankHits(hits);

  assert.equal(ranked[0].hash, HASH2);
  assert.ok(ranked[0].components.releaseConfidence > ranked[1].components.releaseConfidence);
});

test('scenario: cached vs unknown — cached should rank higher', () => {
  const hits = [
    {
      hash: HASH1,
      filename: 'unknown_cache.mkv',
      relevance: 0.8,
      releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
      parserConfidence: 0.85,
      providerObservations: [],  // Unknown
    },
    {
      hash: HASH2,
      filename: 'cached.mkv',
      relevance: 0.8,
      releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
      parserConfidence: 0.85,
      providerObservations: [{ provider: 'torbox', cached: true }],  // Cached
    },
  ];

  const ranked = rankHits(hits);

  // Cached should rank higher
  assert.equal(ranked[0].hash, HASH2);
  assert.equal(ranked[0].components.providerAvailability, 1.0);
  assert.equal(ranked[1].components.providerAvailability, 0.5);  // Neutral
});

test('scenario: unknown provider does not penalize (neutral = 0.5)', () => {
  const hit = {
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.85,
    providerObservations: [],
  };

  const result = rankHit(hit);

  // Unknown provider should be neutral, not zero
  assert.equal(result.components.providerAvailability, 0.5);
});

test('scenario: ambiguous identity (multiple associations)', () => {
  const hit = {
    hash: HASH1,
    filename: 'ambiguous.mkv',
    relevance: 0.7,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.8,
    mediaAssociations: [
      { mediaId: 'tt111', confidence: 0.6 },
      { mediaId: 'tt222', confidence: 0.7 },
      { mediaId: 'tt333', confidence: 0.5 },
    ],
  };

  const result = rankHit(hit);

  // Should use highest confidence association
  assert.equal(result.components.identityConfidence, 0.7);
});

test('scenario: missing metadata does not crash', () => {
  const hit = {
    hash: HASH1,
    filename: 'minimal.mkv',
    relevance: 0.5,
  };

  const result = rankHit(hit);

  assert.ok(result.score > 0);
  assert.ok(result.score <= 1.0);
});

test('scenario: episode match bonus applies when query has season/episode', () => {
  const hit = {
    hash: HASH1,
    filename: 'S05E14.mkv',
    relevance: 0.7,
    releaseAttributes: { season: 5, episode: 14, resolution: '1080p' },
    parserConfidence: 0.85,
  };

  const withEpisode = rankHit(hit, { season: 5, episode: 14 });
  const withoutEpisode = rankHit(hit, {});

  // Episode match should boost score
  assert.ok(withEpisode.score > withoutEpisode.score);
  assert.equal(withEpisode.components.episodeMatch, 1.0);
  assert.equal(withoutEpisode.components.episodeMatch, 0.5);  // Neutral
});

test('scenario: wrong episode gets lower bonus than exact match', () => {
  const hitCorrect = {
    hash: HASH1,
    filename: 'S05E14.mkv',
    relevance: 0.7,
    releaseAttributes: { season: 5, episode: 14, resolution: '1080p' },
    parserConfidence: 0.85,
  };

  const hitWrong = {
    hash: HASH2,
    filename: 'S05E10.mkv',
    relevance: 0.7,
    releaseAttributes: { season: 5, episode: 10, resolution: '1080p' },
    parserConfidence: 0.85,
  };

  const rankedCorrect = rankHit(hitCorrect, { season: 5, episode: 14 });
  const rankedWrong = rankHit(hitWrong, { season: 5, episode: 14 });

  assert.equal(rankedCorrect.components.episodeMatch, 1.0);
  assert.equal(rankedWrong.components.episodeMatch, 0.5);
  assert.ok(rankedCorrect.score > rankedWrong.score);
});

// =============================================================================
// Contract Tests
// =============================================================================

test('getWeights: returns weight configuration', () => {
  const weights = getWeights();

  assert.ok(weights.relevance > 0);
  assert.ok(weights.quality > 0);
  assert.ok(weights.releaseConfidence > 0);
  assert.ok(weights.identityConfidence > 0);
  assert.ok(weights.providerAvailability > 0);
  assert.ok(weights.episodeMatch > 0);

  // Weights should sum to 1.0
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.001);
});

test('rankHit: does not mutate input', () => {
  const hit = {
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.85,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.9 }],
    providerObservations: [],
  };

  const original = JSON.parse(JSON.stringify(hit));

  rankHit(hit);

  // Input should not be mutated
  assert.deepEqual(hit.releaseAttributes, original.releaseAttributes);
  assert.deepEqual(hit.mediaAssociations, original.mediaAssociations);
  assert.deepEqual(hit.providerObservations, original.providerObservations);
});
