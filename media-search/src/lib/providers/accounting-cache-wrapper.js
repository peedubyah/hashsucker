/**
 * Accounting wrapper for the TorBox download URL cache.
 *
 * Records cache-hit / single-flight-reuse / fresh-resolution /
 * invalidate / preservation-after-cancel events into the provider
 * accounting registry. The wrapper is duck-type compatible with the
 * existing cache object returned by getTorBoxDownloadUrlCache().
 *
 * The wrapper does NOT swallow errors. It only observes side effects.
 * Secrets are never read from the underlying cache — only the
 * boolean/identity signals that the cache emits through its methods.
 */

import { providerAccounting } from './provider-accounting.js';

const PROVIDER = 'torbox';

/**
 * @param {ReturnType<typeof import('./torbox-download-url-cache.js').getTorBoxDownloadUrlCache>} cache
 * @param {{
 *   onPreservedAfterCancel?: (info:{capability:object}) => void,
 *   onInvalidate?: (info:{capability:object, reason?:string}) => void,
 *   onCapabilityExpired?: (info:{capability:object}) => void,
 * }} [hooks]
 */
export function wrapTorBoxDownloadUrlCacheWithAccounting(cache, hooks = {}) {
  if (!cache) return cache;
  if (cache.__accountingWrapped === true) return cache;

  const wrapped = {
    ...cache,
    __accountingWrapped: true,

    // Fresh resolution: counted only when the factory actually runs.
    // Single-flight reuse is counted when the factory is skipped because
    // another caller is already resolving the same capability.
    async getOrInFlightByCapability(capability, factory) {
      // The cache exposes its in-flight map indirectly through the
      // existing implementation. We detect a fresh fetch by attempting
      // a synchronous cache hit first; if the cache miss falls through
      // to a single-flight join, the factory is NOT invoked. We infer
      // the path by wrapping the factory with a synchronous flag.
      const existingHit = cache.getByCapability?.(capability);
      let factoryInvoked = false;
      const guardedFactory = async () => {
        factoryInvoked = true;
        return factory();
      };
      let result;
      try {
        result = await cache.getOrInFlightByCapability(capability, guardedFactory);
      } catch (error) {
        categorizeError(error, capability, hooks);
        throw error;
      }
      if (existingHit) {
        // The cache had a settled entry and short-circuited; that
        // path is also a hit.
        providerAccounting.increment(PROVIDER, 'requestdl_cache_hit');
        return result;
      }
      if (factoryInvoked) {
        providerAccounting.increment(PROVIDER, 'requestdl_resolution');
      } else {
        // Another caller was already resolving this capability; the
        // single-flight reuse path. Count it so a canary can assert
        // that concurrent source opens produce one upstream call, not
        // many.
        providerAccounting.increment(PROVIDER, 'requestdl_single_flight_reuse');
      }
      return result;
    },

    // Direct get is a confirmed cache hit. The seam may call this to
    // pre-check before invoking getOrInFlightByCapability; we count
    // it so the canary sees the budget shape.
    getByCapability(capability) {
      const hit = cache.getByCapability?.(capability);
      if (hit) providerAccounting.increment(PROVIDER, 'requestdl_cache_hit');
      return hit;
    },

    setByCapability(capability, url, ttlMs) {
      return cache.setByCapability?.(capability, url, ttlMs);
    },

    invalidateByCapability(capability, reason) {
      providerAccounting.increment(PROVIDER, 'requestdl_capability_invalidate');
      hooks.onInvalidate?.({ capability, reason });
      return cache.invalidateByCapability?.(capability);
    },

    // Pass-throughs that don't need accounting.
    get: cache.get?.bind(cache),
    set: cache.set?.bind(cache),
    delete: cache.delete?.bind(cache),
    clear: cache.clear?.bind(cache),
    size: cache.size?.bind(cache),
    getOrInFlight: cache.getOrInFlight?.bind(cache),
  };

  return wrapped;
}

function categorizeError(error, capability, hooks) {
  if (isClientAbortError(error)) {
    providerAccounting.increment('torbox', 'requestdl_preserved_after_cancel');
    hooks.onPreservedAfterCancel?.({ capability });
    return;
  }
  if (error?.status === 429) {
    providerAccounting.increment('torbox', 'requestdl_rate_limited_429');
    return;
  }
  if (typeof error?.status === 'number' && error.status >= 500 && error.status < 600) {
    providerAccounting.increment('torbox', 'requestdl_upstream_5xx');
    return;
  }
  if (error?.status === 401 || error?.status === 403 || error?.status === 404) {
    providerAccounting.increment('torbox', 'requestdl_capability_invalidate');
    // The single bounded retry attempt was already authorized by the
    // seam's runStaleRecoveryOnce path. Do NOT invalidate here — that
    // is owned by the seam so accounting remains single-source.
    hooks.onInvalidate?.({ capability, reason: `requestdl-${error.status}` });
    return;
  }
  providerAccounting.increment('torbox', 'provider_error_other');
}

function isClientAbortError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  if (error.code === 'ABORT_ERR') return true;
  if (typeof error.message === 'string' && /aborted|abort/i.test(error.message)) {
    return !error?.status;
  }
  return false;
}
