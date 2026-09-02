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

    // Protocol-invalid guard. A real TorBox requestdl permalink
    // should resolve to a binary download stream on a CDN host. When
    // the upstream returns a 2xx but the response is not a real
    // binary stream (CDN interstitial, login wall, error page
    // masquerading as 200, redirect loop back to the TorBox API,
    // empty body), the URL we just resolved is not a usable
    // capability. The seam treats this exactly like 401/403/404:
    // invalidate the cached capability, surface the original error,
    // let the next call re-resolve once. The same call does NOT
    // retry on protocol-invalid.
    const protocolInvalid = detectProtocolInvalidResponse(response, requestUrl);
    if (protocolInvalid) {
      throw new TorBoxDownloadUrlError(
        `TorBox requestdl returned a protocol-invalid response: ${protocolInvalid.reason}`,
        'TORBOX_REQUESTDL_PROTOCOL_INVALID',
        502,
        { protocolInvalidReason: protocolInvalid.reason },
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

// Content-Types that are NEVER valid for a real TorBox download stream.
// A requestdl permalink followed by Range: bytes=0-1023 must answer with
// a binary stream on a CDN host. Anything that smells like HTML, XML, or
// JSON is a CAPTCHA / login wall / error page masquerading as success.
// Real binary download streams answer with application/octet-stream or
// video/* / audio/* (the range response is binary either way).
const NON_BINARY_CONTENT_TYPES = Object.freeze([
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
  'application/json',
  'text/plain',
  'application/javascript',
  'application/x-javascript',
  'application/ld+json',
  'application/rss+xml',
  'application/atom+xml',
]);

// Any text/* subtype is suspicious for a binary download stream.
// Listed separately so the check is explicit rather than relying on a
// trailing-prefix wildcard (which would also catch text/event-stream).
const NON_BINARY_TEXT_PREFIX = 'text/';

// Hostnames that indicate the redirect never escaped TorBox. A real
// requestdl resolves to a CDN host (e.g. tbg.torbox.app, *.cdn.torbox.app,
// or a third-party CDN); landing back on api.torbox.app means the
// permalink bounced inside the API surface and the cached URL is not a
// usable capability.
const TORBOX_API_HOSTNAMES = Object.freeze([
  'api.torbox.app',
  'torbox.app',
]);

function isTorBoxApiHostname(hostname) {
  if (!hostname) return false;
  const lower = String(hostname).toLowerCase();
  return TORBOX_API_HOSTNAMES.some((apiHost) => lower === apiHost || lower.endsWith(`.${apiHost}`));
}

/**
 * Detect a 2xx response that is NOT a real TorBox download stream.
 *
 * Returns `{ reason: string }` if the response is protocol-invalid, or
 * `null` if it appears to be a real binary download capability.
 *
 * Deterministic signals checked (no body parsing):
 *   - response URL still points at the TorBox API surface (redirect loop)
 *   - Content-Type is HTML / XML / JSON / text (not a binary stream)
 *   - Content-Length is explicitly 0 (empty body despite 2xx)
 *
 * These are the cases where the cached URL, if returned to the caller,
 * would be a captive-page / error-page masquerading as a successful
 * capability. The seam treats this exactly like 401/403/404: invalidate
 * the cached capability and let the next call re-resolve once.
 */
function detectProtocolInvalidResponse(response, requestUrl) {
  const finalUrl = response?.url;
  if (finalUrl) {
    let finalHostname = null;
    try {
      finalHostname = new URL(finalUrl).hostname;
    } catch {
      // Malformed final URL — treat as protocol-invalid (same as the
      // missing-URL case but distinct from TORBOX_DOWNSTREAM_URL_MISSING
      // because here the redirect DID change the URL string).
      return { reason: 'malformed-final-url' };
    }
    if (isTorBoxApiHostname(finalHostname)) {
      return { reason: 'redirect-loops-to-torbox-api' };
    }
  }

  const contentTypeHeader = response?.headers?.get?.('content-type');
  if (contentTypeHeader) {
    const contentType = String(contentTypeHeader).toLowerCase().trim();
    // Strip optional charset / boundary parameters.
    const mainType = contentType.split(';')[0].trim();
    if (mainType) {
      if (NON_BINARY_CONTENT_TYPES.includes(mainType)) {
        return { reason: `non-binary-content-type:${mainType}` };
      }
      if (mainType.startsWith(NON_BINARY_TEXT_PREFIX)) {
        return { reason: `non-binary-content-type:${mainType}` };
      }
    }
  }

  const contentLengthHeader = response?.headers?.get?.('content-length');
  if (contentLengthHeader != null) {
    const length = Number(String(contentLengthHeader).trim());
    if (Number.isFinite(length) && length === 0) {
      return { reason: 'empty-body' };
    }
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