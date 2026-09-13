/**
 * Seerr availability wake log (availability tranche).
 *
 * Append-only record of MEDIA_AVAILABLE events and what each one woke.
 * Diagnostics only — never drives scheduling. Bounded: only the most
 * recent 200 events are retained.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seerr_availability_wakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  request_id TEXT,
  media_id TEXT,
  awakened INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL DEFAULT 'request'
);
`;

const RETAIN = 200;

function ensureSchema(db) {
  db.exec(SCHEMA);
}

export function createAvailabilityWakeLog({ db, clock = () => Date.now() } = {}) {
  if (!db) throw new Error('availability wake log requires db');
  ensureSchema(db);
  const now = () => clock();

  function record({ requestId = null, mediaId = null, awakened = 0, via = 'request' } = {}) {
    ensureSchema(db);
    const t = now();
    try {
      const row = db.prepare(`INSERT INTO seerr_availability_wakes
        (received_at, request_id, media_id, awakened, via)
        VALUES (?, ?, ?, ?, ?) RETURNING *`).get(t, requestId, mediaId, awakened, via);
      db.prepare(`DELETE FROM seerr_availability_wakes
        WHERE id <= (SELECT MAX(id) - ? FROM seerr_availability_wakes)`).run(RETAIN);
      return row;
    } catch {
      return null;
    }
  }

  function stats() {
    ensureSchema(db);
    try {
      const row = db.prepare(`SELECT COUNT(*) AS received,
        COALESCE(SUM(awakened), 0) AS awakenedTotal,
        MAX(received_at) AS lastWakeAt FROM seerr_availability_wakes`).get();
      const last = db.prepare(`SELECT request_id AS requestId, media_id AS mediaId, awakened, via
        FROM seerr_availability_wakes ORDER BY id DESC LIMIT 1`).get() ?? null;
      return {
        received: row?.received ?? 0,
        awakenedTotal: row?.awakenedTotal ?? 0,
        lastWakeAt: row?.lastWakeAt ?? null,
        last,
      };
    } catch {
      return { received: 0, awakenedTotal: 0, lastWakeAt: null, last: null };
    }
  }

  return { record, stats };
}
