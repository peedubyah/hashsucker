/**
 * Alternate Stored Candidate Fallback
 *
 * If the currently persisted selected candidate cannot be used at playback time,
 * try the next already-ranked eligible candidate from persisted request results.
 *
 * Design constraints:
 * - Does not re-run discovery
 * - Does not re-rank
 * - Does not change identity tiers
 * - Does not change persisted scores
 * - Uses original persisted candidate order from media request
 * - Ineligible candidates can never be used as fallback
 * - Wrong season/episode candidates can never be used
 * - Preserves fileIndex = null distinctly from 0
 * - Avoids duplicate hashes/releaseKeys in fallback chain
 *
 * Availability behavior:
 * - Fresh cached observation → usable immediately
 * - Stale/missing observation → use bounded playback revalidation
 * - Uncached → skip to next persisted candidate
 * - Provider-check error → record failure and continue only if another candidate exists
 */

import { createRevalidator, REVALIDATION_OUTCOME } from './availability-revalidation.js';

export const FALLBACK_REASON = Object.freeze({
  PRIMARY_UNAVAILABLE: 'primary unavailable; next persisted eligible cached candidate',
  PRIMARY_PROVIDER_ERROR: 'primary provider check failed; next persisted eligible cached candidate',
});

export class FallbackError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'FallbackError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Create an alternate candidate fallback handler.
 *
 * @param {Object} dependencies
 * @param {Object} dependencies.searchCache - Discovery cache for loading persisted results
 * @param {Object} dependencies.revalidator - Availability revalidator instance
 * @param {Function} [dependencies.now] - Clock function
 */
export function createAlternateFallback(dependencies = {}) {
  const { searchCache, revalidator, now = () => Date.now() } = dependencies;

  if (!searchCache) {
    throw new TypeError('searchCache is required');
  }
  if (!revalidator) {
    throw new TypeError('revalidator is required');
  }

  /**
   * Load persisted request results for a media identity.
   *
   * @param {string} mediaId - Media identifier
   * @returns {Array<Object>} Persisted results ordered by rank
   */
  function loadPersistedResults(mediaId) {
    const request = searchCache.getMediaRequestsByMediaId(mediaId);
    if (!request) return [];

    const results = searchCache.getMediaRequestResults(request.id);
    return results;
  }

  /**
   * Check if a candidate is eligible for fallback.
   *
   * @param {Object} result - Persisted media_request_result row
   * @returns {boolean} True if eligible
   */
  function isEligible(result) {
    return result.eligible === 1 || result.eligible === true;
  }

  /**
   * Check if a candidate matches the expected media scope.
   *
   * @param {Object} result - Persisted media_request_result row
   * @param {Object} expectedScope - Expected scope from the request
   * @returns {boolean} True if scope matches
   */
  function matchesScope(result, expectedScope) {
    // If no scope info available, include the candidate (conservative)
    if (!result.expected_media_scope || !result.parsed_candidate_scope) {
      return true;
    }

    try {
      const expected = JSON.parse(result.expected_media_scope);
      const parsed = JSON.parse(result.parsed_candidate_scope);

      // For TV episodes, season and episode must match
      if (expected.season !== undefined && expected.season !== null) {
        if (parsed.season !== expected.season) return false;
      }
      if (expected.episode !== undefined && expected.episode !== null) {
        if (parsed.episode !== expected.episode) return false;
      }
      // For movies, media_type must match
      if (expected.media_type === 'movie') {
        if (parsed.media_type && parsed.media_type !== 'movie') return false;
      }
      return true;
    } catch {
      // If parsing fails, include the candidate (conservative)
      return true;
    }
  }

  /**
   * Build a release key from info hash and file index.
   *
   * @param {string} infoHash - Info hash
   * @param {number|null} fileIndex - File index or null
   * @returns {string} Release key
   */
  function buildReleaseKey(infoHash, fileIndex) {
    if (fileIndex === null || fileIndex === undefined) {
      return `${infoHash}:torrent`;
    }
    return `${infoHash}:${fileIndex}`;
  }

  /**
   * Filter candidates for fallback eligibility.
   *
   * @param {Array<Object>} results - Persisted results
   * @param {Object} options
   * @param {string} options.mediaId - Media identifier
   * @param {Object} options.expectedScope - Expected media scope
   * @param {Set<string>} options.attemptedReleaseKeys - Already-attempted release keys
   * @returns {Array<Object>} Filtered candidates
   */
  function filterCandidates(results, { mediaId, expectedScope, attemptedReleaseKeys }) {
    const seenReleaseKeys = new Set();
    const filtered = [];

    for (const result of results) {
      // Skip ineligible candidates
      if (!isEligible(result)) continue;

      // Skip wrong scope candidates
      if (!matchesScope(result, expectedScope)) continue;

      // Build release key
      const fileIndex = result.file_index_key === -1 ? null : result.file_index_key;
      const releaseKey = buildReleaseKey(result.info_hash, fileIndex);

      // Skip duplicates
      if (seenReleaseKeys.has(releaseKey)) continue;
      if (attemptedReleaseKeys.has(releaseKey)) continue;

      seenReleaseKeys.add(releaseKey);
      filtered.push({
        ...result,
        releaseKey,
        fileIndex,
      });
    }

    return filtered;
  }

  /**
   * Check availability of a candidate using the revalidator.
   *
   * @param {Object} candidate - Filtered candidate
   * @returns {Promise<Object>} Availability result
   */
  async function checkCandidateAvailability(candidate) {
    const revalidation = await revalidator.revalidateAvailability({
      cache: searchCache,
      infoHash: candidate.info_hash,
      mediaId: candidate.media_id || '',
      releaseKey: candidate.releaseKey,
      provider: 'torbox',
    });

    return {
      candidate,
      revalidation,
      isUsable: revalidation.cacheState === REVALIDATION_OUTCOME.CACHED,
      isUncached: revalidation.cacheState === REVALIDATION_OUTCOME.UNCACHED,
      isUnknown: revalidation.cacheState === REVALIDATION_OUTCOME.UNKNOWN,
    };
  }

  /**
   * Find the first usable alternate candidate.
   *
   * @param {Object} params
   * @param {string} params.mediaId - Media identifier
   * @param {string} params.primaryReleaseKey - Release key of the primary candidate
   * @param {Object} params.expectedScope - Expected media scope
   * @param {Set<string>} [params.additionalAttemptedKeys] - Other attempted keys
   * @returns {Promise<Object|null>} First usable alternate or null
   */
  async function findUsableAlternate({ mediaId, primaryReleaseKey, expectedScope, additionalAttemptedKeys = new Set() }) {
    const results = loadPersistedResults(mediaId);
    if (results.length === 0) return null;

    const attemptedReleaseKeys = new Set([primaryReleaseKey, ...additionalAttemptedKeys]);
    const candidates = filterCandidates(results, {
      mediaId,
      expectedScope,
      attemptedReleaseKeys,
    });

    for (const candidate of candidates) {
      const availability = await checkCandidateAvailability(candidate);

      if (availability.isUsable) {
        return {
          candidate: availability.candidate,
          revalidation: availability.revalidation,
        };
      }

      // Uncached → skip to next
      if (availability.isUncached) continue;

      // Unknown (provider check error) → skip to next
      if (availability.isUnknown) continue;
    }

    return null;
  }

  /**
   * Build fallback telemetry extra fields.
   *
   * @param {Object} params
   * @param {string} params.originalReleaseKey - Original primary release key
   * @param {string} params.selectedReleaseKey - Selected fallback release key
   * @param {number} params.fallbackRank - Rank of the fallback candidate
   * @param {string} params.reason - Fallback reason
   * @returns {Object} Extra telemetry fields
   */
  function buildFallbackTelemetry({ originalReleaseKey, selectedReleaseKey, fallbackRank, reason }) {
    return {
      fallbackUsed: true,
      originalReleaseKey,
      selectedReleaseKey,
      fallbackRank,
      reason,
    };
  }

  return {
    loadPersistedResults,
    isEligible,
    matchesScope,
    buildReleaseKey,
    filterCandidates,
    checkCandidateAvailability,
    findUsableAlternate,
    buildFallbackTelemetry,
  };
}
