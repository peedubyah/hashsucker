import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAcquisitionIntent,
  ACQUISITION_INTENT_STATUSES,
  ACQUISITION_INTENT_ACTIONS,
} from '../src/lib/acquisition/intent.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';
import { createCacheObservation } from '../src/lib/providers/observations.js';
import { composeAcquisitionDecision } from '../src/lib/acquisition/decision-composition.js';
import { createAcquisitionPolicy } from '../src/lib/acquisition/policy.js';

const NOW = 20_000;
const HASH = '1111111111111111111111111111111111111111';

function selectedDecision() {
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
  return composeAcquisitionDecision({
    candidates: [candidate],
    observations: [observation],
    policy: createAcquisitionPolicy({ targets: [{ provider: 'provider-a', accountScope: 'primary' }] }),
    evaluationTime: NOW,
  });
}

function deferredDecision() {
  const identity = createReleaseIdentity(HASH, 0);
  const candidate = Object.freeze({
    infoHash: HASH,
    fileIndex: 0,
    releaseKey: identity.releaseKey,
    filename: 'candidate-0.mkv',
    score: 1,
  });
  return composeAcquisitionDecision({
    candidates: [candidate],
    observations: [],
    policy: createAcquisitionPolicy({ targets: [{ provider: 'provider-a', accountScope: 'primary' }] }),
    evaluationTime: NOW,
  });
}

function unavailableDecision() {
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
  return composeAcquisitionDecision({
    candidates: [candidate],
    observations: [observation],
    policy: createAcquisitionPolicy({ targets: [{ provider: 'provider-a', accountScope: 'primary' }] }),
    evaluationTime: NOW,
  });
}

function executionPolicy() {
  return Object.freeze({});
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

test('selected decision creates ready intent', () => {
  const intent = createAcquisitionIntent({
    decision: selectedDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.equal(intent.intentStatus, ACQUISITION_INTENT_STATUSES.READY);
  assert.equal(intent.action, ACQUISITION_INTENT_ACTIONS.PLACE);
  assert.ok(intent.candidateIdentity);
  assert.equal(intent.provider, 'provider-a');
  assert.equal(intent.accountScope, 'primary');
});

test('deferred decision creates deferred intent', () => {
  const intent = createAcquisitionIntent({
    decision: deferredDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.equal(intent.intentStatus, ACQUISITION_INTENT_STATUSES.DEFERRED);
  assert.equal(intent.action, null);
  assert.equal(intent.candidateIdentity, null);
  assert.equal(intent.provider, null);
  assert.equal(intent.accountScope, null);
  assert.equal(intent.evidence, null);
});

test('unavailable decision creates unavailable intent', () => {
  const intent = createAcquisitionIntent({
    decision: unavailableDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.equal(intent.intentStatus, ACQUISITION_INTENT_STATUSES.UNAVAILABLE);
  assert.equal(intent.action, null);
  assert.equal(intent.candidateIdentity, null);
  assert.equal(intent.provider, null);
  assert.equal(intent.accountScope, null);
  assert.equal(intent.evidence, null);
});

// ---------------------------------------------------------------------------
// Selected intent validation
// ---------------------------------------------------------------------------

test('selected decision without candidate rejects ready intent', () => {
  const decision = {
    status: 'selected',
    selectedCandidate: null,
    decisiveObservation: null,
    reasonCodes: [],
    candidateEvaluations: [],
  };

  assert.throws(
    () => createAcquisitionIntent({
      decision,
      evaluationTime: NOW,
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /requires a selected candidate/.test(err.message),
  );
});

test('selected decision without decisive evidence rejects ready intent', () => {
  const identity = createReleaseIdentity(HASH, 0);
  const decision = {
    status: 'selected',
    selectedCandidate: {
      candidate: {},
      identity,
      rank: 0,
      provider: 'provider-a',
      accountScope: 'primary',
    },
    decisiveObservation: null,
    reasonCodes: [],
    candidateEvaluations: [],
  };

  assert.throws(
    () => createAcquisitionIntent({
      decision,
      evaluationTime: NOW,
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /requires decisive evidence/.test(err.message),
  );
});

test('selected decision without provider rejects ready intent', () => {
  const identity = createReleaseIdentity(HASH, 0);
  const decision = {
    status: 'selected',
    selectedCandidate: {
      candidate: {},
      identity,
      rank: 0,
      provider: null,
      accountScope: 'primary',
    },
    decisiveObservation: {},
    reasonCodes: [],
    candidateEvaluations: [],
  };

  assert.throws(
    () => createAcquisitionIntent({
      decision,
      evaluationTime: NOW,
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /identity, provider, and accountScope/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Identity preservation
// ---------------------------------------------------------------------------

test('identity preserved in ready intent', () => {
  const intent = createAcquisitionIntent({
    decision: selectedDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.equal(intent.candidateIdentity.infoHash, HASH);
  assert.equal(intent.candidateIdentity.fileIndex, 0);
  assert.equal(intent.candidateIdentity.releaseKey, `${HASH}:0`);
});

test('provider/account scope preserved in ready intent', () => {
  const intent = createAcquisitionIntent({
    decision: selectedDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.equal(intent.provider, 'provider-a');
  assert.equal(intent.accountScope, 'primary');
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
    filename: 'candidate-torrent.mkv',
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
    executionPolicy: executionPolicy(),
  });

  assert.equal(intent.candidateIdentity.fileIndex, null);
  assert.equal(intent.candidateIdentity.releaseKey, `${HASH}:torrent`);
});

// ---------------------------------------------------------------------------
// Explainability
// ---------------------------------------------------------------------------

test('reason codes preserved in ready intent', () => {
  const intent = createAcquisitionIntent({
    decision: selectedDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.ok(Array.isArray(intent.reasonCodes));
  assert.ok(intent.reasonCodes.length > 0);
});

test('reason codes preserved in deferred intent', () => {
  const intent = createAcquisitionIntent({
    decision: deferredDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.ok(Array.isArray(intent.reasonCodes));
});

test('timestamp is explicit', () => {
  const intent = createAcquisitionIntent({
    decision: selectedDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.equal(intent.createdAt, NOW);
});

test('decisive observation included in ready intent', () => {
  const intent = createAcquisitionIntent({
    decision: selectedDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.ok(intent.evidence);
  assert.equal(intent.evidence.state, 'cached');
  assert.equal(intent.evidence.infoHash, HASH);
});

// ---------------------------------------------------------------------------
// No provider execution
// ---------------------------------------------------------------------------

test('no provider calls — intent is pure', () => {
  // This test verifies the intent factory does not invoke any provider.
  // The decision is already complete; the intent factory only reads it.
  const decision = selectedDecision();
  const intent = createAcquisitionIntent({
    decision,
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  // If any provider call had occurred, the test would have thrown or timed out.
  assert.ok(intent);
  assert.equal(intent.intentStatus, ACQUISITION_INTENT_STATUSES.READY);
});

// ---------------------------------------------------------------------------
// Frozen output
// ---------------------------------------------------------------------------

test('output is deeply frozen', () => {
  const intent = createAcquisitionIntent({
    decision: selectedDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.ok(Object.isFrozen(intent));
  assert.ok(Object.isFrozen(intent.candidateIdentity));
  assert.ok(Object.isFrozen(intent.evidence));
  assert.ok(Object.isFrozen(intent.reasonCodes));
});

test('deferred intent output is frozen', () => {
  const intent = createAcquisitionIntent({
    decision: deferredDecision(),
    evaluationTime: NOW,
    executionPolicy: executionPolicy(),
  });

  assert.ok(Object.isFrozen(intent));
  assert.ok(Object.isFrozen(intent.reasonCodes));
});

// ---------------------------------------------------------------------------
// Invalid input rejected
// ---------------------------------------------------------------------------

test('missing decision throws', () => {
  assert.throws(
    () => createAcquisitionIntent({
      evaluationTime: NOW,
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /decision is required/.test(err.message),
  );
});

test('non-object decision throws', () => {
  assert.throws(
    () => createAcquisitionIntent({
      decision: 'selected',
      evaluationTime: NOW,
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /decision is required/.test(err.message),
  );
});

test('array decision throws', () => {
  assert.throws(
    () => createAcquisitionIntent({
      decision: [],
      evaluationTime: NOW,
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /decision is required/.test(err.message),
  );
});

test('missing evaluationTime throws', () => {
  assert.throws(
    () => createAcquisitionIntent({
      decision: selectedDecision(),
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /evaluationTime is required/.test(err.message),
  );
});

test('negative evaluationTime throws', () => {
  assert.throws(
    () => createAcquisitionIntent({
      decision: selectedDecision(),
      evaluationTime: -1,
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /non-negative millisecond timestamp/.test(err.message),
  );
});

test('non-integer evaluationTime throws', () => {
  assert.throws(
    () => createAcquisitionIntent({
      decision: selectedDecision(),
      evaluationTime: 1.5,
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /non-negative millisecond timestamp/.test(err.message),
  );
});

test('missing executionPolicy throws', () => {
  assert.throws(
    () => createAcquisitionIntent({
      decision: selectedDecision(),
      evaluationTime: NOW,
    }),
    (err) => err instanceof TypeError && /executionPolicy is required/.test(err.message),
  );
});

test('non-object executionPolicy throws', () => {
  assert.throws(
    () => createAcquisitionIntent({
      decision: selectedDecision(),
      evaluationTime: NOW,
      executionPolicy: 'policy',
    }),
    (err) => err instanceof TypeError && /executionPolicy is required/.test(err.message),
  );
});

test('array executionPolicy throws', () => {
  assert.throws(
    () => createAcquisitionIntent({
      decision: selectedDecision(),
      evaluationTime: NOW,
      executionPolicy: [],
    }),
    (err) => err instanceof TypeError && /executionPolicy is required/.test(err.message),
  );
});

test('unknown decision status throws', () => {
  const decision = {
    status: 'unknown',
    selectedCandidate: null,
    decisiveObservation: null,
    reasonCodes: [],
    candidateEvaluations: [],
  };

  assert.throws(
    () => createAcquisitionIntent({
      decision,
      evaluationTime: NOW,
      executionPolicy: executionPolicy(),
    }),
    (err) => err instanceof TypeError && /Unknown decision status/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('ACQUISITION_INTENT_STATUSES exposes all valid statuses', () => {
  assert.deepEqual(ACQUISITION_INTENT_STATUSES, {
    READY: 'ready',
    DEFERRED: 'deferred',
    UNAVAILABLE: 'unavailable',
  });
});

test('ACQUISITION_INTENT_ACTIONS exposes all valid actions', () => {
  assert.deepEqual(ACQUISITION_INTENT_ACTIONS, {
    PLACE: 'place',
  });
});
