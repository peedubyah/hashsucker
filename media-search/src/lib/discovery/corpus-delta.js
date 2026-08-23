/**
 * Corpus Delta Analysis Foundation
 *
 * Pure read-only projection layer over corpus_observations and corpus_versions.
 *
 * Purpose:
 *   Answers "What changed between two corpus snapshots?" without modifying
 *   any source data, candidates, or provider observations.
 *
 * Identity key:
 *   - (info_hash, file_index_key) — the same normalized identity used
 *     everywhere else. file_index_key = -1 represents a null fileIndex.
 *   - NOT filename. NOT candidate row identity.
 *
 * Comparison model:
 *   - "added"    : present in toVersion, absent from fromVersion
 *   - "removed"  : present in fromVersion, absent from toVersion
 *   - "unchanged": present in both versions
 *
 * Contract:
 *   - No schema additions — pure query over existing tables
 *   - No UPDATE/DELETE on any table
 *   - No access to provider observations or acquisition logic
 *   - Deterministic ordering: sorted by (info_hash, file_index_key)
 *   - Safe when versions don't exist or source mismatches
 */

export function createCorpusDelta(evidence) {
  if (!evidence) throw new Error('Corpus delta requires an evidence projection');

  const db = evidence.db;

  /**
   * Get all distinct identity keys observed in a specific corpus version.
   *
   * Only considers observations linked to a version via corpus_version_id.
   * Rows without a corpus_version_id are excluded — they cannot be diffed.
   *
   * @param {string} corpusSource
   * @param {string} corpusVersion
   * @returns {Array<{infoHash: string, fileIndex: number}>}
   */
  function getVersionKeys(corpusSource, corpusVersion) {
    const rows = db.prepare(`
      SELECT DISTINCT co.info_hash, co.file_index_key
      FROM corpus_observations co
      JOIN corpus_versions cv ON co.corpus_version_id = cv.id
      WHERE cv.corpus_source = @corpus_source AND cv.corpus_version = @corpus_version
      ORDER BY co.info_hash, co.file_index_key;
    `).all({
      corpus_source: corpusSource,
      corpus_version: corpusVersion,
    });

    return rows.map((r) => ({
      infoHash: r.info_hash,
      fileIndex: r.file_index_key,
    }));
  }

  /**
   * Compute the delta between two corpus versions.
   *
   * @param {string} corpusSource — Source identifier (e.g., 'dmm')
   * @param {string} fromVersion — Earlier version identifier
   * @param {string} toVersion — Later version identifier
   * @returns {{
   *   source: string,
   *   fromVersion: string,
   *   toVersion: string,
   *   added: Array<{infoHash: string, fileIndex: number}>,
   *   removed: Array<{infoHash: string, fileIndex: number}>,
   *   unchanged: Array<{infoHash: string, fileIndex: number}>,
   * }}
   * @throws {Error} If corpusSource, fromVersion, or toVersion is missing.
   */
  function computeDelta(corpusSource, fromVersion, toVersion) {
    if (!corpusSource) throw new Error('Corpus delta requires corpusSource');
    if (!fromVersion) throw new Error('Corpus delta requires fromVersion');
    if (!toVersion) throw new Error('Corpus delta requires toVersion');

    const added = computeAdded(corpusSource, fromVersion, toVersion);
    const removed = computeRemoved(corpusSource, fromVersion, toVersion);
    const unchanged = computeUnchanged(corpusSource, fromVersion, toVersion);

    return {
      source: corpusSource,
      fromVersion,
      toVersion,
      added,
      removed,
      unchanged,
    };
  }

  function computeAdded(corpusSource, fromVersion, toVersion) {
    const rows = db.prepare(`
      SELECT t.info_hash, t.file_index_key
      FROM corpus_observations t
      JOIN corpus_versions tcv ON t.corpus_version_id = tcv.id
      WHERE tcv.corpus_source = @corpus_source AND tcv.corpus_version = @to_version
        AND NOT EXISTS (
          SELECT 1
          FROM corpus_observations f
          JOIN corpus_versions fcv ON f.corpus_version_id = fcv.id
          WHERE fcv.corpus_source = @corpus_source AND fcv.corpus_version = @from_version
            AND f.info_hash = t.info_hash AND f.file_index_key = t.file_index_key
        )
      GROUP BY t.info_hash, t.file_index_key
      ORDER BY t.info_hash, t.file_index_key;
    `).all({
      corpus_source: corpusSource,
      from_version: fromVersion,
      to_version: toVersion,
    });

    return rows.map((r) => ({
      infoHash: r.info_hash,
      fileIndex: r.file_index_key,
    }));
  }

  function computeRemoved(corpusSource, fromVersion, toVersion) {
    const rows = db.prepare(`
      SELECT f.info_hash, f.file_index_key
      FROM corpus_observations f
      JOIN corpus_versions fcv ON f.corpus_version_id = fcv.id
      WHERE fcv.corpus_source = @corpus_source AND fcv.corpus_version = @from_version
        AND NOT EXISTS (
          SELECT 1
          FROM corpus_observations t
          JOIN corpus_versions tcv ON t.corpus_version_id = tcv.id
          WHERE tcv.corpus_source = @corpus_source AND tcv.corpus_version = @to_version
            AND t.info_hash = f.info_hash AND t.file_index_key = f.file_index_key
        )
      GROUP BY f.info_hash, f.file_index_key
      ORDER BY f.info_hash, f.file_index_key;
    `).all({
      corpus_source: corpusSource,
      from_version: fromVersion,
      to_version: toVersion,
    });

    return rows.map((r) => ({
      infoHash: r.info_hash,
      fileIndex: r.file_index_key,
    }));
  }

  function computeUnchanged(corpusSource, fromVersion, toVersion) {
    const rows = db.prepare(`
      SELECT f.info_hash, f.file_index_key
      FROM corpus_observations f
      JOIN corpus_versions fcv ON f.corpus_version_id = fcv.id
      WHERE fcv.corpus_source = @corpus_source AND fcv.corpus_version = @from_version
        AND EXISTS (
          SELECT 1
          FROM corpus_observations t
          JOIN corpus_versions tcv ON t.corpus_version_id = tcv.id
          WHERE tcv.corpus_source = @corpus_source AND tcv.corpus_version = @to_version
            AND t.info_hash = f.info_hash AND t.file_index_key = f.file_index_key
        )
      GROUP BY f.info_hash, f.file_index_key
      ORDER BY f.info_hash, f.file_index_key;
    `).all({
      corpus_source: corpusSource,
      from_version: fromVersion,
      to_version: toVersion,
    });

    return rows.map((r) => ({
      infoHash: r.info_hash,
      fileIndex: r.file_index_key,
    }));
  }

  return {
    getVersionKeys,
    computeDelta,
  };
}
