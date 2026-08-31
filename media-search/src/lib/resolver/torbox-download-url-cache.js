/**
 * Short-lived TorBox downstream URL cache.
 *
 * Resolves a TorBox requestdl permalink once, captures the final redirected
 * download URL after a bounded byte-range check, and reuses it for rapid media
 * server reopens. URLs remain process-local and are never persisted or logged.
 */

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const LIVENESS_RANGE_BYTES = 1024;

const cache = new Map();
const inFlight = new Map();

function getKey(releaseKey, providerFileId) {
  return `${releaseKey}:${providerFileId}`;
}

export class TorBoxDownloadUrlError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'TorBoxDownloadUrlError';
    this.code = code;
    this.status = status;
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

export function getTorBoxDownloadUrlCache() {
  return {
    get(releaseKey, providerFileId) {
      const key = getKey(releaseKey, providerFileId);
      const entry = cache.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        cache.delete(key);
        return null;
      }
      return { url: entry.url };
    },

    set(releaseKey, providerFileId, url, ttlMs = DEFAULT_TTL_MS) {
      cache.set(getKey(releaseKey, providerFileId), {
        url,
        expiresAt: Date.now() + ttlMs,
      });
    },

    delete(releaseKey, providerFileId) {
      cache.delete(getKey(releaseKey, providerFileId));
    },

    async getOrInFlight(releaseKey, providerFileId, factory) {
      const key = getKey(releaseKey, providerFileId);
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
