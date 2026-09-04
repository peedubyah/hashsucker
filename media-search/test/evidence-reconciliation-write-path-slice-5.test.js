/**
 * Provider Evidence Reconciliation — Write-Path Proof (Slice 5)
 *
 * Proves the storage-layer side of the spec:
 *
 *   E. Write-path hardening
 *     - INSERT OR REPLACE / UPSERT that destroys prior known evidence is
 *       forbidden.
 *     - A fresh transient (state=error|unknown) MUST NOT overwrite a
 *       known current state (state=cached|uncached).
 *     - Fresh known vs fresh known of opposite sign: the newer wins.
 *
 *   H. Request snapshot interaction
 *     - Reconciliation changes do NOT mutate old media_request_results
 *       evidence snapshots.
 *
 * The cache write-path test uses an in-memory discovery cache to keep
 * the test self-contained. The request-snapshot immutability test
 * inserts a request + result with a slice-4 evidence snapshot, then
 * records a transient error, then proves the snapshot is unchanged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiscoveryCache,
  buildEvidenceSnapshot,
} from '../src/lib/discovery/cache.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);

function obs(input) {
  return {
    provider: 'torbox',
    accountScope: 'default',
    subjectKey: input.infoHash,
    fileIndexKey: input.fileIndex ?? -1,
    kind: 'authoritative',
    state: 'cached',
    source: 'unit-test',
    errorCategory: null,
    ...input,
  };
}

// ===========================================================================
// E. Write-path preservation
// ===========================================================================

test('E.1: known cached survives a fresh transient unknown at the current layer', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();

  cache.appendProviderObservation(obs({
    infoHash: HASH_A, fileIndex: null,
    state: 'cached',
    observedAt: now - 5000,
    expiresAt: now + 60000,
  }));
  // Now a fresh transient error happens 1 second later.
  cache.appendProviderObservation(obs({
    infoHash: HASH_A, fileIndex: null,
    state: 'unknown',
    errorCategory: 'temporarily-unavailable',
    observedAt: now - 4000,
    expiresAt: now + 60000,
  }));

  const current = cache.getProviderObservations(HASH_A, null, { now, includeStale: true, kinds: ['authoritative'] });
  // We expect the current projection to STILL be cached, not unknown.
  const cachedRow = current.find((o) => o.state === 'cached');
  const unknownRow = current.find((o) => o.state === 'unknown');
  assert.ok(cachedRow, 'cached must survive a fresh transient unknown');
  assert.ok(!unknownRow, 'unknown must NOT overwrite the known cached current row');
});

test('E.2: known uncached survives a fresh transient error at the current layer', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();

  cache.appendProviderObservation(obs({
    infoHash: HASH_B, fileIndex: null,
    state: 'uncached',
    observedAt: now - 5000,
    expiresAt: now + 60000,
  }));
  cache.appendProviderObservation(obs({
    infoHash: HASH_B, fileIndex: null,
    state: 'error',
    errorCategory: 'unknown',
    observedAt: now - 4000,
    expiresAt: now + 60000,
  }));

  const current = cache.getProviderObservations(HASH_B, null, { now, includeStale: true, kinds: ['authoritative'] });
  const uncachedRow = current.find((o) => o.state === 'uncached');
  const errorRow = current.find((o) => o.state === 'error');
  assert.ok(uncachedRow, 'uncached must survive a fresh transient error');
  assert.ok(!errorRow, 'error must NOT overwrite the known uncached current row');
});

test('E.3: transient-then-known: known DOES overwrite transient at the current layer', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();

  // First a transient, then a known.
  cache.appendProviderObservation(obs({
    infoHash: HASH_C, fileIndex: null,
    state: 'unknown',
    errorCategory: 'temporarily-unavailable',
    observedAt: now - 5000,
    expiresAt: now + 60000,
  }));
  cache.appendProviderObservation(obs({
    infoHash: HASH_C, fileIndex: null,
    state: 'cached',
    observedAt: now - 1000,
    expiresAt: now + 60000,
  }));

  const current = cache.getProviderObservations(HASH_C, null, { now, includeStale: true, kinds: ['authoritative'] });
  const cachedRow = current.find((o) => o.state === 'cached');
  const unknownRow = current.find((o) => o.state === 'unknown');
  assert.ok(cachedRow, 'fresh known cached SHOULD overwrite the prior transient unknown');
  assert.ok(!unknownRow);
});

test('E.4: known-vs-known of opposite sign: newer wins (per spec rule 1+2)', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();
  const HASH_D = 'd'.repeat(40);

  cache.appendProviderObservation(obs({
    infoHash: HASH_D, fileIndex: null,
    state: 'cached',
    observedAt: now - 5000,
    expiresAt: now + 60000,
  }));
  // Newer uncached.
  cache.appendProviderObservation(obs({
    infoHash: HASH_D, fileIndex: null,
    state: 'uncached',
    observedAt: now - 1000,
    expiresAt: now + 60000,
  }));

  const current = cache.getProviderObservations(HASH_D, null, { now, includeStale: true, kinds: ['authoritative'] });
  const uncachedRow = current.find((o) => o.state === 'uncached');
  const cachedRow = current.find((o) => o.state === 'cached');
  assert.ok(uncachedRow, 'newer uncached should win');
  assert.ok(!cachedRow, 'older cached should be replaced by the newer uncached');
});

test('E.4b: transient-vs-transient: newer transient overwrites older transient', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();
  const HASH_F = 'f'.repeat(40);

  cache.appendProviderObservation(obs({
    infoHash: HASH_F, fileIndex: null,
    state: 'unknown',
    errorCategory: 'temporarily-unavailable',
    observedAt: now - 5000,
    expiresAt: now + 60000,
  }));
  // Newer transient.
  cache.appendProviderObservation(obs({
    infoHash: HASH_F, fileIndex: null,
    state: 'error',
    errorCategory: 'unknown',
    observedAt: now - 1000,
    expiresAt: now + 60000,
  }));

  const current = cache.getProviderObservations(HASH_F, null, { now, includeStale: true, kinds: ['authoritative'] });
  const errorRow = current.find((o) => o.state === 'error');
  const unknownRow = current.find((o) => o.state === 'unknown');
  assert.ok(errorRow, 'newer error transient should overwrite the older unknown transient');
  assert.ok(!unknownRow);
});

test('E.5: history preserves the full event chain regardless of write-path gating', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();
  const HASH_E = 'e'.repeat(40);

  cache.appendProviderObservation(obs({
    infoHash: HASH_E, fileIndex: null,
    state: 'cached',
    observedAt: now - 5000,
    expiresAt: now + 60000,
  }));
  cache.appendProviderObservation(obs({
    infoHash: HASH_E, fileIndex: null,
    state: 'unknown',
    errorCategory: 'temporarily-unavailable',
    observedAt: now - 1000,
    expiresAt: now + 60000,
  }));

  // History MUST contain both events.
  const history = cache.getProviderObservationHistory(HASH_E, null, { now, limit: 100 });
  const states = new Set(history.map((h) => h.state));
  assert.ok(states.has('cached'), 'history must contain the cached event');
  assert.ok(states.has('unknown'), 'history must contain the unknown event');
  assert.ok(history.length >= 2, 'history must contain both events');
});

// ===========================================================================
// H. Request snapshot immutability
// ===========================================================================

test('H.1: media_request_results evidence snapshot is immutable under later observation writes', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();

  // Create a request + result with a slice-4-style evidence snapshot.
  const requestId = cache.persistMediaRequest(
    { mediaId: 'tmdb:99', mediaType: 'movie' },
    [{
      rank: 1,
      infoHash: HASH_A,
      fileIndex: null,
      filename: 'test.mkv',
      score: 0.9,
      scoreBreakdown: { components: [{ component: 'fresh', weight: 0.5 }] },
      identity: { tier: 'exact', confidence: 0.9, evidence: null, state: 'resolved' },
      release: { title: 'Test' },
      sources: ['unit-test'],
      observations: [],
      availability: {},
      selectedFileSize: null,
      justification: {
        summary: 'test-justification',
        scoreBreakdown: { components: [{ component: 'fresh', weight: 0.5 }] },
      },
      components: [{ component: 'fresh', weight: 0.5 }],
      contributions: [{ source: 'historical', contribution: 0.3 }],
      providerObservations: [
        { provider: 'torbox', state: 'cached', observedAt: now - 1000 },
      ],
      hasLiveDiscovery: false,
    }]
  );

  const before = cache.getMediaRequestResultEvidenceSnapshot(requestId, 1);
  assert.ok(before, 'snapshot must be readable');
  assert.equal(before.available, true);
  assert.equal(before.version, 1);
  const beforeSnapshotJson = JSON.stringify(before.snapshot);
  assert.equal(beforeSnapshotJson.length > 0, true, 'snapshot body must be non-empty');

  // Now record a transient error that DOES change the current layer.
  cache.appendProviderObservation(obs({
    infoHash: HASH_A, fileIndex: null,
    state: 'error',
    errorCategory: 'temporarily-unavailable',
    observedAt: now,
    expiresAt: now + 60000,
  }));

  // And a fresh negative uncached.
  cache.appendProviderObservation(obs({
    infoHash: HASH_A, fileIndex: null,
    state: 'uncached',
    observedAt: now + 1,
    expiresAt: now + 60001,
  }));

  // The persisted snapshot MUST be unchanged.
  const after = cache.getMediaRequestResultEvidenceSnapshot(requestId, 1);
  const afterSnapshotJson = JSON.stringify(after.snapshot);
  assert.equal(afterSnapshotJson, beforeSnapshotJson,
    'persisted snapshot must not change when later observations are written');
});
