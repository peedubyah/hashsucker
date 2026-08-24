/**
 * Rejection Tracker — Flight Recorder for Pipeline Decisions
 *
 * Every candidate that enters the pipeline is either:
 * - Ranked (appears in results), OR
 * - Rejected (appears in rejections with a reason)
 *
 * No candidate is silently discarded.
 *
 * This module is pure — it does NOT perform I/O or mutate storage.
 */

/**
 * Typed rejection reasons.
 * @readonly
 * @enum {string}
 */
export const RejectionReason = Object.freeze({
  MISSING_HASH: 'missing-hash',
  DUPLICATED: 'duplicate',
  INVALID_RELEASE: 'invalid-release',
  LOW_METADATA_CONFIDENCE: 'low-metadata-confidence',
  FILTERED_BY_QUALITY: 'filtered-by-quality',
  BELOW_SCORE_THRESHOLD: 'below-score-threshold',
  WRONG_SEASON: 'wrong-season',
  WRONG_EPISODE: 'wrong-episode',
  OUT_OF_RANGE: 'out-of-range',
  UNKNOWN_EPISODE_COVERAGE: 'unknown-episode-coverage',
  MALFORMED_RANGE: 'malformed-range',
  PAGINATED: 'paginated',
});

/**
 * Human-readable description of a rejection reason.
 * @param {string} reason - A RejectionReason value
 * @returns {string} Human-readable description
 */
export function describeRejection(reason) {
  switch (reason) {
    case RejectionReason.MISSING_HASH:
      return 'Candidate has no infoHash — cannot identify release';
    case RejectionReason.DUPLICATED:
      return 'Exact duplicate releaseKey merged into stronger candidate';
    case RejectionReason.INVALID_RELEASE:
      return 'Release identity or metadata is invalid';
    case RejectionReason.LOW_METADATA_CONFIDENCE:
      return 'Parser confidence below minimum threshold';
    case RejectionReason.FILTERED_BY_QUALITY:
      return 'Quality filter excluded this release';
    case RejectionReason.BELOW_SCORE_THRESHOLD:
      return 'Score below ranking threshold for inclusion';
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
    case RejectionReason.PAGINATED:
      return 'Result excluded by pagination (beyond page window)';
    default:
      return `Unknown rejection reason: ${reason}`;
  }
}

/**
 * Create a rejection record.
 *
 * @param {Object} params
 * @param {string} params.hash - Candidate infoHash (or 'unknown' if missing)
 * @param {number|null} [params.fileIndex] - Candidate file index
 * @param {string} [params.releaseKey] - Candidate release key
 * @param {string} params.reason - RejectionReason value
 * @param {string} [params.description] - Human-readable description
 * @param {Object} [params.context] - Additional context (e.g. duplicateOf, score, threshold)
 * @returns {Object} Immutable rejection record
 */
export function createRejection({ hash, fileIndex = null, releaseKey = null, reason, description = null, context = null }) {
  return Object.freeze({
    candidate: hash || 'unknown',
    fileIndex,
    releaseKey,
    rejected: true,
    reason,
    description: description || describeRejection(reason),
    ...(context ? { context } : {}),
  });
}

/**
 * Rejection tracker — collects all rejections for a search operation.
 */
export class RejectionTracker {
  constructor() {
    /** @type {Array<Object>} */
    this._rejections = [];
  }

  /**
   * Record a rejection.
   * @param {Object} rejection - Rejection record from createRejection()
   */
  record(rejection) {
    this._rejections.push(rejection);
  }

  /**
   * Record a duplicate rejection.
   * @param {Object} duplicate - The candidate that was merged away
   * @param {string} duplicateOf - releaseKey of the surviving candidate
   */
  recordDuplicate(duplicate, duplicateOf) {
    this._rejections.push(createRejection({
      hash: duplicate.hash,
      fileIndex: duplicate.fileIndex,
      releaseKey: duplicate.releaseKey,
      reason: RejectionReason.DUPLICATED,
      description: `Duplicate of ${duplicateOf} — evidence merged`,
      context: { duplicateOf },
    }));
  }

  /**
   * Record a missing-hash rejection.
   * @param {Object} raw - The raw candidate that was filtered
   */
  recordMissingHash(raw) {
    this._rejections.push(createRejection({
      hash: raw.infoHash || 'unknown',
      reason: RejectionReason.MISSING_HASH,
      context: { source: raw.sources?.[0]?.addonId || 'unknown' },
    }));
  }

  /**
   * Record a low metadata confidence rejection.
   * @param {Object} candidate - The candidate
   * @param {number} confidence - Actual confidence
   * @param {number} threshold - Minimum threshold
   */
  recordLowConfidence(candidate, confidence, threshold) {
    this._rejections.push(createRejection({
      hash: candidate.hash,
      fileIndex: candidate.fileIndex,
      releaseKey: candidate.releaseKey,
      reason: RejectionReason.LOW_METADATA_CONFIDENCE,
      context: { confidence, threshold },
    }));
  }

  /**
   * Record a pagination rejection.
   * @param {Object} candidate - The candidate that was paginated out
   * @param {number} rank - Its rank in the full results
   * @param {number} offset - Pagination offset
   * @param {number} limit - Page size
   */
  recordPaginated(candidate, rank, offset, limit) {
    this._rejections.push(createRejection({
      hash: candidate.hash,
      fileIndex: candidate.fileIndex,
      releaseKey: candidate.releaseKey,
      reason: RejectionReason.PAGINATED,
      context: { rank, offset, limit },
    }));
  }

  /**
   * Get all rejections.
   * @returns {Array<Object>} Immutable copy of rejections
   */
  getRejections() {
    return Object.freeze([...this._rejections]);
  }

  /**
   * Get count of rejections.
   * @returns {number}
   */
  get count() {
    return this._rejections.length;
  }

  /**
   * Merge another tracker's rejections into this one.
   * @param {RejectionTracker} other - Another tracker
   */
  merge(other) {
    if (other && Array.isArray(other._rejections)) {
      this._rejections.push(...other._rejections);
    }
  }

  /**
   * Clear all rejections.
   */
  clear() {
    this._rejections = [];
  }
}
