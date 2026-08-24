/**
 * Lifecycle Event Store
 *
 * Persistent database-backed event store for operational history.
 * Stores request runs and lifecycle events for debugging and future analytics.
 *
 * Schema:
 *   request_runs (
 *     request_id TEXT PRIMARY KEY,
 *     created_at INTEGER NOT NULL,
 *     completed_at INTEGER,
 *     final_status TEXT NOT NULL,
 *     total_duration_ms REAL,
 *     media_id TEXT,
 *     release_key TEXT,
 *     provider TEXT,
 *     failure_reason TEXT,
 *     failure_stage TEXT,
 *     timing_json TEXT  -- JSON snapshot of full timing summary
 *   )
 *
 *   lifecycle_events (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     timestamp INTEGER NOT NULL,
 *     request_id TEXT NOT NULL,
 *     stage TEXT NOT NULL,
 *     component TEXT,
 *     status TEXT NOT NULL,
 *     duration_ms REAL,
 *     error_code TEXT,
 *     details_json TEXT,
 *     FOREIGN KEY (request_id) REFERENCES request_runs(request_id)
 *   )
 *
 * Indexes support querying by:
 * - request_id (for full timeline)
 * - timestamp (for recent events)
 * - stage (for failure analysis)
 * - final_status (for success/failure rates)
 */

import { DatabaseSync } from 'node:sqlite';

const EVENT_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS request_runs (
  request_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  final_status TEXT NOT NULL CHECK (final_status IN ('queued', 'processing', 'completed', 'failed', 'unknown')),
  total_duration_ms REAL,
  media_id TEXT,
  release_key TEXT,
  provider TEXT,
  failure_reason TEXT,
  failure_stage TEXT,
  timing_json TEXT,
  created_at_iso TEXT,
  completed_at_iso TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_runs_created_at ON request_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_runs_final_status ON request_runs(final_status);
CREATE INDEX IF NOT EXISTS idx_request_runs_media_id ON request_runs(media_id);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  component TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'skipped', 'unknown')),
  duration_ms REAL,
  error_code TEXT,
  details_json TEXT,
  timestamp_iso TEXT,
  FOREIGN KEY (request_id) REFERENCES request_runs(request_id)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_request_id ON lifecycle_events(request_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_timestamp ON lifecycle_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_stage ON lifecycle_events(stage);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_status ON lifecycle_events(status);
`;

/**
 * Create a lifecycle event store.
 *
 * @param {Object} options
 * @param {string} [options.dbPath] - SQLite database path (default: ':memory:')
 * @param {DatabaseSync} [options.database] - Existing database instance
 * @returns {LifecycleEventStore}
 */
export function createLifecycleEventStore({ dbPath = ':memory:', database = null } = {}) {
  const db = database || new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(EVENT_STORE_SCHEMA);

  // Prepared statements
  const insertRequestRun = db.prepare(`
    INSERT INTO request_runs (
      request_id, created_at, completed_at, final_status, total_duration_ms,
      media_id, release_key, provider, failure_reason, failure_stage,
      timing_json, created_at_iso, completed_at_iso
    ) VALUES (
      @request_id, @created_at, @completed_at, @final_status, @total_duration_ms,
      @media_id, @release_key, @provider, @failure_reason, @failure_stage,
      @timing_json, @created_at_iso, @completed_at_iso
    )
    ON CONFLICT(request_id) DO UPDATE SET
      completed_at = COALESCE(EXCLUDED.completed_at, request_runs.completed_at),
      final_status = COALESCE(EXCLUDED.final_status, request_runs.final_status),
      total_duration_ms = COALESCE(EXCLUDED.total_duration_ms, request_runs.total_duration_ms),
      failure_reason = COALESCE(EXCLUDED.failure_reason, request_runs.failure_reason),
      failure_stage = COALESCE(EXCLUDED.failure_stage, request_runs.failure_stage),
      timing_json = COALESCE(EXCLUDED.timing_json, request_runs.timing_json),
      completed_at_iso = COALESCE(EXCLUDED.completed_at_iso, request_runs.completed_at_iso)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO lifecycle_events (
      timestamp, request_id, stage, component, status,
      duration_ms, error_code, details_json, timestamp_iso
    ) VALUES (
      @timestamp, @request_id, @stage, @component, @status,
      @duration_ms, @error_code, @details_json, @timestamp_iso
    )
  `);

  const selectRecentRuns = db.prepare(`
    SELECT * FROM request_runs
    ORDER BY created_at DESC
    LIMIT @limit
  `);

  const getRunById = db.prepare(`
    SELECT * FROM request_runs
    WHERE request_id = @request_id
  `);

  const getEventsByRequestId = db.prepare(`
    SELECT * FROM lifecycle_events
    WHERE request_id = @request_id
    ORDER BY timestamp ASC
  `);

  const selectRecentEvents = db.prepare(`
    SELECT * FROM lifecycle_events
    ORDER BY timestamp DESC
    LIMIT @limit
  `);

  const selectEventsByStage = db.prepare(`
    SELECT * FROM lifecycle_events
    WHERE stage = @stage
    ORDER BY timestamp DESC
    LIMIT @limit
  `);

  const selectFailedRuns = db.prepare(`
    SELECT * FROM request_runs
    WHERE final_status = 'failed'
    ORDER BY created_at DESC
    LIMIT @limit
  `);

  const countRuns = db.prepare(`
    SELECT COUNT(*) as count FROM request_runs
  `);

  const countEvents = db.prepare(`
    SELECT COUNT(*) as count FROM lifecycle_events
  `);

  const countByStatus = db.prepare(`
    SELECT final_status, COUNT(*) as count
    FROM request_runs
    GROUP BY final_status
  `);

  /**
   * Record a new request run.
   *
   * @param {Object} run
   * @param {string} run.requestId
   * @param {number} [run.createdAt] - Unix ms (default: now)
   * @param {string} [run.mediaId]
   * @param {string} [run.releaseKey]
   * @param {string} [run.provider]
   * @returns {void}
   */
  function recordRequestRun(run) {
    const now = Date.now();
    insertRequestRun.run({
      request_id: run.requestId,
      created_at: run.createdAt ?? now,
      completed_at: run.completedAt ?? null,
      final_status: run.finalStatus ?? 'queued',
      total_duration_ms: run.totalDurationMs ?? null,
      media_id: run.mediaId ?? null,
      release_key: run.releaseKey ?? null,
      provider: run.provider ?? null,
      failure_reason: run.failureReason ?? null,
      failure_stage: run.failureStage ?? null,
      timing_json: run.timingJson ?? null,
      created_at_iso: run.createdAtIso ?? (new Date(run.createdAt ?? now).toISOString()),
      completed_at_iso: run.completedAtIso ?? null,
    });
  }

  /**
   * Update a request run with final status.
   *
   * @param {string} requestId
   * @param {Object} update
   * @param {string} [update.finalStatus]
   * @param {number} [update.completedAt]
   * @param {number} [update.totalDurationMs]
   * @param {string} [update.failureReason]
   * @param {string} [update.failureStage]
   * @param {string} [update.timingJson]
   * @returns {void}
   */
  function completeRequestRun(requestId, update) {
    insertRequestRun.run({
      request_id: requestId,
      created_at: Date.now(),
      completed_at: update.completedAt ?? Date.now(),
      final_status: update.finalStatus ?? 'completed',
      total_duration_ms: update.totalDurationMs ?? null,
      media_id: null,
      release_key: null,
      provider: null,
      failure_reason: update.failureReason ?? null,
      failure_stage: update.failureStage ?? null,
      timing_json: update.timingJson ?? null,
      created_at_iso: new Date().toISOString(),
      completed_at_iso: update.completedAt ? new Date(update.completedAt).toISOString() : new Date().toISOString(),
    });
  }

  /**
   * Record a lifecycle event.
   *
   * @param {Object} event
   * @param {string} event.requestId
   * @param {string} event.stage
   * @param {string} event.status
   * @param {number} [event.timestamp] - Unix ms (default: now)
   * @param {string} [event.component]
   * @param {number} [event.durationMs]
   * @param {string} [event.errorCode]
   * @param {Object} [event.details] - Will be JSON-serialized
   * @returns {void}
   */
  function recordEvent(event) {
    const now = Date.now();
    insertEvent.run({
      timestamp: event.timestamp ?? now,
      request_id: event.requestId,
      stage: event.stage,
      component: event.component ?? null,
      status: event.status,
      duration_ms: event.durationMs ?? null,
      error_code: event.errorCode ?? null,
      details_json: event.details ? JSON.stringify(event.details) : null,
      timestamp_iso: new Date(event.timestamp ?? now).toISOString(),
    });
  }

  /**
   * Record multiple lifecycle events in a batch.
   *
   * @param {Array<Object>} events
   * @returns {void}
   */
  function recordEvents(events) {
    for (const event of events) {
      recordEvent(event);
    }
  }

  /**
   * Get a request run by ID.
   *
   * @param {string} requestId
   * @returns {Object|null}
   */
  function getRequestRun(requestId) {
    const row = getRunById.get({ request_id: requestId });
    return row ? rowToRequestRun(row) : null;
  }

  /**
   * Get lifecycle events for a request.
   *
   * @param {string} requestId
   * @returns {Array<Object>}
   */
  function getRequestEvents(requestId) {
    return getEventsByRequestId.all({ request_id: requestId }).map(rowToEvent);
  }

  /**
   * Get full request timeline (run + events).
   *
   * @param {string} requestId
   * @returns {Object|null}
   */
  function getRequestTimeline(requestId) {
    const run = getRequestRun(requestId);
    if (!run) return null;
    const events = getRequestEvents(requestId);
    return { run, events };
  }

  /**
   * Get recent request runs.
   *
   * @param {number} [limit=50]
   * @returns {Array<Object>}
   */
  function getRecentRuns(limit = 50) {
    return selectRecentRuns.all({ limit }).map(rowToRequestRun);
  }

  /**
   * Get recent lifecycle events.
   *
   * @param {number} [limit=100]
   * @returns {Array<Object>}
   */
  function getRecentEvents(limit = 100) {
    return selectRecentEvents.all({ limit }).map(rowToEvent);
  }

  /**
   * Get events by stage.
   *
   * @param {string} stage
   * @param {number} [limit=100]
   * @returns {Array<Object>}
   */
  function getEventsByStage(stage, limit = 100) {
    return selectEventsByStage.all({ stage, limit }).map(rowToEvent);
  }

  /**
   * Get failed request runs.
   *
   * @param {number} [limit=50]
   * @returns {Array<Object>}
   */
  function getFailedRuns(limit = 50) {
    return selectFailedRuns.all({ limit }).map(rowToRequestRun);
  }

  /**
   * Count total request runs.
   *
   * @returns {number}
   */
  function countRequestRuns() {
    return countRuns.get().count;
  }

  /**
   * Count total lifecycle events.
   *
   * @returns {number}
   */
  function countLifecycleEvents() {
    return countEvents.get().count;
  }

  /**
   * Count request runs by final status.
   *
   * @returns {Object} Map of status -> count
   */
  function countRunsByStatus() {
    const rows = countByStatus.all();
    const result = {};
    for (const row of rows) {
      result[row.final_status] = row.count;
    }
    return result;
  }

  /**
   * Close the database connection.
   */
  function close() {
    db.close();
  }

  return {
    recordRequestRun,
    completeRequestRun,
    recordEvent,
    recordEvents,
    getRequestRun,
    getRequestEvents,
    getRequestTimeline,
    getRecentRuns,
    getRecentEvents,
    getEventsByStage,
    getFailedRuns,
    countRequestRuns,
    countLifecycleEvents,
    countRunsByStatus,
    close,
    db,
  };
}

/**
 * Convert a database row to a request run object.
 */
function rowToRequestRun(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    finalStatus: row.final_status,
    totalDurationMs: row.total_duration_ms,
    mediaId: row.media_id,
    releaseKey: row.release_key,
    provider: row.provider,
    failureReason: row.failure_reason,
    failureStage: row.failure_stage,
    timingJson: row.timing_json ? JSON.parse(row.timing_json) : null,
    createdAtIso: row.created_at_iso,
    completedAtIso: row.completed_at_iso,
  };
}

/**
 * Convert a database row to a lifecycle event object.
 */
function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    requestId: row.request_id,
    stage: row.stage,
    component: row.component,
    status: row.status,
    durationMs: row.duration_ms,
    errorCode: row.error_code,
    detailsJson: row.details_json ? JSON.parse(row.details_json) : null,
    timestampIso: row.timestamp_iso,
  };
}
