/**
 * Plex refresh fan-out scope targeted tests.
 *
 * Lifecycle-semantics contract: a Seerr season fan-out (or any
 * "strung-out" burst where child notifies arrive seconds apart) MUST
 * produce exactly one targeted Plex partial-refresh per
 * (collection, scanPath) bucket, even though the per-child work
 * exceeds the standard debounce window.
 *
 * The naive debounce keys on (collection, scanPath) and is bounded
 * by a ~750ms window — that window expires between children, so
 * without a fan-out scope each child becomes its own HTTP call.
 *
 * The scope is opened by the caller (e.g. handleSeerrIngress's
 * TV fan-out branch) before the per-episode loop and closed after
 * the loop. While the scope is open, schedule() calls whose mediaId
 * matches the scope's mediaId are folded into per-key buckets
 * inside the scope; no debounce timer starts. On close() each
 * non-empty bucket dispatches exactly one targeted refresh.
 *
 * Hard invariants:
 *  - One season fan-out, N children on the same scanPath →
 *    exactly ONE actual_refresh_sent.
 *  - Different scanPaths in the same fan-out → exactly one refresh
 *    per scanPath (still NO cross-bucket merging).
 *  - Schedules for OTHER mediaIds inside the open scope are
 *    unaffected — they still use the normal debounce path.
 *  - Closing an empty scope does NOT dispatch anything.
 *  - Closing an already-closed scope is idempotent and does NOT
 *    re-dispatch.
 *  - A failed dispatch on close() does not escalate to a
 *    full-section scan and surfaces via refresh_failed.
 *  - Scope lifecycle integrates with the existing accounting
 *    surface (refresh_requested, refresh_coalesced,
 *    actual_refresh_sent, refresh_failed, plus the new
 *    fan_out_scope_closed, fan_out_bucket_dispatched,
 *    fan_out_bucket_merged counters).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRefreshCoalescer } from '../src/lib/plex/refresh-coalescer.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function fakeClock() {
  let now = 1_700_000_000_000;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    advance(ms) { now += ms; },
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, dueAt: now + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => Array.from(timers.values()),
    runDue() {
      const due = Array.from(timers.entries()).filter(([, t]) => t.dueAt <= now);
      for (const [id, t] of due) {
        timers.delete(id);
        try { t.fn(); } catch { /* ignore */ }
      }
    },
  };
}

function makeCoalescer({ windowMs = 50, dispatch = null } = {}) {
  const clock = fakeClock();
  const coalescer = createRefreshCoalescer({ windowMs, clock, dispatch });
  return { coalescer, clock };
}

// ─── Core lifecycle contract ───────────────────────────────────────────────

test('fan-out: N children same scanPath → exactly one actual refresh on close', async () => {
  let dispatchCalls = 0;
  const dispatched = [];
  const { coalescer } = makeCoalescer({
    windowMs: 50,
    dispatch: async (args) => { dispatchCalls += 1; dispatched.push(args); return { ok: true }; },
  });
  // Production wires the scope to the series imdbId; every per-child
  // notifyPlex call carries the same series-level mediaId in its
  // schedule() envelope. The episode granularity lives in the
  // canonicalPath, not in the mediaId.
  const SERIES_MEDIA_ID = 'tt7366338';
  const scope = coalescer.fanOutScope(SERIES_MEDIA_ID);
  // Five children, all on the same Season 01 scanPath. In production
  // these arrive seconds apart; here we don't need to advance time —
  // the scope holds them and defers dispatch entirely.
  const results = [];
  for (let e = 1; e <= 5; e += 1) {
    const r = coalescer.schedule({
      sectionId: '3',
      scanPath: '/mnt/hashsucker-vfs/TV/tt7366338/Season 01',
      collection: 'TV',
      mediaId: SERIES_MEDIA_ID,
      mediaType: 'series',
    });
    results.push(r);
  }
  // The scope has buffered all 5; no debounce timer should have fired
  // (the first schedule was the only one that "started" a bucket;
  // the next four were folded in).
  assert.equal(coalescer._scopeBucketCountFor(SERIES_MEDIA_ID), 1,
    'all five children fold into a single (collection, scanPath) bucket');
  assert.equal(coalescer.pendingCount(), 0, 'no debounce-pending entry exists');
  // No dispatch happened yet.
  assert.equal(dispatchCalls, 0, 'no refresh dispatched before scope close');
  // Only the first schedule should be coalesced:false; the rest are folded.
  assert.equal(results[0].coalesced, false);
  for (let i = 1; i < 5; i += 1) assert.equal(results[i].coalesced, true);
  // Close the scope. Exactly one targeted refresh is dispatched.
  await scope.close();
  assert.equal(dispatchCalls, 1, 'exactly one actual refresh for the whole fan-out');
  assert.equal(dispatched[0].sectionId, '3');
  assert.equal(dispatched[0].scanPath, '/mnt/hashsucker-vfs/TV/tt7366338/Season 01');
  assert.equal(dispatched[0].coalescedCount, 5);
  // The latest mediaId is the series id (same for all children).
  assert.equal(dispatched[0].mediaId, SERIES_MEDIA_ID);
  // All 5 call-site promises resolve with ok:true.
  const settled = await Promise.all(results.map((r) => r.result));
  for (const s of settled) {
    assert.equal(s.ok, true);
    assert.equal(s.method, 'partial-refresh');
    assert.equal(s.coalescedCount, 5);
  }
  // Accounting surface reflects the fan-out.
  const account = coalescer.getAccount();
  assert.equal(account.refresh_requested, 5);
  assert.equal(account.fan_out_bucket_merged, 4, 'four of the five fold into the first bucket');
  assert.equal(account.fan_out_scope_closed, 1);
  assert.equal(account.fan_out_bucket_dispatched, 1);
  assert.equal(account.actual_refresh_sent, 1);
  assert.equal(account.refresh_failed, 0);
  assert.equal(account.full_section_refresh, 0);
});

test('fan-out: children on different scanPaths dispatch one per scanPath', async () => {
  let dispatchCalls = 0;
  const dispatched = [];
  const { coalescer } = makeCoalescer({
    windowMs: 50,
    dispatch: async (args) => { dispatchCalls += 1; dispatched.push(args); return { ok: true }; },
  });
  const SERIES_MEDIA_ID = 'tt7366338';
  const scope = coalescer.fanOutScope(SERIES_MEDIA_ID);
  // Two children on Season 01, two on Season 02 → two scanPath buckets.
  for (const season of [1, 1, 2, 2]) {
    coalescer.schedule({
      sectionId: '3',
      scanPath: `/mnt/hashsucker-vfs/TV/tt7366338/Season ${String(season).padStart(2, '0')}`,
      collection: 'TV',
      mediaId: SERIES_MEDIA_ID,
      mediaType: 'series',
    });
  }
  assert.equal(coalescer._scopeBucketCountFor(SERIES_MEDIA_ID), 2,
    'two distinct scanPaths → two buffered buckets');
  await scope.close();
  assert.equal(dispatchCalls, 2, 'one dispatch per scanPath, no cross-bucket merging');
  const paths = dispatched.map((d) => d.scanPath).sort();
  assert.deepEqual(paths, [
    '/mnt/hashsucker-vfs/TV/tt7366338/Season 01',
    '/mnt/hashsucker-vfs/TV/tt7366338/Season 02',
  ]);
  for (const d of dispatched) assert.equal(d.coalescedCount, 2);
});

test('fan-out: schedules for OTHER mediaIds are unaffected by the open scope', async () => {
  let dispatchCalls = 0;
  const dispatched = [];
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    dispatch: async (args) => { dispatchCalls += 1; dispatched.push(args); return { ok: true }; },
  });
  // Open a fan-out scope for Chernobyl (series-level mediaId).
  const CHERNOBYL = 'tt7366338';
  const scope = coalescer.fanOutScope(CHERNOBYL);
  // An unrelated movie notifyPlex arrives while the scope is open.
  // The movie uses a different mediaId, so it MUST NOT enter the
  // Chernobyl scope — it must use the normal debounce path.
  const movie = coalescer.schedule({
    sectionId: '2',
    scanPath: '/mnt/hashsucker-vfs/Movies/Dune (2021)',
    collection: 'Movies',
    mediaId: 'tt15239678',
    mediaType: 'movie',
  });
  // The movie schedule must NOT enter the Chernobyl scope.
  assert.equal(coalescer._scopeBucketCountFor(CHERNOBYL), 0, 'movie did not enter the Chernobyl scope');
  assert.equal(coalescer.pendingCount(), 1, 'movie is in the normal debounce path');
  // Advance past the movie debounce window — it dispatches independently.
  clock.advance(75);
  clock.runDue();
  await movie.result;
  assert.equal(dispatchCalls, 1, 'movie dispatched via normal debounce');
  assert.equal(dispatched[0].scanPath, '/mnt/hashsucker-vfs/Movies/Dune (2021)');
  // Now buffer a Chernobyl notify into the open scope, close, and confirm
  // the movie was independent of the season fan-out.
  coalescer.schedule({
    sectionId: '3',
    scanPath: '/mnt/hashsucker-vfs/TV/tt7366338/Season 01',
    collection: 'TV',
    mediaId: CHERNOBYL,
    mediaType: 'series',
  });
  assert.equal(coalescer._scopeBucketCountFor(CHERNOBYL), 1);
  await scope.close();
  assert.equal(dispatchCalls, 2, 'one movie (debounce) + one season bucket = 2 total');
});

test('fan-out: closing an empty scope dispatches nothing', async () => {
  let dispatchCalls = 0;
  const { coalescer } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => { dispatchCalls += 1; return { ok: true }; },
  });
  const scope = coalescer.fanOutScope('tt7366338');
  await scope.close();
  assert.equal(dispatchCalls, 0);
  const account = coalescer.getAccount();
  assert.equal(account.fan_out_scope_closed, 1);
  assert.equal(account.fan_out_bucket_dispatched, 0);
  assert.equal(account.actual_refresh_sent, 0);
});

test('fan-out: close() is idempotent — closing twice does not re-dispatch', async () => {
  let dispatchCalls = 0;
  const { coalescer } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => { dispatchCalls += 1; return { ok: true }; },
  });
  const scope = coalescer.fanOutScope('tt7366338');
  coalescer.schedule({
    sectionId: '3',
    scanPath: '/mnt/hashsucker-vfs/TV/tt7366338/Season 01',
    collection: 'TV',
    mediaId: 'tt7366338',
    mediaType: 'series',
  });
  const first = scope.close();
  const second = scope.close();
  await Promise.all([first, second]);
  assert.equal(dispatchCalls, 1, 'exactly one dispatch despite two close() calls');
});

test('fan-out: dispatch failure does not escalate to full-section scan', async () => {
  const { coalescer } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => ({ ok: false, error: 'simulated plex 500' }),
  });
  const scope = coalescer.fanOutScope('tt7366338');
  for (let e = 1; e <= 3; e += 1) {
    coalescer.schedule({
      sectionId: '3',
      scanPath: '/mnt/hashsucker-vfs/TV/tt7366338/Season 01',
      collection: 'TV',
      mediaId: 'tt7366338',
      mediaType: 'series',
    });
  }
  await scope.close();
  const account = coalescer.getAccount();
  assert.equal(account.full_section_refresh, 0, 'no escalation');
  assert.equal(account.refresh_failed, 1, 'single failed targeted refresh');
  assert.equal(account.actual_refresh_sent, 1, 'one attempt was made');
});

test('fan-out: openScope is keyed by mediaId — different mediaIds do not share a scope', async () => {
  let dispatchCalls = 0;
  const dispatched = [];
  const { coalescer } = makeCoalescer({
    windowMs: 50,
    dispatch: async (args) => { dispatchCalls += 1; dispatched.push(args); return { ok: true }; },
  });
  const scopeA = coalescer.fanOutScope('tt7366338');
  const scopeB = coalescer.fanOutScope('tt5687612');
  // One notify under A, one under B, both on the same scanPath text
  // (the shows happen to share a path by coincidence). They MUST
  // NOT merge across scopes.
  coalescer.schedule({
    sectionId: '3',
    scanPath: '/mnt/hashsucker-vfs/TV/Season 01',
    collection: 'TV',
    mediaId: 'tt7366338',
    mediaType: 'series',
  });
  coalescer.schedule({
    sectionId: '3',
    scanPath: '/mnt/hashsucker-vfs/TV/Season 01',
    collection: 'TV',
    mediaId: 'tt5687612',
    mediaType: 'series',
  });
  await scopeA.close();
  await scopeB.close();
  assert.equal(dispatchCalls, 2, 'different mediaIds → different bucket scopes → 2 dispatches');
  assert.equal(dispatched[0].mediaId, 'tt7366338');
  assert.equal(dispatched[1].mediaId, 'tt5687612');
});

test('fan-out: opening a scope for an already-open mediaId returns the same handle', () => {
  const { coalescer } = makeCoalescer({ windowMs: 50 });
  const a = coalescer.fanOutScope('tt7366338');
  const b = coalescer.fanOutScope('tt7366338');
  assert.equal(a, b, 'idempotent open for the same mediaId');
  assert.equal(coalescer.openScopeCount(), 1, 'only one scope tracked');
});

test('fan-out: missing-section-or-path refusal still works inside an open scope', async () => {
  const { coalescer } = makeCoalescer({ windowMs: 50 });
  const scope = coalescer.fanOutScope('tt7366338');
  // No sectionId → refuse; do not buffer into the scope.
  const r = coalescer.schedule({ scanPath: '/a', collection: 'TV', mediaId: 'tt7366338' });
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing-section-or-path');
  assert.equal(coalescer._scopeBucketCountFor('tt7366338'), 0, 'refused request does not enter scope');
  await scope.close();
});

test('fan-out: closed scopes do not accept new schedules', async () => {
  const { coalescer, clock } = makeCoalescer({ windowMs: 50, dispatch: async () => ({ ok: true }) });
  const scope = coalescer.fanOutScope('tt7366338');
  await scope.close();
  // After close, a new schedule for the same mediaId must NOT
  // silently create a new bucket; it must use the normal debounce
  // path so an unrelated call after a fan-out does not get held
  // indefinitely.
  const r = coalescer.schedule({
    sectionId: '3',
    scanPath: '/mnt/hashsucker-vfs/TV/tt7366338/Season 01',
    collection: 'TV',
    mediaId: 'tt7366338',
    mediaType: 'series',
  });
  assert.equal(coalescer.pendingCount(), 1, 'post-close schedule uses debounce path');
  clock.advance(75);
  clock.runDue();
  await r.result;
});

test('fan-out: scope.close() awaits all bucket dispatches', async () => {
  const dispatched = [];
  const dispatch = async (args) => {
    dispatched.push({ at: Date.now(), args });
    return { ok: true };
  };
  const { coalescer } = makeCoalescer({ windowMs: 50, dispatch });
  const scope = coalescer.fanOutScope('tt7366338');
  coalescer.schedule({ sectionId: '3', scanPath: '/a', collection: 'TV', mediaId: 'tt7366338' });
  coalescer.schedule({ sectionId: '3', scanPath: '/b', collection: 'TV', mediaId: 'tt7366338' });
  const settled = await scope.close();
  assert.equal(settled.length, 2);
  // Both bucket results are returned to the caller.
  for (const r of settled) assert.equal(r.ok, true);
});

test('fan-out: scope lifecycle metrics surface in getAccount', async () => {
  const { coalescer } = makeCoalescer({ windowMs: 50, dispatch: async () => ({ ok: true }) });
  const scope = coalescer.fanOutScope('tt7366338');
  coalescer.schedule({ sectionId: '3', scanPath: '/a', collection: 'TV', mediaId: 'tt7366338' });
  coalescer.schedule({ sectionId: '3', scanPath: '/a', collection: 'TV', mediaId: 'tt7366338' });
  coalescer.schedule({ sectionId: '3', scanPath: '/b', collection: 'TV', mediaId: 'tt7366338' });
  // Before close: nothing dispatched, three buffered across two buckets.
  let acct = coalescer.getAccount();
  assert.equal(acct.fan_out_scope_closed, 0);
  assert.equal(acct.fan_out_bucket_dispatched, 0);
  assert.equal(acct.fan_out_bucket_merged, 1, 'one fold-in across two same-key schedules');
  assert.equal(acct.actual_refresh_sent, 0);
  await scope.close();
  acct = coalescer.getAccount();
  assert.equal(acct.fan_out_scope_closed, 1);
  assert.equal(acct.fan_out_bucket_dispatched, 2);
  assert.equal(acct.actual_refresh_sent, 2);
});

test('fan-out: resetAccount zeroes the new counters too', async () => {
  const { coalescer } = makeCoalescer({ windowMs: 50, dispatch: async () => ({ ok: true }) });
  const scope = coalescer.fanOutScope('tt7366338');
  coalescer.schedule({ sectionId: '3', scanPath: '/a', collection: 'TV', mediaId: 'tt7366338' });
  await scope.close();
  coalescer.resetAccount();
  const acct = coalescer.getAccount();
  assert.equal(acct.fan_out_scope_closed, 0);
  assert.equal(acct.fan_out_bucket_dispatched, 0);
  assert.equal(acct.fan_out_bucket_merged, 0);
});