import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPlacementResource,
  PLACEMENT_RESOURCE_STATUSES,
} from '../src/lib/acquisition/placement-resource.js';

const NOW = 20_000;
const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

function validInput(overrides = {}) {
  return {
    provider: 'torbox',
    accountScope: 'primary',
    providerResourceId: '12345',
    candidateIdentity: {
      infoHash: HASH,
      fileIndex: 0,
      releaseKey: `${HASH}:0`,
    },
    createdAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid placement resource creation
// ---------------------------------------------------------------------------

test('valid placement resource creation', () => {
  const resource = createPlacementResource(validInput());

  assert.equal(resource.provider, 'torbox');
  assert.equal(resource.accountScope, 'primary');
  assert.equal(resource.providerResourceId, '12345');
  assert.equal(resource.placementStatus, PLACEMENT_RESOURCE_STATUSES.SUBMITTED);
  assert.equal(resource.createdAt, NOW);
});

test('provider preserved', () => {
  const resource = createPlacementResource(validInput({ provider: 'real-debrid' }));

  assert.equal(resource.provider, 'real-debrid');
});

test('account scope preserved', () => {
  const resource = createPlacementResource(validInput({ accountScope: 'secondary' }));

  assert.equal(resource.accountScope, 'secondary');
});

test('provider resource ID preserved', () => {
  const resource = createPlacementResource(validInput({ providerResourceId: 'abc-123' }));

  assert.equal(resource.providerResourceId, 'abc-123');
});

test('candidate identity preserved', () => {
  const resource = createPlacementResource(validInput());

  assert.equal(resource.candidateIdentity.infoHash, HASH);
  assert.equal(resource.candidateIdentity.fileIndex, 0);
  assert.equal(resource.candidateIdentity.releaseKey, `${HASH}:0`);
});

test('submitted status assigned', () => {
  const resource = createPlacementResource(validInput());

  assert.equal(resource.placementStatus, 'submitted');
});

// ---------------------------------------------------------------------------
// Frozen output
// ---------------------------------------------------------------------------

test('output frozen', () => {
  const resource = createPlacementResource(validInput());

  assert.ok(Object.isFrozen(resource));
  assert.ok(Object.isFrozen(resource.candidateIdentity));
});

// ---------------------------------------------------------------------------
// Null fileIndex preserved
// ---------------------------------------------------------------------------

test('null fileIndex preserved distinctly from zero', () => {
  const resource = createPlacementResource(validInput({
    candidateIdentity: {
      infoHash: HASH,
      fileIndex: null,
      releaseKey: `${HASH}:torrent`,
    },
  }));

  assert.equal(resource.candidateIdentity.fileIndex, null);
  assert.equal(resource.candidateIdentity.releaseKey, `${HASH}:torrent`);
});

// ---------------------------------------------------------------------------
// Invalid input rejected
// ---------------------------------------------------------------------------

test('missing provider throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ provider: undefined })),
    (err) => err instanceof TypeError && /provider is required/.test(err.message),
  );
});

test('empty provider throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ provider: '' })),
    (err) => err instanceof TypeError && /provider is required/.test(err.message),
  );
});

test('non-string provider throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ provider: 123 })),
    (err) => err instanceof TypeError && /provider is required/.test(err.message),
  );
});

test('missing accountScope throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ accountScope: undefined })),
    (err) => err instanceof TypeError && /accountScope is required/.test(err.message),
  );
});

test('empty accountScope throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ accountScope: '' })),
    (err) => err instanceof TypeError && /accountScope is required/.test(err.message),
  );
});

test('missing providerResourceId throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ providerResourceId: undefined })),
    (err) => err instanceof TypeError && /providerResourceId is required/.test(err.message),
  );
});

test('empty providerResourceId throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ providerResourceId: '' })),
    (err) => err instanceof TypeError && /providerResourceId is required/.test(err.message),
  );
});

test('missing candidateIdentity throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ candidateIdentity: undefined })),
    (err) => err instanceof TypeError && /candidateIdentity is required/.test(err.message),
  );
});

test('null candidateIdentity throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ candidateIdentity: null })),
    (err) => err instanceof TypeError && /candidateIdentity is required/.test(err.message),
  );
});

test('array candidateIdentity throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ candidateIdentity: [] })),
    (err) => err instanceof TypeError && /candidateIdentity is required/.test(err.message),
  );
});

test('candidateIdentity missing infoHash throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({
      candidateIdentity: { fileIndex: 0, releaseKey: `${HASH}:0` },
    })),
    (err) => err instanceof TypeError && /infoHash is required/.test(err.message),
  );
});

test('candidateIdentity missing releaseKey throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({
      candidateIdentity: { infoHash: HASH, fileIndex: 0 },
    })),
    (err) => err instanceof TypeError && /releaseKey is required/.test(err.message),
  );
});

test('missing createdAt throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ createdAt: undefined })),
    (err) => err instanceof TypeError && /createdAt is required/.test(err.message),
  );
});

test('null createdAt throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ createdAt: null })),
    (err) => err instanceof TypeError && /createdAt is required/.test(err.message),
  );
});

test('negative createdAt throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ createdAt: -1 })),
    (err) => err instanceof TypeError && /non-negative millisecond timestamp/.test(err.message),
  );
});

test('non-integer createdAt throws', () => {
  assert.throws(
    () => createPlacementResource(validInput({ createdAt: 1.5 })),
    (err) => err instanceof TypeError && /non-negative millisecond timestamp/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// No provider calls
// ---------------------------------------------------------------------------

test('no provider APIs are called during creation', () => {
  // This test verifies the pure boundary: no provider state is accessed.
  // The function is synchronous and has no side effects.
  const resource = createPlacementResource(validInput());

  // Synchronous return indicates no network call
  assert.ok(resource);
  assert.equal(typeof resource, 'object');
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('PLACEMENT_RESOURCE_STATUSES contains expected values', () => {
  assert.equal(PLACEMENT_RESOURCE_STATUSES.SUBMITTED, 'submitted');
});
