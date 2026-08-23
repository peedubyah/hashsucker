/**
 * Corpus Confidence Feature Projection Tests
 *
 * Proves:
 *   - Identity: same hash different file indexes remain separate
 *   - Identity: null file index remains distinct from index 0
 *   - Confidence: highly persistent clean movie = high confidence
 *   - Confidence: new corpus entry = lower persistence confidence
 *   - Confidence: topology with sample files emits warning
 *   - Confidence: missing metadata applies penalty
 *   - Confidence: complete metadata increases metadata confidence
 *   - Math: weighted score is exact deterministic result
 *   - Math: deterministic output for same identity
 *   - Isolation: no provider data accessed
 *   - Graceful: missing evidence returns safe defaults
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createEvidenceProjection } from '../src/lib/discovery/evidence-projection.js';
import { createCorpusVersionRegistry } from '../src/lib/discovery/corpus-versioning.js';
import { createCorpusConfidenceFeatures } from '../src/lib/discovery/corpus-confidence-features.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';

function setup() {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);
  const confidence = createCorpusConfidenceFeatures({ cache, versions });
  return { cache, evidence, versions, confidence };
}

function registerVersion(versions, source, version, observedAt) {
  return versions.registerCorpusVersion({
    corpusSource: source,
    corpusVersion: version,
    observedAt,
  }).version;
}

function observe(evidence, { infoHash, fileIndex = null, observedAt, source = 'dmm', versionId }) {
  evidence.appendCorpusObservation({
    infoHash,
    fileIndex,
    observedAt,
    source,
    corpusVersionId: versionId,
  });
}

function insertCandidate(cache, { infoHash, fileIndex = null, filename, size = null }) {
  const fileIndexKey = fileIndex == null ? -1 : fileIndex;
  const now = Date.now();
  cache.db.prepare(`
    INSERT INTO candidates (info_hash, file_index, file_index_key, filename, size, first_seen, last_seen, metadata, sources)
    VALUES (@info_hash, @file_index, @file_index_key, @filename, @size, @first_seen, @last_seen, '{}', '[]')
  `).run({
    info_hash: infoHash,
    file_index: fileIndex,
    file_index_key: fileIndexKey,
    filename,
    size,
    first_seen: now,
    last_seen: now,
  });
}

function insertReleaseAttribute(cache, {
  infoHash,
  fileIndex = null,
  mediaType = null,
  season = null,
  resolution = null,
  codec = null,
  audio = null,
  sourceType = null,
  releaseGroup = null,
  language = null,
}) {
  const fileIndexKey = fileIndex == null ? -1 : fileIndex;
  cache.db.prepare(`
    INSERT INTO release_attributes (info_hash, file_index_key, source, filename, confidence, media_type, season, resolution, codec, audio, source_type, release_group, language, parsed_at)
    VALUES (@info_hash, @file_index_key, 'test', @filename, 0.5, @media_type, @season, @resolution, @codec, @audio, @source_type, @release_group, @language, @parsed_at)
  `).run({
    info_hash: infoHash,
    file_index_key: fileIndexKey,
    filename: 'test-release',
    media_type: mediaType,
    season,
    resolution,
    codec,
    audio,
    source_type: sourceType,
    release_group: releaseGroup,
    language,
    parsed_at: Date.now(),
  });
}

// =============================================================================
// Identity Tests
// =============================================================================

test('same hash different file indexes remain separate', () => {
  const { cache, confidence } = setup();

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1000000 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 1, filename: 'movie2.mkv', size: 500000 });

  const result0 = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });
  const result1 = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 1 });

  assert.equal(result0.identity.fileIndex, 0);
  assert.equal(result1.identity.fileIndex, 1);
  assert.equal(result0.identity.fileIndexKey, 0);
  assert.equal(result1.identity.fileIndexKey, 1);
});

test('null file index remains distinct from index 0', () => {
  const { cache, confidence } = setup();

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: null, filename: 'info.nfo', size: 100 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1000000 });

  const resultNull = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: null });
  const result0 = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  assert.equal(resultNull.identity.fileIndex, null);
  assert.equal(result0.identity.fileIndex, 0);
  assert.equal(resultNull.identity.fileIndexKey, -1);
  assert.equal(result0.identity.fileIndexKey, 0);
});

// =============================================================================
// Confidence Tests
// =============================================================================

test('highly persistent clean movie has high confidence', () => {
  const { cache, evidence, versions, confidence } = setup();

  // Register multiple versions
  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);
  const v3 = registerVersion(versions, 'dmm', 'commit-c', 1_700_000_200_000);

  // Observed in all versions (persistent) - fileIndex 0 matches query
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_100_000, versionId: v2.id });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_200_000, versionId: v3.id });

  // Clean single video file (good topology)
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 4_500_000_000 });

  // Complete metadata
  insertReleaseAttribute(cache, {
    infoHash: HASH_A,
    mediaType: 'movie',
    resolution: '1080p',
    codec: 'x264',
    audio: 'AAC',
    sourceType: 'BluRay',
    releaseGroup: 'SPARK',
    language: 'English',
  });

  const result = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  // Should have high overall confidence
  assert.ok(result.confidence.overall > 0.5, 'overall confidence should be > 0.5');
  assert.ok(result.confidence.components.persistence > 0.7, 'persistence should be high');
  assert.ok(result.confidence.components.topology > 0.5, 'topology should be decent');
  assert.ok(result.confidence.components.metadata > 0.7, 'metadata should be high');
  assert.equal(result.warnings.length, 0, 'no warnings expected');
});

test('new corpus entry has lower persistence confidence', () => {
  const { cache, evidence, versions, confidence } = setup();

  // Register multiple versions
  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);
  const v3 = registerVersion(versions, 'dmm', 'commit-c', 1_700_000_200_000);

  // Only observed in latest version (new entry) - fileIndex 0 matches query
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_200_000, versionId: v3.id });

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 4_500_000_000 });

  const result = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  // Persistence should be low (1/3 survival rate)
  assert.ok(result.confidence.components.persistence < 0.5, 'persistence should be low for new entry');
  assert.ok(result.warnings.includes('corpus_not_persistent'), 'should warn about low persistence');
});

test('topology with sample files emits warning', () => {
  const { cache, confidence } = setup();

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'Movie.mkv', size: 4_500_000_000 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 1, filename: 'Sample/Movie.Sample.mkv', size: 25_000_000 });

  const result = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  assert.ok(result.warnings.includes('sample_present'), 'should warn about sample files');
});

test('missing metadata applies penalty', () => {
  const { cache, confidence } = setup();

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 4_500_000_000 });

  const result = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  assert.equal(result.confidence.components.metadata, 0.0, 'metadata confidence should be 0');
  assert.ok(result.warnings.includes('missing_metadata'), 'should warn about missing metadata');
});

test('complete metadata increases metadata confidence', () => {
  const { cache, confidence } = setup();

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 4_500_000_000 });

  insertReleaseAttribute(cache, {
    infoHash: HASH_A,
    mediaType: 'movie',
    resolution: '1080p',
    codec: 'x264',
    audio: 'AAC',
    sourceType: 'BluRay',
    releaseGroup: 'SPARK',
    language: 'English',
  });

  const result = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  // All 8 metadata fields populated => 1.0
  assert.equal(result.confidence.components.metadata, 1.0, 'metadata confidence should be 1.0');
});

// =============================================================================
// Math Tests
// =============================================================================

test('weighted score math is exact deterministic result', () => {
  const { cache, evidence, versions, confidence } = setup();

  // Persistence: present in 3/3 versions
  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);
  const v3 = registerVersion(versions, 'dmm', 'commit-c', 1_700_000_200_000);

  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_100_000, versionId: v2.id });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_200_000, versionId: v3.id });

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 4_500_000_000 });

  insertReleaseAttribute(cache, {
    infoHash: HASH_A,
    mediaType: 'movie',
    resolution: '1080p',
    codec: 'x264',
    audio: 'AAC',
    sourceType: 'BluRay',
    releaseGroup: 'SPARK',
    language: 'English',
  });

  const result = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  // Verify the weighted calculation
  const expected = Math.round((
    result.confidence.components.persistence * 0.40 +
    result.confidence.components.topology * 0.40 +
    result.confidence.components.metadata * 0.20
  ) * 10000) / 10000;

  assert.equal(result.confidence.overall, expected, 'overall should equal weighted sum of components');
});

test('deterministic output for same identity', () => {
  const { cache, confidence } = setup();

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 4_500_000_000 });

  const result1 = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });
  const result2 = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  assert.deepEqual(result1, result2);
});

// =============================================================================
// Isolation Tests
// =============================================================================

test('no provider data accessed', () => {
  const { cache, confidence } = setup();

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 4_500_000_000 });

  // Add provider observation (should not affect confidence)
  cache.db.prepare(`
    INSERT INTO provider_observations (info_hash, file_index, file_index_key, provider, cached, checked_at)
    VALUES (@info_hash, @file_index, @file_index_key, @provider, @cached, @checked_at)
  `).run({
    info_hash: HASH_A,
    file_index: 0,
    file_index_key: 0,
    provider: 'torbox',
    cached: 1,
    checked_at: Date.now(),
  });

  const result = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  // Result should not contain any provider observation data
  assert.deepEqual(result.evidence.metadata.releaseAttributes, []);
  assert.equal(result.confidence.components.metadata, 0.0);
});

// =============================================================================
// Graceful Defaults Tests
// =============================================================================

test('missing evidence returns safe defaults', () => {
  const { confidence } = setup();

  // No candidate, no observations, no attributes
  const result = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  assert.deepEqual(result.identity, {
    infoHash: HASH_A,
    fileIndex: 0,
    fileIndexKey: 0,
  });
  assert.ok(result.confidence.overall >= 0 && result.confidence.overall <= 1);
  assert.ok(result.confidence.components.persistence >= 0 && result.confidence.components.persistence <= 1);
  assert.ok(result.confidence.components.topology >= 0 && result.confidence.components.topology <= 1);
  assert.equal(result.confidence.components.metadata, 0.0);
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.warnings.includes('no_files'));
  assert.ok(result.warnings.includes('missing_metadata'));
});

test('multiple video candidates emits warning', () => {
  const { cache, confidence } = setup();

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie1.mkv', size: 4_500_000_000 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 1, filename: 'movie2.mkv', size: 4_200_000_000 });

  const result = confidence.getCandidateConfidenceFeatures({ infoHash: HASH_A, fileIndex: 0 });

  assert.ok(result.warnings.includes('multiple_video_candidates'), 'should warn about multiple video files');
});
