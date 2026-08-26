/**
 * Play-Time Availability Revalidation
 *
 * Decides whether a stored TorBox observation is fresh enough to trust
 * at playback time. If stale or missing, performs exactly one bounded
 * authoritative TorBox cache check.
 *
 * Decision tree:
 *   stored selection
 *     ↓
 *   latest TorBox observation
 *     ↓
 *   fresh?
 *     ┌───┴────┐
 *    yes       no
 *     │         │
 *     │    authoritative TorBox check
 *     │         │
 *     └────┬────┘
 *          ↓
 *    cached?
 *    ┌─────┴─────┐
 *   yes          no
 *    │            │
 *   307       typed failure
 *
 * Design constraints:
 * - Zero provider calls when a fresh observation exists.
 * - Exactly one provider call when observation is stale/missing.
 * - A provider check failure never overwrites a previous cached observation.
 * - Returns structured telemetry for every outcome.
 */

import { createCacheObservation, evaluateObservationFreshness } from '../providers/observations.js';

export const REVALIDATION_SOURCE = Object.freeze({
  STORED_FRESH: 'stored-fresh',
  PLAYBACK_REVALIDATION: 'playback-revalidation',
});

export const REVALIDATION_OUTCOME = Object.freeze({
  CACHED: 'cached',
  UNCACHED: 'uncached',
  UNKNOWN: 'unknown',
});

export class RevalidationError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'RevalidationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Create an availability revalidator with injected dependencies.
 *
 * @param {Object} dependencies
 * @param {Function} dependencies.checkTorBoxCached - TorBox cache check function
 * @param {Function} [dependencies.now] - Clock function
 * @param {number} [dependencies.maxAgeMs] - Freshness window in ms
 * @param {number} [dependencies.checkTimeoutMs] - Timeout for provider check
 * @param {string} [dependencies.apiKey] - TorBox API key
 * @param {Function} [dependencies.fetchFn] - Fetch function for testing
 */
export function createRevalidator(dependencies = {}) {
  const {
    checkTorBoxCached,
    now = () => Date.now(),
    maxAgeMs = 5 * 60 * 1000,
    checkTimeoutMs = 3000,
    apiKey,
    fetchFn,
  } = dependencies;

  if (typeof checkTorBoxCached !== 'function') {
    throw new TypeError('checkTorBoxCached function is required');
  }

  /**
   * Find the most recent authoritative TorBox observation for a hash.
   *
   * @param {Object} cache - Discovery cache with getProviderObservations
   * @param {string} infoHash - 40-char hex info hash
   * @param {number|null} fileIndex - File index or null for torrent-level
   * @returns {Object|null} Latest TorBox observation or null
   */
  function getLatestTorBoxObservation(cache, infoHash, fileIndex) {
    const observations = cache.getProviderObservations(infoHash, fileIndex, {
      includeStale: true,
      kinds: ['authoritative'],
    });

    const torboxObservations = observations.filter((o) => o.provider === 'torbox');
    if (torboxObservations.length === 0) return null;

    // Return the most recent
    return torboxObservations.reduce((latest, obs) =>
      obs.observedAt > latest.observedAt ? obs : latest
    );
  }

  /**
   * Check if an observation is fresh enough to reuse without a provider call.
   *
   * Freshness is based on age (observedAt within maxAgeMs), not expiresAt.
   * This ensures we make zero calls when a recent authoritative observation exists.
   *
   * @param {Object} observation - Provider observation
   * @returns {boolean} True if fresh enough to trust
   */
  function isFreshEnough(observation) {
    const freshness = evaluateObservationFreshness(observation, { now: now() });
    return freshness.ageMs < maxAgeMs;
  }

  /**
   * Persist a TorBox cache check result as an authoritative observation.
   *
   * @param {Object} cache - Discovery cache with appendProviderObservation
   * @param {string} infoHash - Info hash
   * @param {string} state - 'cached' | 'uncached' | 'unknown'
   * @param {number} latencyMs - Check latency
   * @param {Object|null} fileMetadata - Provider file metadata
   * @param {string|null} errorCategory - Error category if failed
   * @returns {Object} Persisted observation
   */
  function persistObservation(cache, infoHash, state, latencyMs, fileMetadata, errorCategory) {
    const observation = createCacheObservation({
      provider: 'torbox',
      accountScope: 'default',
      scope: 'torrent',
      infoHash,
      fileIndex: null,
      kind: 'authoritative',
      state,
      observedAt: now(),
      expiresAt: now() + maxAgeMs,
      source: 'playback-revalidation',
      evidence: fileMetadata ? { fileMetadata } : null,
      errorCategory,
      retryable: state === 'unknown',
      latencyMs,
    });

    cache.appendProviderObservation(observation);
    return observation;
  }

  /**
   * Perform exactly one bounded TorBox cache check.
   *
   * @param {Object} cache - Discovery cache for persistence
   * @param {string} infoHash - Info hash
   * @returns {Object} Check result with state, latency, and persisted observation
   */
  async function checkOnce(cache, infoHash) {
    const checkStart = now();
    const normalizedHash = infoHash.toLowerCase();

    try {
      const result = await checkTorBoxCached([normalizedHash], {
        apiKey,
        fetchFn,
        timeoutMs: checkTimeoutMs,
      });

      const latency = now() - checkStart;
      const isCached = result.cached.has(normalizedHash);
      const isFailed = result.failed.has(normalizedHash);
      const fileMetadata = result.details.get(normalizedHash) || null;
      const hashLatency = result.latencyMs.get(normalizedHash) || latency;

      if (isFailed) {
        // Provider check itself failed — do NOT mark as uncached
        const observation = persistObservation(
          cache,
          infoHash,
          'unknown',
          hashLatency,
          null,
          'temporarily-unavailable'
        );
        return {
          cacheState: REVALIDATION_OUTCOME.UNKNOWN,
          latencyMs: hashLatency,
          observation,
          providerCheckOccurred: true,
          checkError: null,
        };
      }

      const state = isCached ? REVALIDATION_OUTCOME.CACHED : REVALIDATION_OUTCOME.UNCACHED;
      const observation = persistObservation(
        cache,
        infoHash,
        state,
        hashLatency,
        fileMetadata,
        null
      );

      return {
        cacheState: state,
        latencyMs: hashLatency,
        observation,
        providerCheckOccurred: true,
        checkError: null,
      };
    } catch (error) {
      // Global failure (auth, network) — do NOT mark as uncached
      const latency = now() - checkStart;
      const observation = persistObservation(
        cache,
        infoHash,
        'unknown',
        latency,
        null,
        'temporarily-unavailable'
      );
      return {
        cacheState: REVALIDATION_OUTCOME.UNKNOWN,
        latencyMs: latency,
        observation,
        providerCheckOccurred: true,
        checkError: error.message,
      };
    }
  }

  /**
   * Revalidate availability for a stored selection.
   *
   * @param {Object} params
   * @param {Object} params.cache - Discovery cache
   * @param {string} params.infoHash - Selected info hash
   * @param {string} params.mediaId - Media identifier for telemetry
   * @param {string} params.releaseKey - Release key for telemetry
   * @param {string} params.provider - Provider name for telemetry
   * @returns {Promise<Object>} Revalidation result with telemetry
   */
  async function revalidateAvailability({ cache, infoHash, mediaId, releaseKey, provider }) {
    const latestObservation = getLatestTorBoxObservation(cache, infoHash, null);
    const previousObservationAge = latestObservation
      ? now() - latestObservation.observedAt
      : null;

    // Case 1: Fresh observation exists — reuse it, zero provider calls
    if (latestObservation && isFreshEnough(latestObservation)) {
      return {
        availabilitySource: REVALIDATION_SOURCE.STORED_FRESH,
        cacheState: latestObservation.state === 'cached'
          ? REVALIDATION_OUTCOME.CACHED
          : latestObservation.state === 'uncached'
            ? REVALIDATION_OUTCOME.UNCACHED
            : REVALIDATION_OUTCOME.UNKNOWN,
        mediaId,
        releaseKey,
        infoHash,
        provider,
        previousObservationAge,
        providerCheckOccurred: false,
        checkLatencyMs: null,
        observation: latestObservation,
      };
    }

    // Case 2: Stale or missing observation — perform one bounded check
    const checkResult = await checkOnce(cache, infoHash);

    return {
      availabilitySource: REVALIDATION_SOURCE.PLAYBACK_REVALIDATION,
      cacheState: checkResult.cacheState,
      mediaId,
      releaseKey,
      infoHash,
      provider,
      previousObservationAge,
      providerCheckOccurred: true,
      checkLatencyMs: checkResult.latencyMs,
      observation: checkResult.observation,
      checkError: checkResult.checkError,
    };
  }

  return {
    revalidateAvailability,
    getLatestTorBoxObservation,
    isFreshEnough,
  };
}

/**
 * Map a revalidation result to an HTTP outcome for the resolver.
 *
 * @param {Object} revalidation - Result from revalidateAvailability()
 * @returns {{ status: number, body: Object, shouldRedirect: boolean }}
 */
export function mapRevalidationToHttp(revalidation) {
  if (revalidation.cacheState === REVALIDATION_OUTCOME.CACHED) {
    return { status: 307, body: null, shouldRedirect: true };
  }

  if (revalidation.cacheState === REVALIDATION_OUTCOME.UNCACHED) {
    return {
      status: 409,
      body: {
        error: 'Selected release is no longer cached on provider',
        code: 'PROVIDER_NOT_CACHED',
        mediaId: revalidation.mediaId,
        releaseKey: revalidation.releaseKey,
        availabilitySource: revalidation.availabilitySource,
      },
      shouldRedirect: false,
    };
  }

  // UNKNOWN — provider check failed
  return {
    status: 503,
    body: {
      error: 'Provider availability check failed',
      code: 'PROVIDER_CHECK_FAILED',
      mediaId: revalidation.mediaId,
      releaseKey: revalidation.releaseKey,
      availabilitySource: revalidation.availabilitySource,
      ...(revalidation.checkError ? { detail: revalidation.checkError } : {}),
    },
    shouldRedirect: false,
  };
}
