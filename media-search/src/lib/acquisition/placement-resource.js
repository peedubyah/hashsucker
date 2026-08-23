export const PLACEMENT_RESOURCE_STATUSES = Object.freeze({
  SUBMITTED: 'submitted',
});

/**
 * Pure factory for a generic provider placement resource — the contract
 * representing a placement after an execution adapter accepts an execution
 * request.
 *
 * This function does NOT:
 * - call provider APIs
 * - poll provider status
 * - check completion
 * - expose files
 * - schedule workers
 * - perform retries
 *
 * It is a pure boundary that captures the identity of a placement resource
 * without lifecycle management. Future slices will add provider lifecycle
 * adapters on top of this boundary.
 *
 * @param {Object} input
 * @param {string} input.provider - Provider identifier.
 * @param {string} input.accountScope - Account scope.
 * @param {string} input.providerResourceId - Provider-assigned resource ID.
 * @param {Object} input.candidateIdentity - Exact (infoHash, fileIndex) identity.
 * @param {number} input.createdAt - Explicit timestamp (ms).
 * @returns {Object} Frozen placement resource.
 */
export function createPlacementResource({
  provider,
  accountScope,
  providerResourceId,
  candidateIdentity,
  createdAt,
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
  if (!candidateIdentity || typeof candidateIdentity !== 'object' || Array.isArray(candidateIdentity)) {
    throw new TypeError('candidateIdentity is required');
  }
  if (candidateIdentity.infoHash == null) {
    throw new TypeError('candidateIdentity.infoHash is required');
  }
  if (candidateIdentity.releaseKey == null) {
    throw new TypeError('candidateIdentity.releaseKey is required');
  }
  if (createdAt === undefined || createdAt === null) {
    throw new TypeError('createdAt is required');
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new TypeError('createdAt must be a non-negative millisecond timestamp');
  }

  return Object.freeze({
    provider,
    accountScope,
    providerResourceId,
    candidateIdentity: Object.freeze({
      infoHash: candidateIdentity.infoHash,
      fileIndex: candidateIdentity.fileIndex ?? null,
      releaseKey: candidateIdentity.releaseKey,
    }),
    placementStatus: PLACEMENT_RESOURCE_STATUSES.SUBMITTED,
    createdAt,
  });
}
