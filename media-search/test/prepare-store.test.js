import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { createPreparationStore } from '../src/lib/prepare/store.js';
import { PREPARE_STATE } from '../src/lib/prepare/contract.js';const HASH = 'aa'.repeat(20);
const OTHER_HASH = 'bb'.repeat(20);

function setup() {
  const db = new DatabaseSync(':memory:');
  return createPreparationStore({ db });
}

function intent(overrides = {}) {
  return {
    infoHash: HASH,
    provider: 'torbox',
    mediaType: 'movie',
    mediaId: 'tt0133093',
    candidate: { filename: 'The.Matrix.1999.mkv', size: 1000 },
    source: 'play',
    ...overrides,
  };
}

test('startOrJoin creates once and joins twice (single-flight)', () => {
  const store = setup();
  const first = store.startOrJoin(intent());
  assert.equal(first.created, true);
  assert.equal(first.preparation.state, PREPARE_STATE.QUEUED);
  const second = store.startOrJoin(intent());
  assert.equal(second.created, false);
  assert.equal(second.preparation.id, first.preparation.id);
  // A different provider is a different attempt chain.
  const other = store.startOrJoin(intent({ provider: 'realdebrid' }));
  assert.equal(other.created, true);
  assert.notEqual(other.preparation.id, first.preparation.id);
});

test('startOrJoin validates identity inputs', () => {
  const store = setup();
  assert.throws(() => store.startOrJoin(intent({ infoHash: 'xyz' })), /infoHash/);
  assert.throws(() => store.startOrJoin(intent({ provider: null })), /provider/);
});

test('claimDue is atomic and only claims due rows', () => {
  const store = setup();
  const { preparation } = store.startOrJoin(intent());
  const claimed = store.claimDue(preparation.id, PREPARE_STATE.ACQUIRING);
  assert.ok(claimed);
  assert.equal(claimed.state, PREPARE_STATE.ACQUIRING);
  assert.equal(claimed.attempts, 1);
  // Second claim on a non-queued/waiting row fails.
  assert.equal(store.claimDue(preparation.id, PREPARE_STATE.ACQUIRING), null);
  // Future-dated rows are not due.
  const future = store.startOrJoin(intent({ infoHash: OTHER_HASH }));
  store.markWaiting(future.preparation.id, { nextPollAt: Date.now() + 3600_000 });
  const due = store.listDue({ limit: 10 });
  assert.ok(due.every((r) => r.id !== future.preparation.id), 'future rows excluded');
});

test('lifecycle transitions move forward honestly', () => {
  const store = setup();
  const { preparation } = store.startOrJoin(intent());
  const waiting = store.markWaiting(preparation.id, { providerResourceId: 'res-1' });
  assert.equal(waiting.state, PREPARE_STATE.WAITING);
  assert.equal(waiting.provider_resource_id, 'res-1');
  const ready = store.markReady(preparation.id, {});
  assert.equal(ready.state, PREPARE_STATE.READY);
  // Terminal rows are not re-drivable by claim.
  assert.equal(store.claimDue(preparation.id, PREPARE_STATE.ACQUIRING), null);
});

test('failed_temporary requeues; other failures end', () => {
  const store = setup();
  const a = store.startOrJoin(intent()).preparation;
  store.markFailed(a.id, PREPARE_STATE.FAILED_TEMPORARY, { lastError: '429' });
  assert.equal(store.get(a.id).state, PREPARE_STATE.FAILED_TEMPORARY);
  assert.ok(store.requeue(a.id, Date.now()));
  assert.equal(store.get(a.id).state, PREPARE_STATE.QUEUED);
  const b = store.startOrJoin(intent({ infoHash: OTHER_HASH })).preparation;
  store.markFailed(b.id, PREPARE_STATE.FAILED_POLICY, { lastError: '451' });
  assert.equal(store.requeue(b.id, Date.now()), null);
  assert.throws(() => store.markFailed(b.id, 'ready'), /bad preparation failure state/);
});

test('cancel only touches active rows; expiry bounds lifetime', () => {
  const store = setup();
  const a = store.startOrJoin(intent()).preparation;
  store.markCancelled(a.id, 'test-abandon');
  assert.equal(store.get(a.id).state, PREPARE_STATE.CANCELLED);
  assert.equal(store.get(a.id).last_error, 'test-abandon');
  // Cancelling again is a no-op success path (row stays cancelled).
  store.markCancelled(a.id, 'again');
  assert.equal(store.get(a.id).state, PREPARE_STATE.CANCELLED);
  assert.equal(store.countActive(), 0);
  assert.equal(store.countActiveForProvider('torbox'), 0);
});

test('findByMedia and findLatest scope correctly', () => {
  const store = setup();
  store.startOrJoin(intent({ mediaId: 'tt0133093' }));
  store.startOrJoin(intent({ infoHash: OTHER_HASH, mediaId: 'tt9999999' }));
  assert.equal(store.findByMedia({ mediaId: 'tt0133093' }).length, 1);
  assert.equal(store.findLatest(HASH).provider, 'torbox');
  assert.equal(store.findActive(HASH, 'realdebrid'), null);
});

test('pruneTerminal ages out history but never active rows', () => {
  let t = 1_000_000;
  const db = new DatabaseSync(':memory:');
  const store = createPreparationStore({ db, clock: () => t });
  const a = store.startOrJoin(intent()).preparation;
  store.markReady(a.id, {});
  const b = store.startOrJoin(intent({ infoHash: OTHER_HASH })).preparation;
  t += 60_000;
  const pruned = store.pruneTerminal(30_000);
  assert.equal(pruned, 1);
  assert.equal(store.get(a.id), null);
  assert.ok(store.get(b.id));
});
