/**
 * Durable preparation state — the machine side of PREPARING.
 *
 * One row per (release, provider) attempt chain. Keyed by infoHash so
 * duplicate Plays join instead of duplicating provider work (single-flight
 * is the UNIQUE constraint + atomic claim, not a job framework). Survives
 * restart: a restarted process re-reads due rows and resumes
 * polling; provider resources are re-observed, never assumed.
 *
 * This table owns ACQUISITION lifecycle only: queued → acquiring →
 * waiting → ready | failed_* | cancelled | expired. It never chooses
 * representation (the candidate snapshot is an input, recorded for exact
 * closure without re-running discovery) and never binds (Binding stays
 * with representation policy via activateBinding).
 *
 * Retention: terminal rows age out via PRUNE (operator-configurable days);
 * active rows are never pruned.
 */

import { isPreparationActive, isPreparationTerminal, PREPARE_STATE } from './contract.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS preparations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  info_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  media_type TEXT NOT NULL,
  media_id TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  title TEXT,
  candidate_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_resource_id TEXT,
  next_poll_at INTEGER,
  last_error TEXT,
  outcome_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'play',
  session_id TEXT,
  notified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_preparations_singleflight
  ON preparations(info_hash, provider)
  WHERE state IN ('queued', 'acquiring', 'waiting', 'failed_temporary');
CREATE INDEX IF NOT EXISTS idx_preparations_due
  ON preparations(state, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_preparations_media
  ON preparations(media_id, season, episode);
`;

const DEFAULTS = Object.freeze({
  preparationTimeoutMs: 2 * 60 * 60 * 1000,
  retentionDays: 7,
});

function normalizeHash(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(s)) throw new Error('preparations require a 40-hex infoHash');
  return s;
}

export function createPreparationStore({ db, clock = () => Date.now(), config = {} } = {}) {
  if (!db) throw new Error('preparation store requires db');
  db.exec(SCHEMA);
  const now = () => clock();
  const cfg = { ...DEFAULTS, ...config };

  function get(id) {
    return db.prepare('SELECT * FROM preparations WHERE id = ?').get(id) ?? null;
  }

  function findActive(infoHash, provider = null) {
    const hash = normalizeHash(infoHash);
    if (provider) {
      return db.prepare(
        `SELECT * FROM preparations WHERE info_hash = ? AND provider = ?
         AND state IN ('queued','acquiring','waiting','failed_temporary') LIMIT 1`,
      ).get(hash, provider) ?? null;
    }
    return db.prepare(
      `SELECT * FROM preparations WHERE info_hash = ?
       AND state IN ('queued','acquiring','waiting','failed_temporary')
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(hash) ?? null;
  }

  function findLatest(infoHash) {
    return db.prepare(
      `SELECT * FROM preparations WHERE info_hash = ? ORDER BY id DESC LIMIT 1`,
    ).get(normalizeHash(infoHash)) ?? null;
  }

  function findByMedia({ mediaId, season = null, episode = null } = {}) {
    if (!mediaId) return [];
    return db.prepare(
      `SELECT * FROM preparations WHERE media_id = ?
       AND COALESCE(season, -1) = COALESCE(?, -1)
       AND COALESCE(episode, -1) = COALESCE(?, -1)
       ORDER BY id DESC LIMIT 5`,
    ).all(mediaId, season, episode);
  }

  /**
   * Start-or-join: returns the live preparation for (release, provider),
   * creating it when none exists. The UNIQUE partial index makes the
   * single-flight atomic; the loser reads the winner.
   */
  function startOrJoin({
    infoHash, provider, mediaType, mediaId, season = null, episode = null,
    title = null, candidate = {}, source = 'play', sessionId = null,
  }) {
    const hash = normalizeHash(infoHash);
    if (!provider || !mediaType || !mediaId) {
      throw new Error('preparations require provider, mediaType and mediaId');
    }
    const t = now();
    const existing = findActive(hash, provider);
    if (existing) return { preparation: existing, created: false };
    try {
      const row = db.prepare(
        `INSERT INTO preparations
         (info_hash, provider, media_type, media_id, season, episode, title,
          candidate_json, state, next_poll_at, source, session_id, created_at, updated_at,
          expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      ).get(
        hash, provider, mediaType, mediaId, season, episode, title,
        JSON.stringify(candidate ?? {}), t, source, sessionId, t, t,
        t + cfg.preparationTimeoutMs,
      );
      return { preparation: row, created: true };
    } catch (err) {
      if (!/UNIQUE|unique|constraint/i.test(String(err?.message || ''))) throw err;
      return { preparation: findActive(hash, provider), created: false };
    }
  }

  /**
   * Atomic claim for one poll/acquire step: exactly one worker moves a due
   * row into the working state. Returns the claimed row or null.
   */
  function claimDue(id, toState) {
    const t = now();
    try {
      const info = db.prepare(
        `UPDATE preparations SET state = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND state IN ('queued','waiting') AND (next_poll_at IS NULL OR next_poll_at <= ?)`,
      ).run(toState, t, id, t);
      if (info.changes !== 1) return null;
      return get(id);
    } catch {
      return null;
    }
  }

  function listDue({ limit = 5, states = ['queued', 'waiting'] } = {}) {
    const t = now();
    const placeholders = states.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM preparations WHERE state IN (${placeholders})
       AND (next_poll_at IS NULL OR next_poll_at <= ?)
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY next_poll_at NULLS FIRST, id LIMIT ?`,
    ).all(...states, t, t, limit);
  }

  function markWaiting(id, { providerResourceId = null, nextPollAt = null, outcome = null } = {}) {
    const t = now();
    db.prepare(
      `UPDATE preparations SET state = 'waiting',
        provider_resource_id = COALESCE(?, provider_resource_id),
        next_poll_at = ?, outcome_json = COALESCE(?, outcome_json), updated_at = ?
       WHERE id = ? AND state IN ('queued','acquiring','waiting')`,
    ).run(providerResourceId, nextPollAt ?? t, outcome ? JSON.stringify(outcome) : null, t, id);
    return get(id);
  }

  function markReady(id, { providerResourceId = null, outcome = null } = {}) {
    const t = now();
    db.prepare(
      `UPDATE preparations SET state = 'ready',
        provider_resource_id = COALESCE(?, provider_resource_id),
        outcome_json = COALESCE(?, outcome_json), next_poll_at = NULL, updated_at = ?
       WHERE id = ? AND state IN ('queued','acquiring','waiting')`,
    ).run(providerResourceId, outcome ? JSON.stringify(outcome) : null, t, id);
    return get(id);
  }

  function markFailed(id, state, { lastError = null, nextPollAt = null, outcome = null } = {}) {
    if (![PREPARE_STATE.FAILED_TEMPORARY, PREPARE_STATE.FAILED_POLICY, PREPARE_STATE.FAILED_TERMINAL].includes(state)) {
      throw new Error(`bad preparation failure state ${state}`);
    }
    // failed_temporary is re-drivable via requeue(); the rest end here.
    const t = now();
    db.prepare(
      `UPDATE preparations SET state = ?, last_error = ?, next_poll_at = ?,
        outcome_json = COALESCE(?, outcome_json), updated_at = ?
       WHERE id = ?`,
    ).run(state, lastError, nextPollAt, outcome ? JSON.stringify(outcome) : null, t, id);
    return get(id);
  }

  /** Re-drive a failed_temporary row (bounded by attempts at the driver). */
  function requeue(id, nextPollAt) {
    const t = now();
    const info = db.prepare(
      `UPDATE preparations SET state = 'queued', next_poll_at = ?, updated_at = ?
       WHERE id = ? AND state = 'failed_temporary'`,
    ).run(nextPollAt ?? t, t, id);
    return info.changes === 1 ? get(id) : null;
  }

  function markCancelled(id, reason = 'abandoned') {
    const t = now();
    db.prepare(
      `UPDATE preparations SET state = 'cancelled', last_error = ?, updated_at = ?
       WHERE id = ? AND state IN ('queued','acquiring','waiting')`,
    ).run(reason, t, id);
    return get(id);
  }

  function markNotified(id) {
    const t = now();
    db.prepare('UPDATE preparations SET notified_at = ?, updated_at = ? WHERE id = ?').run(t, t, id);
    return get(id);
  }

  function expireOverdue(limit = 50) {
    const t = now();
    const info = db.prepare(
      `UPDATE preparations SET state = 'expired', updated_at = ?
       WHERE state IN ('queued','acquiring','waiting') AND expires_at IS NOT NULL AND expires_at <= ?
       LIMIT ?`,
    ).run(t, t, limit);
    return info.changes;
  }

  function pruneTerminal(olderThanMs) {
    const t = now();
    const info = db.prepare(
      `DELETE FROM preparations
       WHERE state IN ('ready','failed_temporary','failed_policy','failed_terminal','cancelled','expired')
       AND updated_at < ?`,
    ).run(t - olderThanMs);
    return info.changes;
  }

  function countActive() {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM preparations WHERE state IN ('queued','acquiring','waiting','failed_temporary')`,
    ).get()?.n ?? 0;
  }

  function countActiveForProvider(provider) {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM preparations
       WHERE provider = ? AND state IN ('queued','acquiring','waiting','failed_temporary')`,
    ).get(provider)?.n ?? 0;
  }

  return {
    get, findActive, findLatest, findByMedia,
    startOrJoin, claimDue, listDue,
    markWaiting, markReady, markFailed, requeue, markCancelled, markNotified,
    expireOverdue, pruneTerminal, countActive, countActiveForProvider,
    isActive: isPreparationActive, isTerminal: isPreparationTerminal,
  };
}
