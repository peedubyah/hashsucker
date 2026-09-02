import { PROVIDER_CAPABILITIES, createProviderAdapter } from './capabilities.js';
import { classifyProviderError, ProviderOperationError } from './errors.js';
import { createPlacementObservation, createProviderFileInventory } from './resources.js';

const API_BASE = 'https://api.torbox.app/v1/api';
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_OBSERVATION_TTL_MS = 60_000;

/**
 * TorBox account-inventory adapter backed by the repository-verified `mylist`
 * response consumed by torbox-importer. Inventory proves external placement,
 * readiness, and provider file identity; it never proves HashSucker ownership.
 *
 * Slice 2.7 — Provider API efficiency.
 *
 * The inventory provider threads all `mylist` fetches through an
 * opt-in per-request coordinator. The coordinator handles:
 *
 *   - single-flight per request  (concurrent mylist calls share one fetch)
 *   - request-scoped memoization (sequential mylist calls reuse the snapshot)
 *   - bounded retry on 5xx / 429 (configurable via the coordinator)
 *
 * The coordinator and its budget are passed in by the request owner
 * (a media-request handler, canary, or test). When no coordinator is
 * provided, the provider falls back to direct fetchFn calls — the
 * same behavior as pre-2.7 — so a long-lived provider instance never
 * leaks memoization across unrelated requests.
 */
export function createTorBoxInventoryProvider(options = {}) {
  const {
    accountScope = 'default',
    apiKey = process.env.TORBOX_API_KEY,
    apiBase = process.env.TORBOX_API_URL ?? API_BASE,
    fetchFn = fetch,
    timeoutMs = REQUEST_TIMEOUT_MS,
    observationTtlMs = DEFAULT_OBSERVATION_TTL_MS,
    now = () => Date.now(),
    coordinator,
  } = options;
  if (!apiKey) throw authenticationError('TORBOX_API_KEY is missing', 'configure');

  // Coordinator is opt-in. When the request owner supplies a
  // per-request coordinator, all mylist calls inside that request
  // share a single fetch (single-flight + memoization + retry
  // consolidation). When no coordinator is supplied, the provider
  // falls back to direct fetchFn calls — the same behavior as
  // pre-2.7 — so we never leak memoization across unrelated
  // requests on a long-lived provider instance.
  const useCoordinator = coordinator != null;
  const activeCoordinator = coordinator ?? null;

  /**
   * Fetch a single mylist snapshot.
   * - With a per-request coordinator: shared, retried, memoized.
   * - Without one: direct fetchFn, no cross-call sharing.
   */
  async function fetchMylistSnapshot({ signal } = {}) {
    if (!useCoordinator) {
      return directMylistFetch(signal);
    }
    const args = [apiBase, apiKey, signal];
    return activeCoordinator.run('mylist', args, (base, key, sig) => directMylistFetch(sig, base, key));
  }

  async function directMylistFetch(signal, baseOverride = apiBase, keyOverride = apiKey) {
    const response = await fetchFn(`${baseOverride}/torrents/mylist?bypass_cache=true`, {
      headers: {
        Authorization: `Bearer ${keyOverride}`,
        Accept: 'application/json',
        'User-Agent': 'media-search/0.0.1',
      },
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const err = new Error(`TorBox mylist failed: HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const payload = await response.json();
    if (payload?.success !== true || !Array.isArray(payload.data)) {
      throw invalidResponse('TorBox mylist must return success with a data array', 'mylist');
    }
    return { observedAt: now(), resources: payload.data };
  }

  /**
   * Backwards-compatible `getSnapshot` that adapts the new
   * coordinator-shaped snapshot to the pre-2.7 interface that
   * existing capabilities used. The shape is identical (observedAt
   * + resources).
   */
  async function getSnapshot(signal) {
    try {
      return await fetchMylistSnapshot({ signal });
    } catch (error) {
      // The coordinator already retried; this is the final settled error.
      throw classifyProviderError(error, { provider: 'torbox', operation: 'mylist' });
    }
  }

  return createProviderAdapter({
    provider: 'torbox',
    accountScope,
    capabilities: {
      [PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP]: {
        async lookupPlacement(subject, context = {}) {
          const infoHash = normalizeInfoHash(subject?.infoHash);
          const snapshot = await getSnapshot(context.signal);
          const matches = snapshot.resources.filter((resource) => normalizeOptionalInfoHash(resource?.hash) === infoHash);
          if (matches.length === 0) return null;
          if (matches.length > 1) throw conflictError(`Multiple TorBox resources match ${infoHash}`, 'lookup-placement');
          return placementFromResource(matches[0], infoHash, snapshot.observedAt, {
            accountScope, observationTtlMs,
          });
        },
      },
      [PROVIDER_CAPABILITIES.RESOURCE_READINESS]: {
        async observeReadiness(resource, context = {}) {
          const infoHash = normalizeInfoHash(resource?.infoHash);
          const providerResourceId = requireProviderId(resource?.providerResourceId, 'providerResourceId');
          const snapshot = await getSnapshot(context.signal);
          const match = snapshot.resources.find((item) => String(item?.id) === providerResourceId);
          if (!match) {
            return createPlacementObservation({
              provider: 'torbox', accountScope, infoHash, providerResourceId,
              state: 'removed', ownership: resource.ownership ?? 'unknown',
              ownerKey: resource.ownerKey ?? null, provenance: 'torbox-mylist-v1',
              observedAt: snapshot.observedAt, ttlMs: observationTtlMs,
            });
          }
          const providerHash = normalizeOptionalInfoHash(match.hash);
          if (providerHash !== infoHash) {
            throw conflictError('TorBox resource ID hash does not match expected placement hash', 'observe-readiness');
          }
          return placementFromResource(match, infoHash, snapshot.observedAt, {
            accountScope, observationTtlMs,
            ownership: resource.ownership ?? 'unknown', ownerKey: resource.ownerKey ?? null,
          });
        },
      },
      [PROVIDER_CAPABILITIES.FILE_INVENTORY]: {
        async getFileInventory(resource, context = {}) {
          const providerResourceId = requireProviderId(resource?.providerResourceId, 'providerResourceId');
          const snapshot = await getSnapshot(context.signal);
          const match = snapshot.resources.find((item) => String(item?.id) === providerResourceId);
          if (!match) throw notFoundError(`TorBox resource ${providerResourceId} is absent`, 'file-inventory');
          if (!Array.isArray(match.files)) throw invalidResponse('TorBox mylist resource files must be an array', 'file-inventory');
          return createProviderFileInventory({
            provider: 'torbox', accountScope, providerResourceId,
            authoritative: true, complete: true,
            observedAt: snapshot.observedAt, ttlMs: observationTtlMs,
            files: match.files.map(normalizeFile),
            evidence: { source: 'torbox-mylist-v1' },
          });
        },
      },
    },
  });
}

function placementFromResource(resource, infoHash, observedAt, options) {
  return createPlacementObservation({
    provider: 'torbox', accountScope: options.accountScope, infoHash,
    providerResourceId: requireProviderId(resource?.id, 'resource.id'),
    state: deriveReadiness(resource),
    ownership: options.ownership ?? 'external',
    ownerKey: options.ownerKey ?? null,
    provenance: 'torbox-mylist-v1',
    observedAt, ttlMs: options.observationTtlMs,
    evidence: { rawState: firstString(resource.download_state, resource.state, resource.download_status, resource.status) },
  });
}

function deriveReadiness(resource) {
  const raw = firstString(resource?.download_state, resource?.state, resource?.download_status, resource?.status);
  if (raw == null) return Array.isArray(resource?.files) && resource.files.length > 0 ? 'ready' : 'unknown';
  const state = raw.toLowerCase().replaceAll(' ', '_');
  if (['cached', 'completed', 'downloaded', 'ready', 'seeding', 'uploading'].includes(state)) return 'ready';
  if (['queued', 'checking_resume_data', 'downloading', 'meta_downloading', 'pending'].includes(state)) return 'pending';
  if (['error', 'failed'].includes(state)) return 'error';
  return 'unknown';
}

function normalizeFile(file) {
  if (!file || typeof file !== 'object') throw invalidResponse('TorBox file must be an object', 'file-inventory');
  const providerFileId = requireProviderId(file.id, 'file.id');
  const filePath = requireString(file.name, 'file.name');
  const name = filePath.replaceAll('\\', '/').split('/').filter(Boolean).at(-1);
  if (!name) throw invalidResponse('TorBox file name must contain a basename', 'file-inventory');
  return {
    providerFileId,
    path: filePath,
    name,
    size: normalizeSize(file.size),
    selected: file.selected == null ? null : file.selected === true || file.selected === 1,
    corpusFileIndex: null,
    evidence: { source: 'torbox-mylist-v1' },
  };
}

function normalizeInfoHash(value) {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new TypeError('TorBox inventory requires a valid infoHash');
  return hash;
}
function normalizeOptionalInfoHash(value) {
  try { return normalizeInfoHash(value); } catch { return null; }
}
function requireProviderId(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim().length === 0) {
    throw invalidResponse(`${field} is required`, 'mylist');
  }
  return String(value).trim();
}
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalidResponse(`${field} is required`, 'mylist');
  return value.trim();
}
function normalizeSize(value) {
  if (value == null) return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw invalidResponse('file.size must be a non-negative safe integer', 'file-inventory');
  return size;
}
function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
}
function providerError(message, operation, category, retryable = false) {
  return new ProviderOperationError(message, { provider: 'torbox', operation, category, retryable });
}
function invalidResponse(message, operation) { return providerError(message, operation, 'invalid-response'); }
function conflictError(message, operation) { return providerError(message, operation, 'conflict', true); }
function notFoundError(message, operation) { return providerError(message, operation, 'not-found'); }
function authenticationError(message, operation) { return providerError(message, operation, 'authentication'); }
