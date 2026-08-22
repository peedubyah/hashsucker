/**
 * Pure Ranking Module
 *
 * Computes composite ranking scores from evidence inputs.
 * This module is pure — it does NOT:
 * - Call external APIs
 * - Know about specific providers (TorBox, RD, Torrentio, etc.)
 * - Mutate any storage
 * - Perform I/O
 *
 * Inputs are plain values; outputs are plain values.
 *
 * Ranking Contract:
 *   score = relevance × 0.25
 *         + quality × 0.20
 *         + releaseConfidence × 0.20
 *         + identityConfidence × 0.15
 *         + providerAvailability × 0.10
 *         + episodeMatch × 0.10
 *
 * All components are normalized to [0.0, 1.0].
 */

// Quality tiers for resolution
const RESOLUTION_QUALITY = {
  '2160p': 1.0,
  '1080p': 0.9,
  '720p': 0.7,
  '480p': 0.4,
  '360p': 0.2,
};

// Quality tiers for source type
const SOURCE_QUALITY = {
  'Remux': 1.0,
  'BluRay': 0.95,
  'WEB-DL': 0.85,
  'WEBRip': 0.75,
  'HDTV': 0.6,
  'DSRip': 0.5,
  'DVD': 0.4,
};

// Codec bonus (HEVC/x265 preferred for 4K)
const CODEC_BONUS = {
  'x265': 0.1,
  'x264': 0.05,
};

// Weights for composite score
const WEIGHTS = {
  relevance: 0.25,
  quality: 0.20,
  releaseConfidence: 0.20,
  identityConfidence: 0.15,
  providerAvailability: 0.10,
  episodeMatch: 0.10,
};

// Neutral value for unknown/missing data (not a penalty)
const NEUTRAL = 0.5;

/**
 * Compute quality score from release attributes.
 *
 * @param {Object} attrs - Release attributes
 * @param {string} [attrs.resolution] - Resolution (e.g., '1080p')
 * @param {string} [attrs.sourceType] - Source type (e.g., 'BluRay')
 * @param {string} [attrs.codec] - Codec (e.g., 'x264', 'x265')
 * @param {boolean} [attrs.hdr] - HDR flag
 * @returns {number} 0.0-1.0
 */
export function qualityScore(attrs = {}) {
  let score = 0;

  // Resolution contributes 40%
  const resScore = RESOLUTION_QUALITY[attrs.resolution] || 0;
  score += resScore * 0.4;

  // Source contributes 30%
  const srcScore = SOURCE_QUALITY[attrs.sourceType] || 0;
  score += srcScore * 0.3;

  // Codec bonus (up to 15%)
  const codecBonus = CODEC_BONUS[attrs.codec] || 0;
  score += codecBonus;

  // HDR bonus (up to 15%)
  if (attrs.hdr) score += 0.15;

  return Math.min(1.0, score);
}

/**
 * Compute identity confidence from media associations.
 *
 * @param {Array<Object>} mediaAssociations - From candidate_media
 * @returns {number} 0.0-1.0 (NEUTRAL if no associations)
 */
export function identityConfidenceScore(mediaAssociations = []) {
  if (mediaAssociations.length === 0) return NEUTRAL;

  // Use the highest confidence association
  const maxConfidence = Math.max(...mediaAssociations.map(a => a.confidence || 0));
  return Math.min(1.0, maxConfidence);
}

/**
 * Compute identity confidence scoped to a specific media ID.
 *
 * For selected-media retrieval, identity confidence must come only from
 * the association to the selected media. Associations to other media
 * are never eligible and must not contribute to confidence.
 *
 * @param {Array<Object>} mediaAssociations - From candidate_media
 * @param {string} mediaId - Selected media ID to scope to
 * @returns {number} 0.0-1.0 (NEUTRAL if no association to this media)
 */
export function identityConfidenceForMedia(mediaAssociations = [], mediaId) {
  if (!mediaId || mediaAssociations.length === 0) return NEUTRAL;

  const forMedia = mediaAssociations.filter(a => a.mediaId === mediaId);
  if (forMedia.length === 0) return NEUTRAL;

  const maxConfidence = Math.max(...forMedia.map(a => a.confidence || 0));
  return Math.min(1.0, maxConfidence);
}

/**
 * Compute provider availability score from observations.
 *
 * Unknown state (no observations) is NEUTRAL, not a penalty.
 *
 * @param {Array<Object>} providerObservations - From provider_observations
 * @returns {number} 0.0-1.0 (NEUTRAL if no observations)
 */
export function providerAvailabilityScore(providerObservations = []) {
  if (providerObservations.length === 0) return NEUTRAL;

  const cached = providerObservations.filter(o => o.cached === true || o.cached === 1);
  const uncached = providerObservations.filter(o => o.cached === false || o.cached === 0);

  // All cached = 1.0, all uncached = 0.0, mixed = proportional
  const total = providerObservations.length;
  if (cached.length === total) return 1.0;
  if (uncached.length === total) return 0.0;
  return cached.length / total;
}

/**
 * Compute episode match bonus.
 *
 * Only applies when the query specifies season/episode and the release matches.
 *
 * @param {Object} releaseAttrs - Release attributes
 * @param {number} [releaseAttrs.season] - Release season
 * @param {number} [releaseAttrs.episode] - Release episode
 * @param {Object} [queryIntent] - Query intent (optional)
 * @param {number} [queryIntent.season] - Query season
 * @param {number} [queryIntent.episode] - Query episode
 * @returns {number} 0.0-1.0
 */
export function episodeMatchScore(releaseAttrs = {}, queryIntent = {}) {
  // Only score if query has season/episode
  if (queryIntent.season == null || queryIntent.episode == null) return NEUTRAL;

  const seasonMatch = releaseAttrs.season != null && releaseAttrs.season === queryIntent.season;
  const episodeMatch = releaseAttrs.episode != null && releaseAttrs.episode === queryIntent.episode;

  if (seasonMatch && episodeMatch) return 1.0;
  if (seasonMatch) return 0.5;  // Right season, wrong episode
  return 0.0;  // Wrong season
}

/**
 * Rank a single search hit.
 *
 * @param {Object} hit - Search hit with evidence
 * @param {string} hit.hash - InfoHash
 * @param {number|null} hit.fileIndex - File index
 * @param {string} hit.filename - Release filename
 * @param {number} hit.relevance - Title relevance from search (0.0-1.0)
 * @param {Object} [hit.releaseAttributes] - Parsed release attributes
 * @param {number} [hit.parserConfidence] - Parser confidence (0.0-1.0)
 * @param {Array<Object>} [hit.mediaAssociations] - Media associations
 * @param {Array<Object>} [hit.providerObservations] - Provider observations
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping.
 *   When provided, identity confidence uses only the association to this media.
 * @returns {Object} Ranked result with component scores
 */
export function rankHit(hit, queryIntent = {}, mediaId = null) {
  const {
    hash,
    fileIndex = null,
    filename,
    relevance = 0,
    releaseAttributes = {},
    parserConfidence = NEUTRAL,
    mediaAssociations = [],
    providerObservations = [],
  } = hit;

  // Compute component scores
  const quality = qualityScore(releaseAttributes);
  const releaseConfidence = Math.min(1.0, Math.max(0.0, parserConfidence));
  // When mediaId is provided, scope identity confidence to that association.
  // This prevents cross-title identity leakage.
  const identityConfidence = mediaId
    ? identityConfidenceForMedia(mediaAssociations, mediaId)
    : identityConfidenceScore(mediaAssociations);
  const providerAvailability = providerAvailabilityScore(providerObservations);
  const episodeMatch = episodeMatchScore(releaseAttributes, queryIntent);

  // Compute weighted composite score
  const score = (
    relevance * WEIGHTS.relevance +
    quality * WEIGHTS.quality +
    releaseConfidence * WEIGHTS.releaseConfidence +
    identityConfidence * WEIGHTS.identityConfidence +
    providerAvailability * WEIGHTS.providerAvailability +
    episodeMatch * WEIGHTS.episodeMatch
  );

  return {
    hash,
    fileIndex,
    filename,
    score: Math.round(score * 1000) / 1000,
    components: {
      relevance: Math.round(relevance * 1000) / 1000,
      quality: Math.round(quality * 1000) / 1000,
      releaseConfidence: Math.round(releaseConfidence * 1000) / 1000,
      identityConfidence: Math.round(identityConfidence * 1000) / 1000,
      providerAvailability: Math.round(providerAvailability * 1000) / 1000,
      episodeMatch: Math.round(episodeMatch * 1000) / 1000,
    },
    releaseAttributes,
    mediaAssociations,
    providerObservations,
  };
}

/**
 * Rank multiple search hits.
 *
 * @param {Array<Object>} hits - Search hits
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping
 * @returns {Array<Object>} Ranked results sorted by score descending
 */
export function rankHits(hits, queryIntent = {}, mediaId = null) {
  const ranked = hits.map(hit => rankHit(hit, queryIntent, mediaId));
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Get the default weights (for inspection/tuning).
 *
 * @returns {Object} Weight configuration
 */
export function getWeights() {
  return { ...WEIGHTS };
}
