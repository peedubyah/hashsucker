import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createAnticipationScheduler } from '../src/lib/anticipation/scheduler.js';

test('future season episode before preparation boundary performs no network work', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createFutureIntentStore({ db, clock: () => 1_000_000 });
  store.seed({ mediaType: 'series', mediaId: 'tt-future', season: 1, episode: 5, expectedAt: 1_000_000 + 30 * 86400000 });
  const calls = [];
  const scheduler = createAnticipationScheduler({
    store,
    baseUrl: 'http://unused',
    fetchFn: async (...args) => { calls.push(args); throw new Error('network must not run'); },
    clock: () => 1_000_000,
  });
  const result = await scheduler.tickOnce();
  assert.equal(result.to, 'anticipated');
  assert.equal(calls.length, 0);
  assert.equal(store.findByIdentity({ mediaId: 'tt-future', season: 1, episode: 5 }).last_error, 'outside-prepare-window');
});
