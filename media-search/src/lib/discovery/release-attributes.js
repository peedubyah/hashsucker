/**
 * Release Attributes Boundary
 *
 * Filename-derived attributes are evidence about a candidate's content,
 * separate from both candidate identity and media associations.
 *
 * Architectural contract:
 * - Release attributes are SEPARATE from candidates (different table)
 * - Release attributes are SEPARATE from candidate_media (different purpose)
 * - Release attributes are EVIDENCE, not identity
 * - Release attributes do NOT create provider observations
 * - Multiple parsers can contribute attributes
 * - Stronger confidence wins conflicts
 * - Attributes survive cache reload (persistent storage)
 *
 * Purpose:
 * - Store parsed filename metadata for ranking/display
 * - Support multiple enrichment sources with confidence comparison
 * - Enable future re-enrichment without data loss
 * - Provide structured data for UI filtering
 *
 * This module does NOT:
 * - Create media associations (use enrichment.js for that)
 * - Create provider observations (use cache.recordProviderObservation)
 * - Mutate candidate identity
 * - Implement actual parsing (that's a separate concern)
 */

/**
 * Store release attributes for a candidate.
 * Multiple parsers can contribute — stronger confidence wins on conflict.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} attributes - Parsed release attributes
 * @param {string} attributes.infoHash - Candidate infoHash
 * @param {number|null} attributes.fileIndex - Candidate fileIndex
 * @param {string} attributes.filename - Raw filename
 * @param {string} attributes.source - Parser source (e.g., 'ptn', 'guessit', 'custom')
 * @param {number} attributes.confidence - Parser confidence 0.0–1.0
 * @param {Object} attributes.parsed - Parsed fields
 * @param {string} [attributes.parsed.title] - Normalized title
 * @param {number} [attributes.parsed.year] - Release year
 * @param {string} [attributes.parsed.mediaType] - Media type guess (movie, episode, unknown)
 * @param {number} [attributes.parsed.season] - Season number
 * @param {number} [attributes.parsed.episode] - Episode number
 * @param {string} [attributes.parsed.episodeRange] - Episode range (e.g., "1-3")
 * @param {string} [attributes.parsed.resolution] - Resolution (e.g., "1080p", "2160p")
 * @param {string} [attributes.parsed.source] - Source (e.g., "WEB-DL", "BluRay")
 * @param {string} [attributes.parsed.codec] - Video codec (e.g., "x264", "x265") * @param {boolean} [attributes.parsed.hdr] - HDR flag * @param {string} [attributes.parsed.audio] - Audio format (e.g., "AAC", "DTS")
 * @param {string} [attributes.parsed.language] - Language (e.g., "en", "multi")
 * @param {string} [attributes.parsed.releaseGroup] - Release group name
 * @param {Array<string>} [attributes.evidence] - Evidence tags
 * @returns {boolean} True if attributes were stored (new or stronger)
 */
export function storeReleaseAttributes(cache, attributes) {
  if (!cache || !attributes) return false;

  const { infoHash, fileIndex = null, filename, source, confidence, parsed = {}, evidence = [] } = attributes;

  if (!infoHash || !filename || !source) return false;

  const normalizedConfidence = normalizeConfidence(confidence);

  // Check for existing attributes from same source.
  // Equal confidence → latest wins (update allowed).
  // Only skip if existing is strictly stronger.
  const existing = cache.getReleaseAttributes(infoHash, fileIndex, source);
  if (existing && existing.length > 0 && existing[0].confidence > normalizedConfidence) {
    // Existing attributes are strictly stronger — preserve them
    return false;
  }

  cache._insertReleaseAttributes({
    infoHash,
    fileIndex,
    filename,
    source,
    confidence: normalizedConfidence,
    title: parsed.title ?? null,
    year: parsed.year ?? null,
    mediaType: parsed.mediaType ?? null,
    season: parsed.season ?? null,
    episode: parsed.episode ?? null,
    episodeRange: parsed.episodeRange ?? null,
    resolution: parsed.resolution ?? null,
    sourceType: parsed.source ?? null,
    codec: parsed.codec ?? null,
    hdr: parsed.hdr ?? null,
    audio: parsed.audio ?? null,
    language: parsed.language ?? null,
    releaseGroup: parsed.releaseGroup ?? null,
    evidence: Array.isArray(evidence) ? evidence : (evidence ? [evidence] : []),
    parsedAt: Date.now(),
  });

  return true;
}

/**
 * Store multiple release attributes from different sources.
 * Each source is evaluated independently — stronger confidence wins per source.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Array<Object>} attributesList - Array of attribute objects
 * @returns {number} Number of attributes stored (new or stronger)
 */
export function storeReleaseAttributesBatch(cache, attributesList) {
  if (!cache || !Array.isArray(attributesList)) return 0;

  let stored = 0;
  for (const attributes of attributesList) {
    if (storeReleaseAttributes(cache, attributes)) {
      stored++;
    }
  }
  return stored;
}

/**
 * Get all release attributes for a candidate.
 * Returns attributes from all sources, sorted by confidence descending.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {string} infoHash - Candidate infoHash
 * @param {number|null} fileIndex - Candidate fileIndex
 * @returns {Array<Object>} Release attributes from all sources
 */
export function getReleaseAttributesForCandidate(cache, infoHash, fileIndex = null) {
  if (!cache) return [];
  const attributes = cache.getReleaseAttributes(infoHash, fileIndex);
  // Sort by confidence descending (strongest first)
  return attributes.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Get release attributes from a specific source.
 * Since source is part of the primary key, returns at most one result.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {string} infoHash - Candidate infoHash
 * @param {number|null} fileIndex - Candidate fileIndex
 * @param {string} source - Parser source
 * @returns {Object|null} Release attributes or null
 */
export function getReleaseAttributesBySource(cache, infoHash, fileIndex = null, source) {
  if (!cache || !source) return null;
  const results = cache.getReleaseAttributes(infoHash, fileIndex, source);
  return results.length > 0 ? results[0] : null;
}

/**
 * Get the strongest release attributes for a candidate.
 * Returns the highest-confidence attributes across all sources.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {string} infoHash - Candidate infoHash
 * @param {number|null} fileIndex - Candidate fileIndex
 * @returns {Object|null} Strongest release attributes or null
 */
export function getStrongestReleaseAttributes(cache, infoHash, fileIndex = null) {
  const attributes = getReleaseAttributesForCandidate(cache, infoHash, fileIndex);
  return attributes.length > 0 ? attributes[0] : null;
}

/**
 * Check if a candidate has any release attributes.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {string} infoHash - Candidate infoHash
 * @param {number|null} fileIndex - Candidate fileIndex
 * @returns {boolean} True if any attributes exist
 */
export function hasReleaseAttributes(cache, infoHash, fileIndex = null) {
  if (!cache) return false;
  const attributes = cache.getReleaseAttributes(infoHash, fileIndex);
  return attributes.length > 0;
}

/**
 * Get candidates that have no release attributes.
 * Useful for finding candidates that need filename parsing.
 *
 * @param {Object} cache - Discovery cache instance
 * @returns {Array<Object>} Candidates without release attributes
 */
export function getCandidatesWithoutAttributes(cache) {
  if (!cache) return [];
  return cache.getCandidatesWithoutReleaseAttributes();
}

/**
 * Merge release attributes from multiple sources.
 * For each field, the value from the highest-confidence source wins.
 *
 * @param {Array<Object>} attributesList - Release attributes from multiple sources
 * @returns {Object} Merged attributes with source attribution
 */
export function mergeReleaseAttributes(attributesList) {
  if (!Array.isArray(attributesList) || attributesList.length === 0) {
    return null;
  }

  // Sort by confidence descending
  const sorted = [...attributesList].sort((a, b) => b.confidence - a.confidence);

  const merged = {
    title: null,
    year: null,
    mediaType: null,
    season: null,
    episode: null,
    episodeRange: null,
    resolution: null,
    sourceType: null,
    codec: null,
    hdr: null,
    audio: null,
    language: null,
    releaseGroup: null,
    sources: [],
  };

  const fields = [
    'title', 'year', 'mediaType', 'season', 'episode', 'episodeRange',
    'resolution', 'sourceType', 'codec', 'hdr', 'audio', 'language', 'releaseGroup'
  ];

  for (const attr of sorted) {
    merged.sources.push({
      source: attr.source,
      confidence: attr.confidence,
      filename: attr.filename,
    });

    for (const field of fields) {
      if (merged[field] == null && attr[field] != null) {
        merged[field] = attr[field];
      }
    }
  }

  return merged;
}

/**
 * Normalize confidence to [0.0, 1.0] range.
 *
 * @param {number} confidence - Raw confidence value
 * @returns {number} Normalized confidence
 */
function normalizeConfidence(confidence) {
  if (confidence == null || typeof confidence !== 'number' || isNaN(confidence)) {
    return 0.5;
  }
  return Math.max(0.0, Math.min(1.0, confidence));
}

/**
 * Validate a release attributes object.
 * Returns { valid: boolean, errors: string[] }.
 *
 * @param {Object} attributes - Release attributes to validate
 * @returns {Object} Validation result
 */
export function validateReleaseAttributes(attributes) {
  const errors = [];

  if (!attributes) {
    return { valid: false, errors: ['attributes is required'] };
  }

  if (!attributes.infoHash) {
    errors.push('infoHash is required');
  }

  if (!attributes.filename) {
    errors.push('filename is required');
  }

  if (!attributes.source) {
    errors.push('source is required');
  }

  if (attributes.confidence != null) {
    if (typeof attributes.confidence !== 'number' || isNaN(attributes.confidence)) {
      errors.push('confidence must be a number');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
