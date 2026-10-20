/**
 * Route resurrection for an authoritative TorrentFile.
 *
 * A Binding names the authoritative REPRESENTATION (one TorrentFile). A
 * provider placement is a ROUTE to those bytes. When every route is
 * exhausted, the representation has NOT failed — only its delivery has.
 * The correct first response is therefore to look for ANOTHER ROUTE to the
 * SAME TorrentFile, not to choose a different representation.
 *
 * This seam owns exactly that step and nothing else:
 *
 *   - it asks the existing second-placement machinery (the same
 *     cache-only, bounded, idempotent mechanism the periodic route
 *     reconciler already uses) for a route to the SAME TorrentFile;
 *   - it never touches the Release, the TorrentFile, the Binding, the VFS
 *     row, the consumer projection or the candidate ranking;
 *   - it never acquires an uncached download: the TorBox path is
 *     cache-gated and the Real-Debrid path is discovery-only;
 *   - it is bounded per TorrentFile by a cooldown, so a client retry storm
 *     cannot turn one dead route into a provider-call storm.
 *
 * If no route can be found, the caller learns that the delivery is
 * degraded. Deciding what to serve instead is a policy decision that
 * belongs to the caller, not to this seam.
 */

/** Default per-TorrentFile cooldown between resurrection attempts. */
export const ROUTE_RESURRECTION_COOLDOWN_MS = (() => {
  const raw = Number(process.env.ROUTE_RESURRECTION_COOLDOWN_MS ?? 300_000);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 300_000;
})();

/**
 * @param {Object} deps
 * @param {Function} [deps.ensureSecondPlacementFn] - ({torrentFileId}) => outcome
 * @param {Function} [deps.now]
 * @param {number} [deps.cooldownMs]
 * @param {Function} [deps.log]
 */
export function createRouteResurrector({
  ensureSecondPlacementFn = null,
  now = () => Date.now(),
  cooldownMs = ROUTE_RESURRECTION_COOLDOWN_MS,
  log = () => {},
} = {}) {
  // Per-TorrentFile last-attempt time. Process-local: it is a rate guard,
  // not durable truth, and a restart simply allows one more attempt.
  const lastAttemptAt = new Map();

  /**
   * Try to find (or observe) another route to the SAME TorrentFile.
   *
   * @param {Object} params
   * @param {string} params.torrentFileId
   * @returns {Promise<{status: string, recovered: boolean, reason?: string, outcome?: Object}>}
   */
  async function resurrect({ torrentFileId } = {}) {
    if (!torrentFileId || typeof torrentFileId !== 'string') {
      return { status: 'invalid-input', recovered: false, reason: 'torrentFileId is required' };
    }
    if (typeof ensureSecondPlacementFn !== 'function') {
      return { status: 'unavailable', recovered: false, reason: 'no-resurrector-wired' };
    }
    const at = now();
    const last = lastAttemptAt.get(torrentFileId);
    if (last !== undefined && at - last < cooldownMs) {
      return { status: 'cooldown', recovered: false, reason: 'attempted-recently' };
    }
    lastAttemptAt.set(torrentFileId, at);
    let outcome;
    try {
      outcome = await ensureSecondPlacementFn({ torrentFileId });
    } catch (error) {
      const reason = String(error?.message ?? error);
      log(`[route-resurrection] tf=${torrentFileId} failed: ${reason}`);
      return { status: 'error', recovered: false, reason };
    }
    const status = String(outcome?.status ?? 'unknown');
    // 'created' means a NEW route to the SAME TorrentFile now exists
    // (a placement + provider file mapped to that exact TorrentFile). That
    // is route repair, not media reselection.
    const recovered = status === 'created';
    // The provider was actually consulted: the account was searched for this
    // exact release. That is the ROUTE-SET COMPLETENESS proof — without it
    // "every known route is dead" is not "no same-TorrentFile route exists".
    const discoveryCompleted = status !== 'unknown' && status !== 'invalid-input';
    log(`[route-resurrection] tf=${torrentFileId} status=${status} recovered=${recovered} discoveryCompleted=${discoveryCompleted}`);
    return { status, recovered, discoveryCompleted, outcome: outcome ?? null };
  }

  return Object.freeze({ resurrect });
}
