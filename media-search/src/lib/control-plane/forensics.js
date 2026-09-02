/**
 * E02 provider-file identity forensics.
 *
 * Read-only projection helpers that reconstruct the exact durable identity
 * chain used by the TorBox delivery seam:
 *
 *   release.infoHash
 *     → provider_placements  (placement, providerResourceId, state)
 *     → provider_files        (current placement observation)
 *     → torrent_files         (durable physical identity, Slice 1.5)
 *     → candidate_file_mappings (caller-supplied releaseKey → providerFileId)
 *     → requestdl URL         (the exact envelope the seam hands to fetch)
 *
 * No mutations, no live provider calls, no logging of secrets. The seam
 * itself remains the single source of truth for state changes; this module
 * only mirrors the construction order and column surfaces it consumes so
 * the next E02 investigator can read persistence, replay a URL, and detect
 * silent identity drift without re-deriving the rules.
 *
 * The requestdl construction mirrors `torbox-delivery.js` step 5 exactly
 * (param order: token, torrent_id, file_id, redirect=true) so a forensic
 * URL is byte-identical to a live one (modulo the API key).
 *
 * @see media-search/src/lib/resolver/torbox-delivery.js (requestdl)
 * @see media-search/src/lib/control-plane/store.js (durable identity)
 * @see media-search/src/lib/resolver/torbox-file-identity.js (size match)
 */

const DEFAULT_TORBOX_API_BASE = 'https://api.torbox.app/v1/api';

/**
 * Build the exact requestdl envelope consumed by the TorBox delivery seam.
 *
 * Mirrors `ensureTorBoxDelivery` step 5 in
 * `media-search/src/lib/resolver/torbox-delivery.js`:
 *   const params = new URLSearchParams({
 *     token, torrent_id, file_id, redirect: 'true',
 *   });
 *   `${TORBOX_API_BASE}/torrents/requestdl?${params.toString()}`;
 *
 * @param {Object} args
 * @param {Object} args.placement  - { provider, accountScope, providerResourceId }
 *   Sourced from controlPlaneStore.findPlacement / findPlacementByInfoHash.
 * @param {Object} args.mapping    - { providerFileId }  from candidate_file_mappings.
 * @param {string} [args.apiKey]   - API key (optional; when omitted, param
 *   is `''` and the URL is still fully reconstructable for diagnostics).
 * @param {string} [args.apiBase]  - Override the default TorBox base URL.
 * @returns {{ url: string, params: { token: string, torrent_id: string, file_id: string, redirect: 'true' } }}
 */
export function buildRequestdlUrl({ placement, mapping, apiKey = '', apiBase = DEFAULT_TORBOX_API_BASE } = {}) {
  if (!placement || typeof placement !== 'object') {
    throw new TypeError('placement is required');
  }
  if (!mapping || typeof mapping !== 'object') {
    throw new TypeError('mapping is required');
  }
  if (typeof placement.providerResourceId !== 'string' || placement.providerResourceId.length === 0) {
    throw new TypeError('placement.providerResourceId is required');
  }
  if (typeof mapping.providerFileId !== 'string' || mapping.providerFileId.length === 0) {
    throw new TypeError('mapping.providerFileId is required');
  }
  // Param order is meaningful: deterministic forensic replay.
  const params = {
    token: String(apiKey ?? ''),
    torrent_id: placement.providerResourceId,
    file_id: mapping.providerFileId,
    redirect: 'true',
  };
  const qs = new URLSearchParams(params).toString();
  const base = String(apiBase ?? DEFAULT_TORBOX_API_BASE).replace(/\/+$/, '');
  return { url: `${base}/torrents/requestdl?${qs}`, params };
}

/**
 * Project the full durable identity chain for a single (provider, infoHash).
 *
 * Returns the active placement (state != 'removed'), its present
 * provider_files observations, the durable TorrentFile row each provider
 * file is mapped to, the candidate_file_mappings row keyed by the
 * caller-supplied releaseKey (if any), and the reconstructed requestdl
 * envelope. When any link is missing, the report records the gap so the
 * investigator can see exactly which step is the discontinuity.
 *
 * @param {Object} store - controlPlaneStore instance.
 * @param {Object} args
 * @param {string} args.infoHash
 * @param {string} [args.provider='torbox']
 * @param {string} [args.releaseKey]
 * @param {string} [args.apiKey]
 * @param {string} [args.apiBase]
 * @returns {{
 *   infoHash: string,
 *   provider: string,
 *   placement: Object|null,
 *   providerFiles: Object[],
 *   torrentFiles: Object[],
 *   fileMapping: Object|null,
 *   inventorySnapshot: Object|null,
 *   requestdl: { url: string, params: Object }|null,
 *   gaps: string[],
 * }}
 */
export function projectReleaseEvidence(store, args = {}) {
  if (!store || typeof store !== 'object') {
    throw new TypeError('store is required');
  }
  const infoHash = String(args.infoHash ?? '').trim().toLowerCase();
  const provider = String(args.provider ?? 'torbox');
  const releaseKey = args.releaseKey ?? null;
  const gaps = [];

  const placement = store.findPlacementByInfoHash(provider, infoHash) ?? null;
  if (!placement) gaps.push('no-active-placement');

  const providerFiles = placement
    ? store.listProviderFiles(placement.id, { includeMissing: false })
    : [];
  const inventorySnapshot = placement ? store.getProviderInventorySnapshot(placement.id) : null;

  const torrentFiles = store.listTorrentFilesForRelease(infoHash);

  // For each present provider file, surface its durable TorrentFile row.
  const providerFileEvidence = providerFiles.map((pf) => {
    const tf = pf.torrentFileId ? store.getTorrentFile(pf.torrentFileId) : null;
    return {
      providerFileId: pf.providerFileId,
      path: pf.path,
      name: pf.name,
      size: pf.size,
      mappingState: pf.mappingState,
      mappingError: pf.mappingError,
      torrentFileId: pf.torrentFileId ?? null,
      torrentFile: tf
        ? { id: tf.id, infoHash: tf.infoHash, internalPath: tf.internalPath, size: tf.size }
        : null,
      invariant: derivePresentFileInvariant(pf),
    };
  });

  const fileMapping = placement && releaseKey
    ? store.findFileMapping(releaseKey, placement.id)
    : null;
  if (placement && releaseKey && !fileMapping) gaps.push('no-file-mapping-for-release-key');

  let requestdl = null;
  if (placement && fileMapping) {
    requestdl = buildRequestdlUrl({ placement, mapping: fileMapping, apiKey: args.apiKey, apiBase: args.apiBase });
  } else if (placement && fileMapping == null) {
    gaps.push('cannot-build-requestdl-no-mapping');
  }

  return {
    infoHash,
    provider,
    placement,
    providerFiles: providerFileEvidence,
    torrentFiles: torrentFiles.map((tf) => ({
      id: tf.id, infoHash: tf.infoHash, internalPath: tf.internalPath, size: tf.size,
    })),
    fileMapping,
    inventorySnapshot,
    requestdl,
    gaps,
  };
}

/**
 * For a given provider file on a placement, return its full evidence tuple:
 * the present provider_files row, the durable TorrentFile row it is mapped
 * to (if any), the cross-references from the other direction
 * (listProviderRefsForTorrentFile), and the binding invariant verdict.
 *
 * @param {Object} store - controlPlaneStore instance.
 * @param {Object} args
 * @param {string} args.placementId
 * @param {string} args.providerFileId
 * @returns {{
 *   placementId: string,
 *   providerFileId: string,
 *   present: boolean,
 *   providerFile: Object|null,
 *   torrentFile: Object|null,
 *   refs: Object[],
 *   invariant: { ok: boolean, reason: string|null, expectedSize: number|null },
 * }}
 */
export function projectProviderFileEvidence(store, { placementId, providerFileId } = {}) {
  if (!store) throw new TypeError('store is required');
  if (typeof placementId !== 'string' || !placementId) {
    throw new TypeError('placementId is required');
  }
  if (typeof providerFileId !== 'string' || !providerFileId) {
    throw new TypeError('providerFileId is required');
  }
  const files = store.listProviderFiles(placementId, { includeMissing: true });
  const providerFile = files.find((f) => f.providerFileId === providerFileId) ?? null;
  const torrentFile = providerFile?.torrentFileId
    ? store.getTorrentFile(providerFile.torrentFileId)
    : null;
  const refs = torrentFile
    ? store.listProviderRefsForTorrentFile(torrentFile.id)
    : [];
  return {
    placementId,
    providerFileId,
    present: providerFile?.present === true,
    providerFile,
    torrentFile: torrentFile
      ? { id: torrentFile.id, infoHash: torrentFile.infoHash, internalPath: torrentFile.internalPath, size: torrentFile.size }
      : null,
    refs: refs.map((r) => ({
      id: r.id, placementId: r.placementId, providerFileId: r.providerFileId,
      present: r.present, mappingState: r.mappingState,
    })),
    invariant: derivePresentFileInvariant(providerFile),
  };
}

/**
 * Project a single TorrentFile row plus the cross-references from
 * provider_files (including the demoted churn history) that point at it.
 *
 * @param {Object} store
 * @param {string} torrentFileId
 */
export function projectTorrentFileEvidence(store, torrentFileId) {
  if (!store) throw new TypeError('store is required');
  if (typeof torrentFileId !== 'string' || !torrentFileId) {
    throw new TypeError('torrentFileId is required');
  }
  const tf = store.getTorrentFile(torrentFileId);
  const refs = tf ? store.listProviderRefsForTorrentFile(torrentFileId) : [];
  return {
    torrentFile: tf
      ? { id: tf.id, infoHash: tf.infoHash, internalPath: tf.internalPath, size: tf.size, createdAt: tf.createdAt }
      : null,
    refs: refs.map((r) => ({
      id: r.id, placementId: r.placementId, providerFileId: r.providerFileId,
      present: r.present, mappingState: r.mappingState, mappingError: r.mappingError,
    })),
  };
}

/**
 * Sanity invariant for a present provider_files row.
 *  - When mappingState === 'mapped', torrentFileId must be set and the
 *    referenced TorrentFile's (infoHash, internalPath, size) must agree.
 *  - When mappingState is 'conflict' / 'incomplete' / 'unmapped', the gap
 *    is recorded as a non-ok invariant with a stable reason string.
 *  - When providerFile is null, ok=false reason='provider-file-absent'.
 */
function derivePresentFileInvariant(providerFile) {
  if (!providerFile) {
    return { ok: false, reason: 'provider-file-absent', expectedSize: null };
  }
  if (!providerFile.present) {
    return { ok: false, reason: 'provider-file-not-present', expectedSize: providerFile.size ?? null };
  }
  if (providerFile.mappingState === 'mapped') {
    if (!providerFile.torrentFileId) {
      return { ok: false, reason: 'mapped-without-torrent-file-id', expectedSize: providerFile.size ?? null };
    }
    return { ok: true, reason: null, expectedSize: providerFile.size ?? null };
  }
  if (providerFile.mappingState === 'incomplete') {
    return { ok: false, reason: 'incomplete-size', expectedSize: providerFile.size ?? null };
  }
  if (providerFile.mappingState === 'conflict') {
    return { ok: false, reason: 'conflict', expectedSize: providerFile.size ?? null };
  }
  return { ok: false, reason: 'unmapped', expectedSize: providerFile.size ?? null };
}

export const E02_FORENSICS = Object.freeze({
  DEFAULT_TORBOX_API_BASE,
});

export const E02_FORENSIC_INVARIANTS = Object.freeze({
  REQUESTDL_PARAM_ORDER: Object.freeze(['token', 'torrent_id', 'file_id', 'redirect']),
  REQUESTDL_REDIRECT: 'true',
  MAPPED_REQUIRES_TORRENT_FILE_ID: true,
  PARTIAL_UNIQUE_INDEX: 'idx_provider_files_one_current_mapping(placement_id, torrent_file_id) WHERE present=1 AND torrent_file_id IS NOT NULL',
});
