/**
 * Request Timing Formatter Tests
 *
 * Tests formatRequestTiming, formatSearchTiming, formatTimingComparison.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatRequestTiming, formatSearchTiming, formatTimingComparison } from '../src/lib/requests/timing-formatter.js';

const SAMPLE_TIMING = {
  requestId: 'test-123',
  totalDurationMs: 2557,
  stages: {
    'request.received': { startedAt: '2026-08-24T03:00:00.000Z', completedAt: '2026-08-24T03:00:00.000Z', durationMs: 0, status: 'completed' },
    'identity.resolved': { startedAt: '2026-08-24T03:00:00.001Z', completedAt: '2026-08-24T03:00:00.083Z', durationMs: 82, status: 'completed' },
    'metadata.resolved': { startedAt: '2026-08-24T03:00:00.083Z', completedAt: '2026-08-24T03:00:00.393Z', durationMs: 310, status: 'completed' },
    'corpus.lookup': { startedAt: '2026-08-24T03:00:00.393Z', completedAt: '2026-08-24T03:00:00.418Z', durationMs: 25, status: 'completed' },
    'live.discovery': { startedAt: '2026-08-24T03:00:00.418Z', completedAt: '2026-08-24T03:00:01.658Z', durationMs: 1240, status: 'completed' },
    'candidate.ranking': { startedAt: '2026-08-24T03:00:01.658Z', completedAt: '2026-08-24T03:00:01.698Z', durationMs: 40, status: 'completed' },
    'candidate.selected': { startedAt: '2026-08-24T03:00:01.698Z', completedAt: '2026-08-24T03:00:01.703Z', durationMs: 5, status: 'completed' },
    'cache.checked': { startedAt: '2026-08-24T03:00:01.703Z', completedAt: '2026-08-24T03:00:02.323Z', durationMs: 620, status: 'completed' },
    'handoff.created': { startedAt: '2026-08-24T03:00:02.323Z', completedAt: '2026-08-24T03:00:02.543Z', durationMs: 220, status: 'completed' },
    'strm.created': { startedAt: '2026-08-24T03:00:02.543Z', completedAt: '2026-08-24T03:00:02.558Z', durationMs: 15, status: 'completed' },
  },
  completed: true,
};

test('formatRequestTiming renders header', () => {
  const text = formatRequestTiming(SAMPLE_TIMING);
  assert.match(text, /REQUEST TIMELINE/);
});

test('formatRequestTiming renders all stages', () => {
  const text = formatRequestTiming(SAMPLE_TIMING);
  assert.match(text, /Request\.Received 0ms/);
  assert.match(text, /Identity\.Resolved 82ms/);
  assert.match(text, /Metadata\.Resolved 310ms/);
  assert.match(text, /Corpus\.Lookup 25ms/);
  assert.match(text, /Live\.Discovery 1240ms/);
  assert.match(text, /Candidate\.Ranking 40ms/);
  assert.match(text, /Candidate\.Selected 5ms/);
  assert.match(text, /Cache\.Checked 620ms/);
  assert.match(text, /Handoff\.Created 220ms/);
  assert.match(text, /Strm\.Created 15ms/);
});

test('formatRequestTiming renders total', () => {
  const text = formatRequestTiming(SAMPLE_TIMING);
  assert.match(text, /TOTAL: 2557ms/);
});

test('formatRequestTiming handles failed stages', () => {
  const timing = {
    totalDurationMs: 100,
    stages: {
      'stage1': { startedAt: '2026-08-24T03:00:00.000Z', completedAt: '2026-08-24T03:00:00.050Z', durationMs: 50, status: 'failed' },
    },
  };
  const text = formatRequestTiming(timing);
  assert.match(text, /Stage1 50ms ✗/);
});

test('formatRequestTiming handles null timing', () => {
  const text = formatRequestTiming(null);
  assert.match(text, /REQUEST TIMELINE/);
  assert.match(text, /No timing data available/);
});

test('formatRequestTiming handles empty stages', () => {
  const text = formatRequestTiming({ stages: {} });
  assert.match(text, /REQUEST TIMELINE/);
  assert.match(text, /TOTAL: 0ms/);
});

test('formatSearchTiming renders header', () => {
  const text = formatSearchTiming(SAMPLE_TIMING);
  assert.match(text, /SEARCH TIMING/);
});

test('formatSearchTiming renders stages', () => {
  const text = formatSearchTiming(SAMPLE_TIMING);
  assert.match(text, /Request\.Received 0ms/);
  assert.match(text, /TOTAL: 2557ms/);
});

test('formatSearchTiming handles null timing', () => {
  const text = formatSearchTiming(null);
  assert.match(text, /SEARCH TIMING/);
  assert.match(text, /No timing data available/);
});

test('formatTimingComparison renders header', () => {
  const text = formatTimingComparison([SAMPLE_TIMING, SAMPLE_TIMING]);
  assert.match(text, /TIMING COMPARISON/);
});

test('formatTimingComparison renders stage stats', () => {
  const text = formatTimingComparison([SAMPLE_TIMING, SAMPLE_TIMING]);
  assert.match(text, /Request\.Received/);
  assert.match(text, /Latest/);
  assert.match(text, /Average/);
  assert.match(text, /Min/);
  assert.match(text, /Max/);
});

test('formatTimingComparison handles empty array', () => {
  const text = formatTimingComparison([]);
  assert.match(text, /TIMING COMPARISON/);
  assert.match(text, /No timing data available/);
});

test('formatTimingComparison handles null', () => {
  const text = formatTimingComparison(null);
  assert.match(text, /TIMING COMPARISON/);
  assert.match(text, /No timing data available/);
});

test('formatRequestTiming sorts stages chronologically', () => {
  const timing = {
    totalDurationMs: 100,
    stages: {
      'stage2': { startedAt: '2026-08-24T03:00:00.050Z', completedAt: '2026-08-24T03:00:00.100Z', durationMs: 50, status: 'completed' },
      'stage1': { startedAt: '2026-08-24T03:00:00.000Z', completedAt: '2026-08-24T03:00:00.050Z', durationMs: 50, status: 'completed' },
    },
  };
  const text = formatRequestTiming(timing);
  const stage1Pos = text.indexOf('Stage1');
  const stage2Pos = text.indexOf('Stage2');
  assert.ok(stage1Pos < stage2Pos, 'stage1 should appear before stage2');
});

test('formatRequestTiming rounds durations', () => {
  const timing = {
    totalDurationMs: 100.7,
    stages: {
      'stage1': { startedAt: '2026-08-24T03:00:00.000Z', completedAt: '2026-08-24T03:00:00.100Z', durationMs: 100.7, status: 'completed' },
    },
  };
  const text = formatRequestTiming(timing);
  assert.match(text, /Stage1 101ms/);
  assert.match(text, /TOTAL: 101ms/);
});
