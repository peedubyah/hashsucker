import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeAcquisitionDecision,
  DECISION_COMPOSITION_STATUSES,
} from '../src/lib/acquisition/decision-composition.js';
import { createAcquisitionPolicy } from '../src/lib/acquisition/policy.js';
import { createCacheObservation } from '../src/lib/providers/observations.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';

const NOW = 20_000;
const HASHES = [
  '1111111111111111111111111111111111111111',
  '2222222222222222222222222222222222222222',
  '3333333333333333333333333333333333333333',
  '4444444444444444444444444444444444444444',
];

function candidate(index, fileIndex = 0, overrides = {}) {
  const infoHash = HASHES[index];
  const identity = createReleaseIdentity(infoHash, fileIndex);
  return Object.freeze({
    infoHash,
    fileIndex,
    releaseKey: identity.releaseKey,
    filename: `candidate-${index}.mkv`,
    score: 1 - (index * 0.1),
    ...overrides,
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
    observedAt: options.observedAt ?? NOW - 1_000,
    expiresAt: options.expiresAt ?? NOW + 10_000,
    source: options.source ?? 'fixture-provider',
    errorCategory: options.errorCategory,
    retryable: options.retryable,
    retryAfterMs: options.retryAfterMs,
  });
}

function policy(targets) {
  return createAcquisitionPolicy({ targets });
}

function compose(input) {
  return composeAcquisitionDecision({
    candidates: input.candidates,
    observations: input.observations,
    policy: input.policy ?? policy([{ provider: 'provider-a', accountScope: 'primary' }]),
    evaluationTime: input.evaluationTime ?? NOW,
  });
}

// ---------------------------------------------------------------------------
// Selection behavior
// ---------------------------------------------------------------------------

test('highest-ranked candidate with authoritative cached evidence is selected', () => {
  const ranked = [candidate(0), candidate(1), candidate(2)];
  const decision = compose({
    candidates: ranked,
    observations: [
      observation(0, 'cached'),
      observation(1, 'cached'),
      observation(2, 'cached'),
    ],
  });

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedCandidate.candidate, ranked[0]);
  assert.equal(decision.selectedCandidate.rank, 0);
  assert.equal(decision.selectedCandidate.identity.releaseKey, `${HASHES[0]}:0`);
  assert.equal(decision.selectedCandidate.provider, 'provider-a');
  assert.equal(decision.selectedCandidate.accountScope, 'primary');
  assert.ok(decision.decisiveObservation);
  assert.equal(decision.decisiveObservation.state, 'cached');
  assert.equal(decision.decisiveObservation.infoHash, HASHES[0]);
});

test('highest-ranked candidate with unknown evidence is deferred', () => {
  const decision = compose({
    candidates: [candidate(0), candidate(1)],
    observations: [
      observation(0, 'unknown'),
      observation(1, 'cached'),
    ],
  });

  assert.equal(decision.status, 'deferred');
  assert.equal(decision.selectedCandidate, null);
  assert.equal(decision.decisiveObservation, null);
  assert.equal(decision.reasonCodes.length, 1);
  assert.equal(decision.candidateEvaluations[0].status, 'unresolved');
});

test('highest-ranked candidate with error evidence is deferred', () => {
  const decision = compose({
    candidates: [candidate(0)],
    observations: [
      observation(0, 'error', {
        errorCategory: 'rate-limit',
        retryable: true,
        retryAfterMs: 30_000,
      }),
    ],
  });

  assert.equal(decision.status, 'deferred');
  assert.equal(decision.selectedCandidate, null);
  assert.equal(decision.decisiveObservation, null);
  assert.equal(decision.candidateEvaluations[0].targets[0].state, 'error');
  assert.equal(decision.candidateEvaluations[0].targets[0].observation.errorCategory, 'rate-limit');
  assert.equal(decision.candidateEvaluations[0].targets[0].observation.retryAfterMs, 30_000);
});

test('lower-ranked candidate selected only when higher-ranked is authoritative uncached', () => {
  const ranked = [candidate(0), candidate(1)];
  const decision = compose({
    candidates: ranked,
    observations: [
      observation(0, 'uncached'),
      observation(1, 'cached'),
    ],
  });

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedCandidate.candidate, ranked[1]);
  assert.equal(decision.selectedCandidate.rank, 1);
  assert.equal(decision.candidateEvaluations[0].status, 'unavailable');
  assert.equal(decision.candidateEvaluations[1].status, 'available');
});

test('no candidates returns deterministic unavailable result', () => {
  const decision = compose({
    candidates: [],
    observations: [],
  });

  assert.equal(decision.status, 'unavailable');
  assert.equal(decision.selectedCandidate, null);
  assert.equal(decision.decisiveObservation, null);
  assert.deepEqual(decision.candidateEvaluations, []);
  assert.equal(decision.reasonCodes.length, 1);
});

// ---------------------------------------------------------------------------
// Evidence states
// ---------------------------------------------------------------------------

test('uncached evidence on all candidates yields unavailable', () => {
  const decision = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'uncached')],
  });

  assert.equal(decision.status, 'unavailable');
  assert.equal(decision.reasonCodes[0], 'authoritatively-uncached');
});

test('missing observation defers', () => {
  const decision = compose({
    candidates: [candidate(0)],
    observations: [],
  });

  assert.equal(decision.status, 'deferred');
  assert.equal(decision.candidateEvaluations[0].targets[0].reason, 'missing-observation');
});

test('stale observation defers', () => {
  const decision = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'cached', { expiresAt: NOW })],
  });

  assert.equal(decision.status, 'deferred');
  assert.equal(decision.candidateEvaluations[0].targets[0].state, 'unknown');
});

test('unbounded observation defers', () => {
  const obs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASHES[0],
    fileIndex: 0,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: [candidate(0)],
    observations: [obs],
  });

  assert.equal(decision.status, 'deferred');
  assert.equal(decision.candidateEvaluations[0].targets[0].state, 'unknown');
});

test('future observation defers', () => {
  const decision = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'cached', { observedAt: NOW + 10_000 })],
  });

  assert.equal(decision.status, 'deferred');
});

test('non-authoritative observation defers', () => {
  const decision = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'cached', { kind: 'inferred' })],
  });

  assert.equal(decision.status, 'deferred');
  assert.equal(decision.candidateEvaluations[0].targets[0].reason, 'non-authoritative-observation');
});

test('predicted observation defers', () => {
  const decision = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'cached', { kind: 'predicted' })],
  });

  assert.equal(decision.status, 'deferred');
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('exact torrent candidate match', () => {
  const ranked = [candidate(0, null)];
  const obs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASHES[0],
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: ranked,
    observations: [obs],
  });

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedCandidate.identity.fileIndex, null);
  assert.equal(decision.selectedCandidate.identity.releaseKey, `${HASHES[0]}:torrent`);
});

test('exact file candidate match', () => {
  const ranked = [candidate(0, 0)];
  const obs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASHES[0],
    fileIndex: 0,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: ranked,
    observations: [obs],
  });

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedCandidate.identity.fileIndex, 0);
});

test('null fileIndex is distinct from zero', () => {
  const ranked = [candidate(0, 0)];

  // Torrent-scoped observation on a file-level candidate must not project
  const obs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASHES[0],
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: ranked,
    observations: [obs],
  });

  assert.equal(decision.status, 'deferred');
  assert.equal(decision.selectedCandidate, null);
});

test('wrong file identity rejected', () => {
  const ranked = [candidate(0, 0)];

  // Observation for file index 1, but candidate is file index 0
  const obs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASHES[0],
    fileIndex: 1,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: ranked,
    observations: [obs],
  });

  assert.equal(decision.status, 'deferred');
});

test('torrent-scoped observation matches torrent-level candidate', () => {
  // Torrent-level candidate (fileIndex=null) with torrent-scoped observation
  const ranked = [candidate(0, null)];
  const torrentObs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASHES[0],
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: ranked,
    observations: [torrentObs],
  });

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedCandidate.identity.fileIndex, null);
  assert.equal(decision.selectedCandidate.identity.releaseKey, `${HASHES[0]}:torrent`);
  assert.equal(decision.decisiveObservation.scope, 'torrent');
});

test('candidate-scoped observation matches file-level candidate', () => {
  // File-level candidate (fileIndex=0) with candidate-scoped observation
  const ranked = [candidate(0, 0)];
  const fileObs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASHES[0],
    fileIndex: 0,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: ranked,
    observations: [fileObs],
  });

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedCandidate.identity.fileIndex, 0);
  assert.equal(decision.decisiveObservation.scope, 'candidate');
});

test('candidate-scoped observation does not match torrent-level candidate', () => {
  // Torrent-level candidate (fileIndex=null) but candidate-scoped observation for fileIndex=0
  const ranked = [candidate(0, null)];
  const fileObs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASHES[0],
    fileIndex: 0,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: ranked,
    observations: [fileObs],
  });

  assert.equal(decision.status, 'deferred');
});

test('unsupported observation scope is rejected', () => {
  // provider-resource, exposure, mount, provider-file are not admissible into
  // the decision evaluator. createCacheObservation accepts them as valid
  // observation scopes, but decision.js rejects them at the admission boundary.
  const unsupportedScopes = ['provider-resource', 'exposure', 'mount', 'provider-file'];
  for (const scope of unsupportedScopes) {
    const ranked = [candidate(0)];
    const obs = createCacheObservation({
      provider: 'provider-a',
      accountScope: 'primary',
      scope,
      infoHash: HASHES[0],
      fileIndex: 0,
      kind: 'authoritative',
      state: 'cached',
      observedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      source: 'fixture-provider',
    });

    assert.throws(
      () => composeAcquisitionDecision({
        candidates: ranked,
        observations: [obs],
        policy: policy([{ provider: 'provider-a', accountScope: 'primary' }]),
        evaluationTime: NOW,
      }),
      (err) => err instanceof TypeError && /unsupported scope/.test(err.message),
      `scope "${scope}" should be rejected`,
    );
  }
});

test('torrent-scoped observation does not match file-level candidate', () => {
  // File-level candidate (fileIndex=0) with torrent-scoped observation
  // — keyed differently, so the candidate has no matching observation.
  const ranked = [candidate(0, 0)];
  const torrentObs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASHES[0],
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: ranked,
    observations: [torrentObs],
  });

  assert.equal(decision.status, 'deferred');
});

test('provider/account scope isolation preserved', () => {
  // Observation for a different account scope must not project onto a candidate
  // queried under a different account scope. No matching observation exists
  // under the target policy, so the candidate defers (missing-observation).
  const ranked = [candidate(0)];
  const obs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'secondary',
    scope: 'candidate',
    infoHash: HASHES[0],
    fileIndex: 0,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    source: 'fixture-provider',
  });

  const decision = compose({
    candidates: ranked,
    observations: [obs],
    policy: policy([{ provider: 'provider-a', accountScope: 'primary' }]),
  });

  assert.equal(decision.status, 'deferred');
  assert.equal(decision.candidateEvaluations[0].provider, null);
  assert.equal(decision.candidateEvaluations[0].targets[0].reason, 'missing-observation');
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test('provider separation — different providers do not merge', () => {
  const ranked = [candidate(0)];
  const observations = [
    observation(0, 'cached', { provider: 'provider-b', accountScope: 'primary' }),
    observation(0, 'uncached', { provider: 'provider-a', accountScope: 'primary' }),
  ];

  const providerA = compose({
    candidates: ranked,
    observations,
    policy: policy([{ provider: 'provider-a', accountScope: 'primary' }]),
  });

  assert.equal(providerA.status, 'unavailable');
  assert.equal(providerA.candidateEvaluations[0].provider, null);

  const providerB = compose({
    candidates: ranked,
    observations,
    policy: policy([{ provider: 'provider-b', accountScope: 'primary' }]),
  });

  assert.equal(providerB.status, 'selected');
  assert.equal(providerB.selectedCandidate.provider, 'provider-b');
});

test('account separation — different accounts do not merge', () => {
  const ranked = [candidate(0)];
  const observations = [
    observation(0, 'cached', { provider: 'provider-a', accountScope: 'secondary' }),
    observation(0, 'uncached', { provider: 'provider-a', accountScope: 'primary' }),
  ];

  const primary = compose({
    candidates: ranked,
    observations,
    policy: policy([{ provider: 'provider-a', accountScope: 'primary' }]),
  });

  assert.equal(primary.status, 'unavailable');

  const secondary = compose({
    candidates: ranked,
    observations,
    policy: policy([{ provider: 'provider-a', accountScope: 'secondary' }]),
  });

  assert.equal(secondary.status, 'selected');
  assert.equal(secondary.selectedCandidate.accountScope, 'secondary');
});

test('cross provider + account isolation — four independent targets', () => {
  const ranked = [candidate(0)];
  const observations = [
    observation(0, 'cached', { provider: 'provider-a', accountScope: 'primary' }),
    observation(0, 'uncached', { provider: 'provider-a', accountScope: 'secondary' }),
    observation(0, 'uncached', { provider: 'provider-b', accountScope: 'primary' }),
    observation(0, 'uncached', { provider: 'provider-b', accountScope: 'secondary' }),
  ];

  const targets = [
    { provider: 'provider-a', accountScope: 'primary' },
    { provider: 'provider-a', accountScope: 'secondary' },
    { provider: 'provider-b', accountScope: 'primary' },
    { provider: 'provider-b', accountScope: 'secondary' },
  ];

  const decision = compose({
    candidates: ranked,
    observations,
    policy: policy(targets),
  });

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedCandidate.provider, 'provider-a');
  assert.equal(decision.selectedCandidate.accountScope, 'primary');
  assert.equal(decision.candidateEvaluations[0].status, 'available');
});

// ---------------------------------------------------------------------------
// Explainability
// ---------------------------------------------------------------------------

test('candidate evaluations are included in the result', () => {
  const ranked = [candidate(0), candidate(1)];
  const decision = compose({
    candidates: ranked,
    observations: [
      observation(0, 'cached'),
      observation(1, 'cached'),
    ],
  });

  assert.ok(Array.isArray(decision.candidateEvaluations));
  assert.equal(decision.candidateEvaluations.length, 2);
  assert.equal(decision.candidateEvaluations[0].candidate, ranked[0]);
  assert.equal(decision.candidateEvaluations[0].rank, 0);
  assert.equal(decision.candidateEvaluations[1].rank, 1);
});

test('reason codes are included', () => {
  const cachedDecision = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'cached')],
  });

  assert.ok(cachedDecision.reasonCodes.length > 0);
  assert.ok(cachedDecision.reasonCodes.includes('fresh-authoritative-cache-hit'));

  const unavailableDecision = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'uncached')],
  });

  assert.ok(unavailableDecision.reasonCodes.includes('authoritatively-uncached'));

  const deferredDecision = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'unknown')],
  });

  assert.ok(deferredDecision.reasonCodes.length > 0);
});

test('decisive observation is included when selected', () => {
  const ranked = [candidate(0)];
  const obs = observation(0, 'cached');
  const decision = compose({
    candidates: ranked,
    observations: [obs],
  });

  assert.equal(decision.status, 'selected');
  assert.ok(decision.decisiveObservation);
  assert.equal(decision.decisiveObservation.infoHash, HASHES[0]);
  assert.equal(decision.decisiveObservation.state, 'cached');
  assert.equal(decision.decisiveObservation.kind, 'authoritative');
});

test('decisive observation is null when deferred or unavailable', () => {
  const deferred = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'unknown')],
  });

  assert.equal(deferred.decisiveObservation, null);

  const unavailable = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'uncached')],
  });

  assert.equal(unavailable.decisiveObservation, null);
});

// ---------------------------------------------------------------------------
// Stage 3 authority preservation
// ---------------------------------------------------------------------------

test('candidate order is preserved — no re-ranking', () => {
  const ranked = [candidate(0), candidate(1), candidate(2)];
  const originalOrder = ranked.map((c) => c.infoHash);

  const decision = compose({
    candidates: ranked,
    observations: [
      observation(0, 'cached'),
      observation(1, 'cached'),
      observation(2, 'cached'),
    ],
  });

  assert.deepEqual(decision.candidateEvaluations.map((e) => e.candidate.infoHash), originalOrder);
});

test('candidates are not mutated', () => {
  const ranked = Object.freeze([candidate(0), candidate(1)]);
  const originalHashes = ranked.map((c) => c.infoHash);

  compose({
    candidates: ranked,
    observations: [observation(0, 'cached')],
  });

  assert.deepEqual(ranked.map((c) => c.infoHash), originalHashes);
});

// ---------------------------------------------------------------------------
// Result shape and immutability
// ---------------------------------------------------------------------------

test('result is deeply frozen', () => {
  const decision = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'cached')],
  });

  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.selectedCandidate));
  assert.ok(Object.isFrozen(decision.candidateEvaluations));
  assert.ok(Object.isFrozen(decision.reasonCodes));
});

test('selectedCandidate is null when not selected', () => {
  const deferred = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'unknown')],
  });

  assert.equal(deferred.selectedCandidate, null);

  const unavailable = compose({
    candidates: [candidate(0)],
    observations: [observation(0, 'uncached')],
  });

  assert.equal(unavailable.selectedCandidate, null);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('missing candidates throws', () => {
  assert.throws(
    () => compose({}),
    /candidates must be an array/,
  );
});

test('missing observations throws', () => {
  assert.throws(
    () => compose({ candidates: [] }),
    /observations must be an array/,
  );
});

test('missing policy throws', () => {
  assert.throws(
    () => composeAcquisitionDecision({
      candidates: [],
      observations: [],
      evaluationTime: NOW,
    }),
    /policy is required/,
  );
});

test('missing evaluationTime throws', () => {
  assert.throws(
    () => composeAcquisitionDecision({
      candidates: [],
      observations: [],
      policy: policy([{ provider: 'provider-a', accountScope: 'primary' }]),
    }),
    /evaluationTime is required/,
  );
});

test('negative evaluationTime throws', () => {
  assert.throws(
    () => compose({
      candidates: [],
      observations: [],
      policy: policy([{ provider: 'provider-a', accountScope: 'primary' }]),
      evaluationTime: -1,
    }),
    /evaluationTime must be a non-negative millisecond timestamp/,
  );
});

test('non-integer evaluationTime throws', () => {
  assert.throws(
    () => compose({
      candidates: [],
      observations: [],
      policy: policy([{ provider: 'provider-a', accountScope: 'primary' }]),
      evaluationTime: 20_000.5,
    }),
    /evaluationTime must be a non-negative millisecond timestamp/,
  );
});

test('non-object policy throws', () => {
  assert.throws(
    () => compose({
      candidates: [],
      observations: [],
      policy: 'invalid',
      evaluationTime: NOW,
    }),
    /policy is required/,
  );
});

test('array policy throws', () => {
  assert.throws(
    () => compose({
      candidates: [],
      observations: [],
      policy: [],
      evaluationTime: NOW,
    }),
    /policy is required/,
  );
});

// ---------------------------------------------------------------------------
// Integration with policy targets
// ---------------------------------------------------------------------------

test('multi-target policy selects best provider at first available rank', () => {
  const ranked = [candidate(0)];
  const observations = [
    observation(0, 'cached', { provider: 'provider-b' }),
    observation(0, 'uncached', { provider: 'provider-a' }),
  ];

  const decision = compose({
    candidates: ranked,
    observations,
    policy: policy([
      { provider: 'provider-a', accountScope: 'primary' },
      { provider: 'provider-b', accountScope: 'primary' },
    ]),
  });

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedCandidate.provider, 'provider-b');
});

test('policy target order does not override candidate rank', () => {
  const ranked = [candidate(0), candidate(1)];
  const decision = compose({
    candidates: ranked,
    observations: [
      observation(0, 'cached', { provider: 'provider-b' }),
      observation(1, 'cached', { provider: 'provider-a' }),
    ],
    policy: policy([
      { provider: 'provider-a', accountScope: 'primary' },
      { provider: 'provider-b', accountScope: 'primary' },
    ]),
  });

  assert.equal(decision.selectedCandidate.rank, 0);
  assert.equal(decision.selectedCandidate.provider, 'provider-b');
});

test('multi-target with multiple candidates — candidate rank dominates', () => {
  const ranked = [candidate(0), candidate(1)];
  const decision = compose({
    candidates: ranked,
    observations: [
      observation(0, 'cached'),
      observation(1, 'cached', { provider: 'provider-b' }),
    ],
    policy: policy([
      { provider: 'provider-a', accountScope: 'primary' },
      { provider: 'provider-b', accountScope: 'primary' },
    ]),
  });

  assert.equal(decision.selectedCandidate.rank, 0);
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('DECISION_COMPOSITION_STATUSES exposes all valid statuses', () => {
  assert.deepEqual(DECISION_COMPOSITION_STATUSES, {
    SELECTED: 'selected',
    DEFERRED: 'deferred',
    UNAVAILABLE: 'unavailable',
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('all candidates unavailable yields unavailable status', () => {
  const ranked = [candidate(0), candidate(1), candidate(2)];
  const decision = compose({
    candidates: ranked,
    observations: [
      observation(0, 'uncached'),
      observation(1, 'uncached'),
      observation(2, 'uncached'),
    ],
  });

  assert.equal(decision.status, 'unavailable');
  assert.equal(decision.selectedCandidate, null);
  assert.equal(decision.reasonCodes[0], 'authoritatively-uncached');
});

test('mixed uncached and cached — cached wins at higher rank', () => {
  const ranked = [candidate(0), candidate(1)];
  const decision = compose({
    candidates: ranked,
    observations: [
      observation(0, 'cached'),
      observation(1, 'uncached'),
    ],
  });

  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedCandidate.rank, 0);
});

test('deferred status returned when no targets are resolvable', () => {
  const ranked = [candidate(0)];
  const decision = compose({
    candidates: ranked,
    observations: [observation(0, 'unknown')],
  });

  assert.equal(decision.status, 'deferred');
  assert.equal(decision.reasonCodes[0], 'provider-reality-unresolved');
});
