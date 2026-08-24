/**
 * Worker Visibility Formatter
 *
 * Renders worker lifecycle information as terminal text.
 * No cards. No charts. Plain text.
 *
 * Format:
 *   WORKERS
 *
 *   Worker-1
 *   Status: running
 *   Heartbeat: 12s ago
 *   Active job: d80b11307
 *
 *   Completed: 421
 *   Failed: 3
 */

/**
 * Format worker status as plain terminal text.
 *
 * @param {Object} status - Output from WorkerVisibility.getStatus()
 * @returns {string} Formatted text
 */
export function formatWorkerStatus(status) {
  if (!status) {
    return 'WORKERS\n\nNo worker data available.';
  }

  const lines = [];
  lines.push('WORKERS');
  lines.push('');

  // Status line with emoji indicator
  const statusIndicator = {
    running: '●',
    idle: '○',
    stuck: '✗',
    error: '✗',
  }[status.status] || '?';

  lines.push(`  Worker-1`);
  lines.push(`  Status: ${status.status === 'running' ? 'running' : status.status} ${statusIndicator}`);
  
  // Last heartbeat
  if (status.lastHeartbeatMs != null) {
    const heartbeat = formatDuration(status.lastHeartbeatMs);
    lines.push(`  Heartbeat: ${heartbeat}`);
  } else {
    lines.push(`  Heartbeat: never`);
  }

  // Active job
  if (status.currentRequestId) {
    lines.push(`  Active job: ${status.currentRequestId.substring(0, 12)}...`);
  } else {
    lines.push(`  Active job: none`);
  }

  lines.push('');

  // Job counts
  lines.push(`  Queued: ${status.queuedJobs}`);
  lines.push(`  Active: ${status.activeJobs}`);
  lines.push(`  Completed: ${status.completedJobs}`);
  lines.push(`  Failed: ${status.failedJobs}`);

  // Stuck jobs
  if (status.stuckJobs.length > 0) {
    lines.push('');
    lines.push(`  Stuck Jobs (${status.stuckJobs.length}):`);
    for (const stuck of status.stuckJobs) {
      lines.push(`    ${stuck.requestId.substring(0, 12)}... (${stuck.durationMin}min)`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration
 */
function formatDuration(ms) {
  if (ms < 1000) return 'just now';
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  return `${Math.round(ms / 3600000)}h ago`;
}
