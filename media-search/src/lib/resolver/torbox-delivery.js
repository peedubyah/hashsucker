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
import { TorBoxDownloadUrlError } from './torbox-download-url-cache.js';

const TORBOX_API_BASE = 'https://api.torbox.app/v1/api';

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
}) {
  // Step 1: Reuse persisted control-plane state when present.
  let placement = controlPlaneStore.findPlacementByInfoHash('torbox', infoHash);

  // Step 2: Passively recover an existing account placement before creating one.
  // Scoped longer timeout for the missing-placement recovery lookup only.
  // mylist?bypass_cache=true is authoritative but can exceed the default 5s timeout.
  if (!placement && torBoxInventoryProvider) {
    const recoverySignal = AbortSignal.timeout(15_000);
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
      placementResult = await placementCapability.createPlacement({
        magnet,
        addOnlyIfCached: true,
      });
    } catch (createError) {
      // Ambiguous timeout: createtorrent may have succeeded remotely.
      // Perform a fresh recovery lookup before retrying creation.
      if (torBoxInventoryProvider) {
        const recoverySignal = AbortSignal.timeout(15_000);
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
    const inventorySignal = AbortSignal.timeout(15_000);
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
}) {
  // Detect whether the current call will reuse an existing placement.
  // If the call enters the creation path (no existing placement) and
  // requestdl fails, there is nothing to recover — the placement was
  // created in this same call and any failure should surface as-is.
  const existingPlacement = controlPlaneStore.findPlacementByInfoHash('torbox', infoHash);
  const reusedExistingPlacementId = existingPlacement?.id ?? null;

  const delivery = await ensureTorBoxDelivery({
    infoHash,
    fileIndex,
    releaseKey,
    filename,
    controlPlaneStore,
    torBoxProvider,
    torBoxInventoryProvider,
    fetchFn,
    now,
  });

  try {
    const downloadUrl = await resolveCachedDownloadUrl({
      delivery,
      torBoxDownloadUrlCache,
      resolveTorBoxDownloadUrl,
      isUrlLive,
    });
    return { ...downloadUrl, recovered: false };
  } catch (error) {
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
  const url = await torBoxDownloadUrlCache.getOrInFlightByCapability(
    capability,
    async () => {
      const resolved = await resolveTorBoxDownloadUrl(delivery.url);
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
}) {
  // Recovery is bounded and selective. The seam never re-creates on
  // 429 (throttling) or for timeout-class failures. The seam only
  // repairs when the failing call had reused an existing placement.
  if (!reusedExistingPlacementId) throw originalError;
  if (originalError instanceof TorBoxDownloadUrlError && originalError.status === 429) {
    throw originalError;
  }
  if (originalError instanceof TorBoxDownloadUrlError && originalError.code === 'TORBOX_REQUESTDL_TIMEOUT') {
    throw originalError;
  }
  if (!(originalError instanceof TorBoxDownloadUrlError)) throw originalError;
  if (!torBoxInventoryProvider) throw originalError;
  if (typeof controlPlaneStore.markPlacementRemoved !== 'function') throw originalError;

  // One authoritative mylist lookup scoped to the SAME (provider, infoHash).
  // This is the seam that asks the only TorBox endpoint that actually
  // represents whether the user still owns this resource.
  let observedPlacement = null;
  try {
    const lookupSignal = AbortSignal.timeout(15_000);
    observedPlacement = await torBoxInventoryProvider
      .require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
      .lookupPlacement({ infoHash }, { signal: lookupSignal });
  } catch {
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
  try {
    controlPlaneStore.markPlacementRemoved(reusedExistingPlacementId, {
      reason: 'upstream-resource-absent',
      observedAt: now(),
    });
  } catch {
    // If the placement was already invalidated by a concurrent path,
    // proceed to the re-entered lifecycle anyway.
  }

  const recoveredDelivery = await ensureTorBoxDelivery({
    infoHash,
    fileIndex,
    releaseKey,
    filename,
    controlPlaneStore,
    torBoxProvider,
    torBoxInventoryProvider,
    fetchFn,
    now,
  });

  const recoveredUrl = await resolveCachedDownloadUrl({
    delivery: recoveredDelivery,
    torBoxDownloadUrlCache,
    resolveTorBoxDownloadUrl,
    isUrlLive,
  });
  return recoveredUrl;
}
