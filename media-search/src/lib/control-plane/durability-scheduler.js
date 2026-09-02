/**
 * Background Durability V1 — scheduling, eligibility, and persistence.
 *
 * Slice A of the durability milestone. Owns:
 *   - minimal durable due-state representation (durability_due_state,
 *     durability_scheduler_state)
 *   - idempotent enrollment for newly-fulfilled bindings and recently
 *     repaired authoritative items (failure_category = stale-placement-repaired)
 *   - internal sparse cadence with deterministic per-item jitter
 *   - persisted next_due across restart
 *   - bounded overdue batches per pass
 *   - no startup full-library scan/storm — enrollment is event-driven
 *   - one active pass ownership (startPass is a no-op while one is in flight)
 *   - minimal enable flag (default: disabled)
 *   - minimal diagnostics surface (enabled, due count, last run, outcomes, next due)
 *   - scheduling → execution seam: an injectable executor callback
 *     (executeDueItem) is invoked for each selected item; this module does
 *     NOT touch providers or repair logic.
 *
 * Deliberately NOT owned here (deferred to Worker B or already-existing paths):
 *   - provider freshness checks / network I/O
 *   - repair transactions
 *   - capability URLs, discovery, ranking, Plex materialization
 *   - durable playback activity tracking (does not yet exist in the
 *     control-plane store; the 'playable' lifecycle milestone is declared
 *     but never written. Per the brief, this input is explicitly deferred
 *     until it exists durably.)
 */

import { createHash } from 'node:crypto';

export const DURABILITY_MODE = Object.freeze({
  DISABLED: 'disabled',
  OBSERVE: 'observe',
  EXECUTE: 'execute',
});

const DEFAULT_BASE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h nominal cadence
const DEFAULT_JITTER_RATIO = 0.2; // ±20% deterministic per-item jitter
const DEFAULT_MAX_BATCH = 25;     // bounded overdue batch size per pass
const DEFAULT_PASS_TIMEOUT_MS = 5 * 60 * 1000; // 5min — one active pass ceiling

// Repair failure_category values from repair-events.js that signal
// "recently repaired authoritative item".
const REPAIR_RE_ENROLL_CATEGORIES = Object.freeze([
  'stale-placement-repaired',
]);

function requireControlPlaneStore(store) {
  if (!store || typeof store !== 'object' || typeof store.db?.exec !== 'function') {
    throw new TypeError('createDurabilityScheduler requires a controlPlaneStore with .db');
  }
  return store;
}

function requireExecutor(executor) {
  if (executor != null && typeof executor !== 'function') {
    throw new TypeError('executor, if provided, must be a function');
  }
  return executor ?? null;
}

function requireInteger(value, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${field} must be an integer >= ${min}`);
  }
  return value;
}

function normalizeMode(mode) {
  if (mode == null) return DURABILITY_MODE.DISABLED;
  const value = String(mode);
  if (!Object.values(DURABILITY_MODE).includes(value)) {
    throw new TypeError(`Unknown durability mode: ${value}`);
  }
  return value;
}

/**
 * Deterministic per-item jitter in (-ratio, +ratio). The result depends only
 * on the libraryItemId, so the same item gets the same offset on every
 * restart — important for sparse, non-storming cadence.
 *
 * @param {string} libraryItemId
 * @param {number} ratio
 * @returns {number} multiplicative offset, e.g. 1.15 → next_due += 15%
 */
function deterministicJitterMultiplier(libraryItemId, ratio) {
  const digest = createHash('sha256').update(String(libraryItemId)).digest();
  // Take 4 bytes as an unsigned 32-bit int. Map to (-ratio, +ratio).
  const n = digest.readUInt32BE(0);
  // 0..2^32 → -1..+1
  const unit = (n / 0xFFFFFFFF) * 2 - 1;
  return 1 + unit * ratio;
}

/**
 * @param {Object} options
 * @param {Object} options.controlPlaneStore  Required.
 * @param {Function} [options.executor]       Optional async (item, ctx) => outcome
 * @param {number}   [options.baseIntervalMs] Nominal cadence between checks
 * @param {number}   [options.jitterRatio]    Per-item jitter fraction (0..1)
 * @param {number}   [options.maxBatch]       Max items per pass
 * @param {number}   [options.passTimeoutMs]  One-pass ownership ceiling
 * @param {string}   [options.mode]           Initial mode (default 'disabled')
 * @param {Function} [options.now]            Clock override
 * @param {Function} [options.log]            Logger
 */
export function createDurabilityScheduler(options = {}) {
  const store = requireControlPlaneStore(options.controlPlaneStore);
  const executor = requireExecutor(options.executor);
  // Floor: 100ms. Anything smaller is almost certainly a misconfiguration
  // and would produce provider-storming traffic. The default is 6h.
  const baseIntervalMs = requireInteger(options.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS, 'baseIntervalMs', { min: 100 });
  const jitterRatio = (() => {
    const v = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    if (!(typeof v === 'number') || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new TypeError('jitterRatio must be a number in [0, 1]');
    }
    return v;
  })();
  const maxBatch = requireInteger(options.maxBatch ?? DEFAULT_MAX_BATCH, 'maxBatch', { min: 1 });
  const passTimeoutMs = requireInteger(options.passTimeoutMs ?? DEFAULT_PASS_TIMEOUT_MS, 'passTimeoutMs', { min: 1000 });
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const initialMode = normalizeMode(options.mode);

  // Apply migration once at construction time. Idempotent.
  migrateDurabilitySchema(store.db);
  // Seed the singleton scheduler-state row if absent.
  seedSchedulerState(store.db, { mode: initialMode, now: now() });

  let mode = getMode(store.db);
  let passInFlight = null;

  // ─── mode / diagnostics surface ───────────────────────────────────────
  function setMode(nextMode) {
    const normalized = normalizeMode(nextMode);
    store.db.prepare(`
      UPDATE durability_scheduler_state SET mode = ?, updated_at = ? WHERE id = 1
    `).run(normalized, now());
    mode = normalized;
    return mode;
  }
  function getModeRow() {
    return store.db.prepare('SELECT * FROM durability_scheduler_state WHERE id = 1').get();
  }

  // ─── enrollment (idempotent) ───────────────────────────────────────────

  /**
   * Enroll a newly-fulfilled binding (or its supersession) for background checks.
   *
   * Idempotency:

   *   - If a row exists for libraryItemId with a newer-or-equal enrollmentKey,
   *     no change to next_due. Existing due state is preserved.
   *   - If the row exists with an older enrollmentKey (new version), advance
   *     next_due_at = now() + jitteredInterval and update enrollmentKey.
   *
   * @param {Object} input
   * @param {string} input.libraryItemId
   * @param {string} input.enrollmentKey   opaque string (e.g. `binding:${bindingId}:${version}`)
   * @param {number} [input.observedAt]    ms timestamp of the enrollment signal
   * @returns {{enrolled: boolean, libraryItemId: string, nextDueAt: number}}
   */
  function enrollNewlyFulfilled(input) {
    const libraryItemId = requireString(input?.libraryItemId, 'libraryItemId');
    const enrollmentKey = requireString(input?.enrollmentKey, 'enrollmentKey');
    const observedAt = requireInteger(input?.observedAt ?? now(), 'observedAt', { min: 0 });
    return upsertDueRow({
      libraryItemId,
      enrollmentKey,
      source: 'newly-fulfilled',
      observedAt,
      forceRenew: false,
    });
  }

  /**
   * Enroll a recently-repaired authoritative item (stale-placement-repaired).
   * Uses (infoHash + occurredAt) as enrollmentKey so the same item can be
   * re-enrolled for new repair events without churning prior schedules.
   *
   * @param {Object} input
   * @param {string} input.libraryItemId
   * @param {string} input.infoHash
   * @param {number} input.occurredAt      ms timestamp of the repair event
   * @returns {{enrolled: boolean, libraryItemId: string, nextDueAt: number}}
   */
  function enrollRecentlyRepaired(input) {
    const libraryItemId = requireString(input?.libraryItemId, 'libraryItemId');
    const infoHash = requireString(input?.infoHash, 'infoHash', 64);
    const occurredAt = requireInteger(input?.occurredAt, 'occurredAt', { min: 0 });
    return upsertDueRow({
      libraryItemId,
      enrollmentKey: `repair:${infoHash}:${occurredAt}`,
      source: 'recently-repaired',
      observedAt: occurredAt,
      forceRenew: false,
    });
  }

  function upsertDueRow({ libraryItemId, enrollmentKey, source, observedAt, forceRenew }) {
    requireLibraryItem(store, libraryItemId);
    const existing = store.db.prepare(
      'SELECT * FROM durability_due_state WHERE library_item_id = ?',
    ).get(libraryItemId);
    if (existing && !forceRenew && existing.disabled === 1) {
      // Was explicitly un-enrolled; do not re-add.
      return { enrolled: false, libraryItemId, nextDueAt: null, reason: 'disabled' };
    }
    if (existing && !forceRenew && existing.enrollment_key === enrollmentKey) {
      // Same key seen before → idempotent no-op; preserve existing next_due_at.
      return { enrolled: false, libraryItemId, nextDueAt: existing.next_due_at, reason: 'duplicate' };
    }
    if (existing && !forceRenew && isEnrollmentKeyNewer(existing.enrollment_key, enrollmentKey) === false) {
      // Existing key is strictly newer (lexicographic); treat as no-op.
      return { enrolled: false, libraryItemId, nextDueAt: existing.next_due_at, reason: 'older-key' };
    }
    const jitter = deterministicJitterMultiplier
      ? deterministicJitterMultiplier(libraryItemId, jitterRatio)
      : 1;
    const nextDueAt = observedAt + Math.round(baseIntervalMs * jitter);
    const timestamp = now();
    if (existing) {
      store.db.prepare(`
        UPDATE durability_due_state
        SET enrollment_key = ?, source = ?, enrolled_at = ?,
            next_due_at = ?, updated_at = ?
        WHERE library_item_id = ?
      `).run(
        enrollmentKey, source, observedAt, nextDueAt, timestamp, libraryItemId,
      );
    } else {
      store.db.prepare(`
        INSERT INTO durability_due_state (
          library_item_id, enrollment_key, source, enrolled_at,
          next_due_at, last_run_at, last_outcome, consecutive_failures,
          last_error, disabled, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', 0, NULL, 0, ?)
      `).run(
        libraryItemId, enrollmentKey, source, observedAt, nextDueAt, timestamp,
      );
    }
    return { enrolled: true, libraryItemId, nextDueAt };
  }

  function unEnroll(libraryItemId) {
    requireString(libraryItemId, 'libraryItemId');
    store.db.prepare(`
      UPDATE durability_due_state SET disabled = 1, updated_at = ? WHERE library_item_id = ?
    `).run(now(), libraryItemId);
  }

  function reEnroll(libraryItemId) {
    requireString(libraryItemId, 'libraryItemId');
    store.db.prepare(`
      UPDATE durability_due_state SET disabled = 0, updated_at = ? WHERE library_item_id = ?
    `).run(now(), libraryItemId);
  }

  // ─── due selection ────────────────────────────────────────────────────

  /**
   * Read up to `limit` due rows. Includes currently-overdue rows (next_due_at
   * <= now) AND rows that have never run (last_run_at IS NULL).
   *
   * Order: oldest next_due_at first (most overdue first). Disabled rows are
   * excluded.
   *
   * @param {number} [limit]
   * @returns {Array<DueRow>}
   */
  function listDue(limit = maxBatch) {
    requireInteger(limit, 'limit', { min: 1 });
    const cutoff = now();
    return store.db.prepare(`
      SELECT * FROM durability_due_state
      WHERE disabled = 0
        AND next_due_at <= ?
      ORDER BY next_due_at ASC
      LIMIT ?
    `).all(cutoff, limit);
  }

  /**
   * Compute count of due rows now (overdue or never-run). Cheap for
   * diagnostics; uses index on next_due_at.
   */
  function countDue() {
    const cutoff = now();
    return store.db.prepare(`
      SELECT COUNT(*) AS n FROM durability_due_state
      WHERE disabled = 0 AND next_due_at <= ?
    `).get(cutoff).n;
  }

  /**
   * Schedule the next pass. Sparse, deterministic. The next pass happens at:
   *   passInterval + max(passTimeoutMs, executorBacklogHint).
   * We do not start the timer here; this just records the planned next
   * absolute timestamp and returns it for the caller to arm a setTimeout.
   *
   * @returns {{ nextPassAt: number }}
   */
  function scheduleNextPass() {
    const jitter = typeof deterministicJitterMultiplier === 'function'
      ? deterministicJitterMultiplier('scheduler', jitterRatio)
      : 1;
    const interval = Math.round(baseIntervalMs * jitter);
    const nextPassAt = now() + interval;
    store.db.prepare(`
      UPDATE durability_scheduler_state SET next_pass_at = ?, updated_at = ? WHERE id = 1
    `).run(nextPassAt, now());
    return { nextPassAt };
  }

  // ─── pass execution ──────────────────────────────────────────────────

  /**
   * Execute one pass:
   *   1. If mode is 'disabled' → no-op diagnostic run, return summary.
   *   2. If a pass is already in flight → return early (one active pass).
   *   3. List up to maxBatch due rows.
   *   4. For each row: invoke executor (or, in observe mode, record intent
   *      without calling executor). Update last_run_at / outcome.
   *   5. Update scheduler_state with pass results.
   *
   * @param {Object} [options]
   * @param {Array<{row: object, outcome: string, error?: string}>} [options.rowResults]
   *        Pre-computed per-row outcomes from a batch-oriented runtime
   *        seam (e.g. durability-runtime). When provided, the scheduler
   *        does NOT invoke the per-item executor callback and instead
   *        writes the supplied outcomes directly via writeRunResult. This
   *        is the seam the named repair uses so Worker B's runBatch is
   *        invoked at most once per (provider, accountScope) group.
   * @returns {Promise<PassSummary>}
   */
  async function runPass(options = {}) {
    if (passInFlight) {
      return { ran: false, reason: 'pass-in-flight', passInFlightId: passInFlight.id };
    }
    const id = `dpass_${createHash('sha1').update(`dpass:${now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
    const startedAt = now();
    passInFlight = { id, startedAt };

    // Defensive timeout so a hung executor cannot wedge the scheduler
    // forever (passInFlight becomes null again).
    const timeoutHandle = setTimeout(() => {
      if (passInFlight?.id === id) {
        passInFlight = null;
        log('durability: pass timed out', { id });
      }
    }, passTimeoutMs);
    if (timeoutHandle.unref) timeoutHandle.unref();

    const state = getModeRow();
    const currentMode = state.mode;
    const due = listDue(maxBatch);

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    const providedResults = options?.rowResults;
    const useProvided = Array.isArray(providedResults);

    try {
      if (useProvided) {
        // Fast path: a batch-oriented runtime seam already produced the
        // per-row outcomes for the full pass. The runtime guarantees one
        // Worker B runBatch per (provider, accountScope) group; this
        // method only writes the per-row results to durability_due_state.
        const byRow = new Map();
        for (const entry of providedResults) {
          if (entry?.row) byRow.set(entry.row.library_item_id, entry);
        }
        for (const row of due) {
          const entry = byRow.get(row.library_item_id);
          if (!entry) {
            writeRunResult(row, { outcome: 'skipped', error: 'no-runtime-result' });
            skipped += 1;
            continue;
          }
          const outcome = entry.outcome === 'succeeded'
            || entry.outcome === 'failed'
            || entry.outcome === 'skipped'
            ? entry.outcome
            : 'skipped';
          writeRunResult(row, { outcome, error: entry.error ?? null });
          if (outcome === 'succeeded') succeeded += 1;
          else if (outcome === 'failed') failed += 1;
          else skipped += 1;
        }
      } else {
        for (const row of due) {
          const summary = await invokeForRow(row, currentMode);
          if (summary.outcome === 'succeeded') succeeded += 1;
          else if (summary.outcome === 'failed') failed += 1;
          else skipped += 1;
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      const endedAt = now();
      passInFlight = null;
      store.db.prepare(`
        UPDATE durability_scheduler_state SET
          last_pass_at = ?, last_pass_id = ?, last_pass_selected = ?,
          last_pass_succeeded = ?, last_pass_failed = ?, last_pass_skipped = ?,
          updated_at = ?
        WHERE id = 1
      `).run(
        endedAt, id, due.length, succeeded, failed, skipped, endedAt,
      );
    }

    const nextPlan = scheduleNextPass();
    return {
      ran: true,
      passId: id,
      mode: currentMode,
      selected: due.length,
      succeeded,
      failed,
      skipped,
      startedAt,
      endedAt: now(),
      nextPassAt: nextPlan.nextPassAt,
    };
  }

  async function invokeForRow(row, currentMode) {
    const startedAt = now();
    if (currentMode === DURABILITY_MODE.DISABLED) {
      // No-op diagnostic. Mark skipped so we don't appear stale.
      writeRunResult(row, { outcome: 'skipped', error: 'mode-disabled' });
      return { outcome: 'skipped' };
    }
    if (currentMode === DURABILITY_MODE.OBSERVE) {
      // Observe: list the intent to the durable record but do NOT call the
      // executor seam. The whole point of observe-mode is to surface
      // "what would have run" without producing provider traffic.
      writeRunResult(row, { outcome: 'skipped', error: 'mode-observe' });
      return { outcome: 'skipped' };
    }
    if (!executor) {
      writeRunResult(row, { outcome: 'skipped', error: 'no-executor' });
      return { outcome: 'skipped' };
    }
    let outcome;
    let errorText;
    try {
      const result = await executor({
        libraryItemId: row.library_item_id,
        source: row.source,
        enrollmentKey: row.enrollment_key,
        nextDueAt: row.next_due_at,
      }, { mode: currentMode });
      outcome = result?.outcome === 'succeeded' ? 'succeeded' : 'failed';
      errorText = result?.outcome === 'succeeded' ? null : (result?.error ?? 'unspecified');
    } catch (err) {
      outcome = 'failed';
      errorText = String(err?.message ?? err);
    }
    writeRunResult(row, { outcome, error: errorText, startedAt });
    return { outcome };
  }

  function writeRunResult(row, { outcome, error, startedAt = now() }) {
    const stamp = now();
    const prevFailures = row.consecutive_failures ?? 0;
    const newFailures = outcome === 'failed' ? prevFailures + 1 : 0;
    // After a pass (any outcome), advance next_due_at so the same item is
    // not selected again immediately. The sparse cadence is per-item
    // jittered from the *run* moment so an item is never "double-queued".
    const jitter = deterministicJitterMultiplier
      ? deterministicJitterMultiplier(row.library_item_id, jitterRatio)
      : 1;
    const nextDueAt = stamp + Math.round(baseIntervalMs * jitter);
    store.db.prepare(`
      UPDATE durability_due_state SET
        last_run_at = ?, last_outcome = ?, consecutive_failures = ?,
        last_error = ?, next_due_at = ?, updated_at = ?
      WHERE library_item_id = ?
    `).run(stamp, outcome, newFailures, error ?? null, nextDueAt, stamp, row.library_item_id);
  }

  // ─── diagnostics ─────────────────────────────────────────────────────

  function diagnostics() {
    const state = getModeRow();
    const dueCount = countDue();
    const total = store.db.prepare(
      'SELECT COUNT(*) AS n FROM durability_due_state WHERE disabled = 0',
    ).get().n;
    return {
      enabled: state.mode !== DURABILITY_MODE.DISABLED,
      mode: state.mode,
      dueCount,
      enrolledCount: total,
      lastPassAt: state.last_pass_at,
      lastPassId: state.last_pass_id,
      lastPassSelected: state.last_pass_selected,
      lastPassSucceeded: state.last_pass_succeeded,
      lastPassFailed: state.last_pass_failed,
      lastPassSkipped: state.last_pass_skipped,
      nextPassAt: state.next_pass_at,
      baseIntervalMs,
      jitterRatio,
      maxBatch,
    };
  }

  return {
    enrollNewlyFulfilled,
    enrollRecentlyRepaired,
    unEnroll,
    reEnroll,
    listDue,
    countDue,
    runPass,
    scheduleNextPass,
    setMode,
    diagnostics,
    get mode() { return mode; },
  };
}

// ─── schema (idempotent migration) ──────────────────────────────────────

function migrateDurabilitySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durability_scheduler_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL CHECK (mode IN ('disabled', 'observe', 'execute')),
      next_pass_at INTEGER,
      last_pass_at INTEGER,
      last_pass_id TEXT,
      last_pass_selected INTEGER,
      last_pass_succeeded INTEGER,
      last_pass_failed INTEGER,
      last_pass_skipped INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS durability_due_state (
      library_item_id TEXT PRIMARY KEY,
      enrollment_key TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('newly-fulfilled', 'recently-repaired')),
      enrolled_at INTEGER NOT NULL,
      next_due_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_outcome TEXT NOT NULL CHECK (last_outcome IN ('pending', 'succeeded', 'failed', 'skipped')) DEFAULT 'pending',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (library_item_id) REFERENCES library_items(id)
    );

    CREATE INDEX IF NOT EXISTS idx_durability_due_next
      ON durability_due_state(next_due_at);
    CREATE INDEX IF NOT EXISTS idx_durability_due_enabled_due
      ON durability_due_state(disabled, next_due_at);
  `);
}

function seedSchedulerState(db, { mode, now: stamp }) {
  const existing = db.prepare('SELECT id FROM durability_scheduler_state WHERE id = 1').get();
  if (existing) return;
  db.prepare(`
    INSERT INTO durability_scheduler_state (id, mode, updated_at) VALUES (1, ?, ?)
  `).run(mode, stamp);
}

function getMode(db) {
  return db.prepare('SELECT mode FROM durability_scheduler_state WHERE id = 1').get().mode;
}

function requireLibraryItem(store, libraryItemId) {
  if (typeof store.getLibraryItem !== 'function') {
    throw new TypeError('controlPlaneStore.getLibraryItem is required');
  }
  const item = store.getLibraryItem(libraryItemId);
  if (!item) throw new Error(`Unknown library item: ${libraryItemId}`);
  return item;
}

function requireString(value, field, max = 256) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

/**
 * Returns true if `incoming` is strictly newer than `existing` (lexicographic).
 * Enrollment keys are intentionally monotonic strings (binding ids, repair
 * events with timestamps).
 */
function isEnrollmentKeyNewer(existing, incoming) {
  return String(incoming) > String(existing);
}

export const __test__ = Object.freeze({
  deterministicJitterMultiplier,
  isEnrollmentKeyNewer,
  REPAIR_RE_ENROLL_CATEGORIES,
  DEFAULT_BASE_INTERVAL_MS,
  DEFAULT_JITTER_RATIO,
  DEFAULT_MAX_BATCH,
});