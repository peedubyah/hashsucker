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
// Per-capability requestdl rate-limit gate. When requestdl returns 429,
// the seam records a gate here so subsequent `getOrInFlightByCapability`
// callers short-circuit without invoking the factory (no upstream
// requestdl call). Process-local by design: the gate is short-lived
// (bounded by the upstream Retry-After header or the conservative
// floor) so a process restart naturally clears it.
//
// The gate key is the same `(provider, accountScope, placementId,
// providerFileId)` tuple used for cache entries, which means a single
// gate covers ALL callers targeting the SAME exact capability tuple —
// including concurrent VFS byte-read, resolver, and revalidation
// paths. The gate is intentionally NOT a global or account-wide
// throttle; it is scoped to the specific capability that the upstream
// just refused.
const rateLimited = new Map();
// Per-capability DELIVERY (byte-read) rate-limit gate. When a byte
// Range GET against the cached CDN URL returns 429 from the upstream
// CDN/edge, the VFS byte path records a gate here. The requestdl
// gate and the delivery gate are intentionally separate maps so the
// two layers can be independently cleared: a successful requestdl
// does not retroactively clear a delivery 429, and vice versa. The
// delivery gate is keyed on the same `(provider, accountScope,
// placementId, providerFileId)` tuple, scoped as narrowly as the
// evidence supports.
const deliveryRateLimited = new Map();
// Floor for the backoff window when upstream omits Retry-After. The
// same floor protects against tiny Retry-After values that would
// produce a 1–2 second backoff and immediately re-trigger upstream.
const MIN_BACKOFF_MS = 30_000;
// Ceiling for the backoff window. A 24h Retry-After (legal per RFC
// 7231) would otherwise freeze the cache for a day; this ceiling
// keeps the gate bounded so a stuck entry clears itself.
const MAX_BACKOFF_MS = 5 * 60_000;

function tupleKey({ provider, accountScope, placementId, providerFileId }) {
  return `${provider}:${accountScope}:${placementId}:${providerFileId}`;
}

function legacyKey(releaseKey, providerFileId) {
  return `legacy:${releaseKey}:${providerFileId}`;
}

function nowMs() {
  return Date.now();
}

// Optional clock injection so tests (and any future operator harness)
// can drive the gate deterministically without monkey-patching
// Date.now. The default keeps the existing behavior: real wall clock.
let nowFn = nowMs;
function setNowFn(fn) {
  if (typeof fn === 'function') nowFn = fn;
  else nowFn = nowMs;
}

/**
 * Per-capability backoff gate. Returns `{ until, retryAfterMs }` when
 * the gate is active, or `null` when it has expired or was never set.
 * Lazy-evicts expired entries so the Map does not grow unbounded.
 */
function checkRateLimited(capability, now = nowFn()) {
  const key = tupleKey(capability);
  const entry = rateLimited.get(key);
  if (!entry) return null;
  if (!Number.isFinite(entry.until) || now >= entry.until) {
    rateLimited.delete(key);
    return null;
  }
  return { until: entry.until, retryAfterMs: entry.until - now };
}

/**
 * Record a per-capability rate-limit gate. The window is the upstream
 * `Retry-After` (clamped to `[MIN_BACKOFF_MS, MAX_BACKOFF_MS]`) when
 * present, or the floor when absent. The window is the MAX of any
 * existing gate so repeated 429s do not shrink the backoff.
 *
 * Optional `now` argument overrides the module-level clock for
 * the recorded `until` timestamp. Production callers pass
 * nothing; tests pass the same `now` they use everywhere else.
 */
function markRateLimited(capability, retryAfterMs, now = nowFn()) {
  const key = tupleKey(capability);
  const requested = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : MIN_BACKOFF_MS;
  const clamped = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, requested));
  const until = now + clamped;
  const existing = rateLimited.get(key);
  const newUntil = existing?.until && existing.until > until ? existing.until : until;
  rateLimited.set(key, { until: newUntil, retryAfterMs: clamped });
}

/**
 * Per-capability DELIVERY (byte-read) backoff gate. Returns
 * `{ until, retryAfterMs }` when the gate is active, or `null`
 * when it has expired or was never set. Lazy-evicts expired
 * entries so the Map does not grow unbounded.
 *
 * The delivery gate is independent from the requestdl gate: a
 * requestdl 429 does NOT arm the delivery gate, and a delivery
 * 429 does NOT arm the requestdl gate. The two surfaces can be
 * concurrently throttled (requestdl API throttle vs CDN/edge
 * throttle) and the accounting/canary visibility must be able to
 * distinguish them.
 *
 * Optional `now` argument overrides the module-level clock for
 * this single check. Production callers pass nothing; tests that
 * drive a virtual clock on the VFS layer pass the same `now` so
 * the gate's window and the VFS state machine advance together.
 */
function checkDeliveryRateLimited(capability, now = nowFn()) {
  const key = tupleKey(capability);
  const entry = deliveryRateLimited.get(key);
  if (!entry) return null;
  if (!Number.isFinite(entry.until) || now >= entry.until) {
    deliveryRateLimited.delete(key);
    return null;
  }
  return { until: entry.until, retryAfterMs: entry.until - now };
}

/**
 * Record a per-capability delivery backoff gate. The window is the
 * upstream `Retry-After` (clamped to `[MIN_BACKOFF_MS, MAX_BACKOFF_MS]`)
 * when present, or the floor when absent. The window is the MAX of
 * any existing gate so repeated 429s do not shrink the backoff.
 *
 * Returns the recorded retryAfterMs (post-clamp) so the caller can
 * surface it on the response (Retry-After header) and in the
 * accounting counter without re-parsing the upstream header.
 *
 * Optional `now` argument overrides the module-level clock for
 * the recorded `until` timestamp. Production callers pass
 * nothing; tests pass the same `now` they use everywhere else.
 */
function markDeliveryRateLimited(capability, retryAfterMs, now = nowFn()) {
  const key = tupleKey(capability);
  const requested = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : MIN_BACKOFF_MS;
  const clamped = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, requested));
  const until = now + clamped;
  const existing = deliveryRateLimited.get(key);
  const newUntil = existing?.until && existing.until > until ? existing.until : until;
  deliveryRateLimited.set(key, { until: newUntil, retryAfterMs: clamped });
  return clamped;
}

/**
 * Clear a per-capability delivery backoff gate. Called by the VFS
 * byte path when a successful byte read follows a 429 — the
 * capability is demonstrably usable again, so the next delivery
 * call does not need to honor a stale window.
 */
function clearDeliveryRateLimited(capability) {
  deliveryRateLimited.delete(tupleKey(capability));
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

    // Per-capability rate-limit gate — direct accessors. The gate is
    // process-local and shared by all callers that target the same
    // capability tuple, so a single 429 observation protects every
    // concurrent and subsequent requestdl attempt on that tuple until
    // the window expires (or the gate is explicitly cleared after a
    // successful re-resolution).
    isRateLimited(capability, now) {
      return checkRateLimited(capability, now);
    },

    markRateLimited(capability, retryAfterMs, now) {
      markRateLimited(capability, retryAfterMs, now);
    },

    clearRateLimited(capability) {
      rateLimited.delete(tupleKey(capability));
    },

    // Per-capability DELIVERY (byte-read) rate-limit gate. The gate
    // is keyed on the same capability tuple as the cache entries, so
    // a single 429 observation against the CDN/edge URL covers every
    // concurrent and subsequent byte read against the same capability.
    // The gate is independent from the requestdl gate: a requestdl
    // 429 does not arm the delivery gate, and a delivery 429 does not
    // arm the requestdl gate.
    isDeliveryRateLimited(capability, now) {
      return checkDeliveryRateLimited(capability, now);
    },

    markDeliveryRateLimited(capability, retryAfterMs, now) {
      return markDeliveryRateLimited(capability, retryAfterMs, now);
    },

    clearDeliveryRateLimited(capability) {
      clearDeliveryRateLimited(capability);
    },

    async getOrInFlightByCapability(capability, factory) {
      const key = tupleKey(capability);

      // Per-capability 429 back-pressure. When the previous requestdl
      // attempt for this capability returned 429 and the gate is still
      // active, refuse the call WITHOUT invoking the factory — no
      // upstream requestdl call, no provider storm. The capability is
      // not invalidated and the cache entry (if any) is not touched;
      // only new resolution attempts are blocked. The factory is never
      // invoked when the gate is active.
      // If a caller is already resolving this capability, join the
      // in-flight promise — even when the gate is active. This
      // ensures concurrent callers during a backoff do NOT each
      // throw a fresh 429; they observe the in-flight resolve
      // (which itself will clear the gate on success).
      const existing = inFlight.get(key);
      if (existing) return existing;

      const gate = checkRateLimited(capability);
      if (gate) {
        const error = new TorBoxDownloadUrlError(
          'TorBox requestdl is currently rate-limited for this capability',
          'TORBOX_REQUESTDL_RATE_LIMITED',
          429,
          { retryAfterMs: gate.retryAfterMs },
        );
        // Annotate the gate metadata so downstream accounting can
        // distinguish a back-pressure short-circuit from a fresh 429
        // observation. `fromGate: true` is consumed by the accounting
        // wrapper to emit `requestdl_backoff_short_circuit` instead of
        // `requestdl_rate_limited_429`.
        error.fromGate = true;
        throw error;
      }

      try {
        const promise = factory();
        inFlight.set(key, promise);
        const result = await promise;
        // A successful resolution supersedes any prior gate. The next
        // 429 is the only thing that re-arms it.
        rateLimited.delete(key);
        return result;
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
      rateLimited.clear();
      deliveryRateLimited.clear();
    },

    size() {
      return cache.size;
    },
  };
}

export const TORBOX_DOWNLOAD_URL_CACHE_TTL_MS = DEFAULT_TTL_MS;
export const TORBOX_DELIVERY_BACKOFF_MIN_MS = MIN_BACKOFF_MS;
export const TORBOX_DELIVERY_BACKOFF_MAX_MS = MAX_BACKOFF_MS;

/**
 * Test/clock-injection helpers. Production code should never call
 * these — they exist so a deterministic harness can drive the
 * delivery/requestdl gate window without monkey-patching Date.now.
 * They are NOT part of the cache's observable surface.
 */
export function _setTorboxCacheNow(fn) {
  setNowFn(fn);
}

export function _resetTorboxCacheNow() {
  setNowFn(null);
}