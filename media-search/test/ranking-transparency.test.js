/**
 * Ranking Transparency Tests
 *
 * Proves the ranking engine can explain its decisions:
 * - Why result A beat result B
 * - Same release with different provider states
 * - Same media with different qualities
 * - Incomplete metadata
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { rankHit, rankHits, qualityScore, identityConfidenceScore, providerAvailabilityScore, episodeMatchScore, getWeights } from '../src/lib/discovery/ranking.js';
import { explainScore, compareRanks } from '../src/lib/discovery/ranking-explain.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

// =============================================================================
// Explainability Tests
// =============================================================================

test('explainScore: returns score breakdown and evidence', () => {
  const hit = {
    hash: HASH1,
    filename: 'The.Matrix.1999.1080p.BluRay.mkv',
    relevance: 0.9,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay', codec: 'x264' },
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: 'tt0133093', confidence: 0.95 }],
    providerObservations: [{ provider: 'torbox', cached: true }],
  };

  const explanation = explainScore(hit);

  assert.equal(explanation.hash, HASH1);
  assert.ok(explanation.score > 0);
  assert.ok(explanation.breakdown.relevance > 0);
  assert.ok(explanation.breakdown.quality > 0);
  assert.ok(explanation.breakdown.identityConfidence > 0);
  assert.ok(explanation.breakdown.providerAvailability > 0);
  assert.ok(Array.isArray(explanation.evidence));
  assert.ok(explanation.evidence.length > 0);
});

test('explainScore: evidence includes identity match detail', () => {
  const hit = {
    hash: HASH1,
    filename: 'Movie.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.85,
    mediaAssociations: [{ mediaId: 'tt1234567', confidence: 0.92 }],
    providerObservations: [],
  };

  const explanation = explainScore(hit);

  const identityEvidence = explanation.evidence.find(e => e.type === 'identity');
  assert.ok(identityEvidence);
  assert.match(identityEvidence.detail, /tt1234567/);
  assert.match(identityEvidence.detail, /92%/);
});

test('explainScore: evidence includes provider availability detail', () => {
  const hit = {
    hash: HASH1,
    filename: 'Movie.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.85,
    mediaAssociations: [],
    providerObservations: [{ provider: 'torbox', cached: true }, { provider: 'rd', cached: true }],
  };

  const explanation = explainScore(hit);

  const availabilityEvidence = explanation.evidence.find(e => e.type === 'availability');
  assert.ok(availabilityEvidence);
  assert.equal(availabilityEvidence.strength, 'high');
  assert.match(availabilityEvidence.detail, /2 provider/);
});

test('explainScore: unknown provider state is marked unknown', () => {
  const hit = {
    hash: HASH1,
    filename: 'Movie.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.85,
    mediaAssociations: [],
    providerObservations: [],
  };

  const explanation = explainScore(hit);

  const availabilityEvidence = explanation.evidence.find(e => e.type === 'availability');
  assert.ok(availabilityEvidence);
  assert.equal(availabilityEvidence.strength, 'unknown');
  assert.match(availabilityEvidence.detail, /unknown/i);
});

test('explainScore: no identity is marked unknown', () => {
  const hit = {
    hash: HASH1,
    filename: 'Movie.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.85,
    mediaAssociations: [],
    providerObservations: [],
  };

  const explanation = explainScore(hit);

  const identityEvidence = explanation.evidence.find(e => e.type === 'identity');
  assert.ok(identityEvidence);
  assert.equal(identityEvidence.strength, 'unknown');
});

test('explainScore: episode match evidence included when query has season/episode', () => {
  const hit = {
    hash: HASH1,
    filename: 'S05E14.mkv',
    relevance: 0.8,
    releaseAttributes: { season: 5, episode: 14, resolution: '1080p' },
    parserConfidence: 0.85,
    mediaAssociations: [],
    providerObservations: [],
  };

  const explanation = explainScore(hit, { season: 5, episode: 14 });

  const episodeEvidence = explanation.evidence.find(e => e.type === 'episode');
  assert.ok(episodeEvidence);
  assert.equal(episodeEvidence.strength, 'exact');
  assert.match(episodeEvidence.detail, /S5E14/);
});

// =============================================================================
// Comparison Tests
// =============================================================================

test('compareRanks: explains why higher quality won', () => {
  const winner = {
    hash: HASH1,
    filename: 'Movie.2160p.BluRay.HDR.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '2160p', sourceType: 'BluRay', hdr: true, codec: 'x265' },
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.9 }],
    providerObservations: [],
  };

  const loser = {
    hash: HASH2,
    filename: 'Movie.480p.DVD.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '480p', sourceType: 'DVD', codec: 'x264' },
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.9 }],
    providerObservations: [],
  };

  const comparison = compareRanks(winner, loser);

  assert.ok(comparison.scoreDiff > 0);
  assert.ok(comparison.reasons.length > 0);
  assert.ok(comparison.reasons.some(r => r.includes('quality')));
});

test('compareRanks: explains why cached won over uncached', () => {
  const winner = {
    hash: HASH1,
    filename: 'Movie.1080p.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.85,
    mediaAssociations: [],
    providerObservations: [{ provider: 'torbox', cached: true }],
  };

  const loser = {
    hash: HASH2,
    filename: 'Movie.1080p.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.85,
    mediaAssociations: [],
    providerObservations: [{ provider: 'torbox', cached: false }],
  };

  const comparison = compareRanks(winner, loser);

  assert.ok(comparison.scoreDiff > 0);
  assert.ok(comparison.reasons.some(r => r.includes('availability')));
});

test('compareRanks: explains why identity match won', () => {
  const winner = {
    hash: HASH1,
    filename: 'Movie.mkv',
    relevance: 0.7,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.8,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.95 }],
    providerObservations: [],
  };

  const loser = {
    hash: HASH2,
    filename: 'Movie.mkv',
    relevance: 0.7,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.8,
    mediaAssociations: [],
    providerObservations: [],
  };

  const comparison = compareRanks(winner, loser);

  assert.ok(comparison.scoreDiff > 0);
  assert.ok(comparison.reasons.some(r => r.includes('identity')));
});

// =============================================================================
// Scenario Tests
// =============================================================================

test('scenario: same release with different provider states', () => {
  const baseHit = {
    hash: HASH1,
    filename: 'Movie.1080p.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.85,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.9 }],
  };

  const withCache = rankHit({ ...baseHit, providerObservations: [{ provider: 'torbox', cached: true }] });
  const withoutCache = rankHit({ ...baseHit, providerObservations: [{ provider: 'torbox', cached: false }] });
  const unknownCache = rankHit({ ...baseHit, providerObservations: [] });

  // Cached should rank highest
  assert.ok(withCache.score > withoutCache.score);
  // Unknown should be in the middle (neutral, not penalized)
  assert.ok(unknownCache.score > withoutCache.score);
  assert.ok(withCache.score > unknownCache.score);

  // Scores should differ only in provider component
  assert.equal(withCache.components.relevance, withoutCache.components.relevance);
  assert.equal(withCache.components.quality, withoutCache.components.quality);
  assert.equal(withCache.components.identityConfidence, withoutCache.components.identityConfidence);
});

test('scenario: same media with different qualities', () => {
  const baseHit = {
    hash: HASH1,
    filename: 'Movie.mkv',
    relevance: 0.9,
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.95 }],
    providerObservations: [],
  };

  const fourK = rankHit({ ...baseHit, releaseAttributes: { resolution: '2160p', sourceType: 'BluRay', hdr: true } });
  const tenEighty = rankHit({ ...baseHit, releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' } });
  const fourEighty = rankHit({ ...baseHit, releaseAttributes: { resolution: '480p', sourceType: 'DVD' } });

  // Quality ordering should match resolution ordering
  assert.ok(fourK.score > tenEighty.score);
  assert.ok(tenEighty.score > fourEighty.score);

  // Quality component should reflect the difference
  assert.ok(fourK.components.quality > tenEighty.components.quality);
  assert.ok(tenEighty.components.quality > fourEighty.components.quality);
});

test('scenario: incomplete metadata does not crash and ranks lower', () => {
  const complete = {
    hash: HASH1,
    filename: 'Movie.2160p.BluRay.HDR.DTS.x265-Group.mkv',
    relevance: 0.95,
    releaseAttributes: { resolution: '2160p', sourceType: 'BluRay', hdr: true, codec: 'x265', audio: 'DTS', releaseGroup: 'Group' },
    parserConfidence: 0.95,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.95 }],
    providerObservations: [{ provider: 'torbox', cached: true }],
  };

  const minimal = {
    hash: HASH2,
    filename: 'movie.mkv',
    relevance: 0.5,
    releaseAttributes: {},
    parserConfidence: 0.5,
    mediaAssociations: [],
    providerObservations: [],
  };

  const ranked = rankHits([complete, minimal]);

  // Complete metadata should rank first
  assert.equal(ranked[0].hash, HASH1);
  assert.ok(ranked[0].score > ranked[1].score);

  // Minimal metadata should still get a valid score (not crash)
  assert.ok(ranked[1].score > 0);
  assert.ok(ranked[1].score < ranked[0].score);
});

test('scenario: ambiguous identity with multiple associations', () => {
  const hit = {
    hash: HASH1,
    filename: 'Batman.mkv',
    relevance: 0.7,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.8,
    mediaAssociations: [
      { mediaId: 'tt0096895', confidence: 0.6 },  // Batman 1989
      { mediaId: 'tt0112462', confidence: 0.55 },  // Batman Forever
      { mediaId: 'tt0468569', confidence: 0.5 },   // The Dark Knight
    ],
    providerObservations: [],
  };

  const result = rankHit(hit);

  // Should use the highest confidence association
  assert.equal(result.components.identityConfidence, 0.6);
});

test('scenario: missing release attributes (no resolution/source)', () => {
  const hit = {
    hash: HASH1,
    filename: 'movie.mkv',
    relevance: 0.6,
    releaseAttributes: { title: 'Movie' },  // Only title, no quality info
    parserConfidence: 0.7,
    mediaAssociations: [],
    providerObservations: [],
  };

  const result = rankHit(hit);

  // Quality should be zero (no resolution/source to score)
  assert.equal(result.components.quality, 0);
  // But overall score should still be valid (other components contribute)
  assert.ok(result.score > 0);
});

test('scenario: exact episode match beats same season wrong episode', () => {
  const exactMatch = rankHit({
    hash: HASH1,
    filename: 'S05E14.mkv',
    relevance: 0.8,
    releaseAttributes: { season: 5, episode: 14, resolution: '1080p' },
    parserConfidence: 0.85,
    mediaAssociations: [],
    providerObservations: [],
  }, { season: 5, episode: 14 });

  const wrongEpisode = rankHit({
    hash: HASH2,
    filename: 'S05E10.mkv',
    relevance: 0.8,
    releaseAttributes: { season: 5, episode: 10, resolution: '1080p' },
    parserConfidence: 0.85,
    mediaAssociations: [],
    providerObservations: [],
  }, { season: 5, episode: 14 });

  assert.ok(exactMatch.score > wrongEpisode.score);
  assert.equal(exactMatch.components.episodeMatch, 1.0);
  assert.equal(wrongEpisode.components.episodeMatch, 0.5);
});

// =============================================================================
// Audit: Purity Verification
// =============================================================================

test('audit: rankHit does not mutate input hit', () => {
  const hit = {
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.85,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.9 }],
    providerObservations: [{ provider: 'torbox', cached: true }],
  };

  const original = JSON.parse(JSON.stringify(hit));

  rankHit(hit);

  // Input should not be mutated
  assert.deepEqual(hit.releaseAttributes, original.releaseAttributes);
  assert.deepEqual(hit.mediaAssociations, original.mediaAssociations);
  assert.deepEqual(hit.providerObservations, original.providerObservations);
});

test('audit: rankHit does not perform I/O (pure function)', () => {
  // If rankHit were impure, it would require fetch/database
  // This test verifies it runs without any external dependencies
  const hit = {
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.5,
    releaseAttributes: {},
    parserConfidence: 0.5,
    mediaAssociations: [],
    providerObservations: [],
  };

  // Should complete synchronously (no promises, no I/O)
  const result = rankHit(hit);
  assert.ok(typeof result.score === 'number');
});

test('audit: ranking has no provider-specific logic', () => {
  // Provider observations are generic — no hardcoded provider names
  const hit = {
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.5,
    releaseAttributes: {},
    parserConfidence: 0.5,
    mediaAssociations: [],
    providerObservations: [
      { provider: 'any-provider-name', cached: true },
      { provider: 'another-provider', cached: false },
    ],
  };

  const result = rankHit(hit);

  // Should score based on cached state, not provider name
  assert.equal(result.components.providerAvailability, 0.5);  // 1 cached, 1 uncached
});

test('audit: missing evidence is handled neutrally', () => {
  const hit = {
    hash: HASH1,
    filename: 'test.mkv',
    relevance: 0.5,
    // No releaseAttributes
    // No parserConfidence
    // No mediaAssociations
    // No providerObservations
  };

  const result = rankHit(hit);

  // All missing components should use neutral value (0.5), not zero
  assert.equal(result.components.releaseConfidence, 0.5);
  assert.equal(result.components.identityConfidence, 0.5);
  assert.equal(result.components.providerAvailability, 0.5);
  assert.equal(result.components.episodeMatch, 0.5);

  // Score should still be valid
  assert.ok(result.score > 0);
});

test('audit: score is weighted sum of components', () => {
  const hit = {
    hash: HASH1,
    filename: 'Movie.1080p.BluRay.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay', codec: 'x264' },
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.85 }],
    providerObservations: [{ provider: 'torbox', cached: true }],
  };

  const result = rankHit(hit);

  // The score is the weighted sum of components
  // Score = relevance*0.25 + quality*0.20 + releaseConf*0.20 + identityConf*0.15 + providerAvail*0.10 + episodeMatch*0.10
  const weights = getWeights();
  const expectedScore =
    result.components.relevance * weights.relevance +
    result.components.quality * weights.quality +
    result.components.releaseConfidence * weights.releaseConfidence +
    result.components.identityConfidence * weights.identityConfidence +
    result.components.providerAvailability * weights.providerAvailability +
    result.components.episodeMatch * weights.episodeMatch;

  assert.ok(Math.abs(expectedScore - result.score) < 0.001);
});
