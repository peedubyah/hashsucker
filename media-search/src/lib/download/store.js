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
 *                   tree. When the staged file is still present, re-POST
 *                   is a no-op (returns the row as-is). When a downstream
 *                   importer has moved/consumed it, re-POST resets to
 *                   requested so the worker re-stages from durable
 *                   TorrentFile truth (matches the UNRAID.md promise that
 *                   anything not yet moved can always be re-staged).
 *   failed        — terminal, or retry-waiting when attempts remain
 *                   and next_due_at is set (worker claims due rows;
 *                   re-POST resets the budget intentionally)
 *
 * "Staged" is deliberately NOT "permanent": a downstream barnacle may
 * immediately move/import the file. Table lives in control-plane.db
 * beside the TorrentFile truth — same backup unit, no new database.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { MAX_JOB_ATTEMPTS } from '../lifecycle/job-retry.js';

/** Same presence semantics as the status endpoint: regular file with the expected size. */
export function stagedFilePresent(row) {
  if (!row || row.status !== DOWNLOAD_STATUS.STAGED || !row.stagedPath || row.expectedSize == null) return false;
  try {
    const stat = fs.statSync(row.stagedPath);
    return stat.isFile() && stat.size === row.expectedSize;
  } catch {
    return false;
  }
}

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
    attempts: row.attempts ?? 0,
    nextDueAt: row.next_due_at ?? null,
    failCategory: row.fail_category ?? null,
    handoffVersion: row.handoff_version ?? 0,
    handoffState: row.handoff_state ?? 'none',
    handoffId: row.handoff_id ?? null,
    handoffAt: row.handoff_at ?? null,
    qualityProfile: row.quality_profile ?? 'balanced',
  };
}

export function createDownloadStore({ db, now = () => Date.now() } = {}) {
  if (!db) throw new Error('download store requires db');
  db.exec(SCHEMA);
  // Additive retry + handoff columns (job-retry / download-handoff
  // tranches). PRAGMA-guarded so existing databases migrate without
  // rebuild.
  try {
    const cols = db.prepare('PRAGMA table_info(download_requests)').all().map((c) => c.name);
    if (!cols.includes('attempts')) db.exec('ALTER TABLE download_requests ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('next_due_at')) db.exec('ALTER TABLE download_requests ADD COLUMN next_due_at INTEGER');
    if (!cols.includes('fail_category')) db.exec('ALTER TABLE download_requests ADD COLUMN fail_category TEXT');
    if (!cols.includes('handoff_version')) db.exec('ALTER TABLE download_requests ADD COLUMN handoff_version INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('handoff_state')) db.exec("ALTER TABLE download_requests ADD COLUMN handoff_state TEXT NOT NULL DEFAULT 'none'");
    if (!cols.includes('handoff_id')) db.exec('ALTER TABLE download_requests ADD COLUMN handoff_id TEXT');
    if (!cols.includes('handoff_at')) db.exec('ALTER TABLE download_requests ADD COLUMN handoff_at INTEGER');
    if (!cols.includes('quality_profile')) db.exec("ALTER TABLE download_requests ADD COLUMN quality_profile TEXT NOT NULL DEFAULT 'balanced'");
  } catch {}

  function get(id) {
    const row = db.prepare('SELECT * FROM download_requests WHERE id = ?').get(id);
    return rowToDownload(row);
  }

  /**
   * Idempotent intent: an active (requested/resolving/materializing)
   * or staged row for the same exact media is returned as-is; a failed
   * row is reset to requested (asked again). Otherwise a new intent.
   */
  function request({ mediaId, mediaType, season = null, episode = null, title = null, year = null, qualityProfile = null }) {
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
    // Explicit profile updates stored intent everywhere (never triggers
    // work by itself); omitted preserves whatever is stored.
    const adoptProfile = (id) => {
      if (qualityProfile != null) {
        db.prepare('UPDATE download_requests SET quality_profile = ?, updated_at = ? WHERE id = ?')
          .run(qualityProfile, timestamp, id);
      }
    };
    if (current) {
      if (current.status === DOWNLOAD_STATUS.STAGED) {
        // No-op only while the staged file is actually there. A moved /
        // consumed file resets to requested so the worker re-stages from
        // durable truth (re-POST === re-stage-when-needed).
        if (stagedFilePresent(current)) {
          adoptProfile(current.downloadRequestId);
          return { download: get(current.downloadRequestId), created: false };
        }
      } else if (current.status !== DOWNLOAD_STATUS.FAILED) {
        adoptProfile(current.downloadRequestId);
        return { download: get(current.downloadRequestId), created: false };
      }
      db.prepare(`
        UPDATE download_requests SET status = 'requested', last_error = NULL,
          torrent_file_id = NULL, expected_size = NULL, bytes_complete = 0,
          staged_path = NULL, title = COALESCE(?, title), year = COALESCE(?, year),
          attempts = 0, next_due_at = NULL, fail_category = NULL,
          quality_profile = COALESCE(?, quality_profile),
          updated_at = ?
        WHERE id = ?
      `).run(title, year, qualityProfile, timestamp, current.downloadRequestId);
      return { download: get(current.downloadRequestId), created: false, reset: true };
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO download_requests (
        id, media_id, media_type, season, episode, title, year,
        status, torrent_file_id, expected_size, bytes_complete,
        staged_path, last_error, quality_profile, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', NULL, NULL, 0, NULL, NULL, ?, ?, ?)
    `).run(id, mediaId, mediaType, season, episode, title, year, qualityProfile ?? 'balanced', timestamp, timestamp);
    return { download: get(id), created: true };
  }

  /** Atomic claim for the worker single-flight; false when already taken.
   * Claims fresh requests plus retry-due rows (failed with a future
   * schedule reached and budget remaining). Terminal failures
   * (exhausted/never-scheduled) are never claimed. */
  function claimResolving(id) {
    const result = db.prepare(`
      UPDATE download_requests SET status = 'resolving', updated_at = ?
      WHERE id = ? AND (status = 'requested' OR (status = 'failed'
        AND next_due_at IS NOT NULL AND next_due_at <= ? AND attempts < ?))
    `).run(now(), id, now(), MAX_JOB_ATTEMPTS);
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

  /** Terminal failure: preserves reason, clears any retry schedule.
   * attempts: explicit count from the caller, else increment by one. */
  function markFailed(id, lastError, { category = null, attempts = null } = {}) {
    db.prepare(`
      UPDATE download_requests SET status = 'failed', last_error = ?,
        fail_category = COALESCE(?, fail_category),
        attempts = COALESCE(?, attempts + 1),
        next_due_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(String(lastError ?? 'unknown error').slice(0, 2000), category, attempts, now(), id);
    return get(id);
  }

  /** Schedule a bounded retry: stays failed, becomes claimable at due time. */
  function scheduleRetry(id, { error, category, attempts, delayMs }) {
    db.prepare(`
      UPDATE download_requests SET status = 'failed', last_error = ?,
        fail_category = ?, attempts = ?, next_due_at = ?, updated_at = ?
      WHERE id = ?
    `).run(String(error ?? 'unknown error').slice(0, 2000), category ?? null,
      attempts ?? 0, now() + (delayMs ?? 0), now(), id);
    return get(id);
  }

  function listClaimable(limit = 1) {
    return db.prepare(`
      SELECT * FROM download_requests
      WHERE status = 'requested' OR (status = 'failed'
        AND next_due_at IS NOT NULL AND next_due_at <= ? AND attempts < ?)
      ORDER BY created_at ASC LIMIT ?
    `).all(now(), MAX_JOB_ATTEMPTS, limit).map(rowToDownload);
  }

  /**
   * Boot recovery: transient states return to requested so the worker can
   * resume its named partial. The materializer validates the file and
   * corrects durable progress on its first callback. Returns reset count.
   */
  function resetStale() {
    const result = db.prepare(`
      UPDATE download_requests SET status = 'requested', last_error = NULL, updated_at = ?
      WHERE status IN ('resolving', 'materializing')
    `).run(now());
    return result.changes;
  }

  /** Handoff transfer states live beside the bytes truth (no status change). */
  function activeHandoff(row) {
    return !!row && (row.handoffState === 'pending' || row.handoffState === 'accepted');
  }

  /**
   * Begin a transfer: only from staged rows with no live handoff.
   * Returns { handoff } with the new deterministic version, or
   * { active } when a transfer is already in flight (idempotent).
   */
  function createHandoff(id) {
    const row = get(id);
    if (!row) throw new Error('unknown download request');
    if (row.status !== 'staged') throw new Error(`handoff requires staged bytes (status=${row.status})`);
    if (activeHandoff(row)) return { handoff: rowToHandoff(row), active: true };
    const version = (row.handoffVersion ?? 0) + 1;
    const handoffId = `dl-${id}-v${version}`;
    db.prepare(`UPDATE download_requests SET handoff_version = ?, handoff_state = 'pending',
      handoff_id = ?, handoff_at = ?, updated_at = ? WHERE id = ?`)
      .run(version, handoffId, now(), now(), id);
    return { handoff: rowToHandoff(get(id)), created: true };
  }

  /**
   * Apply a transfer event (poll observation or consumer ACK).
   * Version-guarded: superseded manifests are ignored. Terminal
   * transfer states (completed/failed) never move again except via a
   * new explicit handoff version.
   */
  function applyHandoffEvent(id, handoffId, { state, detail = null } = {}) {
    const row = get(id);
    if (!row) return { applied: false, reason: 'unknown-request' };
    if (row.handoffId !== handoffId) return { applied: false, reason: 'superseded-version' };
    if (!['pending', 'accepted', 'completed', 'failed'].includes(state)) {
      return { applied: false, reason: 'bad-state' };
    }
    if (row.handoffState === 'completed' || row.handoffState === 'failed') {
      return { applied: false, reason: 'transfer-terminal' };
    }
    db.prepare(`UPDATE download_requests SET handoff_state = ?, last_error = COALESCE(?, last_error),
      updated_at = ? WHERE id = ?`).run(state, detail, now(), id);
    return { applied: true, handoff: rowToHandoff(get(id)) };
  }

  function rowToHandoff(row) {
    return {
      handoffId: row.handoffId,
      version: row.handoffVersion,
      downloadRequestId: row.downloadRequestId,
      state: row.handoffState,
      handoffAt: row.handoffAt,
    };
  }

  return {
    get,
    request,
    claimResolving,
    markMaterializing,
    noteProgress,
    markStaged,
    markFailed,
    scheduleRetry,
    listClaimable,
    resetStale,
    createHandoff,
    applyHandoffEvent,
  };
}
