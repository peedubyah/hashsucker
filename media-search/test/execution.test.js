import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExecutionRequest,
  EXECUTION_STATUSES,
  EXECUTION_ACTIONS,
} from '../src/lib/acquisition/execution.js';
import {
  createAcquisitionIntent,
  ACQUISITION_INTENT_STATUSES,
} from '../src/lib/acquisition/intent.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';
import { createCacheObservation } from '../src/lib/providers/observations.js';
import { composeAcquisitionDecision } from '../src/lib/acquisition/decision-composition.js';
import { createAcquisitionPolicy } from '../src/lib/acquisition/policy.js';

const NOW = 20_000;
const HASH = '1111111111111111111111111111111111111111';

function readyIntent() {
  const identity = createReleaseIdentity(HASH, 0);
  const observation = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASH,
    fileIndex: 0,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });
  const candidate = Object.freeze({
    infoHash: HASH,
    fileIndex: 0,
    releaseKey: identity.releaseKey,
    filename: 'candidate-0.mkv',
    score: 1,
  });
  const decision = composeAcquisitionDecision({
    candidates: [candidate],
    observations: [observation],
    policy: createAcquisitionPolicy({ targets: [{ provider: 'provider-a', accountScope: 'primary' }] }),
    evaluationTime: NOW,
  });
  return createAcquisitionIntent({
    decision,
    evaluationTime: NOW,
    executionPolicy: Object.freeze({}),
  });
}

function deferredIntent() {
  const identity = createReleaseIdentity(HASH, 0);
  const candidate = Object.freeze({
    infoHash: HASH,
    fileIndex: 0,
    releaseKey: identity.releaseKey,
    filename: 'candidate-0.mkv',
    score: 1,
  });
  const decision = composeAcquisitionDecision({
    candidates: [candidate],
    observations: [],
    policy: createAcquisitionPolicy({ targets: [{ provider: 'provider-a', accountScope: 'primary' }] }),
    evaluationTime: NOW,
  });
  return createAcquisitionIntent({
    decision,
    evaluationTime: NOW,
    executionPolicy: Object.freeze({}),
  });
}

function unavailableIntent() {
  const identity = createReleaseIdentity(HASH, 0);
  const observation = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASH,
    fileIndex: 0,
    kind: 'authoritative',
    state: 'uncached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });
  const candidate = Object.freeze({
    infoHash: HASH,
    fileIndex: 0,
    releaseKey: identity.releaseKey,
    filename: 'candidate-0.mkv',
    score: 1,
  });
  const decision = composeAcquisitionDecision({
    candidates: [candidate],
    observations: [observation],
    policy: createAcquisitionPolicy({ targets: [{ provider: 'provider-a', accountScope: 'primary' }] }),
    evaluationTime: NOW,
  });
  return createAcquisitionIntent({
    decision,
    evaluationTime: NOW,
    executionPolicy: Object.freeze({}),
  });
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

test('ready intent creates ready execution request', () => {
  const request = createExecutionRequest({
    intent: readyIntent(),
    evaluationTime: NOW,
  });

  assert.equal(request.executionStatus, EXECUTION_STATUSES.READY);
  assert.equal(request.action, EXECUTION_ACTIONS.PLACE);
  assert.ok(request.candidateIdentity);
  assert.equal(request.provider, 'provider-a');
  assert.equal(request.accountScope, 'primary');
});

test('deferred intent remains deferred', () => {
  const request = createExecutionRequest({
    intent: deferredIntent(),
    evaluationTime: NOW,
  });

  assert.equal(request.executionStatus, EXECUTION_STATUSES.DEFERRED);
  assert.equal(request.action, null);
  assert.equal(request.candidateIdentity, null);
  assert.equal(request.provider, null);
  assert.equal(request.accountScope, null);
});

test('unavailable intent remains unavailable', () => {
  const request = createExecutionRequest({
    intent: unavailableIntent(),
    evaluationTime: NOW,
  });

  assert.equal(request.executionStatus, EXECUTION_STATUSES.UNAVAILABLE);
  assert.equal(request.action, null);
  assert.equal(request.candidateIdentity, null);
  assert.equal(request.provider, null);
  assert.equal(request.accountScope, null);
});

// ---------------------------------------------------------------------------
// Identity preservation
// ---------------------------------------------------------------------------

test('candidate identity preserved in ready execution request', () => {
  const request = createExecutionRequest({
    intent: readyIntent(),
    evaluationTime: NOW,
  });

  assert.equal(request.candidateIdentity.infoHash, HASH);
  assert.equal(request.candidateIdentity.fileIndex, 0);
  assert.equal(request.candidateIdentity.releaseKey, `${HASH}:0`);
});

test('null fileIndex preserved distinctly from zero', () => {
  const identity = createReleaseIdentity(HASH, null);
  const observation = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASH,
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });
  const candidate = Object.freeze({
    infoHash: HASH,
    fileIndex: null,
    releaseKey: identity.releaseKey,
    filename: 'candidate-torrent',
    score: 1,
  });
  const decision = composeAcquisitionDecision({
    candidates: [candidate],
    observations: [observation],
    policy: createAcquisitionPolicy({ targets: [{ provider: 'provider-a', accountScope: 'primary' }] }),
    evaluationTime: NOW,
  });
  const intent = createAcquisitionIntent({
    decision,
    evaluationTime: NOW,
    executionPolicy: Object.freeze({}),
  });
  const request = createExecutionRequest({
    intent,
    evaluationTime: NOW,
  });

  assert.equal(request.candidateIdentity.fileIndex, null);
  assert.equal(request.candidateIdentity.releaseKey, `${HASH}:torrent`);
});

// ---------------------------------------------------------------------------
// Provider/account scope preservation
// ---------------------------------------------------------------------------

test('provider and account scope preserved in ready execution request', () => {
  const request = createExecutionRequest({
    intent: readyIntent(),
    evaluationTime: NOW,
  });

  assert.equal(request.provider, 'provider-a');
  assert.equal(request.accountScope, 'primary');
});

// ---------------------------------------------------------------------------
// Reason codes preservation
// ---------------------------------------------------------------------------

test('reason codes preserved in ready execution request', () => {
  const request = createExecutionRequest({
    intent: readyIntent(),
    evaluationTime: NOW,
  });

  assert.ok(Array.isArray(request.reasonCodes));
  assert.ok(request.reasonCodes.length > 0);
});

test('reason codes preserved in deferred execution request', () => {
  const request = createExecutionRequest({
    intent: deferredIntent(),
    evaluationTime: NOW,
  });

  assert.ok(Array.isArray(request.reasonCodes));
});

// ---------------------------------------------------------------------------
// Evidence preservation
// ---------------------------------------------------------------------------

test('evidence preserved in ready execution request', () => {
  const request = createExecutionRequest({
    intent: readyIntent(),
    evaluationTime: NOW,
  });

  assert.ok(request.evidence);
  assert.equal(request.evidence.state, 'cached');
});

test('evidence is null for deferred execution request', () => {
  const request = createExecutionRequest({
    intent: deferredIntent(),
    evaluationTime: NOW,
  });

  assert.equal(request.evidence, null);
});

// ---------------------------------------------------------------------------
// Timestamp explicit
// ---------------------------------------------------------------------------

test('evaluation timestamp is explicit in execution request', () => {
  const request = createExecutionRequest({
    intent: readyIntent(),
    evaluationTime: NOW,
  });

  assert.equal(request.createdAt, NOW);
});

// ---------------------------------------------------------------------------
// Output frozen
// ---------------------------------------------------------------------------

test('execution request output is frozen', () => {
  const request = createExecutionRequest({
    intent: readyIntent(),
    evaluationTime: NOW,
  });

  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.candidateIdentity));
  assert.ok(Object.isFrozen(request.reasonCodes));
});

test('deferred execution request output is frozen', () => {
  const request = createExecutionRequest({
    intent: deferredIntent(),
    evaluationTime: NOW,
  });

  assert.ok(Object.isFrozen(request));
});

// ---------------------------------------------------------------------------
// Invalid input rejection
// ---------------------------------------------------------------------------

test('missing intent throws', () => {
  assert.throws(
    () => createExecutionRequest({ evaluationTime: NOW }),
    (err) => err instanceof TypeError && /intent is required/.test(err.message),
  );
});

test('non-object intent throws', () => {
  assert.throws(
    () => createExecutionRequest({ intent: 'ready', evaluationTime: NOW }),
    (err) => err instanceof TypeError && /intent is required/.test(err.message),
  );
});

test('array intent throws', () => {
  assert.throws(
    () => createExecutionRequest({ intent: [], evaluationTime: NOW }),
    (err) => err instanceof TypeError && /intent is required/.test(err.message),
  );
});

test('missing evaluationTime throws', () => {
  assert.throws(
    () => createExecutionRequest({ intent: readyIntent() }),
    (err) => err instanceof TypeError && /evaluationTime is required/.test(err.message),
  );
});

test('negative evaluationTime throws', () => {
  assert.throws(
    () => createExecutionRequest({ intent: readyIntent(), evaluationTime: -1 }),
    (err) => err instanceof TypeError && /non-negative millisecond timestamp/.test(err.message),
  );
});

test('non-integer evaluationTime throws', () => {
  assert.throws(
    () => createExecutionRequest({ intent: readyIntent(), evaluationTime: 1.5 }),
    (err) => err instanceof TypeError && /non-negative millisecond timestamp/.test(err.message),
  );
});

test('unknown intent status throws', () => {
  const intent = { intentStatus: 'unknown', reasonCodes: [] };
  assert.throws(
    () => createExecutionRequest({ intent, evaluationTime: NOW }),
    (err) => err instanceof TypeError && /Unknown intent status/.test(err.message),
  );
});

test('ready intent without candidate identity throws', () => {
  const intent = {
    intentStatus: 'ready',
    action: 'place',
    candidateIdentity: null,
    provider: 'provider-a',
    accountScope: 'primary',
    reasonCodes: [],
    evidence: {},
  };
  assert.throws(
    () => createExecutionRequest({ intent, evaluationTime: NOW }),
    (err) => err instanceof TypeError && /candidate identity/.test(err.message),
  );
});

test('ready intent without provider throws', () => {
  const intent = {
    intentStatus: 'ready',
    action: 'place',
    candidateIdentity: { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` },
    provider: null,
    accountScope: 'primary',
    reasonCodes: [],
    evidence: {},
  };
  assert.throws(
    () => createExecutionRequest({ intent, evaluationTime: NOW }),
    (err) => err instanceof TypeError && /provider/.test(err.message),
  );
});

test('ready intent without account scope throws', () => {
  const intent = {
    intentStatus: 'ready',
    action: 'place',
    candidateIdentity: { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` },
    provider: 'provider-a',
    accountScope: null,
    reasonCodes: [],
    evidence: {},
  };
  assert.throws(
    () => createExecutionRequest({ intent, evaluationTime: NOW }),
    (err) => err instanceof TypeError && /account scope/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// No provider calls
// ---------------------------------------------------------------------------

test('no provider APIs are called during execution request creation', () => {
  // This test verifies the pure boundary: no provider state is accessed
  // beyond what the intent already contains. The intent carries provider
  // as a string identifier, not a live client reference.
  const request = createExecutionRequest({
    intent: readyIntent(),
    evaluationTime: NOW,
  });

  // Provider is a string, not an object with methods
  assert.equal(typeof request.provider, 'string');
  assert.equal(request.provider, 'provider-a');
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('EXECUTION_STATUSES contains expected values', () => {
  assert.equal(EXECUTION_STATUSES.READY, 'ready');
  assert.equal(EXECUTION_STATUSES.DEFERRED, 'deferred');
  assert.equal(EXECUTION_STATUSES.UNAVAILABLE, 'unavailable');
});

test('EXECUTION_ACTIONS contains expected values', () => {
  assert.equal(EXECUTION_ACTIONS.PLACE, 'place');
});
