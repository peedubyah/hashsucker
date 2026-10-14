import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createAnticipationScheduler } from '../src/lib/anticipation/scheduler.js';

// Driven through the scheduler tick (the real entry path), not a direct
// processIntent call: the store surfaces a released future-not-released row
// as due, and the tick must perform its one-time release wake — clear the
// pre-release classification and re-attempt exactly once.
test('released future wake clears future classification after one rearm (via tick)', async () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => 1_000_000 });
  const { intent } = store.seed({
    mediaType: 'series', mediaId: 'tt-retry', season: 1, episode: 8,
    expectedAt: 900_000, deferReason: 'future-not-released',
  });
  // Exhausted its pre-release retry budget while still unreleased.
  store.transition(intent.id, 'failed', { last_error: 'prepare-http-200', next_check_at: 9_999_999 });
  cache.db.prepare('UPDATE future_intents SET attempts=6 WHERE id=?').run(intent.id);

  const httpCalls = [];
  const scheduler = createAnticipationScheduler({
    store, baseUrl: 'http://test', dataPlaneBaseUrl: null,
    fetchFn: async (url) => { httpCalls.push(url); throw new Error('prepare unavailable'); },
    clock: () => 1_000_000, log: () => {},
    tvPrepareDays: 3, tvPublishDays: 1,
  });

  const result = await scheduler.tickOnce();
  // The wake itself must run (the row was released while failed).
  assert.equal(result.intentId, intent.id, 'the released row was processed');
  const row = store.findByIdentity({ mediaId: 'tt-retry', season: 1, episode: 8 });
  assert.equal(row.defer_reason, 'released-no-candidate',
    'pre-release classification cleared after the air date passed');
  assert.equal(row.state, 'anticipated', 'one further attempt granted');
  // It attempted fulfillment again (prepare over HTTP) rather than dying.
  assert.ok(httpCalls.some((u) => u.includes('/api/media-prepare')),
    'the wake re-attempts preparation');
  // And the wake is one-time: a subsequent failure obeys ordinary released
  // semantics (parked, not re-woken by the same air date).
  cache.close();
});

// The same row, now re-failed under released semantics, must NOT be re-woken
// by the release-wake path a second time.
test('release wake is one-time: a released row that fails again parks', async () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => 1_000_000 });
  const { intent } = store.seed({
    mediaType: 'series', mediaId: 'tt-retry2', season: 1, episode: 9,
    expectedAt: 900_000, deferReason: 'released-no-candidate',
  });
  store.transition(intent.id, 'failed', { last_error: 'prepare-http-500', next_check_at: 1 });
  cache.db.prepare('UPDATE future_intents SET attempts=6 WHERE id=?').run(intent.id);

  const scheduler = createAnticipationScheduler({
    store, baseUrl: 'http://test', dataPlaneBaseUrl: null,
    fetchFn: async () => { throw new Error('prepare unavailable'); },
    clock: () => 1_000_000, log: () => {},
  });
  await scheduler.tickOnce();
  const row = store.findByIdentity({ mediaId: 'tt-retry2', season: 1, episode: 9 });
  assert.equal(row.defer_reason, 'released-no-candidate', 'classification unchanged');
  assert.equal(row.state, 'failed', 'still failed, never re-woken');
  cache.close();
});
