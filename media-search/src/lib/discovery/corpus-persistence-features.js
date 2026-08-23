/**
 * Corpus Persistence Feature Projection
 *
 * Pure read-only feature extraction layer that converts corpus history into
 * normalized evidence features.
 *
 * Purpose:
 *   Projects corpus version history into a structured feature vector that
 *   describes how a candidate has persisted across corpus snapshots.
 *
 *   This is NOT scoring. It is a normalized description of corpus behavior
 *   that future scoring or ranking layers can consume.
 *
 * Feature categories:
 *   - temporal  : when the candidate was first/last observed
 *   - persistence: how many versions contained it vs total available
 *   - lifecycle  : presence state and transition counts (add/remove/churn)
 *
 * Identity key:
 *   - (info_hash, file_index_key) — same normalized identity everywhere
 *
 * Contract:
 *   - No schema additions — pure query over existing tables
 *   - No UPDATE/DELETE on any table
 *   - No access to provider observations or acquisition logic
 *   - Deterministic output
 *   - Safe when no history exists
 */

export function createCorpusPersistenceFeatures(versions) {
  if (!versions) throw new Error('Corpus persistence features require a version registry');

  const db = versions.db || versions.evidence?.db;

  /**
   * Get normalized persistence features for a candidate.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @param {string} [corpusSource='dmm'] — Source to analyze
   * @returns {{
   *   identity: { infoHash: string, fileIndex: number },
   *   temporal: {
   *     firstObserved: number|null,
   *     lastObserved: number|null,
   *     ageMs: number|null,
   *   },
   *   persistence: {
   *     versionsObserved: number,
   *     versionsAvailable: number,
   *     survivalRate: number|null,
   *   },
   *   lifecycle: {
   *     currentlyPresent: boolean,
   *     addedCount: number,
   *     removedCount: number,
   *     churnCount: number,
   *   },
   * }}
   */
  function getPersistenceFeatures(infoHash, fileIndex, corpusSource = 'dmm') {
    if (!infoHash) throw new Error('getPersistenceFeatures requires infoHash');

    const fileIdxKey = fileIndex == null ? -1 : fileIndex;

    // All versions for this source, oldest first
    const allVersions = versions.getVersionHistory(corpusSource, { limit: 1000 }).reverse();
    const versionsAvailable = allVersions.length;

    if (versionsAvailable === 0) {
      return emptyFeatures(infoHash, fileIndex);
    }

    // Temporal bounds from actual observations
    const temporal = getTemporalBounds(db, infoHash, fileIdxKey);

    // Versions where this candidate appears
    const candidateVersions = versions.getCandidateVersions(infoHash, fileIndex);
    const versionsObserved = candidateVersions.length;

    // Walk the version timeline to compute lifecycle transitions
    const lifecycle = computeLifecycle(allVersions, candidateVersions);

    const survivalRate = versionsAvailable > 0
      ? versionsObserved / versionsAvailable
      : null;

    return {
      identity: {
        infoHash,
        fileIndex,
      },
      temporal,
      persistence: {
        versionsObserved,
        versionsAvailable,
        survivalRate,
      },
      lifecycle,
    };
  }

  function getTemporalBounds(db, infoHash, fileIdxKey) {
    const row = db.prepare(`
      SELECT MIN(observed_at) AS earliest, MAX(observed_at) AS latest
      FROM corpus_observations
      WHERE info_hash = @info_hash AND file_index_key = @file_index_key
        AND corpus_version_id IS NOT NULL;
    `).get({ info_hash: infoHash, file_index_key: fileIdxKey });

    const firstObserved = row?.earliest ?? null;
    const lastObserved = row?.latest ?? null;
    const ageMs = (firstObserved != null && lastObserved != null)
      ? lastObserved - firstObserved
      : null;

    return { firstObserved, lastObserved, ageMs };
  }

  function computeLifecycle(allVersions, candidateVersions) {
    const presentSet = new Set(candidateVersions.map((v) => v.id));

    let addedCount = 0;
    let removedCount = 0;
    let currentlyPresent = false;

    for (let i = 0; i < allVersions.length; i++) {
      const isPresent = presentSet.has(allVersions[i].id);

      if (i === 0) {
        // First version: initial appearance is an add event
        if (isPresent) addedCount = 1;
      } else {
        const wasPresent = presentSet.has(allVersions[i - 1].id);
        if (!wasPresent && isPresent) addedCount++;
        if (wasPresent && !isPresent) removedCount++;
      }

      currentlyPresent = isPresent;
    }

    return {
      currentlyPresent,
      addedCount,
      removedCount,
      churnCount: addedCount + removedCount,
    };
  }

  function emptyFeatures(infoHash, fileIndex) {
    return {
      identity: {
        infoHash,
        fileIndex,
      },
      temporal: {
        firstObserved: null,
        lastObserved: null,
        ageMs: null,
      },
      persistence: {
        versionsObserved: 0,
        versionsAvailable: 0,
        survivalRate: null,
      },
      lifecycle: {
        currentlyPresent: false,
        addedCount: 0,
        removedCount: 0,
        churnCount: 0,
      },
    };
  }

  return {
    getPersistenceFeatures,
  };
}
