/**
 * Corpus Versioning and Delta Ingestion Foundation
 *
 * Append-only corpus version registry that establishes a reliable corpus
 * timeline. Enables future evidence models to distinguish:
 *   - "hash was recently observed" (freshness)
 *   - "hash has persisted across many corpus snapshots" (persistence)
 *
 * Version semantics:
 * - A "corpus version" is a logical snapshot of the entire corpus at a point
 *   time (e.g., one DMM git commit, or one ingestion run if no version meta).
 * - `corpus_version` is a deterministic identifier (git SHA, snapshot ID, etc.)
 * - `observed_at` is source-side: when this version was released/updated
 * - `recorded_at` is local-side: when we registered it
 *
 * Append-only contract:
 * - No UPDATE/DELETE on `corpus_versions` or `corpus_version_fragments`
 * - No modification to candidates, provider observations, or acquisition
 * - Existing `corpus_observations` rows remain valid (version_id nullable)
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS corpus_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  corpus_source TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  ingestion_id TEXT,
  fragment_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  UNIQUE (corpus_source, corpus_version)
);

CREATE INDEX IF NOT EXISTS idx_corpus_versions_source
  ON corpus_versions(corpus_source, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_corpus_versions_ingestion
  ON corpus_versions(ingestion_id);

CREATE TABLE IF NOT EXISTS corpus_version_fragments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  corpus_version_id INTEGER NOT NULL,
  fragment_id TEXT NOT NULL,
  fragment_sha TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY (corpus_version_id) REFERENCES corpus_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_corpus_version_fragments_version
  ON corpus_version_fragments(corpus_version_id);
CREATE INDEX IF NOT EXISTS idx_corpus_version_fragments_fragment
  ON corpus_version_fragments(fragment_id);
`;

/**
 * Create a corpus version registry over an existing evidence projection.
 *
 * @param {Object} evidence - Evidence projection instance (createEvidenceProjection)
 * @returns {Object} Corpus version registry interface
 */
export function createCorpusVersionRegistry(evidence) {
  if (!evidence) throw new Error('Corpus version registry requires an evidence projection');

  const db = evidence.db;

  // Ensure schema exists (idempotent, additive)
  db.exec(SCHEMA);

  const insertVersionStmt = db.prepare(`
    INSERT INTO corpus_versions (
      corpus_source, corpus_version, observed_at, recorded_at,
      ingestion_id, fragment_count, record_count, metadata
    ) VALUES (
      @corpus_source, @corpus_version, @observed_at, @recorded_at,
      @ingestion_id, @fragment_count, @record_count, @metadata
    ) ON CONFLICT(corpus_source, corpus_version) DO NOTHING;
  `);

  const getVersionStmt = db.prepare(`
    SELECT * FROM corpus_versions
    WHERE corpus_source = @corpus_source AND corpus_version = @corpus_version;
  `);

  const insertFragmentStmt = db.prepare(`
    INSERT INTO corpus_version_fragments (
      corpus_version_id, fragment_id, fragment_sha, record_count, recorded_at
    ) VALUES (
      @corpus_version_id, @fragment_id, @fragment_sha, @record_count, @recorded_at
    );
  `);

  const getFragmentsStmt = db.prepare(`
    SELECT * FROM corpus_version_fragments
    WHERE corpus_version_id = @corpus_version_id
    ORDER BY fragment_id;
  `);

  const getVersionHistoryStmt = db.prepare(`
    SELECT * FROM corpus_versions
    WHERE corpus_source = @corpus_source
    ORDER BY observed_at DESC
    LIMIT @limit;
  `);

  const getVersionByIdStmt = db.prepare(`
    SELECT * FROM corpus_versions WHERE id = @id;
  `);

  const getVersionByIngestionStmt = db.prepare(`
    SELECT * FROM corpus_versions
    WHERE ingestion_id = @ingestion_id
    LIMIT 1;
  `);

  const countVersionsStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM corpus_versions
    WHERE corpus_source = @corpus_source;
  `);

  const getCandidateVersionsStmt = db.prepare(`
    SELECT DISTINCT cv.id, cv.corpus_source, cv.corpus_version, cv.observed_at
    FROM corpus_observations co
    JOIN corpus_versions cv ON co.corpus_version_id = cv.id
    WHERE co.info_hash = @info_hash AND co.file_index_key = @file_index_key
    ORDER BY cv.observed_at ASC;
  `);

  const getCandidateFirstVersionStmt = db.prepare(`
    SELECT cv.id, cv.corpus_source, cv.corpus_version, cv.observed_at
    FROM corpus_observations co
    JOIN corpus_versions cv ON co.corpus_version_id = cv.id
    WHERE co.info_hash = @info_hash AND co.file_index_key = @file_index_key
    ORDER BY cv.observed_at ASC
    LIMIT 1;
  `);

  const getCandidateLastVersionStmt = db.prepare(`
    SELECT cv.id, cv.corpus_source, cv.corpus_version, cv.observed_at
    FROM corpus_observations co
    JOIN corpus_versions cv ON co.corpus_version_id = cv.id
    WHERE co.info_hash = @info_hash AND co.file_index_key = @file_index_key
    ORDER BY cv.observed_at DESC
    LIMIT 1;
  `);

  function fileIndexKey(fileIndex) {
    return fileIndex == null ? -1 : fileIndex;
  }

  function rowToCorpusVersion(row) {
    return {
      id: row.id,
      corpusSource: row.corpus_source,
      corpusVersion: row.corpus_version,
      observedAt: row.observed_at,
      recordedAt: row.recorded_at,
      ingestionId: row.ingestion_id,
      fragmentCount: row.fragment_count,
      recordCount: row.record_count,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }

  function rowToFragment(row) {
    return {
      id: row.id,
      corpusVersionId: row.corpus_version_id,
      fragmentId: row.fragment_id,
      fragmentSha: row.fragment_sha,
      recordCount: row.record_count,
      recordedAt: row.recorded_at,
    };
  }

  /**
   * Register a new corpus version. Append-only — if the version already exists
   * for this source, returns the existing version without modification.
   *
   * @param {Object} version
   * @param {string} version.corpusSource - Source identifier (e.g., 'dmm')
   * @param {string} version.corpusVersion - Version identifier (git SHA, snapshot ID)
   * @param {number} observedAt - Source-side: when this version was released
   * @param {string} [ingestionId] - Optional ingestion run identifier
   * @param {Object} [metadata] - Optional JSON-serializable metadata
   * @returns {{ version: Object, created: boolean }}
   */
  function registerCorpusVersion({
    corpusSource,
    corpusVersion,
    observedAt,
    ingestionId = null,
    metadata = null,
  }) {
    if (!corpusSource) throw new Error('Corpus version requires corpusSource');
    if (!corpusVersion) throw new Error('Corpus version requires corpusVersion');
    if (observedAt == null) throw new Error('Corpus version requires observedAt');

    const recordedAt = Date.now();
    const metadataJson = metadata != null ? JSON.stringify(metadata) : null;

    const result = insertVersionStmt.run({
      corpus_source: corpusSource,
      corpus_version: corpusVersion,
      observed_at: observedAt,
      recorded_at: recordedAt,
      ingestion_id: ingestionId,
      fragment_count: 0,
      record_count: 0,
      metadata: metadataJson,
    });

    const created = result.changes > 0;
    const row = getVersionStmt.get({
      corpus_source: corpusSource,
      corpus_version: corpusVersion,
    });

    return {
      version: rowToCorpusVersion(row),
      created,
    };
  }

  /**
   * Register a fragment belonging to a corpus version.
   *
   * @param {Object} fragment
   * @param {number} fragment.corpusVersionId - ID from registerCorpusVersion
   * @param {string} fragment.fragmentId - Fragment identifier (e.g., filename)
   * @param {string} [fragment.fragmentSha] - Git blob SHA if available
   * @param {number} [fragment.recordCount] - Number of records in this fragment
   * @returns {Object} The registered fragment
   */
  function registerFragment({
    corpusVersionId,
    fragmentId,
    fragmentSha = null,
    recordCount = 0,
  }) {
    if (!corpusVersionId) throw new Error('Fragment requires corpusVersionId');
    if (!fragmentId) throw new Error('Fragment requires fragmentId');

    const recordedAt = Date.now();

    const result = insertFragmentStmt.run({
      corpus_version_id: corpusVersionId,
      fragment_id: fragmentId,
      fragment_sha: fragmentSha,
      record_count: recordCount,
      recorded_at: recordedAt,
    });

    return {
      id: Number(result.lastInsertRowid),
      corpusVersionId,
      fragmentId,
      fragmentSha,
      recordCount,
      recordedAt,
    };
  }

  /**
   * Get a corpus version by source and version identifier.
   *
   * @param {string} corpusSource
   * @param {string} corpusVersion
   * @returns {Object|null}
   */
  function getVersion(corpusSource, corpusVersion) {
    const row = getVersionStmt.get({
      corpus_source: corpusSource,
      corpus_version: corpusVersion,
    });
    return row ? rowToCorpusVersion(row) : null;
  }

  /**
   * Get a corpus version by ID.
   *
   * @param {number} id
   * @returns {Object|null}
   */
  function getVersionById(id) {
    const row = getVersionByIdStmt.get({ id });
    return row ? rowToCorpusVersion(row) : null;
  }

  /**
   * Get the corpus version for an ingestion run.
   *
   * @param {string} ingestionId
   * @returns {Object|null}
   */
  function getVersionByIngestion(ingestionId) {
    const row = getVersionByIngestionStmt.get({ ingestion_id: ingestionId });
    return row ? rowToCorpusVersion(row) : null;
  }

  /**
   * Get version history for a corpus source.
   *
   * @param {string} corpusSource
   * @param {Object} [options]
   * @param {number} [options.limit=100]
   * @returns {Array<Object>} Versions (newest first)
   */
  function getVersionHistory(corpusSource, options = {}) {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('History limit must be between 1 and 1000');
    }

    const rows = getVersionHistoryStmt.all({
      corpus_source: corpusSource,
      limit,
    });
    return rows.map(rowToCorpusVersion);
  }

  /**
   * Get fragments for a corpus version.
   *
   * @param {number} corpusVersionId
   * @returns {Array<Object>}
   */
  function getFragments(corpusVersionId) {
    const rows = getFragmentsStmt.all({ corpus_version_id: corpusVersionId });
    return rows.map(rowToFragment);
  }

  /**
   * Count total versions for a corpus source.
   *
   * @param {string} corpusSource
   * @returns {number}
   */
  function countVersions(corpusSource) {
    const row = countVersionsStmt.get({ corpus_source: corpusSource });
    return row.count;
  }

  /**
   * Get all corpus versions that observed a candidate.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {Array<Object>} Versions (oldest first)
   */
  function getCandidateVersions(infoHash, fileIndex) {
    const rows = getCandidateVersionsStmt.all({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return rows.map(rowToCorpusVersion);
  }

  /**
   * Get the first corpus version that observed a candidate.
   * Answers: "Which corpus snapshot introduced this hash?"
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {Object|null}
   */
  function getCandidateFirstVersion(infoHash, fileIndex) {
    const row = getCandidateFirstVersionStmt.get({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return row ? rowToCorpusVersion(row) : null;
  }

  /**
   * Get the last corpus version that observed a candidate.
   * Answers: "When was this hash last present?"
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {Object|null}
   */
  function getCandidateLastVersion(infoHash, fileIndex) {
    const row = getCandidateLastVersionStmt.get({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return row ? rowToCorpusVersion(row) : null;
  }

  /**
   * Get the full version persistence record for a candidate.
   * Answers: "Did this hash survive multiple corpus updates?"
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {{
   *   infoHash: string,
   *   fileIndex: number|null,
   *   firstVersion: Object|null,
   *   lastVersion: Object|null,
   *   versionCount: number,
   *   versions: Array<Object>,
   *   persistedAcrossVersions: boolean,
   * }}
   */
  function getCandidateVersionPersistence(infoHash, fileIndex) {
    const versions = getCandidateVersions(infoHash, fileIndex);
    const firstVersion = versions[0] || null;
    const lastVersion = versions[versions.length - 1] || null;

    return {
      infoHash,
      fileIndex,
      firstVersion,
      lastVersion,
      versionCount: versions.length,
      versions,
      persistedAcrossVersions: versions.length > 1,
    };
  }

  /**
   * Get the version-aware observation history for a candidate.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @param {Object} [options]
   * @param {number} [options.limit=100]
   * @returns {Array<Object>} Observations with version info attached
   */
  function getVersionedObservationHistory(infoHash, fileIndex, options = {}) {
    const limit = options.limit ?? 100;
    const observations = evidence.getCorpusObservationHistory(infoHash, fileIndex, { limit });

    return observations.map((obs) => {
      let version = null;
      if (obs.corpusVersionId) {
        version = getVersionById(obs.corpusVersionId);
      }
      return { ...obs, version };
    });
  }

  return {
    registerCorpusVersion,
    registerFragment,
    getVersion,
    getVersionById,
    getVersionByIngestion,
    getVersionHistory,
    getFragments,
    countVersions,
    getCandidateVersions,
    getCandidateFirstVersion,
    getCandidateLastVersion,
    getCandidateVersionPersistence,
    getVersionedObservationHistory,
    // Exposed for derived projection layers (e.g., corpus-persistence-features)
    get db() { return db; },
  };
}
