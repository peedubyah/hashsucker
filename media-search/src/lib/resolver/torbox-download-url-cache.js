/**
 * Short-lived TorBox downstream URL cache.
 *
 * Resolves a TorBox requestdl permalink once, captures the final redirected
 * download URL after a bounded byte-range check, and reuses it for rapid media
 * server reopens. URLs remain process-local and are never persisted or logged.
 *
 * Capability key (stable provider addressing):
 *   { provider, accountScope, placementId, providerFileId }
 *
 * A legacy (releaseKey, providerFileId) signature is preserved for callers
 * that only have candidate-level identifiers — it is mapped to the same
 * underlying capability entry by joining on providerFileId within the
 * singleton cache. The legacy signature is the bounded correctness floor;
 * the capability-tuple signature is the recommended one.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — bounded process-local lifetime.
const DEFAULT_TIMEOUT_MS = 10_000;
const LIVENESS_RANGE_BYTES = 1024;

const cache = new Map();
const inFlight = new Map();

function tupleKey({ provider, accountScope, placementId, providerFileId }) {
  return `${provider}:${accountScope}:${placementId}:${providerFileId}`;
}

function legacyKey(releaseKey, providerFileId) {
  return `legacy:${releaseKey}:${providerFileId}`;
}

export class TorBoxDownloadUrlError extends Error {
  constructor(message, code, status, extra = {}) {
    super(message);
    this.name = 'TorBoxDownloadUrlError';
    this.code = code;
    this.status = status;
    if (extra && typeof extra === 'object') {
      Object.assign(this, extra);
    }
  }
}

export async function resolveTorBoxDownloadUrl(requestUrl, options = {}) {
  const {
    fetchFn = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    rangeBytes = LIVENESS_RANGE_BYTES,
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetchFn(requestUrl, {
      method: 'GET',
      headers: { Range: `bytes=0-${rangeBytes - 1}` },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
      throw new TorBoxDownloadUrlError(
        `TorBox requestdl returned HTTP 429`,
        'TORBOX_REQUESTDL_RATE_LIMITED',
        429,
        { retryAfterMs: retryAfterMs ?? null },
      );
    }

    if (response.status !== 200 && response.status !== 206) {
      throw new TorBoxDownloadUrlError(
        `TorBox requestdl returned HTTP ${response.status}`,
        'TORBOX_REQUESTDL_FAILED',
        response.status,
      );
    }

    const downstreamUrl = response.url;
    if (!downstreamUrl || downstreamUrl === requestUrl) {
      throw new TorBoxDownloadUrlError(
        'TorBox requestdl did not resolve to a downstream download URL',
        'TORBOX_DOWNSTREAM_URL_MISSING',
        502,
      );
    }

    return downstreamUrl;
  } catch (error) {
    if (error instanceof TorBoxDownloadUrlError) throw error;
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      throw new TorBoxDownloadUrlError(
        'TorBox requestdl resolution timed out',
        'TORBOX_REQUESTDL_TIMEOUT',
        504,
      );
    }
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl resolution failed',
      'TORBOX_REQUESTDL_FAILED',
      502,
    );
  } finally {
    clearTimeout(timeout);
    if (response?.body) {
      try {
        await response.body.cancel();
      } catch {
        // The bounded response may already be consumed or closed.
      }
    }
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  // Numeric seconds form (RFC 7231 §7.1.3).
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // HTTP-date form — surface the parsed value if it is in the future,
  // otherwise null so the caller falls back to its conservative default.
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const diff = date - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
}

export function getTorBoxDownloadUrlCache() {
  return {
    getByCapability(capability) {
      const key = tupleKey(capability);
      const entry = cache.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        cache.delete(key);
        return null;
      }
      return { url: entry.url, capability: entry.capability };
    },

    setByCapability(capability, url, ttlMs = DEFAULT_TTL_MS) {
      const key = tupleKey(capability);
      cache.set(key, {
        url,
        capability: { ...capability },
        expiresAt: Date.now() + ttlMs,
      });
    },

    invalidateByCapability(capability) {
      cache.delete(tupleKey(capability));
    },

    // Legacy API: keyed on (releaseKey, providerFileId). Preserved for
    // older callers and existing tests. Internally stored under a distinct
    // namespace so it never collides with capability entries.
    get(releaseKey, providerFileId) {
      const key = legacyKey(releaseKey, providerFileId);
      const entry = cache.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        cache.delete(key);
        return null;
      }
      return { url: entry.url };
    },

    set(releaseKey, providerFileId, url, ttlMs = DEFAULT_TTL_MS) {
      cache.set(legacyKey(releaseKey, providerFileId), {
        url,
        expiresAt: Date.now() + ttlMs,
      });
    },

    delete(releaseKey, providerFileId) {
      cache.delete(legacyKey(releaseKey, providerFileId));
    },

    async getOrInFlightByCapability(capability, factory) {
      const key = tupleKey(capability);
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

    async getOrInFlight(releaseKey, providerFileId, factory) {
      const key = legacyKey(releaseKey, providerFileId);
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

    clear() {
      cache.clear();
      inFlight.clear();
    },

    size() {
      return cache.size;
    },
  };
}

export const TORBOX_DOWNLOAD_URL_CACHE_TTL_MS = DEFAULT_TTL_MS;