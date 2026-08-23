import { PROVIDER_CAPABILITIES } from './capabilities.js';

export const TORBOX_EXECUTION_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
});

export const TORBOX_PROVIDER_ID = 'torbox';

/**
 * TorBox-specific execution adapter — consumes the generic execution request
 * contract and delegates to the existing TorBox placement capability.
 *
 * This adapter is the first provider-specific execution boundary. It proves
 * that the generic execution request can drive provider placement without
 * changing the core acquisition pipeline.
 *
 * The adapter does NOT:
 * - generate magnets from infoHash (no magic conversion)
 * - poll provider status
 * - track lifecycle state
 * - handle retries
 * - expose files
 * - perform cleanup
 *
 * The adapter requires a magnet resolver — an external data source that
 * already knows how to map candidate identities to magnets. The adapter
 * never invents missing acquisition data.
 *
 * @param {Object} options
 * @param {Function} options.getMagnetForIdentity - async (candidateIdentity) => magnet string
 * @returns {Object} TorBox execution adapter with submit() method.
 */
export function createTorBoxExecutionAdapter({ getMagnetForIdentity } = {}) {
  if (typeof getMagnetForIdentity !== 'function') {
    throw new TypeError('getMagnetForIdentity is required');
  }

  return Object.freeze({
    provider: TORBOX_PROVIDER_ID,

    /**
     * Submit a generic execution request to TorBox for placement.
     *
     * @param {Object} input
     * @param {Object} input.executionRequest - Generic execution request from createExecutionRequest().
     * @param {Object} input.providerCapability - Provider adapter supporting PLACEMENT_CREATE.
     * @returns {Promise<Object>} Frozen placement submission result.
     */
    async submit({ executionRequest, providerCapability } = {}) {
      validateExecutionRequest(executionRequest);
      validateProviderCapability(providerCapability);

      const magnet = await getMagnetForIdentity(executionRequest.candidateIdentity);
      if (!magnet || typeof magnet !== 'string') {
        throw new TypeError('No magnet available for candidate identity');
      }

      const placementCapability = providerCapability.require(
        PROVIDER_CAPABILITIES.PLACEMENT_CREATE
      );

      const placementResult = await placementCapability.createPlacement({
        magnet,
        addOnlyIfCached: true,
      });

      return Object.freeze({
        status: TORBOX_EXECUTION_STATUS.SUBMITTED,
        provider: TORBOX_PROVIDER_ID,
        providerResourceId: placementResult.providerResourceId,
        infoHash: placementResult.infoHash,
        accountScope: executionRequest.accountScope,
        createdAt: executionRequest.createdAt,
      });
    },
  });
}

function validateExecutionRequest(executionRequest) {
  if (!executionRequest || typeof executionRequest !== 'object' || Array.isArray(executionRequest)) {
    throw new TypeError('executionRequest is required');
  }

  if (executionRequest.executionStatus === 'deferred') {
    throw new TypeError('Cannot submit deferred execution request');
  }

  if (executionRequest.executionStatus === 'unavailable') {
    throw new TypeError('Cannot submit unavailable execution request');
  }

  if (executionRequest.executionStatus !== 'ready') {
    throw new TypeError(`Unknown execution status: ${executionRequest.executionStatus}`);
  }

  if (executionRequest.action !== 'place') {
    throw new TypeError(`Unsupported action: ${executionRequest.action}`);
  }

  if (executionRequest.provider !== TORBOX_PROVIDER_ID) {
    throw new TypeError(
      `Provider mismatch: expected ${TORBOX_PROVIDER_ID}, got ${executionRequest.provider}`
    );
  }

  if (!executionRequest.candidateIdentity) {
    throw new TypeError('executionRequest requires candidateIdentity');
  }

  if (!executionRequest.accountScope) {
    throw new TypeError('executionRequest requires accountScope');
  }
}

function validateProviderCapability(providerCapability) {
  if (!providerCapability || typeof providerCapability !== 'object' || Array.isArray(providerCapability)) {
    throw new TypeError('providerCapability is required');
  }

  if (typeof providerCapability.require !== 'function') {
    throw new TypeError('providerCapability must implement require()');
  }

  if (!providerCapability.supports(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)) {
    throw new TypeError('providerCapability must support placement-create');
  }
}
