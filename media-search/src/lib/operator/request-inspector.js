/**
 * Request inspector — builds a structured view of request lifecycle
 * with recommendations (not automatic actions).
 *
 * Data model:
 *   Request
 *    |
 *    +-- state
 *    +-- created_at
 *    +-- updated_at
 *    +-- last_event
 *    +-- queue_location
 *    +-- failure_reason
 *    +-- retry_count
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// Thresholds for recommendations (in milliseconds)
const STUCK_THRESHOLD_MS = 60 * 60 * 1000;      // 1 hour
const FAILED_CLEANUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const ORPHANED_THRESHOLD_MS = 30 * 60 * 1000;    // 30 minutes

/**
 * Inspect all requests and generate recommendations.
 * @param {Object} options
 * @param {string} options.requestsRoot - Path to requests directory
 * @param {Object} [options.controlPlaneStore] - Control-plane store instance
 * @param {() => number} [options.now] - Clock function
 * @returns {Promise<{ requests: Array, recommendations: Array, summary: Object }>}
 */
export async function inspectRequests({ requestsRoot, controlPlaneStore, now = Date.now } = {}) {
  const requests = [];
  const recommendations = [];

  const dirs = ['incoming', 'processing', 'done', 'failed'];
  const allQueueFiles = [];

  // 1. Scan all queue files
  for (const dir of dirs) {
    const dirPath = path.join(requestsRoot, dir);
    let entries;
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const requestId = entry.slice(0, -5);
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) continue;

      try {
        const body = await fs.readFile(path.join(dirPath, entry), 'utf8');
        const request = JSON.parse(body);
        allQueueFiles.push({ requestId, status: dir, request });
      } catch {
        // Unreadable file — still report it
        allQueueFiles.push({ requestId, status: dir, request: null, unreadable: true });
      }
    }
  }

  // 2. Build structured view for each request
  for (const { requestId, status, request, unreadable } of allQueueFiles) {
    const mediaId = request?.mediaId || request?.media_id;
    const createdAt = request?.createdAt || request?.created_at;
    const updatedAt = request?.updatedAt || request?.updated_at;
    const retryCount = request?.retryCount ?? request?.retry_count ?? 0;
    const lastError = request?.lastError || request?.last_error;
    const failureReason = request?.failureReason || request?.failure_reason || lastError;

    // Build timeline from request fields
    const timeline = buildTimeline(request);

    // Determine last event
    const lastEvent = timeline.length > 0 ? timeline[timeline.length - 1].label : 'unknown';

    const requestView = {
      requestId,
      state: status,
      created_at: createdAt,
      updated_at: updatedAt,
      last_event: lastEvent,
      queue_location: status,
      failure_reason: failureReason || null,
      retry_count: retryCount,
      media_id: mediaId,
      timeline,
      unreadable: unreadable || false,
    };

    requests.push(requestView);

    // 3. Generate recommendations based on rules
    const rec = generateRecommendation({
      request: requestView,
      controlPlaneStore,
      now,
    });
    if (rec) {
      recommendations.push(rec);
    }
  }

  // 4. Check for DB-only records (no queue file)
  if (controlPlaneStore) {
    try {
      const dbItems = controlPlaneStore.db.prepare(`
        SELECT DISTINCT le.library_item_id
        FROM lifecycle_events le
        WHERE le.status = 'failed'
      `).all();

      for (const { library_item_id: itemId } of dbItems) {
        // Check if there's a queue file for this item
        const hasQueueFile = allQueueFiles.some(r => {
          const mediaId = r.request?.mediaId || r.request?.media_id;
          return mediaId && mediaId.includes(itemId.slice(0, 8));
        });

        if (!hasQueueFile) {
          recommendations.push({
            type: 'orphaned-database-record',
            severity: 'info',
            library_item_id: itemId,
            reason: 'library item has failed lifecycle but no queue file',
            suggestion: 'reconcile or purge database record',
          });
        }
      }
    } catch {
      // Table may not exist
    }
  }

  const summary = {
    total: requests.length,
    queued: requests.filter(r => r.state === 'incoming').length,
    processing: requests.filter(r => r.state === 'processing').length,
    done: requests.filter(r => r.state === 'done').length,
    failed: requests.filter(r => r.state === 'failed').length,
    recommendations: recommendations.length,
  };

  return { requests, recommendations, summary };
}

/**
 * Build a timeline of events from request fields.
 * @param {Object} request
 * @returns {Array<{ label: string, timestamp: string, status: 'complete' | 'failed' | 'pending' }>}
 */
function buildTimeline(request) {
  const events = [];

  if (!request) return events;

  const createdAt = request.createdAt || request.created_at;
  const claimedAt = request.claimedAt || request.claimed_at;
  const torboxResolvedAt = request.torboxResolvedAt || request.torbox_resolved_at;
  const materializedAt = request.materializedAt || request.materialized_at;
  const completedAt = request.completedAt || request.completed_at;
  const failedAt = request.failedAt || request.failed_at;
  const lastError = request.lastError || request.last_error;

  if (createdAt) {
    events.push({ label: 'created', timestamp: createdAt, status: 'complete' });
  }

  if (claimedAt) {
    events.push({ label: 'claimed', timestamp: claimedAt, status: 'complete' });
  }

  if (torboxResolvedAt) {
    events.push({ label: 'torbox resolved', timestamp: torboxResolvedAt, status: 'complete' });
  }

  if (materializedAt) {
    events.push({ label: 'materialized', timestamp: materializedAt, status: 'complete' });
  }

  if (completedAt) {
    events.push({ label: 'completed', timestamp: completedAt, status: 'complete' });
  }

  if (failedAt || lastError) {
    events.push({
      label: 'failed',
      timestamp: failedAt || createdAt,
      status: 'failed',
    });
  }

  return events;
}

/**
 * Generate a recommendation for a request based on rules.
 * @param {Object} options
 * @returns {Object|null}
 */
function generateRecommendation({ request, now = Date.now }) {
  const { state, created_at, updated_at, retry_count, unreadable, failure_reason } = request;

  if (unreadable) {
    return {
      type: 'corrupted-file',
      severity: 'warning',
      requestId: request.requestId,
      state,
      reason: 'unreadable queue file',
      suggestion: 'delete or repair file',
    };
  }

  const lastUpdate = updated_at ? new Date(updated_at).getTime() : created_at ? new Date(created_at).getTime() : null;
  const age = lastUpdate ? now() - lastUpdate : 0;

  // Rule: Processing > 1 hour = possible stuck worker
  if (state === 'processing' && age > STUCK_THRESHOLD_MS) {
    const hours = Math.round(age / (60 * 60 * 1000));
    return {
      type: 'stuck-worker',
      severity: 'warning',
      requestId: request.requestId,
      state,
      reason: `processing for ${hours}h without update`,
      suggestion: 'reset or delete request',
    };
  }

  // Rule: Failed > 7 days = eligible for cleanup
  if (state === 'failed' && age > FAILED_CLEANUP_THRESHOLD_MS) {
    const days = Math.round(age / (24 * 60 * 60 * 1000));
    return {
      type: 'eligible-for-cleanup',
      severity: 'info',
      requestId: request.requestId,
      state,
      reason: `failed for ${days}d, retry_count=${retry_count}`,
      suggestion: 'delete request',
    };
  }

  // Rule: Failed with retry_count = 0 and recent = suggest retry
  if (state === 'failed' && retry_count === 0 && age < FAILED_CLEANUP_THRESHOLD_MS) {
    return {
      type: 'retry-eligible',
      severity: 'info',
      requestId: request.requestId,
      state,
      reason: failure_reason || 'recent failure, no retries yet',
      suggestion: 'retry',
    };
  }

  // Rule: Orphaned (incoming for > 30 min without processing)
  if (state === 'incoming' && age > ORPHANED_THRESHOLD_MS) {
    const minutes = Math.round(age / (60 * 1000));
    return {
      type: 'stuck-in-queue',
      severity: 'warning',
      requestId: request.requestId,
      state,
      reason: `queued for ${minutes}min without being claimed`,
      suggestion: 'check worker availability',
    };
  }

  return null;
}

/**
 * Format a single request for display.
 * @param {Object} request
 * @returns {string}
 */
export function formatRequestInspection(request) {
  const lines = [];

  lines.push(`REQUEST ${request.requestId.slice(0, 8)}`);
  lines.push('');
  lines.push('State:');
  lines.push(request.state.toUpperCase());
  lines.push('');

  lines.push('Timeline:');
  for (const event of request.timeline) {
    const icon = event.status === 'complete' ? '✓' : event.status === 'failed' ? '✗' : '○';
    lines.push(`${icon} ${event.label}`);
  }

  if (request.failure_reason) {
    lines.push('');
    lines.push('Failure:');
    lines.push(request.failure_reason);
  }

  lines.push('');
  lines.push(`Retries: ${request.retry_count}`);
  lines.push(`Age: ${request.created_at ? formatDuration(Date.now() - new Date(request.created_at).getTime()) : 'unknown'}`);

  return lines.join('\n');
}

/**
 * Format milliseconds as human-readable duration.
 */
function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
