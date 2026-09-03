/**
 * Terminal Delivery Evidence
 *
 * Persists provider-specific, capability-specific, mapping-coordinate-
 * specific evidence about a delivery capability so that the normal
 * resolver availability ladder can override stale cached observations.
 *
 * The VFS byte path conclusively proves a TorBox delivery capability
 * is invalid, invalidates it, and obtains one fresh capability — which
 * is also proven invalid by the same byte path. The current mapping
 * is correct. Without durable evidence the next normal
 * GET /stream/series/tt7137906?season=1&episode=2 call would still
 * see the cached TorBox `cached` provider observation and return the
 * poisoned primary; the persisted alternate-candidate rung is
 * therefore never entered.
 *
 * Evidence states:
 *   - `usable`   default; the capability is trusted.
 *   - `temporary` a transient failure (e.g. 429) was observed. The
 *                capability might recover once the upstream backoff
 *                window passes. Never becomes terminal on its own.
 *   - `terminal`  the current exact mapping is unusable. Promoted
 *                only after the bounded fresh capability retry also
 *                fails protocol validation, OR after two consecutive
 *                definitive upstream capability failures (401/403/404
 *                /410/stale mapping). A 429/transient never becomes
 *                terminal.
 *
 * Authoritative identity contract: the row is keyed on the capability
 * tuple (provider, accountScope, placementId, providerFileId). A
 * changed authoritative mapping (different providerFileId) creates a
 * new row; a row whose mapping has changed is not inherited by the
 * new mapping coordinate.
 *
 * Restarts: rows live in the control plane SQLite database, so they
 * survive a process restart. `pruneExpiredDeliveryEvidence` is
 * available so the durable store does not grow unbounded; it is
 * called lazily on read so an unpruned row past its expiresAt is
 * treated as absent.
 *
 * Ownership: this module is a thin wrapper over the control plane
 * store. It does NOT own placement, inventory, file mapping, or
 * authoritative size. Recording a terminal row does NOT mutate any
 * of those — the test A3 enforces that.
 */

export const TERMINAL_DELIVERY_STATES = Object.freeze({
  USABLE: 'usable',
  TEMPORARY: 'temporary',
  TERMINAL: 'terminal',
});

const DEFAULT_TERMINAL_TTL_MS = 10 * 60 * 1000;     // 10 minutes
const DEFAULT_TEMPORARY_TTL_MS = 5 * 60 * 1000;     // 5 minutes
const DEFAULT_USABLE_TTL_MS = 30 * 60 * 1000;       // 30 minutes

function normalizeInput(input) {
  return {
    provider: input.provider,
    accountScope: input.accountScope ?? 'default',
    placementId: input.placementId,
    providerFileId: input.providerFileId,
    infoHash: input.infoHash ?? null,
    fileIndexKey: input.fileIndexKey == null ? -1 : input.fileIndexKey,
    reason: input.reason ?? null,
    failureCategory: input.failureCategory ?? null,
    observedAt: input.observedAt,
  };
}

/**
 * Create a thin wrapper over the control plane store that exposes the
 * three recording helpers and a few pure lookups.
 *
 * @param {Object} params
 * @param {Object} params.controlPlaneStore - control plane store instance
 * @param {Function} [params.now] - clock function
 * @param {number} [params.terminalTtlMs] - TTL for terminal evidence
 * @param {number} [params.temporaryTtlMs] - TTL for temporary evidence
 * @param {number} [params.usableTtlMs] - TTL for usable evidence
 */
export function createTerminalDeliveryEvidenceStore({
  controlPlaneStore,
  now = () => Date.now(),
  terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
  temporaryTtlMs = DEFAULT_TEMPORARY_TTL_MS,
  usableTtlMs = DEFAULT_USABLE_TTL_MS,
} = {}) {
  if (!controlPlaneStore) {
    throw new TypeError('controlPlaneStore is required');
  }
  if (typeof controlPlaneStore.recordDeliveryEvidence !== 'function') {
    throw new TypeError('controlPlaneStore is missing recordDeliveryEvidence');
  }
  if (typeof controlPlaneStore.findDeliveryEvidence !== 'function') {
    throw new TypeError('controlPlaneStore is missing findDeliveryEvidence');
  }

  function ttlFor(state) {
    if (state === TERMINAL_DELIVERY_STATES.TERMINAL) return terminalTtlMs;
    if (state === TERMINAL_DELIVERY_STATES.TEMPORARY) return temporaryTtlMs;
    return usableTtlMs;
  }

  function recordState(state, input) {
    const normalized = normalizeInput(input);
    const observedAt = normalized.observedAt ?? now();
    return controlPlaneStore.recordDeliveryEvidence({
      ...normalized,
      state,
      observedAt,
      expiresAt: observedAt + ttlFor(state),
    });
  }

  function recordUsable(input) {
    return recordState(TERMINAL_DELIVERY_STATES.USABLE, input);
  }

  function recordTemporary(input) {
    return recordState(TERMINAL_DELIVERY_STATES.TEMPORARY, input);
  }

  function recordTerminal(input) {
    return recordState(TERMINAL_DELIVERY_STATES.TERMINAL, input);
  }

  /**
   * Look up a delivery evidence row by capability tuple. Treats
   * expired rows as absent (pruned lazily on read) so callers
   * never have to think about TTL.
   */
  function findTerminalEvidence({ provider, accountScope = 'default', placementId, providerFileId }) {
    const row = controlPlaneStore.findDeliveryEvidence({
      provider,
      accountScope,
      placementId,
      providerFileId,
    });
    if (!row) return null;
    if (row.expiresAt <= now()) return null;
    return row;
  }

  /**
   * Classify the provider state for a given (placement, file) tuple.
   * Returns one of TERMINAL_DELIVERY_STATES, or `usable` if no row
   * exists or the existing row has expired.
   */
  function classifyProviderState({ provider, accountScope = 'default', placementId, providerFileId }) {
    const row = findTerminalEvidence({ provider, accountScope, placementId, providerFileId });
    if (!row) return TERMINAL_DELIVERY_STATES.USABLE;
    return row.state;
  }

  return {
    recordUsable,
    recordTemporary,
    recordTerminal,
    findTerminalEvidence,
    classifyProviderState,
    listForCoordinate({ infoHash, fileIndexKey }) {
      const rows = controlPlaneStore.listDeliveryEvidenceForHash(infoHash, fileIndexKey ?? -1);
      return rows.filter((row) => row.expiresAt > now());
    },
    pruneExpired() {
      return controlPlaneStore.pruneExpiredDeliveryEvidence(now());
    },
  };
}
