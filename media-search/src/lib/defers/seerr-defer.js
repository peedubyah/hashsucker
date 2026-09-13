/**
 * Seerr deferred-request classification (household deferred-request tranche).
 *
 * Pure functions: given what the Seerr boundary already knows (a
 * release/air date from metadata it already fetched, a candidate count
 * from the pipeline it already ran, or a thrown error), decide whether
 * the request is "not yet" (durable retryable intent) or "broken"
 * (deterministic failure that retrying cannot fix).
 *
 * Outcomes:
 *   fulfilled                 — candidates exist; normal path owns it.
 *   future-not-released       — strong metadata says release/air is future.
 *   released-no-candidate     — should exist, but no usable candidate yet.
 *   candidate-not-fulfillable — pipeline failed transiently (provider,
 *                               availability, hydration); retry may help.
 *   hard-failure              — invalid identity/mapping/config; never retry.
 *
 * No I/O, no DB, no clock import — the caller passes nowMs.
 */

export const DEFER_REASONS = Object.freeze({
  FUTURE_NOT_RELEASED: 'future-not-released',
  RELEASED_NO_CANDIDATE: 'released-no-candidate',
  CANDIDATE_NOT_FULFILLABLE: 'candidate-not-fulfillable',
  HARD_FAILURE: 'hard-failure',
});

/**
 * Deterministic failure signatures. These describe states where running
 * the same pipeline later cannot plausibly change the result: bad input
 * identity, unsupported mapping, or server wiring that only an operator
 * deploy can fix. Everything else is treated as transient.
 */
const HARD_FAILURE_PATTERNS = [
  /mediaId is required/i,
  /invalid media/i,
  /unsupported media/i,
  /unknown media type/i,
  /malformed/i,
  /not supported/i,
  /hydrate\w* not provided/i,
  /identity-unresolved/i,
  /identity-misconfigured/i,
  /no supported/i,
];

export function isHardFailureMessage(message) {
  const msg = String(message ?? '');
  return HARD_FAILURE_PATTERNS.some((re) => re.test(msg));
}

/**
 * Parse an ISO-ish release/air date to epoch ms. Strict by design:
 * rejects garbage instead of fabricating a date the scheduler would
 * then sleep on. Returns null when unknown.
 */
export function parseReleaseDateMs(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isSafeInteger(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  if (year < 1900 || year > 2100) return null;
  return ms;
}

/**
 * Classify a Seerr request outcome.
 *
 * @param {Object} args
 * @param {string|null} args.dateRaw  release/air date already on hand (or null)
 * @param {number|null} args.total    candidate count (null when the pipeline threw)
 * @param {boolean} args.bound        whether the pipeline bound a usable
 *                                    provider-backed handoff (default true).
 *                                    Candidates without a binding are
 *                                    CANDIDATE_NOT_FULFILLABLE, not fulfilled.
 * @param {string|null} args.selectionReason selection.reason when total is 0
 * @param {Error|string|null} args.error thrown pipeline error (or null)
 * @param {number} args.nowMs         caller clock
 * @returns {{ outcome: string, retryable: boolean, expectedAt: number|null, detail: string|null }}
 */
export function classifySeerrDeferral({ dateRaw = null, total = null, bound = true, selectionReason = null, error = null, nowMs = Date.now() } = {}) {
  if (error != null) {
    const message = error instanceof Error ? error.message : String(error);
    if (isHardFailureMessage(message)) {
      return { outcome: DEFER_REASONS.HARD_FAILURE, retryable: false, expectedAt: null, detail: message.slice(0, 160) };
    }
    return {
      outcome: DEFER_REASONS.CANDIDATE_NOT_FULFILLABLE,
      retryable: true,
      expectedAt: parseReleaseDateMs(dateRaw),
      detail: message.slice(0, 160),
    };
  }
  const count = Number(total) || 0;
  if (count > 0 && bound) {
    return { outcome: 'fulfilled', retryable: false, expectedAt: null, detail: null };
  }
  if (count > 0 && !bound) {
    return {
      outcome: DEFER_REASONS.CANDIDATE_NOT_FULFILLABLE,
      retryable: true,
      expectedAt: parseReleaseDateMs(dateRaw),
      detail: selectionReason,
    };
  }
  const expectedAt = parseReleaseDateMs(dateRaw);
  if (expectedAt != null && expectedAt > nowMs) {
    return { outcome: DEFER_REASONS.FUTURE_NOT_RELEASED, retryable: true, expectedAt, detail: selectionReason };
  }
  return {
    outcome: DEFER_REASONS.RELEASED_NO_CANDIDATE,
    retryable: true,
    expectedAt,
    detail: selectionReason,
  };
}
