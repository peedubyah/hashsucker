/**
 * Representation policy: who may replace the authoritative representation,
 * on what evidence, and within what budget.
 *
 * A Binding names the authoritative representation. A provider route is a
 * ROUTE to those bytes. When every route of a TorrentFile is exhausted the
 * delivery is degraded — that alone is NOT a reason to declare the
 * representation invalid.
 *
 * This module owns the ONE decision that may replace the representation
 * because of a delivery failure, and makes that decision explicit:
 *
 *   - it requires DURABLE evidence that the authoritative TorrentFile has
 *     no live route (the recorded route-failure evidence), not one
 *     request's exhaustion: a route that was throttled or timed out is
 *     transient and leaves the representation authoritative;
 *   - it is budgeted: at most one representation switch per media intent
 *     per window, so a flapping route cannot churn the representation;
 *   - it never invents a representation: the switch itself reuses the
 *     EXISTING persisted-candidate lifecycle (an already-ranked,
 *     already-eligible alternative with a validated byte response).
 *
 * It does not own placements, inventory, file mappings, the TorrentFile
 * identity, the VFS path, or any provider state.
 */

export const REPRESENTATION_POLICY_REASONS = Object.freeze({
  ALLOWED: 'no-live-route-and-budget-available',
  NO_DURABLE_EVIDENCE: 'no-durable-route-failure-evidence',
  TRANSIENT_ROUTE: 'route-failure-is-transient',
  BUDGET_SPENT: 'representation-switch-budget-spent',
  NOT_AUTHORITATIVE: 'no-authoritative-binding',
});

/** Default window in which at most one representation switch is allowed. */
export const REPRESENTATION_SWITCH_WINDOW_MS = (() => {
  const raw = Number(process.env.REPRESENTATION_SWITCH_WINDOW_MS ?? 6 * 60 * 60 * 1000);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 6 * 60 * 60 * 1000;
})();

/**
 * @param {Object} deps
 * @param {Function} [deps.now]
 * @param {number} [deps.switchWindowMs]
 */
export function createRepresentationPolicy({
  now = () => Date.now(),
  switchWindowMs = REPRESENTATION_SWITCH_WINDOW_MS,
} = {}) {
  // Per-media last switch time. A process-local rate guard, not durable
  // truth: the durable trail of a switch is the binding history itself.
  const lastSwitchAt = new Map();

  /**
   * Decide whether the authoritative representation may be replaced now.
   *
   * @param {Object} params
   * @param {string} params.mediaId - the media intent
   * @param {Array<Object>} [params.routes] - the routes the data plane failed on
   * @param {Object} [params.evidence] - the durable-evidence write summary
   *   {recorded, terminal, temporary, skipped}
   * @param {boolean} [params.hasAuthoritativeBinding]
   * @returns {{allow: boolean, reason: string}}
   */
  function decide({ mediaId, routes = [], evidence = null, hasAuthoritativeBinding = true } = {}) {
    if (!hasAuthoritativeBinding) {
      return { allow: false, reason: REPRESENTATION_POLICY_REASONS.NOT_AUTHORITATIVE };
    }
    const key = String(mediaId ?? '');
    const last = lastSwitchAt.get(key);
    if (last !== undefined && now() - last < switchWindowMs) {
      return { allow: false, reason: REPRESENTATION_POLICY_REASONS.BUDGET_SPENT };
    }
    if (!Array.isArray(routes) || routes.length === 0) {
      return { allow: false, reason: REPRESENTATION_POLICY_REASONS.NO_DURABLE_EVIDENCE };
    }
    // Every route the data plane reported must be a PROVABLY dead one, and
    // the durable evidence for each of them must have been written. A route
    // that merely did not answer leaves the representation authoritative.
    const allTerminal = routes.every((route) => route?.kind === 'terminal');
    if (!allTerminal) {
      return { allow: false, reason: REPRESENTATION_POLICY_REASONS.TRANSIENT_ROUTE };
    }
    if (!evidence || evidence.recorded < routes.length || evidence.temporary > 0) {
      return { allow: false, reason: REPRESENTATION_POLICY_REASONS.NO_DURABLE_EVIDENCE };
    }
    return { allow: true, reason: REPRESENTATION_POLICY_REASONS.ALLOWED };
  }

  /**
   * Record that a representation switch happened (the budget).
   */
  function noteSwitch({ mediaId } = {}) {
    lastSwitchAt.set(String(mediaId ?? ''), now());
  }

  return Object.freeze({ decide, noteSwitch });
}
