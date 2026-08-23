import { classifyProviderError, ProviderOperationError } from '../errors.js';
import { createPlacementResource } from '../../acquisition/placement-resource.js';
import { createPlacementObservation } from '../../acquisition/placement-observation.js';
import { PLACEMENT_OBSERVATION_STATUSES } from '../../acquisition/placement-observation.js';

export const REALDEBRID_PROVIDER_ID = 'realdebrid';

export const REALDEBRID_API_BASE = 'https://api.real-debrid.com/rest/1.0';

const REALDEBRID_STATUS_MAP = Object.freeze({
  downloaded: PLACEMENT_OBSERVATION_STATUSES.READY,
  magnet_conversion: PLACEMENT_OBSERVATION_STATUSES.PROCESSING,
  waiting_files_selection: PLACEMENT_OBSERVATION_STATUSES.PROCESSING,
  queued: PLACEMENT_OBSERVATION_STATUSES.PROCESSING,
  downloading: PLACEMENT_OBSERVATION_STATUSES.PROCESSING,
  compressing: PLACEMENT_OBSERVATION_STATUSES.PROCESSING,
  uploading: PLACEMENT_OBSERVATION_STATUSES.PROCESSING,
  error: PLACEMENT_OBSERVATION_STATUSES.FAILED,
  dead: PLACEMENT_OBSERVATION_STATUSES.FAILED,
  virus: PLACEMENT_OBSERVATION_STATUSES.FAILED,
});

/**
 * Real-Debrid placement adapter — consumes the generic execution request
 * contract and delegates to the Real-Debrid REST API.
 *
 * This adapter is the first Real-Debrid-specific placement boundary. It proves
 * that the generic execution request can drive Real-Debrid placement without
 * changing the core acquisition pipeline.
 *
 * The adapter supports only:
 * - Placement submission via POST /rest/1.0/torrents/addMagnet
 * - Placement observation via GET /rest/1.0/torrents/info/{id}
 *
 * The adapter does NOT:
 * - select files
 * - retrieve unrestricted links
 * - generate playback URLs
 * - poll provider status
 * - track lifecycle state beyond observation
 * - handle retries
 * - expose files
 * - perform cleanup
 *
 * @param {Object} options
 * @param {string} options.apiKey - Real-Debrid API bearer token.
 * @param {Function} [options.fetchFn] - Fetch implementation (defaults to global fetch).
 * @param {number} [options.timeoutMs] - Request timeout in milliseconds.
 * @param {Function} [options.now] - Clock function (defaults to Date.now).
 * @returns {Object} Real-Debrid placement adapter with submit() and observe() methods.
 */
export function createRealDebridPlacementAdapter({
  apiKey,
  fetchFn = fetch,
  timeoutMs = 5_000,
  now = () => Date.now(),
} = {}) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('apiKey is required');
  }

  return Object.freeze({
    provider: REALDEBRID_PROVIDER_ID,

    /**
     * Submit a generic execution request to Real-Debrid for placement.
     *
     * @param {Object} input
     * @param {Object} input.executionRequest - Generic execution request from createExecutionRequest().
     * @returns {Promise<Object>} Frozen placement resource.
     */
    async submit({ executionRequest } = {}) {
      validateExecutionRequest(executionRequest);

      const magnet = executionRequest.locator?.locatorValue;
      if (!magnet || typeof magnet !== 'string') {
        throw new TypeError('executionRequest.locator.locatorValue (magnet) is required');
      }

      const body = new URLSearchParams();
      body.append('magnet', magnet);

      let response;
      try {
        response = await fetchFn(`${REALDEBRID_API_BASE}/torrents/addMagnet`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'media-search/0.0.1',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw classifyProviderError(error, {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'add-magnet',
        });
      }

      if (!response.ok) {
        const error = new Error(`Real-Debrid addMagnet failed: HTTP ${response.status}`);
        error.status = response.status;
        throw classifyProviderError(error, {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'add-magnet',
        });
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw classifyProviderError(error, {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'add-magnet',
        });
      }

      if (!payload || typeof payload !== 'object') {
        throw new ProviderOperationError('Real-Debrid addMagnet returned malformed response', {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'add-magnet',
          category: 'invalid-response',
          retryable: false,
        });
      }

      if (!payload.id || String(payload.id).trim() === '') {
        throw new ProviderOperationError('Real-Debrid addMagnet response missing id', {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'add-magnet',
          category: 'invalid-response',
          retryable: false,
        });
      }

      const providerResourceId = String(payload.id);

      return createPlacementResource({
        provider: REALDEBRID_PROVIDER_ID,
        accountScope: executionRequest.accountScope,
        providerResourceId,
        candidateIdentity: executionRequest.candidateIdentity,
        createdAt: executionRequest.createdAt,
      });
    },

    /**
     * Observe a Real-Debrid placement resource.
     *
     * @param {Object} input
     * @param {Object} input.placementResource - Placement resource from submit().
     * @param {number} [input.observedAt] - Explicit observation timestamp (ms).
     * @returns {Promise<Object>} Frozen placement observation.
     */
    async observe({ placementResource, observedAt = now() } = {}) {
      validatePlacementResource(placementResource);

      let response;
      try {
        response = await fetchFn(
          `${REALDEBRID_API_BASE}/torrents/info/${placementResource.providerResourceId}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: 'application/json',
              'User-Agent': 'media-search/0.0.1',
            },
            signal: AbortSignal.timeout(timeoutMs),
          }
        );
      } catch (error) {
        throw classifyProviderError(error, {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'torrents-info',
        });
      }

      if (!response.ok) {
        const error = new Error(`Real-Debrid torrents/info failed: HTTP ${response.status}`);
        error.status = response.status;
        throw classifyProviderError(error, {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'torrents-info',
        });
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw classifyProviderError(error, {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'torrents-info',
        });
      }

      if (!payload || typeof payload !== 'object') {
        throw new ProviderOperationError('Real-Debrid torrents/info returned malformed response', {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'torrents-info',
          category: 'invalid-response',
          retryable: false,
        });
      }

      if (!payload.status || typeof payload.status !== 'string') {
        throw new ProviderOperationError('Real-Debrid torrents/info response missing status', {
          provider: REALDEBRID_PROVIDER_ID,
          operation: 'torrents-info',
          category: 'invalid-response',
          retryable: false,
        });
      }

      const providerStatus = payload.status;
      const status = REALDEBRID_STATUS_MAP[providerStatus] ?? PLACEMENT_OBSERVATION_STATUSES.UNKNOWN;
      const progress = normalizeProgress(payload.progress);

      return createPlacementObservation({
        provider: REALDEBRID_PROVIDER_ID,
        accountScope: placementResource.accountScope,
        providerResourceId: placementResource.providerResourceId,
        placementStatus: status,
        providerStatus,
        progress,
        observedAt,
        error: status === PLACEMENT_OBSERVATION_STATUSES.FAILED
          ? { category: 'provider-failed', providerStatus }
          : null,
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

  if (executionRequest.provider !== REALDEBRID_PROVIDER_ID) {
    throw new TypeError(
      `Provider mismatch: expected ${REALDEBRID_PROVIDER_ID}, got ${executionRequest.provider}`
    );
  }

  if (!executionRequest.candidateIdentity) {
    throw new TypeError('executionRequest requires candidateIdentity');
  }

  if (!executionRequest.accountScope) {
    throw new TypeError('executionRequest requires accountScope');
  }
}

function validatePlacementResource(placementResource) {
  if (!placementResource || typeof placementResource !== 'object' || Array.isArray(placementResource)) {
    throw new TypeError('placementResource is required');
  }

  if (placementResource.provider !== REALDEBRID_PROVIDER_ID) {
    throw new TypeError(
      `Provider mismatch: expected ${REALDEBRID_PROVIDER_ID}, got ${placementResource.provider}`
    );
  }

  if (!placementResource.providerResourceId) {
    throw new TypeError('placementResource requires providerResourceId');
  }

  if (!placementResource.accountScope) {
    throw new TypeError('placementResource requires accountScope');
  }
}

function normalizeProgress(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return value;
}
