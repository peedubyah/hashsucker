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
  compareHits,
  compareHitsDetailed,
  explainOrder,
  compareRanked,
  explainRank,
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
