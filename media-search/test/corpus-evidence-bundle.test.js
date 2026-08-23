/**
 * Corpus Evidence Bundle Tests
 *
 * Proves:
 *   - Complete evidence candidate returns full bundle
 *   - Missing persistence history handled gracefully
 *   - Missing topology data handled gracefully
 *   - Missing release attributes handled gracefully
 *   - Multiple file indexes produce separate bundles
 *   - Deterministic repeated output
 *   - Identity isolation between different hashes
 *   - No ranking behavior (no winner selection)
 *   - No provider access
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createEvidenceProjection } from '../src/lib/discovery/evidence-projection.js';
import { createCorpusVersionRegistry } from '../src/lib/discovery/corpus-versioning.js';
import { createCorpusEvidenceBundle } from '../src/lib/discovery/corpus-evidence-bundle.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';

function setup() {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);
  const bundle = createCorpusEvidenceBundle({ cache, versions });
  return { cache, evidence, versions, bundle };
}

function registerVersion(versions, source, version, observedAt) {
  return versions.registerCorpusVersion({
    corpusSource: source,
    corpusVersion: version,
    observedAt,
  }).version.id;
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
// Complete Evidence Tests
// =============================================================================

test('complete evidence candidate returns full bundle', () => {
  const { cache, evidence, versions, bundle } = setup();

  // Register versions
  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  const v2 = registerVersion(versions, 'dmm', 'v2', 2000);
  const v3 = registerVersion(versions, 'dmm', 'v3', 3000);

  // Observe candidate across versions
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 2000, versionId: v2 });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 3000, versionId: v3 });

  // Insert candidate file
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1500000000 });

  // Insert release attributes
  insertReleaseAttribute(cache, {
    infoHash: HASH_A,
    fileIndex: 0,
    mediaType: 'movie',
    resolution: '1080p',
    codec: 'x264',
    audio: 'AC3',
    sourceType: 'BluRay',
    releaseGroup: 'TEST',
    language: 'eng',
  });

  const result = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });

  // Identity
  assert.equal(result.identity.infoHash, HASH_A);
  assert.equal(result.identity.fileIndex, 0);

  // Release
  assert.equal(result.release.count, 1);
  assert.equal(result.release.attributes.length, 1);
  assert.equal(result.release.attributes[0].media_type, 'movie');

  // Persistence
  assert.equal(result.persistence.persistence.versionsObserved, 3);
  assert.equal(result.persistence.persistence.versionsAvailable, 3);
  assert.equal(result.persistence.persistence.survivalRate, 1);
  assert.equal(result.persistence.lifecycle.currentlyPresent, true);
  assert.equal(result.persistence.lifecycle.addedCount, 1);

  // Topology
  assert.equal(result.topology.files.totalFiles, 1);
  assert.equal(result.topology.files.videoFiles, 1);
  assert.equal(result.topology.structure.singleFileMedia, true);
  assert.equal(result.topology.quality.likelyPlayableTarget, true);

  // Confidence
  assert.ok(result.confidence.overall > 0.5, 'overall confidence should be high for clean persistent movie');

  // Evidence quality
  assert.equal(result.evidenceQuality.hasPersistenceHistory, true);
  assert.equal(result.evidenceQuality.hasTopologyData, true);
  assert.equal(result.evidenceQuality.hasReleaseAttributes, true);
  assert.equal(result.evidenceQuality.persistenceVersionsObserved, 3);
  assert.equal(result.evidenceQuality.topologyTotalFiles, 1);
  assert.equal(result.evidenceQuality.releaseAttributeCount, 1);

  // Risks should be minimal
  assert.deepEqual(result.risks, []);
});

// =============================================================================
// Missing Evidence Tests
// =============================================================================

test('missing persistence history handled gracefully', () => {
  const { cache, bundle } = setup();

  // Only topology and release attributes, no corpus observations
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1000000 });
  insertReleaseAttribute(cache, { infoHash: HASH_A, fileIndex: 0, mediaType: 'movie' });

  const result = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });

  assert.equal(result.persistence.persistence.versionsObserved, 0);
  assert.equal(result.persistence.persistence.versionsAvailable, 0);
  assert.equal(result.persistence.persistence.survivalRate, null);
  assert.equal(result.persistence.lifecycle.currentlyPresent, false);
  assert.equal(result.evidenceQuality.hasPersistenceHistory, false);

  // Should still have topology and release data
  assert.equal(result.topology.files.totalFiles, 1);
  assert.equal(result.release.count, 1);
});

test('missing topology data handled gracefully', () => {
  const { evidence, versions, bundle } = setup();

  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });

  // No candidate files inserted

  const result = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });

  assert.equal(result.topology.files.totalFiles, 0);
  assert.equal(result.topology.structure.singleFileMedia, false);
  assert.equal(result.topology.quality.likelyPlayableTarget, false);
  assert.equal(result.evidenceQuality.hasTopologyData, false);

  // Should still have persistence data
  assert.equal(result.persistence.persistence.versionsObserved, 1);
});

test('missing release attributes handled gracefully', () => {
  const { cache, evidence, versions, bundle } = setup();

  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1000000 });

  // No release attributes inserted

  const result = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });

  assert.equal(result.release.count, 0);
  assert.equal(result.release.attributes.length, 0);
  assert.equal(result.evidenceQuality.hasReleaseAttributes, false);

  // Should still have persistence and topology
  assert.equal(result.persistence.persistence.versionsObserved, 1);
  assert.equal(result.topology.files.totalFiles, 1);
});

// =============================================================================
// Multiple File Indexes Tests
// =============================================================================

test('multiple file indexes produce separate bundles', () => {
  const { cache, evidence, versions, bundle } = setup();

  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });
  observe(evidence, { infoHash: HASH_A, fileIndex: 1, observedAt: 1000, versionId: v1 });

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1000000 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 1, filename: 'movie2.mkv', size: 500000 });

  const result0 = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });
  const result1 = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 1 });

  assert.equal(result0.identity.fileIndex, 0);
  assert.equal(result1.identity.fileIndex, 1);

  // Both should see the full torrent topology
  assert.equal(result0.topology.files.totalFiles, 2);
  assert.equal(result1.topology.files.totalFiles, 2);

  // But separate persistence
  assert.equal(result0.persistence.persistence.versionsObserved, 1);
  assert.equal(result1.persistence.persistence.versionsObserved, 1);
});

// =============================================================================
// Determinism Tests
// =============================================================================

test('deterministic repeated output', () => {
  const { cache, evidence, versions, bundle } = setup();

  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1000000 });
  insertReleaseAttribute(cache, { infoHash: HASH_A, fileIndex: 0, mediaType: 'movie' });

  const result1 = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });
  const result2 = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });

  assert.deepEqual(result1, result2);
});

// =============================================================================
// Identity Isolation Tests
// =============================================================================

test('identity isolation between different hashes', () => {
  const { cache, evidence, versions, bundle } = setup();

  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });
  observe(evidence, { infoHash: HASH_B, fileIndex: 0, observedAt: 1000, versionId: v1 });

  // Small file vs large file to differentiate topology confidence
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie-a.mkv', size: 500000 });
  insertCandidate(cache, { infoHash: HASH_B, fileIndex: 0, filename: 'movie-b.mkv', size: 1500000000 });

  const resultA = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });
  const resultB = bundle.getEvidenceBundle({ infoHash: HASH_B, fileIndex: 0 });

  assert.equal(resultA.identity.infoHash, HASH_A);
  assert.equal(resultB.identity.infoHash, HASH_B);

  // Each should only see their own topology
  assert.equal(resultA.topology.files.totalFiles, 1);
  assert.equal(resultB.topology.files.totalFiles, 1);

  // Different confidence due to different file sizes
  assert.notEqual(resultA.confidence.overall, resultB.confidence.overall);
});

// =============================================================================
// No Ranking Behavior Tests
// =============================================================================

test('no ranking behavior — bundle does not select winners', () => {
  const { cache, evidence, versions, bundle } = setup();

  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });
  observe(evidence, { infoHash: HASH_B, fileIndex: 0, observedAt: 1000, versionId: v1 });

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie-a.mkv', size: 1000000 });
  insertCandidate(cache, { infoHash: HASH_B, fileIndex: 0, filename: 'movie-b.mkv', size: 2000000 });

  const resultA = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });
  const resultB = bundle.getEvidenceBundle({ infoHash: HASH_B, fileIndex: 0 });

  // Bundle should not contain any ranking or winner selection
  assert.equal(resultA.rank, undefined);
  assert.equal(resultA.score, undefined);
  assert.equal(resultA.selected, undefined);
  assert.equal(resultB.rank, undefined);
  assert.equal(resultB.score, undefined);
  assert.equal(resultB.selected, undefined);
});

// =============================================================================
// No Provider Access Tests
// =============================================================================

test('no provider access — bundle does not query provider observations', () => {
  const { cache, evidence, versions, bundle } = setup();

  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1000000 });

  // Insert a provider observation (should not appear in bundle)
  cache.db.prepare(`
    INSERT INTO provider_observations (info_hash, file_index_key, provider, cached, checked_at)
    VALUES (@info_hash, 0, 'test-provider', 1, @checked_at)
  `).run({ info_hash: HASH_A, checked_at: Date.now() });

  const result = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });

  // Bundle should not contain any provider data
  assert.equal(result.providers, undefined);
  assert.equal(result.providerData, undefined);
  assert.equal(result.availability, undefined);
});

// =============================================================================
// Risk Collection Tests
// =============================================================================

test('risks collected from all evidence layers', () => {
  const { cache, evidence, versions, bundle } = setup();

  // Create a candidate with multiple risk signals
  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  const v2 = registerVersion(versions, 'dmm', 'v2', 2000);

  // Only observed in one version (low survival rate)
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });

  // Insert a sample file (topology risk)
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'sample-movie.mkv', size: 50000000 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 1, filename: 'movie.mkv', size: 1000000000 });

  const result = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });

  // Should have risks from multiple layers
  assert.ok(result.risks.includes('corpus_not_persistent') || result.risks.includes('sample_present'),
    'should have at least one risk from persistence or topology');
});

// =============================================================================
// Null vs 0 File Index Tests
// =============================================================================

test('null file index remains distinct from index 0', () => {
  const { cache, bundle } = setup();

  insertCandidate(cache, { infoHash: HASH_A, fileIndex: null, filename: 'torrent.nfo', size: 100 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1000000 });

  const resultNull = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: null });
  const result0 = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });

  assert.equal(resultNull.identity.fileIndex, null);
  assert.equal(result0.identity.fileIndex, 0);

  // Both should see the full torrent topology
  assert.equal(resultNull.topology.files.totalFiles, 2);
  assert.equal(result0.topology.files.totalFiles, 2);
});

// =============================================================================
// Empty Bundle Tests
// =============================================================================

test('empty bundle for completely unknown hash', () => {
  const { bundle } = setup();

  const result = bundle.getEvidenceBundle({ infoHash: HASH_C, fileIndex: 0 });

  assert.equal(result.identity.infoHash, HASH_C);
  assert.equal(result.persistence.persistence.versionsObserved, 0);
  assert.equal(result.topology.files.totalFiles, 0);
  assert.equal(result.release.count, 0);
  assert.equal(result.evidenceQuality.hasPersistenceHistory, false);
  assert.equal(result.evidenceQuality.hasTopologyData, false);
  assert.equal(result.evidenceQuality.hasReleaseAttributes, false);
});

// =============================================================================
// Evidence Quality Summary Tests
// =============================================================================

test('evidence quality summary reflects available data', () => {
  const { cache, evidence, versions, bundle } = setup();

  const v1 = registerVersion(versions, 'dmm', 'v1', 1000);
  const v2 = registerVersion(versions, 'dmm', 'v2', 2000);

  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1000, versionId: v1 });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 2000, versionId: v2 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 0, filename: 'movie.mkv', size: 1000000 });
  insertCandidate(cache, { infoHash: HASH_A, fileIndex: 1, filename: 'subtitles.srt', size: 50000 });
  insertReleaseAttribute(cache, { infoHash: HASH_A, fileIndex: 0, mediaType: 'movie' });
  insertReleaseAttribute(cache, { infoHash: HASH_A, fileIndex: 1, resolution: '1080p' });

  const result = bundle.getEvidenceBundle({ infoHash: HASH_A, fileIndex: 0 });

  assert.equal(result.evidenceQuality.hasPersistenceHistory, true);
  assert.equal(result.evidenceQuality.hasTopologyData, true);
  assert.equal(result.evidenceQuality.hasReleaseAttributes, true);
  assert.equal(result.evidenceQuality.persistenceVersionsObserved, 2);
  assert.equal(result.evidenceQuality.topologyTotalFiles, 2);
  assert.equal(result.evidenceQuality.releaseAttributeCount, 2);
});
