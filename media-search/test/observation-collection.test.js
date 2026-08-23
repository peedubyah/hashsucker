import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectCandidateObservations,
  COLLECTION_STATUSES,
} from '../src/lib/acquisition/observation-collection.js';
import { createCacheObservation } from '../src/lib/providers/observations.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';

const NOW = 20_000;
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);

// ---------------------------------------------------------------------------
// Mock provider capability — records calls, returns configured observations.
// ---------------------------------------------------------------------------

function createMockProvider(observationsByHash, options = {}) {
  const recordedCalls = [];
  return {
    getCalls() { return recordedCalls; },
    async observeCache(subjects) {
      recordedCalls.push(subjects);
      return subjects.map(({ infoHash }) => {
        const key = infoHash.toLowerCase();
        const configured = observationsByHash.get(key);
        if (configured) return configured;
        // Default: unknown observation
        return createCacheObservation({
          provider: 'mock',
          accountScope: 'default',
          scope: 'torrent',
          infoHash: key,
          fileIndex: null,
          kind: 'authoritative',
          state: options.defaultState ?? 'unknown',
          observedAt: NOW - 1_000,
          expiresAt: NOW + 5_000,
          source: 'mock-provider',
        });
      });
    },
  };
}

function candidate(fileIndex = 0, infoHash = HASH_A) {
  return createReleaseIdentity(infoHash, fileIndex);
}

function torrentObservation(infoHash, state = 'cached') {
  return createCacheObservation({
    provider: 'mock',
    accountScope: 'default',
    scope: 'torrent',
    infoHash,
    fileIndex: null,
    kind: 'authoritative',
    state,
    observedAt: NOW - 1_000,
    expiresAt: NOW + 5_000,
    source: 'mock-provider',
    ...(state === 'error' ? { errorCategory: 'unknown' } : {}),
  });
}

// ---------------------------------------------------------------------------
// Slice 2C — Batched provider cache observation collection
// ---------------------------------------------------------------------------

test('ranked candidates preserve ordering in projections', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
    [HASH_B, torrentObservation(HASH_B, 'uncached')],
    [HASH_C, torrentObservation(HASH_C, 'cached')],
  ]));

  const candidates = [candidate(null, HASH_A), candidate(null, HASH_B), candidate(null, HASH_C)];
  const result = await collectCandidateObservations({
    candidates,
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  assert.equal(result.projections.length, 3);
  assert.equal(result.projections[0].candidate.infoHash, HASH_A);
  assert.equal(result.projections[1].candidate.infoHash, HASH_B);
  assert.equal(result.projections[2].candidate.infoHash, HASH_C);
});

test('candidate window limit — only first maxCandidates inspected', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
    [HASH_B, torrentObservation(HASH_B, 'cached')],
    [HASH_C, torrentObservation(HASH_C, 'cached')],
  ]));

  const candidates = [candidate(null, HASH_A), candidate(null, HASH_B), candidate(null, HASH_C)];
  const result = await collectCandidateObservations({
    candidates,
    providerCapability: provider,
    now: NOW,
    maxCandidates: 2,
  });

  assert.equal(result.projections.length, 2);
  assert.equal(result.projections[0].candidate.infoHash, HASH_A);
  assert.equal(result.projections[1].candidate.infoHash, HASH_B);
});

test('duplicate info hashes deduplicated in provider query', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
    [HASH_B, torrentObservation(HASH_B, 'cached')],
  ]));

  // Three candidates: two share HASH_A, one has HASH_B
  const candidates = [
    candidate(null, HASH_A),
    candidate(0, HASH_A),  // Same hash, different fileIndex
    candidate(null, HASH_B),
  ];
  await collectCandidateObservations({
    candidates,
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  const calls = provider.getCalls();
  assert.equal(calls.length, 1);
  // Only 2 unique hashes in the query
  assert.equal(calls[0].length, 2);
  assert.deepEqual(calls[0].map((s) => s.infoHash).sort(), [HASH_A, HASH_B]);
});

test('shared torrent hash preserves multiple candidates in projections', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
  ]));

  // Two candidates sharing same hash but different fileIndex
  const candidateA = candidate(0, HASH_A);
  const candidateB = candidate(7, HASH_A);
  const result = await collectCandidateObservations({
    candidates: [candidateA, candidateB],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  // Both candidates get their own projection (not collapsed)
  assert.equal(result.projections.length, 2);
  assert.equal(result.projections[0].candidate.fileIndex, 0);
  assert.equal(result.projections[1].candidate.fileIndex, 7);
});

test('batch provider call receives unique hashes (not one per candidate)', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
    [HASH_B, torrentObservation(HASH_B, 'cached')],
  ]));

  // 4 candidates, 2 unique hashes
  const candidates = [
    candidate(null, HASH_A),
    candidate(null, HASH_A),
    candidate(null, HASH_B),
    candidate(null, HASH_B),
  ];
  await collectCandidateObservations({
    candidates,
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  const calls = provider.getCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
});

test('cached observation preserved through projection', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
  ]));

  const result = await collectCandidateObservations({
    candidates: [candidate(null, HASH_A)],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  const proj = result.projections[0];
  assert.equal(proj.status, 'projected');
  assert.equal(proj.observation.state, 'cached');
  assert.equal(proj.observation.infoHash, HASH_A);
  assert.equal(proj.observation.scope, 'torrent');
});

test('unknown/error observation preserved (not converted to uncached)', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'unknown')],
    [HASH_B, torrentObservation(HASH_B, 'error')],
  ]));

  const result = await collectCandidateObservations({
    candidates: [candidate(null, HASH_A), candidate(null, HASH_B)],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  // Both should be projected (they're torrent candidates with torrent observations)
  // but their states are preserved as-is
  assert.equal(result.projections[0].observation.state, 'unknown');
  assert.equal(result.projections[1].observation.state, 'error');
});

test('torrent candidate accepted when observation is cached', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
  ]));

  const result = await collectCandidateObservations({
    candidates: [candidate(null, HASH_A)],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  const proj = result.projections[0];
  assert.equal(proj.status, 'projected');
  assert.equal(proj.candidate.fileIndex, null);
  assert.equal(proj.observation.state, 'cached');
});

test('file candidate does not receive unauthorized torrent evidence', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
  ]));

  // File candidate (fileIndex=0) with torrent-scoped observation
  const result = await collectCandidateObservations({
    candidates: [candidate(0, HASH_A)],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  const proj = result.projections[0];
  assert.equal(proj.status, 'rejected');
  assert.equal(proj.reason, 'torrent-scope-file-candidate');
  assert.equal(proj.candidate.fileIndex, 0);
});

test('empty candidates → empty result with deterministic status', async () => {
  const provider = createMockProvider(new Map());

  const result = await collectCandidateObservations({
    candidates: [],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  assert.equal(result.status, COLLECTION_STATUSES.EMPTY);
  assert.equal(result.projections.length, 0);
  assert.equal(result.observations.length, 0);
  assert.equal(result.queries.length, 0);
  assert.ok(Object.isFrozen(result));
});

test('missing hash on candidate → throws TypeError', async () => {
  const provider = createMockProvider(new Map());

  await assert.rejects(
    () => collectCandidateObservations({
      candidates: [{ fileIndex: 0 }],  // No infoHash
      providerCapability: provider,
      now: NOW,
      maxCandidates: 10,
    }),
    (error) => error instanceof TypeError
  );
});

test('provider observations retain candidate relationship for shared hash', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
  ]));

  const candidateA = candidate(0, HASH_A);
  const candidateB = candidate(7, HASH_A);
  const result = await collectCandidateObservations({
    candidates: [candidateA, candidateB],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  // Both projections reference the same observation hash
  assert.equal(result.projections[0].observation.infoHash, HASH_A);
  assert.equal(result.projections[1].observation.infoHash, HASH_A);

  // But they are distinct candidate identities
  assert.notEqual(
    result.projections[0].candidate.releaseKey,
    result.projections[1].candidate.releaseKey,
  );

  // The observation is torrent-scoped (fileIndex=null)
  assert.equal(result.projections[0].observation.fileIndex, null);
  assert.equal(result.projections[1].observation.fileIndex, null);
});

test('output is frozen (immutable)', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
  ]));

  const result = await collectCandidateObservations({
    candidates: [candidate(null, HASH_A)],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.observations));
  assert.ok(Object.isFrozen(result.projections));
  assert.ok(Object.isFrozen(result.queries));
});

test('missing now → throws TypeError', async () => {
  const provider = createMockProvider(new Map());

  await assert.rejects(
    () => collectCandidateObservations({
      candidates: [candidate(null, HASH_A)],
      providerCapability: provider,
      maxCandidates: 10,
    }),
    (error) => error instanceof TypeError
  );
});

test('missing maxCandidates → throws TypeError', async () => {
  const provider = createMockProvider(new Map());

  await assert.rejects(
    () => collectCandidateObservations({
      candidates: [candidate(null, HASH_A)],
      providerCapability: provider,
      now: NOW,
    }),
    (error) => error instanceof TypeError
  );
});

test('invalid provider capability → throws TypeError', async () => {
  await assert.rejects(
    () => collectCandidateObservations({
      candidates: [candidate(null, HASH_A)],
      providerCapability: {},
      now: NOW,
      maxCandidates: 10,
    }),
    (error) => error instanceof TypeError
  );
});

test('queries record what was asked of the provider', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
    [HASH_B, torrentObservation(HASH_B, 'cached')],
  ]));

  const candidates = [candidate(null, HASH_A), candidate(null, HASH_B)];
  const result = await collectCandidateObservations({
    candidates,
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  assert.equal(result.queries.length, 1);
  assert.deepEqual(result.queries[0].infoHashes.sort(), [HASH_A, HASH_B]);
});

test('output is not an acquisition decision — no selected/deferred/unavailable', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'cached')],
  ]));

  const result = await collectCandidateObservations({
    candidates: [candidate(null, HASH_A)],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  // The collector is an evidence boundary, not a decision layer
  assert.equal(result.status, COLLECTION_STATUSES.SUCCESS);
  assert.equal(result.selected, undefined);
  assert.equal(result.deferred, undefined);
  assert.equal(result.unavailable, undefined);
  assert.equal(result.reason, undefined);
});

test('provider error becomes observation state, not thrown exception', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'error')],
  ]));

  // Should NOT throw — error is preserved in observation
  const result = await collectCandidateObservations({
    candidates: [candidate(null, HASH_A)],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  assert.equal(result.projections[0].observation.state, 'error');
});

test('uncached observation preserved as uncached (not converted)', async () => {
  const provider = createMockProvider(new Map([
    [HASH_A, torrentObservation(HASH_A, 'uncached')],
  ]));

  const result = await collectCandidateObservations({
    candidates: [candidate(null, HASH_A)],
    providerCapability: provider,
    now: NOW,
    maxCandidates: 10,
  });

  assert.equal(result.projections[0].observation.state, 'uncached');
  assert.equal(result.projections[0].status, 'projected');
});
