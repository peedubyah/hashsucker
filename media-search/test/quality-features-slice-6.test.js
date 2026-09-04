/**
 * Quality Feature Extraction + Persistence — Slice 6 proof tests.
 *
 * Covers the slice-6 spec sections:
 *   B  quality feature schema (versioned, compact)
 *   C  resolution normalization (explicit parsed → filename fallback)
 *   D  size/bitrate proxy (bytesPerMinute when runtime known, else raw-only)
 *   E  source type normalization
 *   F  release group normalization (raw preserved, normalized conservatively)
 *   G  codec normalization
 *   H  container derivation from extension only
 *   I  persistence (versioned JSON column, legacy rows NULL)
 *   J  write path (same object, no re-query, no re-rank)
 *   K  analytics read API (distributions, size stats)
 *   M  YIFY/small-release: features differ, NO ranking difference
 *   N  determinism (byte-identical JSON for same candidate)
 *   O  non-goals (no quality_score, no group reliability weights)
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractQualityFeatures,
  serializeQualityFeatures,
  QUALITY_FEATURES_VERSION,
} from '../src/lib/discovery/quality-features.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(tag) {
  const dir = mkdtempSync(join(tmpdir(), `qf-${tag}-`));
  return join(dir, 'test.db');
}

function candidate(overrides = {}) {
  return {
    release: {
      resolution: '1080p',
      source_type: 'BluRay',
      codec: 'x265',
      release_group: 'FLUX',
      ...(overrides.release || {}),
    },
    filename: overrides.filename || 'Movie.2024.1080p.BluRay.x265-FLUX.mkv',
    selectedFileSize: overrides.selectedFileSize ?? 8589934592, // 8 GiB
    ...overrides,
  };
}

// ===========================================================================
// B. Quality feature schema
// ===========================================================================

test('B: schema is versioned and compact', () => {
  const features = extractQualityFeatures(candidate());
  assert.equal(features.version, QUALITY_FEATURES_VERSION);
  assert.equal(typeof features.resolution, 'object');
  assert.equal(typeof features.size, 'object');
  assert.equal(typeof features.source, 'object');
  assert.equal(typeof features.codec, 'object');
  assert.equal(typeof features.container, 'object');
  assert.equal(typeof features.releaseGroup, 'object');
  assert.equal(typeof features.derived, 'object');
});

test('B: frozen output — cannot be mutated', () => {
  const features = extractQualityFeatures(candidate());
  assert.throws(() => { features.version = 99; }, TypeError);
  assert.throws(() => { features.resolution.label = '720p'; }, TypeError);
});

// ===========================================================================
// C. Resolution normalization
// ===========================================================================

test('C: explicit parsed resolution preferred over filename', () => {
  const features = extractQualityFeatures(candidate({ release: { resolution: '2160p' }, filename: 'Movie.1080p.mkv' }));
  assert.equal(features.resolution.label, '2160p');
  assert.equal(features.resolution.width, 3840);
  assert.equal(features.resolution.height, 2160);
});

test('C: filename fallback when parser output absent', () => {
  const features = extractQualityFeatures(candidate({ release: { resolution: null }, filename: 'Movie.2160p.UHD.mkv' }));
  assert.equal(features.resolution.label, '2160p');
});

test('C: 4K/UHD/2160p all normalize to 2160p', () => {
  for (const res of ['4K', 'UHD', '4kuhd', '2160p']) {
    const features = extractQualityFeatures(candidate({ release: { resolution: res }, filename: 'Movie.mkv' }));
    assert.equal(features.resolution.label, '2160p');
  }
});

test('C: 1080p/1080i/FHD all normalize to 1080p', () => {
  for (const res of ['1080p', '1080i', 'FHD']) {
    const features = extractQualityFeatures(candidate({ release: { resolution: res }, filename: 'Movie.mkv' }));
    assert.equal(features.resolution.label, '1080p');
  }
});

test('C: 576p/480p normalize to sd', () => {
  for (const res of ['576p', '480p', '360p']) {
    const features = extractQualityFeatures(candidate({ release: { resolution: res }, filename: 'Movie.mkv' }));
    assert.equal(features.resolution.label, 'sd');
  }
});

test('C: unknown resolution when no signal', () => {
  const features = extractQualityFeatures(candidate({ release: { resolution: null }, filename: 'Movie.mkv' }));
  assert.equal(features.resolution.label, 'unknown');
  assert.equal(features.resolution.width, null);
  assert.equal(features.resolution.height, null);
  assert.equal(features.resolution.confidence, 0.0);
});

test('C: do NOT infer 2160p from file size', () => {
  // A 50GB file with no resolution signal must NOT be inferred as 2160p
  const features = extractQualityFeatures(candidate({ release: { resolution: null }, filename: 'Movie.mkv', selectedFileSize: 53687091200 }));
  assert.equal(features.resolution.label, 'unknown');
});

// ===========================================================================
// D. Size / bitrate proxy
// ===========================================================================

test('D: bytesPerMinute when runtime available', () => {
  const features = extractQualityFeatures(candidate({ selectedFileSize: 6442450944 }), { runtimeMinutes: 120 });
  assert.equal(features.size.bytes, 6442450944);
  assert.equal(features.size.bytesPerMinute, Math.round(6442450944 / 120));
  assert.equal(features.size.sizeDensityMode, 'runtime-normalized');
});

test('D: raw-only when runtime unavailable', () => {
  const features = extractQualityFeatures(candidate({ selectedFileSize: 8589934592 }));
  assert.equal(features.size.bytes, 8589934592);
  assert.equal(features.size.bytesPerMinute, null);
  assert.equal(features.size.sizeDensityMode, 'raw-only');
});

test('D: missing when no size', () => {
  const features = extractQualityFeatures(candidate({ selectedFileSize: null }));
  assert.equal(features.size.bytes, null);
  assert.equal(features.size.bytesPerMinute, null);
  assert.equal(features.size.sizeDensityMode, 'missing');
});

test('D: 12GB 1080p vs 12GB 2160p — same bytes, different resolution', () => {
  const big = 12884901888; // 12 GiB
  const f1080 = extractQualityFeatures(candidate({ release: { resolution: '1080p' }, selectedFileSize: big }));
  const f2160 = extractQualityFeatures(candidate({ release: { resolution: '2160p' }, selectedFileSize: big }));
  assert.equal(f1080.size.bytes, big);
  assert.equal(f2160.size.bytes, big);
  assert.equal(f1080.resolution.label, '1080p');
  assert.equal(f2160.resolution.label, '2160p');
  // Both have same bytes — resolution differentiates them
  assert.notEqual(f1080.resolution.label, f2160.resolution.label);
});

// ===========================================================================
// E. Source type normalization
// ===========================================================================

test('E: normalize source types', () => {
  const cases = [
    ['Remux', 'remux'],
    ['BluRay', 'bluray'],
    ['WEB-DL', 'web-dl'],
    ['WEBRip', 'webrip'],
    ['HDTV', 'hdtv'],
    ['CAM', 'cam'],
  ];
  for (const [input, expected] of cases) {
    const features = extractQualityFeatures(candidate({ release: { source_type: input } }));
    assert.equal(features.source.type, expected);
  }
});

test('E: unknown source when no signal', () => {
  const features = extractQualityFeatures(candidate({ release: { source_type: null }, filename: 'Movie.mkv' }));
  assert.equal(features.source.type, 'unknown');
});

// ===========================================================================
// F. Release group normalization
// ===========================================================================

test('F: preserve raw, normalize conservatively', () => {
  const features = extractQualityFeatures(candidate({ release: { release_group: 'FLUX' } }));
  assert.equal(features.releaseGroup.raw, 'FLUX');
  assert.equal(features.releaseGroup.normalized, 'FLUX');
});

test('F: strip trailing dots and surrounding punctuation', () => {
  const features = extractQualityFeatures(candidate({ release: { release_group: '-YTS.' } }));
  assert.equal(features.releaseGroup.raw, '-YTS.');
  assert.equal(features.releaseGroup.normalized, 'YTS');
});

test('F: preserve mixed-case groups (FraMeSToR)', () => {
  const features = extractQualityFeatures(candidate({ release: { release_group: 'FraMeSToR' } }));
  assert.equal(features.releaseGroup.normalized, 'FraMeSToR');
});

test('F: null when no group', () => {
  const features = extractQualityFeatures(candidate({ release: { release_group: null } }));
  assert.equal(features.releaseGroup.raw, null);
  assert.equal(features.releaseGroup.normalized, null);
  assert.equal(features.releaseGroup.confidence, 0.0);
});

// ===========================================================================
// G. Codec normalization
// ===========================================================================

test('G: normalize codec aliases', () => {
  const cases = [
    ['x265', 'hevc'], ['x264', 'h264'], ['hevc', 'hevc'], ['h265', 'hevc'],
    ['h264', 'h264'], ['avc', 'h264'], ['av1', 'av1'], ['vc-1', 'vc1'],
    ['vc1', 'vc1'], ['mpeg2', 'mpeg2'],
  ];
  for (const [input, expected] of cases) {
    const features = extractQualityFeatures(candidate({ release: { codec: input } }));
    assert.equal(features.codec.video, expected);
  }
});

test('G: unknown codec when no signal', () => {
  const features = extractQualityFeatures(candidate({ release: { codec: null }, filename: 'Movie.mkv' }));
  assert.equal(features.codec.video, 'unknown');
});

// ===========================================================================
// H. Container derivation
// ===========================================================================

test('H: derive container from extension', () => {
  const cases = [
    ['Movie.mkv', 'mkv'],
    ['Movie.mp4', 'mp4'],
    ['Movie.m2ts', 'm2ts'],
    ['Movie.ts', 'ts'],
    ['Movie.avi', 'avi'],
  ];
  for (const [filename, expected] of cases) {
    const features = extractQualityFeatures(candidate({ filename }));
    assert.equal(features.container.type, expected);
  }
});

test('H: unknown container when no extension', () => {
  const features = extractQualityFeatures(candidate({ filename: 'Movie' }));
  assert.equal(features.container.type, 'unknown');
});

test('H: do NOT infer container from codec/source', () => {
  // Even if codec is x265 (common in mkv), container must come from extension
  const features = extractQualityFeatures(candidate({ release: { codec: 'x265' }, filename: 'Movie.mp4' }));
  assert.equal(features.container.type, 'mp4');
});

// ===========================================================================
// I. Persistence
// ===========================================================================

test('I: new row persists quality_features with version=1', () => {
  const dbPath = tempDbPath('persist');
  const cache = createDiscoveryCache({ dbPath });
  const ranked = {
    hash: 'A'.repeat(40),
    fileIndex: null,
    filename: 'Movie.2024.2160p.UHD.BluRay.x265-GROUP.mkv',
    score: 0.9,
    components: { relevance: 0.9, quality: 0.8, releaseConfidence: 0.7, identityConfidence: 0.9, providerAvailability: 0.8, episodeMatch: 0 },
    contributions: {},
    sources: [],
    providerObservations: [],
    hasLiveDiscovery: true,
    justification: { scoreBreakdown: {}, weights: {}, historicalPrior: 0, freshProviderAvailability: 0.8 },
    identity: { tier: 'verified', confidence: 0.9, evidence: [], eligible: true },
    release: { resolution: '2160p', source_type: 'BluRay', codec: 'x265', release_group: 'GROUP' },
    selectedFileSize: 25769803776,
  };
  const requestId = cache.persistMediaRequest(
    { mediaId: 'tt0000001', mediaType: 'movie' },
    [{ rank: 1, infoHash: ranked.hash, fileIndex: ranked.fileIndex, filename: ranked.filename, score: ranked.score, scoreBreakdown: ranked.justification.scoreBreakdown, identity: ranked.identity, release: ranked.release, sources: ranked.sources, selectedFileSize: ranked.selectedFileSize, justification: ranked.justification, components: ranked.components, contributions: ranked.contributions, providerObservations: ranked.providerObservations, hasLiveDiscovery: ranked.hasLiveDiscovery }],
  );
  const qf = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  assert.ok(qf, 'quality features API must return an object');
  assert.equal(qf.available, true);
  assert.equal(qf.version, QUALITY_FEATURES_VERSION);
  assert.ok(qf.features);
  assert.equal(qf.features.resolution.label, '2160p');
  assert.equal(qf.features.source.type, 'bluray');
  assert.equal(qf.features.codec.video, 'hevc');
  assert.equal(qf.features.container.type, 'mkv');
  assert.equal(qf.features.releaseGroup.normalized, 'GROUP');
  // Cleanup
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

test('I: legacy row without quality_features reads as unavailable', () => {
  const dbPath = tempDbPath('legacy');
  const cache = createDiscoveryCache({ dbPath });
  // Insert a row directly without quality_features
  const info = cache.db.prepare(`
    INSERT INTO media_requests (media_id, media_type, candidate_count, created_at)
    VALUES ('tt0000002', 'movie', 1, ?)
  `).run(Date.now());
  const requestId = info.lastInsertRowid;
  cache.db.prepare(`
    INSERT INTO media_request_results (request_id, rank, info_hash, file_index_key, filename, score, eligible)
    VALUES (?, 1, ?, -1, 'legacy.mkv', 0.5, 1)
  `).run(requestId, 'B'.repeat(40));
  const qf = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  assert.ok(qf);
  assert.equal(qf.available, false);
  assert.equal(qf.features, null);
  // Cleanup
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

// ===========================================================================
// J. Write path
// ===========================================================================

test('J: quality features captured from SAME candidate that produced ranked row', () => {
  const dbPath = tempDbPath('write-path');
  const cache = createDiscoveryCache({ dbPath });
  const ranked = {
    hash: 'C'.repeat(40),
    fileIndex: null,
    filename: 'Dune.2024.2160p.WEB-DL.DDP5.1.x265-NTb.mkv',
    score: 0.85,
    components: { relevance: 0.8, quality: 0.75, releaseConfidence: 0.7, identityConfidence: 0.85, providerAvailability: 0.6, episodeMatch: 0 },
    contributions: {},
    sources: [],
    providerObservations: [],
    hasLiveDiscovery: true,
    justification: { scoreBreakdown: {}, weights: {}, historicalPrior: 0, freshProviderAvailability: 0.6 },
    identity: { tier: 'provider-confirmed', confidence: 0.85, evidence: [], eligible: true },
    release: { resolution: '2160p', source_type: 'WEB-DL', codec: 'x265', release_group: 'NTb' },
    selectedFileSize: 17179869184,
  };
  const requestId = cache.persistMediaRequest(
    { mediaId: 'tt0000003', mediaType: 'movie' },
    [{ rank: 1, infoHash: ranked.hash, fileIndex: ranked.fileIndex, filename: ranked.filename, score: ranked.score, scoreBreakdown: ranked.justification.scoreBreakdown, identity: ranked.identity, release: ranked.release, sources: ranked.sources, selectedFileSize: ranked.selectedFileSize, justification: ranked.justification, components: ranked.components, contributions: ranked.contributions, providerObservations: ranked.providerObservations, hasLiveDiscovery: ranked.hasLiveDiscovery }],
  );
  const qf = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  assert.equal(qf.features.resolution.label, '2160p');
  assert.equal(qf.features.source.type, 'web-dl');
  assert.equal(qf.features.codec.video, 'hevc');
  assert.equal(qf.features.releaseGroup.normalized, 'NTb');
  // Cleanup
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

test('J: no re-query, no re-rank — score unchanged', () => {
  const dbPath = tempDbPath('no-rerank');
  const cache = createDiscoveryCache({ dbPath });
  const ranked = {
    hash: 'D'.repeat(40),
    fileIndex: null,
    filename: 'Movie.1080p.mkv',
    score: 0.75,
    components: { relevance: 0.7, quality: 0.6, releaseConfidence: 0.5, identityConfidence: 0.7, providerAvailability: 0.4, episodeMatch: 0 },
    contributions: {},
    sources: [],
    providerObservations: [],
    hasLiveDiscovery: true,
    justification: { scoreBreakdown: {}, weights: {}, historicalPrior: 0, freshProviderAvailability: 0.4 },
    identity: { tier: 'probable', confidence: 0.7, evidence: [], eligible: true },
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x264', release_group: 'SPARK' },
    selectedFileSize: 8589934592,
  };
  const requestId = cache.persistMediaRequest(
    { mediaId: 'tt0000004', mediaType: 'movie' },
    [{ rank: 1, infoHash: ranked.hash, fileIndex: ranked.fileIndex, filename: ranked.filename, score: ranked.score, scoreBreakdown: ranked.justification.scoreBreakdown, identity: ranked.identity, release: ranked.release, sources: ranked.sources, selectedFileSize: ranked.selectedFileSize, justification: ranked.justification, components: ranked.components, contributions: ranked.contributions, providerObservations: ranked.providerObservations, hasLiveDiscovery: ranked.hasLiveDiscovery }],
  );
  const results = cache.getMediaRequestResults(requestId);
  assert.equal(results[0].score, 0.75);
  // Cleanup
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

// ===========================================================================
// K. Analytics read API
// ===========================================================================

test('K: distribution aggregation works', () => {
  const dbPath = tempDbPath('dist');
  const cache = createDiscoveryCache({ dbPath });
  const mkRanked = (infoHash, filename, release, size) => ({
    rank: 1, infoHash, fileIndex: null, filename, score: 0.8,
    components: { relevance: 0.8, quality: 0.7, releaseConfidence: 0.6, identityConfidence: 0.8, providerAvailability: 0.5, episodeMatch: 0 },
    contributions: {}, sources: [], providerObservations: [], hasLiveDiscovery: true,
    justification: { scoreBreakdown: {}, weights: {}, historicalPrior: 0, freshProviderAvailability: 0.5 },
    identity: { tier: 'verified', confidence: 0.8, evidence: [], eligible: true },
    release, selectedFileSize: size,
  });
  const results = [
    { ...mkRanked('A'.repeat(40), 'Movie1.2160p.BluRay.x265-GRP.mkv', { resolution: '2160p', source_type: 'BluRay', codec: 'x265', release_group: 'GRP' }, 25769803776), rank: 1 },
    { ...mkRanked('B'.repeat(40), 'Movie2.1080p.WEB-DL.x264-YTS.mkv', { resolution: '1080p', source_type: 'WEB-DL', codec: 'x264', release_group: 'YTS' }, 1401946675), rank: 2 },
    { ...mkRanked('C'.repeat(40), 'Movie3.1080p.BluRay.x264-FLUX.mkv', { resolution: '1080p', source_type: 'BluRay', codec: 'x264', release_group: 'FLUX' }, 8589934592), rank: 3 },
  ];
  const requestId = cache.persistMediaRequest({ mediaId: 'tt0000005', mediaType: 'movie' }, results);
  const dist = cache.getQualityFeatureDistribution();
  assert.ok(dist);
  assert.equal(dist.total, 3);
  assert.equal(dist.resolution['2160p'], 1);
  assert.equal(dist.resolution['1080p'], 2);
  assert.equal(dist.source['bluray'], 2);
  assert.equal(dist.source['web-dl'], 1);
  assert.equal(dist.codec['hevc'], 1);
  assert.equal(dist.codec['h264'], 2);
  assert.equal(dist.releaseGroup['YTS'], 1);
  assert.equal(dist.releaseGroup['FLUX'], 1);
  assert.equal(dist.releaseGroup['GRP'], 1);
  assert.equal(dist.withExactSize, 3);
  assert.ok(dist.sizeStats['1080p']);
  assert.equal(dist.sizeStats['1080p'].count, 2);
  // Cleanup
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

test('K: distribution returns NULL when no quality features', () => {
  const dbPath = tempDbPath('dist-empty');
  const cache = createDiscoveryCache({ dbPath });
  const dist = cache.getQualityFeatureDistribution();
  assert.equal(dist, null);
  // Cleanup
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

// ===========================================================================
// M. YIFY / small-release case
// ===========================================================================

test('M: YIFY small encode vs larger BluRay — features differ, NO ranking difference', () => {
  const yify = extractQualityFeatures(candidate({
    release: { resolution: '1080p', source_type: 'WEB-DL', codec: 'x264', release_group: 'YIFY' },
    filename: 'Movie.2024.1080p.WEB-DL.x264-YIFY.mkv',
    selectedFileSize: 1401946675, // ~1.3 GiB
  }));
  const bluray = extractQualityFeatures(candidate({
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x265', release_group: 'SPREBBLE' },
    filename: 'Movie.2024.1080p.BluRay.x265-SPREBBLE.mkv',
    selectedFileSize: 12884901888, // 12 GiB
  }));
  // Features differ materially
  assert.notEqual(yify.size.bytes, bluray.size.bytes);
  assert.notEqual(yify.source.type, bluray.source.type);
  assert.notEqual(yify.codec.video, bluray.codec.video);
  assert.notEqual(yify.releaseGroup.normalized, bluray.releaseGroup.normalized);
  // Both 1080p
  assert.equal(yify.resolution.label, '1080p');
  assert.equal(bluray.resolution.label, '1080p');
  // NO quality_score field — this slice does not compute one
  assert.equal(yify.quality_score, undefined);
  assert.equal(bluray.quality_score, undefined);
});

// ===========================================================================
// N. Determinism
// ===========================================================================

test('N1: same candidate → byte-identical quality feature JSON', () => {
  const c = candidate();
  const f1 = extractQualityFeatures(c);
  const f2 = extractQualityFeatures(c);
  assert.equal(serializeQualityFeatures(f1), serializeQualityFeatures(f2));
});

test('N2: candidate ordering does not affect per-candidate features', () => {
  const c1 = candidate({ filename: 'A.2160p.mkv', selectedFileSize: 25769803776 });
  const c2 = candidate({ filename: 'B.1080p.mkv', selectedFileSize: 8589934592 });
  const alone = [extractQualityFeatures(c1)];
  const withOther = [extractQualityFeatures(c2), extractQualityFeatures(c1)];
  assert.equal(
    serializeQualityFeatures(alone[0]),
    serializeQualityFeatures(withOther[1]),
  );
});

test('N3: unknown values stay null/unknown', () => {
  const features = extractQualityFeatures(candidate({ release: { resolution: null, source_type: null, codec: null, release_group: null }, filename: 'Movie', selectedFileSize: null }));
  assert.equal(features.resolution.label, 'unknown');
  assert.equal(features.resolution.width, null);
  assert.equal(features.resolution.height, null);
  assert.equal(features.source.type, 'unknown');
  assert.equal(features.codec.video, 'unknown');
  assert.equal(features.container.type, 'unknown');
  assert.equal(features.releaseGroup.raw, null);
  assert.equal(features.releaseGroup.normalized, null);
  assert.equal(features.size.bytes, null);
  assert.equal(features.size.bytesPerMinute, null);
});

test('N4: releaseGroup normalization is deterministic', () => {
  for (let i = 0; i < 10; i++) {
    const features = extractQualityFeatures(candidate({ release: { release_group: '-DON.' } }));
    assert.equal(features.releaseGroup.normalized, 'DON');
  }
});

test('N5: codec normalization deterministic', () => {
  for (let i = 0; i < 10; i++) {
    const features = extractQualityFeatures(candidate({ release: { codec: 'x265' } }));
    assert.equal(features.codec.video, 'hevc');
  }
});

test('N6: container from path deterministic', () => {
  for (let i = 0; i < 10; i++) {
    const features = extractQualityFeatures(candidate({ filename: 'Movie.mkv' }));
    assert.equal(features.container.type, 'mkv');
  }
});

test('N7: runtime-normalized size deterministic', () => {
  for (let i = 0; i < 10; i++) {
    const features = extractQualityFeatures(candidate({ selectedFileSize: 6442450944 }), { runtimeMinutes: 120 });
    assert.equal(features.size.bytesPerMinute, Math.round(6442450944 / 120));
  }
});

test('N8: no provider URL/token/auth enters feature snapshot', () => {
  const features = extractQualityFeatures(candidate());
  const json = serializeQualityFeatures(features);
  assert.ok(!json.includes('magnet'));
  assert.ok(!json.includes('token'));
  assert.ok(!json.includes('apiKey'));
  assert.ok(!json.includes('provider'));
});

test('N9: old row without quality_features still reads', () => {
  const dbPath = tempDbPath('old-row');
  const cache = createDiscoveryCache({ dbPath });
  const info = cache.db.prepare(`
    INSERT INTO media_requests (media_id, media_type, candidate_count, created_at)
    VALUES ('tt0000009', 'movie', 1, ?)
  `).run(Date.now());
  const requestId = info.lastInsertRowid;
  cache.db.prepare(`
    INSERT INTO media_request_results (request_id, rank, info_hash, file_index_key, filename, score, eligible)
    VALUES (?, 1, ?, -1, 'old.mkv', 0.5, 1)
  `).run(requestId, 'E'.repeat(40));
  const qf = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  assert.ok(qf);
  assert.equal(qf.available, false);
  assert.equal(qf.features, null);
  // Cleanup
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

test('N10: new row persists version=1', () => {
  const dbPath = tempDbPath('version');
  const cache = createDiscoveryCache({ dbPath });
  const ranked = {
    hash: 'F'.repeat(40), fileIndex: null, filename: 'Movie.1080p.mkv', score: 0.8,
    components: { relevance: 0.8, quality: 0.7, releaseConfidence: 0.6, identityConfidence: 0.8, providerAvailability: 0.5, episodeMatch: 0 },
    contributions: {}, sources: [], providerObservations: [], hasLiveDiscovery: true,
    justification: { scoreBreakdown: {}, weights: {}, historicalPrior: 0, freshProviderAvailability: 0.5 },
    identity: { tier: 'verified', confidence: 0.8, evidence: [], eligible: true },
    release: { resolution: '1080p', source_type: 'BluRay', codec: 'x264', release_group: 'TEST' },
    selectedFileSize: 8589934592,
  };
  const requestId = cache.persistMediaRequest(
    { mediaId: 'tt0000010', mediaType: 'movie' },
    [{ rank: 1, infoHash: ranked.hash, fileIndex: ranked.fileIndex, filename: ranked.filename, score: ranked.score, scoreBreakdown: ranked.justification.scoreBreakdown, identity: ranked.identity, release: ranked.release, sources: ranked.sources, selectedFileSize: ranked.selectedFileSize, justification: ranked.justification, components: ranked.components, contributions: ranked.contributions, providerObservations: ranked.providerObservations, hasLiveDiscovery: ranked.hasLiveDiscovery }],
  );
  const qf = cache.getMediaRequestResultQualityFeatures(requestId, 1);
  assert.equal(qf.version, 1);
  // Cleanup
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

// ===========================================================================
// O. Non-goals
// ===========================================================================

test('O: no quality_score in feature snapshot', () => {
  const features = extractQualityFeatures(candidate());
  assert.equal(features.quality_score, undefined);
  assert.equal(features.qualityScore, undefined);
});

test('O: no release-group reliability weights', () => {
  const features = extractQualityFeatures(candidate({ release: { release_group: 'YIFY' } }));
  assert.equal(features.releaseGroup.reliability, undefined);
  assert.equal(features.releaseGroup.weight, undefined);
});

test('O: no provider state in features', () => {
  const features = extractQualityFeatures(candidate());
  assert.equal(features.provider, undefined);
  assert.equal(features.cached, undefined);
  assert.equal(features.availability, undefined);
});
