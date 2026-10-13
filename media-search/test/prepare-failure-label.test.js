import test from 'node:test';
import assert from 'node:assert/strict';
import { describePrepareFailure } from '../src/lib/requests/prepare-failure.js';

test('an explicit server error is reported verbatim', () => {
  const r = { status: 400, json: { error: 'Invalid media type: episode' } };
  assert.deepEqual(describePrepareFailure(r), { error: 'Invalid media type: episode', reason: 'server-error' });
});

test('a 200 with no handoff names the selection reason instead of prepare-http-200', () => {
  const r = { status: 200, json: { prepared: false, selection: { reason: 'no-bindable-candidate' } } };
  assert.deepEqual(describePrepareFailure(r), {
    error: 'prepare:no-handoff:no-bindable-candidate',
    reason: 'no-handoff',
  });
});

test('a 200 with a handoff but no durable TorrentFile is a distinct class', () => {
  const r = { status: 200, json: {
    prepared: true, handoff: { torrentFileId: null },
    selection: { reason: 'cached-first fallback (no bindable candidate)' } } };
  assert.deepEqual(describePrepareFailure(r), {
    error: 'prepare:no-torrentfile:cached-first fallback (no bindable candidate)',
    reason: 'no-torrentfile',
  });
});

test('a non-200 transport result still gets the transport label', () => {
  assert.deepEqual(describePrepareFailure({ status: 500, json: {} }),
    { error: 'prepare-http-500', reason: 'http-status' });
  assert.deepEqual(describePrepareFailure({ status: 400, json: {} }),
    { error: 'prepare-http-400', reason: 'http-status' });
});

test('an unrecognised 200 shape still degrades to prepare-http-200', () => {
  // Guards against a future body shape silently looking like success.
  const r = { status: 200, json: { prepared: true, handoff: { torrentFileId: 'tf_1' } } };
  assert.equal(describePrepareFailure(r).reason, 'unknown');
  assert.equal(describePrepareFailure(r).error, 'prepare-http-200');
});

test('no selection reason is tolerated', () => {
  const r = { status: 200, json: { prepared: false, selection: null } };
  assert.equal(describePrepareFailure(r).error, 'prepare:no-handoff');
  const r2 = { status: 200, json: {} };
  assert.equal(describePrepareFailure(r2).reason, 'no-handoff');
});

test('a missing body never crashes and is not mistaken for success', () => {
  for (const bad of [undefined, null, {}, { json: null }]) {
    const out = describePrepareFailure(bad);
    assert.ok(typeof out.error === 'string' && out.error.length > 0);
  }
});
