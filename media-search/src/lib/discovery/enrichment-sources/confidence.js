/**
 * Confidence Scoring for Media Identity Enrichment
 *
 * Computes confidence scores for media associations based on
 * title match quality, year match, and season/episode match.
 *
 * Scoring:
 *   base: 0.5
 *   title exact match: +0.2
 *   title starts with: +0.1
 *   title includes: +0.05
 *   year match: +0.1
 *   season+episode match: +0.15
 *
 * Clamped to [0.0, 1.0]
 */

/**
 * Compute confidence score for a media association.
 *
 * @param {Object} params
 * @param {string} params.titleMatch - 'exact' | 'starts' | 'includes' | 'none'
 * @param {boolean} params.yearMatch - Whether year matches
 * @param {boolean} params.seasonMatch - Whether season matches
 * @param {boolean} params.episodeMatch - Whether episode matches
 * @returns {number} Confidence score 0.0–1.0
 */
export function computeConfidence({ titleMatch = 'none', yearMatch = false, seasonMatch = false, episodeMatch = false } = {}) {
  let score = 0.5;

  if (titleMatch === 'exact') score += 0.2;
  else if (titleMatch === 'starts') score += 0.1;
  else if (titleMatch === 'includes') score += 0.05;

  if (yearMatch) score += 0.1;
  if (seasonMatch && episodeMatch) score += 0.15;

  return Math.min(1.0, Math.max(0.0, score));
}

/**
 * Determine title match quality.
 *
 * @param {string} candidateTitle - Parsed title from release attributes
 * @param {string} resultTitle - Title from metadata provider
 * @returns {'exact'|'starts'|'includes'|'none'}
 */
export function titleMatchQuality(candidateTitle, resultTitle) {
  if (!candidateTitle || !resultTitle) return 'none';

  const a = candidateTitle.toLowerCase().trim();
  const b = resultTitle.toLowerCase().trim();

  if (!a || !b) return 'none';
  if (a === b) return 'exact';
  if (b.startsWith(a) || a.startsWith(b)) return 'starts';
  if (b.includes(a) || a.includes(b)) return 'includes';
  return 'none';
}

/**
 * Compute year match bonus.
 *
 * @param {number|null} candidateYear - Year from release attributes
 * @param {number|null} resultYear - Year from metadata provider
 * @returns {boolean}
 */
export function yearMatch(candidateYear, resultYear) {
  if (candidateYear == null || resultYear == null) return false;
  return candidateYear === resultYear;
}

/**
 * Compute season/episode match.
 *
 * @param {number|null} candidateSeason
 * @param {number|null} candidateEpisode
 * @param {number|null} resultSeason
 * @param {number|null} resultEpisode
 * @returns {{ seasonMatch: boolean, episodeMatch: boolean }}
 */

/**
 * Resolution state classifier.
 *
 * Separates "resolver found a possible match" from "resolver produced a trusted identity association."
 *
 * States:
 *   confirmed  — High confidence (>= 0.7) + multiple evidence sources (>= 2)
 *   probable   — Reasonable match (>= 0.5) but incomplete evidence or limited corroboration
 *   ambiguous  — Low confidence (>= 0.4) OR conflicting evidence (year mismatch, type mismatch, episode not verified)
 *   rejected   — Evidence contradicts candidate (type mismatch, year mismatch with no other strong evidence)
 *   unresolved — No usable match (< 0.4) or below resolver minimum threshold
 *
 * @param {Object} params
 * @param {number} params.confidence — Raw confidence score 0.0–1.0
 * @param {string[]} params.evidence — Evidence tags from resolver
 * @param {number} [params.matchCount=1] — Number of matches returned by resolver
 * @returns {string} One of: 'confirmed' | 'probable' | 'ambiguous' | 'rejected' | 'unresolved'
 */
export function classifyResolutionState({ confidence, evidence = [], matchCount = 1 } = {}) {
  const MIN_CONFIDENCE = 0.4;

  // Below minimum threshold — no usable match
  if (confidence < MIN_CONFIDENCE) return 'unresolved';

  // Check for contradicting evidence
  const hasTypeMismatch = evidence.includes('type_mismatch');
  const hasYearMismatch = evidence.includes('year_mismatch');
  const hasEpisodeNotVerified = evidence.includes('episode_not_verified');
  const hasWeakTitle = evidence.includes('title_weak_match');
  const hasPartialToken = evidence.includes('title_partial_token_match');

  // Strong evidence of contradiction
  if (hasTypeMismatch && confidence < 0.6) return 'rejected';
  if (hasYearMismatch && hasWeakTitle) return 'rejected';

  // Count positive evidence types
  const positiveEvidence = evidence.filter(e =>
    e.startsWith('title_') && !e.includes('weak') && !e.includes('partial')
  );
  const hasYearMatch = evidence.includes('year_match') || evidence.includes('year_close_match');
  const hasEpisodeVerified = evidence.includes('episode_verified');
  const hasSeriesMatch = evidence.includes('series_match');

  // Multiple evidence categories
  const evidenceCategories = new Set();
  if (evidence.some(e => e.startsWith('title_') && !e.includes('weak') && !e.includes('partial'))) evidenceCategories.add('title');
  if (hasYearMatch) evidenceCategories.add('year');
  if (hasEpisodeVerified) evidenceCategories.add('episode');
  if (hasSeriesMatch) evidenceCategories.add('series');

  // Confirmed: high confidence + multiple evidence categories
  if (confidence >= 0.7 && evidenceCategories.size >= 2) return 'confirmed';

  // Probable: medium-high confidence or strong single evidence
  if (confidence >= 0.6 && evidenceCategories.size >= 1) return 'probable';
  if (confidence >= 0.7) return 'probable';

  // Ambiguous: low confidence OR conflicting signals
  if (confidence >= MIN_CONFIDENCE && confidence < 0.6) return 'ambiguous';
  if (hasYearMismatch || hasEpisodeNotVerified || hasPartialToken) return 'ambiguous';
  if (matchCount > 1 && confidence < 0.6) return 'ambiguous';

  // Fallback
  return 'unresolved';
}
export function seasonEpisodeMatch(candidateSeason, candidateEpisode, resultSeason, resultEpisode) {
  const seasonMatch = candidateSeason != null && resultSeason != null && candidateSeason === resultSeason;
  const episodeMatch = candidateEpisode != null && resultEpisode != null && candidateEpisode === resultEpisode;
  return { seasonMatch, episodeMatch };
}
