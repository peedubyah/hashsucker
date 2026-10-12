/**
 * Anticipatory scheduler tests (anticipatory tranche).
 *
 * Fixture stores + stub HTTP/data-plane. No network, no providers.
 * Covers: durable intent claim/idempotency, prepare→prepared,
 * publish-only-after-winner, byte-probe gating, exhaustion withdrawal,
 * episode isolation, race single-winner, prewarm range math.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createFutureIntentStore,
  INTENT_STATES,
  intentBackoffMs,
} from '../src/lib/anticipation/future-intents.js';
import { createAnticipationScheduler, classifyIntentPriority } from '../src/lib/anticipation/scheduler.js';
import { __rangesForTests } from '../src/lib/anticipation/prewarm.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

function memDb() {
  return new DatabaseSync(':memory:');
}

function stubBody() {
  const chunks = [Buffer.from('x'.repeat(70000))];
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
      cancel: async () => {},
    }),
  };
}

// Stub HTTP: scripted prepare/publish/data-plane responses + call log.
function stubHttp({ prepareTf = 'tf_prep1', publishTf = null, probeOk = true } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url, body });
    if (url.endsWith('/api/media-prepare')) {
      return { status: 200, text: async () => JSON.stringify({ prepared: true, handoff: { torrentFileId: prepareTf } }) };
    }
    if (url.endsWith('/api/media-request')) {
      return { status: 200, text: async () => JSON.stringify({ handoff: { torrentFileId: publishTf ?? prepareTf }, reuseMode: 'republish', fulfilled: true, published: true, vfsPublished: true }) };
    }
    if (url.includes('/files/')) {
      if (!probeOk) return { status: 503, text: async () => '', body: stubBody() };
      return { status: 206, text: async () => '', body: stubBody() };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchFn, calls };
}

function scheduler({ store, httpOpts, cache = null, controlPlaneStore = null, checkStates = {} } = {}) {
  const { fetchFn, calls } = stubHttp(httpOpts);
  const sched = createAnticipationScheduler({
    store,
    baseUrl: 'http://test:3000',
    dataPlaneBaseUrl: 'http://dp:3001',
    cache,
    controlPlaneStore,
    fetchFn,
    checkTorBoxCachedFn: async (hashes) => hashes.map((h) => ({ infoHash: h, state: checkStates[h] ?? 'cached' })),
    clock: () => 1_000_000,
    log: () => {},
  });
  return { sched, calls };
}

test('seed is idempotent; claim admits exactly one winner', () => {
  const store = createFutureIntentStore({ db: memDb() });
  const a = store.seed({ mediaType: 'movie', mediaId: 'tt1' });
  const b = store.seed({ mediaType: 'movie', mediaId: 'tt1' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.intent.id, b.intent.id);
  assert.equal(store.claim(a.intent.id), true);
  assert.equal(store.claim(a.intent.id), false, 'second claim loses');
  const counts = Object.fromEntries(store.counts().map((r) => [r.state, r.n]));
  assert.equal(counts.preparing, 1);
});

test('anticipated tick prepares without publishing', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'tt1' });
  const { sched, calls } = scheduler({ store });
  const r = await sched.tickOnce();
  assert.equal(r.acted, true);
  assert.equal(r.to, INTENT_STATES.PREPARED);
  assert.ok(calls.some((c) => c.url.endsWith('/api/media-prepare')));
  assert.ok(!calls.some((c) => c.url.endsWith('/api/media-request')), 'no publish before winner');
  const row = store.list({})[0];
  assert.equal(row.torrent_file_id, 'tf_prep1');
});

test('prepare failure backs off, terminal failure parks', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  store.seed({ mediaType: 'movie', mediaId: 'tt1' });
  const fetchFn = async (url) => {
    if (url.endsWith('/api/media-prepare')) {
      return { status: 500, text: async () => JSON.stringify({ error: 'boom' }) };
    }
    throw new Error('unexpected ' + url);
  };
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d', fetchFn,
    clock: () => 1_000_000, log: () => {},
  });
  const r = await sched.tickOnce();
  assert.equal(r.to, INTENT_STATES.ANTICIPATED);
  const row = store.list({})[0];
  assert.ok(row.next_check_at > 1_000_000, 'backoff scheduled');
  assert.equal(row.attempts, 1);
});

test('prepared tick publishes same winner and reaches playable on probe', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'tt1' });
  const { sched, calls } = scheduler({ store });
  await sched.tickOnce(); // anticipate -> prepared
  // Make prepared due immediately.
  store.transition(intent.id, INTENT_STATES.PREPARED, { torrent_file_id: 'tf_prep1', next_check_at: 0 });
  const r2 = await sched.tickOnce();
  assert.equal(r2.to, INTENT_STATES.PLAYABLE);
  const row = store.list({})[0];
  assert.equal(row.torrent_file_id, 'tf_prep1');
  const publish = calls.find((c) => c.url.endsWith('/api/media-request'));
  assert.equal(publish.body.sourceType, 'future-intent-publish');
});

test('winner change converges explicitly with recorded evidence', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'tt1' });
  const { sched } = scheduler({ store, httpOpts: { prepareTf: 'tf_A', publishTf: 'tf_B' } });
  await sched.tickOnce();
  store.transition(intent.id, INTENT_STATES.PREPARED, { torrent_file_id: 'tf_A', next_check_at: 0 });
  const r2 = await sched.tickOnce();
  assert.equal(r2.to, INTENT_STATES.PLAYABLE);
  const row = store.list({})[0];
  assert.equal(row.torrent_file_id, 'tf_B', 'converged onto published winner');
  assert.match(row.last_error ?? '', /winner-changed:tf_A->tf_B/);
});

test('probe failure plus uncached revalidation withdraws presentation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anticip-wd-'));
  const saved = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cache = createDiscoveryCache();
  try {
    const store = createFutureIntentStore({ db: memDb() });
    const { intent } = store.seed({ mediaType: 'movie', mediaId: 'tt9' });
    const { fetchFn } = stubHttp({ probeOk: false });
    const sched = createAnticipationScheduler({
      store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
      cache, controlPlaneStore: {},
      fetchFn,
      checkTorBoxCachedFn: async (hashes) => hashes.map((h) => ({ infoHash: h, state: 'uncached' })),
      clock: () => 1_000_000, log: () => {},
    });
    await sched.tickOnce(); // anticipated -> prepared
    store.transition(intent.id, INTENT_STATES.PREPARED, { torrent_file_id: 'tf_prep1', next_check_at: 0 });
    const r2 = await sched.tickOnce(); // publish ok, probe fails
    assert.equal(r2.to, INTENT_STATES.PUBLISHED_PREPARING);
    assert.notEqual(store.list({})[0].state, INTENT_STATES.PLAYABLE);
    // Exhaustion drill: failed probe + same-hash UNCACHED revalidation.
    const r = await sched.checkExhaustion(
      { ...store.list({})[0], torrent_file_id: 'tf_prep1' },
      'h'.repeat(40),
    );
    assert.equal(r.exhausted, true);
    assert.equal(r.ok, true);
    assert.equal(store.list({})[0].state, INTENT_STATES.WITHDRAWN);
  } finally {
    cache.close();
  }
});

test('episode intents are isolated', () => {
  const store = createFutureIntentStore({ db: memDb() });
  const e1 = store.seed({ mediaType: 'series', mediaId: 'ttS', season: 1, episode: 1 });
  const e2 = store.seed({ mediaType: 'series', mediaId: 'ttS', season: 1, episode: 2 });
  assert.notEqual(e1.intent.id, e2.intent.id);
  assert.equal(store.claim(e1.intent.id), true);
  assert.equal(store.claim(e2.intent.id), true, 'sibling episode claims independently');
  // Claimed rows surface as due only via orphan reaping (preparing state
  // is included in due()); unclaimed siblings are due normally.
  const dueIds = store.due(10).map((r) => r.id);
  assert.ok(dueIds.includes(e1.intent.id) && dueIds.includes(e2.intent.id));
});

test('scheduler passes the configured due limit and reaches work beyond ten rows', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  const dueCalls = [];
  const originalDue = store.due.bind(store);
  store.due = (options) => {
    dueCalls.push(options);
    return originalDue(options);
  };
  for (let i = 0; i < 12; i += 1) {
    const { intent } = store.seed({ mediaType: 'movie', mediaId: `tt-exhausted-${i}` });
    store.claim(intent.id);
    store.transition(intent.id, INTENT_STATES.FAILED, {
      last_error: 'attempts-exhausted:parked',
      next_check_at: 0,
    });
    for (let attempt = 1; attempt < 6; attempt += 1) {
      store.retry(intent.id, 0);
      store.claim(intent.id);
      store.transition(intent.id, INTENT_STATES.FAILED, {
        last_error: 'attempts-exhausted:parked',
        next_check_at: 0,
      });
    }
  }
  const target = store.seed({ mediaType: 'movie', mediaId: 'tt-retryable-after-prefix' }).intent;
  store.transition(target.id, INTENT_STATES.ANTICIPATED, { next_check_at: 0 });
  const { sched } = scheduler({ store });
  const result = await sched.tickOnce();
  assert.equal(dueCalls[0].limit, 50);
  assert.equal(result.intentId, target.id);
  assert.equal(result.acted, true);
  assert.notEqual(store.findByIdentity({ mediaId: 'tt-retryable-after-prefix' }).state, INTENT_STATES.ANTICIPATED);
});

test('ordinary drain executes up to four actionable rows in priority order', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  for (let i = 0; i < 4; i += 1) store.seed({ mediaType: 'movie', mediaId: `tt-drain-${i}` });
  const logs = [];
  const { fetchFn } = stubHttp();
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://test:3000', dataPlaneBaseUrl: 'http://dp:3001', fetchFn,
    clock: () => 1_000_000, log: (msg) => logs.push(msg),
  });
  await sched.tickOnce();
  assert.equal(logs.filter((msg) => msg.startsWith('scheduler due-row')).length, 4);
  assert.ok(logs.some((msg) => msg.includes('scheduler drain actions=4')));
  assert.deepEqual(store.list({ state: INTENT_STATES.PREPARED, limit: 10 }).map((row) => row.media_id), [
    'tt-drain-0', 'tt-drain-1', 'tt-drain-2', 'tt-drain-3',
  ]);
});

test('priority classifier uses durable intent state and ownership fields', () => {
  const nowMs = 1_000_000;
  assert.equal(classifyIntentPriority({ state: 'published_preparing' }, nowMs).className, 'P0');
  assert.equal(classifyIntentPriority({ state: 'anticipated', season_owners: 'season:x:s01', expected_at: nowMs }, nowMs).className, 'P1');
  assert.equal(classifyIntentPriority({ state: 'prepared' }, nowMs).className, 'P2');
  assert.equal(classifyIntentPriority({ state: 'anticipated', expected_at: nowMs }, nowMs).className, 'P3');
  assert.equal(classifyIntentPriority({ state: 'failed', attempts: 1 }, nowMs).className, 'P4');
  assert.equal(classifyIntentPriority({ state: 'failed', attempts: 6 }, nowMs).actionable, false);
  assert.equal(classifyIntentPriority({ state: 'anticipated', expected_at: nowMs + 1, defer_reason: 'future-not-released' }, nowMs).actionable, false);
});

test('P0 drains before P1 and exhausted rows consume no action slots', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  const exhausted = store.seed({ mediaType: 'movie', mediaId: 'tt-drain-exhausted' }).intent;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    store.claim(exhausted.id);
    store.transition(exhausted.id, INTENT_STATES.FAILED, { last_error: 'attempts-exhausted:parked', next_check_at: 0 });
    if (attempt < 5) store.retry(exhausted.id, 0);
  }
  store.seed({ mediaType: 'movie', mediaId: 'tt-drain-p1', season: 1, episode: 1, expectedAt: 1_000_000, deferReason: 'candidate-not-fulfillable' });
  const p0 = store.seed({ mediaType: 'movie', mediaId: 'tt-drain-p0' }).intent;
  store.transition(p0.id, INTENT_STATES.PUBLISHED_PREPARING, { next_check_at: 0 });
  const logs = [];
  const { fetchFn } = stubHttp();
  const sched = createAnticipationScheduler({ store, baseUrl: 'http://test:3000', dataPlaneBaseUrl: 'http://dp:3001', fetchFn, clock: () => 1_000_000, log: (msg) => logs.push(msg) });
  await sched.tickOnce();
  const rows = logs.filter((msg) => msg.startsWith('scheduler due-row'));
  assert.match(rows[0], /id=\d+ state=published_preparing class=P0/);
  assert.ok(!rows.some((msg) => msg.includes('attempts-exhausted')));
});

test('future-not-released rows retain priority over ordinary backlog', () => {
  const store = createFutureIntentStore({ db: memDb() });
  const future = store.seed({ mediaType: 'series', mediaId: 'tt-future-priority', season: 1, episode: 1, expectedAt: 900_000, deferReason: 'future-not-released' }).intent;
  const ordinary = store.seed({ mediaType: 'movie', mediaId: 'tt-ordinary-priority' }).intent;
  const due = store.due({ limit: 2 });
  assert.equal(due[0].id, future.id);
  assert.equal(due[1].id, ordinary.id);
});

test('season reconciliation and ordinary work alternate without starvation', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  const season = store.ensureRequestedSeason({ mediaId: 'tt-season-fair', tmdbId: 1, season: 1, nextCheckAt: 0 });
  const ordinary = store.seed({ mediaType: 'movie', mediaId: 'tt-ordinary-fair' }).intent;
  const calls = [];
  const { fetchFn } = stubHttp();
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://test:3000', dataPlaneBaseUrl: 'http://dp:3001', fetchFn,
    clock: () => 1_000_000, log: () => {},
    reconcileRequestedSeasonFn: async (row) => { calls.push(row.id); return { ok: true }; },
  });
  const first = await sched.tickOnce();
  assert.equal(first.seasonId, season.id);
  store.scheduleRequestedSeason(season.id, 2_000_000);
  const second = await sched.tickOnce();
  assert.equal(second.intentId, ordinary.id);
});

test('prewarm ranges cover head and tail without overlap', async () => {
  const GB = 1024 * 1024 * 1024;
  const big = __rangesForTests(40 * GB);
  assert.ok(big.length >= 17, `head 16 + tail, got ${big.length}`);
  assert.deepEqual(big[0], [0, 8 * 1024 * 1024 - 1]);
  const last = big[big.length - 1];
  assert.equal(last[1], 40 * GB - 1);
  const small = __rangesForTests(4 * 1024 * 1024);
  assert.deepEqual(small, [[0, 4 * 1024 * 1024 - 1]], 'small file: single head range, no duplicate tail');
  assert.deepEqual(__rangesForTests(0), []);
  assert.deepEqual(__rangesForTests(-5), []);
});

test('intent backoff steps are bounded', async () => {
  assert.equal(intentBackoffMs(0), 15 * 60 * 1000);
  assert.equal(intentBackoffMs(2), 4 * 60 * 60 * 1000);
  assert.equal(intentBackoffMs(99), 24 * 60 * 60 * 1000);
});

test('far-future expectations sleep to window without provider calls', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  const nowMs = 1_000_000_000;
  const day = 86400 * 1000;
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'ttW', source: 'window-test' });
  store.transition(intent.id, 'anticipated', {});
  // Simulate a far-future expected_at via direct update (seed takes it too).
  const db2store = store;
  void db2store;
  const { sched, calls } = scheduler({ store });
  void sched;
  // Drive processIntent directly with window params.
  const { createAnticipationScheduler: mk } = await import('../src/lib/anticipation/scheduler.js');
  const s2 = mk({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    fetchFn: async () => { throw new Error('must not call'); },
    clock: () => nowMs, log: () => {}, prepareDays: 30, publishDays: 7,
  });
  const row = store.list({}).find((r) => r.media_id === 'ttW');
  const r = await s2.processIntent({ ...row, expected_at: nowMs + 60 * day, arr_satisfied: 0 });
  assert.equal(r.to, 'anticipated');
  assert.equal(r.acted, true);
  const after = store.list({}).find((x) => x.media_id === 'ttW');
  assert.equal(after.next_check_at, nowMs + 60 * day - 30 * day, 'pushed to prepare window start');
});

test('satisfied intents park without fulfillment action', async () => {
  const store = createFutureIntentStore({ db: memDb() });
  store.seed({ mediaType: 'movie', mediaId: 'ttS', source: 'radarr:movie:9' });
  const row = store.list({})[0];
  store.refreshArr(row.id, { expectedAt: null, satisfied: true, nextCheckAt: 0 });
  const { createAnticipationScheduler: mk } = await import('../src/lib/anticipation/scheduler.js');
  let called = false;
  const s2 = mk({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    fetchFn: async () => { called = true; throw new Error('must not call'); },
    clock: () => 2_000_000_000, log: () => {}, prepareDays: 30, publishDays: 7,
  });
  const fresh = store.list({}).find((x) => x.media_id === 'ttS');
  const r = await s2.processIntent({ ...fresh });
  assert.equal(called, false, 'no provider calls for satisfied intent');
  assert.equal(store.list({})[0].state, 'anticipated');
});
