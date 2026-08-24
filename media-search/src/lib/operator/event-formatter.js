/**
 * Event Store Formatter
 *
 * Renders persisted lifecycle events as terminal text.
 * No cards. No charts. Plain text.
 */

/**
 * Format a timestamp as HH:MM:SS for compact display.
 */
function formatTime(isoString) {
  if (!isoString) return '--:--:--';
  try {
    const d = new Date(isoString);
    return d.toTimeString().split(' ')[0];
  } catch {
    return '--:--:--';
  }
}

/**
 * Format a duration in milliseconds to a compact string.
 */
function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m${sec}s`;
}

/**
 * Format a request timeline from the event store.
 *
 * @param {Object} timeline - { run, events } from getRequestTimeline()
 * @returns {string} Formatted text
 */
export function formatRequestTimeline(timeline) {
  if (!timeline || !timeline.run) {
    return 'REQUEST NOT FOUND\n\nNo timeline data available.';
  }

  const { run, events } = timeline;
  const lines = [];

  lines.push('REQUEST TRACE');
  lines.push('');
  lines.push(`RequestId: ${run.requestId}`);
  lines.push(`Status: ${run.finalStatus}`);
  if (run.mediaId) lines.push(`Media: ${run.mediaId}`);
  if (run.releaseKey) lines.push(`Release: ${run.releaseKey}`);
  if (run.provider) lines.push(`Provider: ${run.provider}`);
  if (run.createdAtIso) lines.push(`Created: ${run.createdAtIso}`);
  if (run.completedAtIso) lines.push(`Completed: ${run.completedAtIso}`);
  if (run.totalDurationMs != null) lines.push(`Duration: ${formatDuration(run.totalDurationMs)}`);
  if (run.failureReason) {
    lines.push('');
    lines.push('Failure:');
    lines.push(`  Stage: ${run.failureStage || 'unknown'}`);
    lines.push(`  Reason: ${run.failureReason}`);
  }

  if (events.length > 0) {
    lines.push('');
    lines.push('Timeline:');
    lines.push(`  ${'Time'.padEnd(8)} ${'Stage'.padEnd(25)} ${'Component'.padEnd(15)} ${'Duration'.padStart(10)} Status`);
    lines.push(`  ${'-'.repeat(8)} ${'-'.repeat(25)} ${'-'.repeat(15)} ${'-'.repeat(10)} ------`);
    
    for (const event of events) {
      const time = formatTime(event.timestampIso);
      const stage = formatStageName(event.stage).padEnd(25);
      const component = (event.component || '-').padEnd(15);
      const duration = event.durationMs != null ? formatDuration(event.durationMs).padStart(10) : '-'.padStart(10);
      const status = event.status === 'failed' ? '✗' : (event.status === 'completed' ? '✓' : '○');
      const error = event.errorCode ? ` [${event.errorCode}]` : '';
      lines.push(`  ${time} ${stage} ${component} ${duration} ${status}${error}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a stage name for display.
 * Converts dot-separated to title case.
 */
function formatStageName(name) {
  if (!name) return '';
  return name.split('.').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('.');
}

/**
 * Format a list of request runs.
 *
 * @param {Array<Object>} runs
 * @returns {string} Formatted text
 */
export function formatRecentRuns(runs) {
  if (!runs || runs.length === 0) {
    return 'RECENT REQUESTS\n\nNo requests found.';
  }

  const lines = [];
  lines.push('RECENT REQUESTS');
  lines.push('');
  lines.push(`  ${'ID'.padEnd(14)} ${'Status'.padEnd(12)} ${'Duration'.padStart(10)} ${'Media/Title'.padEnd(20)} Created`);
  lines.push(`  ${'-'.repeat(14)} ${'-'.repeat(12)} ${'-'.repeat(10)} ${'-'.repeat(20)} -------`);

  for (const run of runs) {
    const id = (run.requestId.substring(0, 12) + '...').padEnd(14);
    const status = (run.finalStatus === 'failed' ? '✗ ' : run.finalStatus === 'completed' ? '✓ ' : '○ ') + run.finalStatus;
    const duration = run.totalDurationMs != null ? formatDuration(run.totalDurationMs).padStart(10) : '-'.padStart(10);
    const media = (run.mediaId || run.releaseKey || '-').substring(0, 18).padEnd(20);
    const created = run.createdAtIso ? formatTime(run.createdAtIso) : '-';
    lines.push(`  ${id} ${status.padEnd(12)} ${duration} ${media} ${created}`);
  }

  return lines.join('\n');
}

/**
 * Format failed request runs.
 *
 * @param {Array<Object>} runs
 * @returns {string} Formatted text
 */
export function formatFailedRuns(runs) {
  if (!runs || runs.length === 0) {
    return 'FAILED REQUESTS\n\nNo failed requests found.';
  }

  const lines = [];
  lines.push('FAILED REQUESTS');
  lines.push('');
  lines.push(`  ${'ID'.padEnd(14)} ${'Failed Stage'.padEnd(25)} ${'Error'.padEnd(30)} ${'Elapsed'.padStart(10)}`);
  lines.push(`  ${'-'.repeat(14)} ${'-'.repeat(25)} ${'-'.repeat(30)} ${'-'.repeat(10)}`);

  for (const run of runs) {
    const id = (run.requestId.substring(0, 12) + '...').padEnd(14);
    const stage = (run.failureStage || 'unknown').padEnd(25);
    const error = (run.failureReason || '-').substring(0, 28).padEnd(30);
    const elapsed = run.totalDurationMs != null ? formatDuration(run.totalDurationMs).padStart(10) : '-'.padStart(10);
    lines.push(`  ${id} ${stage} ${error} ${elapsed}`);
  }

  return lines.join('\n');
}
