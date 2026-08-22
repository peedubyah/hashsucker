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
 * Stores the actual (unrounded) weighted contributions so explainRank() can
 * report what determined the score without recomputing from rounded components.
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
 * @returns {Object} Ranked result with component scores and raw contributions
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
    providerEvidence = providerObservations,
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

  // Compute weighted contributions (raw, before rounding) — these are what
  // actually produced the score. Stored so explainRank() doesn't recompute
  // from rounded component values and drift from the true score.
  const contributions = {
    relevance: relevance * WEIGHTS.relevance,
    quality: quality * WEIGHTS.quality,
    releaseConfidence: releaseConfidence * WEIGHTS.releaseConfidence,
    identityConfidence: identityConfidence * WEIGHTS.identityConfidence,
    providerAvailability: providerAvailability * WEIGHTS.providerAvailability,
    episodeMatch: episodeMatch * WEIGHTS.episodeMatch,
  };

  const score = (
    contributions.relevance +
    contributions.quality +
    contributions.releaseConfidence +
    contributions.identityConfidence +
    contributions.providerAvailability +
    contributions.episodeMatch
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
    contributions,
    releaseAttributes,
    mediaAssociations,
    providerObservations,
    providerEvidence,
    sources,
    selectedMediaId,
  };
}

/**
 * DETAILED comparator — the SINGLE source of truth for ranking order.
 *
 * Every other ordering function derives from this one:
 *   - compareHits()        → returns compareHitsDetailed().order
 *   - rankHits()           → sorts using compareHits()
 *   - explainOrder()       → derives directly from compareHitsDetailed()
 *   - compareRanked()      → derives directly from explainOrder()
 *
 * There must be NO second handwritten precedence chain.
 *
 * Ordering precedence (first difference is decisive):
 * 1. Higher composite score wins
 * 2. Higher releaseConfidence wins (parser evidence strength)
 * 3. Higher quality wins (resolution/source evidence)
 * 4. Higher relevance wins (title match strength)
 * 5. Lower hash string wins (deterministic, content-derived)
 * 6. Lower fileIndex wins (null sorts after 0)
 *
 * @param {Object} a - First ranked result
 * @param {Object} b - Second ranked result
 * @returns {{order: -1|0|1, decisiveFactor: string|null, aValue: *, bValue: *, winner: 'a'|'b'|'tie', reason: string}}
 */
export function compareHitsDetailed(a, b) {
  // Primary: composite score (higher wins)
  const aScore = a.score ?? 0;
  const bScore = b.score ?? 0;
  if (aScore !== bScore) {
    const aWins = aScore > bScore;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'score',
      aValue: aScore,
      bValue: bScore,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} has higher composite score (${aScore} vs ${bScore})`,
    };
  }

  // Tie-break 1: releaseConfidence (higher wins)
  const aConf = a.components?.releaseConfidence ?? 0;
  const bConf = b.components?.releaseConfidence ?? 0;
  if (aConf !== bConf) {
    const aWins = aConf > bConf;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'releaseConfidence',
      aValue: aConf,
      bValue: bConf,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on release confidence (${aConf} vs ${bConf})`,
    };
  }

  // Tie-break 2: quality (higher wins)
  const aQual = a.components?.quality ?? 0;
  const bQual = b.components?.quality ?? 0;
  if (aQual !== bQual) {
    const aWins = aQual > bQual;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'quality',
      aValue: aQual,
      bValue: bQual,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on quality (${aQual} vs ${bQual})`,
    };
  }

  // Tie-break 3: relevance (higher wins)
  const aRel = a.components?.relevance ?? 0;
  const bRel = b.components?.relevance ?? 0;
  if (aRel !== bRel) {
    const aWins = aRel > bRel;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'relevance',
      aValue: aRel,
      bValue: bRel,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on relevance (${aRel} vs ${bRel})`,
    };
  }

  // Tie-break 4: hash (lexicographic, lower wins — deterministic)
  if (a.hash !== b.hash) {
    const aWins = a.hash < b.hash;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'hash',
      aValue: a.hash,
      bValue: b.hash,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on hash (lexicographic)`,
    };
  }

  // Tie-break 5: fileIndex (lower wins, null sorts after 0)
  const aIdx = a.fileIndex ?? Number.MAX_SAFE_INTEGER;
  const bIdx = b.fileIndex ?? Number.MAX_SAFE_INTEGER;
  if (aIdx !== bIdx) {
    const aWins = aIdx < bIdx;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'fileIndex',
      aValue: a.fileIndex,
      bValue: b.fileIndex,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on file index (${a.fileIndex} vs ${b.fileIndex})`,
    };
  }

  // Exact equality: all tie-breakers exhausted
  return {
    order: 0,
    decisiveFactor: null,
    aValue: null,
    bValue: null,
    winner: 'tie',
    reason: 'identical scores and all tie-breakers',
  };
}

/**
 * Compare two ranked results. Returns compareHitsDetailed().order.
 *
 * @param {Object} a - First ranked result
 * @param {Object} b - Second ranked result
 * @returns {number} -1 if a before b, 1 if b before a, 0 if equal
 */
export function compareHits(a, b) {
  return compareHitsDetailed(a, b).order;
}

/**
 * Explain why one result outranks another.
 *
 * Derives directly from compareHitsDetailed() — there is no second
 * handwritten precedence chain.
 *
 * @param {Object} a - First ranked result
 * @param {Object} b - Second ranked result
 * @returns {{decisiveFactor: string|null, aValue: *, bValue: *, winner: 'a'|'b'|'tie', reason: string}}
 */
export function explainOrder(a, b) {
  const d = compareHitsDetailed(a, b);
  return {
    decisiveFactor: d.decisiveFactor,
    aValue: d.aValue,
    bValue: d.bValue,
    winner: d.winner,
    reason: d.reason,
  };
}

/**
 * Rank multiple search hits.
 *
 * Uses deterministic tie-breakers so repeated identical input yields identical
 * order. Ordering is derived from compareHits() → compareHitsDetailed(),
 * the single source of truth.
 *
 * @param {Array<Object>} hits - Search hits
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping
 * @returns {Array<Object>} Ranked results sorted by score descending
 */
export function rankHits(hits, queryIntent = {}, mediaId = null) {
  const ranked = hits.map(hit => rankHit(hit, queryIntent, mediaId));
  ranked.sort(compareHits);
  return ranked;
}

/**
 * Compare two ranked results to explain why one outranks the other.
 *
 * Accepts RANKED RESULTS ONLY (output of rankHit/rankHits). Does NOT accept
 * explainRank() output, because explainRank() drops hash/fileIndex and
 * therefore cannot reproduce the final hash/fileIndex tie-breaks.
 *
 * Callers that need per-result explanations should call explainRank()
 * separately on each ranked result.
 *
 * Ordering is derived directly from explainOrder() → compareHitsDetailed(),
 * the single source of truth. Guaranteed to never drift from rankHits().
 *
 * @param {Object} a - First ranked result (rankHit/rankHits output)
 * @param {Object} b - Second ranked result (rankHit/rankHits output)
 * @returns {Object} Comparison result
 */
export function compareRanked(a, b) {
  if (!a || !b) return null;

  const order = explainOrder(a, b);
  const aComponents = a.components || {};
  const bComponents = b.components || {};
  const weights = WEIGHTS;

  // Compute weighted contribution diffs (raw, from stored contributions when available)
  const aContrib = a.contributions || {};
  const bContrib = b.contributions || {};
  const diffs = {};
  for (const key of Object.keys(weights)) {
    const aWeighted = aContrib[key] ?? (aComponents[key] || 0) * weights[key];
    const bWeighted = bContrib[key] ?? (bComponents[key] || 0) * weights[key];
    diffs[key] = Math.round((aWeighted - bWeighted) * 1000) / 1000;
  }

  return {
    winner: order.winner,
    scoreDiff: Math.round(((a.score ?? 0) - (b.score ?? 0)) * 1000) / 1000,
    componentDiffs: diffs,
    decisiveFactor: order.decisiveFactor,
    primaryReason: order.reason,
  };
}

/**
 * Build factual quality reasons from releaseAttributes.
 *
 * Describes ACTUAL release properties (resolution, source, codec, HDR),
 * never inferring resolution from the aggregate quality score.
 *
 * @param {Object} attrs - Release attributes
 * @returns {string[]} Human-readable quality reasons
 */
function buildQualityReasons(attrs = {}) {
  const reasons = [];

  // Resolution — describe what IS, not what the composite score implies
  if (attrs.resolution) {
    reasons.push(attrs.resolution);
  }

  // Source type
  if (attrs.sourceType) {
    reasons.push(attrs.sourceType);
  }

  // Codec
  if (attrs.codec) {
    reasons.push(attrs.codec);
  }

  // HDR
  if (attrs.hdr) {
    reasons.push('HDR');
  }

  return reasons;
}

/**
 * Explain a ranked result.
 *
 * Derives a deterministic explanation from the SAME component values that
 * rankHit() used. Does NOT duplicate ranking calculations — it reads the
 * components already computed by rankHit().
 *
 * Uses the ACTUAL weighted contributions stored by rankHit() (not recomputed
 * from rounded component values) so the explanation reconciles with the score.
 *
 * Quality explanations describe FACTS from releaseAttributes (resolution,
 * source, codec, HDR) — never inferring resolution from the aggregate score.
 *
 * Provider hints (non-authoritative) are never described as confirmed
 * provider availability. Only authoritative providerObservations contribute
 * to the providerAvailability component.
 *
 * @param {Object} ranked - Output of rankHit()
 * @param {number} ranked.score - Composite score
 * @param {Object} ranked.components - Component scores (relevance, quality, releaseConfidence, identityConfidence, providerAvailability, episodeMatch)
 * @param {Object} [ranked.contributions] - Raw weighted contributions (from rankHit)
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

  // Use ACTUAL contributions from rankHit() if available (raw, unrounded).
  // These are what produced the score. Only fall back to recomputing from
  // rounded components if contributions weren't stored (backward compat).
  const contributions = ranked.contributions
    ? { ...ranked.contributions }
    : {
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

  // Quality — describe FACTS from releaseAttributes, not composite thresholds
  const qualityReasons = buildQualityReasons(ranked.releaseAttributes || {});
  reasons.push(...qualityReasons);

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
 * Get the default weights (for inspection/tuning).
 *
 * @returns {Object} Weight configuration
 */
export function getWeights() {
  return { ...WEIGHTS };
}
