/**
 * Product library listing.
 *
 * Answers "what is in my library and is it published?" from existing
 * durable truth without SQLite archaeology. No second state model: every
 * field derives from library_items, playback handoffs, VFS publication
 * rows, TorrentFile rows, active bindings, and current data-plane
 * coordinates.
 *
 * Per-item state (existing truth only, no invented states):
 *   published  — desired present and the scoped VFS row exists;
 *   absent     — desired_state is 'absent' (unpublished, reusable truth kept);
 *   incomplete — desired present but the scoped VFS row is missing.
 *
 * TV identity stays per-episode (mediaId + season + episode). No season
 * rollups, no positional inference, no provider internals, never any
 * runtime DeliveryCapability.
 */

function isEpisodeItem(item) {
  return item.season != null && item.episode != null;
}

function handoffFor(cache, item) {
  try {
    if (isEpisodeItem(item)) {
      return cache.getTvPlaybackHandoff(item.mediaId, item.season, item.episode) ?? null;
    }
    return cache.getPlaybackHandoffByMediaId?.(item.mediaId) ?? null;
  } catch {
    return null;
  }
}

function vfsRowFor(cache, item) {
  try {
    if (isEpisodeItem(item)) {
      return cache.getVfsTvEntry(item.mediaId, item.season, item.episode) ?? null;
    }
    return cache.getVfsMovieEntry(item.mediaId) ?? null;
  } catch {
    return null;
  }
}

function torrentFileFor(controlPlaneStore, torrentFileId) {
  if (!torrentFileId || typeof controlPlaneStore?.getTorrentFile !== 'function') {
    return null;
  }
  try {
    return controlPlaneStore.getTorrentFile(torrentFileId) ?? null;
  } catch {
    return null;
  }
}

function hasCoords(controlPlaneStore, torrentFileId) {
  if (!torrentFileId || typeof controlPlaneStore?.listDataPlaneCoordinates !== 'function') {
    return false;
  }
  try {
    return (controlPlaneStore.listDataPlaneCoordinates(torrentFileId) || []).length > 0;
  } catch {
    return false;
  }
}

function hasActiveBinding(controlPlaneStore, libraryItemId) {
  if (typeof controlPlaneStore?.listBindings !== 'function') {
    return false;
  }
  try {
    return controlPlaneStore.listBindings(libraryItemId)
      .some((b) => b && b.status === 'active');
  } catch {
    return false;
  }
}

/**
 * List library items with product publication state.
 *
 * @returns {{ items: Object[], total: number }}
 */
export function listLibrary({ cache, controlPlaneStore, limit = 100, mediaType = null } = {}) {
  if (!cache || !controlPlaneStore) {
    throw new Error('cache and controlPlaneStore are required');
  }
  let items = controlPlaneStore.listAllLibraryItems({ limit: 500 });
  if (mediaType === 'movie' || mediaType === 'episode') {
    const wantEpisode = mediaType === 'episode';
    items = items.filter((it) => (it.season != null && it.episode != null) === wantEpisode);
  }
  // Collapse legacy duplicate rows for the same episode (older writers keyed
  // episodes without season/episode in the identity key). Prefer the
  // canonical key form; the survivor's own desired/VFS state still decides.
  const seen = new Map();
  for (const it of items) {
    const k = `${it.mediaId}|${it.season ?? ''}|${it.episode ?? ''}`;
    const prev = seen.get(k);
    if (!prev) {
      seen.set(k, it);
      continue;
    }
    const parts = (r) => (r.identityKey || '').split(':').length;
    if (parts(it) > parts(prev)) seen.set(k, it);
  }
  items = [...seen.values()];
  const listed = items.slice(0, limit).map((item) => {
    const episodeScoped = item.season != null && item.episode != null;
    const handoff = handoffFor(cache, item);
    const vfs = vfsRowFor(cache, item);
    const tfId = handoff?.torrentFileId ?? null;
    const tf = torrentFileFor(controlPlaneStore, tfId);
    const desiredAbsent = item.desiredState === 'absent';
    return {
      mediaId: item.mediaId,
      mediaType: episodeScoped ? 'episode' : 'movie',
      season: item.season ?? null,
      episode: item.episode ?? null,
      title: item.title ?? null,
      year: item.year ?? null,
      desiredState: item.desiredState,
      state: desiredAbsent ? 'absent' : (vfs ? 'published' : 'incomplete'),
      canonicalPath: vfs?.canonicalPath ?? null,
      torrentFileId: tfId,
      size: tf?.size ?? null,
      hasServingCoordinates: hasCoords(controlPlaneStore, tfId),
      hasActiveBinding: hasActiveBinding(controlPlaneStore, item.id),
    };
  });
  return { items: listed, total: listed.length };
}
