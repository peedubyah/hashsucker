/**
 * TorBox Delivery Resolver
 *
 * Owns the full TorBox placement lifecycle through the control plane store.
 * This is the single entry point for resolving a candidate to a TorBox delivery URL.
 *
 * Contract:
 *   (infoHash, fileIndex, releaseKey)
 *     → check existing placement in control plane
 *     → if absent and hash is known cached:
 *         → create cached-only TorBox placement
 *         → persist placement + file inventory + file mapping
 *     → resolve requestdl redirect URL
 *
 * Invariants:
 *   - Never creates an uncached TorBox download (add_only_if_cached=true)
 *   - Never assumes TorBox file ID equals corpus fileIndex
 *   - All state persisted through controlPlaneStore (single source of truth)
 *   - Idempotent: repeated calls reuse existing placement/mapping
 */

import path from 'node:path';

import { PROVIDER_CAPABILITIES } from '../providers/capabilities.js';
import { checkTorBoxCached } from '../providers/torbox.js';
import {
  REPAIR_FAILURE_CATEGORIES,
  recordRepairEvent,
} from '../control-plane/repair-events.js';
import { notifyStalePlacementRepaired } from '../control-plane/durability-enroller.js';
import { TorBoxDownloadUrlError } from './torbox-download-url-cache.js';
import { providerAccounting } from '../providers/provider-accounting.js';

const TORBOX_API_BASE = 'https://api.torbox.app/v1/api';

// Process-local single-flight registry. When multiple requests simultaneously
// discover the same stale placement, only one in-flight repair promise runs
// the expensive provider mutation; the others await the same outcome.
// Scope: per (provider, accountScope, infoHash). DB constraints are the final
// durable guard — the in-flight map is purely a latency / storm shield.
const repairInFlight = new Map();
function repairInFlightKey(infoHash) {
  return `torbox:default:${String(infoHash || '').toLowerCase()}`;
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

export class TorBoxDeliveryError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'TorBoxDeliveryError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Ensure a TorBox placement exists for the given candidate and return a delivery URL.
 *
 * @param {Object} params
 * @param {string} params.infoHash - Info hash
 * @param {number|null} params.fileIndex - Corpus file index
 * @param {string} params.releaseKey - Release key (infoHash:fileIndex)
 * @param {string} params.filename - Exact persisted candidate filename
 * @param {Object} params.controlPlaneStore - Control plane store instance
 * @param {Object} params.torBoxProvider - TorBox provider with PLACEMENT_CREATE capability
 * @param {Object} params.torBoxInventoryProvider - TorBox provider with lookup and inventory capabilities
 * @param {Function} [params.fetchFn] - Fetch implementation
 * @param {Function} [params.now] - Clock function
 * @returns {Promise<{ url: string, placementId: string, providerFileId: string, size: number|null }>}
 * @throws {TorBoxDeliveryError} When delivery cannot be resolved
 */
export async function ensureTorBoxDelivery({
  infoHash,
  fileIndex,
  releaseKey,
  filename,
  controlPlaneStore,
  torBoxProvider,
  torBoxInventoryProvider,
  fetchFn = fetch,
  now = () => Date.now(),
  signal,
}) {
  // Step 1: Reuse persisted control-plane state when present.
  let placement = controlPlaneStore.findPlacementByInfoHash('torbox', infoHash);

  // Combine any caller-provided client signal with each scoped timeout so a
  // client cancel propagates through every sub-call (mylist lookup,
  // inventory fetch, requestdl). Scoped timeouts remain the hard ceiling.
  const combinedSignal = (scopedMs) => {
    const timeout = AbortSignal.timeout(scopedMs);
    if (!signal) return timeout;
    return AbortSignal.any([timeout, signal]);
  };

  // Step 2: Passively recover an existing account placement before creating one.
  // Scoped longer timeout for the missing-placement recovery lookup only.
  // mylist?bypass_cache=true is authoritative but can exceed the default 5s timeout.
  if (!placement && torBoxInventoryProvider) {
    const recoverySignal = combinedSignal(15_000);
    providerAccounting.increment('torbox', 'placement_lookup_mylist');
    const observedPlacement = await torBoxInventoryProvider
      .require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
      .lookupPlacement({ infoHash }, { signal: recoverySignal });
    if (observedPlacement) {
      placement = controlPlaneStore.recordPlacement(observedPlacement);
      controlPlaneStore.recordPlacementLookupObservation({
        provider: observedPlacement.provider,
        accountScope: observedPlacement.accountScope,
        infoHash,
        observationState: 'present',
        placementId: placement.id,
        observedAt: observedPlacement.observedAt,
        expiresAt: observedPlacement.expiresAt,
        source: observedPlacement.provenance,
      });
    }
  }

  if (!placement) {
    // Step 3: Creation remains cached-only when no account placement exists.
    providerAccounting.increment('torbox', 'availability_checkcached');
    const cacheResult = await checkTorBoxCached([infoHash], { fetchFn });
    if (!cacheResult.cached.has(infoHash.toLowerCase())) {
      throw new TorBoxDeliveryError(
        'Hash is not cached on TorBox — refusing to create uncached download',
        'NOT_CACHED',
        404,
      );
    }

    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    const placementCapability = torBoxProvider.require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE);
    let placementResult;
    try {
      providerAccounting.increment('torbox', 'placement_create');
      placementResult = await placementCapability.createPlacement({
        magnet,
        addOnlyIfCached: true,
      });
    } catch (createError) {
      // Ambiguous timeout: createtorrent may have succeeded remotely.
      // Perform a fresh recovery lookup before retrying creation.
      if (torBoxInventoryProvider) {
        const recoverySignal = combinedSignal(15_000);
        providerAccounting.increment('torbox', 'placement_lookup_mylist');
        const observedPlacement = await torBoxInventoryProvider
          .require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
          .lookupPlacement({ infoHash }, { signal: recoverySignal });
        if (observedPlacement) {
          placement = controlPlaneStore.recordPlacement(observedPlacement);
          controlPlaneStore.recordPlacementLookupObservation({
            provider: observedPlacement.provider,
            accountScope: observedPlacement.accountScope,
            infoHash,
            observationState: 'present',
            placementId: placement.id,
            observedAt: observedPlacement.observedAt,
            expiresAt: observedPlacement.expiresAt,
            source: observedPlacement.provenance,
          });
        }
      }
      if (!placement) {
        throw createError;
      }
    }

    if (!placement) {
      const observedAt = now();
      placement = controlPlaneStore.recordPlacement({
        provider: 'torbox',
        accountScope: 'default',
        infoHash,
        providerResourceId: placementResult.providerResourceId,
        state: 'ready',
        ownership: 'owned',
        ownerKey: `vfs-${observedAt}`,
        provenance: 'torbox-delivery-resolver',
        observedAt,
        expiresAt: observedAt + 5 * 60 * 1000,
      });
    }
  }

  // Step 4: Find or establish the exact provider-file mapping.
  let mapping = controlPlaneStore.findFileMapping(releaseKey, placement.id);
  if (!mapping) {
    if (!torBoxInventoryProvider) {
      throw new TorBoxDeliveryError(
        'TorBox account inventory is required to establish an exact file mapping',
        'INVENTORY_UNAVAILABLE',
        503,
      );
    }
    const inventorySignal = combinedSignal(15_000);
    providerAccounting.increment('torbox', 'inventory_fetch');
    const inventory = await torBoxInventoryProvider
      .require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
      .getFileInventory(placement, { signal: inventorySignal });
    const files = controlPlaneStore.replaceProviderFileInventory(
      placement.id,
      inventory.files,
      {
        observedAt: inventory.observedAt,
        expiresAt: inventory.expiresAt,
        authoritative: inventory.authoritative,
        complete: inventory.complete,
        evidence: inventory.evidence,
      },
    );
    const matchingFile = findExactProviderFile(files, filename);
    mapping = controlPlaneStore.recordFileMapping({
      infoHash,
      fileIndex,
      releaseKey,
      placementId: placement.id,
      providerFileId: matchingFile.providerFileId,
      state: 'mapped',
      method: 'provider-filename-exact',
      authoritative: true,
      evidence: { candidateFilename: filename, providerPath: matchingFile.path },
      mappedAt: now(),
    });
  }

  // Step 5: Build redirect URL
  const apiKey = process.env.TORBOX_API_KEY;
  const params = new URLSearchParams({
    token: apiKey,
    torrent_id: placement.providerResourceId,
    file_id: mapping.providerFileId,
    redirect: 'true',
  });
  const url = `${TORBOX_API_BASE}/torrents/requestdl?${params.toString()}`;

  // Get size from file inventory
  const files = controlPlaneStore.listProviderFiles(placement.id);
  const file = files.find((f) => f.providerFileId === mapping.providerFileId);
  const size = file?.size ?? null;

  return {
    url,
    provider: placement.provider,
    accountScope: placement.accountScope,
    placementId: placement.id,
    providerFileId: mapping.providerFileId,
    size,
  };
}

function findExactProviderFile(files, filename) {
  const candidateName = path.posix.basename(String(filename ?? '').replaceAll('\\', '/'));
  if (!candidateName) {
    throw new TorBoxDeliveryError(
      'Persisted candidate filename is required for exact TorBox file mapping',
      'CANDIDATE_FILENAME_REQUIRED',
      500,
    );
  }
  const matches = files.filter((file) => file.name === candidateName);
  if (matches.length !== 1) {
    throw new TorBoxDeliveryError(
      matches.length === 0
        ? `No TorBox file exactly matches persisted candidate ${candidateName}`
        : `Multiple TorBox files exactly match persisted candidate ${candidateName}`,
      matches.length === 0 ? 'FILE_NOT_FOUND' : 'FILE_MAPPING_AMBIGUOUS',
      404,
    );
  }
  return matches[0];
}

/**
 * Resolve a TorBox delivery URL with bounded stale-placement recovery.
 *
 * This is the authoritative TorBox delivery seam. It owns:
 *   1. Placement reuse / passive mylist recovery / cached-only creation
 *   2. Exact provider-file mapping
 *   3. requestdl resolution through the short-lived CDN URL cache
 *   4. Bounded repair when requestdl fails for a reused placement whose
 *      upstream TorBox resource no longer exists in the user's mylist.
 *
 * Repair contract:
 *   - A repair attempt is allowed only when the current call reused an
 *     existing placement (i.e. a placement was already persisted before
 *     the call entered step 1 of `ensureTorBoxDelivery`).
 *   - A repair attempt is suppressed for HTTP 429 (throttling) and for
 *     timeout-class failures (transient network).
 *   - The repair is bounded to ONE attempt per resolver request. After
 *     a repair is attempted — regardless of outcome — the result of the
 *     re-entered lifecycle is the final answer; no further repair is
 *     permitted.
 *   - Recovery is scoped to the SAME (releaseKey, infoHash, fileIndex,
 *     filename). No rediscovery, reranking, or playback_handoff mutation
 *     is permitted.
 *
 * @param {Object} params
 * @param {string} params.infoHash
 * @param {number|null} params.fileIndex
 * @param {string} params.releaseKey
 * @param {string} params.filename
 * @param {Object} params.controlPlaneStore
 * @param {Object} params.torBoxProvider
 * @param {Object} params.torBoxInventoryProvider
 * @param {Object} params.torBoxDownloadUrlCache
 * @param {Function} params.resolveTorBoxDownloadUrl
 * @param {Function} [params.isUrlLive]
 * @param {Function} [params.fetchFn]
 * @param {Function} [params.now]
 * @returns {Promise<{ url: string, placementId: string, providerFileId: string, size: number|null, recovered: boolean }>}
 */
export async function resolveTorBoxDeliveryWithStaleRecovery({
  infoHash,
  fileIndex,
  releaseKey,
  filename,
  controlPlaneStore,
  torBoxProvider,
  torBoxInventoryProvider,
  torBoxDownloadUrlCache,
  resolveTorBoxDownloadUrl,
  isUrlLive,
  fetchFn = fetch,
  now = () => Date.now(),
  signal,
}) {
  // Process-local single-flight: concurrent calls for the same (provider,
  // accountScope, infoHash) reuse one in-flight repair promise. This stops
  // two simultaneous stale discoveries from racing to (a) mylist-lookup,
  // (b) mark the same placement removed (idempotent), then (c) each
  // attempting to createPlacement and one of them falling over the
  // UNIQUE(provider, account_scope, provider_resource_id) constraint.
  const key = repairInFlightKey(infoHash);
  const existing = repairInFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await runStaleRecoveryOnce({
        infoHash, fileIndex, releaseKey, filename,
        controlPlaneStore, torBoxProvider, torBoxInventoryProvider,
        torBoxDownloadUrlCache, resolveTorBoxDownloadUrl, isUrlLive,
        fetchFn, now, signal,
      });
    } finally {
      repairInFlight.delete(key);
    }
  })();
  repairInFlight.set(key, promise);
  return promise;
}

async function runStaleRecoveryOnce({
  infoHash, fileIndex, releaseKey, filename,
  controlPlaneStore, torBoxProvider, torBoxInventoryProvider,
  torBoxDownloadUrlCache, resolveTorBoxDownloadUrl, isUrlLive,
  fetchFn, now, signal,
}) {
  // Detect whether the current call will reuse an existing placement.
  // If the call enters the creation path (no existing placement) and
  // requestdl fails, there is nothing to recover — the placement was
  // created in this same call and any failure should surface as-is.
  const existingPlacement = controlPlaneStore.findPlacementByInfoHash('torbox', infoHash);
  const reusedExistingPlacementId = existingPlacement?.id ?? null;

  let delivery;
  try {
    delivery = await ensureTorBoxDelivery({
      infoHash, fileIndex, releaseKey, filename,
      controlPlaneStore, torBoxProvider, torBoxInventoryProvider,
      fetchFn, now, signal,
    });
  } catch (error) {
    if (isClientAbortError(error)) {
      // Client cancellation is not a provider failure; the valid cached
      // capability must not be invalidated by an aborted call.
      throw error;
    }
    if (error instanceof TorBoxDeliveryError && error.code === 'NOT_CACHED') {
      recordRepairEvent(controlPlaneStore, {
        failureCategory: REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_UNRECOVERABLE,
        infoHash,
        reason: 'torbox-not-cached',
        evidence: { stage: 'placement-create', fileIndex, releaseKey },
        observedAt: now(),
        now,
      });
    }
    throw error;
  }

  try {
    const downloadUrl = await resolveCachedDownloadUrl({
      delivery,
      torBoxDownloadUrlCache,
      resolveTorBoxDownloadUrl,
      isUrlLive,
      signal,
      infoHash,
      controlPlaneStore,
      now,
    });
    return { ...downloadUrl, recovered: false };
  } catch (error) {
    if (isClientAbortError(error)) {
      // Same rule: do not let a cancelled read poison the cache.
      throw error;
    }
    // Classify the requestdl failure before invoking repair so that
    // observability does not depend on the repair branch succeeding.
    if (error instanceof TorBoxDownloadUrlError) {
      // Protocol-invalid takes priority over 5xx because it is
      // structurally a 502 (the wrapper maps every non-HTTP failure
      // to 502) but the failure class is the SAME as 401/403/404:
      // the cached URL is not a usable capability and must be
      // invalidated so the next call re-resolves once.
      if (error.code === 'TORBOX_REQUESTDL_PROTOCOL_INVALID') {
        const capability = {
          provider: delivery.provider,
          accountScope: delivery.accountScope,
          placementId: delivery.placementId,
          providerFileId: delivery.providerFileId,
        };
        torBoxDownloadUrlCache.invalidateByCapability?.(capability);
        recordRepairEvent(controlPlaneStore, {
          failureCategory: REPAIR_FAILURE_CATEGORIES.DELIVERY_CAPABILITY_PROTOCOL_INVALID,
          infoHash,
          reason: 'torbox-requestdl-protocol-invalid',
          evidence: {
            stage: 'requestdl',
            status: error.status ?? null,
            code: error.code,
            reason: error.protocolInvalidReason ?? null,
            placementId: delivery.placementId,
            providerFileId: delivery.providerFileId,
          },
          retryable: true,
          observedAt: now(),
          now,
        });
        // Surface the protocol-invalid error unchanged. The same call
        // does NOT retry; the next call's getOrInFlightByCapability
        // will not find a cached entry and re-resolve exactly once.
        throw error;
      }
      if (error.status === 429) {
        recordRepairEvent(controlPlaneStore, {
          failureCategory: REPAIR_FAILURE_CATEGORIES.REQUESTDL_RATE_LIMITED,
          infoHash,
          reason: 'torbox-requestdl-429',
          evidence: {
            stage: 'requestdl',
            retryAfterMs: error.retryAfterMs ?? null,
            placementId: delivery.placementId,
            providerFileId: delivery.providerFileId,
          },
          retryable: false,
          observedAt: now(),
          now,
        });
      } else if (typeof error.status === 'number' && error.status >= 500 && error.status < 600) {
        recordRepairEvent(controlPlaneStore, {
          failureCategory: REPAIR_FAILURE_CATEGORIES.REQUESTDL_UPSTREAM_5XX,
          infoHash,
          reason: `torbox-requestdl-${error.status}`,
          evidence: {
            stage: 'requestdl',
            status: error.status,
            placementId: delivery.placementId,
            providerFileId: delivery.providerFileId,
          },
          retryable: false,
          observedAt: now(),
          now,
        });
      } else if (error.status === 401 || error.status === 403 || error.status === 404) {
        // Capability expired or revoked: invalidate so the next call
        // re-resolves once. The same call does not retry; that is the
        // bounded one re-resolution contract.
        const capability = {
          provider: delivery.provider,
          accountScope: delivery.accountScope,
          placementId: delivery.placementId,
          providerFileId: delivery.providerFileId,
        };
        torBoxDownloadUrlCache.invalidateByCapability?.(capability);
        recordRepairEvent(controlPlaneStore, {
          failureCategory: REPAIR_FAILURE_CATEGORIES.DELIVERY_CAPABILITY_EXPIRED,
          infoHash,
          reason: `torbox-requestdl-${error.status}`,
          evidence: {
            stage: 'requestdl',
            status: error.status,
            placementId: delivery.placementId,
            providerFileId: delivery.providerFileId,
          },
          retryable: true,
          observedAt: now(),
          now,
        });
      }
    }
    const recovered = await recoverStalePlacement({
      originalError: error,
      infoHash,
      fileIndex,
      releaseKey,
      filename,
      reusedExistingPlacementId,
      controlPlaneStore,
      torBoxProvider,
      torBoxInventoryProvider,
      torBoxDownloadUrlCache,
      resolveTorBoxDownloadUrl,
      isUrlLive,
      fetchFn,
      now,
    });
    return { ...recovered, recovered: true };
  }
}

async function resolveCachedDownloadUrl({
  delivery,
  torBoxDownloadUrlCache,
  resolveTorBoxDownloadUrl,
  isUrlLive,
  signal,
  infoHash,
  controlPlaneStore,
  now,
}) {
  const capability = {
    provider: delivery.provider,
    accountScope: delivery.accountScope,
    placementId: delivery.placementId,
    providerFileId: delivery.providerFileId,
  };
  let cachedDownload = torBoxDownloadUrlCache.getByCapability?.(capability) ?? null;
  if (cachedDownload && isUrlLive && !await isUrlLive(cachedDownload.url)) {
    torBoxDownloadUrlCache.invalidateByCapability?.(capability);
    cachedDownload = null;
  }
  if (cachedDownload?.url) {
    return {
      url: cachedDownload.url,
      provider: delivery.provider,
      accountScope: delivery.accountScope,
      placementId: delivery.placementId,
      providerFileId: delivery.providerFileId,
      size: delivery.size,
    };
  }
  let recoveredNow = false;
  const url = await torBoxDownloadUrlCache.getOrInFlightByCapability(
    capability,
    async () => {
      // A single bounded re-resolution is allowed per cache miss. If
      // requestdl returns 401/403/404 the seam invalidates the cache so
      // the NEXT call (not this one) re-resolves once. The same call does
      // not loop on 401/403/404 — that would amplify provider failures.
      const resolved = await resolveTorBoxDownloadUrl(delivery.url, { signal });
      if (!recoveredNow && controlPlaneStore && infoHash) {
        recoveredNow = true;
        recordRepairEvent(controlPlaneStore, {
          failureCategory: REPAIR_FAILURE_CATEGORIES.DELIVERY_CAPABILITY_RECOVERED,
          infoHash,
          reason: 'torbox-requestdl-re-resolved',
          evidence: {
            stage: 'requestdl-re-resolution',
            placementId: delivery.placementId,
            providerFileId: delivery.providerFileId,
          },
          retryable: false,
          observedAt: now ? now() : Date.now(),
          now,
        });
      }
      torBoxDownloadUrlCache.setByCapability(capability, resolved);
      return resolved;
    },
  );
  return {
    url,
    provider: delivery.provider,
    accountScope: delivery.accountScope,
    placementId: delivery.placementId,
    providerFileId: delivery.providerFileId,
    size: delivery.size,
  };
}

async function recoverStalePlacement({
  originalError,
  infoHash,
  fileIndex,
  releaseKey,
  filename,
  reusedExistingPlacementId,
  controlPlaneStore,
  torBoxProvider,
  torBoxInventoryProvider,
  torBoxDownloadUrlCache,
  resolveTorBoxDownloadUrl,
  isUrlLive,
  fetchFn,
  now,
  signal,
}) {
  // Recovery is bounded and selective. The seam never re-creates on
  // 429 (throttling), timeout-class failures, or transport-level
  // network failures (no HTTP response). The mylist lookup is the
  // sole authoritative signal for whether the upstream resource is
  // gone; status alone is not sufficient to trigger destructive
  // repair. The seam only repairs when the failing call had reused
  // an existing placement.
  if (!reusedExistingPlacementId) throw originalError;
  if (isClientAbortError(originalError)) throw originalError;
  if (originalError instanceof TorBoxDownloadUrlError && originalError.status === 429) {
    throw originalError;
  }
  if (originalError instanceof TorBoxDownloadUrlError && originalError.code === 'TORBOX_REQUESTDL_TIMEOUT') {
    throw originalError;
  }
  // Transport-level network failure (resolveTorBoxDownloadUrl wraps
  // any non-HTTP fetch throw as a 502 with code TORBOX_REQUESTDL_FAILED
  // and the DOWNSTREAM_URL_MISSING branch is 502 as well). Suppress
  // destructive repair for transport-level errors so a transient
  // network blip cannot rotate the durable placement identity.
  if (originalError instanceof TorBoxDownloadUrlError
      && (originalError.code === 'TORBOX_DOWNSTREAM_URL_MISSING'
        || (originalError.status === 502
            && originalError.code !== 'TORBOX_REQUESTDL_FAILED'))) {
    throw originalError;
  }
  if (!(originalError instanceof TorBoxDownloadUrlError)) throw originalError;
  if (!torBoxInventoryProvider) throw originalError;
  if (typeof controlPlaneStore.markPlacementRemoved !== 'function') throw originalError;

  // One authoritative mylist lookup scoped to the SAME (provider, infoHash).
  // This is the seam that asks the only TorBox endpoint that actually
  // represents whether the user still owns this resource.
  const lookupTimeout = AbortSignal.timeout(15_000);
  const lookupSignal = signal ? AbortSignal.any([lookupTimeout, signal]) : lookupTimeout;
  let observedPlacement = null;
  try {
    providerAccounting.increment('torbox', 'placement_lookup_mylist');
    observedPlacement = await torBoxInventoryProvider
      .require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
      .lookupPlacement({ infoHash }, { signal: lookupSignal });
  } catch (lookupError) {
    if (isClientAbortError(lookupError)) throw lookupError;
    recordRepairEvent(controlPlaneStore, {
      failureCategory: REPAIR_FAILURE_CATEGORIES.INVENTORY_REFRESH_FAILED,
      infoHash,
      reason: 'torbox-mylist-lookup-failed-during-recovery',
      evidence: { stage: 'recovery-lookup', error: lookupError?.message ?? null },
      retryable: false,
      observedAt: now(),
      now,
    });
    // Best-effort: if the lookup itself errors, surface the original
    // requestdl failure unchanged.
    throw originalError;
  }

  if (observedPlacement) {
    // Resource still exists upstream — the requestdl failure is
    // transient or otherwise not lifecycle-related. Surface unchanged.
    throw originalError;
  }

  // Resource is absent upstream. Invalidate the stale local placement
  // and re-enter the lifecycle ONCE for the SAME (releaseKey, infoHash,
  // fileIndex, filename). findPlacementByInfoHash now returns null
  // (the placement is state='removed'), so ensureTorBoxDelivery will
  // execute the cached-only creation path against a fresh resource.
  let markRemovedOk = true;
  try {
    controlPlaneStore.markPlacementRemoved(reusedExistingPlacementId, {
      reason: 'upstream-resource-absent',
      observedAt: now(),
    });
  } catch {
    // If the placement was already invalidated by a concurrent path,
    // proceed to the re-entered lifecycle anyway.
    markRemovedOk = false;
  }

  let recoveredDelivery;
  try {
    recoveredDelivery = await ensureTorBoxDelivery({
      infoHash,
      fileIndex,
      releaseKey,
      filename,
      controlPlaneStore,
      torBoxProvider,
      torBoxInventoryProvider,
      fetchFn,
      now,
      signal,
    });
  } catch (createError) {
    if (isClientAbortError(createError)) throw createError;
    const category = (createError instanceof TorBoxDeliveryError && createError.code === 'NOT_CACHED')
      ? REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_UNRECOVERABLE
      : REPAIR_FAILURE_CATEGORIES.CACHED_ONLY_PLACEMENT_RECREATION_FAILED;
    recordRepairEvent(controlPlaneStore, {
      failureCategory: category,
      infoHash,
      reason: createError instanceof TorBoxDeliveryError
        ? `torbox-create-${createError.code ?? 'unknown'}`
        : 'torbox-create-threw',
      evidence: {
        stage: 'cached-only-recreate',
        markRemovedOk,
        code: createError?.code ?? null,
        status: createError?.status ?? null,
        message: createError?.message ?? null,
      },
      retryable: false,
      observedAt: now(),
      now,
    });
    throw createError;
  }

  const recoveredUrl = await resolveCachedDownloadUrl({
    delivery: recoveredDelivery,
    torBoxDownloadUrlCache,
    resolveTorBoxDownloadUrl,
    isUrlLive,
    signal,
    infoHash,
    controlPlaneStore,
    now,
  });

  // Repair succeeded: durable identity preserved (torrent_files rows are
  // re-used by canonical (infoHash, internal_path, size) within the new
  // placement's authoritative inventory refresh). Record the success.
  const newPlacementRow = controlPlaneStore.findPlacementByInfoHash('torbox', infoHash);
  const repairedAt = now();
  recordRepairEvent(controlPlaneStore, {
    failureCategory: REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED,
    infoHash,
    reason: 'stale-placement-repaired-cached-only-recreate',
    evidence: {
      stage: 'repair-complete',
      previousPlacementId: reusedExistingPlacementId,
      newPlacementId: recoveredDelivery.placementId,
      newProviderResourceId: newPlacementRow.providerResourceId,
      newProviderFileId: recoveredDelivery.providerFileId,
    },
    retryable: false,
    observedAt: repairedAt,
    now,
  });
  // Notify the durability enroller so a freshly-repaired authoritative
  // item is enrolled for its next durability pass. No-op when the
  // scheduler is not registered (default-disabled mode). Failure here
  // is non-fatal: the repair itself already succeeded.
  try {
    const libraryItem = typeof controlPlaneStore.findLibraryItemByInfoHash === 'function'
      ? controlPlaneStore.findLibraryItemByInfoHash(infoHash)
      : null;
    if (libraryItem) {
      notifyStalePlacementRepaired({
        libraryItemId: libraryItem.id,
        failureCategory: REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED,
        infoHash,
        occurredAt: repairedAt,
      });
    }
  } catch {
    // durability enrollment is best-effort; never poison the repair
  }
  return recoveredUrl;
}
