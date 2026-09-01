/**
 * TorBox File Identity Helper (Slice 1.75)
 *
 * Establishes a durable control-plane identity binding BEFORE a playback
 * handoff is persisted. The contract is:
 *
 *   (infoHash, selectedFileSize)
 *     → TorBox account placement (find or passively recover via mylist)
 *     → authoritative TorBox file inventory (provider files with size)
 *     → UNIQUE present provider_file with size === selectedFileSize
 *     → provider_files.torrent_file_id  (the durable physical-file id)
 *
 * Failure modes are explicit and deterministic:
 *   - INVALID_INPUT:        bad infoHash / missing or non-positive selectedFileSize
 *   - INVENTORY_UNAVAILABLE: torBoxInventoryProvider is not configured
 *   - INVENTORY_ERROR:      inventory fetch threw (caller may inspect error)
 *   - NO_PLACEMENT:         no TorBox resource matches the infoHash
 *   - NO_FILE_SIZE_MATCH:   zero present provider files with the exact size
 *   - AMBIGUOUS_FILE_SIZE:  more than one present provider file with the exact size
 *   - MISSING_TORRENT_FILE: the matched provider file has no torrent_file_id
 *
 * The helper does NOT:
 *   - mint provider_file_id from basename / path basename / fileIndex / X
 *   - fall back to torrent total size, rounded GiB, or parsed title sizes
 *   - issue requestdl or resolve a CDN URL
 *
 * @see torbox-delivery.js for the requestdl-resolution seam built on top of
 *      the same inventory machinery.
 */

import { PROVIDER_CAPABILITIES } from '../providers/capabilities.js';

const INVALID_INPUT = 'INVALID_INPUT';
const INVENTORY_UNAVAILABLE = 'INVENTORY_UNAVAILABLE';
const INVENTORY_ERROR = 'INVENTORY_ERROR';
const NO_PLACEMENT = 'NO_PLACEMENT';
const NO_FILE_SIZE_MATCH = 'NO_FILE_SIZE_MATCH';
const AMBIGUOUS_FILE_SIZE = 'AMBIGUOUS_FILE_SIZE';
const MISSING_TORRENT_FILE = 'MISSING_TORRENT_FILE';

export class TorBoxFileIdentityError extends Error {
  constructor(message, code, info) {
    super(message);
    this.name = 'TorBoxFileIdentityError';
    this.code = code;
    this.info = info || null;
  }
}

/**
 * Ensure a TorBox file identity exists for the given infoHash + exact size.
 *
 * @param {Object} params
 * @param {string} params.infoHash - 40-char lowercase infoHash (validated)
 * @param {number} params.selectedFileSize - positive integer byte count from
 *   BehaviorHints.videoSize. NOT a torrent total size, NOT a rounded value,
 *   NOT a parsed title size.
 * @param {Object} params.controlPlaneStore - controlPlaneStore instance
 * @param {Object} [params.torBoxInventoryProvider] - adapter with FILE_INVENTORY
 * @param {Object} [params.torBoxProvider] - placement provider (passive recovery)
 * @param {string} [params.releaseKey] - releaseKey for cache lookup (optional)
 * @param {string} [params.accountScope='default'] - placement account scope
 * @param {Function} [params.now] - clock
 * @param {Function} [params.fetchSignal] - optional AbortSignal factory
 * @returns {Promise<{ placementId: string, providerFileId: string, torrentFileId: string, size: number }>}
 * @throws {TorBoxFileIdentityError} on every failure path with deterministic code
 */
export async function ensureTorBoxFileIdentity({
  infoHash,
  selectedFileSize,
  controlPlaneStore,
  torBoxInventoryProvider,
  torBoxProvider,
  releaseKey,
  accountScope = 'default',
  now = () => Date.now(),
  fetchSignal,
}) {
  // A. Input validation: positive int selectedFileSize + valid infoHash.
  if (!controlPlaneStore) {
    throw new TorBoxFileIdentityError('controlPlaneStore is required', INVALID_INPUT, null);
  }
  const normalizedHash = normalizeInfoHash(infoHash);
  if (normalizedHash == null) {
    throw new TorBoxFileIdentityError(
      'infoHash must be a 40-char lowercase hex string',
      INVALID_INPUT,
      { infoHash: String(infoHash ?? '') },
    );
  }
  if (!Number.isSafeInteger(selectedFileSize) || selectedFileSize <= 0) {
    throw new TorBoxFileIdentityError(
      'selectedFileSize must be a positive integer byte count',
      INVALID_INPUT,
      { selectedFileSize },
    );
  }

  // B. Find or passively recover the current TorBox placement.
  let placement = controlPlaneStore.findPlacementByInfoHash('torbox', normalizedHash);

  if (!placement && torBoxInventoryProvider && typeof torBoxInventoryProvider.supports === 'function'
      && torBoxInventoryProvider.supports(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)) {
    const observedAt = now();
    const lookupSignal = fetchSignal ? fetchSignal(15_000) : AbortSignal.timeout(15_000);
    try {
      const observedPlacement = await torBoxInventoryProvider
        .require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
        .lookupPlacement({ infoHash: normalizedHash }, { signal: lookupSignal });
      if (observedPlacement && observedPlacement.providerResourceId) {
        placement = controlPlaneStore.findPlacement(
          'torbox',
          accountScope,
          String(observedPlacement.providerResourceId),
        );
        if (!placement) {
          placement = controlPlaneStore.recordPlacement({
            provider: 'torbox',
            accountScope,
            infoHash: normalizedHash,
            providerResourceId: String(observedPlacement.providerResourceId),
            state: 'ready',
            ownership: 'owned',
            ownerKey: `vfs-${observedAt}`,
            provenance: 'torbox-file-identity',
            observedAt,
            expiresAt: observedAt + 5 * 60 * 1000,
          });
        }
        controlPlaneStore.recordPlacementLookupObservation({
          provider: 'torbox',
          accountScope,
          infoHash: normalizedHash,
          observationState: 'present',
          placementId: placement.id,
          observedAt,
          expiresAt: observedAt + 5 * 60 * 1000,
          source: 'torbox-file-identity',
        });
      }
    } catch (lookupError) {
      // Lookup failures are non-fatal here — inventory may still have files.
    }
  }

  if (!placement || !placement.providerResourceId) {
    throw new TorBoxFileIdentityError(
      `No TorBox placement for infoHash ${normalizedHash}`,
      NO_PLACEMENT,
      { infoHash: normalizedHash },
    );
  }

  // C. Inventory observation: ALWAYS fetch authoritative inventory so that
  //    replaceProviderFileInventory can build/update torrent_files and
  //    provider_files.torrent_file_id mappings (Slice 1.5 machinery).
  if (!torBoxInventoryProvider) {
    throw new TorBoxFileIdentityError(
      'TorBox inventory provider is required to observe provider files',
      INVENTORY_UNAVAILABLE,
      { infoHash: normalizedHash },
    );
  }
  const inventorySignal = fetchSignal ? fetchSignal(15_000) : AbortSignal.timeout(15_000);
  let inventory;
  try {
    inventory = await torBoxInventoryProvider
      .require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
      .getFileInventory(placement, { signal: inventorySignal });
  } catch (inventoryError) {
    throw new TorBoxFileIdentityError(
      `TorBox inventory fetch failed: ${inventoryError.message}`,
      INVENTORY_ERROR,
      { infoHash: normalizedHash, cause: inventoryError.message },
    );
  }

  // D. Persist inventory; replaceProviderFileInventory creates torrent_files
  //    rows and provider_files.torrent_file_id mappings.
  const observedAt = inventory.observedAt ?? now();
  const files = controlPlaneStore.replaceProviderFileInventory(
    placement.id,
    inventory.files,
    {
      observedAt,
      expiresAt: inventory.expiresAt,
      authoritative: inventory.authoritative,
      complete: inventory.complete,
      evidence: inventory.evidence,
    },
  );

  // E. Find present provider_files with exact size match.
  // F. Enforce cardinality: 0 → NO_FILE_SIZE_MATCH, >1 → AMBIGUOUS_FILE_SIZE.
  const matches = files.filter((f) => f.size === selectedFileSize);
  if (matches.length === 0) {
    throw new TorBoxFileIdentityError(
      `No provider file with size ${selectedFileSize} bytes on ${normalizedHash}`,
      NO_FILE_SIZE_MATCH,
      {
        infoHash: normalizedHash,
        placementId: placement.id,
        selectedFileSize,
        presentFileCount: files.length,
        distinctSizes: uniqueSortedSizes(files),
        releaseKey: releaseKey ?? null,
      },
    );
  }
  if (matches.length > 1) {
    throw new TorBoxFileIdentityError(
      `Multiple (${matches.length}) provider files match size ${selectedFileSize} on ${normalizedHash}`,
      AMBIGUOUS_FILE_SIZE,
      {
        infoHash: normalizedHash,
        placementId: placement.id,
        selectedFileSize,
        matchCount: matches.length,
        conflictingProviderFileIds: matches.map((m) => m.providerFileId),
        releaseKey: releaseKey ?? null,
      },
    );
  }

  const matched = matches[0];

  // G. Validate the provider_file row has a durable torrent_file_id AND
  //    that the row in control-plane.db actually exists.
  if (!matched.torrentFileId || matched.mappingState !== 'mapped') {
    throw new TorBoxFileIdentityError(
      `Matched provider file ${matched.providerFileId} has no mapped torrent_file_id`,
      MISSING_TORRENT_FILE,
      {
        infoHash: normalizedHash,
        placementId: placement.id,
        providerFileId: matched.providerFileId,
        torrentFileId: matched.torrentFileId ?? null,
        mappingState: matched.mappingState ?? null,
      },
    );
  }
  const torrentFile = controlPlaneStore.getTorrentFile(matched.torrentFileId);
  if (!torrentFile) {
    throw new TorBoxFileIdentityError(
      `torrent_file_id ${matched.torrentFileId} not found in control plane`,
      MISSING_TORRENT_FILE,
      {
        infoHash: normalizedHash,
        placementId: placement.id,
        providerFileId: matched.providerFileId,
        torrentFileId: matched.torrentFileId,
      },
    );
  }
  if (torrentFile.infoHash !== normalizedHash || torrentFile.size !== selectedFileSize) {
    throw new TorBoxFileIdentityError(
      `torrent_file ${matched.torrentFileId} mismatch (hash=${torrentFile.infoHash} size=${torrentFile.size})`,
      MISSING_TORRENT_FILE,
      {
        infoHash: normalizedHash,
        placementId: placement.id,
        providerFileId: matched.providerFileId,
        torrentFileId: matched.torrentFileId,
        observedInfoHash: torrentFile.infoHash,
        observedSize: torrentFile.size,
      },
    );
  }

  return {
    placementId: placement.id,
    providerFileId: matched.providerFileId,
    torrentFileId: matched.torrentFileId,
    size: torrentFile.size,
  };
}

function normalizeInfoHash(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(trimmed)) return null;
  return trimmed;
}

function uniqueSortedSizes(files) {
  const set = new Set();
  for (const f of files) {
    if (Number.isInteger(f.size) && f.size > 0) set.add(f.size);
  }
  return [...set].sort((a, b) => a - b);
}

export const TORBOX_FILE_IDENTITY_ERROR_CODES = Object.freeze({
  INVALID_INPUT,
  INVENTORY_UNAVAILABLE,
  INVENTORY_ERROR,
  NO_PLACEMENT,
  NO_FILE_SIZE_MATCH,
  AMBIGUOUS_FILE_SIZE,
  MISSING_TORRENT_FILE,
});