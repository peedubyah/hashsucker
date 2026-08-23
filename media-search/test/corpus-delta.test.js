/**
 * Corpus Delta Analysis Foundation Tests
 *
 * Proves:
 *   - Hashes appearing for the first time are detected as "added"
 *   - Hashes disappearing are detected as "removed"
 *   - Hashes persisting across versions are "unchanged"
 *   - Same hash with different file indexes are distinct identities
 *   - Identical versions produce an empty delta
 *   - Different corpus sources cannot be compared accidentally
 *   - Output ordering is deterministic
 *   - Missing versions are handled safely
 *   - No source data, candidates, or provider observations are modified
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createEvidenceProjection } from '../src/lib/discovery/evidence-projection.js';
import { createCorpusVersionRegistry } from '../src/lib/discovery/corpus-versioning.js';
import { createCorpusDelta } from '../src/lib/discovery/corpus-delta.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';
const HASH_D = 'dddddddddddddddddddddddddddddddddddddddd';

function setup() {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const evidence = createEvidenceProjection(cache);
  const versions = createCorpusVersionRegistry(evidence);
  const delta = createCorpusDelta(evidence);
  return { cache, evidence, versions, delta };
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

test('hash appears for first time between versions', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });

  const result = delta.computeDelta('dmm', 'commit-a', 'commit-b');

  assert.deepEqual(result.added, [{ infoHash: HASH_A, fileIndex: -1 }]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.unchanged, []);
});

test('hash disappears between versions', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });

  const result = delta.computeDelta('dmm', 'commit-a', 'commit-b');

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, [{ infoHash: HASH_A, fileIndex: -1 }]);
  assert.deepEqual(result.unchanged, []);
});

test('hash persists across versions as unchanged', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });

  const result = delta.computeDelta('dmm', 'commit-a', 'commit-b');

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.unchanged, [{ infoHash: HASH_A, fileIndex: -1 }]);
});

test('same hash with different file indexes are distinct identities', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  // v1: hash A with fileIndex null (-1) and fileIndex 0
  observe(evidence, { infoHash: HASH_A, fileIndex: null, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_000_000, versionId: v1.id });

  // v2: hash A with fileIndex null (-1) only — fileIndex 0 removed
  observe(evidence, { infoHash: HASH_A, fileIndex: null, observedAt: 1_700_000_100_000, versionId: v2.id });

  const result = delta.computeDelta('dmm', 'commit-a', 'commit-b');

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, [{ infoHash: HASH_A, fileIndex: 0 }]);
  assert.deepEqual(result.unchanged, [{ infoHash: HASH_A, fileIndex: -1 }]);
});

test('identical versions produce empty delta', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_B, observedAt: 1_700_000_000_000, versionId: v1.id });

  const result = delta.computeDelta('dmm', 'commit-a', 'commit-a');

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.unchanged, [
    { infoHash: HASH_A, fileIndex: -1 },
    { infoHash: HASH_B, fileIndex: -1 },
  ]);
});

test('different corpus sources cannot be compared accidentally', () => {
  const { evidence, versions, delta } = setup();

  const vDmm = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const vOther = registerVersion(versions, 'other', 'commit-b', 1_700_000_100_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: vDmm.id });
  observe(evidence, { infoHash: HASH_B, observedAt: 1_700_000_100_000, versionId: vOther.id });

  // Comparing dmm commit-a to other commit-b: no overlap because source differs
  const result = delta.computeDelta('dmm', 'commit-a', 'commit-b');

  // commit-b doesn't exist in 'dmm' source, so toVersion is empty
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, [{ infoHash: HASH_A, fileIndex: -1 }]);
  assert.deepEqual(result.unchanged, []);
});

test('output ordering is deterministic', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  // Insert in non-sorted order
  observe(evidence, { infoHash: HASH_D, observedAt: 1_700_000_100_000, versionId: v2.id });
  observe(evidence, { infoHash: HASH_B, observedAt: 1_700_000_100_000, versionId: v2.id });
  observe(evidence, { infoHash: HASH_C, observedAt: 1_700_000_100_000, versionId: v2.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });

  const result = delta.computeDelta('dmm', 'commit-a', 'commit-b');

  const hashes = result.added.map((e) => e.infoHash);
  const sorted = [...hashes].sort();
  assert.deepEqual(hashes, sorted, 'added list must be sorted by infoHash');

  // Run again — must be identical
  const result2 = delta.computeDelta('dmm', 'commit-a', 'commit-b');
  assert.deepEqual(result, result2, 'delta must be deterministic across calls');
});

test('missing versions produce safe empty results', () => {
  const { delta } = setup();

  // Neither version exists
  const result = delta.computeDelta('dmm', 'nonexistent-a', 'nonexistent-b');

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.unchanged, []);
  assert.equal(result.source, 'dmm');
  assert.equal(result.fromVersion, 'nonexistent-a');
  assert.equal(result.toVersion, 'nonexistent-b');
});

test('mixed added, removed, and unchanged in single delta', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  // v1: A, B
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_B, observedAt: 1_700_000_000_000, versionId: v1.id });

  // v2: A (unchanged), C (added) — B removed
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });
  observe(evidence, { infoHash: HASH_C, observedAt: 1_700_000_100_000, versionId: v2.id });

  const result = delta.computeDelta('dmm', 'commit-a', 'commit-b');

  assert.deepEqual(result.added, [{ infoHash: HASH_C, fileIndex: -1 }]);
  assert.deepEqual(result.removed, [{ infoHash: HASH_B, fileIndex: -1 }]);
  assert.deepEqual(result.unchanged, [{ infoHash: HASH_A, fileIndex: -1 }]);
});

test('observations without corpus_version_id are excluded from delta', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  // Linked to versions
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });

  // Unlinked observation (no version) — should not appear in delta
  evidence.appendCorpusObservation({
    infoHash: HASH_B,
    observedAt: 1_700_000_000_000,
    source: 'dmm',
    // corpusVersionId intentionally omitted
  });

  const result = delta.computeDelta('dmm', 'commit-a', 'commit-b');

  // HASH_B has no version link, so it cannot be in any delta
  const allKeys = [...result.added, ...result.removed, ...result.unchanged];
  assert.ok(!allKeys.some((k) => k.infoHash === HASH_B),
    'unlinked observations must not appear in delta');

  // HASH_A is unchanged
  assert.deepEqual(result.unchanged, [{ infoHash: HASH_A, fileIndex: -1 }]);
});

test('getVersionKeys returns distinct keys for a version', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);

  observe(evidence, { infoHash: HASH_A, fileIndex: null, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, fileIndex: null, observedAt: 1_700_000_000_000, versionId: v1.id }); // duplicate

  const keys = delta.getVersionKeys('dmm', 'commit-a');

  assert.equal(keys.length, 2);
  assert.deepEqual(keys, [
    { infoHash: HASH_A, fileIndex: -1 },
    { infoHash: HASH_A, fileIndex: 0 },
  ]);
});

test('delta preserves fileIndex null vs 0 distinction', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  // v1: null fileIndex only
  observe(evidence, { infoHash: HASH_A, fileIndex: null, observedAt: 1_700_000_000_000, versionId: v1.id });

  // v2: fileIndex 0 only — different identity
  observe(evidence, { infoHash: HASH_A, fileIndex: 0, observedAt: 1_700_000_100_000, versionId: v2.id });

  const result = delta.computeDelta('dmm', 'commit-a', 'commit-b');

  assert.deepEqual(result.added, [{ infoHash: HASH_A, fileIndex: 0 }]);
  assert.deepEqual(result.removed, [{ infoHash: HASH_A, fileIndex: -1 }]);
  assert.deepEqual(result.unchanged, []);
});

test('computeDelta requires all parameters', () => {
  const { delta } = setup();

  assert.throws(() => delta.computeDelta(), /corpusSource/);
  assert.throws(() => delta.computeDelta('dmm'), /fromVersion/);
  assert.throws(() => delta.computeDelta('dmm', 'a'), /toVersion/);
});

test('no source data is mutated by delta computation', () => {
  const { evidence, versions, delta } = setup();

  const v1 = registerVersion(versions, 'dmm', 'commit-a', 1_700_000_000_000);
  const v2 = registerVersion(versions, 'dmm', 'commit-b', 1_700_000_100_000);

  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_000_000, versionId: v1.id });
  observe(evidence, { infoHash: HASH_A, observedAt: 1_700_000_100_000, versionId: v2.id });

  // Snapshot counts before
  const obsBefore = evidence.countCorpusObservations(HASH_A, null);
  const versionsBefore = versions.countVersions('dmm');

  delta.computeDelta('dmm', 'commit-a', 'commit-b');

  // Snapshot counts after — must be unchanged
  const obsAfter = evidence.countCorpusObservations(HASH_A, null);
  const versionsAfter = versions.countVersions('dmm');

  assert.equal(obsAfter, obsBefore, 'observation count must not change');
  assert.equal(versionsAfter, versionsBefore, 'version count must not change');
});
