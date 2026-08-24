/**
 * Request Timing Tests
 *
 * Tests RequestTiming class and timing instrumentation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestTiming, createRequestTiming } from '../src/lib/requests/timing.js';

test('RequestTiming creates with requestId', () => {
  const timing = new RequestTiming('test-123');
  assert.equal(timing.requestId, 'test-123');
});

test('start and end records stage duration', () => {
  const timing = new RequestTiming('test');
  timing.start('test.stage');
  timing.end('test.stage');

  const summary = timing.summary();
  assert.ok(summary.stages['test.stage']);
  assert.equal(summary.stages['test.stage'].status, 'completed');
  assert.ok(summary.stages['test.stage'].durationMs >= 0);
});

test('end without start creates synthetic record', () => {
  const timing = new RequestTiming('test');
  timing.end('unknown.stage');

  const summary = timing.summary();
  assert.ok(summary.stages['unknown.stage']);
  assert.equal(summary.stages['unknown.stage'].durationMs, 0);
});

test('fail marks stage as failed', () => {
  const timing = new RequestTiming('test');
  timing.start('failing.stage');
  timing.fail('failing.stage', 'something went wrong');

  const summary = timing.summary();
  assert.equal(summary.stages['failing.stage'].status, 'failed');
  assert.equal(summary.stages['failing.stage'].error, 'something went wrong');
});

test('complete sets completed flag', () => {
  const timing = new RequestTiming('test');
  timing.complete();

  const summary = timing.summary();
  assert.equal(summary.completed, true);
});

test('summary includes totalDurationMs', () => {
  const timing = new RequestTiming('test');
  timing.start('stage1');
  timing.end('stage1');
  timing.start('stage2');
  timing.end('stage2');
  timing.complete();

  const summary = timing.summary();
  assert.ok(typeof summary.totalDurationMs === 'number');
  assert.ok(summary.totalDurationMs >= 0);
});

test('summary includes all stages', () => {
  const timing = new RequestTiming('test');
  timing.start('stage1');
  timing.end('stage1');
  timing.start('stage2');
  timing.end('stage2');

  const summary = timing.summary();
  assert.equal(Object.keys(summary.stages).length, 2);
  assert.ok(summary.stages['stage1']);
  assert.ok(summary.stages['stage2']);
});

test('getStages returns array of stage records', () => {
  const timing = new RequestTiming('test');
  timing.start('stage1');
  timing.end('stage1');

  const stages = timing.getStages();
  assert.equal(stages.length, 1);
  assert.equal(stages[0].stage, 'stage1');
  assert.ok(stages[0].startedAt);
  assert.ok(stages[0].completedAt);
  assert.ok(stages[0].durationMs >= 0);
  assert.equal(stages[0].status, 'completed');
});

test('getStageDuration returns null for unknown stage', () => {
  const timing = new RequestTiming('test');
  assert.equal(timing.getStageDuration('unknown'), null);
});

test('getStageDuration returns duration for completed stage', () => {
  const timing = new RequestTiming('test');
  timing.start('test.stage');
  timing.end('test.stage');

  const duration = timing.getStageDuration('test.stage');
  assert.ok(typeof duration === 'number');
  assert.ok(duration >= 0);
});

test('createRequestTiming factory creates instance', () => {
  const timing = createRequestTiming('test-id');
  assert.ok(timing instanceof RequestTiming);
  assert.equal(timing.requestId, 'test-id');
});

test('complete is idempotent', () => {
  const timing = new RequestTiming('test');
  timing.start('stage');
  timing.end('stage');
  timing.complete();
  timing.complete(); // Should not throw or change anything

  const summary = timing.summary();
  assert.equal(summary.completed, true);
});

test('start overwrites previous stage start', () => {
  const timing = new RequestTiming('test');
  timing.start('stage');
  timing.start('stage'); // restart
  timing.end('stage');

  const summary = timing.summary();
  assert.ok(summary.stages['stage'].durationMs >= 0);
});

test('timing operations never throw', () => {
  const timing = new RequestTiming('test');
  // All of these should be safe
  assert.doesNotThrow(() => {
    timing.start('a');
    timing.end('a');
    timing.fail('b', 'err');
    timing.complete();
    timing.summary();
    timing.getStages();
    timing.getStageDuration('a');
  });
});

test('metadata is preserved in stage records', () => {
  const timing = new RequestTiming('test');
  timing.start('stage', { customField: 'value', count: 42 });
  timing.end('stage', 'completed', { result: 'success' });

  const stages = timing.getStages();
  assert.equal(stages[0].customField, 'value');
  assert.equal(stages[0].count, 42);
  assert.equal(stages[0].result, 'success');
});

test('isFailed returns false for successful request', () => {
  const timing = new RequestTiming('test');
  timing.start('stage');
  timing.end('stage');
  assert.equal(timing.isFailed(), false);
  assert.equal(timing.getFailure(), null);
});

test('isFailed returns true after fail()', () => {
  const timing = new RequestTiming('test');
  timing.start('failing.stage');
  timing.fail('failing.stage', 'error message');
  assert.equal(timing.isFailed(), true);
  const failure = timing.getFailure();
  assert.ok(failure);
  assert.equal(failure.stage, 'failing.stage');
  assert.equal(failure.error, 'error message');
});

test('fail captures errorCode and component', () => {
  const timing = new RequestTiming('test');
  timing.start('stage');
  timing.fail('stage', 'error', { errorCode: 'NO_CANDIDATES', component: 'ranking-engine' });
  
  const failure = timing.getFailure();
  assert.equal(failure.errorCode, 'NO_CANDIDATES');
  assert.equal(failure.component, 'ranking-engine');
});

test('summary includes failure info', () => {
  const timing = new RequestTiming('test');
  timing.start('stage1');
  timing.end('stage1');
  timing.start('stage2');
  timing.fail('stage2', 'broke');
  
  const summary = timing.summary();
  assert.ok(summary.failure);
  assert.equal(summary.failure.stage, 'stage2');
  assert.equal(summary.failure.error, 'broke');
});
