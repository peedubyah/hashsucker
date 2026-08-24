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
  rankHitsTiered,
  qualityScore,
  identityConfidenceScore,
  providerAvailabilityScore,
  episodeMatchScore,
  getWeights,
  compareHits,
  compareHitsDetailed,
  explainOrder,
  compareRanked,
  explainRank,
  diagnoseIdentityEligibility,
  countIdentityEligibility,
  classifyIdentityTier,
  evaluateIdentityTiers,
  aggregateIdentityTiers,
  shadowRankComparison,
  diagnoseIdentityEvidence,
  diagnoseTopCandidates,
} from '../src/lib/discovery/ranking.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';
const HASH4 = 'dddddddddddddddddddddddddddddddddddddddd';

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

test('episodeMatchScore: right season wrong episode returns 0.0 (hard gate rejects before scoring)', () => {
  const score = episodeMatchScore(
    { season: 5, episode: 14 },
    { season: 5, episode: 10 }
  );
  assert.equal(score, 0.0);
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

test('scenario: wrong episode scores 0.0 (hard gate rejects before ranking)', () => {
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
  // Wrong episode gets 0.0 in preference (hard gate should have rejected it)
  assert.equal(rankedWrong.components.episodeMatch, 0.0);
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

// =============================================================================
// Ranking Justification Tests
// =============================================================================

test('rankHit: attaches justification with score breakdown', () => {
  const result = rankHit({
    hash: HASH1,
    fileIndex: 0,
    releaseKey: `${HASH1}:0`,
    filename: 'Movie.2024.1080p.BluRay.x265.mkv',
    relevance: 0.85,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay', codec: 'x265' },
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.95 }],
    providerObservations: [{ provider: 'torbox', cached: true, state: 'cached', observedAt: 10_000, kind: 'authoritative', freshness: 'fresh', fresh: true }],
  });

  assert.ok(result.justification, 'justification must exist');
  assert.equal(result.justification.candidate.hash, HASH1);
  assert.equal(result.justification.candidate.fileIndex, 0);
  assert.equal(result.justification.candidate.releaseKey, `${HASH1}:0`);
  assert.equal(result.justification.candidate.filename, 'Movie.2024.1080p.BluRay.x265.mkv');
  assert.equal(result.justification.finalScore, result.score);
  assert.ok(result.justification.scoreBreakdown, 'scoreBreakdown must exist');
  assert.ok(typeof result.justification.scoreBreakdown.cacheScore === 'number');
  assert.ok(typeof result.justification.scoreBreakdown.qualityScore === 'number');
  assert.ok(typeof result.justification.scoreBreakdown.sourceScore === 'number');
  assert.ok(typeof result.justification.scoreBreakdown.metadataScore === 'number');
  assert.ok(typeof result.justification.scoreBreakdown.popularityScore === 'number');
  assert.ok(result.justification.weights, 'weights must exist');
});

test('rankHit: justification does not change score', () => {
  const hit = {
    hash: HASH1,
    fileIndex: null,
    filename: 'test.mkv',
    relevance: 0.7,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.8,
    mediaAssociations: [],
    providerObservations: [],
  };

  const result = rankHit(hit);
  // Score is computed from components, not affected by justification
  const expectedScore = (
    0.7 * 0.25 +  // relevance
    result.components.quality * 0.20 +
    0.8 * 0.20 +  // releaseConfidence
    0.5 * 0.15 +  // identityConfidence (neutral)
    0.5 * 0.10 +  // providerAvailability (neutral)
    0.5 * 0.10    // episodeMatch (neutral)
  );
  assert.ok(Math.abs(result.score - expectedScore) < 0.01, 'score unchanged by justification');
});

test('rankHits: assigns rank starting from 1', () => {
  const hits = [
    { hash: HASH1, filename: 'low.mkv', relevance: 0.3, releaseAttributes: { resolution: '480p' }, parserConfidence: 0.5 },
    { hash: HASH2, filename: 'high.mkv', relevance: 0.9, releaseAttributes: { resolution: '2160p' }, parserConfidence: 0.9 },
    { hash: HASH3, filename: 'mid.mkv', relevance: 0.6, releaseAttributes: { resolution: '1080p' }, parserConfidence: 0.8 },
  ];

  const ranked = rankHits(hits);

  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].justification.rank, 1);
  assert.equal(ranked[1].justification.rank, 2);
  assert.equal(ranked[2].justification.rank, 3);
});

test('rankHits: rank matches sorted position', () => {
  const hits = [
    { hash: HASH1, filename: 'a.mkv', relevance: 0.5, releaseAttributes: {}, parserConfidence: 0.5 },
    { hash: HASH2, filename: 'b.mkv', relevance: 0.9, releaseAttributes: { resolution: '2160p' }, parserConfidence: 0.9 },
    { hash: HASH3, filename: 'c.mkv', relevance: 0.7, releaseAttributes: { resolution: '1080p' }, parserConfidence: 0.7 },
  ];

  const ranked = rankHits(hits);

  // Highest score should be rank 1
  const maxScore = Math.max(...ranked.map(r => r.score));
  const topRanked = ranked.find(r => r.score === maxScore);
  assert.equal(topRanked.justification.rank, 1);
});

test('rankHit: justification scoreBreakdown maps to components', () => {
  const result = rankHit({
    hash: HASH1,
    fileIndex: null,
    filename: 'test.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.85,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.9 }],
    providerObservations: [{ provider: 'torbox', cached: true, state: 'cached', observedAt: 10_000, kind: 'authoritative', freshness: 'fresh', fresh: true }],
  });

  // scoreBreakdown maps to component scores (possibly renamed for clarity)
  assert.equal(result.justification.scoreBreakdown.cacheScore, result.components.providerAvailability);
  assert.equal(result.justification.scoreBreakdown.qualityScore, result.components.quality);
  assert.equal(result.justification.scoreBreakdown.sourceScore, result.components.releaseConfidence);
  assert.equal(result.justification.scoreBreakdown.metadataScore, result.components.identityConfidence);
  assert.equal(result.justification.scoreBreakdown.popularityScore, result.components.relevance);
});

test('rankHit: justification is immutable', () => {
  const result = rankHit({
    hash: HASH1,
    fileIndex: null,
    filename: 'test.mkv',
    relevance: 0.5,
    releaseAttributes: {},
    parserConfidence: 0.5,
    mediaAssociations: [],
    providerObservations: [],
  });

  // Should not be able to modify justification
  assert.throws(() => {
    result.justification.finalScore = 999;
  }, /Cannot assign to read only property|Cannot set property/);
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

// =============================================================================
// compareHitsDetailed — single source of truth
// =============================================================================

test('compareHitsDetailed: decisiveFactor at each precedence level', () => {
  const baseOpts = { fileIndex: null, mediaAssociations: [], providerObservations: [], sources: [] };

  // Score difference wins (via rankHit results)
  const aScore = rankHit({ hash: HASH1, ...baseOpts, filename: 'A.mkv', relevance: 0.9, releaseAttributes: { resolution: '2160p' }, parserConfidence: 0.9 }, {});
  const bScore = rankHit({ hash: HASH2, ...baseOpts, filename: 'B.mkv', relevance: 0.1, releaseAttributes: { resolution: '360p' }, parserConfidence: 0.1 }, {});
  let d = compareHitsDetailed(aScore, bScore);
  assert.equal(d.winner, 'a');
  assert.equal(d.decisiveFactor, 'score');
  assert.equal(d.order, -1);

  // Equal score → releaseConfidence decisive (artificial to isolate)
  const aConf = { score: 0.5, components: { relevance: 0.0, quality: 0.0, releaseConfidence: 0.9 }, hash: HASH1, fileIndex: null };
  const bConf = { score: 0.5, components: { relevance: 0.0, quality: 0.0, releaseConfidence: 0.1 }, hash: HASH2, fileIndex: null };
  d = compareHitsDetailed(aConf, bConf);
  assert.equal(d.winner, 'a');
  assert.equal(d.decisiveFactor, 'releaseConfidence');
  assert.equal(d.order, -1);
});

test('compareHitsDetailed: quality tie-break', () => {
  const baseOpts = { fileIndex: null, mediaAssociations: [], providerObservations: [], sources: [] };
  // Equal relevance and releaseConfidence, different quality
  const a = rankHit({ ...baseOpts, hash: HASH1, filename: 'A.mkv', relevance: 0.5, releaseAttributes: { resolution: '2160p', sourceType: 'BluRay' }, parserConfidence: 0.5 }, {});
  const b = rankHit({ ...baseOpts, hash: HASH2, filename: 'B.mkv', relevance: 0.5, releaseAttributes: { resolution: '360p', sourceType: 'DVD' }, parserConfidence: 0.5 }, {});
  const d = compareHitsDetailed(a, b);
  // Scores will differ because quality differs; but if score ties, quality should decide
  // Let's check the direct contract: if score ties, quality is decisive
  // We'll construct an artificial pair to test quality specifically
  const artA = { score: 0.5, components: { relevance: 0.5, quality: 0.9, releaseConfidence: 0.5 }, hash: HASH1, fileIndex: null };
  const artB = { score: 0.5, components: { relevance: 0.5, quality: 0.1, releaseConfidence: 0.5 }, hash: HASH2, fileIndex: null };
  const dd = compareHitsDetailed(artA, artB);
  assert.equal(dd.decisiveFactor, 'quality');
  assert.equal(dd.winner, 'a');
  assert.equal(dd.order, -1);
});

test('compareHitsDetailed: relevance tie-break', () => {
  const artA = { score: 0.5, components: { relevance: 0.9, quality: 0.5, releaseConfidence: 0.5 }, hash: HASH1, fileIndex: null };
  const artB = { score: 0.5, components: { relevance: 0.1, quality: 0.5, releaseConfidence: 0.5 }, hash: HASH2, fileIndex: null };
  const d = compareHitsDetailed(artA, artB);
  assert.equal(d.decisiveFactor, 'relevance');
  assert.equal(d.winner, 'a');
  assert.equal(d.order, -1);
});

test('compareHitsDetailed: hash tie-break (lexicographic)', () => {
  const artA = { score: 0.5, components: { relevance: 0.5, quality: 0.5, releaseConfidence: 0.5 }, hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fileIndex: null };
  const artB = { score: 0.5, components: { relevance: 0.5, quality: 0.5, releaseConfidence: 0.5 }, hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fileIndex: null };
  const d = compareHitsDetailed(artA, artB);
  assert.equal(d.decisiveFactor, 'hash');
  assert.equal(d.winner, 'a');
  assert.equal(d.order, -1);
});

test('compareHitsDetailed: fileIndex tie-break — null sorts after 0', () => {
  const common = { score: 0.5, components: { relevance: 0.5, quality: 0.5, releaseConfidence: 0.5 }, hash: HASH1 };
  const withZero = { ...common, fileIndex: 0 };
  const withNull = { ...common, fileIndex: null };
  // Lower fileIndex (0) wins
  const d = compareHitsDetailed(withZero, withNull);
  assert.equal(d.decisiveFactor, 'fileIndex');
  assert.equal(d.winner, 'a');
  assert.equal(d.order, -1);
  // Reverse: null vs 0 → 0 wins (b wins)
  const d2 = compareHitsDetailed(withNull, withZero);
  assert.equal(d2.decisiveFactor, 'fileIndex');
  assert.equal(d2.winner, 'b');
  assert.equal(d2.order, 1);
});

test('compareHitsDetailed: exact equality returns order 0', () => {
  const art = { score: 0.5, components: { relevance: 0.5, quality: 0.5, releaseConfidence: 0.5 }, hash: HASH1, fileIndex: 0 };
  const d = compareHitsDetailed(art, { ...art });
  assert.equal(d.order, 0);
  assert.equal(d.winner, 'tie');
  assert.equal(d.decisiveFactor, null);
});

test('compareHits: thin wrapper returns .order', () => {
  const artA = { score: 0.8, components: { relevance: 0.5, quality: 0.5, releaseConfidence: 0.5 }, hash: HASH1, fileIndex: null };
  const artB = { score: 0.2, components: { relevance: 0.5, quality: 0.5, releaseConfidence: 0.5 }, hash: HASH2, fileIndex: null };
  assert.equal(compareHits(artA, artB), compareHitsDetailed(artA, artB).order);
});

test('explainOrder: derives from compareHitsDetailed', () => {
  const artA = { score: 0.5, components: { relevance: 0.5, quality: 0.5, releaseConfidence: 0.5 }, hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fileIndex: null };
  const artB = { score: 0.5, components: { relevance: 0.5, quality: 0.5, releaseConfidence: 0.5 }, hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fileIndex: null };
  const detailed = compareHitsDetailed(artA, artB);
  const order = explainOrder(artA, artB);
  assert.equal(order.decisiveFactor, detailed.decisiveFactor);
  assert.equal(order.winner, detailed.winner);
  assert.equal(order.reason, detailed.reason);
});

test('rankHits ordering matches compareHitsDetailed per precedence level', () => {
  const baseOpts = { fileIndex: null, mediaAssociations: [], providerObservations: [], sources: [] };
  const hits = [
    { ...baseOpts, hash: HASH3, filename: 'low.mkv', relevance: 0.1, releaseAttributes: { resolution: '360p' }, parserConfidence: 0.1 },
    { ...baseOpts, hash: HASH1, filename: 'high.mkv', relevance: 0.9, releaseAttributes: { resolution: '2160p' }, parserConfidence: 0.9 },
    { ...baseOpts, hash: HASH2, filename: 'mid.mkv', relevance: 0.5, releaseAttributes: { resolution: '1080p' }, parserConfidence: 0.5 },
  ];
  const ranked = rankHits(hits, {});
  // Verify each adjacent pair is ordered per the detailed contract
  for (let i = 0; i < ranked.length - 1; i++) {
    const d = compareHitsDetailed(ranked[i], ranked[i + 1]);
    assert.equal(d.winner, 'a', `rankHits[${i}] must beat rankHits[${i+1}] per detailed comparator`);
    assert.equal(d.order, -1, `rankHits[${i}] must sort before rankHits[${i+1}]`);
  }
});

// =============================================================================
// compareRanked contract — ranked results only
// =============================================================================

test('compareRanked: accepts ranked results (not explainRank output)', () => {
  const baseOpts = { fileIndex: null, mediaAssociations: [], providerObservations: [], sources: [] };
  const a = rankHit({ ...baseOpts, hash: HASH1, filename: 'A.mkv', relevance: 0.9, releaseAttributes: { resolution: '2160p' }, parserConfidence: 0.9 }, {});
  const b = rankHit({ ...baseOpts, hash: HASH2, filename: 'B.mkv', relevance: 0.1, releaseAttributes: { resolution: '360p' }, parserConfidence: 0.1 }, {});
  const cmp = compareRanked(a, b);
  assert.equal(cmp.winner, 'a');
  assert.equal(cmp.decisiveFactor, 'score');
});

test('compareRanked: preserves final hash/fileIndex tie-break identity', () => {
  // The critical contract test: compareRanked must NOT silently lose final
  // tie-break identity when all components tie. It must see hash + fileIndex.
  const common = { score: 0.5, components: { relevance: 0.5, quality: 0.5, releaseConfidence: 0.5 } };
  const a = { ...common, hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fileIndex: 0 };
  const b = { ...common, hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fileIndex: 0 };
  const cmp = compareRanked(a, b);
  assert.equal(cmp.winner, 'a', 'hash tie-break must be decisive');
  assert.equal(cmp.decisiveFactor, 'hash');
});

test('compareRanked: returns null for null inputs', () => {
  assert.equal(compareRanked(null, {}), null);
  assert.equal(compareRanked({}, null), null);
});

test('compareRanked: explainRank output is not contractually valid (drops hash/fileIndex)', () => {
  // Proves why compareRanked requires ranked results: explainRank drops hash/fileIndex
  const baseOpts = { fileIndex: null, mediaAssociations: [], providerObservations: [], sources: [] };
  const a = rankHit({ ...baseOpts, hash: HASH1, filename: 'A.mkv', relevance: 0.9, releaseAttributes: { resolution: '2160p' }, parserConfidence: 0.9 }, {});
  const b = rankHit({ ...baseOpts, hash: HASH2, filename: 'B.mkv', relevance: 0.9, releaseAttributes: { resolution: '2160p' }, parserConfidence: 0.9 }, {});
  // If we passed explainRank output, the hashes would be undefined and the
  // comparator would tie instead of breaking on hash.
  const expA = explainRank(a);
  const expB = explainRank(b);
  // confirm that hash is dropped by explainRank
  assert.equal(expA.hash, undefined, 'explainRank must drop hash');
  // If you called compareRanked(expA, expB) you'd get a false tie
  // because hash/fileIndex are missing. That's the documented reason
  // compareRanked requires ranked results.
});

// =============================================================================
// Semantic Confidence Tests — Source-Agnostic Equivalence
// =============================================================================

import {
  relevanceFromIdentity,
  identityConfidenceFromLiveScope,
  providerAvailabilityFromLive,
} from '../src/lib/discovery/ranking.js';

test('relevanceFromIdentity: corpus text relevance passes through unchanged', () => {
  // Corpus candidates with BM25 relevance should use it directly
  assert.equal(relevanceFromIdentity(0.9, null, null), 0.9);
  assert.equal(relevanceFromIdentity(0.5, null, null), 0.5);
  assert.equal(relevanceFromIdentity(1.0, null, null), 1.0);
});

test('relevanceFromIdentity: live candidate scoped to queried media gets identity-derived relevance', () => {
  // Live candidate scoped to the queried media should get moderate relevance
  // (not neutral 0.5, not full 1.0)
  const score = relevanceFromIdentity(0, 'tt123', 'tt123');
  assert.ok(score > 0.5, 'Live scope match should exceed neutral');
  assert.ok(score < 1.0, 'Live scope match should be less than exact text match');
  assert.equal(score, 0.7);
});

test('relevanceFromIdentity: live candidate not scoped to queried media gets neutral', () => {
  // Live candidate scoped to different media should be neutral
  assert.equal(relevanceFromIdentity(0, 'tt456', 'tt123'), 0.5);
});

test('identityConfidenceFromLiveScope: uses associations when available', () => {
  // When associations exist, use them (corpus path)
  const score = identityConfidenceFromLiveScope('tt123', [{ mediaId: 'tt123', confidence: 0.9 }], 'tt123');
  assert.equal(score, 0.9);
});

test('identityConfidenceFromLiveScope: live scope match provides moderate confidence', () => {
  // When no associations but live scope matches, provide moderate confidence
  const score = identityConfidenceFromLiveScope('tt123', [], 'tt123');
  assert.ok(score > 0.5, 'Live scope match should exceed neutral');
  assert.equal(score, 0.7);
});

test('identityConfidenceFromLiveScope: no scope match returns neutral', () => {
  // When no associations and no scope match, return neutral
  assert.equal(identityConfidenceFromLiveScope(null, [], 'tt123'), 0.5);
  assert.equal(identityConfidenceFromLiveScope('tt456', [], 'tt123'), 0.5);
});

test('providerAvailabilityFromLive: uses observations when available', () => {
  // When observations exist, use them (corpus path)
  const score = providerAvailabilityFromLive([{ provider: 'torbox', cached: true }], false, null);
  assert.equal(score, 1.0);
});

test('providerAvailabilityFromLive: live discovery provides availability evidence', () => {
  // Live discovery itself is availability evidence
  const score = providerAvailabilityFromLive([], true, null);
  assert.ok(score > 0.5, 'Live discovery should exceed neutral');
  assert.equal(score, 0.6);
});

test('providerAvailabilityFromLive: live discovery with cache hint scores higher', () => {
  // Live discovery with cache hints should score higher
  const score = providerAvailabilityFromLive([], true, { torbox: { cached: true } });
  assert.ok(score >= 0.6, 'Cache hint should increase score');
  assert.equal(score, 0.8);
});

test('providerAvailabilityFromLive: no evidence returns neutral', () => {
  // No observations and no live discovery = neutral
  assert.equal(providerAvailabilityFromLive([], false, null), 0.5);
});

// =============================================================================
// Source-Agnostic Equivalence Tests
// =============================================================================

test('EQUIVALENCE: same evidence produces same score regardless of source', () => {
  // A corpus candidate and live candidate with identical evidence should score equally
  const baseEvidence = {
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x265.mkv',
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay', codec: 'x265' },
    parserConfidence: 0.85,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.9 }],
    providerObservations: [{ provider: 'torbox', cached: true }],
  };

  // Corpus candidate with text relevance
  const corpusResult = rankHit({
    ...baseEvidence,
    hash: HASH1,
    relevance: 0.85,
    hasLiveDiscovery: false,
    liveProviderHints: null,
  }, {}, 'tt123');

  // Live candidate with identity-derived relevance (same effective relevance)
  const liveResult = rankHit({
    ...baseEvidence,
    hash: HASH2,
    relevance: 0, // Will be derived from identity
    selectedMediaId: 'tt123',
    hasLiveDiscovery: true,
    liveProviderHints: { torbox: { cached: true } },
  }, {}, 'tt123');

  // Both should have identical component scores
  assert.equal(corpusResult.components.quality, liveResult.components.quality, 'Quality should be equal');
  assert.equal(corpusResult.components.releaseConfidence, liveResult.components.releaseConfidence, 'ReleaseConfidence should be equal');
  assert.equal(corpusResult.components.identityConfidence, liveResult.components.identityConfidence, 'IdentityConfidence should be equal');
  assert.equal(corpusResult.components.providerAvailability, liveResult.components.providerAvailability, 'ProviderAvailability should be equal');
});

test('EQUIVALENCE: quality is purely attribute-based, source-independent', () => {
  // Quality should be identical for identical attributes regardless of source
  const attrs = { resolution: '2160p', sourceType: 'Remux', codec: 'x265', hdr: true };

  const corpusResult = rankHit({
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.8,
    releaseAttributes: attrs,
    parserConfidence: 0.9,
    hasLiveDiscovery: false,
  }, {});

  const liveResult = rankHit({
    hash: HASH2,
    filename: 'test.mkv',
    relevance: 0.8,
    releaseAttributes: attrs,
    parserConfidence: 0.9,
    hasLiveDiscovery: true,
  }, {});

  assert.equal(corpusResult.components.quality, liveResult.components.quality);
});

test('EQUIVALENCE: releaseConfidence is purely confidence-based, source-independent', () => {
  // ReleaseConfidence should be identical for identical parser confidence
  const corpusResult = rankHit({
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.8,
    parserConfidence: 0.75,
    hasLiveDiscovery: false,
  }, {});

  const liveResult = rankHit({
    hash: HASH2,
    filename: 'test.mkv',
    relevance: 0.8,
    parserConfidence: 0.75,
    hasLiveDiscovery: true,
  }, {});

  assert.equal(corpusResult.components.releaseConfidence, liveResult.components.releaseConfidence);
});

test('EQUIVALENCE: identityConfidence from associations is source-independent', () => {
  // When both have same associations, identityConfidence should match
  const associations = [{ mediaId: 'tt123', confidence: 0.85 }];

  const corpusResult = rankHit({
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.8,
    mediaAssociations: associations,
    hasLiveDiscovery: false,
  }, {}, 'tt123');

  const liveResult = rankHit({
    hash: HASH2,
    filename: 'test.mkv',
    relevance: 0.8,
    mediaAssociations: associations,
    hasLiveDiscovery: true,
  }, {}, 'tt123');

  assert.equal(corpusResult.components.identityConfidence, liveResult.components.identityConfidence);
});

test('EQUIVALENCE: providerAvailability from observations is source-independent', () => {
  // When both have same observations, providerAvailability should match
  const observations = [{ provider: 'torbox', cached: true }];

  const corpusResult = rankHit({
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.8,
    providerObservations: observations,
    hasLiveDiscovery: false,
  }, {});

  const liveResult = rankHit({
    hash: HASH2,
    filename: 'test.mkv',
    relevance: 0.8,
    providerObservations: observations,
    hasLiveDiscovery: true,
  }, {});

  assert.equal(corpusResult.components.providerAvailability, liveResult.components.providerAvailability);
});

test('EQUIVALENCE: live scope match provides identity-derived relevance', () => {
  // Live candidate scoped to queried media should get identity-derived relevance
  const liveResult = rankHit({
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0, // No text relevance
    selectedMediaId: 'tt123',
    hasLiveDiscovery: true,
  }, {}, 'tt123');

  // Should get identity-derived relevance (0.7) not neutral (0.5)
  assert.equal(liveResult.components.relevance, 0.7);
});

test('EQUIVALENCE: live discovery provides availability evidence', () => {
  // Live candidate without observations should still get availability evidence
  const liveResult = rankHit({
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.8,
    providerObservations: [],
    hasLiveDiscovery: true,
    liveProviderHints: null,
  }, {});

  // Should get live discovery availability (0.6) not neutral (0.5)
  assert.equal(liveResult.components.providerAvailability, 0.6);
});

test('EQUIVALENCE: live scope match provides identity confidence', () => {
  // Live candidate scoped to queried media should get identity confidence
  const liveResult = rankHit({
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.8,
    mediaAssociations: [],
    selectedMediaId: 'tt123',
    hasLiveDiscovery: true,
  }, {}, 'tt123');

  // Should get live scope identity confidence (0.7) not neutral (0.5)
  assert.equal(liveResult.components.identityConfidence, 0.7);
});

// =============================================================================
// Identity Eligibility Diagnostics — Measurement Only, No Filtering
// =============================================================================

test('diagnoseIdentityEligibility: returns null for non-corpus candidates', () => {
  const liveHit = {
    hash: HASH1,
    filename: 'test.mkv',
    sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    mediaAssociations: [],
  };
  assert.equal(diagnoseIdentityEligibility(liveHit, {}, 'tt123'), null);
});

test('diagnoseIdentityEligibility: corpus with matching association reports identityMatch=true', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.720p.mkv',
    releaseKey: 'abc123',
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };
  const diag = diagnoseIdentityEligibility(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(diag.identityMatch, true);
  assert.equal(diag.rejectionReason, null);
  assert.equal(diag.seasonEpisodeMatch, 'match');
  assert.equal(diag.targetMediaId, 'tt0364845');
});

test('diagnoseIdentityEligibility: corpus with no associations reports text-only', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.720p.mkv',
    releaseKey: 'abc123',
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [],
  };
  const diag = diagnoseIdentityEligibility(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(diag.identityMatch, false);
  assert.ok(diag.rejectionReason.includes('no_identity_evidence'));
  assert.equal(diag.seasonEpisodeMatch, 'match');
});

test('diagnoseIdentityEligibility: corpus with wrong media association reports mismatch', () => {
  const hit = {
    hash: HASH1,
    filename: 'Other.Show.S01E01.720p.mkv',
    releaseKey: 'xyz789',
    releaseAttributes: { title: 'Other Show', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt9999999', confidence: 0.8 }],
  };
  const diag = diagnoseIdentityEligibility(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(diag.identityMatch, false);
  assert.ok(diag.rejectionReason.includes('identity_mismatch'));
  assert.ok(diag.rejectionReason.includes('tt9999999'));
});

test('diagnoseIdentityEligibility: wrong season detected', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S02E01.720p.mkv',
    releaseKey: 'abc123',
    releaseAttributes: { title: 'NCIS', season: 2, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };
  const diag = diagnoseIdentityEligibility(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(diag.identityMatch, true);
  assert.ok(diag.seasonEpisodeMatch.includes('wrong_season'));
});

test('diagnoseIdentityEligibility: wrong episode detected', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E05.720p.mkv',
    releaseKey: 'abc123',
    releaseAttributes: { title: 'NCIS', season: 1, episode: 5 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };
  const diag = diagnoseIdentityEligibility(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(diag.identityMatch, true);
  assert.ok(diag.seasonEpisodeMatch.includes('wrong_episode'));
});

test('countIdentityEligibility: aggregates counts correctly', () => {
  const hits = [
    // Identity match
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
    // No identity evidence
    {
      hash: HASH2,
      filename: 'NCIS.S01E02.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 2 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    // Wrong media
    {
      hash: HASH3,
      filename: 'Other.S01E01.mkv',
      releaseAttributes: { title: 'Other', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt9999999', confidence: 0.8 }],
    },
  ];

  const counts = countIdentityEligibility(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(counts.corpusRetrieved, 3);
  assert.equal(counts.identityMatched, 1);
  assert.equal(counts.identityRejected, 2);
  assert.equal(counts.textOnlyMatches, 1);
  assert.equal(counts.ranked, 3);
});

test('countIdentityEligibility: filters out non-corpus candidates', () => {
  const hits = [
    // Corpus candidate
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
    // Live candidate (should be excluded from counts)
    {
      hash: HASH2,
      filename: 'Live.S01E01.mkv',
      releaseAttributes: { title: 'Live', season: 1, episode: 1 },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      mediaAssociations: [],
      selectedMediaId: 'tt0364845',
      hasLiveDiscovery: true,
    },
  ];

  const counts = countIdentityEligibility(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(counts.corpusRetrieved, 1);
  assert.equal(counts.identityMatched, 1);
});

test('countIdentityEligibility: season/episode failures counted', () => {
  const hits = [
    // Wrong season
    {
      hash: HASH1,
      filename: 'NCIS.S02E01.mkv',
      releaseAttributes: { title: 'NCIS', season: 2, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
    // Wrong episode
    {
      hash: HASH2,
      filename: 'NCIS.S01E05.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 5 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
    // Match
    {
      hash: HASH3,
      filename: 'NCIS.S01E01.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
  ];

  const counts = countIdentityEligibility(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(counts.seasonEpisodeFailures, 2);
  assert.equal(counts.identityMatched, 3); // All have correct media association
});

// =============================================================================
// Identity Tier Classification Tests
// =============================================================================

test('classifyIdentityTier: explicit media association match is Verified', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.mkv',
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Verified');
  assert.ok(result.IdentityConfidence >= 0.9);
  assert.ok(result.IdentityEvidence.includes('media-association-match'));
  assert.equal(result.RejectionReason, null);
});

test('classifyIdentityTier: identity mismatch is Rejected', () => {
  const hit = {
    hash: HASH1,
    filename: 'Other.Show.S01E01.mkv',
    releaseAttributes: { title: 'Other Show', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt9999999', confidence: 0.8 }],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Rejected');
  assert.ok(result.IdentityConfidence <= 0.2);
  assert.ok(result.RejectionReason.includes('identity_mismatch'));
});

test('classifyIdentityTier: no target media ID is Rejected', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.mkv',
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, null);
  assert.equal(result.IdentityTier, 'Rejected');
  assert.ok(result.RejectionReason.includes('no_target_media_id'));
});

test('classifyIdentityTier: strong title match without media association is Probable', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.720p.mkv',
    relevance: 0.85,
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Probable');
  assert.ok(result.IdentityConfidence >= 0.5);
  assert.ok(result.IdentityEvidence.includes('strong-title-match'));
});

test('classifyIdentityTier: partial metadata without title match is Probable', () => {
  const hit = {
    hash: HASH1,
    filename: 'some_release.mkv',
    relevance: 0.3,
    releaseAttributes: { title: null, season: 1, episode: null },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.5 }],
    mediaAssociations: [],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Probable');
  assert.ok(result.IdentityEvidence.includes('parsed-season'));
});

test('classifyIdentityTier: text-only match is TextOnly', () => {
  const hit = {
    hash: HASH1,
    filename: 'random_release.mkv',
    relevance: 0.1,
    releaseAttributes: {},
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.3 }],
    mediaAssociations: [],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'TextOnly');
  assert.ok(result.IdentityEvidence.includes('text-similarity-only'));
});

test('classifyIdentityTier: live candidate scoped to media is ProviderMatched', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.WEB-DL.mkv',
    sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    selectedMediaId: 'tt0364845',
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'ProviderMatched');
  assert.ok(result.IdentityEvidence.includes('provider-scoped-to-media'));
});

test('classifyIdentityTier: live candidate not scoped is Probable', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.WEB-DL.mkv',
    sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Probable');
  assert.ok(result.IdentityEvidence.includes('live-discovery'));
});

test('classifyIdentityTier: season/episode match boosts confidence', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.mkv',
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Verified');
  assert.equal(result.IdentityConfidence, 1.0);
  assert.ok(result.IdentityEvidence.includes('season-episode-match'));
});

test('classifyIdentityTier: wrong season reduces confidence', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S02E01.mkv',
    releaseAttributes: { title: 'NCIS', season: 2, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Verified');
  assert.ok(result.IdentityConfidence < 0.9);
  assert.ok(result.IdentityEvidence.includes('wrong-season'));
});

test('evaluateIdentityTiers: returns array of evaluations', () => {
  const hits = [
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
    {
      hash: HASH2,
      filename: 'Other.S01E01.mkv',
      releaseAttributes: { title: 'Other', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt9999999', confidence: 0.8 }],
    },
  ];
  const results = evaluateIdentityTiers(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(results.length, 2);
  assert.equal(results[0].IdentityTier, 'Verified');
  assert.equal(results[1].IdentityTier, 'Rejected');
});

test('aggregateIdentityTiers: counts by tier', () => {
  const hits = [
    // Verified
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
    // Probable (strong title match)
    {
      hash: HASH2,
      filename: 'NCIS.S01E02.mkv',
      relevance: 0.8,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 2 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    // Rejected (identity mismatch)
    {
      hash: HASH3,
      filename: 'Other.S01E01.mkv',
      releaseAttributes: { title: 'Other', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt9999999', confidence: 0.8 }],
    },
    // TextOnly
    {
      hash: 'dddddddddddddddddddddddddddddddddddddddd',
      filename: 'random.mkv',
      relevance: 0.1,
      releaseAttributes: {},
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.3 }],
      mediaAssociations: [],
    },
    // Live (Probable)
    {
      hash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      filename: 'Live.S01E01.mkv',
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    },
  ];

  const counts = aggregateIdentityTiers(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(counts.CorpusRetrieved, 4);
  assert.equal(counts.LiveRetrieved, 1);
  assert.equal(counts.VerifiedCount, 1);
  assert.equal(counts.ProbableCount, 2); // strong title match + live
  assert.equal(counts.TextOnlyCount, 1);
  assert.equal(counts.RejectedCount, 1);
  assert.equal(counts.IdentityMismatches, 1);
});

test('aggregateIdentityTiers: season/episode failures counted', () => {
  const hits = [
    {
      hash: HASH1,
      filename: 'NCIS.S02E01.mkv',
      releaseAttributes: { title: 'NCIS', season: 2, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
    {
      hash: HASH2,
      filename: 'NCIS.S01E05.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 5 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
  ];

  const counts = aggregateIdentityTiers(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(counts.SeasonEpisodeFailures, 2);
});

test('classifyIdentityTier: does not mutate input', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.mkv',
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };

  const original = JSON.parse(JSON.stringify(hit));
  classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');

  assert.deepEqual(hit.releaseAttributes, original.releaseAttributes);
  assert.deepEqual(hit.mediaAssociations, original.mediaAssociations);
});

// =============================================================================
// Shadow Ranking Comparison Tests
// =============================================================================

test('shadowRankComparison: returns comparison structure', () => {
  const candidates = [
    // ProviderMatched (live-scoped)
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    // Probable (corpus, strong title match)
    {
      hash: HASH2,
      filename: 'NCIS.S01E02.mkv',
      relevance: 0.8,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 2 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    // Probable (corpus, no media association)
    {
      hash: HASH3,
      filename: 'NCIS.S01E03.mkv',
      relevance: 0.7,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 3 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
  ];

  const result = shadowRankComparison(candidates, { season: 1, episode: 1 }, 'tt0364845', 50);
  assert.ok(result.CurrentTopSources);
  assert.ok(result.VerifiedOnlyTopSources);
  assert.ok(result.TieredTopSources);
  assert.ok(result.CurrentTopScoreRange);
  // VerifiedOnlyTopScoreRange may be null if no Verified candidates exist
  assert.ok(typeof result.CandidatesExcludedByVerifiedFilter === 'number');
  assert.ok(Array.isArray(result.CurrentTop10));
  assert.ok(Array.isArray(result.VerifiedOnlyTop10));
  assert.ok(Array.isArray(result.TieredTop10));
});

test('shadowRankComparison: VerifiedOnly excludes non-verified candidates', () => {
  const candidates = [
    // ProviderMatched (live-scoped) - NOT Verified
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    // Probable (corpus, no media association)
    {
      hash: HASH2,
      filename: 'NCIS.S01E02.mkv',
      relevance: 0.8,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 2 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
  ];

  const result = shadowRankComparison(candidates, { season: 1, episode: 1 }, 'tt0364845', 50);
  // Both are excluded from VerifiedOnly (ProviderMatched is not Verified)
  assert.equal(result.CandidatesExcludedByVerifiedFilter, 2);
  assert.equal(result.VerifiedOnlyTopSources.corpus, 0);
  assert.equal(result.VerifiedOnlyTopSources.live, 0);
});

test('shadowRankComparison: Tiered mode includes provider-matched first then probable', () => {
  const candidates = [
    // ProviderMatched (live-scoped)
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    // Probable (corpus, no media association)
    {
      hash: HASH2,
      filename: 'NCIS.S01E02.mkv',
      relevance: 0.8,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 2 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
  ];

  const result = shadowRankComparison(candidates, { season: 1, episode: 1 }, 'tt0364845', 50);
  // Tiered should have both candidates (ProviderMatched + Probable)
  assert.equal(result.TieredTopSources.corpus + result.TieredTopSources.live, 2);
});

test('shadowRankComparison: Current mode includes all candidates', () => {
  const candidates = [
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    {
      hash: HASH2,
      filename: 'NCIS.S01E02.mkv',
      relevance: 0.8,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 2 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    {
      hash: HASH3,
      filename: 'NCIS.S01E03.mkv',
      relevance: 0.7,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 3 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
  ];

  const result = shadowRankComparison(candidates, { season: 1, episode: 1 }, 'tt0364845', 50);
  assert.equal(result.CurrentTopSources.corpus + result.CurrentTopSources.live, 3);
});

test('shadowRankComparison: does not mutate input candidates', () => {
  const candidates = [
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
  ];

  const original = JSON.parse(JSON.stringify(candidates));
  shadowRankComparison(candidates, { season: 1, episode: 1 }, 'tt0364845', 50);

  assert.deepEqual(candidates, original);
});

test('shadowRankComparison: empty candidates returns empty results', () => {
  const result = shadowRankComparison([], { season: 1, episode: 1 }, 'tt0364845', 50);
  assert.equal(result.CurrentTopSources.corpus, 0);
  assert.equal(result.CurrentTopSources.live, 0);
  assert.equal(result.CandidatesExcludedByVerifiedFilter, 0);
  assert.equal(result.CurrentTop10.length, 0);
});

// =============================================================================
// Tiered Ranking Precedence Tests
// =============================================================================

test('rankHitsTiered: provider-matched candidates outrank probable regardless of source', () => {
  const hits = [
    // Probable (corpus, high relevance score)
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.2160p.mkv',
      relevance: 0.95,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '2160p', sourceType: 'BluRay' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    // ProviderMatched (live-scoped, lower relevance)
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      relevance: 0.7,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '1080p', sourceType: 'WEB-DL' },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  // ProviderMatched should come first even though it has lower relevance score
  assert.equal(ranked[0].hash, HASH2); // ProviderMatched wins
  assert.equal(ranked[1].hash, HASH1); // Probable second
  assert.equal(tierMeta.TierCounts.ProviderMatched, 1);
  assert.equal(tierMeta.TierCounts.Probable, 1);
});

test('rankHitsTiered: verified corpus candidate outranks probable live candidate', () => {
  const hits = [
    // Probable (live, no scope)
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      relevance: 0.7,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '1080p', sourceType: 'WEB-DL' },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    },
    // Verified (corpus, with media association)
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.720p.mkv',
      relevance: 0.5,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '720p', sourceType: 'WEBRip' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  // Verified corpus should outrank probable live
  assert.equal(ranked[0].hash, HASH2); // Verified wins
  assert.equal(ranked[1].hash, HASH1); // Probable second
});

test('rankHitsTiered: intra-tier ranking preserves existing score behavior', () => {
  const hits = [
    // Two probable candidates — higher score should win within tier
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.2160p.mkv',
      relevance: 0.95,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '2160p', sourceType: 'BluRay' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.720p.mkv',
      relevance: 0.5,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '720p', sourceType: 'WEBRip' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
  ];

  const { ranked } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  // Higher score should come first within the same tier
  assert.equal(ranked[0].hash, HASH1);
  assert.equal(ranked[1].hash, HASH2);
});

test('rankHitsTiered: three-tier ordering provider-matched-probable-textonly', () => {
  const hits = [
    // TextOnly (lowest relevance, no metadata)
    {
      hash: HASH3,
      filename: 'random_release.mkv',
      relevance: 0.1,
      releaseAttributes: {},
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.3 }],
      mediaAssociations: [],
    },
    // Probable (strong title match)
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.720p.mkv',
      relevance: 0.85,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '720p' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    // ProviderMatched (live-scoped)
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      relevance: 0.7,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(ranked[0].hash, HASH1); // ProviderMatched
  assert.equal(ranked[1].hash, HASH2); // Probable
  assert.equal(ranked[2].hash, HASH3); // TextOnly
  assert.equal(tierMeta.TierCounts.ProviderMatched, 1);
  assert.equal(tierMeta.TierCounts.Probable, 1);
  assert.equal(tierMeta.TierCounts.TextOnly, 1);
});

test('rankHitsTiered: fallback when no verified candidates exist', () => {
  const hits = [
    // Only probable candidates
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.2160p.mkv',
      relevance: 0.95,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '2160p' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.720p.mkv',
      relevance: 0.5,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '720p' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(ranked.length, 2);
  assert.equal(tierMeta.TierCounts.Verified, 0);
  assert.equal(tierMeta.TierCounts.Probable, 2);
  // Fallback: probable candidates still ranked
  assert.equal(ranked[0].hash, HASH1);
  assert.equal(ranked[1].hash, HASH2);
});

test('rankHitsTiered: all candidates preserved (no deletions)', () => {
  const hits = [
    { hash: HASH1, filename: 'a.mkv', relevance: 0.9, releaseAttributes: {}, sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }], mediaAssociations: [] },
    { hash: HASH2, filename: 'b.mkv', relevance: 0.8, releaseAttributes: {}, sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }], mediaAssociations: [] },
    { hash: HASH3, filename: 'c.mkv', relevance: 0.7, releaseAttributes: {}, sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }], mediaAssociations: [] },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(ranked.length, 3); // All candidates preserved
  const totalInTiers = tierMeta.TierCounts.Verified + tierMeta.TierCounts.ProviderMatched + tierMeta.TierCounts.Probable + tierMeta.TierCounts.TextOnly + tierMeta.TierCounts.Rejected;
  assert.equal(totalInTiers, 3);
});

test('rankHitsTiered: tier metadata structure', () => {
  const hits = [
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
  ];

  const { tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(tierMeta.TieredRankingApplied, true);
  assert.ok(tierMeta.TierCounts);
  assert.ok(tierMeta.TopResultsByTier);
  assert.ok(Array.isArray(tierMeta.TopResultsByTier.Verified));
  assert.ok(Array.isArray(tierMeta.TopResultsByTier.ProviderMatched));
  assert.ok(Array.isArray(tierMeta.TopResultsByTier.Probable));
  assert.ok(Array.isArray(tierMeta.TopResultsByTier.TextOnly));
});

test('rankHitsTiered: does not mutate input hits', () => {
  const hits = [
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.mkv',
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
  ];

  const original = JSON.parse(JSON.stringify(hits));
  rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');

  assert.deepEqual(hits, original);
});

// =============================================================================
// Refined Identity Tier Tests (Verified vs ProviderMatched)
// =============================================================================

test('classifyIdentityTier: live-scoped is ProviderMatched, not Verified', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.WEB-DL.mkv',
    sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    selectedMediaId: 'tt0364845',
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'ProviderMatched');
  assert.ok(result.IdentityEvidence.includes('provider-scoped-to-media'));
});

test('classifyIdentityTier: corpus with media association is Verified', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.mkv',
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };
  const result = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Verified');
  assert.ok(result.IdentityEvidence.includes('media-association-match'));
});

test('rankHitsTiered: verified corpus outranks provider-matched live', () => {
  const hits = [
    // ProviderMatched (live-scoped, lower relevance)
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      relevance: 0.7,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '1080p', sourceType: 'WEB-DL' },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    // Verified (corpus, with media association)
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.720p.mkv',
      relevance: 0.5,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '720p', sourceType: 'WEBRip' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  // Verified corpus should outrank provider-matched live
  assert.equal(ranked[0].hash, HASH2); // Verified wins
  assert.equal(ranked[1].hash, HASH1); // ProviderMatched second
  assert.equal(tierMeta.TierCounts.Verified, 1);
  assert.equal(tierMeta.TierCounts.ProviderMatched, 1);
});

test('rankHitsTiered: provider-matched outranks probable', () => {
  const hits = [
    // Probable (corpus, strong title match)
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.2160p.mkv',
      relevance: 0.95,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '2160p', sourceType: 'BluRay' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    // ProviderMatched (live-scoped)
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      relevance: 0.7,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  // ProviderMatched should outrank Probable
  assert.equal(ranked[0].hash, HASH2); // ProviderMatched wins
  assert.equal(ranked[1].hash, HASH1); // Probable second
  assert.equal(tierMeta.TierCounts.ProviderMatched, 1);
  assert.equal(tierMeta.TierCounts.Probable, 1);
});

test('rankHitsTiered: four-tier ordering verified-providermatched-probable-textonly', () => {
  const hits = [
    // TextOnly (lowest relevance, no metadata)
    {
      hash: HASH4,
      filename: 'random_release.mkv',
      relevance: 0.1,
      releaseAttributes: {},
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.3 }],
      mediaAssociations: [],
    },
    // Probable (strong title match)
    {
      hash: HASH3,
      filename: 'NCIS.S01E01.720p.mkv',
      relevance: 0.85,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '720p' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    // ProviderMatched (live-scoped)
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      relevance: 0.7,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    // Verified (corpus with media association)
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.1080p.mkv',
      relevance: 0.5,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '1080p' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(ranked[0].hash, HASH1); // Verified
  assert.equal(ranked[1].hash, HASH2); // ProviderMatched
  assert.equal(ranked[2].hash, HASH3); // Probable
  assert.equal(ranked[3].hash, HASH4); // TextOnly
  assert.equal(tierMeta.TierCounts.Verified, 1);
  assert.equal(tierMeta.TierCounts.ProviderMatched, 1);
  assert.equal(tierMeta.TierCounts.Probable, 1);
  assert.equal(tierMeta.TierCounts.TextOnly, 1);
});

test('rankHitsTiered: fallback when no verified or provider-matched exist', () => {
  const hits = [
    // Only probable candidates
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.2160p.mkv',
      relevance: 0.95,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '2160p' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.720p.mkv',
      relevance: 0.5,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '720p' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(ranked.length, 2);
  assert.equal(tierMeta.TierCounts.Verified, 0);
  assert.equal(tierMeta.TierCounts.ProviderMatched, 0);
  assert.equal(tierMeta.TierCounts.Probable, 2);
  // Fallback: probable candidates still ranked
  assert.equal(ranked[0].hash, HASH1);
  assert.equal(ranked[1].hash, HASH2);
});

test('rankHitsTiered: all candidates preserved with new tier', () => {
  const hits = [
    { hash: HASH1, filename: 'a.mkv', relevance: 0.9, releaseAttributes: {}, sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }], mediaAssociations: [] },
    { hash: HASH2, filename: 'b.mkv', relevance: 0.8, releaseAttributes: {}, sources: [{ origin: 'live', evidence: [], confidence: 0.5 }], selectedMediaId: 'tt0364845' },
    { hash: HASH3, filename: 'c.mkv', relevance: 0.7, releaseAttributes: {}, sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }], mediaAssociations: [] },
  ];

  const { ranked, tierMeta } = rankHitsTiered(hits, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(ranked.length, 3); // All candidates preserved
  const totalInTiers = tierMeta.TierCounts.Verified + tierMeta.TierCounts.ProviderMatched + tierMeta.TierCounts.Probable + tierMeta.TierCounts.TextOnly + tierMeta.TierCounts.Rejected;
  assert.equal(totalInTiers, 3);
});

// =============================================================================
// Identity Evidence Diagnostic Tests
// =============================================================================

test('diagnoseIdentityEvidence: exposes evidence sources for verified candidate', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.mkv',
    relevance: 0.8,
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
  };
  const result = diagnoseIdentityEvidence(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Verified');
  assert.ok(result.EvidenceSources.Candidate_media.length > 0);
  assert.ok(result.EvidenceSources.Candidate_media[0].includes('tt0364845'));
  assert.equal(result.EvidenceSources.MediaId_scope.scoped, false); // Corpus doesn't have selectedMediaId
  assert.equal(result.EvidenceSources.Title_match.isStrongMatch, true);
  assert.equal(result.EvidenceSources.Season_episode_match.matchStatus, 'exact_match');
});

test('diagnoseIdentityEvidence: exposes evidence for provider-matched candidate', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.WEB-DL.mkv',
    relevance: 0.7,
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    selectedMediaId: 'tt0364845',
  };
  const result = diagnoseIdentityEvidence(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'ProviderMatched');
  assert.equal(result.EvidenceSources.MediaId_scope.scoped, true);
  assert.equal(result.EvidenceSources.MediaId_scope.selectedMediaId, 'tt0364845');
  assert.equal(result.EvidenceSources.MediaId_scope.queriedMediaId, 'tt0364845');
});

test('diagnoseIdentityEvidence: exposes evidence for probable candidate', () => {
  const hit = {
    hash: HASH1,
    filename: 'NCIS.S01E01.720p.mkv',
    relevance: 0.85,
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: [],
  };
  const result = diagnoseIdentityEvidence(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'Probable');
  assert.equal(result.EvidenceSources.Candidate_media.length, 0);
  assert.equal(result.EvidenceSources.Title_match.isStrongMatch, true);
});

test('diagnoseIdentityEvidence: exposes evidence for text-only candidate', () => {
  const hit = {
    hash: HASH1,
    filename: 'random_release.mkv',
    relevance: 0.1,
    releaseAttributes: {},
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.3 }],
    mediaAssociations: [],
  };
  const result = diagnoseIdentityEvidence(hit, { season: 1, episode: 1 }, 'tt0364845');
  assert.equal(result.IdentityTier, 'TextOnly');
  assert.equal(result.EvidenceSources.Title_match.isStrongMatch, false);
});

test('diagnoseTopCandidates: returns diagnostics for top N', () => {
  const hits = [
    {
      hash: HASH1,
      filename: 'NCIS.S01E01.mkv',
      score: 0.8,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
    {
      hash: HASH2,
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      score: 0.7,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
  ];
  const results = diagnoseTopCandidates(hits, { season: 1, episode: 1 }, 'tt0364845', 50);
  assert.equal(results.length, 2);
  assert.equal(results[0].rank, 1);
  assert.equal(results[0].identity.IdentityTier, 'Verified');
  assert.equal(results[1].rank, 2);
  assert.equal(results[1].identity.IdentityTier, 'ProviderMatched');
});

test('diagnoseTopCandidates: limits to top N', () => {
  const hits = [
    { hash: HASH1, filename: 'a.mkv', score: 0.9, releaseAttributes: {}, sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }], mediaAssociations: [] },
    { hash: HASH2, filename: 'b.mkv', score: 0.8, releaseAttributes: {}, sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }], mediaAssociations: [] },
    { hash: HASH3, filename: 'c.mkv', score: 0.7, releaseAttributes: {}, sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }], mediaAssociations: [] },
  ];
  const results = diagnoseTopCandidates(hits, { season: 1, episode: 1 }, 'tt0364845', 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].rank, 1);
  assert.equal(results[1].rank, 2);
});
