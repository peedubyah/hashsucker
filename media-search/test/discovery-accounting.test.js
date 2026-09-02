/**
 * Discovery accounting targeted tests.
 *
 * Slice 2.9: prove the discovery accounting module:
 *  - snapshots include every known source plus any dynamically
 *    added source,
 *  - recordRequest / recordCandidates / recordError increment the
 *    per-source counters,
 *  - delta() is clamped to zero on each per-source counter,
 *  - reset() zeros the registry,
 *  - secret-free: rejected source names map to "unknown" rather
 *    than leaking credentials/URLs,
 *  - the public /api/debug/discovery-accounting shape is
 *    secret-free.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoveryAccounting,
  formatDiscoveryAccounting,
  isSecretFreeDiscoveryValue,
} from '../src/lib/discovery/discovery-accounting.js';

function freshSnapshot() {
  discoveryAccounting.reset();
  return discoveryAccounting.snapshot();
}

test('discovery-accounting: starts zeroed with the known default sources', () => {
  const snap = freshSnapshot();
  assert.ok(snap.timestamp > 0);
  const knownSources = [
    'torrentio-torbox',
    'torrentio-realdebrid',
    'comet-torbox',
    'comet-realdebrid',
    'comet-manual',
    'torznab',
  ];
  for (const name of knownSources) {
    assert.ok(snap.sources[name], `known source ${name} should be present`);
    assert.deepEqual(
      snap.sources[name],
      { requests: 0, candidates: 0, errors: 0 },
      `default source ${name} starts at zero`,
    );
  }
});

test('discovery-accounting: recordRequest / recordCandidates / recordError increment per source', () => {
  freshSnapshot();
  discoveryAccounting.recordRequest('torrentio-torbox');
  discoveryAccounting.recordRequest('torrentio-torbox');
  discoveryAccounting.recordRequest('comet-torbox');
  discoveryAccounting.recordCandidates('torrentio-torbox', 12);
  discoveryAccounting.recordCandidates('comet-torbox', 3);
  discoveryAccounting.recordError('comet-torbox');
  const snap = discoveryAccounting.snapshot();
  assert.equal(snap.sources['torrentio-torbox'].requests, 2);
  assert.equal(snap.sources['torrentio-torbox'].candidates, 12);
  assert.equal(snap.sources['torrentio-torbox'].errors, 0);
  assert.equal(snap.sources['comet-torbox'].requests, 1);
  assert.equal(snap.sources['comet-torbox'].candidates, 3);
  assert.equal(snap.sources['comet-torbox'].errors, 1);
});

test('discovery-accounting: dynamic source name is added and counted', () => {
  freshSnapshot();
  discoveryAccounting.recordRequest('torznab.0');
  discoveryAccounting.recordCandidates('torznab.0', 5);
  const snap = discoveryAccounting.snapshot();
  assert.ok(snap.sources['torznab.0'], 'dynamic source present');
  assert.equal(snap.sources['torznab.0'].requests, 1);
  assert.equal(snap.sources['torznab.0'].candidates, 5);
});

test('discovery-accounting: secret-bearing source names map to "unknown"', () => {
  freshSnapshot();
  // A URL-like or key-bearing name must be refused.
  discoveryAccounting.recordRequest('https://torrentio.strem.fun/abc=KEY/manifest.json');
  discoveryAccounting.recordRequest('addon-with-key=abc123');
  const snap = discoveryAccounting.snapshot();
  assert.ok(snap.sources['unknown'], 'refused names bucketed under "unknown"');
  assert.ok(snap.sources['unknown'].requests >= 2);
  // The refused names must NOT appear as their own keys.
  assert.equal(snap.sources['https://torrentio.strem.fun/abc=KEY/manifest.json'], undefined);
  assert.equal(snap.sources['addon-with-key=abc123'], undefined);
});

test('discovery-accounting: delta is clamped to zero on per-source counters', () => {
  const before = freshSnapshot();
  discoveryAccounting.recordRequest('torrentio-torbox');
  discoveryAccounting.recordCandidates('torrentio-torbox', 4);
  const after = discoveryAccounting.snapshot();
  const delta = discoveryAccounting.delta(before);
  assert.equal(delta.sources['torrentio-torbox'].requests, 1);
  assert.equal(delta.sources['torrentio-torbox'].candidates, 4);
  // Negative deltas (after < before on any field) clamp to 0.
  const fakeBefore = {
    timestamp: before.timestamp,
    sources: {
      'torrentio-torbox': { requests: 999, candidates: 999, errors: 999 },
    },
  };
  const negativeDelta = discoveryAccounting.delta(fakeBefore);
  assert.equal(negativeDelta.sources['torrentio-torbox'].requests, 0,
    'negative delta clamped to zero');
  void after;
});

test('discovery-accounting: reset() zeros all counters and returns previous snapshot', () => {
  freshSnapshot();
  discoveryAccounting.recordRequest('torrentio-torbox');
  discoveryAccounting.recordCandidates('torrentio-torbox', 7);
  const prev = discoveryAccounting.reset();
  assert.equal(prev.sources['torrentio-torbox'].requests, 1);
  assert.equal(prev.sources['torrentio-torbox'].candidates, 7);
  const snap = discoveryAccounting.snapshot();
  assert.equal(snap.sources['torrentio-torbox'].requests, 0);
  assert.equal(snap.sources['torrentio-torbox'].candidates, 0);
});

test('discovery-accounting: incrementing only one source does not affect others', () => {
  freshSnapshot();
  discoveryAccounting.recordRequest('torrentio-torbox');
  const snap = discoveryAccounting.snapshot();
  assert.equal(snap.sources['torrentio-torbox'].requests, 1);
  assert.equal(snap.sources['comet-torbox'].requests, 0);
  assert.equal(snap.sources['torznab'].requests, 0);
});

test('discovery-accounting: formatDiscoveryAccounting renders active sources only by default', () => {
  freshSnapshot();
  discoveryAccounting.recordRequest('torrentio-torbox');
  discoveryAccounting.recordCandidates('torrentio-torbox', 5);
  const snap = discoveryAccounting.snapshot();
  const text = formatDiscoveryAccounting(snap, { title: 'Live Discovery' });
  assert.match(text, /torrentio-torbox/);
  assert.match(text, /requests=1/);
  assert.match(text, /candidates=5/);
  // The other default sources are zero and should be omitted by default.
  assert.doesNotMatch(text, /comet-torbox:/);
});

test('discovery-accounting: showAll renders all known sources', () => {
  freshSnapshot();
  const snap = discoveryAccounting.snapshot();
  const text = formatDiscoveryAccounting(snap, { title: 'Live Discovery', showAll: true });
  for (const name of ['torrentio-torbox', 'comet-torbox', 'comet-realdebrid', 'torznab']) {
    assert.match(text, new RegExp(name + ':'), `${name} should appear in showAll output`);
  }
});

test('discovery-accounting: isSecretFreeDiscoveryValue accepts only safe values', () => {
  assert.equal(isSecretFreeDiscoveryValue(null), true);
  assert.equal(isSecretFreeDiscoveryValue(0), true);
  assert.equal(isSecretFreeDiscoveryValue(42), true);
  assert.equal(isSecretFreeDiscoveryValue('torrentio-torbox'), true);
  assert.equal(isSecretFreeDiscoveryValue('comet-realdebrid'), true);
  // Secret-bearing strings are rejected.
  assert.equal(isSecretFreeDiscoveryValue('https://x.example/abc=KEY'), false);
  assert.equal(isSecretFreeDiscoveryValue('foo bar'), false);
  assert.equal(isSecretFreeDiscoveryValue('a'.repeat(65)), false);
  // Numbers, booleans, plain objects with safe values pass.
  assert.equal(isSecretFreeDiscoveryValue({ requests: 1, candidates: 0, errors: 0 }), true);
  assert.equal(isSecretFreeDiscoveryValue({ a: 1, b: ['torrentio-torbox'] }), true);
  // Functions or undefined values are rejected.
  assert.equal(isSecretFreeDiscoveryValue(() => {}), false);
  // Arrays of safe values pass.
  assert.equal(isSecretFreeDiscoveryValue(['torrentio-torbox', 1, 0]), true);
  assert.equal(isSecretFreeDiscoveryValue(['safe', 'with space']), false);
});

test('discovery-accounting: end-to-end shape mirrors the /api/debug/discovery-accounting contract', () => {
  freshSnapshot();
  discoveryAccounting.recordRequest('torrentio-torbox');
  discoveryAccounting.recordRequest('torrentio-torbox');
  discoveryAccounting.recordCandidates('torrentio-torbox', 7);
  discoveryAccounting.recordError('comet-torbox');
  const snap = discoveryAccounting.snapshot();
  // Verify the contract shape.
  assert.ok(snap.timestamp > 0);
  assert.ok(snap.sources);
  for (const [name, counter] of Object.entries(snap.sources)) {
    assert.ok(typeof counter.requests === 'number');
    assert.ok(typeof counter.candidates === 'number');
    assert.ok(typeof counter.errors === 'number');
    // The endpoint is secret-free: every value in the snapshot
    // must pass the secret-free guard.
    assert.ok(isSecretFreeDiscoveryValue(name), `source name ${name} is secret-free`);
    assert.ok(isSecretFreeDiscoveryValue(counter), `counter for ${name} is secret-free`);
  }
  // The full snapshot must be secret-free.
  assert.ok(isSecretFreeDiscoveryValue(snap), 'snapshot is secret-free');
});
