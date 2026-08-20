/**
 * Enrichment Worker Orchestration
 *
 * Minimal worker that processes unenriched candidates through an injected
 * enrichment function. The worker is source-agnostic — it does not know
 * about filename parsing, external APIs, or metadata providers.
 *
 * Pipeline:
 *   getUnenrichedCandidates() → worker → enrichCandidates()
 *
 * Guarantees:
 * - Per-candidate failure isolation
 * - No provider observations created
 * - No importer behavior triggered
 * - No schedulers or timers
 * - All writes go through enrichment.js
 */

import { enrichCandidates, getUnenrichedCandidates } from './enrichment.js';

/**
 * Run the enrichment worker against unenriched candidates.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} options
 * @param {Function} options.enrich - Enrichment function: async (candidate) => enrichment|null
 * @param {number} [options.limit] - Max candidates to process (default: all)
 * @param {Function} [options.onProgress] - Progress callback: (candidate, result) => void
 * @returns {Promise<Object>} Run statistics
 */
export async function runEnrichmentWorker(cache, options = {}) {
  const { enrich, limit, onProgress } = options;

  if (!cache) {
    throw new Error('runEnrichmentWorker requires a cache');
  }
  if (typeof enrich !== 'function') {
    throw new Error('runEnrichmentWorker requires an enrich function');
  }

  const stats = {
    total: 0,
    processed: 0,
    associated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Get candidates without media associations
  let candidates = getUnenrichedCandidates(cache);

  if (limit != null && limit > 0) {
    candidates = candidates.slice(0, limit);
  }

  stats.total = candidates.length;

  const enrichments = [];

  for (const candidate of candidates) {
    stats.processed++;
    try {
      // Call injected enrichment function
      // Enrichment function signature: async (cache, candidate, options?) => enrichment|null
      const enrichment = await enrich(cache, candidate);

      if (enrichment) {
        enrichments.push(enrichment);
      } else {
        // No enrichment result — candidate remains unenriched
        stats.skipped++;
      }

      if (onProgress) {
        onProgress(candidate, enrichment);
      }
    } catch (error) {
      // Failure isolation: one candidate failure doesn't affect others
      stats.failed++;
      stats.errors.push({
        infoHash: candidate.infoHash,
        fileIndex: candidate.fileIndex,
        error: error.message,
      });
    }
  }

  // Batch write all successful enrichments through enrichment.js
  if (enrichments.length > 0) {
    const result = enrichCandidates(cache, enrichments);
    stats.associated += result.associated;
    stats.skipped += result.skipped;
  }

  return stats;
}

/**
 * Create a reusable enrichment worker with bound dependencies.
 *
 * @param {Object} options
 * @param {Function} options.enrich - Enrichment function
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Function} Worker function: async (cache, limit?) => stats
 */
export function createEnrichmentWorker(options = {}) {
  const { enrich, onProgress } = options;

  return async (cache, limit) => {
    return runEnrichmentWorker(cache, { enrich, limit, onProgress });
  };
}

/**
 * Process a single candidate through enrichment.
 * Useful for testing or on-demand enrichment.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} candidate - Candidate to enrich
 * @param {Function} enrich - Enrichment function
 * @returns {Promise<Object|null>} Enrichment result or null
 */
export async function enrichSingleCandidate(cache, candidate, enrich) {
  if (!cache || !candidate || typeof enrich !== 'function') {
    return null;
  }

  try {
    const enrichment = await enrich(cache, candidate);
    if (enrichment) {
      const result = enrichCandidates(cache, [enrichment]);
      return { enrichment, ...result };
    }
    return null;
  } catch (error) {
    return { error: error.message };
  }
}
