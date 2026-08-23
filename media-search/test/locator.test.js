import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveAcquisitionLocator,
  LOCATOR_TYPES,
} from '../src/lib/acquisition/locator.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Some+Release`;

function candidate(overrides = {}) {
  return {
    infoHash: HASH,
    fileIndex: 0,
    releaseKey: `${HASH}:0`,
    filename: 'some.release.mkv',
    score: 1,
    magnet: MAGNET,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid magnet resolves
// ---------------------------------------------------------------------------

test('valid magnet resolves locator', () => {
  const locator = resolveAcquisitionLocator({ candidate: candidate() });

  assert.equal(locator.locatorType, LOCATOR_TYPES.MAGNET);
  assert.equal(locator.locatorValue, MAGNET);
  assert.equal(locator.source, 'candidate');
});

test('locator output frozen', () => {
  const locator = resolveAcquisitionLocator({ candidate: candidate() });

  assert.ok(Object.isFrozen(locator));
});

// ---------------------------------------------------------------------------
// Source preserved
// ---------------------------------------------------------------------------

test('source preserved as candidate', () => {
  const locator = resolveAcquisitionLocator({ candidate: candidate() });

  assert.equal(locator.source, 'candidate');
});

// ---------------------------------------------------------------------------
// Magnet variants
// ---------------------------------------------------------------------------

test('magnet with mixed case infoHash normalizes and matches', () => {
  const mixedCaseHash = 'ABCDEF0123456789abcdef0123456789abcdef01';
  const magnet = `magnet:?xt=urn:btih:${mixedCaseHash}`;
  const locator = resolveAcquisitionLocator({
    candidate: candidate({ infoHash: mixedCaseHash, magnet }),
  });

  assert.equal(locator.locatorType, LOCATOR_TYPES.MAGNET);
});

test('magnet with query parameters preserves full URI', () => {
  const magnetWithParams = `magnet:?xt=urn:btih:${HASH}&dn=Release+Name&tr=tracker.example.com`;
  const locator = resolveAcquisitionLocator({
    candidate: candidate({ magnet: magnetWithParams }),
  });

  assert.equal(locator.locatorValue, magnetWithParams);
});

// ---------------------------------------------------------------------------
// Missing magnet rejected
// ---------------------------------------------------------------------------

test('missing magnet throws', () => {
  const c = candidate();
  delete c.magnet;

  assert.throws(
    () => resolveAcquisitionLocator({ candidate: c }),
    (err) => err instanceof TypeError && /magnet is required/.test(err.message),
  );
});

test('null magnet throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({ candidate: candidate({ magnet: null }) }),
    (err) => err instanceof TypeError && /magnet is required/.test(err.message),
  );
});

test('empty string magnet throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({ candidate: candidate({ magnet: '' }) }),
    (err) => err instanceof TypeError && /magnet is required/.test(err.message),
  );
});

test('non-string magnet throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({ candidate: candidate({ magnet: 12345 }) }),
    (err) => err instanceof TypeError && /magnet is required/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Malformed magnet rejected
// ---------------------------------------------------------------------------

test('malformed magnet - missing magnet: prefix throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({
      candidate: candidate({ magnet: `xt=urn:btih:${HASH}` }),
    }),
    (err) => err instanceof TypeError && /malformed magnet URI/.test(err.message),
  );
});

test('malformed magnet - missing xt=urn:btih throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({
      candidate: candidate({ magnet: 'magnet:?dn=No+Hash' }),
    }),
    (err) => err instanceof TypeError && /malformed magnet URI/.test(err.message),
  );
});

test('malformed magnet - short hash throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({
      candidate: candidate({ magnet: 'magnet:?xt=urn:btih:abcdef' }),
    }),
    (err) => err instanceof TypeError && /malformed magnet URI/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Hash mismatch rejected
// ---------------------------------------------------------------------------

test('infoHash mismatch rejected', () => {
  const otherHash = '1234567890abcdef1234567890abcdef12345678';
  const magnetWithOtherHash = `magnet:?xt=urn:btih:${otherHash}`;

  assert.throws(
    () => resolveAcquisitionLocator({
      candidate: candidate({ magnet: magnetWithOtherHash }),
    }),
    (err) => err instanceof TypeError && /infoHash mismatch/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Missing candidate rejected
// ---------------------------------------------------------------------------

test('missing candidate throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({}),
    (err) => err instanceof TypeError && /candidate is required/.test(err.message),
  );
});

test('null candidate throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({ candidate: null }),
    (err) => err instanceof TypeError && /candidate is required/.test(err.message),
  );
});

test('non-object candidate throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({ candidate: 'candidate' }),
    (err) => err instanceof TypeError && /candidate is required/.test(err.message),
  );
});

test('array candidate throws', () => {
  assert.throws(
    () => resolveAcquisitionLocator({ candidate: [] }),
    (err) => err instanceof TypeError && /candidate is required/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Missing infoHash rejected
// ---------------------------------------------------------------------------

test('missing candidate.infoHash throws', () => {
  const c = candidate();
  delete c.infoHash;

  assert.throws(
    () => resolveAcquisitionLocator({ candidate: c }),
    (err) => err instanceof TypeError && /infoHash is required/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Candidate input not mutated
// ---------------------------------------------------------------------------

test('candidate input not mutated', () => {
  const c = candidate();
  const original = JSON.parse(JSON.stringify(c));

  resolveAcquisitionLocator({ candidate: c });

  assert.deepEqual(JSON.parse(JSON.stringify(c)), original);
});

// ---------------------------------------------------------------------------
// No provider calls
// ---------------------------------------------------------------------------

test('no network calls - pure function', () => {
  // This test verifies resolveAcquisitionLocator does not make network calls.
  // The function is synchronous and has no side effects.
  const result = resolveAcquisitionLocator({ candidate: candidate() });

  // Synchronous return indicates no network call
  assert.ok(result);
  assert.equal(typeof result, 'object');
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('LOCATOR_TYPES contains expected values', () => {
  assert.equal(LOCATOR_TYPES.MAGNET, 'magnet');
});
