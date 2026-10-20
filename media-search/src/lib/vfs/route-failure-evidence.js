/**
 * Durable route-failure evidence.
 *
 * When the authoritative byte path proves that a provider ROUTE is dead,
 * that fact must survive a restart: otherwise the system forgets which
 * route died and waits for the next 6-hourly sweep to rediscover it.
 *
 * This module owns exactly that bridge:
 *
 *   - it takes the failed routes reported by the data plane
 *     (provider, account scope, provider resource id, provider file id,
 *     and whether the route answered "gone" or merely did not answer);
 *   - it maps the provider resource id to the durable placement id (the
 *     hash/resource index), because the durable evidence table is keyed on
 *     the capability tuple;
 *   - it records the evidence in the EXISTING provider delivery-evidence
 *     store — 'terminal' for a provably dead route, 'temporary' for a
 *     throttled or timed-out route, which must NEVER be recorded as death;
 *   - it clears stale negative evidence when that route later delivers.
 *
 * It does not own placements, inventory, file mappings, sizes, the
 * Binding, the VFS row, or any provider state. Recording a route failure
 * never changes the authoritative representation.
 */

/** The kinds the data plane reports. */
export const ROUTE_FAILURE_KINDS = Object.freeze({
  TERMINAL: 'terminal',
  TEMPORARY: 'temporary',
});

/**
 * @param {Object} deps
 * @param {Object} deps.controlPlaneStore
 * @param {Object} [deps.evidenceStore] - the terminal-delivery-evidence store
 * @param {Function} [deps.now]
 * @param {Function} [deps.log]
 */
export function createRouteFailureRecorder({
  controlPlaneStore,
  evidenceStore = null,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  /**
   * Record the durable evidence for the routes a byte read just failed on.
   *
   * @param {Object} params
   * @param {Array<Object>} params.routes - the data plane's route failures
   * @param {string} params.infoHash - the authoritative Release
   * @param {number|null} [params.fileIndexKey]
   * @returns {{recorded: number, terminal: number, temporary: number, skipped: number}}
   */
  function recordRouteFailures({ routes, infoHash, fileIndexKey = -1 } = {}) {
    const summary = { recorded: 0, terminal: 0, temporary: 0, skipped: 0 };
    if (!evidenceStore || typeof evidenceStore.recordTerminal !== 'function') return summary;
    if (!Array.isArray(routes) || routes.length === 0) return summary;
    for (const route of routes) {
      const provider = typeof route?.provider === 'string' ? route.provider : null;
      const accountScope = typeof route?.accountScope === 'string' ? route.accountScope : 'default';
      const resourceId = typeof route?.providerResourceId === 'string' ? route.providerResourceId : null;
      const providerFileId = typeof route?.providerFileId === 'string' ? route.providerFileId : null;
      if (!provider || !resourceId || !providerFileId) {
        summary.skipped += 1;
        continue;
      }
      // The durable evidence is keyed on the capability tuple; the provider
      // resource id is the provider-side name of the placement.
      let placementId = null;
      try {
        const placement = typeof controlPlaneStore?.findPlacement === 'function'
          ? controlPlaneStore.findPlacement(provider, accountScope, resourceId)
          : null;
        placementId = placement?.id ?? null;
      } catch {
        placementId = null;
      }
      if (!placementId) {
        // The route is not in the durable index: there is no capability
        // tuple to key evidence on. Nothing is invented.
        summary.skipped += 1;
        continue;
      }
      const terminal = route?.kind === ROUTE_FAILURE_KINDS.TERMINAL;
      const input = {
        provider,
        accountScope,
        placementId,
        providerFileId,
        infoHash: infoHash ?? null,
        fileIndexKey: fileIndexKey ?? -1,
        reason: typeof route?.detail === 'string' ? route.detail.slice(0, 200) : 'route-failed',
        failureCategory: terminal ? 'route-terminal' : 'route-transient',
        observedAt: now(),
      };
      try {
        if (terminal) {
          evidenceStore.recordTerminal(input);
          summary.terminal += 1;
        } else {
          evidenceStore.recordTemporary(input);
          summary.temporary += 1;
        }
        summary.recorded += 1;
        log(`[route-failure] recorded ${terminal ? 'terminal' : 'temporary'} evidence provider=${provider} resource=${resourceId} file=${providerFileId} reason=${input.reason}`);
      } catch (error) {
        summary.skipped += 1;
        log(`[route-failure] evidence write failed provider=${provider} resource=${resourceId}: ${error?.message ?? error}`);
      }
    }
    return summary;
  }

  /**
   * Clear stale negative evidence for a route that just delivered bytes.
   * A route that works again is not a dead route; the negative row must
   * not outlive the proof.
   */
  function clearRouteFailure({ provider, accountScope = 'default', providerResourceId, providerFileId, infoHash = null, fileIndexKey = -1 } = {}) {
    if (!evidenceStore || typeof evidenceStore.recordUsable !== 'function') return false;
    if (!provider || !providerResourceId || !providerFileId) return false;
    let placementId = null;
    try {
      const placement = typeof controlPlaneStore?.findPlacement === 'function'
        ? controlPlaneStore.findPlacement(provider, accountScope, providerResourceId)
        : null;
      placementId = placement?.id ?? null;
    } catch {
      placementId = null;
    }
    if (!placementId) return false;
    try {
      evidenceStore.recordUsable({
        provider,
        accountScope,
        placementId,
        providerFileId,
        infoHash,
        fileIndexKey,
        reason: 'route-delivered',
        failureCategory: null,
        observedAt: now(),
      });
      return true;
    } catch (error) {
      log(`[route-failure] evidence clear failed provider=${provider} resource=${providerResourceId}: ${error?.message ?? error}`);
      return false;
    }
  }

  return Object.freeze({ recordRouteFailures, clearRouteFailure });
}
