/**
 * Upgrade-watch store tests: idempotent seed/converge, due ordering,
 * backoff parking, removal. Evaluator HTTP flow is proven on a scratch
 * instance; here only the durable state machine is pinned.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createUpgradeWatchStore } from '../src/lib/lifecycle/upgrade-watch.js';

function memStore(clock = () => 1000) {
  return createUpgradeWatchStore({ db: new DatabaseSync(':memory:'), clock });
}

test('ensure seeds once, converges adopted binding, never duplicates', () => {
  const store = memStore();
  const a = store.ensure({ mediaType: 'movie', mediaId: 'tt1', tf: 'tf-a', tier: 32, label: 'web-dl/1080p' });
  assert.ok(a.created);
  const b = store.ensure({ mediaType: 'movie', mediaId: 'tt1', tf: 'tf-a', tier: 32, label: 'web-dl/1080p' });
  assert.ok(!b.created && !b.adopted);
  assert.equal(b.row.id, a.row.id);
  const c = store.ensure({ mediaType: 'movie', mediaId: 'tt1', tf: 'tf-b', tier: 42, label: 'bluray/1080p' });
  assert.ok(c.adopted, 'binding changed underneath converges');
  assert.equal(c.row.current_tf, 'tf-b');
  assert.equal(store.counts(), 1);
});

test('due returns only ripe rows in order; park backs off', () => {
  let t = 1000;
  const store = memStore(() => t);
  store.ensure({ mediaType: 'movie', mediaId: 'tt1', tf: 'a', tier: 10, label: 'x', dueInMs: 0 });
  store.ensure({ mediaType: 'movie', mediaId: 'tt2', tf: 'b', tier: 10, label: 'x', dueInMs: 60_000 });
  let due = store.due({ limit: 5 });
  assert.equal(due.length, 1);
  assert.equal(due[0].media_id, 'tt1');
  const n = store.park(due[0].id, { reason: 'market-empty' });
  assert.equal(n, 1);
  due = store.due({ limit: 5 });
  assert.equal(due.length, 0, 'parked beyond backoff horizon');
  t += 61 * 60 * 1000;
  due = store.due({ limit: 5 });
  assert.ok(due.some((r) => r.media_id === 'tt1'), 'ripe again after backoff');
  assert.equal(due.find((r) => r.media_id === 'tt1').attempts, 1);
  store.remove(due[0].id);
  assert.equal(store.counts(), 1);
});
