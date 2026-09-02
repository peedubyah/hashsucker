/**
 * Per-request TorBox call coordinator.
 *
 * Slice 2.7 — Provider API efficiency.
 *
 * Three responsibilities, in order of how much they save:
 *
 *   1. Single-flight per request:  concurrent `mylist` calls (e.g.
 *      lookupPlacement + observeReadiness + getFileInventory firing
 *      in parallel during one delivery lifecycle) share ONE HTTP
 *      fetch and ONE promise. The second caller awaits the first.
 *
 *   2. Memoization per request:    sequential `mylist` calls within
 *      the same request scope reuse the already-resolved snapshot
 *      until the request ends. Avoids re-fetching on cache misses
 *      driven by the same logical media fulfillment.
 *
 *   3. Retry consolidation:        a single 5xx (or other retryable
 *      error) on `mylist` is retried in place. The retry happens
 *      BEFORE the original promise rejects to any caller. Any
 *      concurrent or future caller in the same request scope awaits
 *      the SAME settled promise (whether the original success or
 *      the retry's success/failure). Total HTTP attempts for one
 *      logical snapshot are capped at `maxRetries + 1`.
 *
 * Out of scope:
 *   - cross-request caching
 *   - cross-process deduplication
 *   - jittered backoff scheduling beyond what the caller asks for
 *
 * The coordinator is intentionally sync (microtask) for
 * memoization and single-flight. The only async work happens
 * inside the wrapped fetcher (the caller's real HTTP code).
 */

import { TorBoxCallBudget } from './torbox-call-budget.js';

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 0;
const DEFAULT_RETRYABLE_PREDICATE = isRetryableByDefault;
const RETRYABLE_CATEGORIES = new Set([
  'rate-limit',
  'timeout',
  'network',
  'conflict',
  'temporarily-unavailable',
]);

function isRetryableByDefault(error) {
  if (!error) return false;
  if (error?.retryable === true) return true;
  if (error?.category && RETRYABLE_CATEGORIES.has(error.category)) return true;
  if (error?.status != null) {
    const s = Number(error.status);
    if (s === 429) return true;
    if (s >= 500 && s < 600) return true;
  }
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET' || error?.code === 'ECONNREFUSED') {
    return true;
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  return false;
}

/**
 * @typedef {Object} CoordinatorOptions
 * @property {string} [scope]
 * @property {TorBoxCallBudget} [budget]  reuse an existing budget (recommended)
 * @property {number} [maxRetries=1]      attempts beyond the first
 * @property {(error:any)=>number} [retryDelayMs]  delay in ms for the Nth retry (1-indexed)
 * @property {(error:any)=>boolean} [isRetryable]  predicate; defaults to retryable categories + 5xx/429
 * @property {(args:any[], attempt:number)=>string} [cacheKey]  how to memoize per request
 * @property {() => number} [now]         monotonic time source
 * @property {(ms:number) => Promise<void>} [sleep]  injectable sleeper for tests
 */

export class TorBoxCallCoordinator {
  /**
   * @param {CoordinatorOptions} [options]
   */
  constructor(options = {}) {
    const {
      scope = 'default',
      budget,
      maxRetries = DEFAULT_MAX_RETRIES,
      retryDelayMs,
      isRetryable = DEFAULT_RETRYABLE_PREDICATE,
      cacheKey,
      now = () => Date.now(),
      sleep,
    } = options;

    this._scope = String(scope);
    this._budget = budget ?? new TorBoxCallBudget({ scope: this._scope, now });
    this._maxRetries = normalizeNonNegativeInteger(maxRetries, 'maxRetries');
    this._retryDelayMs = typeof retryDelayMs === 'function'
      ? retryDelayMs
      : () => normalizeNonNegativeInteger(retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, 'retryDelayMs');
    this._isRetryable = isRetryable;
    this._cacheKey = cacheKey ?? defaultCacheKey;
    this._now = now;
    this._sleep = sleep ?? defaultSleep;
    this._inflight = new Map();
    this._memo = new Map();
  }

  get budget() {
    return this._budget;
  }

  get maxRetries() {
    return this._maxRetries;
  }

  /**
   * Run an async fetcher under single-flight + memoization + retry
   * consolidation for a given operation.
   *
   * @template T
   * @param {string} op
   * @param {any[]} args   arguments that identify the call (used for memoization)
   * @param {() => Promise<T>} fetchFn  the actual fetcher
   * @returns {Promise<T>}
   */
  async run(op, args, fetchFn) {
    if (typeof fetchFn !== 'function') {
      throw new TypeError('run() requires a fetchFn function');
    }
    const key = this._cacheKey(args, this._maxRetries);
    const slotKey = `${op}::${key}`;

    const existing = this._inflight.get(slotKey);
    if (existing) {
      this._budget.recordHit(op);
      return existing.promise;
    }

    const memoized = this._memo.get(slotKey);
    if (memoized) {
      this._budget.recordHit(op);
      return memoized.value;
    }

    const entry = createEntry();
    this._inflight.set(slotKey, entry);
    this._budget.recordMiss(op);

    const promise = this._executeWithRetries(op, args, fetchFn, entry)
      .then((value) => {
        // Successful settlement is memoized for the rest of the request
        // so subsequent callers with the same args avoid a re-fetch.
        this._memo.set(slotKey, { value, error: null });
        return value;
      })
      .catch((error) => {
        // Errors are NOT memoized — failures stay visible so callers
        // (and retries, if any) can react. We still cache them briefly
        // to prevent an in-flight-then-rejected promise from being
        // re-entered; the .finally below clears the inflight slot.
        throw error;
      })
      .finally(() => {
        this._inflight.delete(slotKey);
        entry.settled = true;
      });

    entry.promise = promise;
    return promise;
  }

  async _executeWithRetries(op, args, fetchFn, entry) {
    let attempt = 0;
    let lastError = null;

    while (true) {
      const isRetry = attempt > 0;
      if (isRetry) {
        const delay = this._retryDelayMs(lastError) ?? 0;
        if (delay > 0) {
          await this._sleep(delay);
        }
      }
      const startedAt = this._budget.recordFetchStart(op, { retry: isRetry });
      try {
        const result = await fetchFn(...args);
        this._budget.recordFetchEnd(op, { startedAt, error: null });
        entry.attempts = attempt + 1;
        return result;
      } catch (error) {
        const retryable = this._isRetryable(error);
        const budgetLeft = attempt < this._maxRetries;
        const willRetry = retryable && budgetLeft;
        this._budget.recordFetchEnd(op, { startedAt, error, transient: willRetry });
        lastError = error;
        if (willRetry) {
          attempt += 1;
          continue;
        }
        entry.attempts = attempt + 1;
        // Surface a clean error: the most recent attempt's error
        // (either the only attempt, or the final retry's failure).
        throw normalizeError(error);
      }
    }
  }

  /**
   * Detach the budget and drop any in-flight tracking. In-flight
   * promises continue to settle naturally; their budget updates
   * become no-ops. Memoized successes are also dropped so a future
   * (different) request does not accidentally reuse a stale snapshot.
   */
  detach() {
    this._budget.detach();
    this._inflight.clear();
    this._memo.clear();
  }
}

function createEntry() {
  return { promise: null, settled: false, attempts: 0 };
}

function defaultCacheKey(args) {
  return JSON.stringify(args ?? []);
}

function defaultSleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNonNegativeInteger(value, field) {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeError(error) {
  if (error == null) return new Error('TorBox call failed (no error provided)');
  return error instanceof Error ? error : Object.assign(new Error(String(error?.message ?? error)), { cause: error });
}

export const TORBOX_COORDINATOR_DEFAULTS = Object.freeze({
  maxRetries: DEFAULT_MAX_RETRIES,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
});
