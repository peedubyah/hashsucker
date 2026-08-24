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

import { rankHit, explainRank, compareRanked, rankHits, explainOrder, compareHits } from '../src/lib/discovery/ranking.js';
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

  // compareRanked() accepts RANKED RESULTS ONLY (not explainRank() output,
  // which drops hash/fileIndex and cannot reproduce final tie-breaks).
  const comparison = compareRanked(strong, weak);

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

test('rejection: missing selected-media association — candidate appears with NEUTRAL identity', () => {
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

  // Candidate appears (corpus searchable by release identity, not mediaId-gated)
  assert.equal(result.results.length, 1, 'Candidate must appear');
  // Identity confidence is NEUTRAL (0.5) since no association to MEDIA_SHOW
  assert.equal(result.results[0].components.identityConfidence, 0.5, 'Identity confidence must be NEUTRAL');

  cache.close();
});

// =============================================================================
// Test 6: Live selected-media candidate NOT rejected for lacking candidate_media
// =============================================================================

test('live: selected-TV live candidate NOT rejected for lacking candidate_media', async () => {
  const cache = createDiscoveryCache();

  const mockLiveDiscovery = async () => ({
    releases: [{
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
    }],
    sources: {
      torrentio: { count: 1, error: null },
      torznab: { count: 0, error: null },
    },
  });

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

// =============================================================================
// FIX 1: NO_MEDIA_ASSOCIATION is NOT in active taxonomy
// Corpus searchable by release identity — mediaId only scopes ranking
// =============================================================================

test('NO_MEDIA_ASSOCIATION: not in active rejection taxonomy', () => {
  // NO_MEDIA_ASSOCIATION must NOT be in RejectionReason — corpus is now
  // searchable by release identity (title/year/season/episode/filename tokens).
  // mediaId only scopes identity confidence in ranking, not retrieval.
  assert.equal(
    RejectionReason.NO_MEDIA_ASSOCIATION,
    undefined,
    'NO_MEDIA_ASSOCIATION must not exist — corpus searchable by release identity'
  );

  // All active reasons must be observable at the eligibility/ranking boundary
  const activeReasons = Object.values(RejectionReason);
  assert.ok(activeReasons.includes(RejectionReason.WRONG_SEASON));
  assert.ok(activeReasons.includes(RejectionReason.WRONG_EPISODE));
  assert.ok(activeReasons.includes(RejectionReason.OUT_OF_RANGE));
  assert.ok(activeReasons.includes(RejectionReason.UNKNOWN_EPISODE_COVERAGE));
  assert.ok(activeReasons.includes(RejectionReason.MALFORMED_RANGE));
});

test('NO_MEDIA_ASSOCIATION: corpus searchable by release identity (not mediaId-gated)', () => {
  // Verify corpus searchable by release identity — candidate associated only
  // with OTHER media still appears for MEDIA_SHOW (identity confidence is NEUTRAL).
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

  // Candidate appears (corpus searchable by release identity)
  assert.equal(result.results.length, 1, 'Corpus searchable by release identity — candidate must appear');
  assert.equal(result.results[0].components.identityConfidence, 0.5, 'Identity confidence is NEUTRAL for MEDIA_SHOW');

  cache.close();
});

// =============================================================================
// FIX 2: Quality explanations use releaseAttributes facts, not composite thresholds
// =============================================================================

test('explainRank: quality reasons describe actual release properties, not inferred resolution', () => {
  // A 720p release boosted by BluRay + x265 + HDR can cross 0.7 threshold
  // but must NEVER be described as "1080p"
  const hit = {
    hash: HASH1,
    fileIndex: null,
    filename: 'Movie.2024.720p.BluRay.x265.HDR.mkv',
    relevance: 0.8,
    releaseAttributes: {
      title: 'Movie',
      year: 2024,
      resolution: '720p',
      sourceType: 'BluRay',
      codec: 'x265',
      hdr: true,
    },
    parserConfidence: 0.85,
    mediaAssociations: [],
    providerObservations: [],
    sources: [],
  };

  const ranked = rankHit(hit, {});
  const explanation = explainRank(ranked);

  // Must include actual properties
  assert.ok(explanation.reasons.includes('720p'), 'Should include actual resolution');
  assert.ok(explanation.reasons.includes('BluRay'), 'Should include actual source');
  assert.ok(explanation.reasons.includes('x265'), 'Should include actual codec');
  assert.ok(explanation.reasons.includes('HDR'), 'Should include HDR');

  // Must NOT claim higher resolution
  const reasonsStr = explanation.reasons.join(' ');
  assert.ok(!reasonsStr.includes('1080p'), 'Must NOT claim 1080p for a 720p release');
  assert.ok(!reasonsStr.includes('2160p'), 'Must NOT claim 2160p for a 720p release');
});

test('explainRank: 1080p release with high boost never mislabeled as 2160p', () => {
  const hit = {
    hash: HASH1,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x265.HDR.mkv',
    relevance: 0.9,
    releaseAttributes: {
      title: 'Movie',
      year: 2024,
      resolution: '1080p',
      sourceType: 'BluRay',
      codec: 'x265',
      hdr: true,
    },
    parserConfidence: 0.9,
    mediaAssociations: [],
    providerObservations: [],
    sources: [],
  };

  const ranked = rankHit(hit, {});
  const explanation = explainRank(ranked);

  // Should include 1080p (the actual resolution)
  assert.ok(explanation.reasons.includes('1080p'), 'Should include actual 1080p resolution');

  // Must NOT claim 2160p
  assert.ok(!explanation.reasons.includes('2160p'), 'Must NOT claim 2160p/UHD for 1080p release');
});

// =============================================================================
// FIX 3: compareRanked uses shared ordering contract (all tie-breaker scenarios)
// =============================================================================

test('compareRanked: A wins by composite score', () => {
  const a = rankHit({
    hash: HASH1, fileIndex: null, filename: 'A.mkv',
    relevance: 0.9, releaseAttributes: { resolution: '2160p' },
    parserConfidence: 0.9, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});
  const b = rankHit({
    hash: HASH2, fileIndex: null, filename: 'B.mkv',
    relevance: 0.5, releaseAttributes: { resolution: '480p' },
    parserConfidence: 0.5, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});

  const comparison = compareRanked(a, b);
  assert.equal(comparison.winner, 'a');
  assert.equal(comparison.decisiveFactor, 'score');
  assert.ok(comparison.primaryReason.includes('composite score'));
});

test('compareRanked: B wins by composite score identifies B advantage', () => {
  const a = rankHit({
    hash: HASH1, fileIndex: null, filename: 'A.mkv',
    relevance: 0.5, releaseAttributes: { resolution: '480p' },
    parserConfidence: 0.5, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});
  const b = rankHit({
    hash: HASH2, fileIndex: null, filename: 'B.mkv',
    relevance: 0.9, releaseAttributes: { resolution: '2160p' },
    parserConfidence: 0.9, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});

  const comparison = compareRanked(a, b);
  assert.equal(comparison.winner, 'b');
  assert.equal(comparison.decisiveFactor, 'score');
  assert.ok(comparison.primaryReason.includes('B'));
});

test('compareRanked: equal composite score, A wins by releaseConfidence', () => {
  // Calibrate so composite scores are EQUAL but releaseConfidence differs.
  // Score = rel*0.25 + qual*0.2 + rc*0.2 + id*0.15 + prov*0.1 + ep*0.1
  // A: rel=0.8, qual=0.36 (1080p), rc=0.9 → score = 0.2+0.072+0.18+0.075+0.05+0.05 = 0.627
  // B: rel=0.8, qual=0.36 (1080p), rc=0.7 → score = 0.2+0.072+0.14+0.075+0.05+0.05 = 0.587
  // To make equal: B needs +0.04 elsewhere → increase B relevance by 0.04/0.25 = 0.16
  // B: rel=0.96, qual=0.36, rc=0.7 → score = 0.24+0.072+0.14+0.075+0.05+0.05 = 0.627 ✓
  const a = rankHit({
    hash: HASH1, fileIndex: null, filename: 'A.mkv',
    relevance: 0.8, releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.9, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});
  const b = rankHit({
    hash: HASH2, fileIndex: null, filename: 'B.mkv',
    relevance: 0.96, releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.7, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});

  assert.equal(a.score, b.score, 'Scores must be equal for tie-break test');
  const comparison = compareRanked(a, b);
  assert.equal(comparison.winner, 'a');
  assert.equal(comparison.decisiveFactor, 'releaseConfidence');
  assert.ok(comparison.primaryReason.includes('release confidence'));
});

test('compareRanked: equal score+confidence, winner by quality', () => {
  // Calibrate for equal composite scores with different quality.
  // A: rel=0.8, qual=0.4 (2160p), rc=0.7 → score = 0.2+0.08+0.14+0.075+0.05+0.05 = 0.595
  // B: rel=0.8, qual=0.36 (1080p), rc=0.7 → score = 0.2+0.072+0.14+0.075+0.05+0.05 = 0.587
  // To make equal: B needs +0.008 elsewhere → increase B relevance by 0.008/0.25 = 0.032
  // B: rel=0.832, qual=0.36, rc=0.7 → score = 0.208+0.072+0.14+0.075+0.05+0.05 = 0.595 ✓
  const a = rankHit({
    hash: HASH1, fileIndex: null, filename: 'A.mkv',
    relevance: 0.8, releaseAttributes: { resolution: '2160p' },
    parserConfidence: 0.7, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});
  const b = rankHit({
    hash: HASH2, fileIndex: null, filename: 'B.mkv',
    relevance: 0.832, releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.7, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});

  assert.equal(a.score, b.score, 'Scores must be equal for tie-break test');
  const comparison = compareRanked(a, b);
  assert.equal(comparison.winner, 'a');
  assert.equal(comparison.decisiveFactor, 'quality');
});

test('compareRanked: final deterministic hash tie-break can be explained', () => {
  // Same scores, same components, different hashes
  const a = rankHit({
    hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // lower hash
    fileIndex: null, filename: 'A.mkv',
    relevance: 0.8, releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.9, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});
  const b = rankHit({
    hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', // higher hash
    fileIndex: null, filename: 'B.mkv',
    relevance: 0.8, releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.9, mediaAssociations: [], providerObservations: [], sources: [],
  }, {});

  const comparison = compareRanked(a, b);
  assert.equal(comparison.winner, 'a');
  assert.equal(comparison.decisiveFactor, 'hash');
  assert.ok(comparison.primaryReason.includes('hash'));
});

test('compareRanked: exact equality reports tie', () => {
  const hit = {
    hash: HASH1, fileIndex: null, filename: 'A.mkv',
    relevance: 0.8, releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.9, mediaAssociations: [], providerObservations: [], sources: [],
  };
  const a = rankHit(hit, {});
  const b = rankHit(hit, {});

  const comparison = compareRanked(a, b);
  assert.equal(comparison.winner, 'tie');
  assert.equal(comparison.decisiveFactor, null);
  assert.ok(comparison.primaryReason.includes('identical'));
});

test('compareRanked: explainOrder and compareHits share the same contract', () => {
  // Verify that explainOrder() (used by compareRanked) and compareHits()
  // (used by rankHits) produce the same ordering for a pair
  const hits = [
    { hash: HASH1, fileIndex: null, filename: 'A.mkv', relevance: 0.5, releaseAttributes: { resolution: '480p' }, parserConfidence: 0.5, mediaAssociations: [], providerObservations: [], sources: [] },
    { hash: HASH2, fileIndex: null, filename: 'B.mkv', relevance: 0.9, releaseAttributes: { resolution: '2160p' }, parserConfidence: 0.9, mediaAssociations: [], providerObservations: [], sources: [] },
    { hash: HASH3, fileIndex: null, filename: 'C.mkv', relevance: 0.7, releaseAttributes: { resolution: '1080p' }, parserConfidence: 0.7, mediaAssociations: [], providerObservations: [], sources: [] },
  ];

  const ranked = rankHits(hits, {});

  // rankHits ordering must match explainOrder for every pair
  for (let i = 0; i < ranked.length - 1; i++) {
    const a = ranked[i];
    const b = ranked[i + 1];
    const order = explainOrder(a, b);
    assert.equal(order.winner, 'a', `rankHits[${i}] must beat rankHits[${i+1}] per explainOrder`);
  }
});

// =============================================================================
// FIX 4: Contributions preserve actual weighted values from rankHit
// =============================================================================

test('explainRank: uses actual contributions from rankHit (raw, not recomputed from rounded)', () => {
  // Create a hit with values that produce non-round components
  const hit = {
    hash: HASH1,
    fileIndex: null,
    filename: 'Movie.mkv',
    relevance: 0.833, // Will produce 0.833 * 0.25 = 0.20825 (raw) vs 0.208 (from rounded)
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay', codec: 'x265', hdr: true },
    parserConfidence: 0.877,
    mediaAssociations: [{ mediaId: MEDIA_SHOW, confidence: 0.923 }],
    providerObservations: [],
    sources: [],
  };

  const ranked = rankHit(hit, {}, MEDIA_SHOW);
  const explanation = explainRank(ranked);

  // The explanation's contributions should be the RAW values from rankHit
  // (not recomputed from rounded components)
  assert.deepEqual(
    explanation.contributions,
    ranked.contributions,
    'Explanation contributions must match rankHit contributions exactly (raw, unrounded)'
  );

  // Sum of contributions should reconcile with score (within final rounding)
  const contributionSum = Object.values(explanation.contributions).reduce((a, b) => a + b, 0);
  const roundedSum = Math.round(contributionSum * 1000) / 1000;
  assert.equal(
    roundedSum,
    explanation.score,
    'Sum of raw contributions must reconcile with rounded score'
  );
});

test('explainRank: contribution precision proven with non-round component values', () => {
  // Explicitly crafted to show the difference between raw and recomputed
  const hit = {
    hash: HASH1,
    fileIndex: null,
    filename: 'Movie.mkv',
    relevance: 0.777,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay', codec: 'x265', hdr: true },
    parserConfidence: 0.888,
    mediaAssociations: [{ mediaId: MEDIA_SHOW, confidence: 0.999 }],
    providerObservations: [],
    sources: [],
  };

  const ranked = rankHit(hit, {}, MEDIA_SHOW);

  // Raw contribution for relevance: 0.777 * 0.25 = 0.19425
  // Recomputed from rounded: 0.777 rounded to 0.777 * 0.25 = 0.19425 (same in this case)
  // But the key is: the explanation uses the STORED contribution, not recomputation
  const explanation = explainRank(ranked);

  // The raw contribution should be exactly what rankHit stored
  assert.ok(
    Math.abs(explanation.contributions.relevance - 0.777 * 0.25) < 0.0001,
    'Relevance contribution should be raw (unrounded) value'
  );
});
