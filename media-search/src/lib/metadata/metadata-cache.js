/**
 * In-Memory Metadata Cache
 *
 * Fast, bounded, TTL-based cache for title search results.
 * Designed for interactive typeahead: low-latency, metrics-rich,
 * replaceable later by Redis/SQLite without touching callers.
 *
 * Design:
 * - Query key normalized (lowercase, trimmed, collapsed whitespace)
 * - TTL per entry (default 5 minutes)
 * - Bounded entries (LRU eviction when maxEntries exceeded)
 * - Cache hit/miss/eviction metrics
 * - Zero dependencies, synchronous reads for hot path
 */

/**
 * @typedef {Object} CacheMetrics
 * @property {number} hits - Total cache hits
 * @property {number} misses - Total cache misses
 * @property {number} evictions - Total entries evicted (size/TTL)
 * @property {number} size - Current number of entries
 * @property {number} maxEntries - Maximum entries allowed
 * @property {number} hitRatio - Hit ratio (0.0-1.0), null if no requests
 */

/**
 * Normalize a query string into a canonical cache key.
 *
 * @param {string} query - Raw query
 * @returns {string} Normalized key
 */
export function normalizeQueryKey(query) {
  return String(query || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Create an in-memory metadata cache.
 *
 * @param {Object} [options]
 * @param {number} [options.ttlMs=300000] - Time-to-live per entry in ms (default 5 min)
 * @param {number} [options.maxEntries=500] - Maximum entries before LRU eviction
 * @param {number} [options.cleanupIntervalMs=60000] - How often to sweep expired entries
 * @returns {MetadataCache}
 */
export function createMetadataCache(options = {}) {
  const ttlMs = options.ttlMs || 5 * 60 * 1000; // 5 minutes default
  const maxEntries = options.maxEntries || 500;
  const cleanupIntervalMs = options.cleanupIntervalMs || 60 * 1000;

  // Map preserves insertion order for LRU
  const entries = new Map();
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  let cleanupTimer = null;

  function startCleanupTimer() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      sweepExpired();
    }, cleanupIntervalMs);
    // Don't keep process alive solely for cleanup
    if (cleanupTimer.unref) cleanupTimer.unref();
  }

  function stopCleanupTimer() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }

  /**
   * Remove all expired entries.
   * @returns {number} Number of entries removed
   */
  function sweepExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of entries) {
      if (now - entry.createdAt >= ttlMs) {
        entries.delete(key);
        removed++;
        evictions++;
      }
    }
    return removed;
  }

  /**
   * Evict the least-recently-used entry (first inserted).
   */
  function evictLRU() {
    if (entries.size === 0) return;
    const oldestKey = entries.keys().next().value;
    if (oldestKey !== undefined) {
      entries.delete(oldestKey);
      evictions++;
    }
  }

  /**
   * Get a cached entry if it exists and is fresh.
   *
   * @param {string} query - Raw query (will be normalized)
   * @returns {{results: NormalizedMedia[], cachedAt: number, expiresAt: number}|null}
   */
  function get(query) {
    const key = normalizeQueryKey(query);
    const entry = entries.get(key);

    if (!entry) {
      misses++;
      return null;
    }

    const now = Date.now();
    if (now - entry.createdAt >= ttlMs) {
      // Expired
      entries.delete(key);
      evictions++;
      misses++;
      return null;
    }

    // Move to end (LRU: mark as recently used)
    entries.delete(key);
    entries.set(key, entry);

    hits++;
    return {
      results: entry.results,
      cachedAt: entry.createdAt,
      expiresAt: entry.createdAt + ttlMs,
    };
  }

  /**
   * Store results in the cache.
   *
   * @param {string} query - Raw query (will be normalized)
   * @param {NormalizedMedia[]} results - Results to cache
   * @returns {{key: string, cachedAt: number, expiresAt: number}}
   */
  function set(query, results) {
    const key = normalizeQueryKey(query);

    // If key exists, delete first (to update LRU position)
    if (entries.has(key)) {
      entries.delete(key);
    }

    // Evict if at capacity
    while (entries.size >= maxEntries) {
      evictLRU();
    }

    const createdAt = Date.now();
    entries.set(key, { results, createdAt });

    return { key, cachedAt: createdAt, expiresAt: createdAt + ttlMs };
  }

  /**
   * Invalidate a specific query.
   *
   * @param {string} query - Raw query
   * @returns {boolean} True if entry existed and was removed
   */
  function invalidate(query) {
    const key = normalizeQueryKey(query);
    return entries.delete(key);
  }

  /**
   * Clear all cache entries.
   */
  function clear() {
    entries.clear();
  }

  /**
   * Get current cache metrics.
   *
   * @returns {CacheMetrics}
   */
  function getMetrics() {
    const total = hits + misses;
    return {
      hits,
      misses,
      evictions,
      size: entries.size,
      maxEntries,
      hitRatio: total > 0 ? hits / total : null,
    };
  }

  /**
   * Reset metrics counters (but keep cached data).
   */
  function resetMetrics() {
    hits = 0;
    misses = 0;
    evictions = 0;
  }

  /**
   * Check if a query is cached and fresh (without updating LRU or metrics).
   *
   * @param {string} query - Raw query
   * @returns {boolean}
   */
  function has(query) {
    const key = normalizeQueryKey(query);
    const entry = entries.get(key);
    if (!entry) return false;
    if (Date.now() - entry.createdAt >= ttlMs) {
      entries.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Get remaining TTL for a cached entry.
   *
   * @param {string} query - Raw query
   * @returns {number} Remaining TTL in ms, or 0 if not cached/expired
   */
  function getRemainingTtl(query) {
    const key = normalizeQueryKey(query);
    const entry = entries.get(key);
    if (!entry) return 0;
    const remaining = ttlMs - (Date.now() - entry.createdAt);
    return Math.max(0, remaining);
  }

  startCleanupTimer();

  return {
    get,
    set,
    has,
    invalidate,
    clear,
    sweepExpired,
    getMetrics,
    resetMetrics,
    getRemainingTtl,
    get size() { return entries.size; },
    get ttlMs() { return ttlMs; },
    stop: stopCleanupTimer,
    // Symbol.dispose for explicit resource management
    [Symbol.dispose || Symbol.for('nodejs.dispose')]: stopCleanupTimer,
  };
}
