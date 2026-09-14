/**
 * Durable promotion state (promotion tranche, Phase 2).
 *
 * One row per exact TorrentFile (PRIMARY KEY on torrent_file_id):
 *
 *   requested     — human asked; worker has not started bytes yet
 *   materializing — worker is streaming bytes into .staging (transient;
 *                   boot recovery resets these to requested and discards
 *                   partials, then re-fetches cleanly)
 *   verifying     — bytes complete; size/completeness/sparseness check
 *   permanent     — atomically placed; owned truth (terminal)
 *   failed        — retryable; re-POST resets to requested (terminal
 *                   until the human asks again)
 *
 * Permanence is this row's status, never hy4-cache or STRM presence.
 * Table lives in control-plane.db beside the TorrentFile truth it
 * references — same backup unit, no new database.
 */

export const PROMOTION_STATUS = Object.freeze({
  REQUESTED: 'requested',
  MATERIALIZING: 'materializing',
  VERIFYING: 'verifying',
  PERMANENT: 'permanent',
  FAILED: 'failed',
});

const TERMINAL = new Set([PROMOTION_STATUS.PERMANENT, PROMOTION_STATUS.FAILED]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS promotions (
  torrent_file_id TEXT PRIMARY KEY,
  library_item_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
  season INTEGER,
  episode INTEGER,
  status TEXT NOT NULL CHECK (status IN ('requested', 'materializing', 'verifying', 'permanent', 'failed')),
  permanent_path TEXT,
  bytes_complete INTEGER NOT NULL DEFAULT 0 CHECK (bytes_complete >= 0),
  size INTEGER NOT NULL CHECK (size > 0),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (torrent_file_id) REFERENCES torrent_files(id)
);
CREATE INDEX IF NOT EXISTS idx_promotions_media
  ON promotions(media_type, media_id, season, episode);
CREATE INDEX IF NOT EXISTS idx_promotions_status
  ON promotions(status);
`;

function rowToPromotion(row) {
  if (!row) return null;
  return {
    torrentFileId: row.torrent_file_id,
    libraryItemId: row.library_item_id,
    mediaId: row.media_id,
    mediaType: row.media_type,
    season: row.season,
    episode: row.episode,
    status: row.status,
    permanentPath: row.permanent_path,
    bytesComplete: row.bytes_complete,
    size: row.size,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPromotionStore({ db, now = () => Date.now() } = {}) {
  if (!db) throw new Error('promotion store requires a database handle');
  db.exec(SCHEMA);

  function get(torrentFileId) {
    const row = db.prepare('SELECT * FROM promotions WHERE torrent_file_id = ?').get(torrentFileId);
    return rowToPromotion(row);
  }

  function getByMedia({ mediaId, mediaType, season = null, episode = null }) {
    const row = db.prepare(`
      SELECT * FROM promotions
      WHERE media_id = ? AND media_type = ?
        AND COALESCE(season, -1) = COALESCE(?, -1)
        AND COALESCE(episode, -1) = COALESCE(?, -1)
      ORDER BY updated_at DESC LIMIT 1
    `).get(mediaId, mediaType, season, episode);
    return rowToPromotion(row);
  }

  /**
   * Idempotent request: already permanent → returned as-is (no-op);
   * already requested/materializing/verifying → current state;
   * failed → reset to requested (human asked again).
   */
  function request({ torrentFileId, libraryItemId, mediaId, mediaType, season = null, episode = null, size, permanentPath }) {
    if (!torrentFileId) throw new Error('torrentFileId is required');
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('positive TorrentFile size is required');
    if (!permanentPath) throw new Error('permanentPath is required');
    const existing = get(torrentFileId);
    const timestamp = now();
    if (existing) {
      if (existing.status === PROMOTION_STATUS.PERMANENT) return { promotion: existing, created: false };
      if (!TERMINAL.has(existing.status)) return { promotion: existing, created: false };
      db.prepare(`
        UPDATE promotions SET status = 'requested', last_error = NULL,
          bytes_complete = 0, permanent_path = ?, updated_at = ?
        WHERE torrent_file_id = ?
      `).run(permanentPath, timestamp, torrentFileId);
      return { promotion: get(torrentFileId), created: false, reset: true };
    }
    db.prepare(`
      INSERT INTO promotions (
        torrent_file_id, library_item_id, media_id, media_type, season,
        episode, status, permanent_path, bytes_complete, size,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, 0, ?, NULL, ?, ?)
    `).run(torrentFileId, libraryItemId, mediaId, mediaType, season, episode,
      permanentPath, size, timestamp, timestamp);
    return { promotion: get(torrentFileId), created: true };
  }

  /** Atomic claim for the worker single-flight; false when already taken. */
  function claimMaterializing(torrentFileId) {
    const result = db.prepare(`
      UPDATE promotions SET status = 'materializing', updated_at = ?
      WHERE torrent_file_id = ? AND status = 'requested'
    `).run(now(), torrentFileId);
    return result.changes === 1;
  }

  function markVerifying(torrentFileId, bytesComplete) {
    db.prepare(`
      UPDATE promotions SET status = 'verifying', bytes_complete = ?, updated_at = ?
      WHERE torrent_file_id = ?
    `).run(bytesComplete, now(), torrentFileId);
    return get(torrentFileId);
  }

  function markPermanent(torrentFileId) {
    const row = get(torrentFileId);
    if (!row) throw new Error('unknown promotion');
    db.prepare(`
      UPDATE promotions SET status = 'permanent', bytes_complete = size,
        last_error = NULL, updated_at = ?
      WHERE torrent_file_id = ?
    `).run(now(), torrentFileId);
    return get(torrentFileId);
  }

  function markFailed(torrentFileId, lastError) {
    db.prepare(`
      UPDATE promotions SET status = 'failed', last_error = ?, updated_at = ?
      WHERE torrent_file_id = ?
    `).run(String(lastError ?? 'unknown error').slice(0, 2000), now(), torrentFileId);
    return get(torrentFileId);
  }

  function noteProgress(torrentFileId, bytesComplete) {
    db.prepare(`
      UPDATE promotions SET bytes_complete = ?, updated_at = ?
      WHERE torrent_file_id = ? AND status = 'materializing'
    `).run(bytesComplete, now(), torrentFileId);
  }

  function listClaimable(limit = 1) {
    return db.prepare(`
      SELECT * FROM promotions WHERE status = 'requested'
      ORDER BY created_at ASC LIMIT ?
    `).all(limit).map(rowToPromotion);
  }

  /**
   * Boot recovery: anything stranded in a transient state goes back to
   * requested so the worker re-fetches cleanly. Returns reset count.
   */
  function resetStale() {
    const result = db.prepare(`
      UPDATE promotions SET status = 'requested', bytes_complete = 0,
        last_error = NULL, updated_at = ?
      WHERE status IN ('materializing', 'verifying')
    `).run(now());
    return result.changes;
  }

  return {
    get,
    getByMedia,
    request,
    claimMaterializing,
    markVerifying,
    markPermanent,
    markFailed,
    noteProgress,
    listClaimable,
    resetStale,
  };
}
