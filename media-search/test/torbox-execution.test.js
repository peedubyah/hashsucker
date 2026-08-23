import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTorBoxExecutionAdapter,
  TORBOX_EXECUTION_STATUS,
  TORBOX_PROVIDER_ID,
} from '../src/lib/providers/torbox-execution.js';
import {
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
import { createTorBoxProvider } from '../src/lib/providers/torbox.js';
import { PROVIDER_CAPABILITIES, createProviderAdapter } from '../src/lib/providers/capabilities.js';
import {
  HASH,
  MAGNET,
  createTorrentSuccess,
  createTorrentAuthError,
  createTorrentNotCached,
  createTorrentMalformed,
} from './fixtures/torbox-response-fixtures.js';
import { ProviderOperationError } from '../src/lib/providers/errors.js';

const NOW = 20_000;

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function readyExecutionRequest() {
  const identity = createReleaseIdentity(HASH, 0);
  const observation = createCacheObservation({
    provider: 'torbox',
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
    policy: createAcquisitionPolicy({ targets: [{ provider: 'torbox', accountScope: 'primary' }] }),
    evaluationTime: NOW,
  });
  const intent = createAcquisitionIntent({
    decision,
    evaluationTime: NOW,
    executionPolicy: Object.freeze({}),
  });
  // Manually construct execution request with torbox provider
  return Object.freeze({
    executionStatus: EXECUTION_STATUSES.READY,
    action: EXECUTION_ACTIONS.PLACE,
    candidateIdentity: Object.freeze({
      infoHash: intent.candidateIdentity.infoHash,
      fileIndex: intent.candidateIdentity.fileIndex,
      releaseKey: intent.candidateIdentity.releaseKey,
    }),
    provider: 'torbox',
    accountScope: 'primary',
    reasonCodes: intent.reasonCodes,
    evidence: intent.evidence,
    createdAt: NOW,
  });
}

function torboxCapability(apiKey = 'token') {
  return createTorBoxProvider({
    accountScope: 'primary',
    apiKey,
    now: () => NOW,
    fetchFn: async () => response(createTorrentSuccess()),
  });
}

function magnetResolver() {
  return async (candidateIdentity) => {
    if (candidateIdentity.infoHash === HASH) return MAGNET;
    throw new Error('No magnet for unknown identity');
  };
}

// ---------------------------------------------------------------------------
// Valid submission
// ---------------------------------------------------------------------------

test('valid TorBox execution request submits placement', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  const result = await adapter.submit({
    executionRequest: readyExecutionRequest(),
    providerCapability: torboxCapability(),
  });

  assert.equal(result.status, TORBOX_EXECUTION_STATUS.SUBMITTED);
  assert.equal(result.provider, TORBOX_PROVIDER_ID);
  assert.equal(result.providerResourceId, '12345');
  assert.equal(result.infoHash, HASH);
  assert.equal(result.accountScope, 'primary');
});

test('generic request maps correctly to TorBox capability', async () => {
  let capturedMagnet = null;
  const capability = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async (url, options) => {
      // Capture the magnet from the request body
      const body = options?.body;
      if (body) {
        const params = new URLSearchParams(body);
        capturedMagnet = params.get('magnet');
      }
      return response(createTorrentSuccess());
    },
  });

  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await adapter.submit({
    executionRequest: readyExecutionRequest(),
    providerCapability: capability,
  });

  assert.equal(capturedMagnet, MAGNET);
});

// ---------------------------------------------------------------------------
// Identity preservation
// ---------------------------------------------------------------------------

test('provider identity preserved in submission result', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  const result = await adapter.submit({
    executionRequest: readyExecutionRequest(),
    providerCapability: torboxCapability(),
  });

  assert.equal(result.provider, 'torbox');
});

test('account scope preserved in submission result', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  const result = await adapter.submit({
    executionRequest: readyExecutionRequest(),
    providerCapability: torboxCapability(),
  });

  assert.equal(result.accountScope, 'primary');
});

test('provider resource ID preserved in submission result', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  const result = await adapter.submit({
    executionRequest: readyExecutionRequest(),
    providerCapability: torboxCapability(),
  });

  assert.equal(result.providerResourceId, '12345');
});

// ---------------------------------------------------------------------------
// Rejection of non-ready requests
// ---------------------------------------------------------------------------

test('deferred execution request rejected', async () => {
  const deferredRequest = Object.freeze({
    executionStatus: EXECUTION_STATUSES.DEFERRED,
    action: null,
    candidateIdentity: null,
    provider: 'torbox',
    accountScope: 'primary',
    reasonCodes: [],
    evidence: null,
    createdAt: NOW,
  });

  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({
      executionRequest: deferredRequest,
      providerCapability: torboxCapability(),
    }),
    (err) => err instanceof TypeError && /deferred/.test(err.message),
  );
});

test('unavailable execution request rejected', async () => {
  const unavailableRequest = Object.freeze({
    executionStatus: EXECUTION_STATUSES.UNAVAILABLE,
    action: null,
    candidateIdentity: null,
    provider: 'torbox',
    accountScope: 'primary',
    reasonCodes: [],
    evidence: null,
    createdAt: NOW,
  });

  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({
      executionRequest: unavailableRequest,
      providerCapability: torboxCapability(),
    }),
    (err) => err instanceof TypeError && /unavailable/.test(err.message),
  );
});

test('wrong provider rejected', async () => {
  const wrongProviderRequest = Object.freeze({
    executionStatus: EXECUTION_STATUSES.READY,
    action: EXECUTION_ACTIONS.PLACE,
    candidateIdentity: Object.freeze({ infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` }),
    provider: 'real-debrid',
    accountScope: 'primary',
    reasonCodes: [],
    evidence: {},
    createdAt: NOW,
  });

  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({
      executionRequest: wrongProviderRequest,
      providerCapability: torboxCapability(),
    }),
    (err) => err instanceof TypeError && /Provider mismatch/.test(err.message),
  );
});

test('missing candidate identity rejected', async () => {
  const missingIdentityRequest = Object.freeze({
    executionStatus: EXECUTION_STATUSES.READY,
    action: EXECUTION_ACTIONS.PLACE,
    candidateIdentity: null,
    provider: 'torbox',
    accountScope: 'primary',
    reasonCodes: [],
    evidence: {},
    createdAt: NOW,
  });

  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({
      executionRequest: missingIdentityRequest,
      providerCapability: torboxCapability(),
    }),
    (err) => err instanceof TypeError && /candidateIdentity/.test(err.message),
  );
});

test('missing account scope rejected', async () => {
  const missingScopeRequest = Object.freeze({
    executionStatus: EXECUTION_STATUSES.READY,
    action: EXECUTION_ACTIONS.PLACE,
    candidateIdentity: Object.freeze({ infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` }),
    provider: 'torbox',
    accountScope: null,
    reasonCodes: [],
    evidence: {},
    createdAt: NOW,
  });

  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({
      executionRequest: missingScopeRequest,
      providerCapability: torboxCapability(),
    }),
    (err) => err instanceof TypeError && /accountScope/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Provider error preservation
// ---------------------------------------------------------------------------

test('provider auth failure preserved as ProviderOperationError', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({
      executionRequest: readyExecutionRequest(),
      providerCapability: createTorBoxProvider({
        accountScope: 'primary',
        apiKey: 'bad-token',
        now: () => NOW,
        fetchFn: async () => response(createTorrentAuthError(), 401),
      }),
    }),
    (err) => err instanceof ProviderOperationError && err.category === 'authentication',
  );
});

test('provider rejection preserved as ProviderOperationError', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({
      executionRequest: readyExecutionRequest(),
      providerCapability: createTorBoxProvider({
        accountScope: 'primary',
        apiKey: 'token',
        now: () => NOW,
        fetchFn: async () => response(createTorrentNotCached(), 200),
      }),
    }),
    (err) => err instanceof ProviderOperationError && err.category === 'not-found',
  );
});

test('malformed provider response preserved as error', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({
      executionRequest: readyExecutionRequest(),
      providerCapability: createTorBoxProvider({
        accountScope: 'primary',
        apiKey: 'token',
        now: () => NOW,
        fetchFn: async () => response(createTorrentMalformed(), 200),
      }),
    }),
    (err) => err instanceof Error,
  );
});

// ---------------------------------------------------------------------------
// No polling, no lifecycle handling
// ---------------------------------------------------------------------------

test('no polling occurs during submission', async () => {
  let fetchCallCount = 0;
  const capability = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => {
      fetchCallCount += 1;
      return response(createTorrentSuccess());
    },
  });

  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await adapter.submit({
    executionRequest: readyExecutionRequest(),
    providerCapability: capability,
  });

  // Exactly one API call — no polling
  assert.equal(fetchCallCount, 1);
});

test('no lifecycle handling occurs — result contains no state beyond submitted', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  const result = await adapter.submit({
    executionRequest: readyExecutionRequest(),
    providerCapability: torboxCapability(),
  });

  assert.equal(result.status, 'submitted');
  // No lifecycle state fields
  assert.equal(result.downloadState, undefined);
  assert.equal(result.progress, undefined);
  assert.equal(result.files, undefined);
});

// ---------------------------------------------------------------------------
// No generic execution contract mutation
// ---------------------------------------------------------------------------

test('generic execution request is not mutated', async () => {
  const request = readyExecutionRequest();
  const originalRequest = JSON.parse(JSON.stringify(request));

  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await adapter.submit({
    executionRequest: request,
    providerCapability: torboxCapability(),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(request)), originalRequest);
});

// ---------------------------------------------------------------------------
// Output frozen
// ---------------------------------------------------------------------------

test('submission result is frozen', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  const result = await adapter.submit({
    executionRequest: readyExecutionRequest(),
    providerCapability: torboxCapability(),
  });

  assert.ok(Object.isFrozen(result));
});

// ---------------------------------------------------------------------------
// Invalid adapter construction
// ---------------------------------------------------------------------------

test('adapter construction requires getMagnetForIdentity', () => {
  assert.throws(
    () => createTorBoxExecutionAdapter({}),
    (err) => err instanceof TypeError && /getMagnetForIdentity is required/.test(err.message),
  );
});

test('submit requires executionRequest', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({ providerCapability: torboxCapability() }),
    (err) => err instanceof TypeError && /executionRequest is required/.test(err.message),
  );
});

test('submit requires providerCapability', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  await assert.rejects(
    () => adapter.submit({ executionRequest: readyExecutionRequest() }),
    (err) => err instanceof TypeError && /providerCapability is required/.test(err.message),
  );
});

test('submit rejects providerCapability without placement-create', async () => {
  const adapter = createTorBoxExecutionAdapter({ getMagnetForIdentity: magnetResolver() });
  const emptyCapability = createProviderAdapter({
    provider: 'torbox',
    accountScope: 'primary',
    capabilities: {},
  });
  await assert.rejects(
    () => adapter.submit({
      executionRequest: readyExecutionRequest(),
      providerCapability: emptyCapability,
    }),
    (err) => err instanceof TypeError && /placement-create/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// No magic magnet generation
// ---------------------------------------------------------------------------

test('adapter does not generate magnets from infoHash', async () => {
  // Resolver that would generate a synthetic magnet — should not be called
  // for this test. Instead, we verify the adapter uses the resolver output,
  // not an internal generation.
  let resolverCalled = false;
  const adapter = createTorBoxExecutionAdapter({
    getMagnetForIdentity: async () => {
      resolverCalled = true;
      return MAGNET;
    },
  });

  await adapter.submit({
    executionRequest: readyExecutionRequest(),
    providerCapability: torboxCapability(),
  });

  assert.ok(resolverCalled, 'adapter must use provided resolver, not internal generation');
});

test('adapter throws when resolver returns no magnet', async () => {
  const adapter = createTorBoxExecutionAdapter({
    getMagnetForIdentity: async () => null,
  });

  await assert.rejects(
    () => adapter.submit({
      executionRequest: readyExecutionRequest(),
      providerCapability: torboxCapability(),
    }),
    (err) => err instanceof TypeError && /No magnet available/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('TORBOX_EXECUTION_STATUS contains expected values', () => {
  assert.equal(TORBOX_EXECUTION_STATUS.SUBMITTED, 'submitted');
});

test('TORBOX_PROVIDER_ID is torbox', () => {
  assert.equal(TORBOX_PROVIDER_ID, 'torbox');
});
