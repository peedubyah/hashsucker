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

test('evaluate drops watch row when publication retired, without network', async () => {
  const { createUpgradeWatchStore, createUpgradeEvaluator } =
    await import('../src/lib/lifecycle/upgrade-watch.js');
  const { DatabaseSync } = await import('node:sqlite');
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const { createControlPlaneStore } = await import('../src/lib/control-plane/store.js');
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const controlPlaneStore = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  const store = createUpgradeWatchStore({ db: cache.db });
  // Published-then-retired: library item absent, VFS row gone.
  controlPlaneStore.ensureLibraryItem({
    mediaType: 'movie', mediaId: 'tt-gone', title: 'Gone', desiredState: 'absent',
  });
  store.ensure({ mediaType: 'movie', mediaId: 'tt-gone', tf: 'tf-old', tier: 32, label: 'web-dl/1080p' });
  let fetched = 0;
  const ev = createUpgradeEvaluator({
    store, cache, controlPlaneStore, baseUrl: 'http://127.0.0.1:9',
    fetchFn: async () => { fetched++; throw new Error('must not fetch'); },
  });
  const [row] = store.due({ limit: 1 });
  const out = await ev.evaluate(row);
  assert.equal(out.to, 'removed');
  assert.equal(out.reason, 'no-active-publication');
  assert.equal(fetched, 0, 'no network before confirming publication');
  assert.equal(store.counts(), 0);
});

test('placementHeld requires a currently-ready placement', async () => {
  const { placementHeld } = await import('../src/lib/lifecycle/upgrade-watch.js');
  const storeFor = (rows) => ({
    findPlacementByInfoHash: (provider, hash) =>
      rows.find((r) => r.provider === provider && r.infoHash === hash) ?? null,
  });
  const H = 'a'.repeat(40);
  assert.equal(placementHeld(storeFor([]), H), false);
  assert.equal(placementHeld(storeFor([{ provider: 'torbox', infoHash: H, state: 'ready' }]), H), true);
  assert.equal(placementHeld(storeFor([{ provider: 'torbox', infoHash: H, state: 'removed' }]), H), false);
  assert.equal(placementHeld(storeFor([{ provider: 'torbox', infoHash: H, state: 'error' }]), H), false);
  assert.equal(placementHeld(storeFor([{ provider: 'torbox', infoHash: H, state: 'degraded' }]), H), false);
  assert.equal(placementHeld(storeFor([{ provider: 'torbox', infoHash: H, state: 'pending' }]), H), false);
  assert.equal(placementHeld(storeFor([{ provider: 'realdebrid', infoHash: H, state: 'ready' }]), H), true);
  assert.equal(placementHeld(null, H), false);
});

test('RD status maps stay within the placements CHECK constraint', async () => {
  const a = await import('../src/lib/control-plane/second-placement.js');
  const b = await import('../src/lib/control-plane/rd-placement-realizer.js');
  const allowed = new Set(['pending', 'ready', 'degraded', 'error', 'removed', 'unknown']);
  for (const [name, map] of [['second-placement', a.RD_STATE_MAP], ['realizer', b.RD_STATE_MAP]]) {
    for (const [k, v] of Object.entries(map)) {
      assert.ok(allowed.has(v), `${name}: ${k} -> ${v} violates CHECK`);
    }
    assert.equal(map.error, 'error');
    assert.equal(map.dead, 'error');
    assert.equal(map.downloaded, 'ready');
  }
  assert.deepEqual(a.RD_STATE_MAP, b.RD_STATE_MAP, 'mirrored maps agree');
});
