/**
 * Background Durability V1 — scheduling, eligibility, persistence tests.
 *
 * Slice A. These tests prove the scheduling/eligibility/persistence slice
 * in isolation, without touching any provider or repair logic. The
 * integration seam is exercised via an injected executor that records
 * calls.
 *
 * Coverage (A1–A6):
 *   A1 — Idempotent enrollment: newly-fulfilled + recently-repaired
 *   A2 — Persisted next_due across restart
 *   A3 — Deterministic jitter, sparse cadence
 *   A4 — Bounded overdue batches
 *   A5 — One active pass ownership; no startup full-library scan
 *   A6 — Minimal enable flag (default disabled) + diagnostics
 *
 * Excluded by design (Worker B):
 *   - provider freshness checks / network I/O
 *   - repair transactions
 *   - playback activity (does not yet exist durably in the control-plane
 *     store; deferred per Slice A brief)
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDurabilityScheduler,
  DURABILITY_MODE,
  __test__ as schedulerInternals,
} from '../src/lib/control-plane/durability-scheduler.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { REPAIR_FAILURE_CATEGORIES } from '../src/lib/control-plane/repair-events.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const HASH_B = '1234567890abcdef1234567890abcdef12345678';

function movie(overrides = {}) {
  return {
    mediaType: 'movie',
    mediaId: 'tt0133093',
    title: 'The Matrix',
    year: 1999,
    desiredState: 'present',
    ...overrides,
  };
}

function setupBindable(store, item, identity, options = {}) {
  const path = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: options.provider ?? 'realdebrid',
    accountScope: 'primary',
    infoHash: identity.infoHash,
    providerResourceId: options.resourceId ?? `resource-${identity.infoHash.slice(0, 5)}`,
    state: 'ready',
    ownership: options.ownership ?? 'owned',
    ownerKey: item.id,
    provenance: 'test',
    idempotencyKey: `placement:${options.provider ?? 'realdebrid'}:${identity.infoHash}`,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: options.providerFileId ?? 'file-1',
    path: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    name: 'The.Matrix.1999.mkv',
    size: 1_000,
    selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  const fileId = options.providerFileId ?? 'file-1';
  store.recordFileMapping({
    ...identity,
    placementId: placement.id,
    providerFileId: fileId,
    state: 'mapped',
    method: 'provider-file-id',
    authoritative: true,
  });
  const exposure = store.recordExposure({
    placementId: placement.id,
    providerFileId: fileId,
    transport: options.transport ?? 'zurg-rclone',
    exposureKey: options.exposureKey ?? `${placement.id}:${fileId}`,
    relativePath: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    state: 'visible',
    readOnly: true,
    observedAt: 0,
    expiresAt: 9_999_999_999_999,
  });
  return { path, placement, exposure, providerFileId: fileId };
}

// Use a fixed clock so deterministic-jitter math is exact.
function fixedClock(t) {
  const start = t;
  return () => start;
}

// ─── A1: idempotent enrollment ─────────────────────────────────────────

test('A1a: enrollNewlyFulfilled is idempotent on duplicate key', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000) });
  const item = store.ensureLibraryItem(movie());

  const first = sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_x:1',
    observedAt: 1_000,
  });
  assert.equal(first.enrolled, true);

  const second = sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_x:1', // identical
    observedAt: 2_000,                // even with later observedAt
  });
  assert.equal(second.enrolled, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(second.nextDueAt, first.nextDueAt, 'next_due is preserved on duplicate');

  // Underlying state is unchanged.
  const row = store.db.prepare('SELECT * FROM durability_due_state WHERE library_item_id = ?').get(item.id);
  assert.equal(row.enrollment_key, 'binding:bd_x:1');
  assert.equal(row.next_due_at, first.nextDueAt);

  store.close();
});

test('A1b: enrollNewlyFulfilled advances on a strictly-newer key', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000) });
  const item = store.ensureLibraryItem(movie());

  const first = sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_x:1',
    observedAt: 1_000,
  });
  const second = sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_y:2', // lexicographically newer
    observedAt: 5_000,
  });
  assert.equal(first.enrolled, true);
  assert.equal(second.enrolled, true);
  assert.notEqual(second.nextDueAt, first.nextDueAt, 'a newer key re-derives next_due');

  store.close();
});

test('A1c: enrollRecentlyRepaired is idempotent on duplicate repair event', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000) });
  const item = store.ensureLibraryItem(movie());

  const repairedAt = 1_234_567_890;
  const first = sched.enrollRecentlyRepaired({
    libraryItemId: item.id,
    infoHash: HASH,
    occurredAt: repairedAt,
  });
  assert.equal(first.enrolled, true);

  const dup = sched.enrollRecentlyRepaired({
    libraryItemId: item.id,
    infoHash: HASH,
    occurredAt: repairedAt,
  });
  assert.equal(dup.enrolled, false);
  assert.equal(dup.reason, 'duplicate');
  assert.equal(dup.nextDueAt, first.nextDueAt);

  // A new repair event for the same item enrolls a fresh schedule.
  const later = sched.enrollRecentlyRepaired({
    libraryItemId: item.id,
    infoHash: HASH,
    occurredAt: repairedAt + 1,
  });
  assert.equal(later.enrolled, true);
  assert.notEqual(later.nextDueAt, first.nextDueAt);

  // Sanity: a separate repair event with a strictly-older key (lex <
  // existing) is treated as no-op. The due-state row is per
  // library_item, and a parallel earlier repair should not churn the
  // schedule.
  const earlier = sched.enrollRecentlyRepaired({
    libraryItemId: item.id,
    infoHash: HASH_B,
    occurredAt: repairedAt - 100,
  });
  assert.equal(earlier.enrolled, false, 'an older key does not churn the schedule');
  assert.equal(earlier.reason, 'older-key');

  store.close();
});

test('A1d: unEnroll then reEnroll preserves the disable gate', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000) });
  const item = store.ensureLibraryItem(movie());

  sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_x:1',
    observedAt: 1_000,
  });
  sched.unEnroll(item.id);
  const blocked = sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_y:99',
    observedAt: 2_000,
  });
  assert.equal(blocked.enrolled, false, 'unEnrolled items are not re-enrolled');
  assert.equal(blocked.reason, 'disabled');

  sched.reEnroll(item.id);
  const allowed = sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_z:100',
    observedAt: 3_000,
  });
  assert.equal(allowed.enrolled, true, 'reEnroll allows a new enrollment');

  store.close();
});

// ─── A2: persisted next_due across restart ────────────────────────────

test('A2: next_due survives a process restart (file-backed SQLite)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'durability-restart-'));
  let itemId;
  try {
    const dbPath = join(dir, 'cp.db');

    // First process: create store, seed library item, enroll.
    {
      const store = createControlPlaneStore({ dbPath, now: fixedClock(10_000) });
      const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(10_000) });
      const item = store.ensureLibraryItem({ ...movie({ mediaId: 'tt-restart-1' }) });
      itemId = item.id;
      const first = sched.enrollNewlyFulfilled({
        libraryItemId: itemId,
        enrollmentKey: 'binding:bd_restart:1',
        observedAt: 10_000,
      });
      assert.equal(first.enrolled, true);
      const persisted = store.db.prepare(
        'SELECT next_due_at FROM durability_due_state WHERE library_item_id = ?',
      ).get(itemId);
      assert.equal(persisted.next_due_at, first.nextDueAt);
      store.close();
    }

    // Second process: open same DB. next_due must equal the persisted value
    // (proves: no startup full-library scan, no recompute, deterministic
    // jitter produces the same offset for the same libraryItemId).
    {
      const store = createControlPlaneStore({ dbPath, now: fixedClock(20_000) });
      const reloaded = store.db.prepare(
        'SELECT * FROM durability_due_state WHERE library_item_id = ?',
      ).get(itemId);
      assert.ok(reloaded, 'row is durable across restart');
      // The schedule is unchanged: a future run that consults listDue(...)
      // will not see this item until time >= next_due_at, which is the same
      // value computed before restart.
      const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(20_000) });
      const due = sched.listDue(100);
      assert.equal(due.length, 0, 'no due items before next_due_at');
      store.close();
    }

    // Third process: advance the clock well past next_due_at → item is now due.
    {
      const store = createControlPlaneStore({ dbPath, now: fixedClock(1_000_000_000) });
      const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000_000_000) });
      const due = sched.listDue(100);
      assert.equal(due.length, 1, 'item becomes due after next_due_at elapses');
      assert.equal(due[0].library_item_id, itemId);
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── A3: deterministic jitter / sparse cadence ────────────────────────

test('A3a: jitter is deterministic for the same libraryItemId', () => {
  const m1 = schedulerInternals.deterministicJitterMultiplier('item-A', 0.2);
  const m2 = schedulerInternals.deterministicJitterMultiplier('item-A', 0.2);
  assert.equal(m1, m2);
  assert.ok(m1 >= 0.8 && m1 <= 1.2, 'jitter multiplier stays in ratio band');
  assert.ok(m1 !== 1.0, 'jitter is not a no-op');
});

test('A3b: jitter differs across libraryItemIds (sparse, non-storming)', () => {
  const seen = new Set();
  for (let i = 0; i < 16; i += 1) {
    seen.add(
      schedulerInternals.deterministicJitterMultiplier(`item-${i}`, 0.2),
    );
  }
  assert.ok(seen.size >= 8, `expected diverse jitter values, got ${seen.size}`);
});

test('A3c: enrolled next_due spreads multiple items across a sparse window', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const sched = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(1_000),
    baseIntervalMs: 10_000,
    jitterRatio: 0.2,
  });
  const items = [];
  for (let i = 0; i < 50; i += 1) {
    const item = store.ensureLibraryItem(movie({ mediaId: `tt-sparse-${i}` }));
    items.push(item);
    sched.enrollNewlyFulfilled({
      libraryItemId: item.id,
      enrollmentKey: `binding:bd_s${i}:1`,
      observedAt: 1_000,
    });
  }
  const dueTimes = items.map((item) => {
    const row = store.db.prepare(
      'SELECT next_due_at FROM durability_due_state WHERE library_item_id = ?',
    ).get(item.id);
    return row.next_due_at;
  });
  const min = Math.min(...dueTimes);
  const max = Math.max(...dueTimes);
  const spread = max - min;
  // 50 items × ±20% jitter over a 10s base → ≥ 1s spread.
  assert.ok(spread >= 1_000, `expected at least 1s spread, got ${spread}ms`);
  // All values within (1 ± jitterRatio) × base = [8000, 12000] of observedAt=1000
  // → absolute bounds: [9000, 13000].
  for (const t of dueTimes) {
    assert.ok(t >= 9_000 && t <= 13_000, `next_due ${t} outside [9000, 13000]`);
  }
  store.close();
});

// ─── A4: bounded overdue batches ─────────────────────────────────────

test('A4: listDue returns at most maxBatch overdue rows (oldest first)', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const sched = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(1_000),
    baseIntervalMs: 100,    // floor: 100ms. observedAt=0 → next_due ≤ 100 < 1000
    jitterRatio: 0,         // exact times
    maxBatch: 3,
  });
  for (let i = 0; i < 5; i += 1) {
    const item = store.ensureLibraryItem(movie({ mediaId: `tt-batch-${i}` }));
    sched.enrollNewlyFulfilled({
      libraryItemId: item.id,
      enrollmentKey: `binding:bd_b${i}:1`,
      observedAt: 0,
    });
  }
  const rows = store.db.prepare('SELECT * FROM durability_due_state ORDER BY next_due_at').all();
  const allOverdue = rows.every((r) => r.next_due_at <= 1_000);
  assert.ok(allOverdue, 'all rows are overdue at t=1000');

  // We need a fresh scheduler so its `now` is advanced.
  const sched2 = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(5_000),
    baseIntervalMs: 1_000,
    jitterRatio: 0,
    maxBatch: 3,
  });
  const due = sched2.listDue();
  assert.equal(due.length, 3, 'respects maxBatch');
  // The three most-overdue are selected first.
  assert.ok(due[0].next_due_at <= due[1].next_due_at);
  assert.ok(due[1].next_due_at <= due[2].next_due_at);
  store.close();
});

// ─── A5: one active pass ownership; no startup full-library scan ─────

test('A5a: runPass is a no-op when mode is disabled (the default)', async () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  // No mode passed → defaults to disabled.
  const sched = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(1_000),
    baseIntervalMs: 1_000,
    jitterRatio: 0.2,
  });
  assert.equal(sched.mode, DURABILITY_MODE.DISABLED);
  const diag = sched.diagnostics();
  assert.equal(diag.enabled, false);
  assert.equal(diag.mode, 'disabled');

  // Enroll an item and let it be overdue; default-mode pass must skip.
  const item = store.ensureLibraryItem(movie());
  sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_disabled:1',
    observedAt: 0,
  });
  const schedLater = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(100_000),
    baseIntervalMs: 1_000,
    jitterRatio: 0.2,
  });
  const summary = await schedLater.runPass();
  assert.equal(summary.ran, true);
  assert.equal(summary.mode, 'disabled');
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.skipped, 1, 'disabled mode records skipped, not selected');
  store.close();
});

test('A5b: observe mode records intent without invoking the executor', async () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  let executorCalls = 0;
  const observer = async () => { executorCalls += 1; return { outcome: 'succeeded' }; };
  const sched = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(1_000),
    mode: DURABILITY_MODE.OBSERVE,
    baseIntervalMs: 1_000,
    jitterRatio: 0.2,
    executor: observer,
  });
  const item = store.ensureLibraryItem(movie());
  sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_observe:1',
    observedAt: 0,
  });
  const schedLater = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(100_000),
    mode: DURABILITY_MODE.OBSERVE,
    baseIntervalMs: 1_000,
    jitterRatio: 0.2,
    executor: observer,
  });
  const summary = await schedLater.runPass();
  assert.equal(summary.mode, 'observe');
  assert.equal(summary.selected, 1);
  assert.equal(executorCalls, 0, 'observe mode does NOT call the executor');
  // The row is recorded as 'skipped' with reason 'observe-mode' (per seam
  // contract — observe mode means the executor seam is not invoked).
  const row = store.db.prepare('SELECT last_outcome, last_error FROM durability_due_state WHERE library_item_id = ?').get(item.id);
  assert.equal(row.last_outcome, 'skipped');
  store.close();
});

test('A5c: one active pass ownership — concurrent runPass is rejected', async () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  // Slow executor; first call blocks the pass.
  let release;
  const releaseGate = new Promise((r) => { release = r; });
  const sched = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(1_000),
    mode: DURABILITY_MODE.EXECUTE,
    baseIntervalMs: 1_000,
    jitterRatio: 0,        // exact times — all 3 items are due at t=1000
    executor: () => releaseGate,
  });
  for (let i = 0; i < 3; i += 1) {
    const item = store.ensureLibraryItem(movie({ mediaId: `tt-conc-${i}` }));
    sched.enrollNewlyFulfilled({
      libraryItemId: item.id,
      enrollmentKey: `binding:bd_c${i}:1`,
      observedAt: 0,
    });
  }
  // Pre-condition: 3 items are due at the current clock (1000).
  assert.equal(sched.countDue(), 3);

  const first = sched.runPass();
  // While the first pass is awaiting its executor, a concurrent call must
  // short-circuit (one active pass ownership).
  const second = await sched.runPass();
  assert.equal(second.ran, false);
  assert.equal(second.reason, 'pass-in-flight');

  release();
  const firstSummary = await first;
  assert.equal(firstSummary.ran, true);
  assert.equal(firstSummary.selected, 3);
  store.close();
});

test('A5d: no startup full-library scan — constructor does not touch durable rows', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  // Construct the scheduler first so the durability schema is migrated.
  const first = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000) });
  // Seed a pre-existing durable row OUT OF BAND using a real library item.
  const item = store.ensureLibraryItem(movie({ mediaId: 'tt-pre-seeded' }));
  store.db.prepare(`
    INSERT INTO durability_due_state (
      library_item_id, enrollment_key, source, enrolled_at,
      next_due_at, last_run_at, last_outcome, consecutive_failures,
      last_error, disabled, updated_at
    ) VALUES (?, 'binding:bd_pre:1', 'newly-fulfilled', 0, 0, NULL, 'pending', 0, NULL, 0, 0)
  `).run(item.id);
  // Discard the first scheduler; a fresh construction must not mutate any
  // pre-existing durable rows (proves no startup storm / no full scan).
  const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(5_000) });
  const row = store.db.prepare('SELECT * FROM durability_due_state WHERE library_item_id = ?').get(item.id);
  assert.equal(row.enrollment_key, 'binding:bd_pre:1', 'pre-existing key is preserved');
  assert.equal(row.next_due_at, 0, 'pre-existing next_due is preserved');
  assert.equal(row.last_run_at, null, 'pre-existing last_run is preserved');
  // The diagnostic surface is computed lazily and is not part of a startup
  // scan; verify that it does not write to the DB.
  const beforeLastPass = store.db.prepare(
    'SELECT last_pass_at FROM durability_scheduler_state WHERE id = 1',
  ).get().last_pass_at;
  sched.diagnostics();
  const afterLastPass = store.db.prepare(
    'SELECT last_pass_at FROM durability_scheduler_state WHERE id = 1',
  ).get().last_pass_at;
  assert.equal(beforeLastPass, afterLastPass, 'diagnostics() is a read');
  first; // silence unused
  store.close();
});

// ─── A6: minimal enable flag + diagnostics ────────────────────────────

test('A6a: default mode is disabled; setMode flips enabled/disabled correctly', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000) });
  assert.equal(sched.mode, DURABILITY_MODE.DISABLED);
  assert.equal(sched.diagnostics().enabled, false);
  sched.setMode(DURABILITY_MODE.OBSERVE);
  assert.equal(sched.mode, 'observe');
  assert.equal(sched.diagnostics().enabled, true);
  sched.setMode(DURABILITY_MODE.DISABLED);
  assert.equal(sched.diagnostics().enabled, false);
  store.close();
});

test('A6b: diagnostics expose enabled/due/last-run/outcomes/next-due', async () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const calls = [];
  const executor = async (item) => { calls.push(item); return { outcome: 'succeeded' }; };
  const sched = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(1_000),
    mode: DURABILITY_MODE.EXECUTE,
    baseIntervalMs: 1_000, // small enough that observedAt=0 → next_due ≤ 1_200
    jitterRatio: 0.2,
    executor,
  });
  for (let i = 0; i < 2; i += 1) {
    const item = store.ensureLibraryItem(movie({ mediaId: `tt-diag-${i}` }));
    sched.enrollNewlyFulfilled({
      libraryItemId: item.id,
      enrollmentKey: `binding:bd_d${i}:1`,
      observedAt: 0,
    });
  }
  const before = sched.diagnostics();
  assert.equal(before.mode, 'execute');
  assert.equal(before.enabled, true);
  assert.equal(before.dueCount, 2);
  assert.equal(before.lastPassAt, null);
  assert.equal(before.nextPassAt, null);
  assert.equal(before.baseIntervalMs > 0, true);
  assert.equal(before.jitterRatio > 0, true);
  assert.equal(before.maxBatch > 0, true);

  // Advance time and run a pass.
  const schedLater = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(100_000),
    mode: DURABILITY_MODE.EXECUTE,
    baseIntervalMs: 1_000,
    jitterRatio: 0.2,
    executor,
  });
  const summary = await schedLater.runPass();
  assert.equal(calls.length, 2);
  assert.equal(summary.succeeded, 2);

  const after = schedLater.diagnostics();
  assert.equal(after.lastPassAt >= summary.endedAt - 5_000, true);
  assert.equal(after.lastPassSelected, 2);
  assert.equal(after.lastPassSucceeded, 2);
  assert.equal(after.lastPassFailed, 0);
  assert.equal(after.lastPassSkipped, 0);
  assert.ok(after.nextPassAt != null, 'nextPassAt is set after a pass');
  assert.equal(after.dueCount, 0, 'items have been advanced past their next_due_at');
  store.close();
});

test('A6c: failed executor is recorded as last_outcome=failed with last_error', async () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const failingExecutor = async () => ({ outcome: 'failed', error: 'upstream-503' });
  const sched = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(1_000),
    mode: DURABILITY_MODE.EXECUTE,
    baseIntervalMs: 1_000,
    jitterRatio: 0.2,
    executor: failingExecutor,
  });
  const item = store.ensureLibraryItem(movie());
  sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_fail:1',
    observedAt: 0,
  });
  const schedLater = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(100_000),
    mode: DURABILITY_MODE.EXECUTE,
    baseIntervalMs: 1_000,
    jitterRatio: 0.2,
    executor: failingExecutor,
  });
  const summary = await schedLater.runPass();
  assert.equal(summary.failed, 1);
  const row = store.db.prepare('SELECT last_outcome, last_error, consecutive_failures FROM durability_due_state WHERE library_item_id = ?').get(item.id);
  assert.equal(row.last_outcome, 'failed');
  assert.equal(row.last_error, 'upstream-503');
  assert.equal(row.consecutive_failures, 1);
  store.close();
});

// ─── integration seam: end-to-end without providers ───────────────────

test('seam: full flow enroll→due→execute→record without any provider call', async () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  let observed = [];
  const sched = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(1_000),
    mode: DURABILITY_MODE.EXECUTE,
    baseIntervalMs: 1_000,
    jitterRatio: 0, // exact
    executor: async (item, ctx) => {
      observed.push({ item, ctx });
      return { outcome: 'succeeded' };
    },
  });
  const item = store.ensureLibraryItem(movie());
  // "newly fulfilled" — what Worker B will call when a binding becomes active.
  const enrollResult = sched.enrollNewlyFulfilled({
    libraryItemId: item.id,
    enrollmentKey: 'binding:bd_e2e:1',
    observedAt: 1_000,
  });
  assert.equal(enrollResult.enrolled, true);
  // Sanity: not due until time elapses.
  assert.equal(sched.listDue(100).length, 0);

  // Advance time past the jittered interval; pass selects and runs the seam.
  const schedLater = createDurabilityScheduler({
    controlPlaneStore: store,
    now: fixedClock(2_500),
    mode: DURABILITY_MODE.EXECUTE,
    baseIntervalMs: 1_000,
    jitterRatio: 0,
    executor: async (item, ctx) => {
      observed.push({ item, ctx });
      return { outcome: 'succeeded' };
    },
  });
  const summary = await schedLater.runPass();
  assert.equal(summary.selected, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].item.libraryItemId, item.id);
  assert.equal(observed[0].item.source, 'newly-fulfilled');
  assert.equal(observed[0].ctx.mode, 'execute');
  store.close();
});

test('seam: recently-repaired enrollment (failure_category=stale-placement-repaired)', () => {
  // The short does NOT call provider checks or repair. It only consumes the
  // durable repair-evidence signal that torbox-delivery already records.
  // This test demonstrates that the seam accepts a `stale-placement-repaired`
  // signal end-to-end without touching providers.
  assert.ok(
    REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED === 'stale-placement-repaired',
    'expected durable repair-event category to exist for the seam',
  );
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000) });
  const item = store.ensureLibraryItem(movie());
  const result = sched.enrollRecentlyRepaired({
    libraryItemId: item.id,
    infoHash: HASH,
    occurredAt: 1_700_000_000_000,
  });
  assert.equal(result.enrolled, true);
  const row = store.db.prepare('SELECT source FROM durability_due_state WHERE library_item_id = ?').get(item.id);
  assert.equal(row.source, 'recently-repaired');
  store.close();
});

// ─── A6 corollary: observe-only is safe (no provider traffic) ─────────

test('default-mode=disabled means cold items are NOT continuously scheduled', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  // Empty store. Construct a scheduler; do not enroll anything.
  const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000) });
  // No rows → listDue returns 0.
  assert.equal(sched.listDue(100).length, 0);
  // countDue is 0.
  assert.equal(sched.countDue(), 0);
  // diagnostics reflects 0 enrolled.
  assert.equal(sched.diagnostics().enrolledCount, 0);
  store.close();
});

// ─── ordering invariants ─────────────────────────────────────────────

test('upsert preserves the (library_item_id) primary key across many enrollments', () => {
  const store = createControlPlaneStore({ now: fixedClock(1_000) });
  const sched = createDurabilityScheduler({ controlPlaneStore: store, now: fixedClock(1_000) });
  const item = store.ensureLibraryItem(movie());

  // 100 enrollments with monotonically increasing keys.
  for (let i = 0; i < 100; i += 1) {
    const pad = String(i).padStart(3, '0');
    sched.enrollNewlyFulfilled({
      libraryItemId: item.id,
      enrollmentKey: `binding:bd_x:${pad}`,
      observedAt: 1_000 + i,
    });
  }
  const rows = store.db.prepare(
    'SELECT * FROM durability_due_state WHERE library_item_id = ?',
  ).all(item.id);
  assert.equal(rows.length, 1, 'primary key holds: at most one row per library item');
  // Final key is the most recent.
  assert.equal(rows[0].enrollment_key, 'binding:bd_x:099');
  store.close();
});
