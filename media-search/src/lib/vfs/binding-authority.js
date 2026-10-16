/**
 * Binding-authoritative VFS state recovery.
 *
 * A published VFS row names the release the active Binding declares. The
 * discovery cache keeps exactly ONE playback_handoffs row per
 * (media_type, media_id, season, episode) slot, and that upsert overwrites in
 * place when a later request selects a DIFFERENT authoritative TorrentFile.
 * A re-selection therefore destroys the published release's handoff while the
 * Binding and the VFS row keep naming it — and the read path, which resolves
 * runtime identity from the handoff, fails with HANDOFF_MISSING. One such row
 * used to fail an entire collection listing.
 *
 * Binding authority wins: the control plane is the durable truth for which
 * representation is published. When the handoff for the published release is
 * gone, the runtime identity is rebuilt from the active Binding and its
 * TorrentFile. Nothing is selected, discovered or invented here — this only
 * reads authoritative durable state that already exists.
 *
 * What is deliberately NOT done:
 *   - choosing a different representation (a newer handoff selection is
 *     history, not authority — the Binding stays untouched);
 *   - writing or back-filling handoff rows;
 *   - serving an entry that has no authoritative backing at all (that entry
 *     is ISOLATED and reported, never guessed).
 */

import { createLibraryIdentityKey } from '../control-plane/canonical-path.js';

/**
 * Rebuild the handoff-shaped runtime identity one VFS entry needs, from the
 * authoritative Binding for its library item.
 *
 * @param {Object|null} controlPlaneStore
 * @param {{mediaId:string, releaseKey:string, mediaType?:string,
 *          season?:number|null, episode?:number|null,
 *          canonicalPath?:string}} entry
 * @returns {{handoff: Object, reason: string}|null} null when no active
 *   Binding backs this entry (the caller isolates it).
 */
export function authoritativeStateForVfsEntry(controlPlaneStore, entry) {
  if (!controlPlaneStore
    || typeof controlPlaneStore.getLibraryItemByIdentityKey !== 'function'
    || typeof controlPlaneStore.getActiveBindingForLibraryItem !== 'function') {
    return null;
  }
  try {
    const identityKey = createLibraryIdentityKey({
      mediaType: entry.mediaType === 'episode' ? 'episode' : 'movie',
      mediaId: entry.mediaId,
      season: entry.season ?? null,
      episode: entry.episode ?? null,
    });
    const item = controlPlaneStore.getLibraryItemByIdentityKey(identityKey);
    const active = item ? controlPlaneStore.getActiveBindingForLibraryItem(item.id) : null;
    if (!active || !active.binding || !active.torrentFile) return null;

    const binding = active.binding;
    const tf = active.torrentFile;
    // The entry must name the SAME release the Binding names. Anything else is
    // a stale projection: convergence owns it, recovery does not.
    if (binding.releaseKey !== entry.releaseKey) {
      return {
        handoff: null,
        reason: 'binding-release-mismatch',
        bindingReleaseKey: binding.releaseKey,
        bindingTorrentFileId: binding.torrentFileId,
      };
    }
    const infoHash = tf.infoHash ?? binding.infoHash;
    const fileIndex = binding.fileIndex ?? null;
    return {
      reason: 'binding-authoritative',
      handoff: {
        mediaId: entry.mediaId,
        mediaType: entry.mediaType === 'episode' ? 'episode' : 'movie',
        season: entry.season ?? null,
        episode: entry.episode ?? null,
        releaseKey: binding.releaseKey,
        infoHash,
        fileIndex,
        filename: tf.internalPath ?? entry.canonicalPath ?? '',
        provider: 'torbox',
        providerState: 'cached',
        identityTier: 'authoritative',
        resolutionState: 'bound',
        selectionReason: 'binding-authoritative-state',
        selectedAt: binding.validFrom ?? null,
        torrentFileId: tf.id,
      },
    };
  } catch {
    // An unreadable control plane is not authority.
    return null;
  }
}

/**
 * Resolve the runtime state for one VFS entry: the handoff first (legacy and
 * still-published rows), then the authoritative Binding, else isolate.
 *
 * @returns {{state: Object|null, action: 'handoff'|'recovered'|'isolated'|'mismatch'}}
 */
export function resolveVfsStateForEntry({
  searchCache,
  controlPlaneStore,
  entry,
  log = () => {},
}) {
  const handoff = resolveHandoff(searchCache, entry);
  if (handoff) {
    return { state: { entry, handoff }, action: 'handoff' };
  }
  const recovered = authoritativeStateForVfsEntry(controlPlaneStore, entry);
  if (recovered?.handoff) {
    log(`[vfs] recovered label=${describe(entry)} release=${entry.releaseKey} `
      + 'reason=published-handoff-superseded authority=active-binding');
    return { state: { entry, handoff: recovered.handoff }, action: 'recovered' };
  }
  if (recovered?.reason === 'binding-release-mismatch') {
    log(`[vfs] isolated label=${describe(entry)} reason=row-not-authoritative `
      + `row=${entry.releaseKey} binding=${recovered.bindingReleaseKey}`);
    return { state: null, action: 'mismatch' };
  }
  log(`[vfs] isolated label=${describe(entry)} release=${entry.releaseKey} `
    + 'reason=no-handoff-no-authoritative-binding');
  return { state: null, action: 'isolated' };
}

function describe(entry) {
  if (entry.season != null || entry.episode != null) {
    return `${entry.mediaId} S${entry.season}E${entry.episode}`;
  }
  return `movie ${entry.mediaId}`;
}

/**
 * The handoff that belongs to THIS entry, or null. A handoff whose identity
 * does not match the entry is not this entry's handoff — it belongs to a
 * different release/representation — so it is ignored here and the
 * authoritative Binding decides (exactly the TV path's historical check,
 * applied to both surfaces).
 */
function resolveHandoff(searchCache, entry) {
  let handoff = null;
  try {
    if (entry.mediaType === 'episode' || entry.season != null || entry.episode != null) {
      if (typeof searchCache?.getTvPlaybackHandoff !== 'function') return null;
      handoff = searchCache.getTvPlaybackHandoff(entry.mediaId, entry.season, entry.episode);
    } else if (typeof searchCache?.getPlaybackHandoffByReleaseKey === 'function') {
      handoff = searchCache.getPlaybackHandoffByReleaseKey(entry.mediaId, entry.releaseKey);
    }
  } catch {
    // An unreadable discovery cache defers to the authoritative path.
    return null;
  }
  if (!handoff) return null;
  if (entry.torrentFileId && handoff.torrentFileId && entry.torrentFileId !== handoff.torrentFileId) return null;
  if (entry.infoHash && handoff.infoHash && String(entry.infoHash).toLowerCase() !== String(handoff.infoHash).toLowerCase()) return null;
  if (entry.fileIndex != null && handoff.fileIndex != null && entry.fileIndex !== handoff.fileIndex) return null;
  return handoff;
}
