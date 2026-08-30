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
  if (!placement && torBoxInventoryProvider) {
    const observedPlacement = await torBoxInventoryProvider
      .require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
      .lookupPlacement({ infoHash });
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

    const magnet = `magnet:?xt:urn:btih:${infoHash}`;
    const placementCapability = torBoxProvider.require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE);
    const placementResult = await placementCapability.createPlacement({
      magnet,
      addOnlyIfCached: true,
    });
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
    const inventory = await torBoxInventoryProvider
      .require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
      .getFileInventory(placement);
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
