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
 * - Fresh TorBox cached observation → usable immediately (no RD calls)
 * - Stale/missing observation → use bounded playback revalidation
 * - Uncached → attempt bounded RD resolution if wired; skip to next candidate if not
 * - Provider-check error + RD wired → attempt bounded RD resolution; continue if not
 * - Provider-check error + RD not wired → skip to next candidate
 * - Neither TorBox nor RD usable → continue to next persisted candidate
 */

import { createRevalidator, REVALIDATION_OUTCOME } from './availability-revalidation.js';
import {
  attemptRdResolution,
  getRdPlaybackUrl,
  RdResolutionError,
} from '../providers/realdebrid/resolve.js';
import { RdCooldownError } from '../providers/realdebrid/client.js';

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
 * @param {Object} [dependencies.rdClient] - Real-Debrid client (resolver-safe). Optional.
 * @param {Object} [dependencies.rdResolutionCache] - Short-lived RD resolved-URL cache. Optional.
 */
export function createAlternateFallback(dependencies = {}) {
  const {
    searchCache,
    revalidator,
    now = () => Date.now(),
    rdClient = null,
    rdResolutionCache = null,
  } = dependencies;

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
  function loadPersistedResults(mediaId, season = null, episode = null) {
    // Scope the request lookup to (mediaId, season, episode) when provided so
    // series episodes get the matching episode request — not the latest
    // request for the media_id (which would be the wrong episode).
    const request = searchCache.getMediaRequestsByMediaId(mediaId, season, episode);
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
   * Attempt bounded Real-Debrid resolution for a fallback candidate.
   *
   * Mirrors the tv-webdav.js resolveBacking RD branch but is scoped to the
   * alternate-fallback path. Never throws — always resolves to a structured
   * result. Uses the in-memory rdResolutionCache (30s TTL) to coalesce
   * concurrent and short-interval requests.
   *
   * @param {Object} candidate - Filtered candidate (with .info_hash, .fileIndex, .filename)
   * @returns {Promise<{
   *   usable: boolean,
   *   provider: 'realdebrid' | null,
   *   url: string | null,
   *   releaseKey: string,
   *   infoHash: string,
   *   fileIndex: number | null,
   *   rdFileId: string | null,
   *   torrentId: string | null,
   *   resolution: 'cache' | 'fresh' | null,
   *   reason: string | null,
   *   error: string | null,
   * }>}
   */
  async function attemptRdResolutionFromAlternate(candidate) {
    const empty = {
      usable: false,
      provider: null,
      url: null,
      releaseKey: candidate?.releaseKey ?? null,
      infoHash: candidate?.info_hash ?? null,
      fileIndex: candidate?.fileIndex ?? null,
      rdFileId: null,
      torrentId: null,
      resolution: null,
      reason: 'unwired',
      error: null,
    };

    if (!rdClient || !rdResolutionCache) {
      return { ...empty, reason: 'unwired' };
    }
    if (!candidate || !candidate.info_hash) {
      return { ...empty, reason: 'invalid_candidate' };
    }

    const infoHash = candidate.info_hash;
    const fileIndex = candidate.fileIndex ?? null;
    const filename = candidate.filename ?? null;
    const size = Number.isFinite(candidate.size) ? candidate.size : null;

    try {
      // (a) check rdResolutionCache for a fresh entry
      const cached = rdResolutionCache.get(infoHash, fileIndex);
      if (cached && cached.url) {
        return {
          usable: true,
          provider: 'realdebrid',
          url: cached.url,
          releaseKey: candidate.releaseKey,
          infoHash,
          fileIndex,
          rdFileId: cached.rdFileId ?? null,
          torrentId: cached.torrentId ?? null,
          resolution: 'cache',
          reason: null,
          error: null,
        };
      }

      // (b) miss → attempt bounded RD resolution (single-flight)
      const result = await rdResolutionCache.getOrInFlight(
        infoHash,
        fileIndex,
        () => attemptRdResolution(
          rdClient,
          searchCache,
          { infoHash, fileIndex, filename, size },
          { now },
        ),
      );

      if (!result || result.status === 'skipped') {
        return {
          ...empty,
          releaseKey: candidate.releaseKey,
          infoHash,
          fileIndex,
          reason: result?.reason ? `skipped:${result.reason}` : 'skipped',
        };
      }

      if (result.status === 'failed') {
        const code = result.error?.code || 'RD_ERROR';
        return {
          ...empty,
          releaseKey: candidate.releaseKey,
          infoHash,
          fileIndex,
          reason: code,
          error: result.error?.message || null,
        };
      }

      // (c) resolved → fetch unrestricted playback URL
      let url;
      try {
        url = await getRdPlaybackUrl(rdClient, result.torrentInfo, result.rdFileId);
      } catch (unrestrictError) {
        const code = unrestrictError?.code || 'RD_UNRESTRICT_FAILED';
        return {
          ...empty,
          releaseKey: candidate.releaseKey,
          infoHash,
          fileIndex,
          reason: code,
          error: unrestrictError?.message || null,
        };
      }

      if (!url) {
        return {
          ...empty,
          releaseKey: candidate.releaseKey,
          infoHash,
          fileIndex,
          reason: 'RD_NO_URL',
        };
      }

      // (d) cache the result (30s TTL default)
      try {
        rdResolutionCache.set(infoHash, fileIndex, url, result.torrentId, result.rdFileId, 30_000);
      } catch (cacheError) {
        // Cache failure must never block resolution success.
        console.warn('[alternate-fallback] rdResolutionCache.set failed: ' + cacheError.message);
      }

      // (e) success
      return {
        usable: true,
        provider: 'realdebrid',
        url,
        releaseKey: candidate.releaseKey,
        infoHash,
        fileIndex,
        rdFileId: result.rdFileId ?? null,
        torrentId: result.torrentId ?? null,
        resolution: 'fresh',
        reason: null,
        error: null,
      };
    } catch (err) {
      // Defensive: never throw. Cooldown / resolution errors get typed reasons.
      if (err instanceof RdCooldownError) {
        return {
          ...empty,
          releaseKey: candidate?.releaseKey ?? null,
          infoHash,
          fileIndex,
          reason: 'RD_COOLDOWN',
          error: err.message,
        };
      }
      if (err instanceof RdResolutionError) {
        return {
          ...empty,
          releaseKey: candidate?.releaseKey ?? null,
          infoHash,
          fileIndex,
          reason: err.code || 'RD_ERROR',
          error: err.message,
        };
      }
      return {
        ...empty,
        releaseKey: candidate?.releaseKey ?? null,
        infoHash,
        fileIndex,
        reason: 'RD_EXCEPTION',
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Check availability of a candidate using the revalidator, and attempt
   * bounded RD resolution when RD is wired AND TorBox does not already
   * confirm the candidate as cached.
   *
   * Milestone contract:
   *   - Usable existing provider placement → use it (no RD calls)
   *   - Provider unusable → bounded same-TorrentFile cross-provider fallback
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

    const isTorBoxCached = revalidation.cacheState === REVALIDATION_OUTCOME.CACHED;

    // Only attempt RD resolution when TorBox does NOT confirm the candidate
    // as cached. A usable TorBox placement must be used as-is — no
    // cross-provider calls merely because RD is wired.
    const rdResolution = isTorBoxCached
      ? null
      : await attemptRdResolutionFromAlternate(candidate);

    return {
      candidate,
      revalidation,
      rdResolution,
      isUsable: isTorBoxCached || (rdResolution && rdResolution.usable),
      isUncached: revalidation.cacheState === REVALIDATION_OUTCOME.UNCACHED,
      isUnknown: revalidation.cacheState === REVALIDATION_OUTCOME.UNKNOWN,
    };
  }

  /**
   * Find the first usable alternate candidate.
   *
   * Selection rule (milestone contract):
   *   - TorBox CACHED → use it (no RD calls, no cross-provider work)
   *   - TorBox UNCACHED/UNKNOWN + RD usable → return usable via RD
   *   - Both fail → continue to next candidate
   *
   * @param {Object} params
   * @param {string} params.mediaId - Media identifier
   * @param {string} params.primaryReleaseKey - Release key of the primary candidate
   * @param {Object} params.expectedScope - Expected media scope
   * @param {Set<string>} [params.additionalAttemptedKeys] - Other attempted keys
   * @returns {Promise<Object|null>} First usable alternate or null
   */
  async function findUsableAlternate({ mediaId, primaryReleaseKey, expectedScope, additionalAttemptedKeys = new Set() }) {
    // Scope the persisted-results load to the same episode the caller is
    // resolving. expectedScope is the source of truth: when it carries
    // season/episode, only that episode's request is relevant.
    const season = expectedScope?.season ?? null;
    const episode = expectedScope?.episode ?? null;
    const results = loadPersistedResults(mediaId, season, episode);
    if (results.length === 0) return null;

    const attemptedReleaseKeys = new Set([primaryReleaseKey, ...additionalAttemptedKeys]);
    const candidates = filterCandidates(results, {
      mediaId,
      expectedScope,
      attemptedReleaseKeys,
    });

    for (const candidate of candidates) {
      // Revalidate TorBox availability first.
      const revalidation = await revalidator.revalidateAvailability({
        cache: searchCache,
        infoHash: candidate.info_hash,
        mediaId: candidate.media_id || '',
        releaseKey: candidate.releaseKey,
        provider: 'torbox',
      });

      // TorBox confirms cached → use it without any RD calls.
      if (revalidation.cacheState === REVALIDATION_OUTCOME.CACHED) {
        return {
          candidate,
          revalidation,
          rdResolution: null,
        };
      }

      // TorBox unavailable — attempt bounded RD resolution only when needed.
      const rdResolution = await attemptRdResolutionFromAlternate(candidate);
      if (rdResolution && rdResolution.usable) {
        return {
          candidate,
          revalidation,
          rdResolution,
        };
      }

      // Both TorBox and RD unavailable → continue to next candidate.
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
    attemptRdResolutionFromAlternate,
    attemptRdResolution,
  };
}
