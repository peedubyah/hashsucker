/**
 * Per-request TorBox API call budget.
 *
 * Slice 2.7 — Provider API efficiency.
 *
 * A "request" is one logical fulfillment lifecycle (a single media
 * request through discovery → selection → placement → delivery).
 * Inside that lifecycle, every live call to the TorBox API is
 * counted in a small per-operation ledger so a canary can assert:
 *
 *   - "1 mylist fetch, reused for lookup + inventory"
 *   - "0 retry thundering herd on 5xx"
 *   - "≤ maxRetries+1 fetches for any single mylist snapshot"
 *
 * The budget is intentionally NOT a rate limiter or back-pressure
 * controller. It is a passive counter that callers and tests inspect.
 *
 * Scope:
 *   The budget lives on a single request scope. When the request
 *   finishes (success or failure), the scope is detached and the
 *   counter becomes inert. Re-entry of the same scope returns the
 *   same budget object; different scopes never share state.
 *
 * Operations:
 *   - mylist (account inventory snapshot)
 *   - checkcached (cache observation)
 *   - createtorrent (placement create)
 *   - other (escape hatch for future endpoints)
 *
 * Counters:
 *   - fetches:   total HTTP attempts (1 per request issued, including retries)
 *   - retries:   total retry attempts (excludes the first attempt)
 *   - inflight:  currently in-flight (started, not yet settled)
 *   - hits:      cache hits served without a network fetch (single-flight reuse)
 *   - misses:    cache misses (one fresh fetch issued)
 *   - failures:  final settled state was a thrown error
 */

const KNOWN_OPERATIONS = new Set(['mylist', 'checkcached', 'createtorrent', 'other']);

export class TorBoxCallBudget {
  constructor({ scope = 'default', now = () => Date.now() } = {}) {
    this._scope = String(scope);
    this._now = now;
    this._detached = false;
    this._byOperation = new Map();
  }

  get scope() {
    return this._scope;
  }

  get detached() {
    return this._detached;
  }

  _ensure(op) {
    let counters = this._byOperation.get(op);
    if (!counters) {
      counters = {
        fetches: 0,
        retries: 0,
        inflight: 0,
        hits: 0,
        misses: 0,
        failures: 0,
        lastStartedAt: null,
        lastSettledAt: null,
        totalDurationMs: 0,
      };
      this._byOperation.set(op, counters);
    }
    return counters;
  }

  /**
   * Record the start of a live HTTP fetch for `op`.
   * Returns the start timestamp (ms).
   *
   * @param {string} op
   * @param {{ retry?: boolean }} [meta]
   * @returns {number} start timestamp
   */
  recordFetchStart(op, { retry = false } = {}) {
    assertOperation(op);
    if (this._detached) return this._now();
    const counters = this._ensure(op);
    counters.fetches += 1;
    if (retry) counters.retries += 1;
    counters.inflight += 1;
    counters.lastStartedAt = this._now();
    return counters.lastStartedAt;
  }

  /**
   * Record the end of a live HTTP fetch for `op`.
   *
   * @param {string} op
   * @param {{ startedAt: number, error?: Error|null, transient?: boolean }} [meta]
   *
   * `transient=true` means the failure was retried (the counter still
   * records the attempt, but `failures` is NOT incremented because
   * the final settled state is not yet known).
   */
  recordFetchEnd(op, { startedAt, error = null, transient = false } = {}) {
    assertOperation(op);
    if (this._detached) return;
    const counters = this._ensure(op);
    counters.inflight = Math.max(0, counters.inflight - 1);
    counters.lastSettledAt = this._now();
    if (typeof startedAt === 'number') {
      counters.totalDurationMs += Math.max(0, counters.lastSettledAt - startedAt);
    }
    if (error && !transient) counters.failures += 1;
  }

  /**
   * Record that an in-scope single-flight hit served a request without
   * issuing a new HTTP fetch.
   */
  recordHit(op) {
    assertOperation(op);
    if (this._detached) return;
    const counters = this._ensure(op);
    counters.hits += 1;
  }

  /**
   * Record that a fresh fetch was issued (no in-scope cache hit).
   */
  recordMiss(op) {
    assertOperation(op);
    if (this._detached) return;
    const counters = this._ensure(op);
    counters.misses += 1;
  }

  /**
   * Detach the budget so future calls become no-ops. Used at request
   * scope teardown.
   */
  detach() {
    this._detached = true;
  }

  /**
   * Read-only snapshot of the counters, grouped by operation. Always
   * includes every known operation key (zeros where unused) for
   * stable canary assertions.
   */
  snapshot() {
    const operations = {};
    for (const op of KNOWN_OPERATIONS) {
      const c = this._byOperation.get(op) ?? {
        fetches: 0,
        retries: 0,
        inflight: 0,
        hits: 0,
        misses: 0,
        failures: 0,
        lastStartedAt: null,
        lastSettledAt: null,
        totalDurationMs: 0,
      };
      operations[op] = {
        fetches: c.fetches,
        retries: c.retries,
        inflight: c.inflight,
        hits: c.hits,
        misses: c.misses,
        failures: c.failures,
        lastStartedAt: c.lastStartedAt,
        lastSettledAt: c.lastSettledAt,
        totalDurationMs: c.totalDurationMs,
      };
    }
    return Object.freeze({
      scope: this._scope,
      detached: this._detached,
      operations: Object.freeze(operations),
    });
  }

  /**
   * Total live fetches across every known operation. Excludes
   * in-scope hits.
   */
  totalFetches() {
    let total = 0;
    for (const op of KNOWN_OPERATIONS) {
      const c = this._byOperation.get(op);
      if (c) total += c.fetches;
    }
    return total;
  }
}

function assertOperation(op) {
  if (!KNOWN_OPERATIONS.has(op)) {
    throw new TypeError(`Unknown TorBox call operation: ${op}`);
  }
}

export const TORBOX_BUDGET_OPERATIONS = Object.freeze([...KNOWN_OPERATIONS]);
