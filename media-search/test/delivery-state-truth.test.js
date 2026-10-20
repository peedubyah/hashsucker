/**
 * Operator truth: representation authority, delivery state and publication
 * are three different facts and must be reported as three different facts.
 *
 * The reuse path (the ordinary "the user asked again" request) used to
 * report `published: true` with no delivery signal at all, while the
 * operator media-requests surface reported the runtime serviceability of the
 * same TorrentFile. Two surfaces, two truths, and one vocabulary for the
 * delivery fact ('blocked' in the request response vs 'unserviceable' in
 * the operator list).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getServiceability, recordServiceable, recordUnserviceable, __resetByteHealth } from '../src/lib/vfs/byte-health.js';

test('the runtime delivery state uses ONE vocabulary', () => {
  __resetByteHealth();
  const never = getServiceability('tf-unknown');
  assert.equal(never.state, 'unknown', 'an unobserved TorrentFile is unknown, never serviceable');
  assert.equal(never.reason, null);
  assert.equal(never.provider, null);
  assert.equal(never.source, null);

  recordServiceable('tf-ok', { provider: 'torbox' });
  const ok = getServiceability('tf-ok');
  assert.equal(ok.state, 'serviceable');
  assert.equal(ok.provider, 'torbox');
  assert.equal(ok.source, 'byte-path', 'the evidence names its own origin');

  recordUnserviceable('tf-bad', { reason: 'provider-body-truncated', provider: 'torbox' });
  const bad = getServiceability('tf-bad');
  assert.equal(bad.state, 'unserviceable', 'the same word the selection path now uses');
  assert.equal(bad.reason, 'provider-body-truncated');
  assert.equal(bad.provider, 'torbox');
  assert.ok(bad.retryInMs >= 0, 'a negative route reports when it will be retried');
  __resetByteHealth();
});
