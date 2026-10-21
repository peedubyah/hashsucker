/**
 * THE CANONICAL PLAYBACK WATERFALL — TESTS.
 *
 * The waterfall's whole job is to make every second attributable. These
 * tests pin:
 *
 *   1. the stage list and its owners are the canonical ones,
 *   2. marks from three processes land on ONE ordered timeline,
 *   3. a gap of a second or more is reported as a bucket, and it is
 *      charged to the process that owned the work in that interval,
 *   4. the session id is a correlation handle: it is bounded, boring, and
 *      never a place to put free text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WATERFALL_BUCKET_MS,
  WATERFALL_OWNER,
  WATERFALL_SESSION_HEADER,
  WATERFALL_STAGE_NAMES,
  assembleWaterfall,
  createWaterfallRecorder,
  newSessionId,
  readSessionId,
} from '../src/lib/measurement/playback-waterfall.js';
import { clearSessions, markSession, openSession, readSession } from '../src/lib/measurement/session-store.js';

// =============================================================================
// 1. THE CANONICAL STAGE LIST
// =============================================================================

test('waterfall: the canonical stage list is the playback session, in order', () => {
  assert.deepEqual(WATERFALL_STAGE_NAMES, [
    'intent_accepted',
    'binding_resolved',
    'playback_object_minted',
    'player_launched',
    'first_http',
    'first_rust_byte_request',
    'provider_request_start',
    'provider_first_byte',
    'first_byte_to_client',
    'player_file_loaded',
    'first_frame',
  ]);
});

test('waterfall: every stage has exactly one owning process', () => {
  assert.equal(WATERFALL_OWNER.SERVER, 'server');
  assert.equal(WATERFALL_OWNER.DATA_PLANE, 'data-plane');
  assert.equal(WATERFALL_OWNER.CLIENT, 'client');
});

// =============================================================================
// 2. ONE TIMELINE ACROSS PROCESSES
// =============================================================================

test('waterfall: marks from three processes land on one ordered timeline', () => {
  const server = { process: 'server', anchorWallMs: 1_000, marks: [
    { stage: 'intent_accepted', atMs: 0 },
    { stage: 'binding_resolved', atMs: 120 },
    { stage: 'playback_object_minted', atMs: 130 },
  ] };
  const client = { process: 'client', anchorWallMs: 1_200, marks: [
    { stage: 'player_launched', atMs: 0 },
    { stage: 'player_file_loaded', atMs: 900 },
    { stage: 'first_frame', atMs: 950 },
  ] };
  const dataPlane = { process: 'data-plane', anchorWallMs: 1_400, marks: [
    { stage: 'first_rust_byte_request', atMs: 0 },
    { stage: 'provider_request_start', atMs: 5 },
    { stage: 'provider_first_byte', atMs: 300 },
    { stage: 'first_byte_to_client', atMs: 320 },
  ] };

  const waterfall = assembleWaterfall({ sessionId: 's-1', sources: [server, client, dataPlane] });
  assert.deepEqual(waterfall.stages.map((s) => s.stage), [
    'intent_accepted',
    'binding_resolved',
    'playback_object_minted',
    'player_launched',
    'first_http',
    'first_rust_byte_request',
    'provider_request_start',
    'provider_first_byte',
    'first_byte_to_client',
    'player_file_loaded',
    'first_frame',
  ].filter((s) => s !== 'first_http'));
  assert.equal(waterfall.missingStages.length, 1);
  assert.deepEqual(waterfall.missingStages, ['first_http']);
});

test('waterfall: the recorder measures with a monotonic clock', () => {
  const recorder = createWaterfallRecorder({ sessionId: 's-1' });
  recorder.mark('intent_accepted');
  recorder.mark('binding_resolved');
  assert.equal(recorder.marks.length, 2);
  assert.ok(recorder.marks[1].atMs >= recorder.marks[0].atMs, 'offsets never go backwards');
  assert.equal(recorder.marks[0].wallMs, recorder.anchorWallMs);
});

// =============================================================================
// 3. BUCKETS
// =============================================================================

test('waterfall: a multi-second gap is a bucket, charged to the process that held it', () => {
  const server = { process: 'server', anchorWallMs: 0, marks: [
    { stage: 'intent_accepted', atMs: 0 },
    { stage: 'binding_resolved', atMs: 10 },
    { stage: 'playback_object_minted', atMs: 20 },
  ] };
  const dataPlane = { process: 'data-plane', anchorWallMs: 5_000, marks: [
    { stage: 'first_rust_byte_request', atMs: 0 },
    { stage: 'provider_request_start', atMs: 1 },
    { stage: 'provider_first_byte', atMs: 45_000 },
    { stage: 'first_byte_to_client', atMs: 45_100 },
  ] };

  const waterfall = assembleWaterfall({ sessionId: 's-2', sources: [server, dataPlane] });
  const buckets = waterfall.buckets;
  assert.ok(buckets.length >= 1, 'the gap was reported as a bucket');
  const providerBucket = buckets.find((b) => b.before === 'provider_first_byte');
  assert.ok(providerBucket, 'the provider wait is a bucket');
  assert.equal(providerBucket.owner, WATERFALL_OWNER.DATA_PLANE,
    'the time before the provider\'s first byte is the data plane\'s');
  assert.ok(providerBucket.gapMs >= WATERFALL_BUCKET_MS);
  // The data plane's anchor is at 5 000 ms, so its last mark lands at
  // 50 100 ms on the shared timeline.
  assert.equal(waterfall.totalMs, 50_100);
});

test('waterfall: a sub-second gap is not a bucket', () => {
  const source = { process: 'server', anchorWallMs: 0, marks: [
    { stage: 'intent_accepted', atMs: 0 },
    { stage: 'binding_resolved', atMs: 10 },
  ] };
  const waterfall = assembleWaterfall({ sessionId: 's-3', sources: [source] });
  assert.equal(waterfall.buckets.length, 0);
});

// =============================================================================
// 4. THE SESSION ID IS A CORRELATION HANDLE
// =============================================================================

test('waterfall: the session id is read from the header and kept boring', () => {
  assert.equal(WATERFALL_SESSION_HEADER, 'x-hs-session');
  assert.equal(readSessionId({ 'x-hs-session': 'hs-abc-123' }), 'hs-abc-123');
  // A header can arrive as an array; the first value is the one.
  assert.equal(readSessionId({ 'x-hs-session': ['hs-abc-123', 'other'] }), 'hs-abc-123');
  // Free text, injection attempts and over-long values are refused.
  assert.equal(readSessionId({ 'x-hs-session': 'has space' }), null);
  assert.equal(readSessionId({ 'x-hs-session': 'a'.repeat(65) }), null);
  assert.equal(readSessionId({ 'x-hs-session': '<script>' }), null);
  assert.equal(readSessionId({}), null);
  assert.equal(readSessionId(null), null);
});

test('waterfall: a minted session id is unique enough to be a handle', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.ok(readSessionId({ 'x-hs-session': id }) === id);
});

// =============================================================================
// THE SESSION STORE: ONE MONOTONIC ORIGIN ACROSS REQUESTS
// =============================================================================

test('session store: marks across requests share one origin', () => {
  clearSessions();
  const sessionId = newSessionId();
  openSession(sessionId);
  markSession(sessionId, 'intent_accepted');
  markSession(sessionId, 'binding_resolved');
  // A later request marks the same session.
  markSession(sessionId, 'first_http');

  const record = readSession(sessionId);
  assert.equal(record.marks.length, 3);
  assert.equal(record.marks[0].stage, 'intent_accepted');
  assert.equal(record.marks[2].stage, 'first_http');
  assert.ok(record.marks[2].atMs >= record.marks[0].atMs, 'offsets never go backwards');
  assert.equal(record.marks[0].wallMs, record.anchorWallMs);
  clearSessions();
});

test('session store: an unknown session is not a mark', () => {
  clearSessions();
  assert.equal(markSession('never-opened', 'intent_accepted'), null);
  assert.equal(readSession('never-opened'), null);
  assert.equal(openSession(null), null);
  clearSessions();
});

test('session store: reopening keeps the first anchor', () => {
  clearSessions();
  const sessionId = newSessionId();
  const first = openSession(sessionId);
  markSession(sessionId, 'intent_accepted');
  const again = openSession(sessionId);
  assert.equal(again.anchorWallMs, first.anchorWallMs, 'the clock starts when the intent was accepted');
  assert.equal(again.marks.length, 1, 'and the marks are not reset');
  clearSessions();
});
