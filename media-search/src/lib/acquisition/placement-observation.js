export const PLACEMENT_OBSERVATION_STATUSES = Object.freeze({
  SUBMITTED: 'submitted',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

const VALID_STATUSES = new Set(Object.values(PLACEMENT_OBSERVATION_STATUSES));

/**
 * Pure factory for a generic placement observation — the contract for observing
 * provider-created resources.
 *
 * This function represents "What is the current observed state of a provider
 * resource?" without performing any provider calls, polling, or lifecycle
 * management.
 *
 * The function does NOT:
 * - call provider APIs
 * - poll provider status
 * - encode Real-Debrid or TorBox specific statuses
 * - expose files, links, or download URLs
 *
 * Provider-specific states are preserved in `providerStatus`. The generic
 * `status` field is normalized to a provider-neutral enum.
 *
 * @param {Object} input
 * @param {string} input.provider - Provider identifier.
 * @param {string} input.accountScope - Account scope.
 * @param {string} input.providerResourceId - Provider-assigned resource ID.
 * @param {string} input.placementStatus - Current placement status.
 * @param {string} [input.providerStatus] - Provider-specific status string.
 * @param {number|null} [input.progress] - Progress percentage (0-100) or null.
 * @param {number} input.observedAt - Explicit observation timestamp (ms).
 * @param {Object|null} [input.error] - Error information if failed.
 * @returns {Object} Frozen placement observation.
 */
export function createPlacementObservation({
  provider,
  accountScope,
  providerResourceId,
  placementStatus,
  providerStatus = null,
  progress = null,
  observedAt,
  error = null,
} = {}) {
  if (!provider || typeof provider !== 'string') {
    throw new TypeError('provider is required');
  }
  if (!accountScope || typeof accountScope !== 'string') {
    throw new TypeError('accountScope is required');
  }
  if (!providerResourceId || typeof providerResourceId !== 'string') {
    throw new TypeError('providerResourceId is required');
  }
  if (!placementStatus || typeof placementStatus !== 'string') {
    throw new TypeError('placementStatus is required');
  }
  if (!VALID_STATUSES.has(placementStatus)) {
    throw new TypeError(`Invalid placement status: ${placementStatus}`);
  }
  if (providerStatus !== null && typeof providerStatus !== 'string') {
    throw new TypeError('providerStatus must be a string or null');
  }
  if (progress !== null) {
    if (typeof progress !== 'number' || !Number.isFinite(progress)) {
      throw new TypeError('progress must be a finite number or null');
    }
    if (progress < 0 || progress > 100) {
      throw new TypeError('progress must be between 0 and 100');
    }
  }
  if (observedAt === undefined || observedAt === null) {
    throw new TypeError('observedAt is required');
  }
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new TypeError('observedAt must be a non-negative millisecond timestamp');
  }
  if (error !== null) {
    if (typeof error !== 'object' || Array.isArray(error)) {
      throw new TypeError('error must be an object or null');
    }
    if (!error.category || typeof error.category !== 'string') {
      throw new TypeError('error.category is required');
    }
  }

  return Object.freeze({
    provider,
    accountScope,
    providerResourceId,
    status: placementStatus,
    providerStatus,
    progress,
    observedAt,
    error: error ? Object.freeze({ ...error }) : null,
  });
}
