/**
 * Media Intent Processor
 *
 * Consumes active media_intents and runs them through the discovery/search pipeline.
 * Tracks processing state (last_processed_at, last_result_count, last_error).
 *
 * Processing flow:
 *   Media_intent → MediaIntentProcessor → searchByMedia() → media_requests → media_request_results
 *
 * No scheduling daemon, webhooks, notifications, or UI.
 */

import { searchByMedia } from '../../api/media-request.js';

/**
 * @typedef {Object} ProcessingResult
 * @property {number} processed - Number of intents processed
 * @property {number} successful - Number of successful searches
 * @property {number} failed - Number of failed searches
 * @property {number} resultsFound - Total results found across all searches
 * @property {Array<{intentId: number, status: string, requestId?: number, resultCount?: number, error?: string}>} details - Per-intent results
 * @property {number} elapsedMs - Time taken for processing
 */

/**
 * @typedef {Object} ProcessingOptions
 * @property {number} [limit=50] - Max intents to process
 * @property {boolean} [dryRun=false] - If true, don't persist results
 * @property {Function} [log] - Optional logging function
 * @property {number} [minIntervalMs=0] - Minimum ms since last processing (0 = process all)
 */

export class MediaIntentProcessor {
  /**
   * @param {Object} cache - Discovery cache instance
   */
  constructor(cache) {
    if (!cache) {
      throw new Error('Cache instance is required');
    }
    this.cache = cache;
  }

  /**
   * Process active media intents.
   * @param {ProcessingOptions} [options] - Processing options
   * @returns {Promise<ProcessingResult>}
   */
  async process(options = {}) {
    const { limit = 50, dryRun = false, log, minIntervalMs = 0 } = options;
    const startedAt = Date.now();

    const result = {
      processed: 0,
      successful: 0,
      failed: 0,
      resultsFound: 0,
      details: [],
      elapsedMs: 0,
    };

    // Find active intents that haven't been recently processed
    const intents = this._findPendingIntents(limit, minIntervalMs);

    if (log) {
      log(`Found ${intents.length} pending intents to process`);
    }

    for (const intent of intents) {
      const detail = { intentId: intent.id, status: 'pending' };

      try {
        if (dryRun) {
          // In dry-run mode, just check if search would return results
          const searchResult = await searchByMedia(this.cache, {
            mediaId: intent.mediaId,
            mediaType: intent.mediaType,
            season: intent.season,
            episode: intent.episode,
            source: intent.source,
            sourceType: intent.sourceType,
            sourceId: intent.sourceId,
            sourceLabel: intent.sourceLabel,
            requestedBy: intent.requestedBy,
            priority: intent.priority,
            persist: false,
          });

          detail.status = 'success';
          detail.resultCount = searchResult.total;
          detail.requestId = null;
          result.successful++;
          result.resultsFound += searchResult.total;
        } else {
          // Execute search and persist results
          const searchResult = await searchByMedia(this.cache, {
            mediaId: intent.mediaId,
            mediaType: intent.mediaType,
            season: intent.season,
            episode: intent.episode,
            source: intent.source,
            sourceType: intent.sourceType,
            sourceId: intent.sourceId,
            sourceLabel: intent.sourceLabel,
            requestedBy: intent.requestedBy,
            priority: intent.priority,
            persist: true,
          });

          // Update processing state
          this._updateProcessingState(intent.id, searchResult.total, null);

          detail.status = 'success';
          detail.requestId = searchResult.requestId;
          detail.resultCount = searchResult.total;
          result.successful++;
          result.resultsFound += searchResult.total;
        }

        if (log) {
          const scope = this._formatScope(intent);
          log(`  processed: ${intent.mediaId}${scope} — ${detail.resultCount} results`);
        }
      } catch (error) {
        detail.status = 'failed';
        detail.error = error.message;
        result.failed++;

        // Update processing state with error
        if (!dryRun) {
          this._updateProcessingState(intent.id, 0, error.message);
        }

        if (log) {
          log(`  failed: ${intent.mediaId} — ${error.message}`);
        }
      }

      result.processed++;
      result.details.push(detail);
    }

    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  /**
   * Find active intents that haven't been recently processed.
   * @param {number} limit - Max intents to return
   * @param {number} minIntervalMs - Minimum ms since last processing
   * @returns {Array<Object>}
   */
  _findPendingIntents(limit, minIntervalMs) {
    const now = Date.now();
    const cutoff = now - minIntervalMs;

    // Query for active intents that haven't been processed recently
    const rows = this.cache.db.prepare(`
      SELECT * FROM media_intents
      WHERE status = 'active'
        AND (last_processed_at IS NULL OR last_processed_at < ?)
      ORDER BY priority DESC, last_requested_at DESC
      LIMIT ?
    `).all(cutoff, limit);

    return rows.map(row => ({
      id: row.id,
      mediaId: row.media_id,
      mediaType: row.media_type,
      season: row.season,
      episode: row.episode,
      source: row.source,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceLabel: row.source_label,
      status: row.status,
      priority: row.priority,
      requestedBy: row.requested_by,
      requestCount: row.request_count,
      lastRequestedAt: row.last_requested_at,
      lastProcessedAt: row.last_processed_at,
      lastResultCount: row.last_result_count,
      lastError: row.last_error,
      createdAt: row.created_at,
    }));
  }

  /**
   * Update processing state for an intent.
   * @param {number} intentId - Intent ID
   * @param {number} resultCount - Number of results found
   * @param {string|null} error - Error message (if any)
   */
  _updateProcessingState(intentId, resultCount, error) {
    this.cache.db.prepare(`
      UPDATE media_intents
      SET last_processed_at = ?,
          last_result_count = ?,
          last_error = ?
      WHERE id = ?
    `).run(Date.now(), resultCount, error, intentId);
  }

  /**
   * Format scope string for logging.
   * @param {Object} intent
   * @returns {string}
   */
  _formatScope(intent) {
    if (intent.season != null) {
      const ep = intent.episode != null ? `E${String(intent.episode).padStart(2, '0')}` : '';
      return ` S${String(intent.season).padStart(2, '0')}${ep}`;
    }
    return '';
  }

  /**
   * Get processing statistics.
   * @returns {Object}
   */
  getStats() {
    const row = this.cache.db.prepare(`
      SELECT
        COUNT(*) as total_intents,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_intents,
        SUM(CASE WHEN last_processed_at IS NOT NULL THEN 1 ELSE 0 END) as processed_intents,
        SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) as error_intents,
        SUM(last_result_count) as total_results
      FROM media_intents
    `).get();

    return {
      totalIntents: row.total_intents || 0,
      activeIntents: row.active_intents || 0,
      processedIntents: row.processed_intents || 0,
      errorIntents: row.error_intents || 0,
      totalResults: row.total_results || 0,
    };
  }
}

/**
 * Format processing result as a human-readable summary.
 * @param {ProcessingResult} result
 * @returns {string}
 */
export function formatProcessingSummary(result) {
  const lines = [
    `Processing complete: ${result.processed} processed, ${result.successful} successful, ${result.failed} failed, ${result.resultsFound} results found in ${result.elapsedMs}ms`,
  ];

  if (result.failed > 0) {
    lines.push('Failed intents:');
    for (const detail of result.details.filter(d => d.status === 'failed')) {
      lines.push(`  intent ${detail.intentId}: ${detail.error}`);
    }
  }

  return lines.join('\n');
}
