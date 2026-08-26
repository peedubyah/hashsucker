/**
 * Corpus Sampler — selects random releases from the indexed corpus.
 *
 * Picks a random candidate with valid required fields.
 * Retrieves media identity if available.
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * Sample a random release from the corpus.
 *
 * @param {Object} options
 * @param {string} [options.dbPath] — SQLite database path (defaults to DISCOVERY_DB env)
 * @returns {Object|null} Sampled release or null if corpus is empty
 * @returns {string} return.infoHash
 * @returns {number|null} return.fileIndex
 * @returns {string} return.releaseKey
 * @returns {string} return.filename
 * @returns {Object|null} return.identity — { mediaId, confidence, resolutionState } or null
 */
export function sampleRandomRelease(options = {}) {
  const dbPath = options.dbPath || process.env.DISCOVERY_DB;
  if (!dbPath || dbPath === ':memory:') {
    return null;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    // Get a random candidate with valid required fields
    const candidate = db.prepare(`
      SELECT info_hash, file_index, file_index_key, filename, title, size
      FROM candidates
      WHERE info_hash IS NOT NULL
        AND info_hash != ''
        AND filename IS NOT NULL
        AND filename != ''
      ORDER BY RANDOM()
      LIMIT 1
    `).get();

    if (!candidate) {
      return null;
    }

    const infoHash = candidate.info_hash;
    const fileIndex = candidate.file_index;
    const fileIndexKey = candidate.file_index_key;
    const filename = candidate.filename;
    const releaseKey = `${infoHash}:${fileIndex === null || fileIndex === undefined ? 'torrent' : fileIndex}`;

    // Try to get media identity
    const identity = getMediaIdentity(db, infoHash, fileIndexKey);

    return {
      infoHash,
      fileIndex,
      fileIndexKey,
      releaseKey,
      filename,
      title: candidate.title,
      size: candidate.size,
      identity,
    };
  } finally {
    db.close();
  }
}

/**
 * Get media identity for a candidate.
 *
 * @param {DatabaseSync} db
 * @param {string} infoHash
 * @param {number} fileIndexKey
 * @returns {Object|null} { mediaId, confidence, resolutionState, evidence } or null
 */
function getMediaIdentity(db, infoHash, fileIndexKey) {
  const row = db.prepare(`
    SELECT media_id, confidence, evidence
    FROM candidate_media
    WHERE info_hash = ?
      AND file_index_key = ?
    ORDER BY confidence DESC
    LIMIT 1
  `).get(infoHash, fileIndexKey);

  if (!row) {
    return null;
  }

  return {
    mediaId: row.media_id,
    confidence: row.confidence,
    resolutionState: 'unresolved',
    evidence: row.evidence ? JSON.parse(row.evidence) : [],
  };
}

/**
 * Sample multiple random releases.
 *
 * @param {number} count — Number of samples
 * @param {Object} options — Same as sampleRandomRelease
 * @returns {Array<Object>} Array of sampled releases
 */
export function sampleRandomReleases(count, options = {}) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const sample = sampleRandomRelease(options);
    if (sample) {
      results.push(sample);
    }
  }
  return results;
}
