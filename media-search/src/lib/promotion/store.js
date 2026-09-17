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
 *   failed        — terminal, or retry-waiting when attempts remain
 *                   and next_due_at is set (worker claims due rows;
 *                   re-POST resets the budget intentionally)
 *
 * Permanence is this row's status, never hy4-cache or STRM presence.
 * Table lives in control-plane.db beside the TorrentFile truth it
 * references — same backup unit, no new database.
 */

import { MAX_JOB_ATTEMPTS } from '../lifecycle/job-retry.js';

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
    attempts: row.attempts ?? 0,
    nextDueAt: row.next_due_at ?? null,
    failCategory: row.fail_category ?? null,
  };
}

export function createPromotionStore({ db, now = () => Date.now() } = {}) {
  if (!db) throw new Error('promotion store requires a database handle');
  db.exec(SCHEMA);
  // Additive retry columns (job-retry tranche). PRAGMA-guarded so
  // existing databases migrate without rebuild.
  try {
    const cols = db.prepare('PRAGMA table_info(promotions)').all().map((c) => c.name);
    if (!cols.includes('attempts')) db.exec('ALTER TABLE promotions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('next_due_at')) db.exec('ALTER TABLE promotions ADD COLUMN next_due_at INTEGER');
    if (!cols.includes('fail_category')) db.exec('ALTER TABLE promotions ADD COLUMN fail_category TEXT');
  } catch {}

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
      // Manual re-POST resets the whole retry budget intentionally.
      db.prepare(`
        UPDATE promotions SET status = 'requested', last_error = NULL,
          bytes_complete = 0, permanent_path = ?,
          attempts = 0, next_due_at = NULL, fail_category = NULL, updated_at = ?
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

  /** Atomic claim for the worker single-flight; false when already taken.
   * Claims fresh requests plus retry-due rows (failed with a reached
   * schedule and budget remaining). */
  function claimMaterializing(torrentFileId) {
    const result = db.prepare(`
      UPDATE promotions SET status = 'materializing', updated_at = ?
      WHERE torrent_file_id = ? AND (status = 'requested' OR (status = 'failed'
        AND next_due_at IS NOT NULL AND next_due_at <= ? AND attempts < ?))
    `).run(now(), torrentFileId, now(), MAX_JOB_ATTEMPTS);
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

  /** Terminal failure: preserves reason, clears any retry schedule. */
  function markFailed(torrentFileId, lastError, { category = null, attempts = null } = {}) {
    db.prepare(`
      UPDATE promotions SET status = 'failed', last_error = ?,
        fail_category = COALESCE(?, fail_category),
        attempts = COALESCE(?, attempts + 1),
        next_due_at = NULL, updated_at = ?
      WHERE torrent_file_id = ?
    `).run(String(lastError ?? 'unknown error').slice(0, 2000), category, attempts, now(), torrentFileId);
    return get(torrentFileId);
  }

  /** Schedule a bounded retry: stays failed, becomes claimable at due time. */
  function scheduleRetry(torrentFileId, { error, category, attempts, delayMs }) {
    db.prepare(`
      UPDATE promotions SET status = 'failed', last_error = ?,
        fail_category = ?, attempts = ?, next_due_at = ?, updated_at = ?
      WHERE torrent_file_id = ?
    `).run(String(error ?? 'unknown error').slice(0, 2000), category ?? null,
      attempts ?? 0, now() + (delayMs ?? 0), now(), torrentFileId);
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
      SELECT * FROM promotions
      WHERE status = 'requested' OR (status = 'failed'
        AND next_due_at IS NOT NULL AND next_due_at <= ? AND attempts < ?)
      ORDER BY created_at ASC LIMIT ?
    `).all(now(), MAX_JOB_ATTEMPTS, limit).map(rowToPromotion);
  }

  /**
   * Boot recovery: anything stranded in a transient state goes back to
   * requested. The shared materializer validates and resumes its named
   * partial, so durable progress is not reset here. Returns reset count.
   */
  function resetStale() {
    const result = db.prepare(`
      UPDATE promotions SET status = 'requested', last_error = NULL, updated_at = ?
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
    scheduleRetry,
    noteProgress,
    listClaimable,
    resetStale,
  };
}
