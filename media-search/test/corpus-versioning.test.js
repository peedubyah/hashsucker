/**
 * Corpus Versioning and Delta Ingestion Foundation Tests
 *
 * Proves:
 * - Distinct corpus versions remain separate from ingestion runs
 * - Repeated ingestion of same corpus version does not create false persistence
 * - Hash appearing across multiple versions can be queried
 * - Hash introduction version can be identified
 * - Missing corpus version metadata is handled safely
 * - Existing candidate/provider observation behavior is unchanged
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createEvidenceProjection } from '../src/lib/discovery/evidence-projection.js';
import { createCorpusVersionRegistry } from '../src/lib/discovery/corpus-versioning.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

// =============================================================================
// Version registration
// =============================================================================

test('registerCorpusVersion creates a new version with required fields', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  const before = Date.now();
  const result = versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'abc123def456',
    observedAt: 1_700_000_000_000,
  });

  assert.equal(result.created, true);
  assert.equal(result.version.corpusSource, 'dmm');
  assert.equal(result.version.corpusVersion, 'abc123def456');
  assert.equal(result.version.observedAt, 1_700_000_000_000);
  assert.ok(result.version.recordedAt >= before);
  assert.equal(result.version.fragmentCount, 0);
  assert.equal(result.version.recordCount, 0);

  cache.close();
});

test('registerCorpusVersion is idempotent — duplicate returns existing version', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  const result1 = versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'abc123',
    observedAt: 1_700_000_000_000,
  });
  assert.equal(result1.created, true);

  const result2 = versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'abc123',
    observedAt: 1_700_000_000_000,
  });
  assert.equal(result2.created, false, 'second registration should not create');
  assert.equal(result2.version.id, result1.version.id, 'should return same version');

  cache.close();
});

test('registerCorpusVersion requires corpusSource, corpusVersion, observedAt', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  assert.throws(
    () => versions.registerCorpusVersion({ corpusVersion: 'abc', observedAt: 1000 }),
    /requires corpusSource/
  );
  assert.throws(
    () => versions.registerCorpusVersion({ corpusSource: 'dmm', observedAt: 1000 }),
    /requires corpusVersion/
  );
  assert.throws(
    () => versions.registerCorpusVersion({ corpusSource: 'dmm', corpusVersion: 'abc' }),
    /requires observedAt/
  );

  cache.close();
});

test('distinct corpus versions remain separate even with same ingestion_id', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  const v1 = versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'sha-v1',
    observedAt: 1_700_000_000_000,
    ingestionId: 'run-1',
  });

  const v2 = versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'sha-v2',
    observedAt: 1_700_000_100_000,
    ingestionId: 'run-1', // Same ingestion run, different corpus version
  });

  assert.notEqual(v1.version.id, v2.version.id);
  assert.equal(versions.countVersions('dmm'), 2);

  cache.close();
});

// =============================================================================
// Fragment registration
// =============================================================================

test('registerFragment associates fragments with a version', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  const v = versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'sha-v1',
    observedAt: 1_700_000_000_000,
  });

  const frag = versions.registerFragment({
    corpusVersionId: v.version.id,
    fragmentId: 'fragment-001.html',
    fragmentSha: 'blob-sha-123',
    recordCount: 1000,
  });

  assert.equal(frag.corpusVersionId, v.version.id);
  assert.equal(frag.fragmentId, 'fragment-001.html');
  assert.equal(frag.fragmentSha, 'blob-sha-123');
  assert.equal(frag.recordCount, 1000);

  const fragments = versions.getFragments(v.version.id);
  assert.equal(fragments.length, 1);

  cache.close();
});

test('registerFragment requires corpusVersionId and fragmentId', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  assert.throws(
    () => versions.registerFragment({ fragmentId: 'frag-1' }),
    /requires corpusVersionId/
  );
  assert.throws(
    () => versions.registerFragment({ corpusVersionId: 1 }),
    /requires fragmentId/
  );

  cache.close();
});

// =============================================================================
// Version queries
// =============================================================================

test('getVersionHistory returns versions newest-first', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'sha-v1',
    observedAt: 1_700_000_000_000,
  });
  versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'sha-v2',
    observedAt: 1_700_000_100_000,
  });
  versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'sha-v3',
    observedAt: 1_700_000_200_000,
  });

  const history = versions.getVersionHistory('dmm');
  assert.equal(history.length, 3);
  assert.equal(history[0].corpusVersion, 'sha-v3');
  assert.equal(history[1].corpusVersion, 'sha-v2');
  assert.equal(history[2].corpusVersion, 'sha-v1');

  cache.close();
});

test('getVersionByIngestion finds version for an ingestion run', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  versions.registerCorpusVersion({
    corpusSource: 'dmm',
    corpusVersion: 'sha-v1',
    observedAt: 1_700_000_000_000,
    ingestionId: 'run-2026-08-23',
  });

  const found = versions.getVersionByIngestion('run-2026-08-23');
  assert.ok(found);
  assert.equal(found.corpusVersion, 'sha-v1');

  const notFound = versions.getVersionByIngestion('nonexistent-run');
  assert.equal(notFound, null);

  cache.close();
});

// =============================================================================
// Candidate version persistence
// =============================================================================

test('getCandidateVersions returns all versions that observed a candidate', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  // Register three corpus versions
  const v1 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000,
  });
  const v2 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v2', observedAt: 20_000,
  });
  const v3 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v3', observedAt: 30_000,
  });

  // Add observations linking candidate to versions
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm', corpusVersionId: v1.version.id,
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 20_000, source: 'dmm', corpusVersionId: v2.version.id,
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 30_000, source: 'dmm', corpusVersionId: v3.version.id,
  });

  const candidateVersions = versions.getCandidateVersions(HASH, null);
  assert.equal(candidateVersions.length, 3);
  assert.equal(candidateVersions[0].corpusVersion, 'sha-v1');
  assert.equal(candidateVersions[1].corpusVersion, 'sha-v2');
  assert.equal(candidateVersions[2].corpusVersion, 'sha-v3');

  cache.close();
});

test('getCandidateFirstVersion identifies which snapshot introduced a hash', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  const v1 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000,
  });
  const v2 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v2', observedAt: 20_000,
  });
  const v3 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v3', observedAt: 30_000,
  });

  // Hash appears in v2 and v3 (not v1)
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 20_000, source: 'dmm', corpusVersionId: v2.version.id,
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 30_000, source: 'dmm', corpusVersionId: v3.version.id,
  });

  const firstVersion = versions.getCandidateFirstVersion(HASH, null);
  assert.ok(firstVersion);
  assert.equal(firstVersion.corpusVersion, 'sha-v2', 'v2 introduced the hash');

  cache.close();
});

test('getCandidateLastVersion identifies most recent presence', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  const v1 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000,
  });
  const v2 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v2', observedAt: 20_000,
  });
  const v3 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v3', observedAt: 30_000,
  });

  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm', corpusVersionId: v1.version.id,
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 20_000, source: 'dmm', corpusVersionId: v2.version.id,
  });
  // Not in v3 — hash disappeared

  const lastVersion = versions.getCandidateLastVersion(HASH, null);
  assert.ok(lastVersion);
  assert.equal(lastVersion.corpusVersion, 'sha-v2', 'v2 is last version with hash');

  cache.close();
});

test('getCandidateVersionPersistence answers "did hash survive multiple updates?"', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  const v1 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000,
  });
  const v2 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v2', observedAt: 20_000,
  });
  const v3 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v3', observedAt: 30_000,
  });

  // HASH appears in all three versions
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm', corpusVersionId: v1.version.id,
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 20_000, source: 'dmm', corpusVersionId: v2.version.id,
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 30_000, source: 'dmm', corpusVersionId: v3.version.id,
  });

  const persistence = versions.getCandidateVersionPersistence(HASH, null);
  assert.equal(persistence.versionCount, 3);
  assert.equal(persistence.persistedAcrossVersions, true);
  assert.equal(persistence.firstVersion.corpusVersion, 'sha-v1');
  assert.equal(persistence.lastVersion.corpusVersion, 'sha-v3');

  cache.close();
});

test('single version means hash did not persist across versions', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  const v1 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000,
  });

  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm', corpusVersionId: v1.version.id,
  });

  const persistence = versions.getCandidateVersionPersistence(HASH, null);
  assert.equal(persistence.versionCount, 1);
  assert.equal(persistence.persistedAcrossVersions, false);

  cache.close();
});

// =============================================================================
// Repeated ingestion of same version does NOT create false persistence
// =============================================================================

test('re-registering same version does not increase version count', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  // First ingestion run
  const r1 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000, ingestionId: 'run-1',
  });
  assert.equal(r1.created, true);

  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm', corpusVersionId: r1.version.id,
  });

  // Second ingestion run — same corpus version (no change)
  const r2 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000, ingestionId: 'run-2',
  });
  assert.equal(r2.created, false, 'should not create duplicate version');

  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm', corpusVersionId: r2.version.id,
  });

  // Version count is still 1
  assert.equal(versions.countVersions('dmm'), 1);

  const persistence = versions.getCandidateVersionPersistence(HASH, null);
  assert.equal(persistence.versionCount, 1, 'same version does not inflate persistence');
  assert.equal(persistence.persistedAcrossVersions, false);

  cache.close();
});

test('multiple ingestion runs with distinct versions creates real persistence', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  // Run 1: version A
  const v1 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-A', observedAt: 10_000, ingestionId: 'run-1',
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm', corpusVersionId: v1.version.id,
  });

  // Run 2: version B (new version)
  const v2 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-B', observedAt: 20_000, ingestionId: 'run-2',
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 20_000, source: 'dmm', corpusVersionId: v2.version.id,
  });

  // Run 3: version C (new version)
  const v3 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-C', observedAt: 30_000, ingestionId: 'run-3',
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 30_000, source: 'dmm', corpusVersionId: v3.version.id,
  });

  const persistence = versions.getCandidateVersionPersistence(HASH, null);
  assert.equal(persistence.versionCount, 3, '3 distinct versions');
  assert.equal(persistence.persistedAcrossVersions, true);
  assert.equal(versions.countVersions('dmm'), 3);

  cache.close();
});

// =============================================================================
// Missing corpus version metadata handled safely
// =============================================================================

test('observations without corpus_version_id still work', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  // Legacy observation — no corpusVersionId
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm',
  });

  const persistence = versions.getCandidateVersionPersistence(HASH, null);
  assert.equal(persistence.versionCount, 0, 'no version link = no version count');
  assert.equal(persistence.firstVersion, null);
  assert.equal(persistence.lastVersion, null);

  cache.close();
});

test('getCandidateVersions returns empty array for unknown candidate', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  const result = versions.getCandidateVersions('nonexistent', null);
  assert.deepEqual(result, []);

  const first = versions.getCandidateFirstVersion('nonexistent', null);
  assert.equal(first, null);

  const last = versions.getCandidateLastVersion('nonexistent', null);
  assert.equal(last, null);

  cache.close();
});

test('getVersionedObservationHistory handles missing version gracefully', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  // Observation without version
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm',
  });

  const history = versions.getVersionedObservationHistory(HASH, null);
  assert.equal(history.length, 1);
  assert.equal(history[0].version, null, 'version is null when not linked');

  cache.close();
});

test('getVersionedObservationHistory includes version when linked', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  const v = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000,
  });

  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm', corpusVersionId: v.version.id,
  });

  const history = versions.getVersionedObservationHistory(HASH, null);
  assert.equal(history.length, 1);
  assert.ok(history[0].version);
  assert.equal(history[0].version.corpusVersion, 'sha-v1');

  cache.close();
});

// =============================================================================
// Existing candidate/provider observation behavior unchanged
// =============================================================================

test('existing candidate behavior unchanged by versioning', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  // Add candidate without any corpus version
  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  const candidate = cache.getCandidate(HASH, null);
  assert.ok(candidate);
  assert.equal(candidate.title, 'Test');

  // Candidate fields unchanged
  assert.equal(candidate.firstSeen, 1000);
  assert.equal(candidate.lastSeen, 5000);

  cache.close();
});

test('existing provider observation behavior unchanged by versioning', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  // Add provider observation
  cache.recordProviderObservation(HASH, null, 'torbox', {
    cached: true,
    checkedAt: Date.now(),
  });

  // Corpus observation with version
  const v = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000,
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm', corpusVersionId: v.version.id,
  });

  // Provider observations unchanged
  const providerObs = cache.getProviderObservations(HASH, null);
  assert.equal(providerObs.length, 1);
  assert.equal(providerObs[0].provider, 'torbox');

  // Corpus observations separate
  const corpusObs = evidence.getCorpusObservationHistory(HASH, null);
  assert.equal(corpusObs.length, 1);
  assert.equal(corpusObs[0].corpusVersionId, v.version.id);

  cache.close();
});

test('existing evidence projection tests still work (backward compat)', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  // These calls match the existing evidence-projection.test.js patterns
  evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: null,
    observedAt: 10_000,
    source: 'dmm-hashlist',
  });

  const count = evidence.countCorpusObservations(HASH, null);
  assert.equal(count, 1);

  const history = evidence.getCorpusObservationHistory(HASH, null);
  assert.equal(history[0].observedAt, 10_000);
  assert.equal(history[0].corpusVersionId, null, 'no version by default');

  // Candidate timeline still works
  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });
  const timeline = evidence.getCandidateTimeline(HASH, null);
  assert.ok(timeline);
  assert.equal(timeline.corpusObservationCount, 1);

  cache.close();
});

// =============================================================================
// Identity separation
// =============================================================================

test('version persistence respects candidate identity (same hash, different fileIndex)', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, fileIndex: 0, title: 'File 0', firstSeen: 1000, lastSeen: 5000 });
  cache.upsertCandidate({ infoHash: HASH, fileIndex: 1, title: 'File 1', firstSeen: 1000, lastSeen: 5000 });

  const v1 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000,
  });
  const v2 = versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v2', observedAt: 20_000,
  });

  // Only fileIndex 0 has observations
  evidence.appendCorpusObservation({
    infoHash: HASH, fileIndex: 0, observedAt: 10_000, source: 'dmm', corpusVersionId: v1.version.id,
  });
  evidence.appendCorpusObservation({
    infoHash: HASH, fileIndex: 0, observedAt: 20_000, source: 'dmm', corpusVersionId: v2.version.id,
  });

  const persistence0 = versions.getCandidateVersionPersistence(HASH, 0);
  assert.equal(persistence0.versionCount, 2);
  assert.equal(persistence0.persistedAcrossVersions, true);

  const persistence1 = versions.getCandidateVersionPersistence(HASH, 1);
  assert.equal(persistence1.versionCount, 0);
  assert.equal(persistence1.persistedAcrossVersions, false);

  cache.close();
});

// =============================================================================
// Multi-source corpus versions
// =============================================================================

test('different corpus sources maintain separate version histories', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);

  cache.upsertCandidate({ infoHash: HASH, title: 'Test', firstSeen: 1000, lastSeen: 5000 });

  versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v1', observedAt: 10_000,
  });
  versions.registerCorpusVersion({
    corpusSource: 'dmm', corpusVersion: 'sha-v2', observedAt: 20_000,
  });
  versions.registerCorpusVersion({
    corpusSource: 'scraper', corpusVersion: 'scrape-001', observedAt: 15_000,
  });

  assert.equal(versions.countVersions('dmm'), 2);
  assert.equal(versions.countVersions('scraper'), 1);

  const dmmHistory = versions.getVersionHistory('dmm');
  assert.equal(dmmHistory.length, 2);

  const scraperHistory = versions.getVersionHistory('scraper');
  assert.equal(scraperHistory.length, 1);

  cache.close();
});
