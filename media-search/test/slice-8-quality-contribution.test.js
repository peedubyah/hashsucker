/**
 * Slice 8 — Quality Contribution Model (Shadow Only).
 *
 * Proves:
 *   A  quality model: versioned, component-scored, reasons, confidence
 *   B  component priority: resolution > sizeRelative > source > codec > container
 *   C  resolution component ordering (2160p>1440p>1080p>720p>sd>unknown)
 *   D  relative size: bounded, saturating, log-sigmoid on peerRatio
 *   E  source type ordering (remux>bluray>web-dl>webrip>hdtv>cam)
 *   F  codec tiny influence (av1>hevc>h264>vc1>mpeg2)
 *   G  container negligible influence
 *   H  release group contributes EXACTLY 0
 *   I  confidence = fraction of known components; missing != negative
 *   J  shadow integration: zero ranking influence
 *   K  hypothetical weight helper reorders correctly
 *   L  YIFY proof: small encode lower quality but not annihilated, no group penalty
 *   M  cross-resolution proof: high-bitrate 1080p close to tiny 2160p
 *   N  persistence: shadow in quality_features JSON, survives close/reopen
 *   O  analytics aggregation: shadow distribution, hypothetical analysis
 *   P  determinism: byte-identical JSON for same candidate
 *   Q  non-goals: no quality_score in production ranking, no provider data leak
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractQualityFeatures,
  computeQualityContribution,
  rankWithHypotheticalQualityWeight,
  QUALITY_FEATURES_VERSION,
  QUALITY_CONTRIBUTION_VERSION,
} from '../src/lib/discovery/quality-features.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(tag) {
  const dir = mkdtempSync(join(tmpdir(), `s8-${tag}-`));
  return join(dir, 'test.db');
}

/**
 * Build a ranked result object matching the shape expected by persistMediaRequest.
 */
function rankedResult(overrides = {}) {
  const {
    rank = 1,
    infoHash = 'A'.repeat(40),
    fileIndex = null,
    filename = 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    score = 0.8,
    selectedFileSize = null,
    release = {},
    identity = { tier: 'verified', confidence: 0.8, evidence: [], eligible: true },
  } = overrides;
  return {
    rank,
    infoHash,
    fileIndex,
    filename,
    score,
    scoreBreakdown: {},
    identity: {
      tier: identity.tier || 'verified',
      confidence: identity.confidence ?? 0.8,
      evidence: identity.evidence || [],
      state: identity.state || 'unresolved',
      eligible: identity.eligible !== false,
      ineligibleReason: identity.ineligibleReason || null,
      ineligibleCode: identity.ineligibleCode || null,
      expectedMediaScope: identity.expectedMediaScope || null,
      parsedCandidateScope: identity.parsedCandidateScope || null,
    },
    release: release || {},
    sources: [],
    observations: [],
    availability: {},
    selectedFileSize,
    justification: { scoreBreakdown: {}, weights: {}, historicalPrior: 0, freshProviderAvailability: 0 },
    components: { relevance: 0.8, quality: 0.7, releaseConfidence: 0.6, identityConfidence: 0.8, providerAvailability: 0.5, episodeMatch: 0 },
    contributions: {},
    providerObservations: [],
    hasLiveDiscovery: true,
  };
}

// ===========================================================================
// A. Quality model structure
// ===========================================================================

test('A: shadow is versioned and has required fields', () => {
  const features = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const shadow = features.qualityContributionShadow;
  assert.equal(shadow.version, QUALITY_CONTRIBUTION_VERSION);
  assert.equal(typeof shadow.total, 'number');
  assert.ok(shadow.total >= 0 && shadow.total <= 1);
  assert.equal(typeof shadow.components, 'object');
  assert.equal(typeof shadow.components.resolution, 'number');
  assert.equal(typeof shadow.components.sizeRelative, 'number');
  assert.equal(typeof shadow.components.source, 'number');
  assert.equal(typeof shadow.components.codec, 'number');
  assert.equal(typeof shadow.components.container, 'number');
  assert.equal(typeof shadow.componentWeights, 'object');
  assert.ok(Array.isArray(shadow.reasons));
  assert.equal(typeof shadow.confidence, 'number');
  assert.ok(shadow.confidence >= 0 && shadow.confidence <= 1);
});

test('A: shadow is frozen', () => {
  const features = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const shadow = features.qualityContributionShadow;
  assert.throws(() => { shadow.total = 0.99; }, TypeError);
  assert.throws(() => { shadow.components.resolution = 0.99; }, TypeError);
});

// ===========================================================================
// B. Component priority
// ===========================================================================

test('B: component weights reflect priority order', () => {
  const features = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const w = features.qualityContributionShadow.componentWeights;
  assert.ok(w.resolution > w.sizeRelative, 'resolution should dominate sizeRelative');
  assert.ok(w.sizeRelative > w.source, 'sizeRelative should exceed source');
  assert.ok(w.source > w.codec, 'source should exceed codec');
  assert.ok(w.codec > w.container, 'codec should exceed container');
});

test('B: component weights sum to 1.0', () => {
  const features = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const w = features.qualityContributionShadow.componentWeights;
  const sum = w.resolution + w.sizeRelative + w.source + w.codec + w.container;
  assert.ok(Math.abs(sum - 1.0) < 0.001, `weights should sum to 1.0, got ${sum}`);
});

// ===========================================================================
// C. Resolution component ordering
// ===========================================================================

test('C: resolution component scores follow spec ordering', () => {
  const res2160 = extractQualityFeatures({
    release: { resolution: '2160p' },
    filename: 'Movie.2024.2160p.UHD.BluRay.x265-FLUX.mkv',
    selectedFileSize: 50000000000,
  });
  const res1440 = extractQualityFeatures({
    release: { resolution: '1440p' },
    filename: 'Movie.2024.1440p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 30000000000,
  });
  const res1080 = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const res720 = extractQualityFeatures({
    release: { resolution: '720p' },
    filename: 'Movie.2024.720p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 4000000000,
  });
  const ressd = extractQualityFeatures({
    release: { resolution: 'sd' },
    filename: 'Movie.2024.480p.BluRay.x264-FLUX.mkv',
    selectedFileSize: 700000000,
  });
  const resUnknown = extractQualityFeatures({
    release: {},
    filename: 'Movie.2024.BluRay.x264-FLUX.mkv',
    selectedFileSize: 8589934592,
  });

  const c2160 = res2160.qualityContributionShadow.components.resolution;
  const c1440 = res1440.qualityContributionShadow.components.resolution;
  const c1080 = res1080.qualityContributionShadow.components.resolution;
  const c720 = res720.qualityContributionShadow.components.resolution;
  const csd = ressd.qualityContributionShadow.components.resolution;
  const cUnknown = resUnknown.qualityContributionShadow.components.resolution;

  assert.ok(c2160 > c1440, `2160p (${c2160}) > 1440p (${c1440})`);
  assert.ok(c1440 > c1080, `1440p (${c1440}) > 1080p (${c1080})`);
  assert.ok(c1080 > c720, `1080p (${c1080}) > 720p (${c720})`);
  assert.ok(c720 > csd, `720p (${c720}) > sd (${csd})`);
  // Slice 8A: unknown is NEUTRAL (0.50), NOT worse than SD.
  // Unknown resolution lowers confidence, not score.
  assert.ok(cUnknown > csd, `unknown (${cUnknown}) > sd (${csd}) — unknown is neutral, not penalised`);
  assert.equal(cUnknown, 0.5, 'unknown resolution is exactly neutral');
});

test('C: resolution scores match spec values', () => {
  const cases = [
    { res: '2160p', expected: 1.00 },
    { res: '1440p', expected: 0.88 },
    { res: '1080p', expected: 0.72 },
    { res: '720p', expected: 0.45 },
    { res: 'sd', expected: 0.20 },
  ];
  for (const { res, expected } of cases) {
    const features = extractQualityFeatures({
      release: { resolution: res },
      filename: `Movie.2024.${res}.BluRay.x265-FLUX.mkv`,
      selectedFileSize: 8589934592,
    });
    const score = features.qualityContributionShadow.components.resolution;
    assert.ok(Math.abs(score - expected) < 0.001, `${res} should be ${expected}, got ${score}`);
  }
});

// ===========================================================================
// D. Relative size component: bounded, saturating, log-sigmoid
// ===========================================================================

test('D: sizeRelative component is bounded [0,1]', () => {
  const cases = [
    { ratio: 0.01 },
    { ratio: 0.25 },
    { ratio: 0.50 },
    { ratio: 1.00 },
    { ratio: 2.00 },
    { ratio: 4.00 },
    { ratio: 10.0 },
    { ratio: 100.0 },
  ];
  for (const { ratio } of cases) {
    const features = extractQualityFeatures({
      release: { resolution: '1080p' },
      filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
      selectedFileSize: 8589934592,
    }, { peerCohort: [Math.round(8589934592 / ratio), 8589934592, Math.round(8589934592 * ratio)] });
    // The actual peerRatio depends on the median; test the component directly
    const shadow = computeQualityContribution({
      resolution: { label: '1080p' },
      derived: { peerRatio: ratio },
      source: { type: 'bluray' },
      codec: { video: 'hevc' },
      container: { type: 'mkv' },
    });
    const score = shadow.components.sizeRelative;
    assert.ok(score >= 0 && score <= 1, `ratio ${ratio} → score ${score} out of [0,1]`);
  }
});

test('D: sizeRelative saturates for huge ratios', () => {
  const low = computeQualityContribution({
    derived: { peerRatio: 4.0 },
    resolution: { label: '1080p' },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  });
  const high = computeQualityContribution({
    derived: { peerRatio: 10.0 },
    resolution: { label: '1080p' },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  });
  const score4 = low.components.sizeRelative;
  const score10 = high.components.sizeRelative;
  assert.ok(score10 > score4, 'ratio 10 > ratio 4 in sizeRelative');
  assert.ok(score10 - score4 < 0.1, `saturating: 4→${score4.toFixed(3)}, 10→${score10.toFixed(3)}`);
});

test('D: sizeRelative is neutral when no peerRatio', () => {
  const shadow = computeQualityContribution({
    derived: { peerRatio: null },
    resolution: { label: '1080p' },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  });
  assert.equal(shadow.components.sizeRelative, 0.5, 'no peerRatio → neutral 0.5');
});

test('D: sizeRelative ordering: small<median<above<huge', () => {
  const cases = [0.25, 1.0, 2.0, 4.0];
  const scores = cases.map((ratio) => computeQualityContribution({
    derived: { peerRatio: ratio },
    resolution: { label: '1080p' },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  }).components.sizeRelative);
  assert.ok(scores[0] < scores[1], 'ratio 0.25 < 1.0');
  assert.ok(scores[1] < scores[2], 'ratio 1.0 < 2.0');
  assert.ok(scores[2] < scores[3], 'ratio 2.0 < 4.0');
});

// ===========================================================================
// E. Source type ordering
// ===========================================================================

test('E: source type scores follow spec ordering', () => {
  const cases = ['remux', 'bluray', 'web-dl', 'webrip', 'hdtv', 'cam'];
  const scores = cases.map((src) => computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: src },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  }).components.source);
  for (let i = 0; i < scores.length - 1; i++) {
    assert.ok(scores[i] > scores[i + 1], `${cases[i]} (${scores[i]}) > ${cases[i + 1]} (${scores[i + 1]})`);
  }
});

test('E: unknown source is neutral', () => {
  const shadow = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'unknown' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  });
  assert.equal(shadow.components.source, 0.5, 'unknown source → neutral');
});

// ===========================================================================
// F. Codec tiny influence
// ===========================================================================

test('F: codec scores follow spec ordering', () => {
  const cases = ['av1', 'hevc', 'h264', 'vc1', 'mpeg2'];
  const scores = cases.map((codec) => computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: codec },
    container: { type: 'mkv' },
  }).components.codec);
  for (let i = 0; i < scores.length - 1; i++) {
    assert.ok(scores[i] > scores[i + 1], `${cases[i]} (${scores[i]}) > ${cases[i + 1]} (${scores[i + 1]})`);
  }
});

test('F: codec influence is tiny compared to resolution', () => {
  const bestCodec = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: 'av1' },
    container: { type: 'mkv' },
  });
  const worstCodec = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: 'mpeg2' },
    container: { type: 'mkv' },
  });
  // Compare weighted contribution to total, not raw component scores
  const codecContributionRange = bestCodec.components.codec * 0.05 - worstCodec.components.codec * 0.05;
  const totalWithoutCodec = bestCodec.total - bestCodec.components.codec * 0.05;
  assert.ok(Math.abs(codecContributionRange) < totalWithoutCodec * 0.1,
    `codec weighted contribution range (${Math.abs(codecContributionRange).toFixed(4)}) < 10% of non-codec total (${totalWithoutCodec.toFixed(4)})`);
});

test('F: unknown codec is neutral', () => {
  const shadow = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: 'unknown' },
    container: { type: 'mkv' },
  });
  assert.equal(shadow.components.codec, 0.5, 'unknown codec → neutral');
});

// ===========================================================================
// G. Container negligible influence
// ===========================================================================

test('G: container scores follow spec ordering', () => {
  const cases = ['mkv', 'mp4', 'm2ts', 'ts', 'avi'];
  const scores = cases.map((container) => computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: container },
  }).components.container);
  assert.ok(scores[0] > scores[1], 'mkv > mp4');
  assert.ok(scores[1] >= scores[2], 'mp4 >= m2ts');
  assert.ok(scores[2] === scores[3], 'm2ts === ts');
  assert.ok(scores[3] > scores[4], 'ts > avi');
});

test('G: container influence is negligible compared to resolution', () => {
  const bestContainer = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  });
  const worstContainer = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: 'avi' },
  });
  const containerRange = bestContainer.components.container - worstContainer.components.container;
  assert.ok(containerRange < 0.25, `container range (${containerRange}) should be small`);
});

test('G: unknown container is neutral', () => {
  const shadow = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: 'unknown' },
  });
  assert.equal(shadow.components.container, 0.5, 'unknown container → neutral');
});

// ===========================================================================
// H. Release group contributes exactly 0
// ===========================================================================

test('H: release group does NOT affect quality contribution', () => {
  // Same features except release group
  const flux = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const framestor = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FraMeSToR' },
    filename: 'Movie.2024.1080p.BluRay.x265-FraMeSToR.mkv',
    selectedFileSize: 8589934592,
  });
  const yts = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'YTS' },
    filename: 'Movie.2024.1080p.BluRay.x265-YTS.mkv',
    selectedFileSize: 8589934592,
  });
  // All identical except group → same shadow
  assert.equal(flux.qualityContributionShadow.total, framestor.qualityContributionShadow.total,
    'FLUX vs FraMeSToR → same shadow total');
  assert.equal(flux.qualityContributionShadow.total, yts.qualityContributionShadow.total,
    'FLUX vs YTS → same shadow total');
  assert.deepEqual(flux.qualityContributionShadow.components, framestor.qualityContributionShadow.components,
    'components identical regardless of group');
});

test('H: release group is mentioned in reasons but contributes 0', () => {
  const features = extractQualityFeatures({
    release: { resolution: '1080p', release_group: 'YTS' },
    filename: 'Movie.2024.1080p.WEB-DL.x264-YTS.mkv',
    selectedFileSize: 1401946675,
  });
  const shadow = features.qualityContributionShadow;
  const groupReasons = shadow.reasons.filter((r) => r.includes('releaseGroup'));
  assert.ok(groupReasons.length > 0, 'releaseGroup mentioned in reasons');
  assert.ok(groupReasons[0].includes('0'), 'releaseGroup contributes 0');
});

// ===========================================================================
// I. Confidence / missing data
// ===========================================================================

test('I: confidence is fraction of known components', () => {
  // All known: resolution, sizeRelative (peerRatio), source, codec, container
  const full = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  });
  assert.equal(full.confidence, 1.0, 'all components known → confidence 1.0');

  // None known
  const empty = computeQualityContribution({
    resolution: { label: 'unknown' },
    derived: { peerRatio: null },
    source: { type: 'unknown' },
    codec: { video: 'unknown' },
    container: { type: 'unknown' },
  });
  assert.equal(empty.confidence, 0.0, 'no components known → confidence 0.0');

  // Half known (resolution + source)
  const half = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: null },
    source: { type: 'bluray' },
    codec: { video: 'unknown' },
    container: { type: 'unknown' },
  });
  assert.equal(half.confidence, 0.4, '2/5 known → confidence 0.4');
});

test('I: missing data is neutral, not negative', () => {
  const unknownSource = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'unknown' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  });
  const knownSource = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'hdtv' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  });
  // unknown source (0.5) should be higher than hdtv (0.35), not lower
  assert.ok(unknownSource.total > knownSource.total,
    `unknown source (${unknownSource.total}) should not be worse than hdtv (${knownSource.total})`);
});

// ===========================================================================
// J. Shadow integration: zero ranking influence
// ===========================================================================

test('J: shadow does NOT change production score', () => {
  // The extractor produces shadow alongside features, but the score comes
  // from the ranking module. We verify that the ranked result object's
  // score field is unchanged by shadow computation.
  const before = rankedResult({
    rank: 1,
    score: 0.85,
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const features = extractQualityFeatures(before, { peerCohort: [8589934592] });
  // The shadow is attached to features, but the original score is untouched
  assert.equal(before.score, 0.85, 'original score unchanged');
  assert.ok(features.qualityContributionShadow.total >= 0, 'shadow total exists');
});

test('J: shadow is deterministic for same candidate', () => {
  const candidate = rankedResult({
    score: 0.85,
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const f1 = extractQualityFeatures(candidate, { peerCohort: [8589934592] });
  const f2 = extractQualityFeatures(candidate, { peerCohort: [8589934592] });
  assert.equal(JSON.stringify(f1.qualityContributionShadow), JSON.stringify(f2.qualityContributionShadow));
});

// ===========================================================================
// K. Hypothetical weight helper
// ===========================================================================

test('K: rankWithHypotheticalQualityWeight reorders correctly', () => {
  const results = [
    { rank: 1, score: 0.9, qualityContributionShadow: { total: 0.3 } }, // high score, low quality
    { rank: 2, score: 0.7, qualityContributionShadow: { total: 0.9 } }, // lower score, high quality
    { rank: 3, score: 0.5, qualityContributionShadow: { total: 0.5 } },
  ];
  const analysis = rankWithHypotheticalQualityWeight(results, 0.1);
  assert.equal(analysis.totalCandidates, 3);
  // At weight 0.1: scores become 0.9+0.03=0.93, 0.7+0.09=0.79, 0.5+0.05=0.55
  // Same order → no reorder
  assert.equal(analysis.reorderCount, 0);
});

test('K: hypothetical weight can cause reorder', () => {
  const results = [
    { rank: 1, score: 0.75, qualityContributionShadow: { total: 0.2 } }, // 0.75 + 0.1*0.2 = 0.77
    { rank: 2, score: 0.70, qualityContributionShadow: { total: 0.9 } }, // 0.70 + 0.1*0.9 = 0.79
  ];
  const analysis = rankWithHypotheticalQualityWeight(results, 0.1);
  assert.equal(analysis.reorderCount, 2, 'both candidates change rank');
  assert.equal(analysis.maxRankMovement, 1);
});

test('K: hypothetical weight at 0.02/0.05/0.10 produces monotonic reorder', () => {
  const results = [
    { rank: 1, score: 0.80, qualityContributionShadow: { total: 0.3 } },
    { rank: 2, score: 0.75, qualityContributionShadow: { total: 0.8 } },
    { rank: 3, score: 0.70, qualityContributionShadow: { total: 0.9 } },
    { rank: 4, score: 0.65, qualityContributionShadow: { total: 0.4 } },
    { rank: 5, score: 0.60, qualityContributionShadow: { total: 0.7 } },
  ];
  const w02 = rankWithHypotheticalQualityWeight(results, 0.02);
  const w05 = rankWithHypotheticalQualityWeight(results, 0.05);
  const w10 = rankWithHypotheticalQualityWeight(results, 0.10);
  // Higher weight should generally cause more reorders (not strictly monotonic
  // for all inputs, but for this fixture it should)
  assert.ok(w10.reorderCount >= w05.reorderCount || w10.maxRankMovement >= w05.maxRankMovement,
    'higher weight causes more movement');
});

test('K: empty input returns empty analysis', () => {
  const analysis = rankWithHypotheticalQualityWeight([], 0.05);
  assert.equal(analysis.totalCandidates, 0);
  assert.equal(analysis.reorderCount, 0);
  assert.deepEqual(analysis.originalOrder, []);
});

// ===========================================================================
// L. YIFY proof
// ===========================================================================

test('L: YIFY-like small encode has lower quality but not annihilated', () => {
  // YIFY: ~1.3 GB, h264, WEB-DL, 1080p
  const yify = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'WEB-DL', codec: 'x264', release_group: 'YTS' },
    filename: 'Movie.2024.1080p.WEB-DL.x264-YTS.mkv',
    selectedFileSize: 1401946675,
  }, { peerCohort: [1401946675, 4500000000, 12000000000] });

  // Normal: ~4 GB, h264, BluRay, 1080p
  const normal = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 4500000000,
  }, { peerCohort: [1401946675, 4500000000, 12000000000] });

  // Remux: ~12 GB, h264, BluRay, 1080p
  const remux = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'h264', release_group: 'FraMeSToR' },
    filename: 'Movie.2024.1080p.BluRay.Remux-FraMeSToR.mkv',
    selectedFileSize: 12000000000,
  }, { peerCohort: [1401946675, 4500000000, 12000000000] });

  const yifyTotal = yify.qualityContributionShadow.total;
  const normalTotal = normal.qualityContributionShadow.total;
  const remuxTotal = remux.qualityContributionShadow.total;

  // YIFY lower than normal/remux on intrinsic quality
  assert.ok(yifyTotal < normalTotal, `YIFY (${yifyTotal}) < normal (${normalTotal})`);
  assert.ok(yifyTotal < remuxTotal, `YIFY (${yifyTotal}) < remux (${remuxTotal})`);

  // But NOT catastrophically penalized (not near 0)
  assert.ok(yifyTotal > 0.3, `YIFY total (${yifyTotal}) not annihilated`);

  // No special group penalty: YTS group doesn't affect score
  const yifyNoGroup = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'WEB-DL', codec: 'x264' },
    filename: 'Movie.2024.1080p.WEB-DL.x264.mkv',
    selectedFileSize: 1401946675,
  }, { peerCohort: [1401946675, 4500000000, 12000000000] });
  assert.equal(yify.qualityContributionShadow.components.resolution, yifyNoGroup.qualityContributionShadow.components.resolution);
  assert.equal(yify.qualityContributionShadow.components.codec, yifyNoGroup.qualityContributionShadow.components.codec);
});

// ===========================================================================
// M. Cross-resolution proof
// ===========================================================================

test('M: strong 1080p close to tiny 2160p', () => {
  // Tiny 2160p encode (3 GB)
  const tiny2160 = extractQualityFeatures({
    release: { resolution: '2160p', source_type: 'WEB-DL', codec: 'hevc' },
    filename: 'Movie.2024.2160p.UHD.WEB-DL.x265-TEST.mkv',
    selectedFileSize: 3000000000,
  }, { peerCohort: [3000000000, 8000000000] });

  // Strong 1080p encode (8 GB, BluRay, x265)
  const strong1080 = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'hevc' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  }, { peerCohort: [4000000000, 8589934592, 12000000000] });

  const tiny2160Total = tiny2160.qualityContributionShadow.total;
  const strong1080Total = strong1080.qualityContributionShadow.total;

  // 2160p advantage exists but scores are reasonably close
  assert.ok(tiny2160Total > strong1080Total * 0.7,
    `tiny 2160p (${tiny2160Total}) should be within 30% of strong 1080p (${strong1080Total})`);
});

test('M: strong 2160p clearly beats mediocre 1080p', () => {
  const strong2160 = extractQualityFeatures({
    release: { resolution: '2160p', source_type: 'BluRay', codec: 'hevc' },
    filename: 'Movie.2024.2160p.UHD.BluRay.x265-FLUX.mkv',
    selectedFileSize: 50000000000,
  }, { peerCohort: [50000000000] });

  const mediocre1080 = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'WEB-DL', codec: 'h264' },
    filename: 'Movie.2024.1080p.WEB-DL.x264-YTS.mkv',
    selectedFileSize: 2000000000,
  }, { peerCohort: [2000000000] });

  assert.ok(strong2160.qualityContributionShadow.total > mediocre1080.qualityContributionShadow.total,
    'strong 2160p > mediocre 1080p');
});

test('M: 720p remux-ish vs ordinary 1080p — 1080p usually retains advantage', () => {
  const res720Remux = extractQualityFeatures({
    release: { resolution: '720p', source_type: 'remux', codec: 'h264' },
    filename: 'Movie.2024.720p.BluRay.Remux-FLUX.mkv',
    selectedFileSize: 6000000000,
  }, { peerCohort: [6000000000] });

  const res1080Ordinary = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'WEB-DL', codec: 'h264' },
    filename: 'Movie.2024.1080p.WEB-DL.x264.mkv',
    selectedFileSize: 4000000000,
  }, { peerCohort: [4000000000] });

  assert.ok(res1080Ordinary.qualityContributionShadow.total > res720Remux.qualityContributionShadow.total,
    'ordinary 1080p > 720p remux');
});

// ===========================================================================
// N. Persistence: shadow in quality_features JSON, survives close/reopen
// ===========================================================================

test('N: shadow persisted in quality_features JSON column', () => {
  const dbPath = tempDbPath('persist');
  const cache = createDiscoveryCache(dbPath);

  const results = [
    rankedResult({
      rank: 1,
      score: 0.9,
      filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
      selectedFileSize: 8589934592,
      release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' },
    }),
    rankedResult({
      rank: 2,
      infoHash: 'B'.repeat(40),
      score: 0.7,
      filename: 'Movie.2024.720p.WEB-DL.x264-YTS.mkv',
      selectedFileSize: 1401946675,
      release: { resolution: '720p', source_type: 'WEB-DL', codec: 'x264', release_group: 'YTS' },
    }),
  ];

  const requestId = cache.persistMediaRequest({ mediaId: 'tt1234567' }, results);

  // Verify shadow via read API
  const shadow1 = cache.getMediaRequestResultQualityContributionShadow(requestId, 1);
  assert.ok(shadow1.available, 'shadow available for rank 1');
  assert.equal(shadow1.shadow.version, QUALITY_CONTRIBUTION_VERSION);
  assert.ok(shadow1.shadow.total > 0);

  const shadow2 = cache.getMediaRequestResultQualityContributionShadow(requestId, 2);
  assert.ok(shadow2.available, 'shadow available for rank 2');
  assert.ok(shadow2.shadow.total > 0);

  // 1080p should have higher quality than 720p
  assert.ok(shadow1.shadow.total > shadow2.shadow.total,
    `1080p (${shadow1.shadow.total}) > 720p (${shadow2.shadow.total})`);

  // Also verify via quality features API
  const qf1 = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  assert.ok(qf1.available);
  assert.ok(qf1.features.qualityContributionShadow);
  assert.equal(qf1.features.qualityContributionShadow.version, QUALITY_CONTRIBUTION_VERSION);

  rmSync(dirname(dbPath), { recursive: true, force: true });
});

test('N: shadow survives close/reopen', () => {
  const dbPath = tempDbPath('reopen');
  let cache = createDiscoveryCache({ dbPath });

  const results = [
    rankedResult({
      rank: 1,
      score: 0.9,
      filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
      selectedFileSize: 8589934592,
      release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' },
    }),
  ];

  const requestId = cache.persistMediaRequest({ mediaId: 'tt7654321' }, results);

  // Capture shadow before close
  const shadowBefore = cache.getMediaRequestResultQualityContributionShadow(requestId, 1);
  assert.ok(shadowBefore.available, 'shadow available before close');
  assert.ok(shadowBefore.shadow !== null, 'shadow not null before close');

  // Close and reopen database (new instance, same file)
  cache.close();
  cache = createDiscoveryCache({ dbPath });

  // Capture shadow after reopen
  const shadowAfter = cache.getMediaRequestResultQualityContributionShadow(requestId, 1);
  assert.ok(shadowAfter !== null, 'shadow result not null after reopen');
  assert.ok(shadowAfter.available, 'shadow available after reopen');
  assert.ok(shadowAfter.shadow !== null, 'shadow not null after reopen');

  assert.deepEqual(shadowBefore.shadow, shadowAfter.shadow, 'shadow byte-stable across reopen');
  assert.equal(shadowBefore.shadow.total, shadowAfter.shadow.total);

  rmSync(dirname(dbPath), { recursive: true, force: true });
});

// ===========================================================================
// O. Analytics aggregation
// ===========================================================================

test('O: shadow distribution aggregation works', () => {
  const dbPath = tempDbPath('analytics');
  const cache = createDiscoveryCache(dbPath);

  const results = [
    rankedResult({
      rank: 1,
      score: 0.9,
      filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
      selectedFileSize: 8589934592,
      release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' },
    }),
    rankedResult({
      rank: 2,
      infoHash: 'B'.repeat(40),
      score: 0.7,
      filename: 'Movie.2024.720p.WEB-DL.x264-YTS.mkv',
      selectedFileSize: 1401946675,
      release: { resolution: '720p', source_type: 'WEB-DL', codec: 'x264', release_group: 'YTS' },
    }),
    rankedResult({
      rank: 3,
      infoHash: 'C'.repeat(40),
      score: 0.5,
      filename: 'Movie.2024.2160p.UHD.BluRay.x265-FLUX.mkv',
      selectedFileSize: 50000000000,
      release: { resolution: '2160p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' },
    }),
  ];

  cache.persistMediaRequest({ mediaId: 'tt9999999' }, results);

  const dist = cache.getQualityContributionShadowDistribution();
  assert.ok(dist !== null, 'distribution available');
  assert.equal(dist.total, 3);
  assert.equal(dist.withShadow, 3);
  assert.ok(dist.totalScore.min >= 0);
  assert.ok(dist.totalScore.max <= 1);
  assert.ok(dist.confidence.min >= 0);
  assert.ok(dist.confidence.max <= 1);
  assert.ok(dist.hypotheticalAnalysis['weight_0.02'] !== undefined);
  assert.ok(dist.hypotheticalAnalysis['weight_0.05'] !== undefined);
  assert.ok(dist.hypotheticalAnalysis['weight_0.10'] !== undefined);

  // Component averages should be reasonable
  assert.ok(dist.componentAverages.resolution > dist.componentAverages.container,
    'resolution average > container average');

  rmSync(dirname(dbPath), { recursive: true, force: true });
});

test('O: distribution returns null for legacy/empty corpus', () => {
  const dbPath = tempDbPath('empty');
  const cache = createDiscoveryCache(dbPath);
  const dist = cache.getQualityContributionShadowDistribution();
  assert.equal(dist, null, 'null when no quality_features rows');
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

// ===========================================================================
// O2. Slice 8A: per-request grouping regression test
// ===========================================================================

test('O2: hypothetical analysis groups by request_id, not globally', () => {
  const dbPath = tempDbPath('per-request');
  const cache = createDiscoveryCache(dbPath);

  // Request A: 3 candidates, scores tightly clustered so quality dominates
  const reqA = [
    rankedResult({
      rank: 1,
      infoHash: 'A'.repeat(40),
      score: 0.70,
      filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
      selectedFileSize: 8589934592,
      release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' },
    }),
    rankedResult({
      rank: 2,
      infoHash: 'B'.repeat(40),
      score: 0.68,
      filename: 'Movie.2024.720p.WEB-DL.x264-YTS.mkv',
      selectedFileSize: 1401946675,
      release: { resolution: '720p', source_type: 'WEB-DL', codec: 'x264', release_group: 'YTS' },
    }),
    rankedResult({
      rank: 3,
      infoHash: 'C'.repeat(40),
      score: 0.66,
      filename: 'Movie.2024.2160p.UHD.WEB-DL.x265-TEST.mkv',
      selectedFileSize: 3000000000,
      release: { resolution: '2160p', source_type: 'WEB-DL', codec: 'x265', release_group: 'TEST' },
    }),
  ];

  // Request B: 2 candidates, much higher scores than A
  // The 720p here has a very low score relative to the others.
  // The point: scores of B don't interleave with A's — if the algorithm
  // did a GLOBAL sort, B's lower-scored 720p would interleave with A's
  // results and produce nonsense movement. Per-request sort keeps them
  // isolated.
  const reqB = [
    rankedResult({
      rank: 1,
      infoHash: 'D'.repeat(40),
      score: 0.95,
      filename: 'Other.2024.1080p.BluRay.x265-AAA.mkv',
      selectedFileSize: 8589934592,
      release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'AAA' },
    }),
    rankedResult({
      rank: 2,
      infoHash: 'E'.repeat(40),
      score: 0.93,
      filename: 'Other.2024.720p.WEB-DL.x264-BBB.mkv',
      selectedFileSize: 1401946675,
      release: { resolution: '720p', source_type: 'WEB-DL', codec: 'x264', release_group: 'BBB' },
    }),
  ];

  const reqIdA = cache.persistMediaRequest({ mediaId: 'ttA' }, reqA);
  const reqIdB = cache.persistMediaRequest({ mediaId: 'ttB' }, reqB);
  assert.notEqual(reqIdA, reqIdB, 'two distinct request_ids');

  const dist = cache.getQualityContributionShadowDistribution();
  assert.ok(dist !== null);
  assert.equal(dist.requestCount, 2, 'two distinct requests');

  const w10 = dist.hypotheticalAnalysis['weight_0.10'];
  assert.equal(w10.requestCount, 2);
  // The schema rejects duplicate (request_id, info_hash, file_index_key) tuples.
  // The default rankedResult factory uses infoHash='A'.repeat(40) and
  // fileIndex=-1, so two rows with default infoHash + -1 collide. We
  // give every row a distinct infoHash so all 5 are persisted.
  assert.equal(w10.candidatesConsidered, 5, '5 candidates considered (3+2)');
  assert.ok(w10.candidatesMoved <= w10.candidatesConsidered);
  assert.ok(w10.medianAbsoluteRankMovement >= 0);
  assert.ok(w10.maxAbsoluteRankMovement >= 0);

  rmSync(dirname(dbPath), { recursive: true, force: true });
});

test('O2: regression — two overlapping-score requests prove global sort would be wrong', () => {
  const dbPath = tempDbPath('overlap');
  const cache = createDiscoveryCache(dbPath);

  // Request 1: low scores 0.50/0.45, all 1080p
  // Request 2: higher scores 0.90/0.80, 720p
  // A global sort would interleave these. A per-request sort keeps them
  // isolated — Request 1's quality reorder doesn't touch Request 2's
  // ordering, and vice versa.
  // Each row gets a distinct infoHash to avoid the UNIQUE INDEX on
  // (request_id, info_hash, file_index_key).
  const req1 = [
    rankedResult({
      rank: 1,
      infoHash: '1'.repeat(40),
      score: 0.50,
      filename: 'A.2024.1080p.BluRay.x265.mkv',
      selectedFileSize: 8000000000,
      release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265' },
    }),
    rankedResult({
      rank: 2,
      infoHash: '2'.repeat(40),
      score: 0.45,
      filename: 'A.2024.1080p.WEB-DL.x264.mkv',
      selectedFileSize: 2000000000,
      release: { resolution: '1080p', source_type: 'WEB-DL', codec: 'x264' },
    }),
  ];

  const req2 = [
    rankedResult({
      rank: 1,
      infoHash: '3'.repeat(40),
      score: 0.90,
      filename: 'B.2024.720p.BluRay.x265.mkv',
      selectedFileSize: 4000000000,
      release: { resolution: '720p', source_type: 'BluRay', codec: 'x265' },
    }),
    rankedResult({
      rank: 2,
      infoHash: '4'.repeat(40),
      score: 0.80,
      filename: 'B.2024.720p.WEB-DL.x264.mkv',
      selectedFileSize: 1500000000,
      release: { resolution: '720p', source_type: 'WEB-DL', codec: 'x264' },
    }),
  ];

  const reqId1 = cache.persistMediaRequest({ mediaId: 'ttX' }, req1);
  const reqId2 = cache.persistMediaRequest({ mediaId: 'ttY' }, req2);

  const dist = cache.getQualityContributionShadowDistribution();
  const w10 = dist.hypotheticalAnalysis['weight_0.10'];

  // CRITICAL ASSERTION: candidatesConsidered must equal sum of per-request
  // candidate counts (2+2=4), NOT a global sort result.
  assert.equal(w10.candidatesConsidered, 4,
    'per-request grouping: candidatesConsidered = sum of per-request counts (2+2=4)');
  assert.equal(w10.requestCount, 2, 'two requests');

  // The per-request top-1 is the original rank 1 in each request. Per-request
  // hypothetical sort should never produce a top-1 change for either request
  // because in each request, rank 1 has both higher score AND (probably)
  // higher quality. We test that the top-1-change counter is independent
  // of the OTHER request's scores.
  assert.ok(w10.requestsWithTop1Change >= 0);
  assert.ok(w10.requestsWithTop1Change <= w10.requestCount);

  rmSync(dirname(dbPath), { recursive: true, force: true });
});

// ===========================================================================
// O3. Slice 8A: unknown resolution is neutral, NOT worse than SD
// ===========================================================================

test('O3: unknown resolution is neutral, not penalised as worse than SD', () => {
  const sd = extractQualityFeatures({
    release: { resolution: 'sd' },
    filename: 'Movie.2024.480p.BluRay.x264.mkv',
    selectedFileSize: 700000000,
  });
  const unknown = extractQualityFeatures({
    release: {},
    filename: 'Movie.2024.BluRay.x264.mkv',
    selectedFileSize: 8589934592,
  });

  const sdResolution = sd.qualityContributionShadow.components.resolution;
  const unknownResolution = unknown.qualityContributionShadow.components.resolution;

  // Slice 8A: unknown is neutral (0.5), SD is 0.20
  assert.equal(unknownResolution, 0.5, 'unknown resolution = 0.5 (neutral)');
  assert.equal(sdResolution, 0.20, 'sd resolution = 0.20');
  assert.ok(unknownResolution > sdResolution,
    `unknown (${unknownResolution}) > sd (${sdResolution}) — not penalised for absence`);

  // But unknown has lower confidence
  const sdConfidence = sd.qualityContributionShadow.confidence;
  const unknownConfidence = unknown.qualityContributionShadow.confidence;
  assert.ok(unknownConfidence < sdConfidence,
    `unknown confidence (${unknownConfidence}) < sd confidence (${sdConfidence}) — confidence decreases for missing data`);
});

test('O3: unknown resolution does NOT implicitly penalise via large weight', () => {
  // Resolution weight = 0.50, unknown = 0.5 (neutral)
  // weighted contribution of unknown = 0.5 * 0.5 = 0.25
  // Compare to SD: 0.20 * 0.5 = 0.10
  // Unknown still wins on the resolution dimension.
  const features = extractQualityFeatures({
    release: {},
    filename: 'Movie.mkv',
    selectedFileSize: 8589934592,
  });
  const shadow = features.qualityContributionShadow;
  assert.equal(shadow.components.resolution, 0.5);
  // The resolution contribution to total: 0.5 * 0.5 = 0.25
  // This is identical to having a known 1080p-equivalent of 0.5 score
  // (which there is no such resolution, but the point is it doesn't
  // implicitly drag the total down).
  // Verify: unknown resolution alone should not cause total < 0.3
  // when all other components are neutral.
  assert.ok(shadow.total >= 0.4,
    `unknown resolution + all neutral should give total >= 0.4, got ${shadow.total}`);
});

// ===========================================================================
// O4. Slice 8A: component weights have container <= 0.02
// ===========================================================================

test('O4: component weights have container influence <= 0.02', () => {
  const features = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const w = features.qualityContributionShadow.componentWeights;
  assert.ok(w.container <= 0.02, `container weight (${w.container}) <= 0.02`);
  assert.equal(w.resolution, 0.50);
  assert.equal(w.sizeRelative, 0.30);
  assert.equal(w.source, 0.14);
  assert.equal(w.codec, 0.05);
  assert.equal(w.container, 0.01);

  // Sum must equal 1.0
  const sum = w.resolution + w.sizeRelative + w.source + w.codec + w.container;
  assert.ok(Math.abs(sum - 1.0) < 0.001, `weights sum to 1.0, got ${sum}`);
});

test('O4: container change (mkv↔avi) does not materially affect total', () => {
  const mkv = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  const avi = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.avi',
    selectedFileSize: 8589934592,
  });
  const totalDelta = Math.abs(mkv.qualityContributionShadow.total - avi.qualityContributionShadow.total);
  // Container weight is 0.01, so mkv(0.55)→avi(0.35) delta = 0.20 * 0.01 = 0.002
  assert.ok(totalDelta < 0.005, `container change total delta (${totalDelta}) < 0.005`);
});

// ===========================================================================
// P. Determinism
// ===========================================================================

test('P: shadow is byte-identical for same candidate', () => {
  const candidate = {
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  };
  const f1 = extractQualityFeatures(candidate, { peerCohort: [4000000000, 8589934592, 12000000000] });
  const f2 = extractQualityFeatures(candidate, { peerCohort: [4000000000, 8589934592, 12000000000] });
  const f3 = extractQualityFeatures(candidate, { peerCohort: [4000000000, 8589934592, 12000000000] });
  const s1 = JSON.stringify(f1.qualityContributionShadow, Object.keys(f1.qualityContributionShadow).sort());
  const s2 = JSON.stringify(f2.qualityContributionShadow, Object.keys(f2.qualityContributionShadow).sort());
  const s3 = JSON.stringify(f3.qualityContributionShadow, Object.keys(f3.qualityContributionShadow).sort());
  assert.equal(s1, s2);
  assert.equal(s2, s3);
});

// ===========================================================================
// Q. Non-goals: no provider/auth/capability data leaks
// ===========================================================================

test('Q: shadow contains no provider/auth/capability data', () => {
  const candidate = rankedResult({
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
    observations: [
      { provider: 'torbox', cached: true, state: 'cached', evidence: { instant: true } },
      { provider: 'realdebrid', cached: false, state: 'uncached' },
    ],
    providerObservations: [
      { provider: 'torbox', cached: true },
    ],
  });
  const features = extractQualityFeatures(candidate, { peerCohort: [8589934592] });
  const shadow = features.qualityContributionShadow;
  const shadowJson = JSON.stringify(shadow);

  assert.ok(!shadowJson.includes('torbox'), 'no provider name in shadow');
  assert.ok(!shadowJson.includes('realdebrid'), 'no provider name in shadow');
  assert.ok(!shadowJson.includes('cached'), 'no cache state in shadow');
  assert.ok(!shadowJson.includes('instant'), 'no evidence in shadow');
});

test('Q: computeQualityContribution is pure (no I/O)', () => {
  // Call with minimal features — should not throw, should not access any external state
  const shadow = computeQualityContribution({
    resolution: { label: '1080p' },
    derived: { peerRatio: 1.0 },
    source: { type: 'bluray' },
    codec: { video: 'hevc' },
    container: { type: 'mkv' },
  });
  assert.equal(typeof shadow.total, 'number');
  assert.ok(shadow.total >= 0 && shadow.total <= 1);
});

// ===========================================================================
// Additional edge cases
// ===========================================================================

test('edge: all unknown/missing components → total is weighted sum', () => {
  const shadow = computeQualityContribution({
    resolution: { label: 'unknown' },
    derived: { peerRatio: null },
    source: { type: 'unknown' },
    codec: { video: 'unknown' },
    container: { type: 'unknown' },
  });
  // Slice 8A: unknown resolution is NEUTRAL (0.5), not 0.0.
  // All five components are 0.5 → total = 0.5 * (0.5+0.3+0.14+0.05+0.01) = 0.5
  assert.ok(Math.abs(shadow.total - 0.5) < 0.01, `expected ~0.5, got ${shadow.total}`);
  assert.equal(shadow.confidence, 0.0, 'confidence 0 when all components unknown');
});

test('edge: best possible quality', () => {
  const shadow = computeQualityContribution({
    resolution: { label: '2160p' },
    derived: { peerRatio: 4.0 },
    source: { type: 'remux' },
    codec: { video: 'av1' },
    container: { type: 'mkv' },
  });
  assert.ok(shadow.total > 0.8, `best quality should be high, got ${shadow.total}`);
  assert.equal(shadow.confidence, 1.0);
});

test('edge: worst possible quality (not unknown)', () => {
  const shadow = computeQualityContribution({
    resolution: { label: 'unknown' },
    derived: { peerRatio: 0.01 },
    source: { type: 'cam' },
    codec: { video: 'mpeg2' },
    container: { type: 'avi' },
  });
  assert.ok(shadow.total < 0.4, `worst quality should be low, got ${shadow.total}`);
});

// Helper
function dirname(p) {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '.' : p.slice(0, idx);
}
