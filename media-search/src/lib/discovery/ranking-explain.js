/**
 * Ranking Explainability
 *
 * Generates human-readable explanations for why a result ranked as it did.
 * Used for debugging, transparency, and API responses.
 */

import { getWeights, qualityScore, identityConfidenceScore, providerAvailabilityScore, episodeMatchScore } from './ranking.js';

/**
 * Explain why a hit received its score.
 *
 * @param {Object} hit - The search hit (same shape as rankHit input)
 * @param {Object} [queryIntent] - Query intent
 * @returns {Object} Explanation with evidence
 */
export function explainScore(hit, queryIntent = {}) {
  const {
    hash,
    filename,
    relevance = 0,
    releaseAttributes = {},
    parserConfidence = 0.5,
    mediaAssociations = [],
    providerObservations = [],
  } = hit;

  const weights = getWeights();
  const quality = qualityScore(releaseAttributes);
  const releaseConf = Math.min(1.0, Math.max(0.0, parserConfidence));
  const identityConf = identityConfidenceScore(mediaAssociations);
  const providerAvail = providerAvailabilityScore(providerObservations);
  const episodeMatch = episodeMatchScore(releaseAttributes, queryIntent);

  // Build evidence array
  const evidence = [];

  // Relevance evidence
  if (relevance >= 0.8) {
    evidence.push({ type: 'relevance', strength: 'high', detail: 'Strong title match' });
  } else if (relevance >= 0.5) {
    evidence.push({ type: 'relevance', strength: 'medium', detail: 'Partial title match' });
  } else {
    evidence.push({ type: 'relevance', strength: 'low', detail: 'Weak title match' });
  }

  // Quality evidence
  if (releaseAttributes.resolution) {
    evidence.push({ type: 'quality', strength: quality >= 0.7 ? 'high' : quality >= 0.4 ? 'medium' : 'low', detail: `${releaseAttributes.resolution} ${releaseAttributes.sourceType || ''}`.trim() });
  }
  if (releaseAttributes.hdr) {
    evidence.push({ type: 'quality', strength: 'bonus', detail: 'HDR' });
  }

  // Identity evidence
  if (mediaAssociations.length > 0) {
    const bestIdentity = mediaAssociations.reduce((best, a) => a.confidence > best.confidence ? a : best);
    evidence.push({ type: 'identity', strength: bestIdentity.confidence >= 0.8 ? 'high' : bestIdentity.confidence >= 0.5 ? 'medium' : 'low', detail: `Matched ${bestIdentity.mediaId} (${Math.round(bestIdentity.confidence * 100)}% confidence)` });
  } else {
    evidence.push({ type: 'identity', strength: 'unknown', detail: 'No media identity resolved' });
  }

  // Provider evidence
  if (providerObservations.length > 0) {
    const cached = providerObservations.filter(o => o.cached === true || o.cached === 1);
    if (cached.length === providerObservations.length) {
      evidence.push({ type: 'availability', strength: 'high', detail: `Cached on ${cached.length} provider(s)` });
    } else if (cached.length > 0) {
      evidence.push({ type: 'availability', strength: 'partial', detail: `Cached on ${cached.length}/${providerObservations.length} provider(s)` });
    } else {
      evidence.push({ type: 'availability', strength: 'low', detail: 'Not cached on any provider' });
    }
  } else {
    evidence.push({ type: 'availability', strength: 'unknown', detail: 'Provider status unknown' });
  }

  // Episode match evidence
  if (queryIntent.season != null && queryIntent.episode != null) {
    if (episodeMatch === 1.0) {
      evidence.push({ type: 'episode', strength: 'exact', detail: `Matches S${queryIntent.season}E${queryIntent.episode}` });
    } else if (episodeMatch === 0.5) {
      evidence.push({ type: 'episode', strength: 'partial', detail: `Right season, wrong episode` });
    } else if (episodeMatch === 0.0) {
      evidence.push({ type: 'episode', strength: 'mismatch', detail: `Wrong season` });
    }
  }

  // Compute contributions
  const breakdown = {
    relevance: Math.round(relevance * weights.relevance * 1000) / 1000,
    quality: Math.round(quality * weights.quality * 1000) / 1000,
    releaseConfidence: Math.round(releaseConf * weights.releaseConfidence * 1000) / 1000,
    identityConfidence: Math.round(identityConf * weights.identityConfidence * 1000) / 1000,
    providerAvailability: Math.round(providerAvail * weights.providerAvailability * 1000) / 1000,
    episodeMatch: Math.round(episodeMatch * weights.episodeMatch * 1000) / 1000,
  };

  const totalScore = Object.values(breakdown).reduce((a, b) => a + b, 0);

  return {
    hash,
    filename,
    score: Math.round(totalScore * 1000) / 1000,
    breakdown,
    evidence,
  };
}

/**
 * Compare two ranked results and explain why one beat the other.
 *
 * @param {Object} winner - The higher-ranked result
 * @param {Object} loser - The lower-ranked result
 * @returns {Object} Comparison with reasons
 */
export function compareRanks(winner, loser) {
  const winnerExp = explainScore(winner);
  const loserExp = explainScore(loser);

  const reasons = [];

  if (winnerExp.breakdown.relevance > loserExp.breakdown.relevance) {
    reasons.push(`Better title match (+${Math.round((winnerExp.breakdown.relevance - loserExp.breakdown.relevance) * 1000) / 1000})`);
  }
  if (winnerExp.breakdown.quality > loserExp.breakdown.quality) {
    reasons.push(`Higher quality release (+${Math.round((winnerExp.breakdown.quality - loserExp.breakdown.quality) * 1000) / 1000})`);
  }
  if (winnerExp.breakdown.identityConfidence > loserExp.breakdown.identityConfidence) {
    reasons.push(`Stronger media identity match (+${Math.round((winnerExp.breakdown.identityConfidence - loserExp.breakdown.identityConfidence) * 1000) / 1000})`);
  }
  if (winnerExp.breakdown.providerAvailability > loserExp.breakdown.providerAvailability) {
    reasons.push(`Better provider availability (+${Math.round((winnerExp.breakdown.providerAvailability - loserExp.breakdown.providerAvailability) * 1000) / 1000})`);
  }
  if (winnerExp.breakdown.episodeMatch > loserExp.breakdown.episodeMatch) {
    reasons.push(`Episode match (+${Math.round((winnerExp.breakdown.episodeMatch - loserExp.breakdown.episodeMatch) * 1000) / 1000})`);
  }

  return {
    winner: winnerExp,
    loser: loserExp,
    scoreDiff: Math.round((winnerExp.score - loserExp.score) * 1000) / 1000,
    reasons,
  };
}
