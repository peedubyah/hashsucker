/**
 * Corpus Evidence Feature Projection
 *
 * Pure read-only feature extraction over corpus observations. Produces a
 * normalized evidence object for a candidate without modifying acquisition
 * decisions, provider observations, or candidate metadata.
 *
 * Feature taxonomy:
 * - temporal.persistence: how long the candidate has been in the corpus
 *   (latest - earliest source observation time)
 * - temporal.freshness: how recently the corpus observed it
 *   (now - latest source observation time)
 * - temporal.firstObserved: earliest source-side evidence time
 * - temporal.lastObserved: latest source-side evidence time
 * - volume.observationCount: total corpus observations
 * - volume.versionCount: distinct corpus versions (ingestion_ids)
 * - volume.sourceCount: distinct sources that observed this candidate
 * - topology: opaque hooks for exploring candidate relationships
 *   (same source, same ingestion run) — no computation, just references
 *
 * Contract:
 * - All features are derived; nothing is stored.
 * - Provider observations are not accessed or modified.
 * - Missing evidence yields zero/null values, never throws.
 * - Topology hooks are lazy — they return iterables, not materialized sets.
 */

import { createEvidenceProjection } from './evidence-projection.js';

/**
 * Default topology provider — returns no relationships.
 * Override with a real topology source when graph edges are available.
 */
function emptyTopology() {
  return {
    bySource: () => [],
    byIngestion: () => [],
    coObserved: () => [],
  };
}

/**
 * Create a corpus evidence feature projection.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} [options]
 * @param {Function} [options.topologyProvider] - ({ infoHash, fileIndex, source, ingestionId }) => TopologyHooks
 * @returns {Object} Feature projection interface
 */
export function createCorpusEvidenceFeatures(cache, options = {}) {
  if (!cache) throw new Error('Corpus evidence features require a cache instance');

  const evidence = createEvidenceProjection(cache);
  const getTopology = options.topologyProvider || (() => emptyTopology());

  /**
   * Normalize a candidate's raw observations into derived features.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @param {Object} [options]
   * @param {number} [options.now] — Override current time (for deterministic tests)
   * @returns {CorpusEvidence} Normalized evidence object
   */
  function getEvidence(infoHash, fileIndex, options = {}) {
    const now = options.now ?? Date.now();
    const history = evidence.getCorpusObservationHistory(infoHash, fileIndex, { limit: 1000 });
    const range = evidence.getCorpusObservationRange(infoHash, fileIndex);
    const sources = evidence.listCorpusSources(infoHash, fileIndex);
    const bySource = evidence.countCorpusObservationsBySource(infoHash, fileIndex);

    // Extract distinct ingestion_ids (corpus versions) from history
    const versionSet = new Set();
    for (const obs of history) {
      if (obs.ingestionId != null) {
        versionSet.add(obs.ingestionId);
      }
    }

    // Temporal calculations
    const firstObserved = range.earliest;
    const lastObserved = range.latest;
    const persistenceMs = (firstObserved != null && lastObserved != null)
      ? lastObserved - firstObserved
      : 0;
    const freshnessMs = lastObserved != null ? now - lastObserved : null;

    // Topology hooks — lazy accessors, not materialized
    const topology = {
      /**
       * Get candidates co-observed from the same source.
       * @returns {Array<string>} infoHashes
       */
      bySource: (source) => {
        const t = getTopology({ infoHash, fileIndex, source });
        return t ? t.bySource(source) : [];
      },

      /**
       * Get candidates from the same ingestion run.
       * @param {string} ingestionId
       * @returns {Array<string>} infoHashes
       */
      byIngestion: (ingestionId) => {
        const t = getTopology({ infoHash, fileIndex, ingestionId });
        return t ? t.byIngestion(ingestionId) : [];
      },

      /**
       * Get candidates co-observed in the same fragment.
       * @param {string} fragmentId
       * @returns {Array<string>} infoHashes
       */
      coObserved: (fragmentId) => {
        const t = getTopology({ infoHash, fileIndex, fragmentId });
        return t ? t.coObserved(fragmentId) : [];
      },
    };

    return {
      infoHash,
      fileIndex,

      temporal: {
        firstObserved,
        lastObserved,
        persistenceMs,
        freshnessMs,
      },

      volume: {
        observationCount: history.length,
        versionCount: versionSet.size,
        sourceCount: sources.length,
      },

      sources: {
        list: sources,
        counts: bySource.map((s) => ({ source: s.source, count: s.count })),
      },

      topology,

      /**
       * Check if evidence exists for this candidate.
       * @returns {boolean}
       */
      hasEvidence: () => history.length > 0,

      /**
       * Get the raw observation history (for debugging/inspection).
       * @returns {Array<Object>}
       */
      rawHistory: () => history,
    };
  }

  /**
   * Get evidence for multiple candidates in batch.
   *
   * @param {Array<{infoHash: string, fileIndex: number|null}>} candidates
   * @param {Object} [options]
   * @returns {Array<CorpusEvidence>}
   */
  function getEvidenceBatch(candidates, options = {}) {
    return candidates.map((c) => getEvidence(c.infoHash, c.fileIndex, options));
  }

  /**
   * Compare two candidates' evidence for relative ranking primitives.
   * Returns a comparison object, not a score.
   *
   * @param {string} infoHashA
   * @param {number|null} fileIndexA
   * @param {string} infoHashB
   * @param {number|null} fileIndexB
   * @param {Object} [options]
   * @returns {{
   *   a: CorpusEvidence,
   *   b: CorpusEvidence,
   *   persistenceDiffMs: number,
   *   freshnessDiffMs: number|null,
   *   observationCountDiff: number,
   *   sharedSources: Array<string>,
   * }}
   */
  function compareEvidence(infoHashA, fileIndexA, infoHashB, fileIndexB, options = {}) {
    const a = getEvidence(infoHashA, fileIndexA, options);
    const b = getEvidence(infoHashB, fileIndexB, options);

    const persistenceDiffMs = a.temporal.persistenceMs - b.temporal.persistenceMs;

    let freshnessDiffMs = null;
    if (a.temporal.freshnessMs != null && b.temporal.freshnessMs != null) {
      freshnessDiffMs = a.temporal.freshnessMs - b.temporal.freshnessMs;
    }

    const observationCountDiff = a.volume.observationCount - b.volume.observationCount;

    const sourcesA = new Set(a.sources.list);
    const sharedSources = b.sources.list.filter((s) => sourcesA.has(s));

    return {
      a,
      b,
      persistenceDiffMs,
      freshnessDiffMs,
      observationCountDiff,
      sharedSources,
    };
  }

  return {
    getEvidence,
    getEvidenceBatch,
    compareEvidence,
    evidence,  // Expose underlying evidence projection for direct access
  };
}

/**
 * @typedef {Object} CorpusEvidence
 * @property {string} infoHash
 * @property {number|null} fileIndex
 * @property {Object} temporal
 * @property {number|null} temporal.firstObserved
 * @property {number|null} temporal.lastObserved
 * @property {number} temporal.persistenceMs
 * @property {number|null} temporal.freshnessMs
 * @property {Object} volume
 * @property {number} volume.observationCount
 * @property {number} volume.versionCount
 * @property {number} volume.sourceCount
 * @property {Object} sources
 * @property {Array<string>} sources.list
 * @property {Array<{source: string, count: number}>} sources.counts
 * @property {Object} topology
 * @property {Function} topology.bySource
 * @property {Function} topology.byIngestion
 * @property {Function} topology.coObserved
 * @property {Function} hasEvidence
 * @property {Function} rawHistory
 */
