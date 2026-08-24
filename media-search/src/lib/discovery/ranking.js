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
 * Semantic: measures confidence that this candidate IS the requested media.
 * Absence of associations means unknown (NEUTRAL), not low confidence.
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
 * Compute identity confidence from live discovery scoping.
 *
 * When live discovery is scoped to a selected media ID, the fact that
 * a live provider returned this candidate for that media IS identity
 * evidence. This is not manufactured — it reflects that the live source
 * already filtered to the requested media.
 *
 * @param {string|null} selectedMediaId - The media ID live discovery was scoped to
 * @param {Array<Object>} mediaAssociations - Existing media associations (if any)
 * @param {string|null} mediaId - The media ID being queried
 * @returns {number} 0.0-1.0
 */
export function identityConfidenceFromLiveScope(selectedMediaId, mediaAssociations = [], mediaId) {
  // If we have explicit associations, use those (higher trust)
  if (mediaAssociations.length > 0) {
    return identityConfidenceForMedia(mediaAssociations, mediaId);
  }

  // If live discovery was scoped to the queried media, that's identity evidence
  // The live provider already filtered to this media — that's meaningful
  if (selectedMediaId && selectedMediaId === mediaId) {
    // Live scope match is weaker than a persisted association
    // but stronger than unknown (NEUTRAL)
    return 0.7; // Moderate confidence from live scoping
  }

  return NEUTRAL;
}

/**
 * Compute provider availability score from observations.
 *
 * Semantic: measures evidence that this candidate is available from providers.
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
 * Compute provider availability from live discovery evidence.
 *
 * When a live provider returns a candidate, that IS availability evidence.
 * The provider has the file and is offering it. This is not manufactured —
 * it reflects real-time provider state.
 *
 * @param {Array<Object>} providerObservations - Existing provider observations
 * @param {boolean} hasLiveDiscovery - Whether this candidate came from live discovery
 * @param {Object} [liveProviderHints] - Provider hints from live discovery
 * @returns {number} 0.0-1.0
 */
export function providerAvailabilityFromLive(providerObservations = [], hasLiveDiscovery = false, liveProviderHints = null) {
  // If we have explicit observations, use those (higher trust)
  if (providerObservations.length > 0) {
    return providerAvailabilityScore(providerObservations);
  }

  // Live discovery itself is availability evidence
  // The provider returned this candidate — they have it
  if (hasLiveDiscovery) {
    // Check if we have cache hints from live source
    if (liveProviderHints && typeof liveProviderHints === 'object') {
      const hints = Object.values(liveProviderHints);
      const cachedCount = hints.filter(h => h && (h.cached === true || h.cached === 1)).length;
      if (cachedCount > 0) return 0.8; // Provider says it's cached
    }
    // Live discovery without cache hint = moderate availability evidence
    return 0.6;
  }

  return NEUTRAL;
}

/**
 * Compute relevance from identity evidence for live candidates.
 *
 * Semantic: measures how well this candidate matches the query.
 * For corpus: BM25 text relevance (exact title match).
 * For live: identity-derived relevance (scoped to selected media).
 *
 * @param {number} textRelevance - BM25-based relevance (corpus only)
 * @param {string|null} selectedMediaId - Media ID live discovery was scoped to
 * @param {string|null} mediaId - Media ID being queried
 * @returns {number} 0.0-1.0
 */
export function relevanceFromIdentity(textRelevance, selectedMediaId = null, mediaId = null) {
  // If we have text relevance (corpus), use it directly
  if (textRelevance > 0) {
    return textRelevance;
  }

  // For live candidates: if discovery was scoped to the queried media,
  // that's relevance evidence — the candidate IS for the requested media
  if (selectedMediaId && selectedMediaId === mediaId) {
    // Identity-derived relevance: live provider returned this for the requested media
    // This is not as strong as exact text match, but it's meaningful
    return 0.7;
  }

  return NEUTRAL;
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
 * Identity eligibility diagnostic — measures identity match for corpus candidates
 * without filtering or changing ranking behavior.
 *
 * Pure function: reads hit evidence, returns diagnostic snapshot.
 * Does NOT modify the candidate or ranking outcome.
 *
 * @param {Object} hit - Corpus candidate entering ranking
 * @param {string} hit.hash - InfoHash
 * @param {number|null} hit.fileIndex - File index
 * @param {string} hit.filename - Release filename
 * @param {string} [hit.releaseKey] - Pre-computed release key
 * @param {Object} [hit.releaseAttributes] - Parsed release attributes
 * @param {Array<Object>} [hit.mediaAssociations] - Media associations (candidate_media rows)
 * @param {Array<Object>} [hit.sources] - Provenance sources
 * @param {string|null} [hit.selectedMediaId] - Selected media intent provenance
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {number} [queryIntent.season] - Query season
 * @param {number} [queryIntent.episode] - Query episode
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {IdentityDiagnostic|null} Diagnostic snapshot, or null for non-corpus
 */
export function diagnoseIdentityEligibility(hit, queryIntent = {}, mediaId = null) {
  const releaseAttributes = hit.releaseAttributes || {};
  const mediaAssociations = hit.mediaAssociations || [];
  const sources = hit.sources || [];
  const isCorpus = sources.some(s => s.origin === 'corpus');

  // Only corpus candidates have persisted identity to diagnose
  if (!isCorpus) {
    return null;
  }

  const parsedTitle = releaseAttributes.title || null;
  const parsedSeason = releaseAttributes.season ?? null;
  const parsedEpisode = releaseAttributes.episode ?? null;
  const targetMediaId = mediaId || hit.selectedMediaId || null;

  let identityMatch = false;
  let rejectionReason = null;

  if (targetMediaId && mediaAssociations.length > 0) {
    const forMedia = mediaAssociations.filter(a => a.mediaId === targetMediaId);
    identityMatch = forMedia.length > 0;

    if (!identityMatch) {
      const associatedIds = [...new Set(mediaAssociations.map(a => a.mediaId))];
      rejectionReason = `identity_mismatch: associated with [${associatedIds.join(', ')}] but queried ${targetMediaId}`;
    }
  } else if (targetMediaId && mediaAssociations.length === 0) {
    rejectionReason = 'no_identity_evidence: no candidate_media rows';
  } else if (!targetMediaId) {
    rejectionReason = 'no_target_media_id: query not scoped to specific media';
  }

  let seasonEpisodeMatch = null;
  if (queryIntent.season != null && queryIntent.episode != null) {
    if (parsedSeason == null) {
      seasonEpisodeMatch = 'unknown_season';
    } else if (parsedSeason !== queryIntent.season) {
      seasonEpisodeMatch = `wrong_season: parsed=${parsedSeason}, query=${queryIntent.season}`;
    } else if (parsedEpisode != null && parsedEpisode !== queryIntent.episode) {
      seasonEpisodeMatch = `wrong_episode: parsed=${parsedEpisode}, query=${queryIntent.episode}`;
    } else {
      seasonEpisodeMatch = 'match';
    }
  }

  return {
    releaseKey: hit.releaseKey || null,
    filename: hit.filename || null,
    identityMatch,
    parsedTitle,
    parsedSeason,
    parsedEpisode,
    targetMediaId,
    rejectionReason,
    seasonEpisodeMatch,
  };
}

/**
 * Aggregate identity eligibility counts for a batch of corpus candidates.
 *
 * Pure function: calls diagnoseIdentityEligibility for each candidate,
 * returns aggregate counts. Does NOT modify any candidate or ranking.
 *
 * @param {Array<Object>} hits - Corpus candidates entering ranking
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {IdentityEligibilityCounts} Aggregate counts
 */
export function countIdentityEligibility(hits, queryIntent = {}, mediaId = null) {
  const diagnostics = hits
    .map(h => diagnoseIdentityEligibility(h, queryIntent, mediaId))
    .filter(d => d !== null);

  const total = diagnostics.length;
  const identityMatched = diagnostics.filter(d => d.identityMatch).length;
  const identityRejected = diagnostics.filter(d => !d.identityMatch && d.rejectionReason).length;
  const textOnlyMatches = diagnostics.filter(d => d.rejectionReason && d.rejectionReason.includes('no_identity_evidence')).length;
  const seasonEpisodeFailures = diagnostics.filter(d => d.seasonEpisodeMatch && d.seasonEpisodeMatch !== 'match').length;

  return {
    corpusRetrieved: total,
    identityMatched,
    identityRejected,
    textOnlyMatches,
    seasonEpisodeFailures,
    ranked: total,
  };
}

/**
 * Identity tier classification — categorizes a candidate's identity match quality.
 *
 * Pure function: reads hit evidence, returns tier classification.
 * Does NOT modify the candidate or ranking outcome.
 *
 * Tiers (in precedence order):
 * - Verified: explicit candidate_media match, confirmed filename/parser identity,
 *             or season/episode confirmation where applicable
 * - ProviderConfirmed: live mediaId scope AND strong identity evidence from filename/parser
 * - Probable: strong corpus/title metadata match
 * - ProviderScoped: live mediaId scope only, no independent identity evidence
 * - TextOnly: retrieved only because of search text similarity
 * - Rejected: identity mismatch or no target media ID
 *
 * @param {Object} hit - Candidate entering ranking
 * @param {string} hit.hash - InfoHash
 * @param {number|null} hit.fileIndex - File index
 * @param {string} hit.filename - Release filename
 * @param {number} [hit.relevance] - Title relevance from search (0.0-1.0)
 * @param {Object} [hit.releaseAttributes] - Parsed release attributes
 * @param {Array<Object>} [hit.mediaAssociations] - Media associations (candidate_media rows)
 * @param {Array<Object>} [hit.sources] - Provenance sources
 * @param {string|null} [hit.selectedMediaId] - Selected media intent provenance
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {number} [queryIntent.season] - Query season
 * @param {number} [queryIntent.episode] - Query episode
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {{IdentityTier: string, IdentityConfidence: number, IdentityEvidence: string[], RejectionReason: string|null}}
 */
export function classifyIdentityTier(hit, queryIntent = {}, mediaId = null) {
  const releaseAttributes = hit.releaseAttributes || {};
  const mediaAssociations = hit.mediaAssociations || [];
  const sources = hit.sources || [];
  const isCorpus = sources.some(s => s.origin === 'corpus');
  const isLive = sources.some(s => s.origin === 'live');

  const parsedTitle = releaseAttributes.title || null;
  const parsedSeason = releaseAttributes.season ?? null;
  const parsedEpisode = releaseAttributes.episode ?? null;
  const targetMediaId = mediaId || hit.selectedMediaId || null;
  const textRelevance = hit.relevance || 0;

  // Helper: check if filename/parser provides strong identity evidence
  // Used to distinguish ProviderConfirmed from ProviderScoped for live candidates
  // and to strengthen Verified tier for corpus candidates
  const hasStrongIdentityEvidence = (h, intent) => {
    const attrs = h.releaseAttributes || {};
    const title = attrs.title || null;
    const season = attrs.season ?? null;
    const episode = attrs.episode ?? null;
    const relevance = h.relevance || 0;

    // Strong title match indicates filename matches query
    const hasStrongTitle = relevance >= 0.6;

    // Parsed season/episode matching query intent
    const querySeason = intent?.season ?? null;
    const queryEpisode = intent?.episode ?? null;
    const hasMatchingSeason = querySeason != null && season === querySeason;
    const hasMatchingEpisode = queryEpisode != null && episode === queryEpisode;
    const hasMatchingSeasonEpisode = hasMatchingSeason && hasMatchingEpisode;

    // Strong identity evidence: either strong title match OR matching season/episode
    return hasStrongTitle || hasMatchingSeasonEpisode;
  };

  // Live candidates: tier based on provider scope + independent identity evidence
  // Provider scope is NOT equivalent to confirmed identity
  if (isLive && !isCorpus) {
    if (hit.selectedMediaId && hit.selectedMediaId === mediaId) {
      // Provider returned this candidate scoped to the requested mediaId
      // Check for independent identity evidence to distinguish ProviderConfirmed vs ProviderScoped
      if (hasStrongIdentityEvidence(hit, queryIntent)) {
        return {
          IdentityTier: 'ProviderConfirmed',
          IdentityConfidence: 0.8,
          IdentityEvidence: ['provider-scoped-to-media', 'strong-identity-evidence'],
          RejectionReason: null,
        };
      }
      return {
        IdentityTier: 'ProviderScoped',
        IdentityConfidence: 0.4,
        IdentityEvidence: ['provider-scoped-to-media'],
        RejectionReason: null,
      };
    }
    return {
      IdentityTier: 'Probable',
      IdentityConfidence: 0.5,
      IdentityEvidence: ['live-discovery'],
      RejectionReason: null,
    };
  }

  // Corpus candidates require a target media ID to classify
  if (!targetMediaId) {
    return {
      IdentityTier: 'Rejected',
      IdentityConfidence: 0.0,
      IdentityEvidence: [],
      RejectionReason: 'no_target_media_id: query not scoped to specific media',
    };
  }

  // Check for strong identity evidence from filename/parser (used for Verified tier)
  const strongIdentityEvidence = hasStrongIdentityEvidence(hit, queryIntent);

  // Check explicit media association
  let explicitMatch = false;
  let identityMismatch = false;
  let associatedIds = [];

  if (mediaAssociations.length > 0) {
    const forMedia = mediaAssociations.filter(a => a.mediaId === targetMediaId);
    explicitMatch = forMedia.length > 0;
    if (!explicitMatch) {
      identityMismatch = true;
      associatedIds = [...new Set(mediaAssociations.map(a => a.mediaId))];
    }
  }

  // Season/episode match evaluation
  let seasonEpisodeMatch = null;
  if (queryIntent.season != null && queryIntent.episode != null) {
    if (parsedSeason == null) {
      seasonEpisodeMatch = 'unknown_season';
    } else if (parsedSeason !== queryIntent.season) {
      seasonEpisodeMatch = 'wrong_season';
    } else if (parsedEpisode != null && parsedEpisode !== queryIntent.episode) {
      seasonEpisodeMatch = 'wrong_episode';
    } else if (parsedEpisode != null && parsedEpisode === queryIntent.episode) {
      seasonEpisodeMatch = 'match';
    } else {
      seasonEpisodeMatch = 'unknown_episode';
    }
  }

  // Rejected: explicit mismatch
  if (identityMismatch) {
    return {
      IdentityTier: 'Rejected',
      IdentityConfidence: 0.1,
      IdentityEvidence: [`associated-with:${associatedIds.join(',')}`],
      RejectionReason: `identity_mismatch: associated with [${associatedIds.join(', ')}] but queried ${targetMediaId}`,
    };
  }

  // Verified: explicit media association match (confirmed identity)
  if (explicitMatch) {
    const evidence = ['media-association-match'];
    let confidence = 0.9;

    if (seasonEpisodeMatch === 'match') {
      evidence.push('season-episode-match');
      confidence = 1.0;
    } else if (seasonEpisodeMatch === 'unknown_episode') {
      evidence.push('correct-season');
    } else if (seasonEpisodeMatch === 'wrong_season') {
      evidence.push('wrong-season');
      confidence = 0.7;
    } else if (seasonEpisodeMatch === 'wrong_episode') {
      evidence.push('wrong-episode');
      confidence = 0.6;
    }

    return {
      IdentityTier: 'Verified',
      IdentityConfidence: confidence,
      IdentityEvidence: evidence,
      RejectionReason: null,
    };
  }

  // No explicit media association from here on
  const hasTitleMatch = textRelevance >= 0.6;
  const hasParsedMetadata = parsedTitle || parsedSeason != null || parsedEpisode != null;

  // Probable: strong title match but no media association
  if (hasTitleMatch) {
    const evidence = ['strong-title-match'];
    let confidence = 0.6;

    if (parsedSeason != null) {
      evidence.push('parsed-season');
      confidence += 0.1;
    }
    if (parsedEpisode != null) {
      evidence.push('parsed-episode');
      confidence += 0.1;
    }

    return {
      IdentityTier: 'Probable',
      IdentityConfidence: Math.min(0.8, confidence),
      IdentityEvidence: evidence,
      RejectionReason: null,
    };
  }

  // Probable: partial metadata evidence
  if (hasParsedMetadata) {
    const evidence = [];
    if (parsedTitle) evidence.push('parsed-title');
    if (parsedSeason != null) evidence.push('parsed-season');
    if (parsedEpisode != null) evidence.push('parsed-episode');

    return {
      IdentityTier: 'Probable',
      IdentityConfidence: 0.4,
      IdentityEvidence: evidence,
      RejectionReason: null,
    };
  }

  // TextOnly: retrieved only because of search text similarity
  return {
    IdentityTier: 'TextOnly',
    IdentityConfidence: 0.2,
    IdentityEvidence: ['text-similarity-only'],
    RejectionReason: 'no_identity_evidence: no candidate_media rows',
  };
}

/**
 * Evaluate identity tier for all candidates in a batch.
 *
 * Pure function: calls classifyIdentityTier for each candidate,
 * returns per-candidate evaluations. Does NOT modify any candidate or ranking.
 *
 * @param {Array<Object>} hits - Candidates entering ranking
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {Array<{IdentityTier: string, IdentityConfidence: number, IdentityEvidence: string[], RejectionReason: string|null}>}
 */
export function evaluateIdentityTiers(hits, queryIntent = {}, mediaId = null) {
  return hits.map(h => classifyIdentityTier(h, queryIntent, mediaId));
}

/**
 * Detailed identity diagnostic — shows why each candidate received its tier.
 *
 * Pure function: reads candidate evidence, returns diagnostic snapshot.
 * Does NOT modify any candidate or ranking outcome.
 *
 * Exposes evidence sources for understanding tier assignments:
 * - Candidate_media: explicit media associations from corpus
 * - Parsed_filename: title/season/episode parsed from filename
 * - MediaId_scope: whether candidate was scoped to requested mediaId
 * - Title_match: text relevance score
 * - Season_episode_match: season/episode confirmation where applicable
 *
 * @param {Object} hit - Candidate entering ranking
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {{IdentityTier: string, EvidenceSources: {Candidate_media: string[], Parsed_filename: Object, MediaId_scope: {selectedMediaId: string|null, queriedMediaId: string|null, scoped: boolean}, Title_match: {relevance: number, isStrongMatch: boolean}, Season_episode_match: {querySeason: number|null, queryEpisode: number|null, parsedSeason: number|null, parsedEpisode: number|null, matchStatus: string|null}}, ConfidenceSignals: {identityConfidence: number, parserConfidence: number, tierConfidence: number}}}
 */
export function diagnoseIdentityEvidence(hit, queryIntent = {}, mediaId = null) {
  const releaseAttributes = hit.releaseAttributes || {};
  const mediaAssociations = hit.mediaAssociations || [];
  const sources = hit.sources || {};
  const isCorpus = sources.some?.(s => s.origin === 'corpus');
  const isLive = sources.some?.(s => s.origin === 'live');

  // Classify tier
  const tier = classifyIdentityTier(hit, queryIntent, mediaId);

  // Evidence: Candidate_media (explicit media associations)
  const candidateMedia = mediaAssociations.map(a => 
    `${a.mediaId}${a.confidence ? `(${(a.confidence * 100).toFixed(0)}%)` : ''}`
  );

  // Evidence: Parsed_filename
  const parsedFilename = {
    title: releaseAttributes.title || null,
    season: releaseAttributes.season ?? null,
    episode: releaseAttributes.episode ?? null,
    resolution: releaseAttributes.resolution || null,
    sourceType: releaseAttributes.sourceType || null,
  };

  // Evidence: MediaId_scope
  const selectedMediaId = hit.selectedMediaId || null;
  const queriedMediaId = mediaId || null;
  const scoped = !!(selectedMediaId && queriedMediaId && selectedMediaId === queriedMediaId);

  // Evidence: Title_match
  const relevance = hit.relevance || 0;
  const isStrongMatch = relevance >= 0.6;

  // Evidence: Season_episode_match
  const querySeason = queryIntent?.season ?? null;
  const queryEpisode = queryIntent?.episode ?? null;
  const parsedSeason = releaseAttributes.season ?? null;
  const parsedEpisode = releaseAttributes.episode ?? null;

  let matchStatus = null;
  if (querySeason != null && queryEpisode != null) {
    if (parsedSeason == null) {
      matchStatus = 'unknown_season';
    } else if (parsedSeason !== querySeason) {
      matchStatus = 'wrong_season';
    } else if (parsedEpisode != null && parsedEpisode !== queryEpisode) {
      matchStatus = 'wrong_episode';
    } else if (parsedEpisode != null && parsedEpisode === queryEpisode) {
      matchStatus = 'exact_match';
    } else {
      matchStatus = 'season_only';
    }
  }

  // Confidence signals
  const identityConfidence = hit.identityConfidence ?? 0.5;
  const parserConfidence = hit.parserConfidence ?? 0.5;

  // Promotion failure diagnostic: why ProviderScoped failed promotion to ProviderScoped
  let promotionFailure = null;
  if (tier.IdentityTier === 'ProviderScoped') {
    const failures = [];
    if (!isStrongMatch) {
      failures.push(`weak-title-match (relevance=${relevance.toFixed(2)}, need>=0.6)`);
    }
    if (querySeason != null && parsedSeason !== querySeason) {
      failures.push(`season-mismatch (parsed=${parsedSeason}, query=${querySeason})`);
    }
    if (queryEpisode != null && parsedEpisode !== queryEpisode) {
      failures.push(`episode-mismatch (parsed=${parsedEpisode}, query=${queryEpisode})`);
    }
    if (parsedSeason == null && parsedEpisode == null) {
      failures.push('no-season-episode-parsed');
    }
    promotionFailure = {
      reason: 'insufficient-independent-identity-evidence',
      failures,
      recommendation: 'Promote to ProviderConfirmed if filename/parser confirms identity',
    };
  }

  return {
    IdentityTier: tier.IdentityTier,
    EvidenceSources: {
      Candidate_media: candidateMedia,
      Parsed_filename: parsedFilename,
      MediaId_scope: {
        selectedMediaId,
        queriedMediaId,
        scoped,
      },
      Title_match: {
        relevance,
        isStrongMatch,
      },
      Season_episode_match: {
        querySeason,
        queryEpisode,
        parsedSeason,
        parsedEpisode,
        matchStatus,
      },
    },
    ConfidenceSignals: {
      identityConfidence,
      parserConfidence,
      tierConfidence: tier.IdentityConfidence,
    },
    ...(promotionFailure && { promotionFailure }),
  };
}

/**
 * Generate detailed identity diagnostics for top N candidates.
 *
 * Pure function: calls diagnoseIdentityEvidence for each candidate.
 * Does NOT modify any candidate or ranking outcome.
 *
 * @param {Array<Object>} hits - Ranked candidates (output of rankHitsTiered)
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID being queried
 * @param {number} [topN] - Number of top candidates to diagnose (default 50)
 * @returns {Array<{rank: number, releaseKey: string, source: string, score: number, identity: Object}>}
 */
export function diagnoseTopCandidates(hits, queryIntent = {}, mediaId = null, topN = 50) {
  return hits.slice(0, topN).map((hit, i) => {
    const source = hit.sources?.some?.(s => s.origin === 'live') ? 'live' : 'corpus';
    const releaseKey = hit.releaseKey || `${hit.hash}:${hit.fileIndex ?? 'torrent'}`;
    const identity = diagnoseIdentityEvidence(hit, queryIntent, mediaId);

    return {
      rank: i + 1,
      releaseKey,
      source,
      score: hit.score ?? null,
      identity,
    };
  });
}

/**
 * Aggregate identity tier distribution for a batch of candidates.
 *
 * Pure function: calls classifyIdentityTier for each candidate,
 * returns aggregate counts. Does NOT modify any candidate or ranking.
 *
 * @param {Array<Object>} hits - Candidates entering ranking
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {{CorpusRetrieved: number, LiveRetrieved: number, VerifiedCount: number, ProviderMatchedCount: number, ProbableCount: number, TextOnlyCount: number, RejectedCount: number, SeasonEpisodeFailures: number, IdentityMismatches: number}}
 */
export function aggregateIdentityTiers(hits, queryIntent = {}, mediaId = null) {
  const evaluations = hits.map(h => classifyIdentityTier(h, queryIntent, mediaId));

  const corpusHits = hits.filter(h => {
    const sources = h.sources || [];
    return sources.some(s => s.origin === 'corpus');
  });
  const liveHits = hits.filter(h => {
    const sources = h.sources || [];
    return sources.some(s => s.origin === 'live');
  });

  return {
    CorpusRetrieved: corpusHits.length,
    LiveRetrieved: liveHits.length,
    VerifiedCount: evaluations.filter(e => e.IdentityTier === 'Verified').length,
    ProviderConfirmedCount: evaluations.filter(e => e.IdentityTier === 'ProviderConfirmed').length,
    ProbableCount: evaluations.filter(e => e.IdentityTier === 'Probable').length,
    ProviderScopedCount: evaluations.filter(e => e.IdentityTier === 'ProviderScoped').length,
    TextOnlyCount: evaluations.filter(e => e.IdentityTier === 'TextOnly').length,
    RejectedCount: evaluations.filter(e => e.IdentityTier === 'Rejected').length,
    SeasonEpisodeFailures: evaluations.filter(e =>
      e.IdentityEvidence && e.IdentityEvidence.some(ev =>
        ev.includes('wrong-season') || ev.includes('wrong-episode')
      )
    ).length,
    IdentityMismatches: evaluations.filter(e =>
      e.RejectionReason && e.RejectionReason.includes('identity_mismatch')
    ).length,
  };
}

/**
 * Shadow ranking comparison — computes hypothetical result sets without
 * modifying the active ranking behavior.
 *
 * Pure function: reads candidates, returns comparison diagnostics.
 * Does NOT modify any candidate or the active ranking outcome.
 *
 * Three modes:
 * 1. Current: all candidates ranked together (the active behavior)
 * 2. VerifiedOnly: only Verified candidates ranked
 * 3. Tiered: Verified → ProviderMatched → Probable (active behavior)
 *
 * @param {Array<Object>} candidates - Eligible candidates (post-dedup, post-eligibility)
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping
 * @param {number} [topN] - Number of top results to compare (default 50)
 * @returns {{CurrentTopSources: string[], VerifiedOnlyTopSources: string[], TieredTopSources: string[], CurrentTopScoreRange: {min: number, max: number}|null, VerifiedOnlyTopScoreRange: {min: number, max: number}|null, CandidatesExcludedByVerifiedFilter: number, CurrentTop10: string[], VerifiedOnlyTop10: string[], TieredTop10: string[]}}
 */
export function shadowRankComparison(candidates, queryIntent = {}, mediaId = null, topN = 50) {
  const evaluations = candidates.map(c => ({
    candidate: c,
    tier: classifyIdentityTier(c, queryIntent, mediaId),
  }));

  // Current: all candidates ranked together
  const currentRanked = rankHits(candidates.map(toRankingInputShadow), queryIntent, mediaId);
  const currentTop = currentRanked.slice(0, topN);

  // VerifiedOnly: only Verified candidates
  const verifiedCandidates = evaluations
    .filter(e => e.tier.IdentityTier === 'Verified')
    .map(e => e.candidate);
  const verifiedOnlyRanked = rankHits(verifiedCandidates.map(toRankingInputShadow), queryIntent, mediaId);
  const verifiedOnlyTop = verifiedOnlyRanked.slice(0, topN);

  // Tiered: Verified → ProviderConfirmed → Probable → ProviderScoped (matches active behavior)
  const providerConfirmedCandidates = evaluations
    .filter(e => e.tier.IdentityTier === 'ProviderConfirmed')
    .map(e => e.candidate);
  const providerScopedCandidates = evaluations
    .filter(e => e.tier.IdentityTier === 'ProviderScoped')
    .map(e => e.candidate);
  const probableCandidates = evaluations
    .filter(e => e.tier.IdentityTier === 'Probable')
    .map(e => e.candidate);
  const tieredRanked = [
    ...verifiedOnlyRanked,
    ...rankHits(providerConfirmedCandidates.map(toRankingInputShadow), queryIntent, mediaId),
    ...rankHits(probableCandidates.map(toRankingInputShadow), queryIntent, mediaId),
    ...rankHits(providerScopedCandidates.map(toRankingInputShadow), queryIntent, mediaId),
  ];
  const tieredTop = tieredRanked.slice(0, topN);

  // Extract source distribution for top N
  const extractSources = (ranked) => {
    const sources = ranked.map(r => {
      const src = r.sources?.find(s => s.origin === 'live') ? 'live' : 'corpus';
      return src;
    });
    const corpusCount = sources.filter(s => s === 'corpus').length;
    const liveCount = sources.filter(s => s === 'live').length;
    return { corpus: corpusCount, live: liveCount };
  };

  // Extract score range for top N
  const scoreRange = (ranked) => {
    if (ranked.length === 0) return null;
    const scores = ranked.map(r => r.score || 0);
    return {
      min: Math.min(...scores),
      max: Math.max(...scores),
    };
  };

  // Extract top 10 releaseKeys
  const top10Keys = (ranked) => ranked.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`);

  return {
    CurrentTopSources: extractSources(currentTop),
    VerifiedOnlyTopSources: extractSources(verifiedOnlyTop),
    TieredTopSources: extractSources(tieredTop),
    CurrentTopScoreRange: scoreRange(currentTop),
    VerifiedOnlyTopScoreRange: scoreRange(verifiedOnlyTop),
    CandidatesExcludedByVerifiedFilter: candidates.length - verifiedCandidates.length,
    CurrentTop10: top10Keys(currentTop),
    VerifiedOnlyTop10: top10Keys(verifiedOnlyTop),
    TieredTop10: top10Keys(tieredTop),
  };
}

/**
 * Convert a canonical candidate to ranking input shape for shadow ranking.
 * Reuses the same transformation as the active pipeline.
 *
 * @param {Object} candidate - Canonical candidate
 * @returns {Object} Ranking input
 */
function toRankingInputShadow(candidate) {
  return {
    hash: candidate.hash,
    fileIndex: candidate.fileIndex ?? null,
    filename: candidate.filename,
    relevance: candidate.relevance ?? 0,
    releaseAttributes: candidate.releaseAttributes || {},
    parserConfidence: candidate.parserConfidence ?? 0.5,
    mediaAssociations: candidate.mediaAssociations || [],
    providerObservations: candidate.providerObservations || [],
    providerEvidence: candidate.providerEvidence || candidate.providerObservations || [],
    sources: candidate.sources || [],
    selectedMediaId: candidate.selectedMediaId ?? null,
    hasLiveDiscovery: candidate.hasLiveDiscovery ?? false,
    liveProviderHints: candidate.liveProviderHints ?? null,
    releaseKey: candidate.releaseKey,
  };
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
    hasLiveDiscovery = false,
    liveProviderHints = null,
  } = hit;

  // Compute component scores using semantic confidence functions.
  // Each component measures evidence quality, not data availability.
  const quality = qualityScore(releaseAttributes);
  const releaseConfidence = Math.min(1.0, Math.max(0.0, parserConfidence));

  // Relevance: text-based for corpus, identity-derived for live
  // For live candidates scoped to the selected media, the scope itself
  // is relevance evidence (the provider returned it for this media)
  const effectiveRelevance = relevanceFromIdentity(relevance, selectedMediaId, mediaId);

  // Identity confidence: associations for corpus, live scope for live
  // Absence of associations doesn't imply low confidence — it means unknown
  const identityConfidence = mediaId
    ? identityConfidenceFromLiveScope(selectedMediaId, mediaAssociations, mediaId)
    : identityConfidenceScore(mediaAssociations);

  // Provider availability: observations for corpus, live discovery for live
  // A live provider returning a candidate IS availability evidence
  const providerAvailability = providerAvailabilityFromLive(
    providerObservations,
    hasLiveDiscovery,
    liveProviderHints
  );

  const episodeMatch = episodeMatchScore(releaseAttributes, queryIntent);

  // Compute weighted contributions (raw, before rounding) — these are what
  // actually produced the score. Stored so explainRank() doesn't recompute
  // from rounded component values and drift from the true score.
  const contributions = {
    relevance: effectiveRelevance * WEIGHTS.relevance,
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

  const roundedScore = Math.round(score * 1000) / 1000;

  // Ranking justification — flight recorder for explainability.
  // Does NOT change the score. Exposes the breakdown so operators can
  // understand why a candidate won or lost.
  const justification = Object.freeze({
    candidate: { hash, fileIndex, releaseKey: hit.releaseKey || `${hash}:${fileIndex ?? 'torrent'}`, filename },
    finalScore: roundedScore,
    scoreBreakdown: Object.freeze({
      cacheScore: Math.round(providerAvailability * 1000) / 1000,
      qualityScore: Math.round(quality * 1000) / 1000,
      sourceScore: Math.round(releaseConfidence * 1000) / 1000,
      metadataScore: Math.round(identityConfidence * 1000) / 1000,
      popularityScore: Math.round(effectiveRelevance * 1000) / 1000,
    }),
    weights: Object.freeze({ ...WEIGHTS }),
  });

  return {
    hash,
    fileIndex,
    filename,
    score: roundedScore,
    components: {
      relevance: Math.round(effectiveRelevance * 1000) / 1000,
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
    provenance: hit.provenance || null,
    justification,
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
  // Assign rank (1-based position in sorted results)
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].justification = Object.freeze({
      ...ranked[i].justification,
      rank: i + 1,
    });
  }
  return ranked;
}

/**
 * Tiered ranking precedence — identity tier as primary sort signal.
 *
 * Ranking behavior:
 * 1. Verified candidates rank above ProviderMatched candidates
 * 2. ProviderMatched candidates rank above Probable candidates
 * 3. Probable candidates rank above TextOnly candidates
 * 4. Within each tier, existing ranking behavior is preserved (score, then tie-breakers)
 * 5. If a higher tier has no candidates, falls back to the next tier
 *
 * No candidates are deleted or discarded — all candidates appear in the output.
 *
 * @param {Array<Object>} hits - Search hits
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping
 * @returns {{ranked: Array<Object>, tierMeta: {TieredRankingApplied: boolean, TierCounts: Object, TopResultsByTier: Object}}}
 */
export function rankHitsTiered(hits, queryIntent = {}, mediaId = null) {
  // Classify each candidate by identity tier
  const classified = hits.map(hit => ({
    hit,
    tier: classifyIdentityTier(hit, queryIntent, mediaId),
  }));

  // Group by tier (preserve all candidates)
  const verified = classified.filter(c => c.tier.IdentityTier === 'Verified');
  const providerConfirmed = classified.filter(c => c.tier.IdentityTier === 'ProviderConfirmed');
  const probable = classified.filter(c => c.tier.IdentityTier === 'Probable');
  const providerScoped = classified.filter(c => c.tier.IdentityTier === 'ProviderScoped');
  const textOnly = classified.filter(c => c.tier.IdentityTier === 'TextOnly');
  const rejected = classified.filter(c => c.tier.IdentityTier === 'Rejected');

  // Rank within each tier using existing behavior
  const rankedVerified = rankHits(verified.map(c => c.hit), queryIntent, mediaId);
  const rankedProviderConfirmed = rankHits(providerConfirmed.map(c => c.hit), queryIntent, mediaId);
  const rankedProbable = rankHits(probable.map(c => c.hit), queryIntent, mediaId);
  const rankedProviderScoped = rankHits(providerScoped.map(c => c.hit), queryIntent, mediaId);
  const rankedTextOnly = rankHits(textOnly.map(c => c.hit), queryIntent, mediaId);
  const rankedRejected = rankHits(rejected.map(c => c.hit), queryIntent, mediaId);

  // Concatenate: Verified → ProviderConfirmed → Probable → ProviderScoped → TextOnly → Rejected
  // Fallback is implicit: if a tier is empty, we simply proceed to the next
  const ranked = [
    ...rankedVerified,
    ...rankedProviderConfirmed,
    ...rankedProbable,
    ...rankedProviderScoped,
    ...rankedTextOnly,
    ...rankedRejected,
  ];

  // Assign final rank (1-based position in sorted results)
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].justification = Object.freeze({
      ...ranked[i].justification,
      rank: i + 1,
    });
  }

  // Build tier metadata for diagnostics
  const tierMeta = {
    TieredRankingApplied: true,
    TierCounts: {
      Verified: rankedVerified.length,
      ProviderConfirmed: rankedProviderConfirmed.length,
      Probable: rankedProbable.length,
      ProviderScoped: rankedProviderScoped.length,
      TextOnly: rankedTextOnly.length,
      Rejected: rankedRejected.length,
    },
    TopResultsByTier: {
      Verified: rankedVerified.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
      ProviderConfirmed: rankedProviderConfirmed.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
      Probable: rankedProbable.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
      ProviderScoped: rankedProviderScoped.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
      TextOnly: rankedTextOnly.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
    },
  };

  return { ranked, tierMeta };
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
