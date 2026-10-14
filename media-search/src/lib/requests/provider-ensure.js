/**
 * Request-scoped provider ensure seams.
 *
 * The discovery pipeline takes optional provider identity-binding seams
 * (`ensureTorBoxFileIdentity`, `ensureRealDebridFileIdentity`). For
 * Real-Debrid, one memoized ensure instance is built per request so
 * repeated ensure calls for the same infoHash inside one request are free
 * and the memo dies with the request. When RD is not configured the
 * helper returns an empty spread so callers keep TorBox-only behavior
 * bit-for-bit.
 */

import { createRdEnsure } from '../providers/realdebrid/ensure.js';

/**
 * @returns {Function|null} request-scoped ensure fn, or null when RD is unavailable
 */
export function buildRequestRdEnsureFn({ rdClient, controlPlaneStore, clock = () => Date.now() } = {}) {
  if (!rdClient || !controlPlaneStore) return null;
  try {
    const { ensure } = createRdEnsure({ store: controlPlaneStore, client: rdClient, now: clock });
    return (params) => ensure(params);
  } catch {
    return null;
  }
}

/**
 * Spread-ready RD ensure for searchByMedia calls: `{ ensureRealDebridFileIdentity }`
 * when RD is available, `{}` otherwise.
 */
export function rdEnsureForRequest({ rdClient, controlPlaneStore, clock = () => Date.now() } = {}) {
  const fn = buildRequestRdEnsureFn({ rdClient, controlPlaneStore, clock });
  return fn ? { ensureRealDebridFileIdentity: fn } : {};
}
