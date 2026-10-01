import { createLibraryIdentityKey } from '../control-plane/canonical-path.js';

/**
 * Record the narrow positive fact that an observed PMS session progressed on
 * the exact published TorrentFile. Provider/runtime state is intentionally
 * excluded; the active Binding supplies the exact object.
 */
export function recordAcceptedPlayback({ cache = null, controlPlaneStore, session, observedAt = Date.now() } = {}) {
  if (!controlPlaneStore || !session || session.progress <= 0 || !session.partFile) return null;
  const key = createLibraryIdentityKey({
    mediaType: session.mediaType === 'movie' ? 'movie' : 'episode',
    mediaId: session.mediaId,
    season: session.mediaType === 'movie' ? null : session.season,
    episode: session.mediaType === 'movie' ? null : session.episode,
  });
  const item = controlPlaneStore.getLibraryItemByIdentityKey?.(key);
  const active = item ? controlPlaneStore.getActiveBindingForLibraryItem?.(item.id) : null;
  if (!item || !active) return null;
  if (active.torrentFile?.id == null || !session.partFile) return null;
  return controlPlaneStore.recordAcceptedTorrentFile({
    libraryItemId: item.id,
    torrentFileId: active.torrentFile.id,
    source: 'plex-session-progress',
    reason: 'pms-session-progressed',
    observedAt,
    evidence: {
      progress: session.progress,
      viewOffset: session.viewOffset,
      ratingKey: session.ratingKey,
      partId: session.partId,
      partFile: session.partFile,
      sessionId: session.sessionId,
    },
  });
}
