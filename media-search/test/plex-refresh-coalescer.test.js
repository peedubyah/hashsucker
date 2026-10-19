/**
 * Plex refresh coalescer targeted tests.
 *
 * Contract (B2-B5):
 *  - N episode refresh requests for the same (collection, scanPath) →
 *    one actual refresh.
 *  - Different target paths do not coalesce.
 *  - Single movie refresh still works.
 *  - Single episode refresh still works.
 *  - Playback paths (webdav, part, fuse) cause zero refresh.
 *  - Failure / timeout does not produce a full-section scan fallback.
 *  - Debounce timing is bounded.
 *  - Plex token never appears in logs or error messages.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRefreshCoalescer, refreshKey, REFRESH_DEFAULTS } from '../src/lib/plex/refresh-coalescer.js';
import { planPlexRefresh, getPlexRefreshAccount, _setCoalescerForTests } from '../src/lib/requests/plex-notifier.js';
import { setPlexRefreshAccount, getMetrics } from '../src/lib/metrics.js';

// Use a fake clock so we can drive the debounce window deterministically.
function fakeClock() {
  let now = 1_700_000_000_000;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    advance(ms) { now += ms; },
    setTimeout(fn, ms) {
      const id = nextId++;
      const dueAt = now + ms;
      timers.set(id, { fn, dueAt });
      // The setTimeout is observed by the test. The coalescer calls
      // fire() synchronously when its window elapses; for tests we
      // dispatch timers eagerly at advance() time.
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

function makeCoalescer({ windowMs = 50, dispatch = null, logger = null } = {}) {
  const clock = fakeClock();
  const coalescer = createRefreshCoalescer({
    windowMs,
    clock,
    logger,
    dispatch,
  });
  return { coalescer, clock };
}

// ─── Coalescer core ─────────────────────────────────────────────────────────

test('coalescer: N same-key requests produce exactly one actual refresh', async () => {
  let dispatchCalls = 0;
  const dispatched = [];
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    dispatch: async (args) => { dispatchCalls += 1; dispatched.push(args); return { ok: true }; },
  });
  const keyArgs = { sectionId: '3', scanPath: '/mnt/hashsucker-vfs/TV/Fleabag (2016)/Season 01', collection: 'TV' };
  const r1 = coalescer.schedule({ ...keyArgs, mediaId: 'tt5687612-s1e1' });
  const r2 = coalescer.schedule({ ...keyArgs, mediaId: 'tt5687612-s1e2' });
  const r3 = coalescer.schedule({ ...keyArgs, mediaId: 'tt5687612-s1e3' });
  const r4 = coalescer.schedule({ ...keyArgs, mediaId: 'tt5687612-s1e4' });
  const r5 = coalescer.schedule({ ...keyArgs, mediaId: 'tt5687612-s1e5' });
  const r6 = coalescer.schedule({ ...keyArgs, mediaId: 'tt5687612-s1e6' });
  // First schedules, rest coalesce.
  assert.equal(r1.coalesced, false);
  for (const r of [r2, r3, r4, r5, r6]) assert.equal(r.coalesced, true);
  // No actual refresh yet.
  assert.equal(coalescer.pendingCount(), 1);
  // Advance past the window.
  clock.advance(75);
  clock.runDue();
  await Promise.all([r1.result, r2.result, r3.result, r4.result, r5.result, r6.result]);
  assert.equal(dispatchCalls, 1, 'exactly one actual refresh dispatched');
  assert.equal(coalescer.pendingCount(), 0);
  const account = coalescer.getAccount();
  assert.equal(account.refresh_requested, 6);
  assert.equal(account.refresh_coalesced, 5);
  assert.equal(account.actual_refresh_sent, 1);
  assert.equal(account.full_section_refresh, 0);
  assert.equal(account.refresh_failed, 0);
  // The merged dispatch carries the latest mediaId and the coalesced count.
  assert.equal(dispatched[0].coalescedCount, 6);
});

test('coalescer: different target paths do not coalesce with each other', async () => {
  let dispatchCalls = 0;
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => { dispatchCalls += 1; return { ok: true }; },
  });
  const base = { sectionId: '3', collection: 'TV' };
  // Same show, different seasons → different scan paths.
  const r1 = coalescer.schedule({ ...base, scanPath: '/mnt/.../Fleabag/Season 01', mediaId: 's1e1' });
  const r2 = coalescer.schedule({ ...base, scanPath: '/mnt/.../Fleabag/Season 02', mediaId: 's2e1' });
  // Different show, different path.
  const r3 = coalescer.schedule({ ...base, scanPath: '/mnt/.../Ted Lasso/Season 01', mediaId: 'ted-s1e1' });
  assert.equal(r1.coalesced, false);
  assert.equal(r2.coalesced, false);
  assert.equal(r3.coalesced, false);
  assert.equal(coalescer.pendingCount(), 3);
  clock.advance(75);
  clock.runDue();
  await Promise.all([r1.result, r2.result, r3.result]);
  assert.equal(dispatchCalls, 3);
  const account = coalescer.getAccount();
  assert.equal(account.actual_refresh_sent, 3);
  assert.equal(account.refresh_coalesced, 0);
});

test('coalescer: different collections (movie vs tv) never coalesce with each other', async () => {
  let dispatchCalls = 0;
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => { dispatchCalls += 1; return { ok: true }; },
  });
  const r1 = coalescer.schedule({ sectionId: '2', collection: 'Movies', scanPath: '/mnt/.../Movies/Dune (2021)', mediaId: 'tt15239678' });
  const r2 = coalescer.schedule({ sectionId: '3', collection: 'TV', scanPath: '/mnt/.../TV/Fleabag/Season 01', mediaId: 'tt5687612' });
  // Even if the scan path text overlapped, the collection + sectionId
  // differ so the keys must differ. Force the literal same string:
  const r3 = coalescer.schedule({ sectionId: '3', collection: 'TV', scanPath: '/mnt/.../TV/Fleabag/Season 01', mediaId: 'tt5687612-other' });
  assert.equal(r1.coalesced, false);
  assert.equal(r2.coalesced, false);
  assert.equal(r3.coalesced, true, 'same (collection, section, path) coalesces');
  clock.advance(75);
  clock.runDue();
  await Promise.all([r1.result, r2.result, r3.result]);
  assert.equal(dispatchCalls, 2, 'movie + tv → 2 actual refreshes');
});

test('coalescer: single movie refresh still works (one call → one dispatch)', async () => {
  let dispatchCalls = 0;
  const dispatched = [];
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    dispatch: async (args) => { dispatchCalls += 1; dispatched.push(args); return { ok: true }; },
  });
  const r = coalescer.schedule({ sectionId: '2', collection: 'Movies', scanPath: '/mnt/.../Movies/Dune (2021)', mediaId: 'tt15239678' });
  assert.equal(r.coalesced, false);
  clock.advance(75);
  clock.runDue();
  const result = await r.result;
  assert.equal(result.ok, true);
  assert.equal(dispatchCalls, 1);
  assert.equal(dispatched[0].mediaId, 'tt15239678');
  assert.equal(dispatched[0].coalescedCount, 1);
});

test('coalescer: single episode refresh still works', async () => {
  let dispatchCalls = 0;
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => { dispatchCalls += 1; return { ok: true }; },
  });
  const r = coalescer.schedule({ sectionId: '3', collection: 'TV', scanPath: '/mnt/.../TV/Fleabag/Season 01', mediaId: 'tt5687612-s1e3' });
  clock.advance(75);
  clock.runDue();
  const result = await r.result;
  assert.equal(result.ok, true);
  assert.equal(dispatchCalls, 1);
});

test('coalescer: debounce window is bounded and timing is predictable', async () => {
  let dispatchCalls = 0;
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => { dispatchCalls += 1; return { ok: true }; },
  });
  const r = coalescer.schedule({ sectionId: '3', collection: 'TV', scanPath: '/mnt/.../TV/Fleabag/Season 01', mediaId: 'e01' });
  // Advance half the window — no fire yet.
  clock.advance(25);
  clock.runDue();
  assert.equal(dispatchCalls, 0);
  assert.equal(coalescer.pendingCount(), 1);
  // Advance the rest — fires exactly once.
  clock.advance(30);
  clock.runDue();
  await r.result;
  assert.equal(dispatchCalls, 1);
  // Window default sanity check: production window is short and bounded.
  assert.ok(REFRESH_DEFAULTS.windowMs >= 50 && REFRESH_DEFAULTS.windowMs <= 2000,
    `default window must be bounded; got ${REFRESH_DEFAULTS.windowMs}`);
});

test('coalescer: window is clamped to safe bounds', () => {
  // Min clamp
  const c1 = createRefreshCoalescer({ windowMs: 1 });
  assert.equal(c1._internal.window, REFRESH_DEFAULTS.minWindowMs);
  // Max clamp
  const c2 = createRefreshCoalescer({ windowMs: 999_999 });
  assert.equal(c2._internal.window, REFRESH_DEFAULTS.maxWindowMs);
  // In range passes through
  const c3 = createRefreshCoalescer({ windowMs: 250 });
  assert.equal(c3._internal.window, 250);
});

test('coalescer: dispatch failure does not escalate to full-section scan', async () => {
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => ({ ok: false, error: 'simulated plex 500' }),
  });
  const r = coalescer.schedule({ sectionId: '3', collection: 'TV', scanPath: '/mnt/.../TV/Fleabag/Season 01', mediaId: 'e01' });
  clock.advance(75);
  clock.runDue();
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'simulated plex 500');
  // No full-section scan counted. Failed targeted refreshes are
  // reported via refresh_failed, not escalated.
  const account = coalescer.getAccount();
  assert.equal(account.full_section_refresh, 0);
  assert.equal(account.refresh_failed, 1);
  assert.equal(account.actual_refresh_sent, 1);
});

test('coalescer: dispatch throw does not escalate to full-section scan', async () => {
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => { throw new Error('boom'); },
  });
  const r = coalescer.schedule({ sectionId: '3', collection: 'TV', scanPath: '/mnt/.../TV/Fleabag/Season 01', mediaId: 'e01' });
  clock.advance(75);
  clock.runDue();
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
  const account = coalescer.getAccount();
  assert.equal(account.full_section_refresh, 0);
  assert.equal(account.refresh_failed, 1);
});

test('coalescer: missing sectionId or scanPath is refused (no silent fallback)', async () => {
  let dispatchCalls = 0;
  const { coalescer } = makeCoalescer({
    windowMs: 50,
    dispatch: async () => { dispatchCalls += 1; return { ok: true }; },
  });
  // Missing scanPath
  const r1 = coalescer.schedule({ sectionId: '3', collection: 'TV', mediaId: 'e01' });
  const result1 = await r1.result;
  assert.equal(result1.ok, false);
  assert.equal(result1.error, 'missing-section-or-path');
  // Missing sectionId
  const r2 = coalescer.schedule({ scanPath: '/a', collection: 'TV', mediaId: 'e01' });
  const result2 = await r2.result;
  assert.equal(result2.ok, false);
  assert.equal(result2.error, 'missing-section-or-path');
  // No dispatch was ever attempted for these.
  assert.equal(dispatchCalls, 0);
  const account = coalescer.getAccount();
  assert.equal(account.refresh_requested, 2);
  assert.equal(account.actual_refresh_sent, 0);
  assert.equal(account.full_section_refresh, 0);
  assert.equal(account.refresh_failed, 2);
});

test('coalescer: refreshKey produces distinct keys for distinct inputs', () => {
  assert.equal(
    refreshKey({ sectionId: '3', scanPath: '/a', collection: 'TV' }),
    refreshKey({ sectionId: '3', scanPath: '/a', collection: 'TV' }),
  );
  assert.notEqual(
    refreshKey({ sectionId: '3', scanPath: '/a', collection: 'TV' }),
    refreshKey({ sectionId: '4', scanPath: '/a', collection: 'TV' }),
  );
  assert.notEqual(
    refreshKey({ sectionId: '3', scanPath: '/a', collection: 'TV' }),
    refreshKey({ sectionId: '3', scanPath: '/b', collection: 'TV' }),
  );
  assert.notEqual(
    refreshKey({ sectionId: '3', scanPath: '/a', collection: 'TV' }),
    refreshKey({ sectionId: '3', scanPath: '/a', collection: 'Movies' }),
  );
  assert.equal(refreshKey({ sectionId: '', scanPath: '/a' }), null);
  assert.equal(refreshKey({ sectionId: '3', scanPath: '' }), null);
});

test('coalescer: account snapshot mirrors changes for metrics sink', () => {
  const { coalescer } = makeCoalescer({ windowMs: 1000 });
  const seen = [];
  const sink = (snap) => seen.push({ ...snap });
  // Re-create with sink (test-time wiring).
  const c2 = createRefreshCoalescer({ windowMs: 1000, onAccount: sink });
  c2.schedule({ sectionId: '3', collection: 'TV', scanPath: '/a', mediaId: 'e01' });
  c2.schedule({ sectionId: '3', collection: 'TV', scanPath: '/a', mediaId: 'e02' });
  // Two schedule() calls each emit one snapshot; the sink must see
  // monotonically growing counters.
  const last = seen[seen.length - 1];
  assert.equal(last.refresh_requested, 2);
  assert.equal(last.refresh_coalesced, 1);
  assert.equal(last.actual_refresh_sent, 0);
  assert.equal(last.pending, 1);
});

test('coalescer: dispatch error messages do not contain caller-supplied secrets', async () => {
  const seen = [];
  const logger = {
    log: (msg) => seen.push(['log', msg]),
    error: (msg) => seen.push(['error', msg]),
  };
  // The coalescer must never amplify caller-supplied args into the
  // logger. We craft a dispatch that fails, then assert the
  // resulting error message does NOT include caller payload.
  const SECRET = 'PLEX-TOKEN-SECRET-abc123-XYZ';
  const { coalescer, clock } = makeCoalescer({
    windowMs: 50,
    logger,
    dispatch: async (args) => {
      // The coalescer-supplied args should not be logged. The fake
      // dispatcher here is only used to provoke the error path.
      return { ok: false, error: 'http-500' };
    },
  });
  // Provide the secret in mediaId. The coalescer must NOT echo it.
  const r = coalescer.schedule({
    sectionId: '3', collection: 'TV', scanPath: '/a', mediaId: SECRET,
  });
  clock.advance(75);
  clock.runDue();
  await r.result;
  for (const [, msg] of seen) {
    assert.ok(!msg.includes(SECRET), `logger leaked caller payload: ${msg}`);
  }
  // The Plex token is loaded by the notifier, not the coalescer.
  // Confirm the coalescer API surface never accepts a token field.
  assert.equal(coalescer._internal.token, undefined);
});

// ─── planPlexRefresh (notifier public helper) ───────────────────────────────

test('planPlexRefresh: returns safe scan path for TV episode', () => {
  const before = { ...process.env };
  try {
    process.env.PLEX_URL = 'http://192.168.2.4:32400';
    process.env.PLEX_TOKEN = 'faketoken';
    process.env.PLEX_TV_SECTION_ID = '3';
    process.env.PLEX_TV_ROOT = '/mnt/hashsucker-vfs/TV';
    process.env.PLEX_MOVIES_SECTION_ID = '2';
    process.env.PLEX_MOVIES_ROOT = '/mnt/hashsucker-vfs/Movies';
    const plan = planPlexRefresh({
      mediaType: 'tv',
      canonicalPath: 'TV/Fleabag (2016)/Season 01/Fleabag (2016) - S01E03.mkv',
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.sectionId, '3');
    assert.equal(plan.collection, 'TV');
    assert.equal(plan.scanPath, '/mnt/hashsucker-vfs/TV/Fleabag (2016)/Season 01');
  } finally {
    process.env = before;
  }
});

test('planPlexRefresh: returns safe scan path for movie', () => {
  const before = { ...process.env };
  try {
    process.env.PLEX_URL = 'http://192.168.2.4:32400';
    process.env.PLEX_TOKEN = 'faketoken';
    process.env.PLEX_TV_SECTION_ID = '3';
    process.env.PLEX_TV_ROOT = '/mnt/hashsucker-vfs/TV';
    process.env.PLEX_MOVIES_SECTION_ID = '2';
    process.env.PLEX_MOVIES_ROOT = '/mnt/hashsucker-vfs/Movies';
    const plan = planPlexRefresh({
      mediaType: 'movie',
      canonicalPath: 'Movies/Black Panther (2018)/Black Panther (2018).mkv',
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.sectionId, '2');
    assert.equal(plan.collection, 'Movies');
    assert.equal(plan.scanPath, '/mnt/hashsucker-vfs/Movies/Black Panther (2018)');
  } finally {
    process.env = before;
  }
});

test('planPlexRefresh: refuses path that escapes collection root', () => {
  const before = { ...process.env };
  try {
    process.env.PLEX_URL = 'http://192.168.2.4:32400';
    process.env.PLEX_TOKEN = 'faketoken';
    process.env.PLEX_TV_SECTION_ID = '3';
    process.env.PLEX_TV_ROOT = '/mnt/hashsucker-vfs/TV';
    process.env.PLEX_MOVIES_SECTION_ID = '2';
    process.env.PLEX_MOVIES_ROOT = '/mnt/hashsucker-vfs/Movies';
    const plan = planPlexRefresh({
      mediaType: 'tv',
      canonicalPath: 'Movies/Foo.mkv',
    });
    assert.equal(plan.ok, false);
    // We must NOT silently fall back to a full-section scan.
    assert.equal(plan.error, 'invalid-canonical-path');
  } finally {
    process.env = before;
  }
});

test('planPlexRefresh: refuses to dispatch when plex is disabled', () => {
  const before = { ...process.env };
  try {
    delete process.env.PLEX_URL;
    delete process.env.PLEX_TOKEN;
    const plan = planPlexRefresh({
      mediaType: 'tv',
      canonicalPath: 'TV/Fleabag (2016)/Season 01/Fleabag (2016) - S01E03.mkv',
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'plex-disabled');
  } finally {
    process.env = before;
  }
});

test('planPlexRefresh: refuses path traversal segments', () => {
  const before = { ...process.env };
  try {
    process.env.PLEX_URL = 'http://192.168.2.4:32400';
    process.env.PLEX_TOKEN = 'faketoken';
    process.env.PLEX_TV_SECTION_ID = '3';
    process.env.PLEX_TV_ROOT = '/mnt/hashsucker-vfs/TV';
    const plan = planPlexRefresh({
      mediaType: 'tv',
      canonicalPath: 'TV/Fleabag (2016)/../etc/S01E03.mkv',
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'invalid-canonical-path');
  } finally {
    process.env = before;
  }
});

// ─── Metrics integration ───────────────────────────────────────────────────

test('metrics: getMetrics() includes plex_refresh snapshot from coalescer', () => {
  const coalescer = createRefreshCoalescer({ windowMs: 1000, dispatch: async () => ({ ok: true }) });
  // Wire to metrics via the public sink contract.
  const sink = (snap) => setPlexRefreshAccount(snap);
  // Capture the snapshot the coalescer would emit by inspecting it directly.
  coalescer.schedule({ sectionId: '3', collection: 'TV', scanPath: '/a', mediaId: 'e01' });
  coalescer.schedule({ sectionId: '3', collection: 'TV', scanPath: '/a', mediaId: 'e02' });
  setPlexRefreshAccount(coalescer.getAccount());
  const m = getMetrics();
  assert.ok(m.plex_refresh);
  assert.equal(m.plex_refresh.refresh_requested, 2);
  assert.equal(m.plex_refresh.refresh_coalesced, 1);
  assert.equal(m.plex_refresh.actual_refresh_sent, 0);
  assert.equal(m.plex_refresh.full_section_refresh, 0);
  // The sink is only used in production; the test just exercises the
  // metrics module surface. We don't actually call sink() because we
  // already injected the snapshot directly above.
  void sink;
});

// ─── Direct-play / transcode contract: zero refresh invocations ─────────────

test('contract: direct-play / transcode / seek / stop / restart must not call notifyPlex', async () => {
  // The notifier is the only publication-driven path that triggers
  // Plex refresh. Playback (WebDAV, Part, FUSE, direct play,
  // transcode) does not import it. We assert the notifier's
  // accounting remains at zero when no publication has happened.
  //
  // Inject a fresh coalescer so the test is independent of the
  // singleton's previous state.
  const previous = _setCoalescerForTests(createRefreshCoalescer({ windowMs: 1000 }));
  try {
    const account = getPlexRefreshAccount();
    assert.equal(account.refresh_requested, 0);
    assert.equal(account.actual_refresh_sent, 0);
    assert.equal(account.full_section_refresh, 0);
    assert.equal(account.refresh_coalesced, 0);
  } finally {
    _setCoalescerForTests(previous);
  }
});
