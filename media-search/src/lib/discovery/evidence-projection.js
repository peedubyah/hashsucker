/**
 * Evidence Projection
 *
 * Read-only evidence contract over existing candidate data.
 *
 * Purpose:
 * - Exposes candidate temporal metadata (first_seen / last_seen) separately
 *   from corpus observation events.
 * - Provides append-only observation storage for future DMM delta ingestion.
 * - Does NOT duplicate candidate metadata — references candidates by PK.
 * - Does NOT modify acquisition decisions or provider observations.
 *
 * Temporal contract (two distinct clocks):
 * - `observed_at` (source-side): when the SOURCE recorded/held the hash.
 *   This is evidence time — e.g., the DMM git commit timestamp for the
 *   fragment containing this hash. It tells you when the corpus knew
 *   about the candidate.
 * - `ingested_at` (local-side): when OUR system ingested/recorded the
 *   observation. Auto-generated at insert time. This is audit time —
 *   tells you when we learned about it.
 *
 * These MUST remain distinct. If you set observed_at = Date.now(),
 * you collapse source evidence into ingestion time and destroy the
 * ability to detect corpus deltas (new/removed hashes across runs).
 *
 * Contract:
 * - Append-only writes to corpus_observations (no UPDATE/DELETE).
 * - All reads are derived from existing tables or the append-only log.
 * - Candidate timeline = first_seen, last_seen, corpus observation count,
 *   and provider observation count — no metadata duplication.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS corpus_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  ingestion_id TEXT,
  fragment_id TEXT,
  evidence TEXT,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_corpus_observations_candidate
  ON corpus_observations(info_hash, file_index_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_corpus_observations_source
  ON corpus_observations(source, observed_at DESC);
`;

/**
 * Create an evidence projection over an existing discovery cache.
 *
 * @param {Object} cache - Discovery cache instance (createDiscoveryCache)
 * @returns {Object} Evidence projection interface
 */
export function createEvidenceProjection(cache) {
  if (!cache) throw new Error('Evidence projection requires a cache instance');

  const db = cache.db;

  // Ensure schema exists (idempotent, additive)
  db.exec(SCHEMA);

  const insertCorpusObservationStmt = db.prepare(`
    INSERT INTO corpus_observations (
      info_hash, file_index_key, observed_at, source,
      ingestion_id, fragment_id, evidence, recorded_at
    ) VALUES (
      @info_hash, @file_index_key, @observed_at, @source,
      @ingestion_id, @fragment_id, @evidence, @recorded_at
    );
  `);

  const getCorpusHistoryStmt = db.prepare(`
    SELECT * FROM corpus_observations
    WHERE info_hash = @info_hash AND file_index_key = @file_index_key
    ORDER BY observed_at DESC, id DESC
    LIMIT @limit;
  `);

  const getCorpusHistoryBySourceStmt = db.prepare(`
    SELECT * FROM corpus_observations
    WHERE info_hash = @info_hash AND file_index_key = @file_index_key
      AND source = @source
    ORDER BY observed_at DESC, id DESC
    LIMIT @limit;
  `);

  const countCorpusObservationsStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM corpus_observations
    WHERE info_hash = @info_hash AND file_index_key = @file_index_key;
  `);

  const countCorpusObservationsBySourceStmt = db.prepare(`
    SELECT source, COUNT(*) AS count FROM corpus_observations
    WHERE info_hash = @info_hash AND file_index_key = @file_index_key
    GROUP BY source;
  `);

  const getCorpusObservationRangeStmt = db.prepare(`
    SELECT MIN(observed_at) AS earliest, MAX(observed_at) AS latest
    FROM corpus_observations
    WHERE info_hash = @info_hash AND file_index_key = @file_index_key;
  `);

  const listSourcesStmt = db.prepare(`
    SELECT DISTINCT source FROM corpus_observations
    WHERE info_hash = @info_hash AND file_index_key = @file_index_key
    ORDER BY source;
  `);

  function fileIndexKey(fileIndex) {
    return fileIndex == null ? -1 : fileIndex;
  }

  function rowToCorpusObservation(row) {
    return {
      id: row.id,
      infoHash: row.info_hash,
      fileIndexKey: row.file_index_key,
      observedAt: row.observed_at,
      source: row.source,
      ingestionId: row.ingestion_id,
      fragmentId: row.fragment_id,
      evidence: row.evidence ? JSON.parse(row.evidence) : null,
      ingestedAt: row.recorded_at,
    };
  }

  /**
   * Append a corpus observation. Append-only — cannot update or delete.
   *
   * CRITICAL: `observedAt` MUST be source-side evidence time (when the
   * source recorded the hash), NOT when you are calling this function.
   * Setting observedAt = Date.now() collapses source evidence into
   * ingestion time and destroys delta detection.
   *
   * @param {Object} observation
   * @param {string} observation.infoHash - Candidate infoHash
   * @param {number|null} observation.fileIndex - Candidate fileIndex
   * @param {number} observedAt - SOURCE-SIDE evidence time (ms epoch).
   *   When the source recorded/held the hash — e.g., DMM fragment git
   *   commit timestamp. NOT ingestion time.
   * @param {string} source - Source identifier (e.g., 'dmm-hashlist', 'scraper')
   * @param {string} [ingestionId] - Optional batch ingestion run identifier
   * @param {string} [fragmentId] - Optional source-specific fragment identifier
   * @param {Object} [evidence] - Optional JSON-serializable evidence blob
   * @returns {Object} The recorded observation with id and ingestedAt
   */
  function appendCorpusObservation({
    infoHash,
    fileIndex = null,
    observedAt,
    source,
    ingestionId = null,
    fragmentId = null,
    evidence = null,
  }) {
    if (!infoHash) throw new Error('Corpus observation requires infoHash');
    if (observedAt == null) throw new Error('Corpus observation requires observedAt');
    if (!source) throw new Error('Corpus observation requires source');

    const ingestedAt = Date.now();
    const evidenceJson = evidence != null ? JSON.stringify(evidence) : null;

    const result = insertCorpusObservationStmt.run({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
      observed_at: observedAt,
      source,
      ingestion_id: ingestionId,
      fragment_id: fragmentId,
      evidence: evidenceJson,
      recorded_at: ingestedAt,
    });

    return {
      id: Number(result.lastInsertRowid),
      infoHash,
      fileIndexKey: fileIndexKey(fileIndex),
      observedAt,
      source,
      ingestionId,
      fragmentId,
      evidence,
      ingestedAt,
    };
  }

  /**
   * Get corpus observation history for a candidate.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @param {Object} [options]
   * @param {number} [options.limit=100] — 1..1000
   * @param {string} [options.source] — filter by source
   * @returns {Array<Object>} Append-only observation history (newest first)
   */
  function getCorpusObservationHistory(infoHash, fileIndex, options = {}) {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('History limit must be between 1 and 1000');
    }

    if (options.source != null) {
      const rows = getCorpusHistoryBySourceStmt.all({
        info_hash: infoHash,
        file_index_key: fileIndexKey(fileIndex),
        source: options.source,
        limit,
      });
      return rows.map(rowToCorpusObservation);
    }

    const rows = getCorpusHistoryStmt.all({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
      limit,
    });
    return rows.map(rowToCorpusObservation);
  }

  /**
   * Count corpus observations for a candidate.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @param {Object} [options]
   * @param {string} [options.source] — filter by source
   * @returns {number} Observation count
   */
  function countCorpusObservations(infoHash, fileIndex, options = {}) {
    if (options.source != null) {
      const row = db.prepare(`
        SELECT COUNT(*) AS count FROM corpus_observations
        WHERE info_hash = ? AND file_index_key = ? AND source = ?
      `).get(infoHash, fileIndexKey(fileIndex), options.source);
      return row.count;
    }
    const row = countCorpusObservationsStmt.get({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return row.count;
  }

  /**
   * Count corpus observations grouped by source.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {Array<{source: string, count: number}>}
   */
  function countCorpusObservationsBySource(infoHash, fileIndex) {
    const rows = countCorpusObservationsBySourceStmt.all({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return rows.map((r) => ({ source: r.source, count: r.count }));
  }

  /**
   * Get the time range of corpus observations for a candidate.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {{earliest: number|null, latest: number|null}}
   */
  function getCorpusObservationRange(infoHash, fileIndex) {
    const row = getCorpusObservationRangeStmt.get({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return {
      earliest: row.earliest ?? null,
      latest: row.latest ?? null,
    };
  }

  /**
   * List distinct sources that have observed this candidate.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {Array<string>}
   */
  function listCorpusSources(infoHash, fileIndex) {
    const rows = listSourcesStmt.all({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return rows.map((r) => r.source);
  }

  /**
   * Get the full temporal evidence timeline for a candidate.
   *
   * Combines candidate first_seen/last_seen with corpus observation
   * metadata and provider observation counts — no metadata duplication.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {{
   *   infoHash: string,
   *   fileIndex: number|null,
   *   firstSeen: number|null,
   *   lastSeen: number|null,
   *   corpusObservationCount: number,
   *   corpusObservationRange: {earliest: number|null, latest: number|null},
   *   corpusSources: Array<string>,
   *   corpusBySource: Array<{source: string, count: number}>,
   *   providerObservationCount: number,
   * }|null}
   */
  function getCandidateTimeline(infoHash, fileIndex) {
    const candidate = cache.getCandidate(infoHash, fileIndex);
    if (!candidate) return null;

    const fileIdxKey = fileIndexKey(fileIndex);

    const corpusCount = countCorpusObservations(infoHash, fileIndex);
    const corpusRange = getCorpusObservationRange(infoHash, fileIndex);
    const corpusSources = listCorpusSources(infoHash, fileIndex);
    const corpusBySource = countCorpusObservationsBySource(infoHash, fileIndex);
    const providerObs = cache.getProviderObservations(infoHash, fileIndex);

    return {
      infoHash: candidate.infoHash,
      fileIndex: candidate.fileIndex,
      firstSeen: candidate.firstSeen,
      lastSeen: candidate.lastSeen,
      corpusObservationCount: corpusCount,
      corpusObservationRange: corpusRange,
      corpusSources,
      corpusBySource,
      providerObservationCount: providerObs.length,
    };
  }

  /**
   * Query candidates filtered by temporal evidence properties.
   *
   * All filters are read-only projections over existing data.
   *
   * @param {Object} [options]
   * @param {number} [options.olderThan] — Exclude candidates with corpus
   *   observations newer than this timestamp
   * @param {number} [options.newerThan] — Exclude candidates with corpus
   *   observations older than this timestamp
   * @param {number} [options.minCorpusObservations] — Minimum observation count
   * @param {number} [options.maxCorpusObservations] — Maximum observation count
   * @param {string} [options.hasSource] — Must have observation from this source
   * @param {string} [options.corpusSource] — Alias for hasSource
   * @param {number} [options.maxProviderObservations] — Maximum provider obs count
   * @returns {Array<Object>} Candidate timeline objects
   */
  function queryEvidence(options = {}) {
    const {
      olderThan,
      newerThan,
      minCorpusObservations,
      maxCorpusObservations,
      hasSource,
      corpusSource,
      maxProviderObservations,
    } = options;

    const sourceFilter = hasSource ?? corpusSource;

    // Get all candidates (read-only — uses cache.queryCachedCandidates)
    const candidates = cache.queryCachedCandidates({});
    const timelines = [];

    for (const candidate of candidates) {
      const timeline = getCandidateTimeline(candidate.infoHash, candidate.fileIndex);
      if (!timeline) continue;

      // Apply temporal filters
      if (olderThan != null && timeline.corpusObservationRange.latest != null) {
        if (timeline.corpusObservationRange.latest > olderThan) continue;
      }

      if (newerThan != null && timeline.corpusObservationRange.earliest != null) {
        if (timeline.corpusObservationRange.earliest < newerThan) continue;
      }

      if (minCorpusObservations != null) {
        if (timeline.corpusObservationCount < minCorpusObservations) continue;
      }

      if (maxCorpusObservations != null) {
        if (timeline.corpusObservationCount > maxCorpusObservations) continue;
      }

      if (sourceFilter != null) {
        if (!timeline.corpusSources.includes(sourceFilter)) continue;
      }

      if (maxProviderObservations != null) {
        if (timeline.providerObservationCount > maxProviderObservations) continue;
      }

      timelines.push(timeline);
    }

    return timelines;
  }

  return {
    appendCorpusObservation,
    getCorpusObservationHistory,
    countCorpusObservations,
    countCorpusObservationsBySource,
    getCorpusObservationRange,
    listCorpusSources,
    getCandidateTimeline,
    queryEvidence,
  };
}
