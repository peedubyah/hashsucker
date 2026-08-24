/**
 * Event Store Tests
 *
 * Tests createLifecycleEventStore, recordRequestRun, recordEvent, getRequestTimeline.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLifecycleEventStore } from '../src/lib/operator/event-store.js';
import { formatRequestTimeline, formatRecentRuns, formatFailedRuns } from '../src/lib/operator/event-formatter.js';

test('createLifecycleEventStore creates in-memory store', () => {
  const store = createLifecycleEventStore();
  assert.equal(store.countRequestRuns(), 0);
  assert.equal(store.countLifecycleEvents(), 0);
  store.close();
});

test('recordRequestRun stores a request run', () => {
  const store = createLifecycleEventStore();
  store.recordRequestRun({
    requestId: 'test-123',
    mediaId: 'tt-test',
    releaseKey: 'hash123:torrent',
    provider: 'torbox',
    finalStatus: 'queued',
  });
  assert.equal(store.countRequestRuns(), 1);
  
  const run = store.getRequestRun('test-123');
  assert.equal(run.requestId, 'test-123');
  assert.equal(run.mediaId, 'tt-test');
  assert.equal(run.finalStatus, 'queued');
  store.close();
});

test('recordEvent stores a lifecycle event', () => {
  const store = createLifecycleEventStore();
  store.recordRequestRun({ requestId: 'test-123', finalStatus: 'queued' });
  store.recordEvent({
    requestId: 'test-123',
    stage: 'request.received',
    status: 'completed',
    durationMs: 5,
  });
  assert.equal(store.countLifecycleEvents(), 1);
  
  const events = store.getRequestEvents('test-123');
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'request.received');
  assert.equal(events[0].status, 'completed');
  store.close();
});

test('getRequestTimeline returns run and events', () => {
  const store = createLifecycleEventStore();
  store.recordRequestRun({
    requestId: 'test-456',
    mediaId: 'tt-show',
    finalStatus: 'completed',
    totalDurationMs: 1500,
  });
  store.recordEvent({ requestId: 'test-456', stage: 'request.received', status: 'completed', durationMs: 0 });
  store.recordEvent({ requestId: 'test-456', stage: 'identity.resolved', status: 'completed', durationMs: 80 });
  store.recordEvent({ requestId: 'test-456', stage: 'handoff.created', status: 'completed', durationMs: 200 });
  
  const timeline = store.getRequestTimeline('test-456');
  assert.ok(timeline);
  assert.equal(timeline.run.requestId, 'test-456');
  assert.equal(timeline.run.totalDurationMs, 1500);
  assert.equal(timeline.events.length, 3);
  store.close();
});

test('getRequestTimeline returns null for unknown request', () => {
  const store = createLifecycleEventStore();
  const timeline = store.getRequestTimeline('nonexistent');
  assert.equal(timeline, null);
  store.close();
});

test('getRecentRuns returns runs in reverse chronological order', () => {
  const store = createLifecycleEventStore();
  store.recordRequestRun({ requestId: 'first', createdAt: 1000 });
  store.recordRequestRun({ requestId: 'second', createdAt: 2000 });
  store.recordRequestRun({ requestId: 'third', createdAt: 3000 });
  
  const recent = store.getRecentRuns(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].requestId, 'third');
  assert.equal(recent[1].requestId, 'second');
  store.close();
});

test('getFailedRuns returns only failed requests', () => {
  const store = createLifecycleEventStore();
  store.recordRequestRun({ requestId: 'success-1', finalStatus: 'completed' });
  store.recordRequestRun({ requestId: 'failed-1', finalStatus: 'failed', failureReason: 'timeout' });
  store.recordRequestRun({ requestId: 'failed-2', finalStatus: 'failed', failureReason: 'no candidates' });
  
  const failed = store.getFailedRuns(10);
  assert.equal(failed.length, 2);
  assert.ok(failed.every(r => r.finalStatus === 'failed'));
  store.close();
});

test('getEventsByStage filters by stage', () => {
  const store = createLifecycleEventStore();
  store.recordRequestRun({ requestId: 'test', finalStatus: 'completed' });
  store.recordEvent({ requestId: 'test', stage: 'request.received', status: 'completed' });
  store.recordEvent({ requestId: 'test', stage: 'identity.resolved', status: 'completed' });
  store.recordEvent({ requestId: 'test', stage: 'request.received', status: 'completed' });
  
  const received = store.getEventsByStage('request.received');
  assert.equal(received.length, 2);
  store.close();
});

test('countRunsByStatus returns status counts', () => {
  const store = createLifecycleEventStore();
  store.recordRequestRun({ requestId: 'r1', finalStatus: 'completed' });
  store.recordRequestRun({ requestId: 'r2', finalStatus: 'completed' });
  store.recordRequestRun({ requestId: 'r3', finalStatus: 'failed' });
  store.recordRequestRun({ requestId: 'r4', finalStatus: 'queued' });
  
  const counts = store.countRunsByStatus();
  assert.equal(counts.completed, 2);
  assert.equal(counts.failed, 1);
  assert.equal(counts.queued, 1);
  store.close();
});

test('completeRequestRun updates existing run', () => {
  const store = createLifecycleEventStore();
  store.recordRequestRun({ requestId: 'test', finalStatus: 'queued' });
  store.completeRequestRun('test', {
    finalStatus: 'completed',
    totalDurationMs: 1500,
  });
  
  const run = store.getRequestRun('test');
  assert.equal(run.finalStatus, 'completed');
  assert.equal(run.totalDurationMs, 1500);
  store.close();
});

test('recordEvents batch inserts events', () => {
  const store = createLifecycleEventStore();
  store.recordRequestRun({ requestId: 'test', finalStatus: 'completed' });
  store.recordEvents([
    { requestId: 'test', stage: 's1', status: 'completed' },
    { requestId: 'test', stage: 's2', status: 'completed' },
    { requestId: 'test', stage: 's3', status: 'failed', errorCode: 'ERR' },
  ]);
  
  assert.equal(store.countLifecycleEvents(), 3);
  store.close();
});

test('formatRequestTimeline renders full timeline', () => {
  const timeline = {
    run: {
      requestId: 'abc-123',
      finalStatus: 'completed',
      mediaId: 'tt-test',
      releaseKey: 'hash:torrent',
      provider: 'torbox',
      totalDurationMs: 1500,
      createdAtIso: '2026-08-24T03:00:00.000Z',
      completedAtIso: '2026-08-24T03:00:01.500Z',
    },
    events: [
      { stage: 'request.received', status: 'completed', durationMs: 0, timestampIso: '2026-08-24T03:00:00.000Z', component: 'api' },
      { stage: 'identity.resolved', status: 'completed', durationMs: 80, timestampIso: '2026-08-24T03:00:00.080Z', component: 'resolver' },
      { stage: 'handoff.created', status: 'completed', durationMs: 200, timestampIso: '2026-08-24T03:00:00.280Z', component: 'handoff' },
    ],
  };
  
  const text = formatRequestTimeline(timeline);
  assert.match(text, /REQUEST TRACE/);
  assert.match(text, /RequestId: abc-123/);
  assert.match(text, /Status: completed/);
  assert.match(text, /Duration: 1\.5s/);
  assert.match(text, /Timeline:/);
  // Table format with time, stage, component, duration, status columns
  assert.match(text, /Time\s+Stage\s+Component\s+Duration Status/);
  assert.match(text, /Request\.Received/);
  assert.match(text, /Identity\.Resolved/);
  assert.match(text, /Handoff\.Created/);
  assert.match(text, /api/);
  assert.match(text, /resolver/);
  assert.match(text, /handoff/);
});

test('formatRequestTimeline renders failure', () => {
  const timeline = {
    run: {
      requestId: 'abc-123',
      finalStatus: 'failed',
      failureReason: 'No cached candidates',
      failureStage: 'candidate.selection',
      totalDurationMs: 500,
    },
    events: [
      { stage: 'request.received', status: 'completed', durationMs: 0 },
      { stage: 'candidate.selection', status: 'failed', durationMs: 500, errorCode: 'NO_CACHED' },
    ],
  };
  
  const text = formatRequestTimeline(timeline);
  assert.match(text, /REQUEST TRACE/);
  assert.match(text, /Status: failed/);
  assert.match(text, /Failure:/);
  assert.match(text, /Reason: No cached candidates/);
  assert.match(text, /Stage: candidate.selection/);
  // Table format - check for components separately
  assert.match(text, /Candidate\.Selection/);
  assert.match(text, /500ms/);
  assert.match(text, /NO_CACHED/);
});

test('formatRequestTimeline handles not found', () => {
  const text = formatRequestTimeline(null);
  assert.match(text, /REQUEST NOT FOUND/);
});

test('formatRecentRuns renders list', () => {
  const runs = [
    { requestId: 'aaa-bbb-ccc-ddd-eee-fff', finalStatus: 'completed', totalDurationMs: 1500, mediaId: 'tt-show', createdAtIso: '2026-08-24T03:00:00.000Z' },
    { requestId: 'ddd-eee-fff-ggg-hhh-iii-jjj', finalStatus: 'failed', failureReason: 'timeout', createdAtIso: '2026-08-24T03:01:00.000Z' },
  ];
  
  const text = formatRecentRuns(runs);
  assert.match(text, /RECENT REQUESTS/);
  assert.match(text, /aaa-bbb-ccc-\.\.\./);
  assert.match(text, /completed/);
  assert.match(text, /tt-show/);
  assert.match(text, /✓/);
});

test('formatRecentRuns handles empty', () => {
  const text = formatRecentRuns([]);
  assert.match(text, /No requests found/);
});

test('formatFailedRuns renders failures', () => {
  const runs = [
    { requestId: 'aaa-bbb-ccc-ddd-eee-fff', failureReason: 'timeout', failureStage: 'live.discovery', totalDurationMs: 5000 },
    { requestId: 'ccc-ddd-eee-fff-ggg-hhh', failureReason: 'no candidates', failureStage: 'candidate.selection', totalDurationMs: 200 },
  ];
  
  const text = formatFailedRuns(runs);
  assert.match(text, /FAILED REQUESTS/);
  assert.match(text, /aaa-bbb-ccc-\.\.\./);
  assert.match(text, /live\.discovery/);
  assert.match(text, /timeout/);
  assert.match(text, /5\.0s/);
});

test('formatFailedRuns handles empty', () => {
  const text = formatFailedRuns([]);
  assert.match(text, /No failed requests found/);
});
