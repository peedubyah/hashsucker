/**
 * Failed Request Formatter Tests
 *
 * Tests formatFailedRequest — renders failed request trace as terminal text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatFailedRequest } from '../src/lib/requests/timing-formatter.js';

const FAILED_DEBUG = {
  found: true,
  requestId: 'abc-123-def',
  status: 'failed',
  request: {
    requestId: 'abc-123-def',
    timing: {
      failure: {
        stage: 'candidate.selection',
        errorCode: 'NO_CACHED_CANDIDATES',
        error: 'No cached candidates found after ranking',
        component: 'ranking-engine',
        elapsedMs: 1523,
      },
      stages: {
        'request.received': { startedAt: '2026-08-24T03:00:00.000Z', completedAt: '2026-08-24T03:00:00.000Z', durationMs: 0, status: 'completed' },
        'identity.resolved': { startedAt: '2026-08-24T03:00:00.001Z', completedAt: '2026-08-24T03:00:00.081Z', durationMs: 80, status: 'completed' },
        'corpus.lookup': { startedAt: '2026-08-24T03:00:00.081Z', completedAt: '2026-08-24T03:00:00.101Z', durationMs: 20, status: 'completed' },
        'live.discovery': { startedAt: '2026-08-24T03:00:00.101Z', completedAt: '2026-08-24T03:00:02.501Z', durationMs: 2400, status: 'completed' },
        'candidate.ranking': { startedAt: '2026-08-24T03:00:02.501Z', completedAt: '2026-08-24T03:00:02.551Z', durationMs: 50, status: 'failed' },
      },
    },
  },
  finalState: {
    status: 'failed',
    lastError: 'No cached candidates found',
  },
};

test('formatFailedRequest renders header', () => {
  const text = formatFailedRequest(FAILED_DEBUG);
  assert.match(text, /REQUEST FAILED/);
});

test('formatFailedRequest renders requestId', () => {
  const text = formatFailedRequest(FAILED_DEBUG);
  assert.match(text, /RequestId:/);
  assert.match(text, /abc-123-def/);
});

test('formatFailedRequest renders failure details', () => {
  const text = formatFailedRequest(FAILED_DEBUG);
  assert.match(text, /Failure:/);
  assert.match(text, /Stage=candidate.selection/);
  assert.match(text, /Reason=NO_CACHED_CANDIDATES/);
  assert.match(text, /Error=No cached candidates found after ranking/);
  assert.match(text, /Component=ranking-engine/);
  assert.match(text, /Elapsed=1523ms/);
});

test('formatFailedRequest renders timeline with success/failure markers', () => {
  const text = formatFailedRequest(FAILED_DEBUG);
  assert.match(text, /Timeline:/);
  // Successful stages should have ✓
  assert.match(text, /✓ Request\.Received 0ms/);
  assert.match(text, /✓ Identity\.Resolved 80ms/);
  assert.match(text, /✓ Corpus\.Lookup 20ms/);
  assert.match(text, /✓ Live\.Discovery 2400ms/);
  // Failed stage should have ✗
  assert.match(text, /✗ Candidate\.Ranking 50ms/);
});

test('formatFailedRequest renders last error', () => {
  const text = formatFailedRequest(FAILED_DEBUG);
  assert.match(text, /Last Error:/);
  assert.match(text, /No cached candidates found/);
});

test('formatFailedRequest handles not found', () => {
  const text = formatFailedRequest({ found: false, requestId: 'missing' });
  assert.match(text, /REQUEST NOT FOUND/);
});

test('formatFailedRequest handles null debug', () => {
  const text = formatFailedRequest(null);
  assert.match(text, /REQUEST NOT FOUND/);
});

test('formatFailedRequest handles missing failure details', () => {
  const debug = {
    found: true,
    requestId: 'abc-123',
    timing: {
      stages: {
        'request.received': { startedAt: '2026-08-24T03:00:00.000Z', completedAt: '2026-08-24T03:00:00.000Z', durationMs: 0, status: 'completed' },
      },
    },
  };
  const text = formatFailedRequest(debug);
  assert.match(text, /REQUEST FAILED/);
  assert.match(text, /RequestId:/);
  // Should still render timeline even without failure details
  assert.match(text, /Timeline:/);
});

test('formatFailedRequest handles failure without errorCode', () => {
  const debug = {
    found: true,
    requestId: 'abc-123',
    timing: {
      failure: {
        stage: 'some.stage',
        error: 'Something broke',
      },
      stages: {},
    },
  };
  const text = formatFailedRequest(debug);
  assert.match(text, /Stage=some.stage/);
  assert.match(text, /Error=Something broke/);
  assert.doesNotMatch(text, /Reason=/);
});

test('formatFailedRequest sorts timeline chronologically', () => {
  const debug = {
    found: true,
    requestId: 'abc-123',
    timing: {
      failure: { stage: 'stage3', error: 'fail' },
      stages: {
        'stage2': { startedAt: '2026-08-24T03:00:00.050Z', completedAt: '2026-08-24T03:00:00.100Z', durationMs: 50, status: 'completed' },
        'stage1': { startedAt: '2026-08-24T03:00:00.000Z', completedAt: '2026-08-24T03:00:00.050Z', durationMs: 50, status: 'completed' },
        'stage3': { startedAt: '2026-08-24T03:00:00.100Z', completedAt: '2026-08-24T03:00:00.150Z', durationMs: 50, status: 'failed' },
      },
    },
  };
  const text = formatFailedRequest(debug);
  const stage1Pos = text.indexOf('Stage1');
  const stage2Pos = text.indexOf('Stage2');
  const stage3Pos = text.indexOf('Stage3');
  assert.ok(stage1Pos < stage2Pos);
  assert.ok(stage2Pos < stage3Pos);
});
