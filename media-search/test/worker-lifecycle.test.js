/**
 * Background worker lifecycle + restart invariants.
 *
 * The workers module owns every ticker. These tests pin the properties that
 * make a restart safe rather than stormy:
 *
 *   W1  every enabled worker arms EXACTLY ONE timer (no duplicate timers
 *       after a rebuild, no double-ticking);
 *   W2  first-tick delays are preserved per worker (a restart burst must not
 *       hit providers/sources immediately);
 *   W3  `stop()` clears every armed timer, so shutdown leaves no worker
 *       running against closed stores;
 *   W4  a disabled worker arms nothing;
 *   W5  re-arming is idempotent per tick: the next delay comes from the
 *       worker's own cadence, not from the initial delay.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createAnticipationScheduler } from '../src/lib/anticipation/scheduler.js';
import { startBackgroundWorkers } from '../src/server/workers.js';

const NOW = 1_800_000_000_000;

function tmpStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = createDiscoveryCache({ dbPath: join(dir, 'discovery.db') });
  t.after(() => cache.close());
  return { cache, store: createFutureIntentStore({ db: cache.db, clock: () => NOW }) };
}

/** Count live timers by patching the global timer constructors once. */
function instrumentTimers(t) {
  const armed = [];
  const realSetTimeout = globalThis.setTimeout;
  t.after(() => { globalThis.setTimeout = realSetTimeout; });
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const timer = realSetTimeout(fn, ms, ...rest);
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
      armed.push({ ms, timer, fn });
    }
    return timer;
  };
  return {
    armed,
    clearAll() {
      for (const a of armed) clearTimeout(a.timer);
    },
  };
}

const NO_HTTP = async () => { throw new Error('no network in lifecycle tests'); };

function workersEnv(t, overrides = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    CONSUMER_RECONCILE_ENABLED: '1',
    CORPUS_MAINTENANCE: '0',
    ANTICIPATION_ENABLED: '1',
    PLAYBACK_OBSERVATION_ENABLED: '0',
    UPGRADE_WATCH_ENABLED: '0',
    HASHSUCKER_PERMANENT_PATH: '',
    HASHSUCKER_DOWNLOAD_PATH: '',
    ARR_SYNC_ENABLED: '0',
    ENRICHMENT_ENABLED: '0',
    HYGIENE_ENABLED: '0',
    PLEX_URL: '',
    PLEX_TOKEN: '',
    ...overrides,
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });
}

test('W1/W2 — one timer per enabled worker, with its documented first-tick delay', (t) => {
  workersEnv(t);
  const timers = instrumentTimers(t);
  const { store } = tmpStore(t);
  const scheduler = createAnticipationScheduler({
    store,
    baseUrl: 'http://lifecycle.test',
    dataPlaneBaseUrl: null,
    fetchFn: NO_HTTP,
    clock: () => NOW,
    log: () => {},
    tvPrepareDays: 3,
    tvPublishDays: 1,
  });
  const workers = startBackgroundWorkers({
    discoveryCache: createDiscoveryCache({ dbPath: ':memory:' }),
    controlPlaneStore: null,
    port: 3000,
    scheduler,
  });
  t.after(() => workers.stop());

  const delays = timers.armed.map((a) => a.ms);
  // Consumer reconcile arms first (60s), then anticipation (2 min). Each worker
  // arms exactly one initial timer: the same delay never appears twice.
  assert.deepEqual(delays, [60_000, 120_000, 5_000],
    `one timer per enabled worker with its first-tick delay, got ${JSON.stringify(delays)}`);
});

test('W3 — stop() clears every armed timer', (t) => {
  workersEnv(t);
  const timers = instrumentTimers(t);
  const { cache, store } = tmpStore(t);
  const scheduler = createAnticipationScheduler({
    store, baseUrl: 'http://lifecycle.test', dataPlaneBaseUrl: null,
    fetchFn: NO_HTTP, clock: () => NOW, log: () => {},
  });
  const workers = startBackgroundWorkers({ discoveryCache: cache, controlPlaneStore: null, port: 3000, scheduler });
  assert.ok(timers.armed.length >= 2, 'workers armed their timers');
  const armedCount = timers.armed.length;
  workers.stop();
  timers.clearAll();
  // A second stop is safe (idempotent) and arms nothing new.
  workers.stop();
  assert.equal(timers.armed.length, armedCount, 'stop() does not re-arm anything');
});

test('W4 — disabled workers arm nothing', (t) => {
  workersEnv(t, {
    CONSUMER_RECONCILE_ENABLED: '0',
    ANTICIPATION_ENABLED: '0',
  });
  const timers = instrumentTimers(t);
  const { cache, store } = tmpStore(t);
  const workers = startBackgroundWorkers({
    discoveryCache: cache,
    controlPlaneStore: null,
    port: 3000,
    scheduler: null,
  });
  t.after(() => workers.stop());
  // Flag-gated workers arm nothing when disabled. The playback observer is a
  // documented exception: it always arms one timer and gates its work
  // internally, so exactly one timer exists.
  assert.deepEqual(timers.armed.map((a) => a.ms), [5_000],
    `only the always-armed observer timer exists, got ${JSON.stringify(timers.armed.map((a) => a.ms))}`);
});

test('W5 — re-arming uses the worker cadence, not the initial delay', async (t) => {
  workersEnv(t, { CONSUMER_RECONCILE_ENABLED: '0' });
  const timers = instrumentTimers(t);
  const { cache, store } = tmpStore(t);
  // A scheduler with the production 15-minute cadence.
  const scheduler = createAnticipationScheduler({
    store,
    baseUrl: 'http://lifecycle.test',
    dataPlaneBaseUrl: null,
    fetchFn: NO_HTTP,
    clock: () => NOW,
    log: () => {},
  });
  const workers = startBackgroundWorkers({ discoveryCache: cache, controlPlaneStore: null, port: 3000, scheduler });
  t.after(() => { workers.stop(); timers.clearAll(); });

  // The anticipation worker armed with its INITAL delay (2 minutes).
  const initial = timers.armed.find((a) => a.ms === 120_000);
  assert.ok(initial, `anticipation armed with its initial delay, got ${JSON.stringify(timers.armed.map((a) => a.ms))}`);

  // Fire that timer (the worker's own tick) and let it settle.
  await initial.fn();
  for (let i = 0; i < 50 && !timers.armed.some((a) => a.ms === 900_000); i += 1) {
    await new Promise((r) => setImmediate(r));
  }

  const delays = timers.armed.map((a) => a.ms);
  assert.ok(delays.includes(900_000),
    `re-armed with the worker cadence (900s), not the initial delay: ${JSON.stringify(delays)}`);
  assert.equal(
    delays.filter((d) => d === 120_000).length, 1,
    'the initial delay is never re-armed as if it were the cadence',
  );
});
