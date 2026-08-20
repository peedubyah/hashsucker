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
export function seasonEpisodeMatch(candidateSeason, candidateEpisode, resultSeason, resultEpisode) {
  const seasonMatch = candidateSeason != null && resultSeason != null && candidateSeason === resultSeason;
  const episodeMatch = candidateEpisode != null && resultEpisode != null && candidateEpisode === resultEpisode;
  return { seasonMatch, episodeMatch };
}
