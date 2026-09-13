/**
 * Future-intent model (anticipatory tranche).
 *
 * Durable "this exact media is expected to be wanted later" state.
 * Intent rows NEVER create VFS, STRM, library publication, or consumer
 * notification by themselves — they only authorize the scheduler to run
 * the existing prepare/publish machinery ahead of demand.
 *
 * Lifecycle: anticipated → preparing → prepared → published_preparing →
 * playable, with failed / withdrawn as terminal states. Only what must
 * survive restart is persisted; the scheduler converges by re-reading
 * durable truth (handoff/library) rather than trusting its own memory.
 */
export const INTENT_STATES = Object.freeze({
  ANTICIPATED: 'anticipated',
  PREPARING: 'preparing',
  PREPARED: 'prepared',
  PUBLISHED_PREPARING: 'published_preparing',
  PLAYABLE: 'playable',
  FAILED: 'failed',
  WITHDRAWN: 'withdrawn',
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS future_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL,
  media_id TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  source TEXT NOT NULL DEFAULT 'operator',
  expected_at INTEGER,
  next_check_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'anticipated',
  torrent_file_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
  -- NOTE: no inline UNIQUE (media_id, season, episode): SQLite treats NULLs
  -- as distinct, which would allow duplicate seasonless rows. Uniqueness
  -- is enforced by idx_future_intents_identity below via COALESCE.
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_future_intents_identity
  ON future_intents(media_id, COALESCE(season, -1), COALESCE(episode, -1));
CREATE INDEX IF NOT EXISTS idx_future_intents_due
  ON future_intents(state, next_check_at);
`;

function ensureSchema(db) {
  db.exec(SCHEMA);
  // Additive Arr columns (Phase: Arr sync). PRAGMA-guarded for existing DBs.
  try {
    const cols = db.prepare('PRAGMA table_info(future_intents)').all().map((c) => c.name);
    if (!cols.includes('arr_satisfied')) {
      db.exec('ALTER TABLE future_intents ADD COLUMN arr_satisfied INTEGER NOT NULL DEFAULT 0');
    }
  } catch {}
}

export function createFutureIntentStore({ db, clock = () => Date.now() } = {}) {
  if (!db) throw new Error('future intents require db');
  ensureSchema(db);

  const now = () => clock();

  function seed({ mediaType, mediaId, season = null, episode = null, source = 'operator', expectedAt = null, checkInMs = 0 }) {
    if (!mediaId || !mediaType) throw new Error('mediaId and mediaType required');
    const t = now();
    // INSERT-or-select (uniqueness is a COALESCE expression index, which
    // ON CONFLICT cannot target portably). Concurrent duplicate seeds race
    // to the same row; the loser reads the winner. Duplicate processing is
    // prevented downstream by the atomic claim.
    try {
      const row = db.prepare(
        `INSERT INTO future_intents
          (media_type, media_id, season, episode, source, expected_at, next_check_at, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'anticipated', ?, ?)
         RETURNING *`,
      ).get(mediaType, mediaId, season, episode, source, expectedAt, t + checkInMs, t, t);
      return { intent: row, created: true };
    } catch (err) {
      if (!/UNIQUE|unique|constraint/i.test(String(err?.message || ''))) throw err;
      return {
        intent: db.prepare(`SELECT * FROM future_intents
          WHERE media_id = ? AND COALESCE(season, -1) = COALESCE(?, -1) AND COALESCE(episode, -1) = COALESCE(?, -1)`)
          .get(mediaId, season, episode),
        created: false,
      };
    }
  }

  function list({ state = null, limit = 100 } = {}) {
    if (state) {
      return db.prepare('SELECT * FROM future_intents WHERE state = ? ORDER BY next_check_at LIMIT ?').all(state, limit);
    }
    return db.prepare('SELECT * FROM future_intents ORDER BY next_check_at LIMIT ?').all(limit);
  }

  function due({ limit = 10 } = {}) {
    // 'preparing' rows visible here are orphaned (ticks run serially, so
    // no worker can be inside one); the scheduler requeues them.
    return db.prepare(`SELECT * FROM future_intents
      WHERE state IN ('anticipated', 'failed', 'prepared', 'published_preparing', 'preparing') AND next_check_at <= ?
      ORDER BY next_check_at LIMIT ?`).all(now(), limit);
  }

  /** Atomic claim: exactly one worker moves anticipated→preparing. */
  function claim(id) {
    const info = db.prepare(`UPDATE future_intents
      SET state = 'preparing', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND state = 'anticipated'`).run(now(), id);
    return info.changes === 1;
  }

  /** Bounded retry: failed→anticipated with incremented attempts. */
  function retry(id, nextCheckAt) {
    const info = db.prepare(`UPDATE future_intents
      SET state = 'anticipated', attempts = attempts + 1,
          last_error = NULL, next_check_at = ?, updated_at = ?
      WHERE id = ? AND state = 'failed'`).run(nextCheckAt, now(), id);
    return info.changes === 1;
  }

  /** Arr-managed rows only (radarr:/sonarr: sources). */
  function listArrSources() {
    ensureSchema(db);
    try {
      return db.prepare(`SELECT * FROM future_intents
        WHERE source LIKE 'radarr:%' OR source LIKE 'sonarr:%'`).all();
    } catch {
      return [];
    }
  }

  /** Refresh Arr-supplied fields after a sync (never resets progress). */
  function refreshArr(id, { expectedAt = null, satisfied = false, nextCheckAt = null } = {}) {
    ensureSchema(db);
    db.prepare(`UPDATE future_intents
      SET expected_at = ?, arr_satisfied = ?, next_check_at = COALESCE(?, next_check_at), updated_at = ?
      WHERE id = ?`).run(expectedAt, satisfied ? 1 : 0, nextCheckAt, now(), id);
  }

  /**
   * Withdraw never-prepared anticipated rows for a vanished/unmonitored
   * Arr source. Prepared+ rows are useful durable truth and stay.
   */
  function withdrawUnmonitored(source) {
    ensureSchema(db);
    const info = db.prepare(`UPDATE future_intents
      SET state = 'withdrawn', last_error = 'arr-unmonitored', updated_at = ?
      WHERE source = ? AND state = 'anticipated'`).run(now(), source);
    return info.changes;
  }

  function transition(id, state, patch = {}) {
    const allowed = Object.values(INTENT_STATES);
    if (!allowed.includes(state)) throw new Error(`bad intent state ${state}`);
    const cols = ['state'];
    const vals = [state];
    for (const [k, v] of Object.entries(patch)) {
      if (['torrent_file_id', 'next_check_at', 'last_error'].includes(k)) {
        cols.push(k);
        vals.push(v);
      }
    }
    cols.push('updated_at');
    vals.push(now(), id);
    db.prepare(`UPDATE future_intents SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...vals);
  }

  function counts() {
    return db.prepare('SELECT state, COUNT(*) AS n FROM future_intents GROUP BY state').all();
  }

  function nextCheck() {
    const row = db.prepare(`SELECT MIN(next_check_at) AS t FROM future_intents
      WHERE state IN ('anticipated', 'failed', 'prepared', 'published_preparing')`).get();
    return row?.t ?? null;
  }

  return { seed, list, due, claim, retry, transition, counts, nextCheck, listArrSources, refreshArr, withdrawUnmonitored };
}

/** Backoff for retryable intent work: 15m, 1h, 4h, cap 24h. */
export function intentBackoffMs(attempts) {
  const steps = [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
  return steps[Math.min(Math.max(0, attempts), steps.length - 1)];
}

/**
 * Retirement guard (lifecycle evidence, not authority): exact match on an
 * Arr-sourced, non-terminal intent means the household still monitors the
 * item — do not auto-retire on consumer absence alone.
 */
export function isWantedByArr(db, { mediaId, season = null, episode = null } = {}) {
  if (!db || !mediaId) return false;
  try {
    const row = db.prepare(`SELECT 1 AS ok FROM future_intents
      WHERE media_id = ? AND COALESCE(season, -1) = COALESCE(?, -1)
        AND COALESCE(episode, -1) = COALESCE(?, -1)
        AND (source LIKE 'radarr:%' OR source LIKE 'sonarr:%')
        AND state IN ('anticipated','preparing','prepared','published_preparing','playable')
      LIMIT 1`).get(mediaId, season, episode);
    return !!row;
  } catch {
    return false;
  }
}
