/**
 * Corpus Evidence Bundle Projection
 *
 * Pure read-only projection layer that combines existing corpus evidence
 * features into a single normalized candidate evidence contract.
 *
 * Purpose:
 *   Provides a unified view of all available evidence for a candidate
 *   identity, composing persistence, topology, and confidence projections
 *   into a single deterministic bundle.
 *
 *   This is NOT acquisition. It is a normalized evidence contract that
 *   future acquisition, materialization, and repair layers can consume.
 *
 * Evidence sources:
 *   - persistence: corpus version history (survival rate, churn, presence)
 *   - topology: torrent/file structure (playable targets, samples, extras)
 *   - confidence: weighted combination of persistence, topology, metadata
 *   - release: parsed release attributes (media_type, resolution, codec, etc.)
 *
 * Contract:
 *   - No schema additions — pure query over existing tables
 *   - No UPDATE/DELETE on any table
 *   - No access to provider observations or acquisition logic
 *   - No writes to any table
 *   - Deterministic output
 *   - Safe when no evidence exists
 *   - Composes existing projections instead of duplicating logic
 */

import { createCorpusPersistenceFeatures } from './corpus-persistence-features.js';
import { createCorpusTopologyFeatures } from './corpus-topology-features.js';
import { createCorpusConfidenceFeatures } from './corpus-confidence-features.js';

/**
 * Create a corpus evidence bundle projection.
 *
 * @param {Object} options
 * @param {Object} options.cache - Discovery cache instance
 * @param {Object} options.versions - Corpus version registry
 * @returns {Object} Corpus evidence bundle projection interface
 */
export function createCorpusEvidenceBundle({ cache, versions }) {
  if (!cache) throw new Error('Corpus evidence bundle requires a cache');
  if (!versions) throw new Error('Corpus evidence bundle requires a version registry');

  const persistence = createCorpusPersistenceFeatures(versions);
  const topology = createCorpusTopologyFeatures(cache);
  const confidence = createCorpusConfidenceFeatures({ cache, versions });

  /**
     * Get a complete evidence bundle for a candidate identity.
     *
     * Composes persistence, topology, and confidence projections into a
     * single normalized contract with release attributes and risk summary.
     *
     * @param {Object} params
     * @param {string} params.infoHash
     * @param {number|null} [params.fileIndex]
     * @param {string} [params.corpusSource='dmm']
     * @returns {{
     *   identity: { infoHash: string, fileIndex: number|null },
     *   release: { attributes: Array, count: number },
     *   persistence: {
     *     temporal: { firstObserved: number|null, lastObserved: number|null, ageMs: number|null },
     *     persistence: { versionsObserved: number, versionsAvailable: number, survivalRate: number|null },
     *     lifecycle: { currentlyPresent: boolean, addedCount: number, removedCount: number, churnCount: number },
     *   },
     *   topology: {
     *     files: { totalFiles: number, mediaFiles: number, nonMediaFiles: number, videoFiles: number, subtitleFiles: number, archiveFiles: number },
     *     structure: { singleFileMedia: boolean, hasExtras: boolean, hasSamples: boolean, hasSeasonStructure: boolean, largestFileRatio: number|null },
     *     quality: { likelyPlayableTarget: boolean, topologyConfidence: number|null, warnings: string[] },
     *   },
     *   confidence: {
     *     overall: number,
     *   },
     *   risks: string[],
     *   evidenceQuality: {
     *     hasPersistenceHistory: boolean,
     *     hasTopologyData: boolean,
     *     hasReleaseAttributes: boolean,
     *     persistenceVersionsObserved: number,
     *     topologyTotalFiles: number,
     *     releaseAttributeCount: number,
     *   },
     * }}
     */
  function getEvidenceBundle({ infoHash, fileIndex = null, corpusSource = 'dmm' }) {
    if (!infoHash) throw new Error('getEvidenceBundle requires infoHash');

    // Compose all evidence layers
    const persistenceFeatures = persistence.getPersistenceFeatures(infoHash, fileIndex, corpusSource);
    const topologyFeatures = topology.getTopologyFeatures(infoHash, fileIndex);
    const confidenceFeatures = confidence.getCandidateConfidenceFeatures({ infoHash, fileIndex, corpusSource });

    // Gather release attributes for this info_hash
    const releaseAttributes = getReleaseAttributes(cache, infoHash);

    // Compute evidence quality summary
    const evidenceQuality = {
      hasPersistenceHistory: persistenceFeatures.persistence.versionsAvailable > 0,
      hasTopologyData: topologyFeatures.files.totalFiles > 0,
      hasReleaseAttributes: releaseAttributes.length > 0,
      persistenceVersionsObserved: persistenceFeatures.persistence.versionsObserved,
      topologyTotalFiles: topologyFeatures.files.totalFiles,
      releaseAttributeCount: releaseAttributes.length,
    };

    // Collect all risks from all evidence layers
    const risks = collectAllRisks(persistenceFeatures, topologyFeatures, confidenceFeatures);

    return {
      identity: {
        infoHash,
        fileIndex,
      },
      release: {
        attributes: releaseAttributes,
        count: releaseAttributes.length,
      },
      persistence: {
        temporal: persistenceFeatures.temporal,
        persistence: persistenceFeatures.persistence,
        lifecycle: persistenceFeatures.lifecycle,
      },
      topology: {
        files: topologyFeatures.files,
        structure: topologyFeatures.structure,
        quality: topologyFeatures.quality,
      },
      confidence: {
        overall: confidenceFeatures.confidence.overall,
      },
      risks,
      evidenceQuality,
    };
  }

  /**
   * Get all release attributes for an info_hash across all file indexes.
   *
   * @param {Object} cache
   * @param {string} infoHash
   * @returns {Array}
   */
  function getReleaseAttributes(cache, infoHash) {
    const rows = cache.db.prepare(`
      SELECT info_hash, file_index_key, source, filename, confidence,
             media_type, season, episode, resolution, codec, audio,
             source_type, release_group, language, title, hdr, parsed_at
      FROM release_attributes
      WHERE info_hash = @info_hash
      ORDER BY file_index_key;
    `).all({ info_hash: infoHash });
    return rows;
  }

  /**
   * Collect all risks from all evidence layers.
   *
   * @param {Object} persistenceFeatures
   * @param {Object} topologyFeatures
   * @param {Object} confidenceFeatures
   * @returns {string[]}
   */
  function collectAllRisks(persistenceFeatures, topologyFeatures, confidenceFeatures) {
    const risks = [];

    // Persistence risks
    const persistence = persistenceFeatures.persistence;
    const lifecycle = persistenceFeatures.lifecycle;

    if (persistence.survivalRate != null && persistence.survivalRate < 0.5) {
      risks.push('corpus_not_persistent');
    }

    if (lifecycle.currentlyPresent === false && persistence.versionsObserved > 0) {
      risks.push('no_longer_in_corpus');
    }

    if (lifecycle.churnCount > 2) {
      risks.push('high_churn');
    }

    // Topology risks
    const structure = topologyFeatures.structure;
    const quality = topologyFeatures.quality;
    const files = topologyFeatures.files;

    if (files.totalFiles === 0) {
      risks.push('no_files');
    }

    if (structure.hasSamples) {
      risks.push('sample_present');
    }

    if (files.videoFiles > 1) {
      risks.push('multiple_video_candidates');
    }

    if (quality.topologyConfidence != null && quality.topologyConfidence < 0.4) {
      risks.push('low_topology_confidence');
    }

    if (quality.topologyConfidence == null && files.totalFiles > 0) {
      risks.push('unknown_topology_quality');
    }

    // Confidence risks
    const warnings = confidenceFeatures.warnings || [];
    for (const warning of warnings) {
      if (!risks.includes(warning)) {
        risks.push(warning);
      }
    }

    return risks;
  }

  return {
    getEvidenceBundle,
  };
}
