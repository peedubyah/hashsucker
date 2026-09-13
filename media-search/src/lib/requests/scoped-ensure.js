/**
 * Request-scoped TorBox ensure-function factory.
 *
 * Wraps ensureTorBoxFileIdentity so every placement-lookup/inventory read
 * inside one request shares a single coordinator-owned mylist snapshot
 * (placement creates invalidate it, so fresh torrents are never missed).
 * Without this, each selection attempt re-downloads the full account
 * list — typically 2 full mylist fetches per bindable candidate
 * (verify + inventory) on the Seerr ingress path.
 *
 * Strictly equivalent data semantics: the snapshot source, the
 * bypass_cache behavior, and the create-invalidation rules are
 * unchanged; reads that would have been two sequential downloads
 * become one shared download of the same endpoint. Falls back to the
 * shared seam unchanged whenever scoping is unavailable.
 */
import { createTorBoxInventoryProvider } from '../providers/torbox-inventory.js';
import { TorBoxCallCoordinator } from '../providers/torbox-call-coordinator.js';
import { ensureTorBoxFileIdentity } from '../resolver/torbox-file-identity.js';

export function buildRequestScopedEnsureFn({
  fallbackFn = null,
  explicitFn = false,
  controlPlaneStore = null,
  torBoxProvider = null,
  apiKey = null,
  apiBase = undefined,
  clock = () => Date.now(),
  scope = 'media-request',
  fetchFn = undefined,
} = {}) {
  if (explicitFn || !controlPlaneStore || !torBoxProvider || !apiKey) return fallbackFn;
  try {
    const requestInventoryProvider = createTorBoxInventoryProvider({
      apiKey,
      apiBase,
      now: clock,
      coordinator: new TorBoxCallCoordinator({ scope }),
      ...(fetchFn ? { fetchFn } : {}),
    });
    return (params) => ensureTorBoxFileIdentity({
      ...params,
      controlPlaneStore,
      torBoxProvider,
      torBoxInventoryProvider: requestInventoryProvider,
      now: clock,
    });
  } catch {
    // Scoping failed; use the shared seam unchanged.
    return fallbackFn;
  }
}
