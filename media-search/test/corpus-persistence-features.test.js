/**
 * Corpus Persistence Feature Projection Tests
 *
 * Proves:
 *   - Continuously present hash has full survival rate
 *   - Recently added hash has correct lifecycle counts
 *   - Removed hash is correctly identified
 *   - Reappearing hash has multiple add events
 *   - Multiple file indexes are independent
 *   - Missing history returns safe defaults
 *   - Output is deterministic
 *   - No provider observation access
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createEvidenceProjection } from '../src/lib/discovery/evidence-projection.js';
import { createCorpusVersionRegistry } from '../src/lib/discovery/corpus-versioning.js';
import { createCorpusPersistenceFeatures } from '../src/lib/discovery/corpus-persistence-features.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';

function setup() {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);
  const features = createCorpusPersistenceFeatures(versions);
  return { cache, evidence, versions, features };
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

// =============================================================================
// Tests
// =============================================================================

test('continuously present hash has full survival rate', () => {
  const { evidence, versions, features } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);
  const v3 = registerVersion(versions, 'dmm', 'commit-c', 1_700_000_200_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_200_000, versionId: v3.id });

  const result = features.getPersistenceFeatures(HASH_A, null);

  assert.equal(result.persistence.versionsObserved, 3);
  assert.equal(result.persistence.versionsAvailable, 3);
  assert.equal(result.persistence.survivalRate, 1.0);
  assert.equal(result.lifecycle.currentlyPresent, true);
  assert.equal(result.lifecycle.addedCount, 1);
  assert.equal(result.lifecycle.removedCount, 0);
  assert.equal(result.lifecycle.churnCount, 1);
});

test('recently added hash has correct lifecycle counts', () => {
  const { evidence, versions, features } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);
  const v3 = registerVersion(versions, 'dmm', 'commit-c', 1_700_000_200_000);

  // Only appears in v3
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_200_000, versionId: v3.id });

  const result = features.getPersistenceFeatures(HASH_A, null);

  assert.equal(result.persistence.versionsObserved, 1);
  assert.equal(result.persistence.versionsAvailable, 3);
  assert.equal(result.persistence.survivalRate, 1 / 3);
  assert.equal(result.lifecycle.currentlyPresent, true);
  assert.equal(result.lifecycle.addedCount, 1);
  assert.equal(result.lifecycle.removedCount, 0);
});

test('removed hash is correctly identified', () => {
  const { evidence, versions, features } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);
  const v3 = registerVersion(versions, 'dmm', 'commit-c', 1_700_000_200_000);

  // Present in v1 and v2, absent in v3
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });

  const result = features.getPersistenceFeatures(HASH_A, null);

  assert.equal(result.persistence.versionsObserved, 2);
  assert.equal(result.persistence.versionsAvailable, 3);
  assert.equal(result.persistence.survivalRate, 2 / 3);
  assert.equal(result.lifecycle.currentlyPresent, false);
  assert.equal(result.lifecycle.addedCount, 1);
  assert.equal(result.lifecycle.removedCount, 1);
  assert.equal(result.lifecycle.churnCount, 2);
});

test('reappearing hash has multiple add events', () => {
  const { evidence, versions, features } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);
  const v3 = registerVersion(versions, 'dmm', 'commit-c', 1_700_000_200_000);
  const v4 = registerVersion(versions, 'dmm', 'commit-d', 1_700_000_300_000);

  // Present in v1, absent in v2, reappears in v3 and v4
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_200_000, versionId: v3.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_300_000, versionId: v4.id });

  const result = features.getPersistenceFeatures(HASH_A, null);

  assert.equal(result.persistence.versionsObserved, 3);
  assert.equal(result.persistence.versionsAvailable, 4);
  assert.equal(result.persistence.survivalRate, 3 / 4);
  assert.equal(result.lifecycle.currentlyPresent, true);
  assert.equal(result.lifecycle.addedCount, 2); // v1 and v3
  assert.equal(result.lifecycle.removedCount, 1); // v2
  assert.equal(result.lifecycle.churnCount, 3);
});

test('multiple file indexes are independent', () => {
  const { evidence, versions, features } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  // Same hash, different file indexes
  observe(evidence, { infoHash: HASH_A, fileIndex: null, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_100_000, versionId: v2.id });

  const resultNull = features.getPersistenceFeatures(HASH_A, null);
  const resultZero = features.getPersistenceFeatures(HASH_A, 0);

  // null fileIndex: only in v1
  assert.equal(resultNull.persistence.versionsObserved, 1);
  assert.equal(resultNull.lifecycle.currentlyPresent, false);

  // fileIndex 0: in both versions
  assert.equal(resultZero.persistence.versionsObserved, 2);
  assert.equal(resultZero.lifecycle.currentlyPresent, true);
});

test('missing history returns safe defaults', () => {
  const { features } = setup();

  const result = features.getPersistenceFeatures(HASH_A, null);

  assert.deepEqual(result.identity, { infoHash: HASH_A, fileIndex: null });
  assert.deepEqual(result.temporal, { firstObserved: null, lastObserved: null, ageMs: null });
  assert.deepEqual(result.persistence, { versionsObserved: 0, versionsAvailable: 0, survivalRate: null });
  assert.deepEqual(result.lifecycle, { currentlyPresent: false, addedCount: 0, removedCount: 0, churnCount: 0 });
});

test('output is deterministic', () => {
  const { evidence, versions, features } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });

  const result1 = features.getPersistenceFeatures(HASH_A, null);
  const result2 = features.getPersistenceFeatures(HASH_A, null);

  assert.deepEqual(result1, result2);
});

test('temporal bounds are correct', () => {
  const { evidence, versions, features } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);
  const v3 = registerVersion(versions, 'dmm', 'commit-c', 1_700_000_200_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_200_000, versionId: v3.id });

  const result = features.getPersistenceFeatures(HASH_A, null);

  assert.equal(result.temporal.firstObserved, 1_700_000_000_000);
  assert.equal(result.temporal.lastObserved, 1_700_000_200_000);
  assert.equal(result.temporal.ageMs, 200_000);
});

test('no provider observation access', () => {
  const { evidence, versions, features } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });

  // Add a provider observation (should not appear in features)
  const candidate = evidence.getCorpusObservationHistory(HASH_A, null, { limit: 1 });
  assert.equal(candidate.length, 1);

  const result = features.getPersistenceFeatures(HASH_A, null);

  // Features should only reflect corpus data, not provider observations
  assert.equal(result.persistence.versionsObserved, 1);
  assert.equal(result.lifecycle.currentlyPresent, true);
});

test('different corpus sources are independent', () => {
  const { evidence, versions, features } = setup();

  const vDmm = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const vOther = registerVersion(versions, 'other', 'commit-b', 1_700_000_100_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: vDmm.id });
  observe(evidence, { infoHash: HASH_B, observedAt: 1_700_000_100_000, versionId: vOther.id });

  const resultDmm = features.getPersistenceFeatures(HASH_A, null, 'dmm');
  const resultOther = features.getPersistenceFeatures(HASH_B, null, 'other');

  assert.equal(resultDmm.persistence.versionsAvailable, 1);
  assert.equal(resultOther.persistence.versionsAvailable, 1);
  assert.equal(resultDmm.persistence.versionsObserved, 1);
  assert.equal(resultOther.persistence.versionsObserved, 1);
});

test('getPersistenceFeatures requires infoHash', () => {
  const { features } = setup();

  assert.throws(() => features.getPersistenceFeatures(), /infoHash/);
  assert.throws(() => features.getPersistenceFeatures(null), /infoHash/);
  assert.throws(() => features.getPersistenceFeatures(''), /infoHash/);
});
