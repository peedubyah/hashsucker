/**
 * Promotion resolution (promotion tranche, Phase 4).
 *
 * POST /api/library/:id/promote resolves :id (a library item) to ONE
 * exact TorrentFile through durable truth only:
 *
 *   library item → active binding → (placement_id, provider_file_id)
 *   → mapped provider_files row → torrent_file_id → TorrentFile
 *
 * No title fuzzy matching, no search, no ranking. When the active
 * binding's provider file is not mapped to a TorrentFile (unmapped /
 * incomplete / conflict), promotion is refused with an exact reason
 * instead of guessing.
 */

export function resolvePromotionTarget(controlPlaneStore, libraryItemId) {
  if (!controlPlaneStore) throw new Error('control plane store is required');
  if (!libraryItemId) throw new Error('library item id is required');

  const item = controlPlaneStore.getLibraryItem(libraryItemId);
  if (!item) return { status: 'unknown-library-item', libraryItemId };

  const bindings = controlPlaneStore.listBindings(libraryItemId) || [];
  const active = bindings.find((b) => b && b.status === 'active');
  if (!active) return { status: 'no-active-binding', libraryItemId };

  const files = controlPlaneStore.listProviderFiles(active.placementId) || [];
  const mapped = files.find((f) => f
    && f.providerFileId === active.providerFileId
    && f.present);
  if (!mapped || !mapped.torrentFileId || mapped.mappingState !== 'mapped') {
    return {
      status: 'unmapped-provider-file',
      libraryItemId,
      placementId: active.placementId,
      providerFileId: active.providerFileId,
      mappingState: mapped?.mappingState ?? 'absent',
    };
  }

  const torrentFile = controlPlaneStore.getTorrentFile(mapped.torrentFileId);
  if (!torrentFile || !Number.isSafeInteger(torrentFile.size) || torrentFile.size <= 0
      || !torrentFile.internalPath) {
    return { status: 'invalid-torrent-file', libraryItemId, torrentFileId: mapped.torrentFileId };
  }

  return {
    status: 'ok',
    libraryItemId,
    item,
    binding: active,
    torrentFile,
  };
}
