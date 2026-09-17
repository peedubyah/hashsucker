/**
 * Temporary (watch-once) publication lifecycle.
 *
 * A publication is temporary only when an explicit request declares it
 * (temporary:true + TTL). Background flows (anticipation, upgrades,
 * reconcile) never write these columns. Retirement removes PRESENTATION
 * via the existing unpublishMedia primitive (VFS row, STRM files,
 * desired_state, binding supersede); durable TF/placement/binding
 * history is retained, so re-request republishes from truth in
 * milliseconds. No playback-completion inference exists anywhere, so
 * retirement is TTL-from-publication by design (conservative default
 * 7 days, override per request).
 */
import { createLibraryIdentityKey } from '../control-plane/canonical-path.js';
import { unpublishMedia } from './unpublish.js';

export const TEMPORARY_MODE = 'temporary';
export const PERMANENT_MODE = 'permanent';
export const DEFAULT_TEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_TEMP_TTL_MS = 3 * 60 * 1000;
export const MAX_TEMP_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function identityKeyFor({ mediaType, mediaId, season = null, episode = null }) {
  const isEpisode = mediaType !== 'movie' && season != null;
  return createLibraryIdentityKey({
    mediaType: isEpisode ? 'episode' : 'movie', mediaId,
    season: isEpisode ? season : null, episode: isEpisode ? episode : null,
  });
}

function findItem(controlPlaneStore, identity) {
  try {
    return controlPlaneStore.getLibraryItemByIdentityKey?.(identityKeyFor(identity)) ?? null;
  } catch {
    return null;
  }
}

/** Mark a published item temporary after a successful explicit request. */
export function markTemporaryPublication(controlPlaneStore, identity, { ttlMs = DEFAULT_TEMP_TTL_MS, nowMs = Date.now() } = {}) {
  const item = findItem(controlPlaneStore, identity);
  if (!item) return { ok: false, reason: 'no-library-item' };
  const ttl = Math.min(Math.max(Number(ttlMs) || DEFAULT_TEMP_TTL_MS, MIN_TEMP_TTL_MS), MAX_TEMP_TTL_MS);
  try {
    controlPlaneStore.db.prepare(`UPDATE library_items SET publication_mode = ?, retire_at = ?, updated_at = ?
      WHERE id = ?`).run(TEMPORARY_MODE, nowMs + ttl, nowMs, item.id);
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 120) };
  }
  return { ok: true, libraryItemId: item.id, retireAt: nowMs + ttl };
}

/** Adopt to permanent (explicit re-request without the flag, or promotion). */
export function clearTemporaryPublication(controlPlaneStore, identity, { nowMs = Date.now() } = {}) {
  const item = findItem(controlPlaneStore, identity);
  if (!item) return { ok: false, reason: 'no-library-item' };
  if ((item.publicationMode ?? PERMANENT_MODE) === PERMANENT_MODE && item.retireAt == null) {
    return { ok: true, unchanged: true, libraryItemId: item.id };
  }
  try {
    controlPlaneStore.db.prepare(`UPDATE library_items SET publication_mode = ?, retire_at = NULL, updated_at = ?
      WHERE id = ?`).run(PERMANENT_MODE, nowMs, item.id);
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 120) };
  }
  return { ok: true, libraryItemId: item.id };
}

/**
 * Retire due temporary publications. Bounded scan, idempotent unpublish,
 * restart-safe (all state durable). Items with a permanent promotion row
 * are adopted to permanent instead of unpublished — a stale timer must
 * never remove owned media presentation.
 */
export async function retireDuePublications({ cache, controlPlaneStore, promotionStore = null, nowMs = Date.now(), limit = 10, log = () => {} } = {}) {
  if (!cache?.db || !controlPlaneStore?.db) throw new Error('retirement requires cache + controlPlaneStore');
  let rows = [];
  try {
    rows = controlPlaneStore.db.prepare(`SELECT * FROM library_items
      WHERE desired_state = 'present' AND publication_mode = ?
        AND retire_at IS NOT NULL AND retire_at <= ?
      ORDER BY retire_at ASC LIMIT ?`).all(TEMPORARY_MODE, nowMs, limit);
  } catch {
    return { retired: 0, adopted: 0 };
  }
  let retired = 0, adopted = 0;
  const details = [];
  for (const row of rows) {
    const identity = {
      mediaType: row.media_type, mediaId: row.media_id, season: row.season, episode: row.episode,
    };
    // Promotion guard: owned media never auto-retires.
    let promoted = false;
    try {
      const promo = promotionStore?.getByMedia?.({
        mediaId: row.media_id,
        mediaType: row.media_type === 'movie' ? 'movie' : 'episode',
        season: row.season, episode: row.episode,
      });
      promoted = !!promo && promo.status === 'permanent';
    } catch {}
    if (promoted) {
      clearTemporaryPublication(controlPlaneStore, identity, { nowMs });
      adopted++;
      details.push({ mediaId: row.media_id, action: 'adopted-permanent' });
      log(`retirement adopted media=${row.media_id} (permanent promotion present)`);
      continue;
    }
    try {
      await unpublishMedia({
        cache, controlPlaneStore,
        mediaId: row.media_id,
        mediaType: row.media_type === 'movie' ? 'movie' : 'episode',
        season: row.season, episode: row.episode,
      });
      retired++;
      details.push({ mediaId: row.media_id, action: 'retired' });
      log(`retirement retired media=${row.media_id} mode=temporary`);
    } catch (err) {
      details.push({ mediaId: row.media_id, action: 'error', error: String(err?.message || err).slice(0, 120) });
    }
  }
  return { retired, adopted, details };
}
