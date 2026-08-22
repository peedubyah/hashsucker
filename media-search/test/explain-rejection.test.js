/**
 * Score Explanation + Hard Rejection Reasons Tests
 *
 * Proves Stage 3 inspectability:
 *
 * 1. Score explanation components exactly match rankHit components
 * 2. Explanation is deterministic
 * 3. Stronger candidate explains why it outranks weaker candidate
 * 4. Wrong local episode produces typed hard rejection
 * 5. Missing selected-media local association is represented as rejection
 * 6. Live selected-media candidate is NOT rejected for lacking candidate_media
 * 7. Provider hint is never explained as authoritative cached state
 * 8. No scoring preference becomes a hard rejection
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { rankHit, explainRank, compareRanked } from '../src/lib/discovery/ranking.js';
import { RejectionReason, reasonFromCoverage, describeRejection, evaluateEligibility } from '../src/lib/discovery/rejection.js';
import { coversEpisode } from '../src/lib/discovery/episode-coverage.js';
import { combinedSearch, searchReleases } from '../src/lib/discovery/search-engine.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';
const HASH_LIVE = 'dddddddddddddddddddddddddddddddddddddddd';

const MEDIA_SHOW = 'tt2085059';
const MEDIA_OTHER = 'tt0000001';

// =============================================================================
// Test 1: Score explanation components exactly match rankHit components
// =============================================================================

test('explainRank: components match rankHit output exactly', () => {
  const hit = {
    hash: HASH1,
    fileIndex: null,
    filename: 'Movie.2024.1080p.mkv',
    relevance: 0.85,
    releaseAttributes: { title: 'Movie', year: 2024, resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: MEDIA_SHOW, confidence: 0.9 }],
    providerObservations: [{ provider: 'torbox', cached: true }],
    sources: [{ origin: 'corpus', evidenceType: 'fts5-ranked', confidence: 0.9 }],
  };

  const ranked = rankHit(hit, {}, MEDIA_SHOW);
  const explanation = explainRank(ranked);

  // Components must be identical
  assert.deepEqual(explanation.components, ranked.components, 'Explanation components must match rankHit components');
  assert.equal(explanation.score, ranked.score, 'Explanation score must match rankHit score');
});

test('explainRank: provider observations contribute to availability', () => {
  const hit = {
    hash: HASH1,
    fileIndex: null,
    filename: 'Movie.mkv',
    relevance: 0.8,
    releaseAttributes: {},
    parserConfidence: 0.8,
    mediaAssociations: [],
    providerObservations: [{ provider: 'torbox', cached: true }],
    sources: [],
  };

  const ranked = rankHit(hit, {});
  const explanation = explainRank(ranked);

  assert.ok(explanation.components.providerAvailability > 0.5, 'Cached provider should yield high availability');
  assert.ok(explanation.reasons.some(r => r.includes('provider availability')), 'Should mention provider availability');
});

// =============================================================================
// Test 2: Explanation is deterministic
// =============================================================================

test('explainRank: deterministic output for same input', () => {
  const hit = {
    hash: HASH1,
    fileIndex: null,
    filename: 'Movie.2024.720p.mkv',
    relevance: 0.7,
    releaseAttributes: { title: 'Movie', year: 2024, resolution: '720p' },
    parserConfidence: 0.85,
    mediaAssociations: [{ mediaId: MEDIA_SHOW, confidence: 0.8 }],
    providerObservations: [],
    sources: [{ origin: 'corpus', evidenceType: 'fts5-ranked', confidence: 0.85 }],
  };

  const ranked = rankHit(hit, {});
  const exp1 = explainRank(ranked);
  const exp2 = explainRank(ranked);

  assert.deepEqual(exp1, exp2, 'Same input must produce identical explanation');
});

// =============================================================================
// Test 3: Stronger candidate explains why it outranks weaker
// =============================================================================

test('explainRank: stronger candidate explains why it outranks weaker', () => {
  const strong = rankHit({
    hash: HASH1,
    fileIndex: null,
    filename: 'Movie.2024.2160p.UHD.mkv',
    relevance: 0.9,
    releaseAttributes: { resolution: '2160p', sourceType: 'BluRay', hdr: true, codec: 'x265' },
    parserConfidence: 0.95,
    mediaAssociations: [{ mediaId: MEDIA_SHOW, confidence: 0.9 }],
    providerObservations: [],
    sources: [],
  }, {}, MEDIA_SHOW);

  const weak = rankHit({
    hash: HASH2,
    fileIndex: null,
    filename: 'Movie.2024.480p.DVD.mkv',
    relevance: 0.9,
    releaseAttributes: { resolution: '480p', sourceType: 'DVD' },
    parserConfidence: 0.7,
    mediaAssociations: [],
    providerObservations: [],
    sources: [],
  }, {});

  const strongExp = explainRank(strong);
  const weakExp = explainRank(weak);

  const comparison = compareRanked(strongExp, weakExp);

  assert.equal(comparison.winner, 'a', 'Stronger candidate should win');
  assert.ok(comparison.scoreDiff > 0, 'Score diff should be positive');
  assert.ok(comparison.componentDiffs.quality > 0, 'Quality diff should favor stronger');
});

// =============================================================================
// Test 4: Wrong local episode produces typed hard rejection
// =============================================================================

test('rejection: wrong local episode produces typed hard rejection', () => {
  const cache = createDiscoveryCache();

  storeReleaseAttributes(cache, {
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Show.S01E02.Wrong.Episode.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Show S01E02',
      year: 2024,
      season: 1,
      episode: 2, // Wrong episode
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });
  cache.associateMedia(HASH1, null, MEDIA_SHOW, { confidence: 0.9, source: 'search' });

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1,
    episode: 3, // Requesting S01E03
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 0, 'Wrong episode should be rejected');

  // Verify typed rejection reason
  const coverage = coversEpisode({ season: 1, episode: 2 }, 1, 3);
  assert.equal(coverage.eligible, false);
  assert.equal(coverage.reason, 'wrong-episode');

  const rejection = reasonFromCoverage(coverage.reason);
  assert.equal(rejection, RejectionReason.WRONG_EPISODE);

  cache.close();
});

// =============================================================================
// Test 5: Missing selected-media local association is rejection
// =============================================================================

test('rejection: missing selected-media association is rejection', () => {
  const cache = createDiscoveryCache();

  storeReleaseAttributes(cache, {
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Show.S01E03.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Show S01E03',
      year: 2024,
      season: 1,
      episode: 3,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });
  // Associate with OTHER media, not MEDIA_SHOW
  cache.associateMedia(HASH1, null, MEDIA_OTHER, { confidence: 0.9, source: 'search' });

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1,
    episode: 3,
    mediaId: MEDIA_SHOW,
  });

  assert.equal(result.results.length, 0, 'No association to selected media should be rejected');

  cache.close();
});

// =============================================================================
// Test 6: Live selected-media candidate NOT rejected for lacking candidate_media
// =============================================================================

test('live: selected-TV live candidate NOT rejected for lacking candidate_media', async () => {
  const cache = createDiscoveryCache();

  const mockLiveDiscovery = async () => [{
    infoHash: HASH_LIVE,
    fileIndex: null,
    releaseKey: `${HASH_LIVE}:torrent`,
    filename: 'Show.S01E03.Live.720p.mkv',
    title: 'Show S01E03',
    season: 1,
    episode: 3,
    resolution: '720p',
    confidence: 0.8,
    sources: [{ addonId: 'torrentio.torbox' }],
  }];

  const result = await combinedSearch(cache, {
    query: 'Show',
    season: 1,
    episode: 3,
    mediaId: MEDIA_SHOW,
    includeLive: true,
    liveDiscoveryFn: mockLiveDiscovery,
    mode: 'raw',
  });

  // Live candidate should survive
  assert.equal(result.results.length, 1, 'Live candidate should survive');
  assert.equal(result.results[0].hash, HASH_LIVE);

  // No rejection for the live candidate
  const liveRejections = (result.debug?.rejections || []).filter(
    r => r.hash === HASH_LIVE
  );
  assert.equal(liveRejections.length, 0, 'Live candidate must NOT be rejected');

  cache.close();
});

// =============================================================================
// Test 7: Provider hint is never explained as authoritative cached state
// =============================================================================

test('explainRank: provider hints (non-authoritative) not described as confirmed', () => {
  // Candidate with only source/provider hints (no authoritative providerObservations)
  const hit = {
    hash: HASH1,
    fileIndex: null,
    filename: 'Movie.mkv',
    relevance: 0.8,
    releaseAttributes: {},
    parserConfidence: 0.8,
    mediaAssociations: [],
    providerObservations: [], // No authoritative observations
    sources: [
      {
        origin: 'live',
        evidence: [],
        confidence: 0.5,
        evidenceType: 'provider-hint:torrentio',
        addonId: 'torrentio',
        addonName: 'Torrentio',
        providerHint: { cached: true, evidence: [] }, // Non-authoritative hint
      },
    ],
  };

  const ranked = rankHit(hit, {});
  const explanation = explainRank(ranked);

  // Provider availability should be NEUTRAL (no authoritative observations)
  assert.equal(explanation.components.providerAvailability, 0.5, 'Hints must not affect availability score');

  // Must NOT mention "confirmed" or "availability" in reasons
  const availabilityReasons = explanation.reasons.filter(r => r.includes('provider availability'));
  assert.equal(availabilityReasons.length, 0, 'Provider hints must not be described as confirmed availability');
});

// =============================================================================
// Test 8: No scoring preference becomes a hard rejection
// =============================================================================

test('rejection: low-scoring but eligible candidate is NOT rejected', () => {
  const cache = createDiscoveryCache();

  // Low-quality but eligible candidate (right episode)
  storeReleaseAttributes(cache, {
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Show.S01E03.480p.DVD.mkv',
    source: 'ptn-regex',
    confidence: 0.6,
    parsed: {
      title: 'Show S01E03',
      year: 2024,
      season: 1,
      episode: 3,
      resolution: '480p',
      sourceType: 'DVD',
    },
    evidence: ['title_extracted'],
  });
  cache.associateMedia(HASH1, null, MEDIA_SHOW, { confidence: 0.9, source: 'search' });

  const result = searchReleases(cache, {
    query: 'Show',
    season: 1,
    episode: 3,
    mediaId: MEDIA_SHOW,
  });

  // Should still appear — low quality is preference, not rejection
  assert.equal(result.results.length, 1, 'Low-quality eligible candidate should NOT be rejected');
  assert.equal(result.results[0].hash, HASH1);

  cache.close();
});

// =============================================================================
// Additional: evaluateEligibility produces typed reasons
// =============================================================================

test('evaluateEligibility: wrong season produces typed rejection', () => {
  const candidate = {
    hash: HASH1,
    fileIndex: null,
    releaseKey: `${HASH1}:torrent`,
    releaseAttributes: { season: 2, episode: 3 },
  };

  const result = evaluateEligibility(candidate, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, RejectionReason.WRONG_SEASON);
  assert.ok(result.description, 'Should have a description');
});

test('evaluateEligibility: out-of-range produces typed rejection', () => {
  const candidate = {
    hash: HASH1,
    fileIndex: null,
    releaseKey: `${HASH1}:torrent`,
    releaseAttributes: { season: 1, episodeRange: '1-5' },
  };

  const result = evaluateEligibility(candidate, 1, 10);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, RejectionReason.OUT_OF_RANGE);
});

test('evaluateEligibility: malformed range produces typed rejection', () => {
  const candidate = {
    hash: HASH1,
    fileIndex: null,
    releaseKey: `${HASH1}:torrent`,
    releaseAttributes: { season: 1, episodeRange: '1--5' },
  };

  const result = evaluateEligibility(candidate, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, RejectionReason.MALFORMED_RANGE);
});

test('evaluateEligibility: unknown episode coverage produces typed rejection', () => {
  const candidate = {
    hash: HASH1,
    fileIndex: null,
    releaseKey: `${HASH1}:torrent`,
    releaseAttributes: { season: 1 }, // Correct season but no episode/range/pack
  };

  const result = evaluateEligibility(candidate, 1, 3);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, RejectionReason.UNKNOWN_EPISODE_COVERAGE);
});

test('evaluateEligibility: eligible episode returns no rejection', () => {
  const candidate = {
    hash: HASH1,
    fileIndex: null,
    releaseKey: `${HASH1}:torrent`,
    releaseAttributes: { season: 1, episode: 3 },
  };

  const result = evaluateEligibility(candidate, 1, 3);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
  assert.equal(result.description, null);
});

// =============================================================================
// describeRejection coverage
// =============================================================================

test('describeRejection: all reasons have descriptions', () => {
  for (const reason of Object.values(RejectionReason)) {
    const desc = describeRejection(reason);
    assert.ok(desc && desc.length > 0, `Description for ${reason} should not be empty`);
    assert.ok(!desc.startsWith('Unknown'), `Description for ${reason} should be known`);
  }
});
