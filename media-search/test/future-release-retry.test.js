import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createAnticipationScheduler } from '../src/lib/anticipation/scheduler.js';

test('released future wake clears future classification after one rearm', async () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => 1_000_000 });
  const { intent } = store.seed({ mediaType: 'series', mediaId: 'tt-retry', season: 1, episode: 8, expectedAt: 900_000, deferReason: 'future-not-released' });
  store.transition(intent.id, 'failed', { last_error: 'prepare-http-200', next_check_at: 9_999_999 });
  cache.db.prepare('UPDATE future_intents SET attempts=6 WHERE id=?').run(intent.id);
  const scheduler = createAnticipationScheduler({ store, baseUrl: 'http://test', clock: () => 1_000_000, fetchFn: async () => { throw new Error('network not expected'); }, log: () => {} });
  const result = await scheduler.tickOnce();
  assert.equal(result.error, true);
  const row = store.findByIdentity({ mediaId: 'tt-retry', season: 1, episode: 8 });
  assert.equal(row.defer_reason, 'released-no-candidate');
  cache.close();
});
