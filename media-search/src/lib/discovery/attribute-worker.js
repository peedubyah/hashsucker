/**
 * Release Attribute Worker
 *
 * Parses filenames of candidates that have no release_attributes yet.
 * This is separate from the media identity enrichment worker (worker.js),
 * which creates candidate_media associations.
 *
 * Pipeline:
 *   getCandidatesWithoutAttributes() → parse filename → storeReleaseAttributes()
 *
 * Guarantees:
 * - Does NOT mutate candidate identity (infoHash, fileIndex)
 * - Does NOT create candidate_media associations
 * - Does NOT create provider observations
 * - Only creates release_attributes (parsed filename metadata)
 * - Per-candidate failure isolation (one parse failure doesn't affect others)
 * - Low-confidence parses ARE stored (with confidence value)
 * - Evidence tags preserved
 * - Raw filename always retained
 */

import { parseFilename } from './parser-adapter.js';
import { storeReleaseAttributes } from './release-attributes.js';
import { getCandidatesWithoutAttributes } from './release-attributes.js';

/**
 * Run the attribute worker against candidates without release attributes.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} options
 * @param {Function} [options.parser] - Parser function: (filename) => parsed|null (defaults to parseFilename)
 * @param {number} [options.limit] - Max candidates to process (default: all)
 * @param {Function} [options.onProgress] - Progress callback: (candidate, attrs|null) => void
 * @returns {Promise<Object>} Run statistics
 */
export async function runAttributeWorker(cache, options = {}) {
  const { parser = parseFilename, limit, onProgress } = options;

  if (!cache) {
    throw new Error('runAttributeWorker requires a cache');
  }
  if (typeof parser !== 'function') {
    throw new Error('runAttributeWorker requires a parser function');
  }

  const stats = {
    total: 0,
    processed: 0,
    parsed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Get candidates without release attributes
  let candidates = getCandidatesWithoutAttributes(cache);

  if (limit != null && limit > 0) {
    candidates = candidates.slice(0, limit);
  }

  stats.total = candidates.length;

  for (const candidate of candidates) {
    stats.processed++;
    try {
      // Parse the filename
      const parsed = parser(candidate.filename || candidate.title);

      if (parsed) {
        // Store release attributes
        storeReleaseAttributes(cache, {
          infoHash: candidate.infoHash,
          fileIndex: candidate.fileIndex,
          filename: candidate.filename || candidate.title,
          source: 'ptn-regex',
          confidence: parsed.confidence,
          parsed: parsed.parsed,
          evidence: parsed.evidence,
        });
        stats.parsed++;
      } else {
        // Parser returned null (unparseable filename)
        stats.skipped++;
      }

      if (onProgress) {
        onProgress(candidate, parsed);
      }
    } catch (error) {
      // Failure isolation: one candidate failure doesn't affect others
      stats.failed++;
      stats.errors.push({
        infoHash: candidate.infoHash,
        fileIndex: candidate.fileIndex,
        filename: candidate.filename,
        error: error.message,
      });
    }
  }

  return stats;
}

/**
 * Create a reusable attribute worker with bound dependencies.
 *
 * @param {Object} options
 * @param {Function} [options.parser] - Parser function
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Function} Worker function: async (cache, limit?) => stats
 */
export function createAttributeWorker(options = {}) {
  const { parser, onProgress } = options;

  return async (cache, limit) => {
    return runAttributeWorker(cache, { parser, limit, onProgress });
  };
}
