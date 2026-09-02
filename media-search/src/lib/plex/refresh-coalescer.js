/**
 * Plex Refresh Coalescer
 *
 * Process-local keyed debouncer for Plex partial-refresh requests.
 *
 * Why: a TV season fan-out (or any rapid burst of related publications)
 * may schedule N notifyPlex() calls in the same event-loop tick window.
 * Each child episode maps to the same logical parent directory:
 *
 *   <PLEX_TV_ROOT>/<Show Name> (year)/Season NN
 *
 * Sending N HTTP partial-refresh calls for that single directory:
 *  - wastes provider round-trips
 *  - can stampede Plex's scanner
 *  - may even trigger a deeper than intended re-scan
 *
 * This coalescer holds a short, bounded timer per (collection, scanPath)
 * key. New requests within the window reset the timer; once the window
 * elapses, a single targeted refresh is dispatched. The window is short
 * (~750ms by default) so the user-visible refresh latency does not
 * regress meaningfully.
 *
 * Fan-out lifecycle: a season fan-out calls notifyPlex() once per
 * child episode, but the per-child work (provider round-trip, hydrate,
 * VFS materialization) takes seconds — much longer than the debounce
 * window. The naive debounce treats each call as an independent burst
 * and emits one targeted refresh per child. To express the fan-out
 * lifecycle explicitly, callers can open a fanOutScope(mediaId) before
 * fanning out and close it after the last child. While the scope is
 * open, schedule() calls for that mediaId are held in a scope-bucket
 * keyed by (collection, scanPath); on close() the scope dispatches one
 * targeted refresh per non-empty bucket (instead of one per call).
 * Schedules for other mediaIds continue to use the normal debounce.
 *
 * Hard policy:
 *  - Key is (collection, scanPath) — different libraries / different
 *    paths NEVER coalesce with each other.
 *  - Failure / timeout / HTTP error NEVER escalates to a full-section
 *    scan. A failed targeted refresh is reported and forgotten; the
 *    operator can rescan explicitly via the existing operator tooling.
 *  - The Plex token is never logged.
 *  - No persistent queue, no Redis, no IPC. Process-local only.
 *
 * Accounting surface:
 *  - getAccount() returns the current counter snapshot, useful for
 *    tests and the /api/metrics scrape. The metrics module also
 *    mirrors these into its pipeline counters for the live endpoint.
 *
 * The dispatch function is supplied by the caller. The coalescer is
 * deliberately framework-free: it does not import node-fetch, does not
 * read process.env, and does not know about Plex. The caller wires
 * the actual HTTP refresh.
 */

const DEFAULT_WINDOW_MS = 750;
const MIN_WINDOW_MS = 50;
const MAX_WINDOW_MS = 5_000;

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function clampWindow(value) {
  const n = Number.isFinite(value) ? Math.trunc(value) : DEFAULT_WINDOW_MS;
  if (n < MIN_WINDOW_MS) return MIN_WINDOW_MS;
  if (n > MAX_WINDOW_MS) return MAX_WINDOW_MS;
  return n;
}

/**
 * Compute the stable debounce key. Different sections, different
 * collection roots, or different scan paths MUST produce different
 * keys or the contract is violated.
 */
export function refreshKey({ sectionId, scanPath, collection }) {
  const sid = safeString(sectionId);
  const path = safeString(scanPath);
  const col = safeString(collection);
  if (!sid || !path) return null;
  return `${col || '?'}::${sid}::${path}`;
}

/**
 * Build a coalescer.
 *
 * Options:
 *   - windowMs:    debounce window per key (clamped to [50, 5000] ms)
 *   - dispatch:    function called exactly once per coalesced batch.
 *                  Receives the merged args and returns either a
 *                  value or a Promise. The return value is the
 *                  refresh result; truthy `ok: true` means success.
 *                  If omitted, the coalescer still schedules timers
 *                  and tracks accounting, and the dispatch is a
 *                  no-op (returns { ok: true }). Tests use this.
 *   - clock:       { now(), setTimeout, clearTimeout } (injectable)
 *   - logger:      optional logger (default = no-op)
 *   - onAccount:   optional callback fired after each counter change
 */
export function createRefreshCoalescer({
  windowMs = DEFAULT_WINDOW_MS,
  dispatch = null,
  clock,
  logger = null,
  onAccount,
} = {}) {
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs)) {
    throw new TypeError('windowMs must be a finite number');
  }
  if (dispatch != null && typeof dispatch !== 'function') {
    throw new TypeError('dispatch must be a function or null');
  }
  if (clock != null) {
    if (typeof clock.now !== 'function' || typeof clock.setTimeout !== 'function'
      || typeof clock.clearTimeout !== 'function') {
      throw new TypeError('clock must provide now/setTimeout/clearTimeout');
    }
  }
  const now = clock?.now ?? (() => Date.now());
  const setTimer = clock?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = clock?.clearTimeout ?? ((t) => clearTimeout(t));
  const window = clampWindow(windowMs);

  const log = (level, message) => {
    try {
      logger?.[level]?.(message);
    } catch { /* ignore logger errors */ }
  };

  // Active entries per key. Each entry holds the most recent pending
  // request payload (so the dispatched refresh carries the latest
  // mediaId/mediaType for logging) and the list of awaiting resolvers.
  const pending = new Map();

  // Active fan-out scopes. A scope is opened by fanOutScope(mediaId)
  // and closed by scope.close(). While open, schedule() calls whose
  // mediaId matches the scope's mediaId are folded into the scope's
  // per-key bucket instead of starting a debounce timer. On close()
  // each non-empty bucket dispatches exactly one targeted refresh.
  // Schedules for non-matching mediaIds go through the normal path.
  const scopes = new Map(); // mediaId -> { buckets: Map<key, bucket> }

  // Counters — single source of truth for accounting.
  const account = {
    refresh_requested: 0,
    refresh_coalesced: 0,
    actual_refresh_sent: 0,
    full_section_refresh: 0,
    refresh_failed: 0,
    fan_out_scope_closed: 0,
    fan_out_bucket_dispatched: 0,
    fan_out_bucket_merged: 0,
  };

  function emitAccount() {
    if (typeof onAccount === 'function') {
      try { onAccount({ ...account, pending: pending.size }); } catch { /* ignore */ }
    }
  }

  async function runDispatch(entry) {
    const args = {
      sectionId: entry.sectionId,
      scanPath: entry.scanPath,
      collection: entry.collection,
      mediaId: entry.latest?.mediaId,
      mediaType: entry.latest?.mediaType,
      coalescedCount: entry.mediaIds?.size || 0,
    };
    if (typeof dispatch !== 'function') {
      // No dispatcher wired (test mode). Resolve as ok.
      return { ok: true, method: 'partial-refresh' };
    }
    try {
      const out = await dispatch(args);
      if (out && typeof out === 'object') return out;
      return { ok: out === true, method: 'partial-refresh' };
    } catch (err) {
      return { ok: false, method: 'partial-refresh', error: err?.message || 'dispatch-threw' };
    }
  }

  function fire(key) {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    clearTimer(entry.timer);
    entry.timer = null;
    account.actual_refresh_sent += 1;
    emitAccount();
    const startedAt = now();
    const finalize = (outcome) => {
      const ok = outcome?.ok === true;
      if (!ok) {
        account.refresh_failed += 1;
        emitAccount();
        const err = outcome?.error || 'unknown-error';
        log('error', `[Plex] partial-refresh failed section=${entry.sectionId} path=${entry.scanPath}: ${err}`);
      } else {
        log('log', `[Plex] partial-refresh ok section=${entry.sectionId} path=${entry.scanPath} merged=${entry.mediaIds?.size || 0}`);
      }
      const result = {
        ok,
        method: outcome?.method || 'partial-refresh',
        sectionId: entry.sectionId,
        scanPath: entry.scanPath,
        collection: entry.collection,
        mediaId: entry.latest?.mediaId,
        mediaType: entry.latest?.mediaType,
        coalescedCount: entry.mediaIds?.size || 0,
        startedAt,
        finishedAt: now(),
        error: ok ? null : (outcome?.error || 'unknown-error'),
      };
      for (const resolve of entry.resolvers) {
        try { resolve(result); } catch { /* ignore */ }
      }
    };
    runDispatch(entry).then(finalize, (err) => finalize({ ok: false, error: err?.message || 'dispatch-rejected' }));
  }

  /**
   * Schedule a refresh for (collection, sectionId, scanPath).
   *
   * If a request for the same key is already pending within the
   * debounce window, the awaiting resolver is folded into the
   * existing pending entry — the actual HTTP call is made exactly
   * once for the merged batch.
   *
   * Returns { coalesced: boolean, key, result: Promise<result> }.
   */
  function schedule({ sectionId, scanPath, collection, mediaId, mediaType }) {
    account.refresh_requested += 1;
    emitAccount();

    const key = refreshKey({ sectionId, scanPath, collection });
    if (key == null) {
      // Refuse to silently escalate. Caller forgot to wire
      // sectionId/scanPath — a code wiring error, not a runtime
      // decision. We fail the request immediately rather than
      // dispatching a no-key refresh.
      account.refresh_failed += 1;
      emitAccount();
      const error = 'missing-section-or-path';
      log('error', `[Plex] refresh refused: ${error}`);
      const result = {
        ok: false,
        method: null,
        sectionId: sectionId || null,
        scanPath: scanPath || null,
        collection: collection || null,
        mediaId: mediaId || null,
        mediaType: mediaType || null,
        coalescedCount: 0,
        startedAt: now(),
        finishedAt: now(),
        error,
      };
      return { coalesced: false, key: null, result: Promise.resolve(result) };
    }

    // Fan-out lifecycle: if a scope is open for this mediaId, fold the
    // request into the scope's per-key bucket instead of starting a
    // debounce timer. The bucket is dispatched exactly once on
    // scope.close(). This is the lifecycle semantics fix for the
    // season-fan-out case: N child notifies that span seconds
    // collapse to a single targeted refresh on scope close.
    const scope = mediaId ? scopes.get(mediaId) : null;
    if (scope && !scope.closed) {
      let bucket = scope.buckets.get(key);
      if (bucket) {
        account.fan_out_bucket_merged += 1;
        emitAccount();
        bucket.latest = { mediaId: mediaId || bucket.latest?.mediaId, mediaType: mediaType || bucket.latest?.mediaType };
        if (mediaId) bucket.mediaIds.add(mediaId);
        bucket.callCount += 1;
        return {
          coalesced: true,
          key,
          result: new Promise((resolve) => bucket.resolvers.push(resolve)),
        };
      }
      bucket = {
        key,
        sectionId,
        scanPath,
        collection,
        latest: { mediaId, mediaType },
        mediaIds: new Set(mediaId ? [mediaId] : []),
        resolvers: [],
        timer: null,
        callCount: 1,
      };
      scope.buckets.set(key, bucket);
      return {
        coalesced: false,
        key,
        result: new Promise((resolve) => bucket.resolvers.push(resolve)),
      };
    }

    const existing = pending.get(key);
    if (existing) {
      account.refresh_coalesced += 1;
      emitAccount();
      existing.latest = { mediaId: mediaId || existing.latest?.mediaId, mediaType: mediaType || existing.latest?.mediaType };
      if (mediaId) existing.mediaIds.add(mediaId);
      return {
        coalesced: true,
        key,
        result: new Promise((resolve) => existing.resolvers.push(resolve)),
      };
    }

    const entry = {
      key,
      sectionId,
      scanPath,
      collection,
      latest: { mediaId, mediaType },
      mediaIds: new Set(mediaId ? [mediaId] : []),
      resolvers: [],
      timer: null,
    };
    entry.timer = setTimer(() => fire(key), window);
    pending.set(key, entry);
    return {
      coalesced: false,
      key,
      result: new Promise((resolve) => entry.resolvers.push(resolve)),
    };
  }

  /**
   * Return the current counter snapshot. Safe to call any time.
   */
  function getAccount() {
    return { ...account, pending: pending.size };
  }

  /**
   * Reset counters. Intended for tests; production does not call this.
   */
  function resetAccount() {
    account.refresh_requested = 0;
    account.refresh_coalesced = 0;
    account.actual_refresh_sent = 0;
    account.full_section_refresh = 0;
    account.refresh_failed = 0;
    account.fan_out_scope_closed = 0;
    account.fan_out_bucket_dispatched = 0;
    account.fan_out_bucket_merged = 0;
    emitAccount();
  }

  /**
   * Force-flush all pending timers immediately. Tests use this to
   * avoid real-time waits; production does not need it.
   *
   * Returns a Promise that resolves when all dispatched refreshes
   * have settled. The Promise resolves to an array of { key, result }.
   */
  async function flush() {
    const keys = Array.from(pending.keys());
    const promises = [];
    for (const key of keys) {
      const entry = pending.get(key);
      if (!entry) continue;
      // Convert each pending entry's resolvers into a single promise.
      const settled = new Promise((resolve) => entry.resolvers.push(resolve));
      promises.push(settled);
      fire(key);
    }
    return Promise.all(promises);
  }

  /**
   * Test/diagnostic helper: how many distinct keys are currently
   * waiting to fire.
   */
  function pendingCount() {
    return pending.size;
  }

  /**
   * Test/diagnostic helper: read the entry for a key without firing.
   * Production code MUST NOT use this — it is for tests only.
   */
  function _peek(key) {
    const e = pending.get(key);
    if (!e) return null;
    return {
      key: e.key,
      sectionId: e.sectionId,
      scanPath: e.scanPath,
      collection: e.collection,
      latest: { ...e.latest },
      mediaIds: Array.from(e.mediaIds),
      resolverCount: e.resolvers.length,
    };
  }

  /**
   * Open a fan-out scope for `mediaId`. While the returned scope is
   * open, schedule() calls whose mediaId matches scope's mediaId are
   * folded into a per-(collection, scanPath) bucket inside the scope;
   * no debounce timer starts. On close() each non-empty bucket
   * dispatches exactly one targeted refresh and resolves all
   * attached promises with the dispatch result.
   *
   * Schedules for other mediaIds are not affected by an open scope.
   *
   * Idempotency: opening a scope for a mediaId that already has an
   * open scope returns the existing scope (close() is still called
   * once per openScope/close pair by the outer lifecycle).
   */
  function fanOutScope(mediaId) {
    if (typeof mediaId !== 'string' || mediaId.length === 0) {
      throw new TypeError('fanOutScope(mediaId) requires a non-empty string mediaId');
    }
    let scope = scopes.get(mediaId);
    if (scope && !scope.closed) {
      return scope.handle;
    }
    scope = {
      mediaId,
      closed: false,
      buckets: new Map(),
      handle: null,
    };
    const close = () => {
      if (scope.closed) return Promise.resolve([]);
      scope.closed = true;
      scopes.delete(mediaId);
      account.fan_out_scope_closed += 1;
      emitAccount();
      const dispatchPromises = [];
      for (const bucket of scope.buckets.values()) {
        dispatchPromises.push(fireBucket(bucket));
        account.fan_out_bucket_dispatched += 1;
      }
      emitAccount();
      return Promise.all(dispatchPromises);
    };
    scope.handle = {
      mediaId,
      close,
    };
    scopes.set(mediaId, scope);
    return scope.handle;
  }

  async function fireBucket(bucket) {
    const startedAt = now();
    const args = {
      sectionId: bucket.sectionId,
      scanPath: bucket.scanPath,
      collection: bucket.collection,
      mediaId: bucket.latest?.mediaId,
      mediaType: bucket.latest?.mediaType,
      // For fan-out buckets, the meaningful merge count is the
      // number of child schedule() calls that folded in, not the
      // distinct mediaIds count (all children of a season share
      // the same series mediaId). For the regular debounce path
      // these are equivalent.
      coalescedCount: bucket.callCount ?? (bucket.mediaIds?.size || 0),
    };
    account.actual_refresh_sent += 1;
    emitAccount();
    const result = {
      ok: false,
      method: 'partial-refresh',
      sectionId: bucket.sectionId,
      scanPath: bucket.scanPath,
      collection: bucket.collection,
      mediaId: bucket.latest?.mediaId,
      mediaType: bucket.latest?.mediaType,
      coalescedCount: bucket.callCount ?? (bucket.mediaIds?.size || 0),
      startedAt,
      finishedAt: now(),
      error: 'unknown-error',
    };
    const settle = (outcome) => {
      const ok = outcome?.ok === true;
      if (!ok) {
        account.refresh_failed += 1;
        emitAccount();
        const err = outcome?.error || 'unknown-error';
        log('error', `[Plex] partial-refresh failed section=${bucket.sectionId} path=${bucket.scanPath}: ${err}`);
      } else {
        log('log', `[Plex] partial-refresh ok section=${bucket.sectionId} path=${bucket.scanPath} merged=${bucket.callCount ?? (bucket.mediaIds?.size || 0)}`);
      }
      result.ok = ok;
      result.method = outcome?.method || 'partial-refresh';
      result.finishedAt = now();
      result.error = ok ? null : (outcome?.error || 'unknown-error');
      for (const resolve of bucket.resolvers) {
        try { resolve(result); } catch { /* ignore */ }
      }
    };
    let outcome;
    if (typeof dispatch !== 'function') {
      outcome = { ok: true, method: 'partial-refresh' };
    } else {
      try {
        const out = await dispatch(args);
        outcome = (out && typeof out === 'object') ? out : { ok: out === true, method: 'partial-refresh' };
      } catch (err) {
        outcome = { ok: false, method: 'partial-refresh', error: err?.message || 'dispatch-threw' };
      }
    }
    settle(outcome);
    return result;
  }

  /**
   * Test/diagnostic helper: how many fan-out scopes are currently
   * open (across all mediaIds).
   */
  function openScopeCount() {
    let n = 0;
    for (const s of scopes.values()) if (!s.closed) n += 1;
    return n;
  }

  /**
   * Test/diagnostic helper: how many buckets are buffered inside a
   * scope (sum across all open scopes, all keys).
   */
  function scopeBucketCount() {
    let n = 0;
    for (const s of scopes.values()) if (!s.closed) n += s.buckets.size;
    return n;
  }

  /**
   * Test/diagnostic helper: read the buffered bucket count for a
   * given mediaId. Returns 0 if no scope is open.
   */
  function _scopeBucketCountFor(mediaId) {
    const s = scopes.get(mediaId);
    if (!s || s.closed) return 0;
    return s.buckets.size;
  }

  return {
    schedule,
    flush,
    fanOutScope,
    getAccount,
    resetAccount,
    pendingCount,
    openScopeCount,
    scopeBucketCount,
    _scopeBucketCountFor,
    _peek,
    _internal: { window },
  };
}

export const REFRESH_DEFAULTS = Object.freeze({
  windowMs: DEFAULT_WINDOW_MS,
  minWindowMs: MIN_WINDOW_MS,
  maxWindowMs: MAX_WINDOW_MS,
});
