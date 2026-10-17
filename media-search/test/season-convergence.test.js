/**
 * Requested-season convergence invariants (autonomous lifecycle slice).
 *
 * Deterministic clock-controlled tests for the real gaps found in the
 * production audit:
 *  - future release boundaries wake the scheduler (nextWakeAt), instead of
 *    waiting out a full fixed tick interval;
 *  - every non-playable episode maps to one small operator cause set
 *    (explainIntent);
 *  - market-miss cold retry stays bounded (one attempt per cold cycle,
 *    never a fresh hot budget).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  createFutureIntentStore,
  explainIntent,
} from '../src/lib/anticipation/future-intents.js';
import { isColdRetryEligible } from '../src/lib/anticipation/scheduler.js';

const T0 = 1_000_000;

function memStore(clock = () => T0) {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock });
  return { cache, store };
}

test('nextWakeAt accounts for a future release boundary sooner than the next poll', () => {
  const { cache, store } = memStore();
  // Ordinary row polling in 15 minutes.
  store.seed({ mediaType: 'series', mediaId: 'tt-wake1', season: 1, episode: 1, checkInMs: 15 * 60 * 1000 });
  // Future episode airing in 2 minutes.
  store.seed({
    mediaType: 'series', mediaId: 'tt-wake1', season: 1, episode: 2,
    expectedAt: T0 + 2 * 60 * 1000, deferReason: 'future-not-released', checkInMs: 60 * 60 * 1000,
  });
  const wake = store.nextWakeAt();
  assert.equal(wake, T0 + 2 * 60 * 1000, 'wake at the release boundary, not the next poll');
  cache.close();
});

test('nextWakeAt surfaces an already-passed release boundary as due now', () => {
  const { cache, store } = memStore();
  store.seed({ mediaType: 'series', mediaId: 'tt-wake2', season: 1, episode: 1, checkInMs: 15 * 60 * 1000 });
  const { intent } = store.seed({
    mediaType: 'series', mediaId: 'tt-wake2', season: 1, episode: 2,
    expectedAt: T0 - 1000, deferReason: 'future-not-released', checkInMs: 60 * 60 * 1000,
  });
  assert.ok(intent);
  const wake = store.nextWakeAt();
  assert.ok(wake <= T0, 'passed boundary wakes immediately');
  cache.close();
});

test('explainIntent maps every non-playable state to one small cause set', () => {
  const cases = [
    [null, 'no-obligation'],
    [{ state: 'playable' }, 'playable'],
    [{ state: 'withdrawn' }, 'withdrawn'],
    [{ state: 'anticipated', defer_reason: 'future-not-released', expected_at: T0 + 1000 }, 'future'],
    [{ state: 'anticipated', defer_reason: 'released-no-candidate', next_check_at: T0 + 1 }, 'no-cached-route'],
    [{ state: 'anticipated', defer_reason: 'candidate-not-fulfillable', next_check_at: T0 + 1 }, 'candidate-not-fulfillable'],
    [{ state: 'prepared', last_error: null, next_check_at: T0 + 1 }, 'prepared-publication-pending'],
    [{ state: 'prepared', last_error: 'waiting-for-acceptable-quality:unknown', next_check_at: T0 + 1 }, 'prepared-waiting-quality'],
    [{ state: 'published_preparing', next_check_at: T0 + 1 }, 'publication-unconfirmed'],
    [{ state: 'failed', attempts: 6, defer_reason: 'released-no-candidate', next_check_at: T0 + 1 }, 'no-cached-route-cold-park'],
    [{ state: 'failed', attempts: 6, defer_reason: 'hard-failure', next_check_at: T0 + 1 }, 'exhausted-terminal'],
  ];
  for (const [intent, cause] of cases) {
    assert.equal(explainIntent(intent, T0).cause, cause, JSON.stringify(intent));
  }
});

test('cold retry stays bounded: eligible once per park, never a fresh hot budget', () => {
  const marketMiss = {
    state: 'failed', attempts: 6, season_owners: 'season:tt-x:s01',
    defer_reason: 'released-no-candidate', next_check_at: T0,
  };
  assert.equal(isColdRetryEligible(marketMiss, T0), true, 'parked market miss re-arms');
  const terminal = { ...marketMiss, defer_reason: 'hard-failure' };
  assert.equal(isColdRetryEligible(terminal, T0), false, 'deterministic failure stays terminal');
  const oneShot = { ...marketMiss, season_owners: '' };
  assert.equal(isColdRetryEligible(oneShot, T0), false, 'one-shot exhaustion stays permanent');
  const early = { ...marketMiss, next_check_at: T0 + 1000 };
  assert.equal(isColdRetryEligible(early, T0), false, 'park must elapse first');
});

test('future episode obligation is created once and converges, never clobbers', () => {
  const { cache, store } = memStore();
  const first = store.seed({
    mediaType: 'series', mediaId: 'tt-once', season: 2, episode: 3,
    source: 'seerr:1', expectedAt: T0 + 86400 * 1000, deferReason: 'future-not-released',
  });
  assert.equal(first.created, true);
  const second = store.seed({
    mediaType: 'series', mediaId: 'tt-once', season: 2, episode: 3,
    source: 'seerr:1', expectedAt: T0 + 86400 * 1000, deferReason: 'future-not-released',
  });
  assert.equal(second.created, false, 'duplicate seed converges, never duplicates');
  assert.equal(second.intent.id, first.intent.id);
  cache.close();
});
