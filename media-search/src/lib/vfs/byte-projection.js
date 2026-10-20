/**
 * BYTE AUTHORITY — one TorrentFile per media intent.
 *
 * The durable truth used to hold TWO copies of the byte identity: the
 * active Binding's TorrentFile (the authority) and the VFS row's
 * TorrentFile (what the byte path serves). They are written by different
 * code, in different databases, and nothing reconciled them — so a
 * publication that moved the VFS row and then failed to activate the
 * Binding left the two naming different TorrentFiles. The byte path
 * served one; the authority said the other; the consumer was told a
 * third size.
 *
 * THE RULE
 *
 *   A VFS row's byte identity (torrent_file_id, infoHash, size) is a
 *   PROJECTION of the active Binding's TorrentFile.
 *
 *   - The Binding decides. It is the authority for the representation.
 *   - A handoff may carry execution material (a candidate, a route), but
 *     it never decides the byte identity of a published intent.
 *   - The projection is written AFTER the Binding is settled, so the row
 *     is never ahead of the authority.
 *   - A VFS row with no Binding (the cold-publication window, a legacy
 *     row) is left alone: it is not contradicting an authority, it has
 *     none yet.
 *
 * The reconciliation is LOCAL: it reads the control plane and the
 * discovery cache and writes the VFS row. No discovery, no ranking, no
 * provider call, no metadata lookup, no consumer call.
 */

import { createLibraryIdentityKey, stableLibraryItemId } from '../control-plane/canonical-path.js';

/**
 * The byte identity an active Binding projects into a VFS row.
 *
 * @param {Object} binding - the active binding (with its TorrentFile)
 * @returns {{torrentFileId: string, infoHash: string, size: number}|null}
 */
export function projectedByteIdentity(binding) {
  const torrentFile = binding?.torrentFile ?? null;
  if (!torrentFile?.id) return null;
  if (!Number.isSafeInteger(torrentFile.size) || torrentFile.size <= 0) return null;
  return {
    torrentFileId: torrentFile.id,
    infoHash: String(torrentFile.infoHash ?? '').toLowerCase(),
    size: torrentFile.size,
  };
}

/**
 * Compare a VFS row with the byte identity its Binding projects.
 *
 * @param {Object} params
 * @param {Object|null} params.row - the VFS row
 * @param {Object|null} params.binding - the active binding
 * @returns {{state: string, row: Object|null, projected: Object|null}}
 *   state: 'aligned' | 'drifted' | 'no-binding' | 'legacy' | 'unprojectable'
 */
export function compareByteAuthority({ row, binding }) {
  const projected = projectedByteIdentity(binding);
  if (!row) return { state: 'no-row', row: null, projected };
  if (!binding) return { state: 'no-binding', row, projected: null };
  if (!projected) return { state: 'unprojectable', row, projected: null };
  if (row.torrentFileId == null) return { state: 'legacy', row, projected };
  const same = row.torrentFileId === projected.torrentFileId
    && String(row.infoHash ?? '').toLowerCase() === projected.infoHash
    && Number(row.size ?? -1) === Number(projected.size);
  return { state: same ? 'aligned' : 'drifted', row, projected };
}

/**
 * The library item that owns a media intent, from the control plane.
 */
function itemForIntent(store, { mediaType, mediaId, season, episode }) {
  try {
    const key = createLibraryIdentityKey({
      mediaType: mediaType === 'movie' ? 'movie' : 'episode',
      mediaId,
      season: mediaType === 'movie' ? undefined : season,
      episode: mediaType === 'movie' ? undefined : episode,
    });
    return store.getLibraryItemByIdentityKey?.(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * The VFS row for a media intent.
 */
function rowForIntent(cache, { mediaType, mediaId, season, episode }) {
  try {
    return mediaType === 'movie'
      ? cache.getVfsMovieEntry?.(mediaId) ?? null
      : cache.getVfsTvEntry?.(mediaId, season, episode) ?? null;
  } catch {
    return null;
  }
}

/**
 * The byte-authority state of every published media intent.
 *
 * @param {Object} params
 * @param {Object} params.store - the control-plane store
 * @param {Object} params.cache - the discovery cache
 * @returns {Array<Object>} one row per intent
 */
export function auditByteAuthority({ store, cache }) {
  const items = store.listAllLibraryItems?.({ limit: 500 }) ?? [];
  const rows = [];
  for (const item of items) {
    if (item.desiredState === 'absent') continue;
    const mediaType = item.season != null && item.episode != null ? 'episode' : 'movie';
    const row = rowForIntent(cache, {
      mediaType, mediaId: item.mediaId, season: item.season, episode: item.episode,
    });
    const binding = store.getActiveBindingForLibraryItem?.(item.id) ?? null;
    const comparison = compareByteAuthority({ row, binding });
    rows.push({
      identityKey: item.identityKey,
      mediaId: item.mediaId,
      mediaType,
      season: item.season ?? null,
      episode: item.episode ?? null,
      bindingId: binding?.binding?.id ?? null,
      bindingVersion: binding?.binding?.version ?? null,
      bindingTorrentFileId: binding?.torrentFile?.id ?? null,
      bindingSize: binding?.torrentFile?.size ?? null,
      bindingInfoHash: binding?.torrentFile?.infoHash ?? null,
      vfsTorrentFileId: row?.torrentFileId ?? null,
      vfsSize: row?.size ?? null,
      vfsInfoHash: row?.infoHash ?? null,
      vfsPath: row?.canonicalPath ?? null,
      state: comparison.state,
    });
  }
  return rows;
}

/**
 * Reconcile the byte authority: every VFS row is projected from the
 * active Binding.
 *
 * Idempotent ✓, restart-safe ✓, local ✓ (no provider, no metadata, no
 * consumer, no discovery).
 *
 * @param {Object} params
 * @param {Object} params.store
 * @param {Object} params.cache
 * @param {number} [params.limit]
 * @param {boolean} [params.dryRun=true] - report what WOULD change
 * @returns {{scanned: number, repaired: Array<Object>, skipped: Array<Object>}}
 */
export function reconcileByteAuthority({ store, cache, limit = 500, dryRun = true }) {
  const rows = auditByteAuthority({ store, cache });
  const repaired = [];
  const skipped = [];
  let scanned = 0;
  for (const row of rows) {
    if (scanned >= Math.max(1, Math.trunc(limit))) break;
    scanned += 1;
    if (row.state !== 'drifted') {
      if (row.state === 'legacy' || row.state === 'no-binding' || row.state === 'no-row') {
        skipped.push({ ...row, reason: row.state });
      }
      continue;
    }
    if (dryRun) {
      repaired.push({ ...row, action: 'would-project' });
      continue;
    }
    // The projection: the row's byte identity becomes the Binding's.
    const applied = projectRowToBinding({ cache, row });
    if (applied.ok) repaired.push({ ...row, action: 'projected', applied });
    else skipped.push({ ...row, reason: applied.reason });
  }
  return { scanned, repaired, skipped };
}

/**
 * Write the Binding's byte identity into the VFS row.
 *
 * The row's PATH never changes here: the presentation identity is stable
 * across a representation change, and only the bytes it points at move.
 */
function projectRowToBinding({ cache, row }) {
  try {
    const torrentFileId = row.bindingTorrentFileId;
    const size = row.bindingSize;
    const infoHash = row.bindingInfoHash;
    if (!torrentFileId || !Number.isSafeInteger(size) || size <= 0 || !infoHash) {
      return { ok: false, reason: 'binding-torrent-file-unprojectable' };
    }
    const table = row.mediaType === 'movie' ? 'vfs_movie_entries' : 'vfs_tv_entries';
    const key = row.mediaType === 'movie'
      ? { media_id: row.mediaId }
      : { media_id: row.mediaId, season: row.season, episode: row.episode };
    const now = Date.now();
    // The generation advances only when the projected bytes actually
    // changed: that is what makes the consumer re-analyse the file.
    const previousGeneration = cache.db.prepare(
      `SELECT MAX(updated_at) AS max_updated_at FROM ${table}`,
    ).get()?.max_updated_at ?? 0;
    const materializedAt = Math.max(now, previousGeneration + 1000);
    const result = cache.db.prepare(`
      UPDATE ${table}
      SET torrent_file_id = @torrent_file_id, info_hash = @info_hash, size = @size,
          updated_at = @updated_at
      WHERE media_id = @media_id
        ${row.mediaType === 'movie' ? '' : 'AND season = @season AND episode = @episode'}
    `).run({
      ...key,
      torrent_file_id: torrentFileId,
      info_hash: String(infoHash).toLowerCase(),
      size,
      updated_at: materializedAt,
    });
    return { ok: true, changes: result.changes, updatedAt: materializedAt };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

export { itemForIntent, rowForIntent, stableLibraryItemId };
