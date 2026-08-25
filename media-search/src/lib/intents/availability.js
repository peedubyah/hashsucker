/**
 * Availability Checker Service
 *
 * Checks whether media-request candidates are currently available from providers.
 * Currently supports TorBox only.
 *
 * Flow:
 *   media_intent → media_request → ranked candidates → availability checker → provider_observations
 *
 * Features:
 * - Batched cache checking via TorBox API
 * - Rate limiting (requests/minute, concurrency)
 * - Freshness handling (reuse recent observations)
 * - Preserves provider-returned file IDs
 */

import { checkTorBoxCached } from '../providers/torbox.js';
import { createCacheObservation } from '../providers/observations.js';
import { evaluateObservationFreshness } from '../providers/observations.js';

/**
 * @typedef {Object} AvailabilityConfig
 * @property {string} [apiKey] - TorBox API key (default: TORBOX_API_KEY env)
 * @property {number} [maxRequestsPerMinute=30] - Max API requests per minute
 * @property {number} [batchSize=10] - Hashes per batch request
 * @property {number} [concurrency=2] - Max concurrent batch requests
 * @property {number} [freshnessTtlMs=300000] - TTL for fresh observations (5 min)
 * @property {number} [timeoutMs=5000] - Request timeout
 * @property {Function} [fetchFn] - Fetch function (for testing)
 * @property {Function} [now] - Now function (for testing)
 */

/**
 * @typedef {Object} AvailabilityResult
 * @property {string} infoHash - Info hash
 * @property {string} state - 'cached', 'uncached', 'unknown'
 * @property {number} checkedAt - Timestamp of check
 * @property {number|null} latencyMs - Response latency
 * @property {Object|null} fileMetadata - Provider file metadata
 * @property {string|null} errorCategory - Error category (if failed)
 */

/**
 * @typedef {Object} BatchResult
 * @property {AvailabilityResult[]} results - Individual hash results
 * @property {number} elapsedMs - Total elapsed time
 * @property {number} batches - Number of batch requests made
 */

export class AvailabilityChecker {
  /**
   * @param {Object} cache - Discovery cache instance
   * @param {AvailabilityConfig} [config] - Configuration
   */
  constructor(cache, config = {}) {
    if (!cache) {
      throw new Error('Cache instance is required');
    }
    this.cache = cache;
    this.apiKey = config.apiKey || process.env.TORBOX_API_KEY || null;
    this.maxRequestsPerMinute = config.maxRequestsPerMinute || 30;
    this.batchSize = config.batchSize || 10;
    this.concurrency = config.concurrency || 2;
    this.freshnessTtlMs = config.freshnessTtlMs || 300000;
    this.timeoutMs = config.timeoutMs || 5000;
    this.fetchFn = config.fetchFn || fetch;
    this.now = config.now || (() => Date.now());

    // Rate limiting state
    this._requestTimestamps = [];
  }

  /**
   * Check availability for multiple info hashes.
   * @param {string[]} infoHashes - Array of info hashes
   * @param {Object} [options] - Options
   * @param {boolean} [options.force=false] - Force recheck even if fresh
   * @returns {Promise<BatchResult>}
   */
  async checkAvailability(infoHashes, options = {}) {
    const { force = false } = options;
    const startedAt = this.now();

    // Deduplicate hashes
    const uniqueHashes = [...new Set(infoHashes.filter(Boolean).map(h => h.toLowerCase()))];

    // Separate into fresh (can reuse) and stale (need recheck)
    const fresh = new Map();
    const stale = [];

    if (!force) {
      for (const hash of uniqueHashes) {
        const observation = this._getFreshObservation(hash);
        if (observation) {
          fresh.set(hash, observation);
        } else {
          stale.push(hash);
        }
      }
    } else {
      stale.push(...uniqueHashes);
    }

    // Check stale hashes
    const checkResults = await this._checkHashes(stale);

    // Combine results
    const results = [];

    // Add fresh results
    for (const [hash, observation] of fresh) {
      results.push({
        infoHash: hash,
        state: observation.state,
        checkedAt: observation.observedAt,
        latencyMs: observation.latencyMs,
        fileMetadata: observation.evidence?.fileMetadata || null,
        errorCategory: observation.errorCategory,
      });
    }

    // Add checked results
    results.push(...checkResults);

    return {
      results,
      elapsedMs: this.now() - startedAt,
      batches: Math.ceil(stale.length / this.batchSize),
    };
  }

  /**
   * Check availability for candidates from a media request.
   * @param {Object} searchResult - Result from searchByMedia()
   * @param {Object} [options] - Options
   * @returns {Promise<BatchResult>}
   */
  async checkCandidates(searchResult, options = {}) {
    const hashes = (searchResult.results || []).map(r => r.infoHash);
    return this.checkAvailability(hashes, options);
  }

  /**
   * Get fresh observation for a hash (if exists and not expired).
   * @param {string} infoHash - Info hash
   * @returns {Object|null}
   */
  _getFreshObservation(infoHash) {
    const observations = this.cache.getProviderObservations(infoHash, null, {
      includeStale: false,
    });

    // Find TorBox observation
    const torboxObs = observations.find(o => o.provider === 'torbox');
    if (!torboxObs) return null;

    // Check freshness
    const freshness = evaluateObservationFreshness(torboxObs, { now: this.now() });
    if (!freshness.fresh) return null;

    return torboxObs;
  }

  /**
   * Check availability for stale hashes with rate limiting.
   * @param {string[]} hashes - Hashes to check
   * @returns {Promise<AvailabilityResult[]>}
   */
  async _checkHashes(hashes) {
    if (hashes.length === 0) return [];

    const results = [];
    const batches = this._chunk(hashes, this.batchSize);

    // Process batches with concurrency limit
    for (let i = 0; i < batches.length; i += this.concurrency) {
      const batchGroup = batches.slice(i, i + this.concurrency);
      const batchPromises = batchGroup.map(batch => this._checkBatch(batch));
      const batchResults = await Promise.all(batchPromises);

      for (const batchResult of batchResults) {
        results.push(...batchResult);
      }
    }

    return results;
  }

  /**
   * Check a single batch of hashes.
   * @param {string[]} batch - Batch of hashes
   * @returns {Promise<AvailabilityResult[]>}
   */
  async _checkBatch(batch) {
    // Rate limit check
    await this._rateLimit();

    const batchStart = this.now();

    try {
      const response = await checkTorBoxCached(batch, {
        apiKey: this.apiKey,
        fetchFn: this.fetchFn,
        timeoutMs: this.timeoutMs,
      });

      const results = [];

      for (const hash of batch) {
        const isCached = response.cached.has(hash);
        const isFailed = response.failed.has(hash);
        const latency = response.latencyMs.get(hash) || 0;
        const details = response.details.get(hash) || null;

        let state;
        let errorCategory = null;

        if (isFailed) {
          state = 'unknown';
          errorCategory = 'temporarily-unavailable';
        } else {
          state = isCached ? 'cached' : 'uncached';
        }

        // Persist observation
        const observation = this._recordObservation(hash, state, latency, details, errorCategory);

        results.push({
          infoHash: hash,
          state,
          checkedAt: observation.observedAt,
          latencyMs: latency,
          fileMetadata: details,
          errorCategory,
        });
      }

      return results;
    } catch (error) {
      // Batch-level failure - mark all as unknown
      const results = [];
      for (const hash of batch) {
        const observation = this._recordObservation(
          hash,
          'unknown',
          this.now() - batchStart,
          null,
          'transient'
        );

        results.push({
          infoHash: hash,
          state: 'unknown',
          checkedAt: observation.observedAt,
          latencyMs: this.now() - batchStart,
          fileMetadata: null,
          errorCategory: 'temporarily-unavailable',
        });
      }
      return results;
    }
  }

  /**
   * Record observation to cache.
   * @param {string} infoHash - Info hash
   * @param {string} state - Availability state
   * @param {number} latencyMs - Response latency
   * @param {Object|null} fileMetadata - Provider file metadata
   * @param {string|null} errorCategory - Error category
   * @returns {Object}
   */
  _recordObservation(infoHash, state, latencyMs, fileMetadata, errorCategory) {
    const observation = createCacheObservation({
      provider: 'torbox',
      accountScope: 'default',
      scope: 'torrent',
      infoHash,
      fileIndex: null,
      kind: 'authoritative',
      state,
      observedAt: this.now(),
      expiresAt: this.now() + this.freshnessTtlMs,
      source: 'torbox-checkcached',
      evidence: fileMetadata ? { fileMetadata } : null,
      errorCategory,
      retryable: state === 'unknown',
      latencyMs,
    });

    this.cache.appendProviderObservation(observation);
    return observation;
  }

  /**
   * Rate limiting - wait if we've exceeded max requests per minute.
   * @returns {Promise<void>}
   */
  async _rateLimit() {
    const now = this.now();
    const oneMinuteAgo = now - 60000;

    // Remove timestamps older than 1 minute
    this._requestTimestamps = this._requestTimestamps.filter(t => t > oneMinuteAgo);

    if (this._requestTimestamps.length >= this.maxRequestsPerMinute) {
      // Wait until the oldest request is more than 1 minute old
      const oldest = this._requestTimestamps[0];
      const waitMs = oldest - oneMinuteAgo + 100; // Add 100ms buffer
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }

    this._requestTimestamps.push(this.now());
  }

  /**
   * Chunk array into smaller arrays.
   * @param {Array} array - Array to chunk
   * @param {number} size - Chunk size
   * @returns {Array[]}
   */
  _chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Get availability state for a specific hash.
   * @param {string} infoHash - Info hash
   * @returns {Object|null}
   */
  getAvailability(infoHash) {
    const observations = this.cache.getProviderObservations(infoHash, null, {
      includeStale: false,
    });

    const torboxObs = observations.find(o => o.provider === 'torbox');
    if (!torboxObs) return null;

    const freshness = evaluateObservationFreshness(torboxObs, { now: this.now() });

    return {
      provider: 'torbox',
      state: torboxObs.state,
      checkedAt: torboxObs.observedAt,
      ageMs: freshness.ageMs,
      fileMetadata: torboxObs.evidence?.fileMetadata || null,
    };
  }

  /**
   * Get availability for multiple hashes.
   * @param {string[]} infoHashes - Info hashes
   * @returns {Object<string, Object>}
   */
  getAvailabilityBatch(infoHashes) {
    const result = {};
    for (const hash of infoHashes) {
      result[hash] = this.getAvailability(hash);
    }
    return result;
  }
}

/**
 * Create an AvailabilityChecker with default config.
 * @param {Object} cache - Discovery cache instance
 * @param {AvailabilityConfig} [config] - Configuration overrides
 * @returns {AvailabilityChecker}
 */
export function createAvailabilityChecker(cache, config = {}) {
  return new AvailabilityChecker(cache, config);
}
