import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyState, makeRecord, validateScenario } from '../benchmarks/lib.js';

test('benchmark state classification never infers cold from missing VFS alone', () => {
  assert.equal(classifyState({}), 'unknown');
  assert.equal(classifyState({ publicationCount: 0 }), 'unknown');
  assert.equal(classifyState({ authoritativeAbsence: true }), 'cold');
  assert.equal(classifyState({ publicationCount: 2 }), 'partial');
  assert.equal(classifyState({ authoritative: true, playable: true }), 'warm');
});

test('tier three requires a provider budget and records blocked safely', () => {
  assert.throws(() => validateScenario({ name: 'x', tier: 3 }), /missing/);
  const record = makeRecord({ scenario: 'cold-small-season', starting_state: 'unknown', status: 'BLOCKED' });
  assert.equal(record.status, 'BLOCKED');
  assert.ok(record.run_id);
});
