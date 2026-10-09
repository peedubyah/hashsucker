import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createAnticipationScheduler } from '../src/lib/anticipation/scheduler.js';

test('due season reconciliation alternates with ordinary episode work', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createFutureIntentStore({ db, clock: () => 1_000_000 });
  store.ensureRequestedSeason({ mediaId: 'tt-fair', tmdbId: 1, season: 1 });
  store.seed({ mediaType: 'series', mediaId: 'tt-fair', season: 1, episode: 1 });
  let seasons = 0;
  const scheduler = createAnticipationScheduler({
    store, baseUrl: 'http://unused', fetchFn: async () => { throw new Error('network not expected'); },
    reconcileRequestedSeasonFn: async () => { seasons += 1; },
    clock: () => 1_000_000,
    sleepFn: async () => {},
  });
  const first = await scheduler.tickOnce();
  assert.equal(first.seasonId, 1);
  const second = await scheduler.tickOnce();
  assert.notEqual(second.seasonId, 1);
  assert.equal(seasons, 1);
});
