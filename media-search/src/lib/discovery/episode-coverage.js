/**
 * Episode Coverage Eligibility
 *
 * Hard eligibility logic for explicit TV episode intent against LOCAL corpus
 * candidates. Answers: "Does this release evidence cover the requested
 * season/episode?" BEFORE preference scoring.
 *
 * This module is pure — it does NOT:
 * - Perform I/O
 * - Mutate storage
 * - Depend on provider state
 *
 * Architectural position (preference scoring comes AFTER this gate):
 *   Selected media association (candidate_media INNER JOIN in search-engine)
 *     ↓
 *   Episode coverage eligibility (THIS MODULE)
 *     ↓
 *   Eligible candidate set
 *     ↓
 *   Desirability scoring (ranking.js)
 *
 * Hard eligibility semantics for explicit S/E intent:
 *
 * 1. SINGLE EPISODE
 *    Release season = S AND episode = E  => eligible
 *    Otherwise                           => ineligible
 *
 * 2. EPISODE RANGE
 *    Release season = S AND episode_range = start-end
 *    Requested E is eligible iff start <= E <= end
 *    Wrong season or E outside range     => ineligible
 *    Malformed/reversed ranges           => ineligible
 *
 * 3. SEASON PACK
 *    Release explicitly evidenced as season-only/season-pack for season S.
 *    An episode in season S is eligible.
 *    Wrong season                        => ineligible
 *    Do NOT infer a season pack merely because episode data is missing.
 *    Require actual parser/evidence semantics (seasonOnly flag or
 *    mediaType='season').
 *
 * 4. UNKNOWN / AMBIGUOUS TV COVERAGE
 *    "Right series, unknown episode coverage" is NOT a good episode match.
 *    season present but episode missing and no seasonPack evidence => ineligible
 */

/**
 * Safely parse an episode_range string "start-end" into [start, end].
 * Returns null if the range is malformed, non-numeric, or reversed.
 *
 * @param {string} rangeStr - Episode range string (e.g., "1-5")
 * @returns {{ start: number, end: number } | null}
 */
export function parseEpisodeRange(rangeStr) {
  if (typeof rangeStr !== 'string') return null;
  const trimmed = rangeStr.trim();
  const parts = trimmed.split('-');
  if (parts.length !== 2) return null;

  const start = parseInt(parts[0].trim(), 10);
  const end = parseInt(parts[1].trim(), 10);

  // Reject non-numeric, NaN, or reversed ranges
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start <= 0 || end <= 0) return null;
  if (start > end) return null;  // Reversed range is malformed

  return { start, end };
}

/**
 * Determine whether a local corpus candidate covers an explicit TV episode.
 *
 * Pure function. Takes release evidence and requested season/episode.
 * Returns { eligible: boolean, reason: string }.
 *
 * @param {Object} releaseAttrs - Release attributes evidence
 * @param {number} [releaseAttrs.season] - Parsed season
 * @param {number} [releaseAttrs.episode] - Parsed single episode
 * @param {string} [releaseAttrs.episodeRange] - Parsed episode range "start-end"
 * @param {boolean} [releaseAttrs.seasonOnly] - Parser-flagged season pack
 * @param {string} [releaseAttrs.mediaType] - Parser media type guess
 * @param {number} requestedSeason - Explicitly requested season
 * @param {number} requestedEpisode - Explicitly requested episode
 * @returns {{ eligible: boolean, reason: string }}
 */
export function coversEpisode(releaseAttrs = {}, requestedSeason, requestedEpisode) {
  const { season, episode, episodeRange, seasonOnly, mediaType } = releaseAttrs;

  // No season evidence at all — cannot confirm coverage
  if (season == null) {
    return { eligible: false, reason: 'no-season-evidence' };
  }

  // Wrong season is always ineligible (regardless of episode/range/pack)
  if (season !== requestedSeason) {
    return { eligible: false, reason: 'wrong-season' };
  }

  // Correct season from here on.

  // Case 1: Single episode evidence
  if (episode != null) {
    if (episode === requestedEpisode) {
      return { eligible: true, reason: 'exact-episode' };
    }
    return { eligible: false, reason: 'wrong-episode' };
  }

  // Case 2: Episode range evidence
  if (episodeRange != null) {
    const range = parseEpisodeRange(episodeRange);
    if (!range) {
      // Malformed range — do not accidentally make eligible
      return { eligible: false, reason: 'malformed-range' };
    }
    if (requestedEpisode >= range.start && requestedEpisode <= range.end) {
      return { eligible: true, reason: 'in-range' };
    }
    return { eligible: false, reason: 'out-of-range' };
  }

  // Case 3: Season pack evidence
  // Only accept explicit season-pack evidence, NOT inferred from missing episode.
  const isSeasonPack = seasonOnly === true || mediaType === 'season';
  if (isSeasonPack) {
    return { eligible: true, reason: 'season-pack' };
  }

  // Case 4: Correct season but unknown episode coverage (no episode, no range, no pack)
  // Conservative: do not treat as eligible.
  return { eligible: false, reason: 'unknown-episode-coverage' };
}

/**
 * Convenience predicate: does this release cover the requested episode?
 *
 * @param {Object} releaseAttrs
 * @param {number} requestedSeason
 * @param {number} requestedEpisode
 * @returns {boolean}
 */
export function isEpisodeCovered(releaseAttrs = {}, requestedSeason, requestedEpisode) {
  return coversEpisode(releaseAttrs, requestedSeason, requestedEpisode).eligible;
}
