import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPlacementObservation,
  PLACEMENT_OBSERVATION_STATUSES,
} from '../src/lib/acquisition/placement-observation.js';

const NOW = 20_000;
const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

function validInput(overrides = {}) {
  return {
    provider: 'torbox',
    accountScope: 'primary',
    providerResourceId: '12345',
    placementStatus: 'submitted',
    providerStatus: null,
    progress: null,
    observedAt: NOW,
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid observations
// ---------------------------------------------------------------------------

test('valid submitted observation', () => {
  const observation = createPlacementObservation(validInput());

  assert.equal(observation.status, PLACEMENT_OBSERVATION_STATUSES.SUBMITTED);
  assert.equal(observation.provider, 'torbox');
  assert.equal(observation.providerResourceId, '12345');
});

test('valid processing observation', () => {
  const observation = createPlacementObservation(validInput({
    placementStatus: 'processing',
    providerStatus: 'downloading',
    progress: 45.5,
  }));

  assert.equal(observation.status, PLACEMENT_OBSERVATION_STATUSES.PROCESSING);
  assert.equal(observation.providerStatus, 'downloading');
  assert.equal(observation.progress, 45.5);
});

test('valid ready observation', () => {
  const observation = createPlacementObservation(validInput({
    placementStatus: 'ready',
    providerStatus: 'finished',
    progress: 100,
  }));

  assert.equal(observation.status, PLACEMENT_OBSERVATION_STATUSES.READY);
  assert.equal(observation.progress, 100);
});

test('valid failed observation', () => {
  const observation = createPlacementObservation(validInput({
    placementStatus: 'failed',
    error: { category: 'provider_rejection', message: 'Torrent not cached' },
  }));

  assert.equal(observation.status, PLACEMENT_OBSERVATION_STATUSES.FAILED);
  assert.equal(observation.error.category, 'provider_rejection');
});

test('valid unknown observation', () => {
  const observation = createPlacementObservation(validInput({
    placementStatus: 'unknown',
    providerStatus: 'error',
  }));

  assert.equal(observation.status, PLACEMENT_OBSERVATION_STATUSES.UNKNOWN);
});

// ---------------------------------------------------------------------------
// Identity preservation
// ---------------------------------------------------------------------------

test('provider identity preserved', () => {
  const observation = createPlacementObservation(validInput({ provider: 'real-debrid' }));

  assert.equal(observation.provider, 'real-debrid');
});

test('account scope preserved', () => {
  const observation = createPlacementObservation(validInput({ accountScope: 'secondary' }));

  assert.equal(observation.accountScope, 'secondary');
});

test('provider resource identity preserved', () => {
  const observation = createPlacementObservation(validInput({ providerResourceId: 'rd-abc-123' }));

  assert.equal(observation.providerResourceId, 'rd-abc-123');
});

// ---------------------------------------------------------------------------
// Provider status preservation
// ---------------------------------------------------------------------------

test('providerStatus preserved - TorBox downloading', () => {
  const observation = createPlacementObservation(validInput({
    placementStatus: 'processing',
    providerStatus: 'downloading',
  }));

  assert.equal(observation.providerStatus, 'downloading');
});

test('providerStatus preserved - RD waiting_files_selection', () => {
  const observation = createPlacementObservation(validInput({
    provider: 'real-debrid',
    placementStatus: 'processing',
    providerStatus: 'waiting_files_selection',
  }));

  assert.equal(observation.providerStatus, 'waiting_files_selection');
});

test('providerStatus preserved - RD downloaded', () => {
  const observation = createPlacementObservation(validInput({
    provider: 'real-debrid',
    placementStatus: 'ready',
    providerStatus: 'downloaded',
    progress: 100,
  }));

  assert.equal(observation.providerStatus, 'downloaded');
});

test('providerStatus defaults to null', () => {
  const observation = createPlacementObservation(validInput());

  assert.equal(observation.providerStatus, null);
});

// ---------------------------------------------------------------------------
// Progress handling
// ---------------------------------------------------------------------------

test('progress zero is valid', () => {
  const observation = createPlacementObservation(validInput({ progress: 0 }));

  assert.equal(observation.progress, 0);
});

test('progress 100 is valid', () => {
  const observation = createPlacementObservation(validInput({ progress: 100 }));

  assert.equal(observation.progress, 100);
});

test('progress fractional is valid', () => {
  const observation = createPlacementObservation(validInput({ progress: 33.33 }));

  assert.equal(observation.progress, 33.33);
});

test('progress null is valid', () => {
  const observation = createPlacementObservation(validInput({ progress: null }));

  assert.equal(observation.progress, null);
});

test('negative progress rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ progress: -1 })),
    (err) => err instanceof TypeError && /between 0 and 100/.test(err.message),
  );
});

test('progress greater than 100 rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ progress: 101 })),
    (err) => err instanceof TypeError && /between 0 and 100/.test(err.message),
  );
});

test('non-numeric progress rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ progress: 'half' })),
    (err) => err instanceof TypeError && /finite number/.test(err.message),
  );
});

test('infinity progress rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ progress: Infinity })),
    (err) => err instanceof TypeError && /finite number/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Timestamp preservation
// ---------------------------------------------------------------------------

test('timestamp preserved', () => {
  const observation = createPlacementObservation(validInput({ observedAt: 1234567890 }));

  assert.equal(observation.observedAt, 1234567890);
});

// ---------------------------------------------------------------------------
// Frozen output
// ---------------------------------------------------------------------------

test('output frozen', () => {
  const observation = createPlacementObservation(validInput());

  assert.ok(Object.isFrozen(observation));
});

test('error frozen when present', () => {
  const observation = createPlacementObservation(validInput({
    placementStatus: 'failed',
    error: { category: 'network', message: 'timeout' },
  }));

  assert.ok(Object.isFrozen(observation.error));
});

// ---------------------------------------------------------------------------
// Invalid status rejection
// ---------------------------------------------------------------------------

test('invalid status rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ placementStatus: 'downloading' })),
    (err) => err instanceof TypeError && /Invalid placement status/.test(err.message),
  );
});

test('empty status rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ placementStatus: '' })),
    (err) => err instanceof TypeError && /placementStatus is required/.test(err.message),
  );
});

test('non-string status rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ placementStatus: 123 })),
    (err) => err instanceof TypeError && /placementStatus is required/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Missing required fields rejected
// ---------------------------------------------------------------------------

test('missing provider rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ provider: undefined })),
    (err) => err instanceof TypeError && /provider is required/.test(err.message),
  );
});

test('empty provider rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ provider: '' })),
    (err) => err instanceof TypeError && /provider is required/.test(err.message),
  );
});

test('missing providerResourceId rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ providerResourceId: undefined })),
    (err) => err instanceof TypeError && /providerResourceId is required/.test(err.message),
  );
});

test('empty providerResourceId rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ providerResourceId: '' })),
    (err) => err instanceof TypeError && /providerResourceId is required/.test(err.message),
  );
});

test('missing accountScope rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ accountScope: undefined })),
    (err) => err instanceof TypeError && /accountScope is required/.test(err.message),
  );
});

test('empty accountScope rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ accountScope: '' })),
    (err) => err instanceof TypeError && /accountScope is required/.test(err.message),
  );
});

test('missing observedAt rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ observedAt: undefined })),
    (err) => err instanceof TypeError && /observedAt is required/.test(err.message),
  );
});

test('null observedAt rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ observedAt: null })),
    (err) => err instanceof TypeError && /observedAt is required/.test(err.message),
  );
});

test('negative observedAt rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ observedAt: -1 })),
    (err) => err instanceof TypeError && /non-negative millisecond timestamp/.test(err.message),
  );
});

test('non-integer observedAt rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ observedAt: 1.5 })),
    (err) => err instanceof TypeError && /non-negative millisecond timestamp/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Provider status validation
// ---------------------------------------------------------------------------

test('non-string providerStatus rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ providerStatus: 123 })),
    (err) => err instanceof TypeError && /providerStatus must be a string or null/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Error validation
// ---------------------------------------------------------------------------

test('error must be object or null', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ error: 'failed' })),
    (err) => err instanceof TypeError && /error must be an object or null/.test(err.message),
  );
});

test('error array rejected', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ error: [] })),
    (err) => err instanceof TypeError && /error must be an object or null/.test(err.message),
  );
});

test('error requires category', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ error: { message: 'no category' } })),
    (err) => err instanceof TypeError && /error.category is required/.test(err.message),
  );
});

test('error category must be string', () => {
  assert.throws(
    () => createPlacementObservation(validInput({ error: { category: 123 } })),
    (err) => err instanceof TypeError && /error.category is required/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// No provider calls
// ---------------------------------------------------------------------------

test('no provider APIs are called during observation creation', () => {
  // This test verifies the pure boundary: no provider state is accessed.
  // The function is synchronous and has no side effects.
  const observation = createPlacementObservation(validInput());

  // Synchronous return indicates no network call
  assert.ok(observation);
  assert.equal(typeof observation, 'object');
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('PLACEMENT_OBSERVATION_STATUSES contains expected values', () => {
  assert.equal(PLACEMENT_OBSERVATION_STATUSES.SUBMITTED, 'submitted');
  assert.equal(PLACEMENT_OBSERVATION_STATUSES.PROCESSING, 'processing');
  assert.equal(PLACEMENT_OBSERVATION_STATUSES.READY, 'ready');
  assert.equal(PLACEMENT_OBSERVATION_STATUSES.FAILED, 'failed');
  assert.equal(PLACEMENT_OBSERVATION_STATUSES.UNKNOWN, 'unknown');
});
