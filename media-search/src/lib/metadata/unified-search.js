/**
 * Unified Media Search Module
 *
 * Orchestrates metadata providers, caching, and request lifecycle for
 * interactive typeahead search. This is the single entry point for
 * title discovery in the media-search application.
 *
 * Features:
 * - Provider-agnostic: Cinemeta today, TMDB tomorrow
 * - In-memory cache with TTL and LRU eviction
 * - Request ID tracking for stale response rejection
 * - Query normalization and minimum length enforcement
 * - Duplicate request suppression (in-flight dedup)
 * - Graceful degradation: cache hit on provider failure
 *
 * The frontend should only know: GET /api/search?q=<query>
 */

import { createMetadataCache, normalizeQueryKey } from './metadata-cache.js';
import { createCinemetaAdapter } from './cinemeta-adapter.js';

// Module-level cache singleton
let cacheInstance = null;
let cacheInitError = null;

function getCache() {
  if (cacheInstance || cacheInitError) return cacheInstance;
  try {
    cacheInstance = createMetadataCache({
      ttlMs: Number(process.env.METADATA_CACHE_TTL_MS) || 5 * 60 * 1000,
      maxEntries: Number(process.env.METADATA_CACHE_MAX_ENTRIES) || 500,
    });
  } catch (error) {
    cacheInitError = error;
    console.error(`Metadata cache initialization failed: ${error.message}`);
  }
  return cacheInstance;
}

// Module-level provider registry
let providers = null;

function getProviders() {
  if (providers) return providers;
  providers = [createCinemetaAdapter()];
  return providers;
}

// In-flight request dedup: key -> Promise
const inFlightRequests = new Map();

// Request ID counter for stale detection
let requestIdCounter = 0;

/**
 * Reset module-level state. Used by tests.
 */
export function _resetForTests() {
  if (cacheInstance) {
    cacheInstance.clear();
  }
  cacheInstance = null;
  cacheInitError = null;
  inFlightRequests.clear();
  requestIdCounter = 0;
}

/**
 * Get the current cache instance for test inspection.
 */
export function _getCacheForTests() {
  return getCache();
}

/**
 * Validate and normalize a search query.
 *
 * @param {string} query - Raw query
 * @returns {{valid: boolean, normalized: string, error: string|null}}
 */
export function validateQuery(query) {
  const normalized = String(query || '').trim();
  if (normalized.length < 2) {
    return { valid: false, normalized, error: 'Query must be at least 2 characters' };
  }
  if (normalized.length > 120) {
    return { valid: false, normalized, error: 'Query must be at most 120 characters' };
  }
  return { valid: true, normalized, error: null };
}

/**
 * Search for titles by query string.
 *
 * This is the primary search function. It:
 * 1. Validates and normalizes the query
 * 2. Checks the in-memory cache
 * 3. Deduplicates concurrent identical requests
 * 4. Queries all registered providers
 * 5. Returns normalized, deduplicated results
 *
 * @param {string} query - Search query
 * @param {Object} [options]
 * @param {string} [options.requestId] - Client-provided request ID for stale detection
 * @param {boolean} [options.skipCache=false] - Bypass cache (force fresh)
 * @returns {Promise<{results: NormalizedMedia[], requestId: string, fromCache: boolean, timings: Object}>}
 */
export async function searchTitles(query, options = {}) {
  const startedAt = performance.now();
  const requestId = options.requestId || `req-${++requestIdCounter}`;

  const validation = validateQuery(query);
  if (!validation.valid) {
    return {
      results: [],
      requestId,
      fromCache: false,
      error: validation.error,
      timings: { totalMs: Math.round(performance.now() - startedAt) },
    };
  }

  const normalizedQuery = validation.normalized;
  const cacheKey = normalizeQueryKey(normalizedQuery);
  const cache = getCache();

  // Check cache first (unless skipCache)
  if (!options.skipCache && cache) {
    const cached = cache.get(normalizedQuery);
    if (cached) {
      return {
        results: cached.results,
        requestId,
        fromCache: true,
        cachedAt: cached.cachedAt,
        expiresAt: cached.expiresAt,
        timings: { totalMs: Math.round(performance.now() - startedAt) },
      };
    }
  }

  // Deduplicate concurrent identical requests
  if (inFlightRequests.has(cacheKey)) {
    const result = await inFlightRequests.get(cacheKey);
    return { ...result, requestId, deduped: true };
  }

  // Create the search promise
  const searchPromise = executeSearch(normalizedQuery, cache);
  inFlightRequests.set(cacheKey, searchPromise);

  try {
    const result = await searchPromise;
    return { ...result, requestId };
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

/**
 * Execute the actual search across providers.
 */
async function executeSearch(normalizedQuery, cache) {
  const startedAt = performance.now();
  const providers = getProviders();

  // Query all providers in parallel
  const providerResults = await Promise.allSettled(
    providers.map((provider) => provider.search(normalizedQuery))
  );

  const allResults = [];
  const errors = [];

  for (let i = 0; i < providerResults.length; i++) {
    const result = providerResults[i];
    const provider = providers[i];
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
    } else {
      errors.push({ provider: provider.name, error: result.reason?.message });
    }
  }

  // Deduplicate by media ID (first seen wins, preserving priority order)
  const seenIds = new Set();
  const deduped = [];
  for (const media of allResults) {
    if (media && media.id && !seenIds.has(media.id)) {
      seenIds.add(media.id);
      deduped.push(media);
    }
  }

  // Cache the results (even if partial, as long as we have some)
  if (cache && deduped.length > 0) {
    cache.set(normalizedQuery, deduped);
  }

  return {
    results: deduped,
    fromCache: false,
    errors: errors.length > 0 ? errors : undefined,
    timings: { totalMs: Math.round(performance.now() - startedAt) },
  };
}

/**
 * Get a specific media item by type and ID.
 *
 * @param {string} type - "movie" or "series"
 * @param {string} id - Media identifier
 * @returns {Promise<NormalizedMedia|null>}
 */
export async function getMediaById(type, id) {
  const providers = getProviders();

  // Try providers in priority order
  for (const provider of providers) {
    if (typeof provider.getMedia === 'function') {
      try {
        const media = await provider.getMedia(type, id);
        if (media) return media;
      } catch (error) {
        console.error(`Provider ${provider.name} getMedia failed: ${error.message}`);
      }
    }
  }

  return null;
}

/**
 * Get cache metrics for monitoring.
 *
 * @returns {CacheMetrics|null}
 */
export function getCacheMetrics() {
  const cache = getCache();
  return cache ? cache.getMetrics() : null;
}

/**
 * Invalidate a cached query.
 *
 * @param {string} query - Query to invalidate
 * @returns {boolean}
 */
export function invalidateCache(query) {
  const cache = getCache();
  return cache ? cache.invalidate(query) : false;
}

/**
 * Clear the entire metadata cache.
 */
export function clearCache() {
  const cache = getCache();
  if (cache) cache.clear();
}
