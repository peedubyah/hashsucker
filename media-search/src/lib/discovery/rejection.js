/**
 * Rejection Reasons
 *
 * Typed rejection reasons for candidates that fail HARD eligibility gates.
 * Rejection answers "Can this candidate satisfy the request?" — it is NOT
 * about preference or desirability.
 *
 * Taxonomy (all reasons produced at the eligibility/ranking boundary):
 *   WRONG_SEASON          — Release season does not match requested season.
 *   WRONG_EPISODE         — Exact episode evidence does not match requested.
 *   OUT_OF_RANGE          — Requested episode is outside the release's range.
 *   UNKNOWN_EPISODE_COVERAGE — Correct season but no episode/range/pack evidence.
 *   MALFORMED_RANGE       — Episode range string is malformed/unparseable.
 *
 * NOTE: Missing selected-media association is enforced UPSTREAM by the
 * candidate_media INNER JOIN in searchReleases(). Candidates without an
 * association never reach combinedSearch(), so this rejection is NOT observable
 * in the combinedSearch() debug.rejections output. This is intentional — the
 * INNER JOIN is the hard gate, and it remains fail-closed.
 *
 * This module is pure — it does NOT:
 * - Perform I/O
 * - Mutate storage
 * - Depend on provider state
 */

import { coversEpisode } from './episode-coverage.js';

/**
 * Typed rejection reasons.
 * @readonly
 * @enum {string}
 */
export const RejectionReason = Object.freeze({
  WRONG_SEASON: 'wrong-season',
  WRONG_EPISODE: 'wrong-episode',
  OUT_OF_RANGE: 'out-of-range',
  UNKNOWN_EPISODE_COVERAGE: 'unknown-episode-coverage',
  MALFORMED_RANGE: 'malformed-range',
});

/**
 * Map episode-coverage reason strings to typed rejection reasons.
 * @param {string} reason - Reason string from coversEpisode()
 * @returns {string|null} Typed rejection reason or null if eligible
 */
export function reasonFromCoverage(reason) {
  switch (reason) {
    case 'wrong-season':
      return RejectionReason.WRONG_SEASON;
    case 'wrong-episode':
      return RejectionReason.WRONG_EPISODE;
    case 'out-of-range':
      return RejectionReason.OUT_OF_RANGE;
    case 'unknown-episode-coverage':
      return RejectionReason.UNKNOWN_EPISODE_COVERAGE;
    case 'malformed-range':
      return RejectionReason.MALFORMED_RANGE;
    default:
      return null;
  }
}

/**
 * Human-readable description of a rejection reason.
 * @param {string} reason - A RejectionReason value
 * @returns {string} Human-readable description
 */
export function describeRejection(reason) {
  switch (reason) {
    case RejectionReason.WRONG_SEASON:
      return 'Wrong season for selected episode';
    case RejectionReason.WRONG_EPISODE:
      return 'Wrong episode (exact match required)';
    case RejectionReason.OUT_OF_RANGE:
      return 'Requested episode outside release range';
    case RejectionReason.UNKNOWN_EPISODE_COVERAGE:
      return 'Correct season but unknown episode coverage';
    case RejectionReason.MALFORMED_RANGE:
      return 'Malformed episode range';
    default:
      return `Unknown rejection reason: ${reason}`;
  }
}

/**
 * Evaluate whether a candidate is eligible for explicit TV episode intent.
 *
 * Pure function. Wraps coversEpisode() to produce typed rejection reasons.
 * For local candidates only — live candidates are already scoped by
 * selected-media/live-discovery intent and must NOT be rejected for lacking
 * a persisted candidate_media row.
 *
 * @param {Object} candidate - Canonical candidate
 * @param {number} requestedSeason - Explicitly requested season
 * @param {number} requestedEpisode - Explicitly requested episode
 * @returns {{ eligible: boolean, reason: string|null, description: string|null }}
 */
export function evaluateEligibility(candidate, requestedSeason, requestedEpisode) {
  const coverage = coversEpisode(candidate.releaseAttributes || {}, requestedSeason, requestedEpisode);
  if (coverage.eligible) {
    return { eligible: true, reason: null, description: null };
  }
  const reason = reasonFromCoverage(coverage.reason);
  return {
    eligible: false,
    reason,
    description: reason ? describeRejection(reason) : null,
  };
}
