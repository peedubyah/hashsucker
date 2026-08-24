/**
 * Search Decision Store
 *
 * Persists search decisions for later cache confidence model training.
 *
 * Schema:
 *   search_decisions (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     query TEXT NOT NULL,
 *     timestamp INTEGER NOT NULL,
 *     candidate_count INTEGER NOT NULL,
 *     winning_release_key TEXT,
 *     winner_source TEXT,
 *     winner_score REAL,
 *     score_breakdown TEXT,  -- JSON: { cacheScore, qualityScore, sourceScore, metadataScore, popularityScore }
 *     cache_state TEXT,       -- 'cached', 'uncached', 'unknown'
 *     rejected_count INTEGER NOT NULL DEFAULT 0,
 *     media_id TEXT,
 *     created_at INTEGER NOT NULL
 *   )
 *
 * This is append-only. Decisions are never updated or deleted.
 */

import { DatabaseSync } from 'node:sqlite';

const SEARCH_DECISIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS search_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  candidate_count INTEGER NOT NULL,
  winning_release_key TEXT,
  winner_source TEXT,
  winner_score REAL,
  score_breakdown TEXT NOT NULL DEFAULT '{}',
  cache_state TEXT NOT NULL DEFAULT 'unknown',
  rejected_count INTEGER NOT NULL DEFAULT 0,
  media_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_decisions_timestamp ON search_decisions(timestamp);
CREATE INDEX IF NOT EXISTS idx_search_decisions_query ON search_decisions(query);
CREATE INDEX IF NOT EXISTS idx_search_decisions_winner_source ON search_decisions(winner_source);
`;

/**
 * Create a search decision store.
 *
 * @param {Object} options
 * @param {string} [options.dbPath] - SQLite database path (default: ':memory:')
 * @param {DatabaseSync} [options.database] - Existing database instance
 * @returns {SearchDecisionStore}
 */
export function createSearchDecisionStore({ dbPath = ':memory:', database = null } = {}) {
  const db = database || new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SEARCH_DECISIONS_SCHEMA);

  const insertStmt = db.prepare(`
    INSERT INTO search_decisions (
      query, timestamp, candidate_count, winning_release_key,
      winner_source, winner_score, score_breakdown, cache_state,
      rejected_count, media_id, created_at
    ) VALUES (
      @query, @timestamp, @candidate_count, @winning_release_key,
      @winner_source, @winner_score, @score_breakdown, @cache_state,
      @rejected_count, @media_id, @created_at
    )
  `);

  const selectRecentStmt = db.prepare(`
    SELECT * FROM search_decisions
    ORDER BY timestamp DESC
    LIMIT @limit
  `);

  const selectByQueryStmt = db.prepare(`
    SELECT * FROM search_decisions
    WHERE query = @query
    ORDER BY timestamp DESC
    LIMIT @limit
  `);

  const countStmt = db.prepare(`
    SELECT COUNT(*) as count FROM search_decisions
  `);

  /**
   * Record a search decision.
   *
   * @param {Object} decision
   * @param {string} decision.query - Search query text
   * @param {number} [decision.timestamp] - Unix ms (default: now)
   * @param {number} decision.candidate_count - Total candidates discovered
   * @param {string} [decision.winning_release_key] - Winner's releaseKey
   * @param {string} [decision.winner_source] - Winner's source origin
   * @param {number} [decision.winner_score] - Winner's final score
   * @param {Object} [decision.score_breakdown] - Score component breakdown
   * @param {string} [decision.cache_state] - Winner's cache state
   * @param {number} [decision.rejected_count] - Number of rejected candidates
   * @param {string} [decision.media_id] - Media ID if scoped
   * @returns {number} Row ID of the inserted decision
   */
  function recordDecision(decision) {
    const now = Date.now();
    const params = {
      query: decision.query ?? '',
      timestamp: decision.timestamp ?? now,
      candidate_count: decision.candidate_count ?? 0,
      winning_release_key: decision.winning_release_key ?? null,
      winner_source: decision.winner_source ?? null,
      winner_score: decision.winner_score ?? null,
      score_breakdown: JSON.stringify(decision.score_breakdown ?? {}),
      cache_state: decision.cache_state ?? 'unknown',
      rejected_count: decision.rejected_count ?? 0,
      media_id: decision.media_id ?? null,
      created_at: now,
    };
    const result = insertStmt.run(params);
    return result.lastInsertRowid;
  }

  /**
   * Get recent search decisions.
   *
   * @param {number} [limit=100]
   * @returns {Array<Object>}
   */
  function getRecentDecisions(limit = 100) {
    return selectRecentStmt.all({ limit }).map(rowToDecision);
  }

  /**
   * Get decisions by query.
   *
   * @param {string} query
   * @param {number} [limit=100]
   * @returns {Array<Object>}
   */
  function getDecisionsByQuery(query, limit = 100) {
    return selectByQueryStmt.all({ query, limit }).map(rowToDecision);
  }

  /**
   * Count total decisions.
   *
   * @returns {number}
   */
  function countDecisions() {
    return countStmt.get().count;
  }

  /**
   * Close the database connection.
   */
  function close() {
    db.close();
  }

  return {
    recordDecision,
    getRecentDecisions,
    getDecisionsByQuery,
    countDecisions,
    close,
    db,
  };
}

/**
 * Convert a database row to a decision object.
 */
function rowToDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    query: row.query,
    timestamp: row.timestamp,
    candidate_count: row.candidate_count,
    winning_release_key: row.winning_release_key,
    winner_source: row.winner_source,
    winner_score: row.winner_score,
    score_breakdown: JSON.parse(row.score_breakdown || '{}'),
    cache_state: row.cache_state,
    rejected_count: row.rejected_count,
    media_id: row.media_id,
    created_at: row.created_at,
  };
}

/**
 * Extract a search decision from a search trace.
 *
 * @param {Object} trace - Output from searchTrace()
 * @param {string} [mediaId] - Media ID if scoped
 * @returns {Object} Decision object ready for recordDecision()
 */
export function decisionFromTrace(trace, mediaId = null) {
  const winner = trace.candidates[0];
  const breakdown = winner?.justification?.scoreBreakdown ?? {};

  return {
    query: trace.query,
    timestamp: Date.now(),
    candidate_count: trace.pipeline?.discovered ?? trace.candidates.length,
    winning_release_key: winner?.releaseKey ?? null,
    winner_source: winner?.provenance?.source ?? winner?.source ?? null,
    winner_score: winner?.score ?? null,
    score_breakdown: {
      cacheScore: breakdown.cacheScore ?? null,
      qualityScore: breakdown.qualityScore ?? null,
      sourceScore: breakdown.sourceScore ?? null,
      metadataScore: breakdown.metadataScore ?? null,
      popularityScore: breakdown.popularityScore ?? null,
    },
    cache_state: winner?.provenance?.cacheState ?? 'unknown',
    rejected_count: trace.rejections?.length ?? 0,
    media_id: mediaId,
  };
}
