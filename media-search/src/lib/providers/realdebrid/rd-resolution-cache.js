/**
 * Short-Lived RD Resolved-URL Cache
 *
 * Process-local in-memory cache for successfully resolved RD URLs.
 * Keyed by (infoHash, fileIndex) to support Jellyfin's stream-probing pattern
 * where multiple /stream requests arrive within seconds for the same candidate.
 *
 * Invariants:
 *   - Process memory only (never persisted or logged)
 *   - TTL-based expiration (default 30s)
 *   - URL is never exposed in logs/telemetry
 *   - In-flight promise coalescing for concurrent same-key requests
 */

const DEFAULT_TTL_MS = 30_000; // 30 seconds

const cache = new Map(); // key -> { url, expiresAt, torrentId, rdFileId }
const inFlight = new Map(); // key -> Promise

function getKey(infoHash, fileIndex) {
  return `${infoHash}:${fileIndex ?? 'torrent'}`;
}

export function getRdResolutionCache() {
  return {
    /**
     * Get cached RD URL if present and not expired.
     * @returns {{ url: string, torrentId: string, rdFileId: string } | null}
     */
    get(infoHash, fileIndex) {
      const key = getKey(infoHash, fileIndex);
      const entry = cache.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
      }
      return { url: entry.url, torrentId: entry.torrentId, rdFileId: entry.rdFileId };
    },

    /**
     * Store a successfully resolved RD URL.
     * @param {string} infoHash
     * @param {number|null} fileIndex
     * @param {string} url - Unrestricted RD URL (never logged)
     * @param {string} torrentId
     * @param {string} rdFileId
     * @param {number} [ttlMs] - Custom TTL (default 30s)
     */
    set(infoHash, fileIndex, url, torrentId, rdFileId, ttlMs = DEFAULT_TTL_MS) {
      const key = getKey(infoHash, fileIndex);
      cache.set(key, {
        url,
        expiresAt: Date.now() + ttlMs,
        torrentId,
        rdFileId,
      });
    },

    /**
     * Remove one resolved URL so a failed read can re-resolve it.
     */
    delete(infoHash, fileIndex) {
      cache.delete(getKey(infoHash, fileIndex));
    },

    /**
     * Get or create an in-flight promise for coalescing concurrent requests.
     * @param {string} infoHash
     * @param {number|null} fileIndex
     * @param {Function} factory - Returns Promise if no in-flight exists
     * @returns {Promise}
     */
    async getOrInFlight(infoHash, fileIndex, factory) {
      const key = getKey(infoHash, fileIndex);
      const existing = inFlight.get(key);
      if (existing) return existing;

      try {
        const promise = factory();
        inFlight.set(key, promise);
        return await promise;
      } finally {
        inFlight.delete(key);
      }
    },

    /**
     * Clear all cached entries (for testing).
     */
    clear() {
      cache.clear();
      inFlight.clear();
    },

    /**
     * Get cache size for diagnostics.
     */
    size() {
      return cache.size;
    },
  };
}

export const RD_RESOLUTION_CACHE_TTL_MS = DEFAULT_TTL_MS;
