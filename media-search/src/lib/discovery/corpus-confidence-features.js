/**
 * Corpus Confidence Feature Projection
 *
 * Pure read-only confidence projection combining persistence, topology,
 * and metadata evidence into a normalized acquisition confidence view.
 *
 * Purpose:
 *   Answers "Given everything we know about this candidate, how confident
 *   are we that this identity represents the intended playable media object?"
 *
 *   This is NOT an acquisition decision. It is a normalized confidence
 *   view that future materialization, repair, and acquisition
 *   observability can consume.
 *
 * Evidence sources:
 *   - persistence: corpus version history (survival rate, churn, presence)
 *   - topology: torrent/file structure (playable targets, samples, extras)
 *   - metadata: parsed release attributes (media_type, resolution, codec, etc.)
 *
 * Confidence model:
 *   overall = persistence * 0.40 + topology * 0.40 + metadata * 0.20
 *
 *   - persistence: survival rate, current presence, version observations
 *   - topology: playable target, file composition, warnings
 *   - metadata: presence and completeness of parsed release attributes
 *
 * Contract:
 *   - No schema additions — pure query over existing tables
 *   - No UPDATE/DELETE on any table
 *   - No access to provider observations or acquisition logic
 *   - No writes to any table
 *   - Deterministic output
 *   - Safe when no evidence exists
 *   - No ML, no learned scoring
 */

import { createCorpusPersistenceFeatures } from './corpus-persistence-features.js';
import { createCorpusTopologyFeatures } from './corpus-topology-features.js';

// Confidence component weights (must sum to 1.0)
const PERSISTENCE_WEIGHT = 0.40;
const TOPOLOGY_WEIGHT = 0.40;
const METADATA_WEIGHT = 0.20;

// Metadata fields that contribute to confidence
const METADATA_FIELDS = [
  'media_type',
  'resolution',
  'codec',
  'audio',
  'source_type',
  'release_group',
  'language',
];

/**
 * Compute persistence confidence from persistence features.
 *
 * Returns a value between 0 and 1.
 * - High when survival rate is high and candidate is currently present
 * - Low when no persistence history exists
 */
function computePersistenceConfidence(persistence, lifecycle) {
  // No persistence data available
  if (persistence.survivalRate == null) {
    return 0.1;
  }

  let confidence = 0.0;

  // Survival rate: primary signal (0-1)
  confidence += persistence.survivalRate * 0.60;

  // Currently present: strong positive signal
  if (lifecycle.currentlyPresent) {
    confidence += 0.25;
  }

  // Versions observed: diminishing returns after 5
  const versionFactor = Math.min(persistence.versionsObserved / 5, 1);
  confidence += versionFactor * 0.15;

  return roundConfidence(confidence);
}

/**
 * Compute topology confidence from topology features.
 *
 * Returns a value between 0 and 1.
 * - High when we have a likely playable target and clean structure
 * - Lower when samples detected or multiple ambiguous video files
 */
function computeTopologyConfidence(topology) {
  const quality = topology.quality;
  const structure = topology.structure;
  const files = topology.files;

  // No topology data
  if (quality.topologyConfidence == null) {
    return 0.2;
  }

  let confidence = quality.topologyConfidence;

  // Likely playable target bonus
  if (quality.likelyPlayableTarget) {
    confidence += 0.15;
  }

  // Sample penalty
  if (structure.hasSamples) {
    confidence -= 0.30;
  }

  // Multiple video files penalty (ambiguous target)
  if (files.videoFiles > 1) {
    confidence -= 0.10;
  }

  // Mostly non-media penalty
  if (files.totalFiles > 0 && files.nonMediaFiles > files.totalFiles * 0.5) {
    confidence -= 0.10;
  }

  return roundConfidence(Math.max(0, Math.min(confidence, 1.0)));
}

/**
 * Compute metadata confidence from release attributes.
 *
 * Returns a value between 0 and 1 based on how many metadata fields
 * are populated across all release attribute rows for this candidate.
 */
function computeMetadataConfidence(releaseAttributes) {
  if (!releaseAttributes || releaseAttributes.length === 0) {
    return 0.0;
  }

  // Collect all populated fields across all attribute rows
  const populatedFields = new Set();
  for (const attr of releaseAttributes) {
    for (const field of METADATA_FIELDS) {
      if (attr[field] != null && attr[field] !== '') {
        populatedFields.add(field);
      }
    }
  }

  const score = populatedFields.size / METADATA_FIELDS.length;
  return roundConfidence(score);
}

/**
 * Round confidence to 4 decimal places to avoid floating point noise.
 */
function roundConfidence(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Collect deterministic warnings based on all evidence.
 *
 * Only emits warnings supported by existing evidence:
 * - corpus_not_persistent: survivalRate < 0.5
 * - sample_present: topology has samples
 * - multiple_video_candidates: more than 1 video file
 * - low_topology_confidence: topologyConfidence < 0.4
 * - no_files: topology has no files
 * - missing_metadata: no release attributes found
 */
function collectWarnings(persistenceFeatures, topologyFeatures, releaseAttributes) {
  const warnings = [];
  const persistence = persistenceFeatures.persistence;
  const lifecycle = persistenceFeatures.lifecycle;
  const structure = topologyFeatures.structure;
  const quality = topologyFeatures.quality;
  const files = topologyFeatures.files;

  // Persistence warnings
  if (persistence.survivalRate != null && persistence.survivalRate < 0.5) {
    warnings.push('corpus_not_persistent');
  }

  // Topology warnings
  if (structure.hasSamples) {
    warnings.push('sample_present');
  }

  if (files.videoFiles > 1) {
    warnings.push('multiple_video_candidates');
  }

  if (quality.topologyConfidence != null && quality.topologyConfidence < 0.4) {
    warnings.push('low_topology_confidence');
  }

  if (files.totalFiles === 0) {
    warnings.push('no_files');
  }

  // Metadata warnings
  if (!releaseAttributes || releaseAttributes.length === 0) {
    warnings.push('missing_metadata');
  }

  return warnings;
}

/**
 * Get release attributes for a candidate's entire torrent (all file indexes).
 */
function getReleaseAttributes(cache, infoHash) {
  const rows = cache.db.prepare(`
    SELECT info_hash, file_index_key, media_type, season, episode, resolution,
           source_type, codec, audio, language, release_group, hdr
    FROM release_attributes
    WHERE info_hash = @info_hash
    ORDER BY file_index_key;
  `).all({ info_hash: infoHash });

  return rows;
}

/**
 * Create a corpus confidence feature projection.
 *
 * @param {Object} options
 * @param {Object} options.cache - Discovery cache instance
 * @param {Object} options.versions - Corpus version registry
 * @returns {Object} Corpus confidence feature projection interface
 */
export function createCorpusConfidenceFeatures({ cache, versions }) {
  if (!cache) throw new Error('Corpus confidence features require a cache');
  if (!versions) throw new Error('Corpus confidence features require a version registry');

  const persistence = createCorpusPersistenceFeatures(versions);
  const topology = createCorpusTopologyFeatures(cache);

  /**
   * Get confidence features for a candidate identity.
   *
   * @param {Object} params
   * @param {string} params.corpusSource - Source identifier (default: 'dmm')
   * @param {string} params.infoHash - Torrent info hash
   * @param {number|null} [params.fileIndex] - File index within torrent
   * @returns {{
   *   identity: { infoHash: string, fileIndex: number, fileIndexKey: number },
   *   evidence: { persistence: Object, topology: Object, metadata: Object },
   *   confidence: { overall: number, components: { persistence: number, topology: number, metadata: number } },
   *   warnings: string[],
   * }}
   */
  function getCandidateConfidenceFeatures({ corpusSource = 'dmm', infoHash, fileIndex }) {
    if (!infoHash) throw new Error('getCandidateConfidenceFeatures requires infoHash');

    const fileIndexKey = fileIndex == null ? -1 : fileIndex;

    // Gather evidence from all three sources
    const persistenceFeatures = persistence.getPersistenceFeatures(infoHash, fileIndex, corpusSource);
    const topologyFeatures = topology.getTopologyFeatures(infoHash, fileIndex);
    const releaseAttrs = getReleaseAttributes(cache, infoHash);

    // Compute component confidences
    const persistenceConfidence = computePersistenceConfidence(
      persistenceFeatures.persistence,
      persistenceFeatures.lifecycle,
    );
    const topologyConfidence = computeTopologyConfidence(topologyFeatures);
    const metadataConfidence = computeMetadataConfidence(releaseAttrs);

    // Weighted overall confidence
    const overall = roundConfidence(
      persistenceConfidence * PERSISTENCE_WEIGHT +
      topologyConfidence * TOPOLOGY_WEIGHT +
      metadataConfidence * METADATA_WEIGHT,
    );

    // Collect warnings
    const warnings = collectWarnings(persistenceFeatures, topologyFeatures, releaseAttrs);

    return {
      identity: {
        infoHash,
        fileIndex,
        fileIndexKey,
      },
      evidence: {
        persistence: persistenceFeatures,
        topology: topologyFeatures,
        metadata: {
          releaseAttributes: releaseAttrs,
        },
      },
      confidence: {
        overall,
        components: {
          persistence: persistenceConfidence,
          topology: topologyConfidence,
          metadata: metadataConfidence,
        },
      },
      warnings,
    };
  }

  return {
    getCandidateConfidenceFeatures,
  };
}
