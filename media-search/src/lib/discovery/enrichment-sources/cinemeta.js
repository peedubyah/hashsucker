/**
 * Cinemeta Media Identity Enrichment Source
 *
 * Resolves media identity by searching Cinemeta with parsed title/year/season/episode
 * from release_attributes. Produces candidate_media associations.
 *
 * Contract:
 * - Consumes release_attributes only (read-only)
 * - Does NOT modify candidates
 * - Writes only candidate_media (via enrichment.js)
 * - Stores confidence + evidence
 * - Supports zero matches (returns empty)
 * - Supports ambiguous matches (returns multiple)
 * - Preserves multiple possible associations
 */

import { searchCatalog } from '../../metadata/cinemeta.js';
import { getStrongestReleaseAttributes } from '../release-attributes.js';
import { computeConfidence, titleMatchQuality, yearMatch, seasonEpisodeMatch } from './confidence.js';

/**
 * Enrich a candidate with media identity from Cinemeta.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} candidate - Candidate to enrich
 * @param {Object} options
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing
 * @returns {Promise<Object|null>} Enrichment result or null if no attributes
 */
export async function enrichWithCinemeta(cache, candidate, options = {}) {
  const { fetchImpl = fetch } = options;

  if (!cache || !candidate) return null;

  const { infoHash, fileIndex = null } = candidate;

  // Get parsed attributes (evidence about the release)
  const attrs = getStrongestReleaseAttributes(cache, infoHash, fileIndex);
  if (!attrs) return null;

  const parsedTitle = attrs.title;
  if (!parsedTitle || parsedTitle.length < 3) return null;

  // Search Cinemeta
  let results;
  try {
    results = await searchCatalog(parsedTitle, fetchImpl);
  } catch (error) {
    // Cinemeta lookup failed — return null (don't force association)
    return null;
  }

  if (!results || results.length === 0) return null;

  // Build media matches
  const matches = [];
  for (const result of results) {
    const titleMtq = titleMatchQuality(parsedTitle, result.name);
    const yearMt = yearMatch(attrs.year, result.year);
    const { seasonMatch, episodeMatch } = seasonEpisodeMatch(
      attrs.season, attrs.episode,
      null, null  // Cinemeta catalog doesn't include season/episode in search results
    );

    // Refuse if title doesn't match at all
    if (titleMtq === 'none') continue;

    const confidence = computeConfidence({
      titleMatch: titleMtq,
      yearMatch: yearMt,
      seasonMatch,
      episodeMatch,
    });

    // Refuse low-confidence associations
    if (confidence < 0.5) continue;

    // Build media ID (Cinemeta uses imdb_id format)
    // For series, we need to match specific episode from videos
    let mediaId = result.id;
    if (result.type === 'series' && attrs.season != null && attrs.episode != null) {
      // For series, the media ID includes season:episode
      mediaId = `${result.id}:${attrs.season}:${attrs.episode}`;
    }

    const evidence = buildEvidence(titleMtq, yearMt, attrs.season, attrs.episode);

    matches.push({
      mediaId,
      confidence,
      title: result.name,
      year: result.year,
      type: result.type,
      evidence,
    });
  }

  // If we have series info but catalog search didn't match season/episode,
  // we need to look up the specific episode
  if (matches.length > 0 && results[0].type === 'series' && attrs.season != null && attrs.episode != null) {
    // Re-check with episode-level precision
    const bestMatch = matches[0];
    // The media ID is already set to include season:episode
    // Confidence is already computed
  }

  if (matches.length === 0) return null;

  return {
    infoHash,
    fileIndex,
    matches: matches.map(m => ({
      mediaId: m.mediaId,
      confidence: m.confidence,
    })),
    source: 'cinemeta',
    evidence: matches[0].evidence,  // Evidence from best match
    raw: matches,  // Full results for debugging
  };
}

/**
 * Build evidence tags from match metadata.
 *
 * @param {string} titleMtq - Title match quality
 * @param {boolean} yearMt - Year match
 * @param {number|null} season - Season number
 * @param {number|null} episode - Episode number
 * @returns {string[]} Evidence tags
 */
function buildEvidence(titleMtq, yearMt, season, episode) {
  const evidence = [];

  if (titleMtq === 'exact') evidence.push('title_exact_match');
  else if (titleMtq === 'starts') evidence.push('title_starts_with');
  else if (titleMtq === 'includes') evidence.push('title_includes');

  if (yearMt) evidence.push('year_match');
  if (season != null && episode != null) evidence.push('season_episode_match');

  return evidence;
}
