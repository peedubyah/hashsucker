import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PREPARE_OUTCOME,
  PREPARE_STATE,
  isPreparationActive,
  isPreparationTerminal,
  toPrepareOutcome,
  nextPreparationState,
  orderPrepareProviders,
} from '../src/lib/prepare/contract.js';

test('outcome mapping covers the adapter surface', () => {
  assert.equal(toPrepareOutcome({ present: true }), PREPARE_OUTCOME.ALREADY_PRESENT);
  assert.equal(toPrepareOutcome({ blocked: true }), PREPARE_OUTCOME.CONTENT_BLOCKED);
  assert.equal(toPrepareOutcome({ accountIneligible: true }), PREPARE_OUTCOME.ACCOUNT_INELIGIBLE);
  assert.equal(toPrepareOutcome({ rateLimited: true }), PREPARE_OUTCOME.RATE_LIMITED);
  assert.equal(toPrepareOutcome({ retryAfterMs: 5000 }), PREPARE_OUTCOME.RATE_LIMITED);
  assert.equal(toPrepareOutcome({ unsupported: true }), PREPARE_OUTCOME.UNSUPPORTED);
  assert.equal(toPrepareOutcome({ accepted: true, ready: true }), PREPARE_OUTCOME.READY);
  assert.equal(toPrepareOutcome({ accepted: true }), PREPARE_OUTCOME.ACCEPTED);
  assert.equal(toPrepareOutcome({ retryable: true }), PREPARE_OUTCOME.TEMPORARY_FAILURE);
  assert.equal(toPrepareOutcome({}), PREPARE_OUTCOME.FAILED);
  assert.equal(toPrepareOutcome(null), PREPARE_OUTCOME.FAILED);
});

test('state transitions route outcomes correctly', () => {
  assert.equal(nextPreparationState('queued', PREPARE_OUTCOME.READY), PREPARE_STATE.READY);
  assert.equal(nextPreparationState('queued', PREPARE_OUTCOME.ACCEPTED), PREPARE_STATE.ACQUIRING);
  assert.equal(nextPreparationState('acquiring', PREPARE_OUTCOME.ACCEPTED), PREPARE_STATE.WAITING);
  assert.equal(nextPreparationState('waiting', PREPARE_OUTCOME.ALREADY_PRESENT), PREPARE_STATE.WAITING);
  assert.equal(nextPreparationState('waiting', PREPARE_OUTCOME.CONTENT_BLOCKED), PREPARE_STATE.FAILED_POLICY);
  assert.equal(nextPreparationState('waiting', PREPARE_OUTCOME.ACCOUNT_INELIGIBLE), PREPARE_STATE.FAILED_TERMINAL);
  assert.equal(nextPreparationState('waiting', PREPARE_OUTCOME.RATE_LIMITED), PREPARE_STATE.FAILED_TEMPORARY);
  assert.equal(nextPreparationState('waiting', PREPARE_OUTCOME.TEMPORARY_FAILURE), PREPARE_STATE.FAILED_TEMPORARY);
  assert.equal(nextPreparationState('waiting', PREPARE_OUTCOME.FAILED), PREPARE_STATE.FAILED_TERMINAL);
});

test('active vs terminal sets are disjoint and complete', () => {
  for (const s of Object.values(PREPARE_STATE)) {
    assert.notEqual(isPreparationActive(s), isPreparationTerminal(s), `state ${s} must be exactly one`);
  }
  assert.ok(isPreparationActive(PREPARE_STATE.QUEUED));
  assert.ok(isPreparationActive(PREPARE_STATE.WAITING));
  assert.ok(isPreparationTerminal(PREPARE_STATE.READY));
  assert.ok(isPreparationTerminal(PREPARE_STATE.FAILED_POLICY));
  assert.ok(!isPreparationTerminal(PREPARE_STATE.FAILED_TEMPORARY), 'temporary failure stays re-drivable');
});

test('provider ordering skips refusals without global preference', () => {
  assert.deepEqual(orderPrepareProviders(['torbox', 'realdebrid']), ['torbox', 'realdebrid']);
  assert.deepEqual(orderPrepareProviders(['realdebrid', 'torbox']), ['realdebrid', 'torbox']);
  const memory = { contentBlocked: new Set(['torbox']), accountIneligible: new Set() };
  assert.deepEqual(orderPrepareProviders(['torbox', 'realdebrid'], memory), ['realdebrid']);
  const memory2 = { contentBlocked: new Set(), accountIneligible: new Set(['realdebrid']) };
  assert.deepEqual(orderPrepareProviders(['torbox', 'realdebrid'], memory2), ['torbox']);
  assert.deepEqual(orderPrepareProviders(['torbox'], { contentBlocked: new Set(['torbox']) }), []);
  assert.deepEqual(orderPrepareProviders(null), []);
});
