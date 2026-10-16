/**
 * Runtime byte-serviceability registry tests (hardening tranche).
 *
 * Pins the semantic gap the Lowdown failure exposed: consumer-visible must not
 * be reported as serviceable, and a known-bad route must be suppressed without
 * touching durable placement truth.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadableStream } from 'node:stream/web';

import {
  __resetByteHealth,
  getServiceability,
  isSuppressed,
  recordServiceable,
  recordUnserviceable,
} from '../src/lib/vfs/byte-health.js';
import { streamFromDataPlane, DataPlaneError } from '../src/lib/vfs/data-plane-forward.js';

test('unobserved TorrentFile is unknown, never claimed serviceable', () => {
  __resetByteHealth();
  const s = getServiceability('tf_never');
  assert.equal(s.state, 'unknown');
  assert.equal(isSuppressed('tf_never'), false, 'unknown must not be suppressed');
});

test('a failed read suppresses the route; success clears it (half-open recovery)', () => {
  __resetByteHealth();
  recordUnserviceable('tf_a', { reason: 'provider-body-truncated', provider: 'torbox' });
  const bad = getServiceability('tf_a');
  assert.equal(bad.state, 'unserviceable');
  assert.equal(bad.provider, 'torbox');
  assert.equal(isSuppressed('tf_a'), true, 'inside backoff window');
  // Backoff expires -> half-open (not suppressed) so a later read can probe.
  const later = Date.now() + 10 * 60_000;
  assert.equal(isSuppressed('tf_a', later), false);
  // Success clears the failure entirely.
  recordServiceable('tf_a', { provider: 'torbox' });
  assert.equal(getServiceability('tf_a').state, 'serviceable');
  assert.equal(isSuppressed('tf_a'), false);
});

test('consecutive failures escalate the backoff but stay bounded', () => {
  __resetByteHealth();
  const first = (recordUnserviceable('tf_b', { reason: 'r' }), getServiceability('tf_b').retryInMs);
  recordUnserviceable('tf_b', { reason: 'r' });
  const second = getServiceability('tf_b').retryInMs;
  for (let i = 0; i < 20; i += 1) recordUnserviceable('tf_b', { reason: 'r' });
  const capped = getServiceability('tf_b').retryInMs;
  assert.ok(second > first, 'backoff escalates');
  assert.ok(capped <= 5 * 60_000, 'backoff is bounded');
});

// ---------------------------------------------------------------------------
// Forward integration: the forwarder is the single choke point for tfId reads.
// ---------------------------------------------------------------------------

function fakeRequest(headers = {}) {
  return { method: 'GET', headers, once() {}, removeListener() {} };
}
function fakeResponse() {
  return {
    headersSent: false,
    writeHead() { this.headersSent = true; },
    end() {},
    destroy() {},
    once() {},
    removeListener() {},
    on() {},
    emit() {},
    write() {},
  };
}
function webBody(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}
function attributionHeaders() {
  return {
    get: (n) => (n === 'x-hashsucker-serving-provider' ? 'torbox'
      : n === 'x-hashsucker-serving-resource-id' ? 'res-1'
        : null),
  };
}
function bodyResponse(chunks) {
  return {
    status: 206,
    headers: attributionHeaders(),
    body: webBody(chunks),
  };
}

test('forwarder short-circuits a suppressed route without calling the data plane', async () => {
  __resetByteHealth();
  recordUnserviceable('tf_supp', { reason: 'provider-body-truncated', provider: 'torbox' });
  let calls = 0;
  const fetchFn = async () => { calls += 1; return bodyResponse([Buffer.from('x')]); };
  await assert.rejects(
    () => streamFromDataPlane({ fetchFn, baseUrl: 'http://dp', tfId: 'tf_supp', request: fakeRequest(), response: fakeResponse() }),
    (e) => e instanceof DataPlaneError && e.code === 'PROVIDER_ROUTE_SUPPRESSED',
  );
  assert.equal(calls, 0, 'no data-plane call while suppressed');
});

test('forwarder records serviceable on a completed body and unserviceable on truncation', async () => {
  __resetByteHealth();
  await streamFromDataPlane({ fetchFn: async () => bodyResponse([new Uint8Array([104, 105])]), baseUrl: 'http://dp', tfId: 'tf_ok', request: fakeRequest(), response: fakeResponse() });
  assert.equal(getServiceability('tf_ok').state, 'serviceable');

  // A web body stream that errors mid-flight is a provider truncation.
  const brokenBody = new ReadableStream({ start(controller) { controller.error(new Error('terminated')); } });
  const broken = {
    status: 206,
    headers: attributionHeaders(),
    body: brokenBody,
  };
  // Headers were already committed, so the forwarder tears the response down
  // rather than throwing — but the route failure is still recorded.
  await streamFromDataPlane({ fetchFn: async () => broken, baseUrl: 'http://dp', tfId: 'tf_trunc', request: fakeRequest(), response: fakeResponse() });
  const s = getServiceability('tf_trunc');
  assert.equal(s.state, 'unserviceable');
  assert.equal(s.reason, 'provider-body-truncated');
  assert.equal(s.provider, 'torbox');
});
