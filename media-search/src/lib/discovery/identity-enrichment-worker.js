/**
 * Identity Enrichment Worker — DEPRECATED (2026-10-20), NOT SCHEDULED.
 *
 * Asynchronous worker that processes candidates through the identity
 * resolver pipeline. Dequeues candidates from the identity_enrichment_queue,
 * calls the resolver, and stores successful matches in candidate_media.
 *
 * DEPRECATION — why this must not simply be wired up:
 *
 *   - It has no scheduler. The only caller is the manual
 *     `npm run enrichment -- process` script, so it has never run in
 *     production: the queue has sat pending and `candidate_media` carries
 *     zero `resolver_source` values.
 *   - It verifies the MEDIA identity of a candidate (which media a release
 *     belongs to) through Cinemeta. It does NOT establish exact-file
 *     identity: `TorrentFile = infoHash + canonicalInternalPath + exact
 *     positive size` still comes from the provider's file list, targeted,
 *     at materialization time.
 *   - The request path already learns the same media association on demand
 *     (`source = 'request-outcome'`), and the ranking does not read this
 *     worker's output: the eligibility gate judges the live parsed
 *     attributes, and the identity-confidence term reads the association's
 *     confidence, not its `resolution_state`.
 *   - A bounded run (20 items) resolved 6 at 432 ms/item — roughly 49
 *     minutes for the whole 6858-item queue, in exchange for a confidence
 *     nudge on candidates for media the household has already bound.
 *
 * If this is ever revived it must first prove a downstream reuse: a real
 * request that consumes the pre-resolved fact and measurably avoids work
 * it would otherwise have done. A changed row is not evidence.
 *
 * See `docs/BUILD-LOG.md` 2026-10-20 ("does identity enrichment have a right
 * to exist?") for the measurement.
 *
 * Pipeline:
 *   identity_enrichment_queue
 *     ↓
 *   worker dequeues
 *     ↓
 *   parse existing release metadata
 *     ↓
 *   call identity resolver
 *     ↓
 *   store candidate_media associations
 *     ↓
 *   update queue status
 *
 * Guarantees:
 * - Per-candidate failure isolation
 * - No ranking behavior changes
 * - No provider observations created
 * - All writes go through cache.associateMedia with provenance
 * - Queue status is always updated (resolved/failed)
 */

import { getStrongestReleaseAttributes } from './release-attributes.js';
import { classifyResolutionState } from './enrichment-sources/confidence.js';

/**
 * Run the identity enrichment worker against pending queue items.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} options
 * @param {Object} options.resolver - Identity resolver instance (BaseIdentityResolver)
 * @param {number} [options.limit] - Max candidates to process (default: 10)
 * @param {Function} [options.onProgress] - Progress callback: (item, result) => void
 * @returns {Promise<Object>} Run statistics
 */
export async function runIdentityEnrichmentWorker(cache, options = {}) {
  const { resolver, limit = 10, onProgress } = options;

  if (!cache) {
    throw new Error('runIdentityEnrichmentWorker requires a cache');
  }
  if (!resolver || typeof resolver.resolveIdentity !== 'function') {
    throw new Error('runIdentityEnrichmentWorker requires a resolver with resolveIdentity()');
  }

  const stats = {
    total: 0,
    processed: 0,
    resolved: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Get pending items from queue
  const pendingItems = cache.getPendingEnrichments(limit);
  stats.total = pendingItems.length;

  for (const item of pendingItems) {
    stats.processed++;

    try {
      // Mark as processing
      cache.updateEnrichmentStatus(item.infoHash, item.fileIndexKey, 'processing', {
        attempts: item.attempts + 1,
        resolverSource: resolver.sourceName,
      });

      // Get candidate and parsed attributes
      const candidate = cache.getCandidate(item.infoHash, item.fileIndexKey === -1 ? null : item.fileIndexKey);
      if (!candidate) {
        // Candidate no longer exists
        cache.updateEnrichmentStatus(item.infoHash, item.fileIndexKey, 'failed', {
          attempts: item.attempts + 1,
          errorMessage: 'Candidate not found',
          errorCategory: 'candidate-missing',
        });
        stats.failed++;
        continue;
      }

      const parsedAttributes = getStrongestReleaseAttributes(cache, item.infoHash, item.fileIndexKey === -1 ? null : item.fileIndexKey);

      // Check if resolver can handle this candidate
      if (!resolver.canResolve({ candidate, parsedAttributes })) {
        cache.updateEnrichmentStatus(item.infoHash, item.fileIndexKey, 'failed', {
          attempts: item.attempts + 1,
          errorMessage: 'Resolver cannot handle candidate',
          errorCategory: 'resolver-skip',
        });
        stats.skipped++;
        continue;
      }

      // Call resolver
      const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

      if (result && result.matches && result.matches.length > 0) {
        // Store successful matches with resolution state
        for (const match of result.matches) {
          const resolutionState = classifyResolutionState({
            confidence: match.confidence,
            evidence: match.evidence || [],
            matchCount: result.matches.length,
          });
          cache.associateMedia(item.infoHash, item.fileIndexKey === -1 ? null : item.fileIndexKey, match.mediaId, {
            source: 'enrichment',
            confidence: match.confidence,
            evidence: match.evidence,
            resolverSource: result.resolverSource || resolver.sourceName,
            resolverVersion: result.resolverVersion || resolver.version,
            matchMethod: match.evidence?.join(',') || null,
            resolutionState,
          });
        }

        // Mark as resolved
        cache.updateEnrichmentStatus(item.infoHash, item.fileIndexKey, 'resolved', {
          attempts: item.attempts + 1,
          resolverSource: result.resolverSource || resolver.sourceName,
        });

        stats.resolved++;
      } else {
        // No matches found - mark as resolved (no match is not a failure)
        cache.updateEnrichmentStatus(item.infoHash, item.fileIndexKey, 'resolved', {
          attempts: item.attempts + 1,
          resolverSource: result.resolverSource || resolver.sourceName,
        });

        stats.resolved++;
      }

      if (onProgress) {
        onProgress(item, result);
      }
    } catch (error) {
      // Determine if we should retry
      const shouldRetry = item.attempts + 1 < item.maxAttempts;
      const nextAttemptAt = shouldRetry
        ? Date.now() + (1000 * 60 * Math.pow(2, item.attempts)) // Exponential backoff: 1min, 2min, 4min
        : null;

      cache.updateEnrichmentStatus(
        item.infoHash,
        item.fileIndexKey,
        shouldRetry ? 'pending' : 'failed',
        {
          attempts: item.attempts + 1,
          errorMessage: error.message,
          errorCategory: error.code || 'unknown',
          nextAttemptAt,
        },
      );

      stats.failed++;
      stats.errors.push({
        infoHash: item.infoHash,
        fileIndexKey: item.fileIndexKey,
        error: error.message,
      });
    }
  }

  return stats;
}

/**
 * Create a reusable identity enrichment worker with bound dependencies.
 *
 * @param {Object} options
 * @param {Object} options.resolver - Identity resolver instance
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Function} Worker function: async (cache, limit?) => stats
 */
export function createIdentityEnrichmentWorker(options = {}) {
  const { resolver, onProgress } = options;

  return async (cache, limit) => {
    return runIdentityEnrichmentWorker(cache, { resolver, limit, onProgress });
  };
}
