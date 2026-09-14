/**
 * Generic download-intent state (download-intent tranche).
 *
 * Unlike promotion, a download request needs no library item: any
 * external system names the media (strong mediaId identity + exact
 * S/E for TV) and HashSucker resolves it to one exact TorrentFile,
 * then stages verified bytes for an external importer ("back door").
 *
 *   requested     — human/external asked; nothing resolved yet
 *   resolving     — fast path (reuse durable TorrentFile) or fresh
 *                   discovery/ranking/binding in progress (transient;
 *                   boot recovery returns these to requested)
 *   materializing — shared byte primitive streaming into .staging
 *                   (transient; same recovery as promotion)
 *   staged        — complete verified bytes in the download output
 *                   tree (terminal; never auto-recreated if a
 *                   downstream importer moves/removes the file)
 *   failed        — retryable; re-POST resets to requested (terminal
 *                   until asked again)
 *
 * "Staged" is deliberately NOT "permanent": a downstream barnacle may
 * immediately move/import the file. Table lives in control-plane.db
 * beside the TorrentFile truth — same backup unit, no new database.
 */

import { randomUUID } from 'node:crypto';

export const DOWNLOAD_STATUS = Object.freeze({
  REQUESTED: 'requested',
  RESOLVING: 'resolving',
  MATERIALIZING: 'materializing',
  STAGED: 'staged',
  FAILED: 'failed',
});

const TRANSIENT = new Set([DOWNLOAD_STATUS.RESOLVING, DOWNLOAD_STATUS.MATERIALIZING]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS download_requests (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
  season INTEGER,
  episode INTEGER,
  title TEXT,
  year INTEGER,
  status TEXT NOT NULL CHECK (status IN ('requested', 'resolving', 'materializing', 'staged', 'failed')),
  torrent_file_id TEXT,
  expected_size INTEGER CHECK (expected_size IS NULL OR expected_size > 0),
  bytes_complete INTEGER NOT NULL DEFAULT 0 CHECK (bytes_complete >= 0),
  staged_path TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (torrent_file_id) REFERENCES torrent_files(id)
);
CREATE INDEX IF NOT EXISTS idx_download_requests_media
  ON download_requests(media_type, media_id, season, episode);
CREATE INDEX IF NOT EXISTS idx_download_requests_status
  ON download_requests(status);
`;

function rowToDownload(row) {
  if (!row) return null;
  return {
    downloadRequestId: row.id,
    mediaId: row.media_id,
    mediaType: row.media_type,
    season: row.season,
    episode: row.episode,
    title: row.title,
    year: row.year,
    status: row.status,
    torrentFileId: row.torrent_file_id,
    expectedSize: row.expected_size,
    bytesComplete: row.bytes_complete,
    stagedPath: row.staged_path,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDownloadStore({ db, now = () => Date.now() } = {}) {
  if (!db) throw new Error('download store requires a database handle');
  db.exec(SCHEMA);

  function get(id) {
    const row = db.prepare('SELECT * FROM download_requests WHERE id = ?').get(id);
    return rowToDownload(row);
  }

  /**
   * Idempotent intent: an active (requested/resolving/materializing)
   * or staged row for the same exact media is returned as-is; a failed
   * row is reset to requested (asked again). Otherwise a new intent.
   */
  function request({ mediaId, mediaType, season = null, episode = null, title = null, year = null }) {
    if (!mediaId) throw new Error('mediaId is required');
    if (mediaType !== 'movie' && mediaType !== 'episode') {
      throw new Error('mediaType must be movie or episode');
    }
    const timestamp = now();
    const existing = db.prepare(`
      SELECT * FROM download_requests
      WHERE media_id = ? AND media_type = ?
        AND COALESCE(season, -1) = COALESCE(?, -1)
        AND COALESCE(episode, -1) = COALESCE(?, -1)
      ORDER BY updated_at DESC LIMIT 1
    `).get(mediaId, mediaType, season, episode);
    const current = rowToDownload(existing);
    if (current) {
      if (current.status === DOWNLOAD_STATUS.STAGED) return { download: current, created: false };
      if (current.status !== DOWNLOAD_STATUS.FAILED) return { download: current, created: false };
      db.prepare(`
        UPDATE download_requests SET status = 'requested', last_error = NULL,
          torrent_file_id = NULL, expected_size = NULL, bytes_complete = 0,
          staged_path = NULL, title = COALESCE(?, title), year = COALESCE(?, year),
          updated_at = ?
        WHERE id = ?
      `).run(title, year, timestamp, current.downloadRequestId);
      return { download: get(current.downloadRequestId), created: false, reset: true };
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO download_requests (
        id, media_id, media_type, season, episode, title, year,
        status, torrent_file_id, expected_size, bytes_complete,
        staged_path, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', NULL, NULL, 0, NULL, NULL, ?, ?)
    `).run(id, mediaId, mediaType, season, episode, title, year, timestamp, timestamp);
    return { download: get(id), created: true };
  }

  /** Atomic claim for the worker single-flight; false when already taken. */
  function claimResolving(id) {
    const result = db.prepare(`
      UPDATE download_requests SET status = 'resolving', updated_at = ?
      WHERE id = ? AND status = 'requested'
    `).run(now(), id);
    return result.changes === 1;
  }

  function markMaterializing(id, { torrentFileId, expectedSize, stagedPath }) {
    if (!torrentFileId) throw new Error('torrentFileId is required');
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new Error('positive expected size is required');
    }
    db.prepare(`
      UPDATE download_requests SET status = 'materializing', torrent_file_id = ?,
        expected_size = ?, staged_path = ?, updated_at = ?
      WHERE id = ?
    `).run(torrentFileId, expectedSize, stagedPath, now(), id);
    return get(id);
  }

  function noteProgress(id, bytesComplete) {
    db.prepare(`
      UPDATE download_requests SET bytes_complete = ?, updated_at = ?
      WHERE id = ? AND status = 'materializing'
    `).run(bytesComplete, now(), id);
  }

  function markStaged(id) {
    const row = get(id);
    if (!row) throw new Error('unknown download request');
    db.prepare(`
      UPDATE download_requests SET status = 'staged', bytes_complete = expected_size,
        last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now(), id);
    return get(id);
  }

  function markFailed(id, lastError) {
    db.prepare(`
      UPDATE download_requests SET status = 'failed', last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(String(lastError ?? 'unknown error').slice(0, 2000), now(), id);
    return get(id);
  }

  function listClaimable(limit = 1) {
    return db.prepare(`
      SELECT * FROM download_requests WHERE status = 'requested'
      ORDER BY created_at ASC LIMIT ?
    `).all(limit).map(rowToDownload);
  }

  /**
   * Boot recovery: transient states return to requested so the worker
   * re-resolves/re-fetches cleanly. Returns reset count. Staged rows
   * are never touched (a moved file is the importer's business).
   */
  function resetStale() {
    const result = db.prepare(`
      UPDATE download_requests SET status = 'requested', bytes_complete = 0,
        last_error = NULL, updated_at = ?
      WHERE status IN ('resolving', 'materializing')
    `).run(now());
    return result.changes;
  }

  return {
    get,
    request,
    claimResolving,
    markMaterializing,
    noteProgress,
    markStaged,
    markFailed,
    listClaimable,
    resetStale,
  };
}
