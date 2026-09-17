/**
 * Bounded automatic retry for media jobs (download intents, promotions).
 *
 * Shared failure classification + budget so both workers behave
 * identically: transient failures schedule a retry with backoff,
 * permanent failures go terminal immediately, exhaustion goes terminal
 * and loud. Unknown shapes fail closed to transient — the attempt
 * budget (not the classifier) is the backstop, so a misclassified
 * error can cost retries but never loop forever.
 *
 * Delays reuse intentBackoffMs (15m, 1h, 4h, cap 24h): first retry
 * soon, then minutes-to-hours, capped within a household timescale.
 * No retry storms by construction (one row, one worker claim, serial
 * ticks, restart preserves due time).
 */
import { intentBackoffMs } from '../anticipation/future-intents.js';

// Total tries including the initial attempt (mirrors the intent
// scheduler's exhaustion budget). Attempts beyond this stay terminal
// until a human re-POSTs (which resets the budget intentionally).
export const MAX_JOB_ATTEMPTS = 6;

const PERMANENT_PATTERNS = [
  /invalid-expected-size/i,
  /size-mismatch/i,
  /sparse-file/i,
  /invalid-input/i,
  /mediaid is required/i,
  /must not carry|must be|episode.*required/i,
  /escapes (owned )?root/i,
  /path escapes/i,
  /positive .* size is required/i,
  /torrentfileid is required/i,
  /no healthy torrentfile/i,
  /no eligible candidate/i,
  /\bunresolvable\b/i,
];

const TRANSIENT_PATTERNS = [
  /timed? ?out/i,
  /aborted|aborterror/i,
  /econnreset|econnrefused|enotfound|enetunreach|eai_again|socket hang up/i,
  /eacces|ebusy|enomem/i,
  /fetch failed/i,
  /network/i,
  /429|too many requests|rate limit/i,
  /\b5\d\d\b/,
  /incomplete stream/i,
  /connection/i,
  /temporar/i,
];

/**
 * Classify a job failure. Stage is the worker phase that failed:
 * resolve (returned non-ok) | target | materialize | unexpected
 * (thrown). Returns { retryable, category } where category is a short
 * stable token for persistence and logs.
 */
export function classifyJobFailure({ stage = 'materialize', error = null } = {}) {
  const msg = String(error?.message ?? error ?? '');
  if (stage === 'target') {
    if (/escapes (owned )?root/i.test(msg)) return { retryable: false, category: 'path-escape' };
    return { retryable: false, category: 'path-config' };
  }
  if (stage === 'unexpected') {
    // Thrown errors bypass reason strings: fail closed to transient.
    // The attempt budget (not this branch) is the backstop.
    return { retryable: true, category: 'unexpected-transient' };
  }
  if (stage === 'resolve') {
    if (/invalid-input|mediaid is required/i.test(msg)) return { retryable: false, category: 'invalid-identity' };
    // Resolve polarity is inverted vs materialize: an unexplained miss
    // means the market has no candidate (permanent; human re-POSTs when
    // the market presumably changed). Only positively-transport failures
    // retry — a short stream that later appears still resolves then.
    if (/timed? ?out|aborted|aborterror|econn|enotfound|enetunreach|eai_again|socket hang up|fetch failed|network|429|too many requests|rate limit|\b5\d\d\b|temporar|unavailable|try again|discovery failed/i.test(msg)) {
      return { retryable: true, category: 'resolve-transient' };
    }
    return { retryable: false, category: 'no-candidate' };
  }
  for (const re of PERMANENT_PATTERNS) {
    if (re.test(msg)) return { retryable: false, category: 'deterministic-mismatch' };
  }
  for (const re of TRANSIENT_PATTERNS) {
    if (re.test(msg)) return { retryable: true, category: 'transient' };
  }
  const statusMatch = msg.match(/\b(\d{3})\b/);
  if (statusMatch) {
    const s = Number(statusMatch[1]);
    if (s === 429 || (s >= 500 && s <= 599)) return { retryable: true, category: 'transient' };
    if (s === 400 || s === 401 || s === 403 || s === 404) return { retryable: false, category: 'deterministic-mismatch' };
  }
  // Unknown: fail closed to transient — bounded by the attempt budget.
  return { retryable: true, category: 'transient' };
}

/** Delay before the Nth failure's retry (N starting at 1). */
export function retryDelayMs(failureNumber) {
  return intentBackoffMs(Math.max(0, (failureNumber ?? 1) - 1));
}

/**
 * Record one job failure against a store exposing get/markFailed/
 * scheduleRetry. Returns { outcome: 'retry'|'failed', row }.
 */
export function recordJobFailure(store, id, classification, error) {
  const cur = store.get(id);
  const attempts = (cur?.attempts ?? 0) + 1;
  const msg = String(error?.message ?? error ?? 'unknown error').slice(0, 2000);
  if (!classification.retryable || attempts >= MAX_JOB_ATTEMPTS) {
    return {
      outcome: 'failed',
      row: store.markFailed(id, msg, { category: classification.category, attempts }),
    };
  }
  return {
    outcome: 'retry',
    row: store.scheduleRetry(id, {
      error: msg, category: classification.category, attempts, delayMs: retryDelayMs(attempts),
    }),
  };
}
