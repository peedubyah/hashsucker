/**
 * Provider-neutral preparation contract.
 *
 * Preparation turns an uncached-but-acceptable Release into an executable
 * one WITHOUT letting any provider choose representation. The shape is
 * always:
 *
 *   representation chosen (candidate, exact-file hints)
 *     → provider acquisition beneath it (per-provider adapters)
 *     → exact-file closure (path + positive size → TorrentFile)
 *     → Binding under normal representation policy
 *
 * Outcome vocabulary is provider-neutral. Provider-specific semantics
 * (RD 451, TorBox whole-torrent, Retry-After) stay in adapters and are
 * mapped here at the boundary. Nothing provider-shaped may leak into
 * client responses — the API layer translates these once more.
 */

export const PREPARE_OUTCOME = Object.freeze({
  /** Provider accepted and content is already downloadable. */
  READY: 'ready',
  /** Provider accepted; content will become downloadable (poll). */
  ACCEPTED: 'accepted',
  /** Already present on the provider; nothing to acquire. */
  ALREADY_PRESENT: 'already_present',
  /** Provider refused this release on content-policy grounds (scope: provider+release). */
  CONTENT_BLOCKED: 'content_blocked',
  /** Account cannot perform acquisition (scope: account, not route). */
  ACCOUNT_INELIGIBLE: 'account_ineligible',
  /** Provider asked to wait (scope: provider, honor Retry-After). */
  RATE_LIMITED: 'rate_limited',
  /** Ambiguous/genuine transient; safe to retry with backoff. */
  TEMPORARY_FAILURE: 'temporary_failure',
  /** Provider cannot do this at all (unsupported op/shape). */
  UNSUPPORTED: 'unsupported',
  /** Failed and should not be retried without new information. */
  FAILED: 'failed',
});

export const PREPARE_STATE = Object.freeze({
  QUEUED: 'queued',
  ACQUIRING: 'acquiring',
  WAITING: 'waiting',
  READY: 'ready',
  FAILED_TEMPORARY: 'failed_temporary',
  FAILED_POLICY: 'failed_policy',
  FAILED_TERMINAL: 'failed_terminal',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

/** States in which a preparation still owns provider-side work. */
const ACTIVE_STATES = new Set([
  PREPARE_STATE.QUEUED,
  PREPARE_STATE.ACQUIRING,
  PREPARE_STATE.WAITING,
  // failed_temporary owns no provider work yet, but it is owed a bounded
  // re-drive (requeue → queued) rather than being history. It must never
  // read as terminal.
  PREPARE_STATE.FAILED_TEMPORARY,
]);

/** Terminal states: the row is history unless explicitly re-driven. */
const TERMINAL_STATES = new Set([
  PREPARE_STATE.READY,
  PREPARE_STATE.FAILED_POLICY,
  PREPARE_STATE.FAILED_TERMINAL,
  PREPARE_STATE.CANCELLED,
  PREPARE_STATE.EXPIRED,
]);

export function isPreparationActive(state) {
  return ACTIVE_STATES.has(state);
}

export function isPreparationTerminal(state) {
  return TERMINAL_STATES.has(state);
}

/**
 * Map a provider adapter result to a contract outcome. Adapters return
 * `{ accepted, present?, blocked?, blockedScope?, retryable?, retryAfterMs?,
 * unsupported?, error?, status? }` — small, honest, provider-flavored.
 * This is the ONLY place provider flavor becomes contract language.
 */
export function toPrepareOutcome(result = {}) {
  if (result?.present === true || result?.alreadyPresent === true) {
    return PREPARE_OUTCOME.ALREADY_PRESENT;
  }
  if (result?.blocked === true) {
    return PREPARE_OUTCOME.CONTENT_BLOCKED;
  }
  if (result?.accountIneligible === true) {
    return PREPARE_OUTCOME.ACCOUNT_INELIGIBLE;
  }
  if (result?.rateLimited === true || result?.retryAfterMs != null) {
    return PREPARE_OUTCOME.RATE_LIMITED;
  }
  if (result?.unsupported === true) {
    return PREPARE_OUTCOME.UNSUPPORTED;
  }
  if (result?.accepted === true) {
    return result?.ready === true ? PREPARE_OUTCOME.READY : PREPARE_OUTCOME.ACCEPTED;
  }
  if (result?.retryable === true) {
    return PREPARE_OUTCOME.TEMPORARY_FAILURE;
  }
  return PREPARE_OUTCOME.FAILED;
}

/**
 * Outcome → preparation state transition for a poll/acquire step.
 * Pure function so the driver stays thin and tests stay honest.
 */
export function nextPreparationState(currentState, outcome) {
  switch (outcome) {
    case PREPARE_OUTCOME.READY:
      return PREPARE_STATE.READY;
    case PREPARE_OUTCOME.ACCEPTED:
    case PREPARE_OUTCOME.ALREADY_PRESENT:
      // ALREADY_PRESENT still needs exact-file closure + Binding, which
      // happens in the same WAITING/drain path as a fresh accept.
      return currentState === PREPARE_STATE.QUEUED ? PREPARE_STATE.ACQUIRING : PREPARE_STATE.WAITING;
    case PREPARE_OUTCOME.CONTENT_BLOCKED:
      return PREPARE_STATE.FAILED_POLICY;
    case PREPARE_OUTCOME.ACCOUNT_INELIGIBLE:
    case PREPARE_OUTCOME.UNSUPPORTED:
    case PREPARE_OUTCOME.FAILED:
      return PREPARE_STATE.FAILED_TERMINAL;
    case PREPARE_OUTCOME.RATE_LIMITED:
    case PREPARE_OUTCOME.TEMPORARY_FAILURE:
    default:
      return PREPARE_STATE.FAILED_TEMPORARY;
  }
}

/**
 * Deterministic provider attempt order for one preparation. No scoring,
 * no racing, no global favorite:
 *
 *   1. a provider with an already-existing resource/placement for the Release;
 *   2. otherwise, eligible backends in configured order, skipping any with
 *      a live refusal memory (content-blocked for this Release, or
 *      account-ineligible right now);
 *   3. a provider-specific refusal moves to the next provider; it never
 *      poisons the Release (other backends still try) and never poisons
 *      the provider globally (other releases still try).
 *
 * @param {string[]} eligible ordered backend ids, e.g. ['torbox','realdebrid']
 * @param {object} [memory] { contentBlocked:Set<string>, accountIneligible:Set<string> }
 * @returns {string[]} attempt order (possibly empty)
 */
export function orderPrepareProviders(eligible = [], memory = {}) {
  const list = Array.isArray(eligible) ? eligible.filter((p) => typeof p === 'string') : [];
  const blocked = memory?.contentBlocked instanceof Set ? memory.contentBlocked : new Set();
  const ineligible = memory?.accountIneligible instanceof Set ? memory.accountIneligible : new Set();
  return list.filter((p) => !blocked.has(p) && !ineligible.has(p));
}
