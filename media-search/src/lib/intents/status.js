/**
 * Media Intent Status
 *
 * Lifecycle observability for processed intents.
 * Provides operator tooling to answer:
 * - What intents exist?
 * - Which have been processed?
 * - Which have results?
 * - Which failed?
 * - Which need reprocessing?
 */

/**
 * @typedef {Object} IntentStatus
 * @property {number} total - Total intents
 * @property {number} active - Active intents
 * @property {number} processed - Intents that have been processed at least once
 * @property {number} unprocessed - Active intents never processed
 * @property {number} failed - Intents with last_error set
 * @property {number} withResults - Intents with last_result_count > 0
 * @property {number} withoutResults - Intents processed but with 0 results
 */

/**
 * @typedef {Object} RecentProcessedIntent
 * @property {number} id - Intent ID
 * @property {string} mediaId - Media ID
 * @property {string|null} label - Human-readable label
 * @property {string} source - Source identifier
 * @property {number|null} lastProcessedAt - Timestamp of last processing
 * @property {number|null} lastResultCount - Results from last processing
 * @property {string|null} lastError - Error from last processing (if any)
 */

/**
 * Get intent lifecycle status counts.
 * @param {Object} cache - Discovery cache instance
 * @param {Object} [options] - Options
 * @param {string} [options.source] - Filter by source
 * @param {string} [options.status] - Filter by status
 * @returns {IntentStatus}
 */
export function getIntentStatus(cache, options = {}) {
  const { source, status } = options;

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (source) {
    whereClause += ' AND source = ?';
    params.push(source);
  }

  if (status) {
    whereClause += ' AND status = ?';
    params.push(status);
  }

  const row = cache.db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN last_processed_at IS NOT NULL THEN 1 ELSE 0 END) as processed,
      SUM(CASE WHEN status = 'active' AND last_processed_at IS NULL THEN 1 ELSE 0 END) as unprocessed,
      SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN last_result_count > 0 THEN 1 ELSE 0 END) as with_results,
      SUM(CASE WHEN last_processed_at IS NOT NULL AND last_result_count = 0 THEN 1 ELSE 0 END) as without_results
    FROM media_intents
    ${whereClause}
  `).get(...params);

  return {
    total: row.total || 0,
    active: row.active || 0,
    processed: row.processed || 0,
    unprocessed: row.unprocessed || 0,
    failed: row.failed || 0,
    withResults: row.with_results || 0,
    withoutResults: row.without_results || 0,
  };
}

/**
 * Get recently processed intents.
 * @param {Object} cache - Discovery cache instance
 * @param {number} [limit=10] - Max results
 * @returns {RecentProcessedIntent[]}
 */
export function getRecentProcessedIntents(cache, limit = 10) {
  const rows = cache.db.prepare(`
    SELECT
      id,
      media_id,
      source_label,
      source,
      last_processed_at,
      last_result_count,
      last_error
    FROM media_intents
    WHERE last_processed_at IS NOT NULL
    ORDER BY last_processed_at DESC
    LIMIT ?
  `).all(limit);

  return rows.map(row => ({
    id: row.id,
    mediaId: row.media_id,
    label: row.source_label,
    source: row.source,
    lastProcessedAt: row.last_processed_at,
    lastResultCount: row.last_result_count,
    lastError: row.last_error,
  }));
}

/**
 * Get intents that need reprocessing.
 * Returns intents that are active and either:
 * - Never been processed
 * - Last processed before the given interval
 * - Last processing failed
 * @param {Object} cache - Discovery cache instance
 * @param {Object} [options] - Options
 * @param {number} [options.minIntervalMs=3600000] - Minimum ms since last processing (default 1 hour)
 * @param {number} [options.limit=50] - Max results
 * @returns {RecentProcessedIntent[]}
 */
export function getReprocessingNeeded(cache, options = {}) {
  const { minIntervalMs = 3600000, limit = 50 } = options;
  const cutoff = Date.now() - minIntervalMs;

  const rows = cache.db.prepare(`
    SELECT
      id,
      media_id,
      source_label,
      source,
      last_processed_at,
      last_result_count,
      last_error
    FROM media_intents
    WHERE status = 'active'
      AND (
        last_processed_at IS NULL
        OR last_processed_at < ?
        OR last_error IS NOT NULL
      )
    ORDER BY
      CASE WHEN last_error IS NOT NULL THEN 0 ELSE 1 END,
      last_processed_at ASC
    LIMIT ?
  `).all(cutoff, limit);

  return rows.map(row => ({
    id: row.id,
    mediaId: row.media_id,
    label: row.source_label,
    source: row.source,
    lastProcessedAt: row.last_processed_at,
    lastResultCount: row.last_result_count,
    lastError: row.last_error,
  }));
}

/**
 * Format relative time (e.g., "2m ago", "3h ago").
 * @param {number|null} timestamp - Unix timestamp
 * @returns {string}
 */
export function formatRelativeTime(timestamp) {
  if (!timestamp) return 'never';

  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Format intent status as human-readable output.
 * @param {IntentStatus} status
 * @param {RecentProcessedIntent[]} recent
 * @returns {string}
 */
export function formatIntentStatus(status, recent) {
  const lines = [
    'Media Intent Status',
    '',
    `Total: ${status.total}`,
    `Active: ${status.active}`,
    `Processed: ${status.processed}`,
    `Pending: ${status.unprocessed}`,
    `Failed: ${status.failed}`,
    '',
    `With results: ${status.withResults}`,
    `Without results: ${status.withoutResults}`,
  ];

  if (recent.length > 0) {
    lines.push('', 'Recent:');
    for (const intent of recent) {
      const label = intent.label || intent.mediaId;
      const time = formatRelativeTime(intent.lastProcessedAt);
      const errorIndicator = intent.lastError ? ' [ERROR]' : '';
      lines.push(`- ${label} (${intent.source}) — ${intent.lastResultCount || 0} results, ${time}${errorIndicator}`);
    }
  }

  return lines.join('\n');
}
