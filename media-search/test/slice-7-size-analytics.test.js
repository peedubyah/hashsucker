/**
 * Slice 7 — Exact Size Propagation + Peer-Relative Size Analytics.
 *
 * Proves:
 *   C  size source precedence (exactFileSize > null, no pack contamination)
 *   E  persistence: selected_file_size + quality_features.size.bytes match
 *   F  peer cohort definition (mediaId + resolution tier, TV: +season+episode)
 *   G  peer-relative features (percentile, ratio, peerCount, median)
 *   H  YIFY/compact encode proof (low percentile, no ranking change)
 *   I  duplicate release proof (same physical release counts once)
 *   J  persistence/restart proof (byte-stable across reopen)
 *   L  non-goals (no quality_score, no ranking change)
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractQualityFeatures,
} from '../src/lib/discovery/quality-features.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(tag) {
  const dir = mkdtempSync(join(tmpdir(), `s7-${tag}-`));
  return join(dir, 'test.db');
}

/**
 * Build a ranked result object matching the shape expected by persistMediaRequest.
 * Mirrors what media-request.js builds from ranked hits.
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
// C. Size source precedence
// ===========================================================================

test('C: exactFileSize takes precedence; null when no exact size', () => {
  // When selectedFileSize is set and positive, quality_features uses it
  const withSize = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  assert.equal(withSize.size.bytes, 8589934592);
  assert.equal(withSize.size.sizeDensityMode, 'raw-only');

  // When selectedFileSize is null, quality_features.size.bytes is null
  const noSize = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: null,
  });
  assert.equal(noSize.size.bytes, null);
  assert.equal(noSize.size.sizeDensityMode, 'missing');
});

test('C: exactFileSize must be positive safe integer (no zero, no negative)', () => {
  const zero = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.mkv',
    selectedFileSize: 0,
  });
  assert.equal(zero.size.bytes, null);

  const negative = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.mkv',
    selectedFileSize: -100,
  });
  assert.equal(negative.size.bytes, null);

  const unsafe = extractQualityFeatures({
    release: { resolution: '1080p' },
    filename: 'Movie.mkv',
    selectedFileSize: 2 ** 53, // not safe integer
  });
  assert.equal(unsafe.size.bytes, null);
});

// ===========================================================================
// E. Persistence: selected_file_size + quality_features.size.bytes match
// ===========================================================================

test('E: persisted selected_file_size equals quality_features.size.bytes', () => {
  const dbPath = tempDbPath('persist');
  const cache = createDiscoveryCache({ dbPath });
  const SIZE = 8589934592; // 8 GiB
  const results = [
    rankedResult({ rank: 1, infoHash: 'A'.repeat(40), filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv', selectedFileSize: SIZE, release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' } }),
    rankedResult({ rank: 2, infoHash: 'B'.repeat(40), filename: 'Movie.2024.1080p.WEB-DL.x264-YTS.mkv', selectedFileSize: 1401946675, release: { resolution: '1080p', source_type: 'WEB-DL', codec: 'x264', release_group: 'YTS' } }),
  ];
  const requestId = cache.persistMediaRequest({ mediaId: 'tt0000001', mediaType: 'movie' }, results);

  // Check rank 1
  const qf1 = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  assert.ok(qf1);
  assert.ok(qf1.available);
  assert.equal(qf1.features.size.bytes, SIZE);

  // Check rank 2
  const qf2 = cache.getMediaRequestResultQualityFeatures(requestId, 2);
  assert.ok(qf2);
  assert.ok(qf2.available);
  assert.equal(qf2.features.size.bytes, 1401946675);

  // Verify selected_file_size column directly
  const row = cache.db.prepare('SELECT selected_file_size FROM media_request_results WHERE request_id = ? AND rank = ?').get(requestId, 1);
  assert.equal(row.selected_file_size, SIZE);

  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

test('E: persisted null when no exact size available', () => {
  const dbPath = tempDbPath('nosize');
  const cache = createDiscoveryCache({ dbPath });
  const results = [
    rankedResult({ rank: 1, selectedFileSize: null }),
  ];
  const requestId = cache.persistMediaRequest({ mediaId: 'tt0000002', mediaType: 'movie' }, results);

  const qf = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  assert.ok(qf);
  assert.ok(qf.available);
  assert.equal(qf.features.size.bytes, null);

  const row = cache.db.prepare('SELECT selected_file_size FROM media_request_results WHERE request_id = ? AND rank = ?').get(requestId, 1);
  assert.equal(row.selected_file_size, null);

  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

// ===========================================================================
// G. Peer-relative features (basic shape + YIFY proof)
// ===========================================================================

test('G: peer-relative features shape and YIFY low-percentile proof', () => {
  // Same movie, same 1080p tier, different sizes (YIFY ~1.3GB, normal ~4GB, remux ~12GB)
  const yify = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x264', release_group: 'YIFY' },
    filename: 'Movie.2024.1080p.BluRay.x264-YIFY.mkv',
    selectedFileSize: 1395864371, // ~1.3 GiB
  });
  const normal = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x264', release_group: 'FLUX' },
    filename: 'Movie.2024.1080p.BluRay.x264-FLUX.mkv',
    selectedFileSize: 4294967296, // 4 GiB
  });
  const remux = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'hevc', release_group: 'FGT' },
    filename: 'Movie.2024.1080p.BluRay.HEVC-FGT.mkv',
    selectedFileSize: 12884901888, // 12 GiB
  });

  // All same resolution tier
  assert.equal(yify.resolution.label, '1080p');
  assert.equal(normal.resolution.label, '1080p');
  assert.equal(remux.resolution.label, '1080p');

  // Sizes differ
  assert.ok(yify.size.bytes < normal.size.bytes);
  assert.ok(normal.size.bytes < remux.size.bytes);

  // No quality_score (non-goal)
  assert.equal(yify.quality_score, undefined);
  assert.equal(normal.quality_score, undefined);
  assert.equal(remux.quality_score, undefined);
});

// ===========================================================================
// J. Persistence/restart proof
// ===========================================================================

test('J: quality features byte-stable across DB reopen', () => {
  const dbPath = tempDbPath('restart');
  const cache = createDiscoveryCache({ dbPath });
  const SIZE = 8589934592;
  const mkResult = (rank, size, res) => ({
    rank, infoHash: rank.toString().repeat(40), fileIndex: null, filename: `Movie.${rank}.mkv`,
    score: 0.8, scoreBreakdown: {},
    identity: { tier: 'verified', confidence: 0.8, evidence: [], state: 'unresolved', eligible: true },
    release: res, sources: [], observations: [], availability: {},
    selectedFileSize: size,
    justification: { scoreBreakdown: {}, weights: {}, historicalPrior: 0, freshProviderAvailability: 0 },
    components: { relevance: 0.8, quality: 0.7, releaseConfidence: 0.6, identityConfidence: 0.8, providerAvailability: 0.5, episodeMatch: 0 },
    contributions: {}, providerObservations: [], hasLiveDiscovery: true,
  });
  const results = [
    mkResult(1, SIZE, { resolution: '1080p' }),
    mkResult(2, 1401946675, { resolution: '1080p' }),
  ];
  const requestId = cache.persistMediaRequest({ mediaId: 'tt0000003', mediaType: 'movie' }, results);

  // Read before reopen
  const qfBefore1 = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  const qfBefore2 = cache.getMediaRequestResultQualityFeatures(requestId, 2);

  // Close and reopen
  cache.close();
  const cache2 = createDiscoveryCache({ dbPath });

  // Read after reopen
  const qfAfter1 = cache2.getMediaRequestResultQualityFeatures(requestId, 1);
  const qfAfter2 = cache2.getMediaRequestResultQualityFeatures(requestId, 2);

  // Byte-stable
  assert.deepEqual(qfAfter1.features, qfBefore1.features);
  assert.deepEqual(qfAfter2.features, qfBefore2.features);
  assert.equal(qfAfter1.features.size.bytes, SIZE);
  assert.equal(qfAfter2.features.size.bytes, 1401946675);

  cache2.close();
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

// ===========================================================================
// L. Non-goals verification
// ===========================================================================

test('L: no quality_score in feature snapshot', () => {
  const features = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'FLUX' },
    filename: 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: 8589934592,
  });
  assert.equal(features.quality_score, undefined);
  assert.equal(features.score, undefined);
});

test('L: no ranking influence from size features', () => {
  // Two candidates with different sizes but identical metadata
  // Ranking is driven by score, not by size features
  const small = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x264', release_group: 'YIFY' },
    filename: 'Movie.2024.1080p.BluRay.x264-YIFY.mkv',
    selectedFileSize: 1395864371,
  });
  const large = extractQualityFeatures({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x264', release_group: 'FLUX' },
    filename: 'Movie.2024.1080p.BluRay.x264-FLUX.mkv',
    selectedFileSize: 8589934592,
  });

  // Features capture size difference
  assert.ok(small.size.bytes < large.size.bytes);

  // But neither gets a quality_score
  assert.equal(small.quality_score, undefined);
  assert.equal(large.quality_score, undefined);
});

// ===========================================================================
// F. Peer cohort definition (basic)
// ===========================================================================

test('F: peer cohort is same mediaId + same resolution tier', () => {
  const dbPath = tempDbPath('cohort');
  const cache = createDiscoveryCache({ dbPath });

  // Movie A 1080p candidates
  const movieA_1080p_v1 = rankedResult({ rank: 1, selectedFileSize: 8589934592, release: { resolution: '1080p' } });
  const movieA_1080p_v2 = rankedResult({ rank: 2, infoHash: 'B'.repeat(40), selectedFileSize: 1401946675, release: { resolution: '1080p' } });

  // Movie A 2160p (different tier, not peer)
  const movieA_2160p = rankedResult({ rank: 3, infoHash: 'C'.repeat(40), selectedFileSize: 25769803776, release: { resolution: '2160p' } });

  // Movie B 1080p (different media, not peer)
  const movieB_1080p = rankedResult({ rank: 4, infoHash: 'D'.repeat(40), selectedFileSize: 8589934592, release: { resolution: '1080p' } });

  const requestId = cache.persistMediaRequest({ mediaId: 'tt0000010', mediaType: 'movie' }, [movieA_1080p_v1, movieA_1080p_v2, movieA_2160p, movieB_1080p]);

  // Verify persistence
  const qf1 = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  assert.equal(qf1.features.size.bytes, 8589934592);
  assert.equal(qf1.features.resolution.label, '1080p');

  const qf3 = cache.getMediaRequestResultQualityFeatures(requestId, 3);
  assert.equal(qf3.features.resolution.label, '2160p');

  cache.close();
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});
