import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACQUISITION_DECISION_STATUSES,
  decideAcquisition,
} from '../src/lib/acquisition/decision.js';
import { createAcquisitionPolicy } from '../src/lib/acquisition/policy.js';
import { createCacheObservation } from '../src/lib/providers/observations.js';

const NOW = 20_000;
const HASHES = [
  '1111111111111111111111111111111111111111',
  '2222222222222222222222222222222222222222',
  '3333333333333333333333333333333333333333',
];

function candidate(index, fileIndex = 0) {
  return Object.freeze({
    hash: HASHES[index],
    fileIndex,
    filename: `candidate-${index}.mkv`,
    score: 1 - (index * 0.1),
  });
}

function observation(index, state, options = {}) {
  return createCacheObservation({
    provider: options.provider ?? 'provider-a',
    accountScope: options.accountScope ?? 'primary',
    scope: 'candidate',
    infoHash: HASHES[index],
    fileIndex: Object.hasOwn(options, 'fileIndex') ? options.fileIndex : 0,
    kind: options.kind ?? 'authoritative',
    state,
    observedAt: options.observedAt ?? 19_000,
    expiresAt: options.expiresAt ?? 21_000,
    source: options.source ?? 'fixture-provider',
    errorCategory: options.errorCategory,
    retryable: options.retryable,
    retryAfterMs: options.retryAfterMs,
  });
}

function decide(rankedCandidates, observations, targets = [
  { provider: 'provider-a', accountScope: 'primary' },
]) {
  return decideAcquisition({
    rankedCandidates,
    observations,
    policy: { targets },
  }, { now: NOW });
}

test('cached preferred candidate wins without changing Stage 3 order', () => {
  const rankedCandidates = Object.freeze([candidate(0), candidate(1)]);
  const originalOrder = rankedCandidates.map((item) => item.hash);

  const decision = decide(rankedCandidates, [
    observation(0, 'cached'),
    observation(1, 'cached'),
  ]);

  assert.deepEqual(ACQUISITION_DECISION_STATUSES, ['selected', 'deferred', 'unavailable']);
  assert.equal(decision.status, 'selected');
  assert.equal(decision.selected.candidate, rankedCandidates[0]);
  assert.equal(decision.selected.rank, 0);
  assert.equal(decision.selected.identity.releaseKey, `${HASHES[0]}:0`);
  assert.equal(decision.selected.provider, 'provider-a');
  assert.equal(decision.reason.code, 'fresh-authoritative-cache-hit');
  assert.deepEqual(rankedCandidates.map((item) => item.hash), originalOrder);
  assert.deepEqual(decision.candidates.map((item) => item.candidate.hash), originalOrder);
});

test('unavailable higher-ranked candidate falls back to the next cached candidate', () => {
  const rankedCandidates = [candidate(0), candidate(1)];
  const decision = decide(rankedCandidates, [
    observation(0, 'uncached'),
    observation(1, 'cached'),
  ]);

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selected.candidate, rankedCandidates[1]);
  assert.equal(decision.selected.rank, 1);
  assert.equal(decision.candidates[0].status, 'unavailable');
  assert.equal(decision.candidates[1].status, 'available');
});

test('unknown and error observations are unresolved, not uncached', () => {
  const unknownDecision = decide([candidate(0)], [observation(0, 'unknown')]);
  assert.equal(unknownDecision.status, 'deferred');
  assert.equal(unknownDecision.reason.code, 'provider-reality-unresolved');
  assert.equal(unknownDecision.candidates[0].status, 'unresolved');
  assert.equal(unknownDecision.candidates[0].targets[0].state, 'unknown');

  const errorDecision = decide([candidate(0)], [observation(0, 'error', {
    errorCategory: 'rate-limit',
    retryable: true,
    retryAfterMs: 30_000,
  })]);
  assert.equal(errorDecision.status, 'deferred');
  assert.equal(errorDecision.candidates[0].targets[0].state, 'error');
  assert.equal(errorDecision.candidates[0].targets[0].observation.errorCategory, 'rate-limit');
  assert.equal(errorDecision.candidates[0].targets[0].observation.retryAfterMs, 30_000);

  const blockedFallback = decide([candidate(0), candidate(1)], [
    observation(0, 'unknown'),
    observation(1, 'cached'),
  ]);
  assert.equal(blockedFallback.status, 'deferred');
  assert.equal(blockedFallback.selected, null);

  const unavailableDecision = decide([candidate(0)], [observation(0, 'uncached')]);
  assert.equal(unavailableDecision.status, 'unavailable');
  assert.equal(unavailableDecision.reason.code, 'authoritatively-uncached');
});

test('provider and account differences remain isolated by policy target', () => {
  const rankedCandidates = [candidate(0), candidate(1)];
  const observations = [
    observation(0, 'cached', { provider: 'provider-b', accountScope: 'secondary' }),
    observation(0, 'uncached', { provider: 'provider-a', accountScope: 'primary' }),
    observation(1, 'cached', { provider: 'provider-a', accountScope: 'primary' }),
  ];

  const providerA = decide(rankedCandidates, observations, [
    { provider: 'provider-a', accountScope: 'primary' },
  ]);
  assert.equal(providerA.selected.rank, 1);
  assert.equal(providerA.selected.provider, 'provider-a');

  const providerB = decide(rankedCandidates, observations, [
    { provider: 'provider-b', accountScope: 'secondary' },
  ]);
  assert.equal(providerB.selected.rank, 0);
  assert.equal(providerB.selected.provider, 'provider-b');
  assert.equal(providerB.selected.accountScope, 'secondary');

  const wrongAccount = decide([candidate(0)], observations, [
    { provider: 'provider-b', accountScope: 'primary' },
  ]);
  assert.equal(wrongAccount.status, 'deferred');
  assert.equal(wrongAccount.candidates[0].targets[0].reason, 'missing-observation');
});

test('policy target preference chooses a provider only within one candidate rank', () => {
  const decision = decide([candidate(0), candidate(1)], [
    observation(0, 'cached', { provider: 'provider-b' }),
    observation(1, 'cached', { provider: 'provider-a' }),
  ], [
    { provider: 'provider-a', accountScope: 'primary' },
    { provider: 'provider-b', accountScope: 'primary' },
  ]);

  assert.equal(decision.selected.rank, 0, 'candidate rank remains primary');
  assert.equal(decision.selected.provider, 'provider-b');
});

test('stale, unbounded, and non-authoritative evidence remain unresolved', () => {
  const stale = observation(0, 'uncached', { expiresAt: NOW });
  const unbounded = createCacheObservation({
    provider: 'provider-a', accountScope: 'primary', scope: 'candidate',
    infoHash: HASHES[0], fileIndex: 0, kind: 'authoritative', state: 'uncached',
    observedAt: 19_000, source: 'fixture-provider',
  });
  const inferred = observation(0, 'cached', { kind: 'inferred' });

  for (const evidence of [stale, unbounded, inferred]) {
    const decision = decide([candidate(0)], [evidence]);
    assert.equal(decision.status, 'deferred');
    assert.equal(decision.candidates[0].status, 'unresolved');
  }
});

test('latest observation is projected deterministically and exact identity stays isolated', () => {
  const decision = decide([candidate(0, 0)], [
    observation(0, 'cached', { observedAt: 18_000 }),
    observation(0, 'uncached', { observedAt: 19_000 }),
    observation(0, 'cached', { fileIndex: null, observedAt: 19_500 }),
  ]);

  assert.equal(decision.status, 'unavailable');
  assert.equal(decision.candidates[0].targets[0].observation.state, 'uncached');
  assert.equal(decision.candidates[0].identity.fileIndex, 0);
});

test('acquisition policy normalizes targets and rejects ambiguous configuration', () => {
  const policy = createAcquisitionPolicy({
    targets: [{ provider: 'Provider-A', accountScope: 'Primary' }],
  });
  assert.deepEqual(policy, {
    version: 1,
    targets: [{ provider: 'provider-a', accountScope: 'primary' }],
  });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.targets));

  assert.throws(() => createAcquisitionPolicy({ targets: [] }), /at least one/);
  assert.throws(() => createAcquisitionPolicy({ targets: [
    { provider: 'provider-a' },
    { provider: 'PROVIDER-A', accountScope: 'default' },
  ] }), /Duplicate/);
});
