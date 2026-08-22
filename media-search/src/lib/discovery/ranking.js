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
 */

import { parseEpisodeRange } from './episode-coverage.js';

/**
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
 * Compute episode match preference among ALREADY-ELIGIBLE candidates.
 *
 * Hard coverage eligibility (wrong season, wrong episode, out-of-range,
 * unknown coverage) is enforced by the episode-coverage gate BEFORE scoring
 * and must not be duplicated here. This function expresses preference tiers
 * among candidates that provably cover the requested episode:
 *
 *   - Exact single-episode match (season+episode)  → 1.0
 *   - Episode range containing the requested E     → 0.8
 *   - Season pack for the requested season         → 0.6
 *
 * When the query has no explicit season/episode intent, returns NEUTRAL.
 *
 * @param {Object} releaseAttrs - Release attributes
 * @param {number} [releaseAttrs.season] - Release season
 * @param {number} [releaseAttrs.episode] - Release episode
 * @param {string} [releaseAttrs.episodeRange] - Release episode range "start-end"
 * @param {boolean} [releaseAttrs.seasonOnly] - Parser-flagged season pack
 * @param {string} [releaseAttrs.mediaType] - Parser media type guess
 * @param {Object} [queryIntent] - Query intent (optional)
 * @param {number} [queryIntent.season] - Query season
 * @param {number} [queryIntent.episode] - Query episode
 * @returns {number} 0.0-1.0
 */
export function episodeMatchScore(releaseAttrs = {}, queryIntent = {}) {
  // Only score if query has explicit season/episode intent
  if (queryIntent.season == null || queryIntent.episode == null) return NEUTRAL;

  const { season, episode, episodeRange, seasonOnly, mediaType } = releaseAttrs;

  // Wrong season — defensive; hard gate should have rejected already.
  if (season == null || season !== queryIntent.season) return 0.0;

  // Exact single-episode match
  if (episode != null && episode === queryIntent.episode) return 1.0;

  // Episode range containing requested episode
  if (episodeRange != null) {
    const range = parseEpisodeRange(episodeRange);
    if (range && queryIntent.episode >= range.start && queryIntent.episode <= range.end) {
      return 0.8;
    }
    // Malformed or non-covering range — defensive low score
    return 0.0;
  }

  // Season pack for correct season
  if (seasonOnly === true || mediaType === 'season') return 0.6;

  // Correct season but no episode/range/pack evidence — unknown coverage
  return 0.0;
}

/**
 * Rank a single search hit.
 *
 * Preserves provenance (sources, selectedMediaId) through the ranking boundary
 * so that merged local/live evidence survives into the final ranked result.
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
 * @param {Array<Object>} [hit.sources] - Provenance sources for evidence
 * @param {string|null} [hit.selectedMediaId] - Selected media intent provenance
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
    sources = [],
    selectedMediaId = null,
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
    sources,
    selectedMediaId,
  };
}

/**
 * Rank multiple search hits.
 *
 * Uses deterministic tie-breakers so repeated identical input yields identical
 * order. Tie-breaking precedence:
 * 1. Higher composite score wins
 * 2. Higher releaseConfidence wins (parser evidence strength)
 * 3. Higher quality wins (resolution/source evidence)
 * 4. Higher relevance wins (title match strength)
 * 5. Lower hash string wins (deterministic, content-derived)
 * 6. Lower fileIndex wins (null sorts after 0)
 *
 * @param {Array<Object>} hits - Search hits
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping
 * @returns {Array<Object>} Ranked results sorted by score descending
 */
export function rankHits(hits, queryIntent = {}, mediaId = null) {
  const ranked = hits.map(hit => rankHit(hit, queryIntent, mediaId));
  ranked.sort((a, b) => {
    // Primary: composite score (higher wins)
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break 1: releaseConfidence (higher wins)
    const aConf = a.components?.releaseConfidence ?? 0;
    const bConf = b.components?.releaseConfidence ?? 0;
    if (bConf !== aConf) return bConf - aConf;
    // Tie-break 2: quality (higher wins)
    const aQual = a.components?.quality ?? 0;
    const bQual = b.components?.quality ?? 0;
    if (bQual !== aQual) return bQual - aQual;
    // Tie-break 3: relevance (higher wins)
    const aRel = a.components?.relevance ?? 0;
    const bRel = b.components?.relevance ?? 0;
    if (bRel !== aRel) return bRel - aRel;
    // Tie-break 4: hash (lexicographic, lower wins — deterministic)
    if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
    // Tie-break 5: fileIndex (lower wins, null sorts after 0)
    const aIdx = a.fileIndex ?? Number.MAX_SAFE_INTEGER;
    const bIdx = b.fileIndex ?? Number.MAX_SAFE_INTEGER;
    return aIdx - bIdx;
  });
  return ranked;
}

/**
 * Explain a ranked result.
 *
 * Derives a deterministic explanation from the SAME component values that
 * rankHit() used. Does NOT duplicate ranking calculations — it reads the
 * components already computed by rankHit().
 *
 * Provider hints (non-authoritative) are never described as confirmed
 * provider availability. Only authoritative providerObservations contribute
 * to the providerAvailability component.
 *
 * @param {Object} ranked - Output of rankHit()
 * @param {number} ranked.score - Composite score
 * @param {Object} ranked.components - Component scores (relevance, quality, releaseConfidence, identityConfidence, providerAvailability, episodeMatch)
 * @param {string} ranked.hash - InfoHash
 * @param {number|null} ranked.fileIndex - File index
 * @param {string} ranked.filename - Release filename
 * @param {Object} [ranked.releaseAttributes] - Parsed release attributes
 * @param {Array<Object>} [ranked.mediaAssociations] - Media associations
 * @param {Array<Object>} [ranked.providerObservations] - Provider observations
 * @param {Array<Object>} [ranked.sources] - Provenance sources
 * @param {string|null} [ranked.selectedMediaId] - Selected media intent provenance
 * @returns {Object} Deterministic explanation
 */
export function explainRank(ranked) {
  const components = ranked.components || {};
  const weights = WEIGHTS;

  // Weighted contributions (what actually determined the score)
  const contributions = {
    relevance: components.relevance * weights.relevance,
    quality: components.quality * weights.quality,
    releaseConfidence: components.releaseConfidence * weights.releaseConfidence,
    identityConfidence: components.identityConfidence * weights.identityConfidence,
    providerAvailability: components.providerAvailability * weights.providerAvailability,
    episodeMatch: components.episodeMatch * weights.episodeMatch,
  };

  // Build deterministic human-readable reasons
  const reasons = [];

  // Relevance
  if (components.relevance >= 0.8) {
    reasons.push('strong title match');
  } else if (components.relevance >= 0.5) {
    reasons.push('moderate title match');
  } else if (components.relevance > 0) {
    reasons.push('weak title match');
  }

  // Quality
  if (components.quality >= 0.9) {
    reasons.push('excellent quality (2160p/UHD)');
  } else if (components.quality >= 0.7) {
    reasons.push('good quality (1080p)');
  } else if (components.quality >= 0.4) {
    reasons.push('acceptable quality (720p)');
  } else if (components.quality > 0) {
    reasons.push('low quality');
  }

  // Release confidence (parser evidence)
  if (components.releaseConfidence >= 0.8) {
    reasons.push('high parser confidence');
  } else if (components.releaseConfidence >= 0.5) {
    reasons.push('moderate parser confidence');
  } else if (components.releaseConfidence > 0) {
    reasons.push('low parser confidence');
  }

  // Identity confidence
  if (components.identityConfidence >= 0.8) {
    reasons.push('strong identity match');
  } else if (components.identityConfidence >= 0.5) {
    reasons.push('moderate identity match');
  } else if (components.identityConfidence > 0) {
    reasons.push('weak identity match');
  }

  // Provider availability (authoritative observations only)
  const hasAuthoritativeProviders = (ranked.providerObservations || []).length > 0;
  if (hasAuthoritativeProviders) {
    if (components.providerAvailability >= 0.8) {
      reasons.push('confirmed provider availability');
    } else if (components.providerAvailability >= 0.5) {
      reasons.push('partial provider availability');
    } else if (components.providerAvailability > 0) {
      reasons.push('limited provider availability');
    } else {
      reasons.push('no provider availability');
    }
  }
  // Provider hints (non-authoritative) are intentionally NOT mentioned
  // as confirmed availability — they remain evidence only.

  // Episode match
  if (components.episodeMatch >= 0.9) {
    reasons.push('exact episode match');
  } else if (components.episodeMatch >= 0.7) {
    reasons.push('episode in range');
  } else if (components.episodeMatch >= 0.5) {
    reasons.push('season pack match');
  }

  // Deterministic summary: top contributing factors
  const sortedContributions = Object.entries(contributions)
    .sort(([, a], [, b]) => b - a);
  const topFactors = sortedContributions
    .filter(([, v]) => v > 0)
    .slice(0, 3)
    .map(([k]) => k);

  return {
    score: ranked.score,
    components: { ...components },
    contributions,
    reasons,
    summary: topFactors.length > 0
      ? `Top factors: ${topFactors.join(', ')}`
      : 'No significant ranking factors',
  };
}

/**
 * Compare two ranked results to explain why one outranks the other.
 *
 * Pure function — no mutation. Takes the outputs of rankHit()/explainRank()
 * and produces a deterministic comparison.
 *
 * @param {Object} a - First ranked result (or its explanation)
 * @param {Object} b - Second ranked result (or its explanation)
 * @returns {Object} Comparison result
 */
export function compareRanked(a, b) {
  if (!a || !b) return null;
  const aComponents = a.components || {};
  const bComponents = b.components || {};
  const weights = WEIGHTS;
  const diffs = {};
  for (const key of Object.keys(weights)) {
    const aWeighted = (aComponents[key] || 0) * weights[key];
    const bWeighted = (bComponents[key] || 0) * weights[key];
    diffs[key] = Math.round((aWeighted - bWeighted) * 1000) / 1000;
  }
  const aScore = a.score ?? aComponents.score ?? 0;
  const bScore = b.score ?? bComponents.score ?? 0;
  const winner = aScore > bScore ? 'a' : (aScore < bScore ? 'b' : 'tie');
  return {
    winner,
    scoreDiff: Math.round((aScore - bScore) * 1000) / 1000,
    componentDiffs: diffs,
    primaryReason: winner === 'tie' ? 'identical scores' : `Higher ${Object.entries(diffs).sort(([, x], [, y]) => y - x)[0]?.[0] || 'score'}`,
  };
}

/**
 * Get the default weights (for inspection/tuning).
 *
 * @returns {Object} Weight configuration
 */
export function getWeights() {
  return { ...WEIGHTS };
}
