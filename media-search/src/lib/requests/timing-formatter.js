/**
 * Request Timing Formatter
 *
 * Renders request lifecycle timing as terminal text.
 * No cards. No charts. Plain text.
 *
 * Format:
 *   REQUEST TIMELINE
 *
 *   Request.received 0ms
 *   Identity.resolved 82ms
 *   Metadata.resolved 310ms
 *   Corpus.lookup.completed 25ms
 *   Live.discovery 1240ms
 *   Ranking.completed 40ms
 *   Candidate.selected 5ms
 *   Cache.checked 620ms
 *   Handoff.created 220ms
 *   Strm.created 15ms
 *
 *   TOTAL: 2557ms
 */

/**
 * Format a request timing summary as plain terminal text.
 *
 * @param {Object} timing - Output from RequestTiming.summary() or timing field in debug response
 * @returns {string} Formatted text
 */
export function formatRequestTiming(timing) {
  if (!timing || !timing.stages) {
    return 'REQUEST TIMELINE\n\nNo timing data available.';
  }

  const lines = [];
  lines.push('REQUEST TIMELINE');
  lines.push('');

  const stages = timing.stages;
  const stageEntries = Object.entries(stages);

  // Sort by startedAt to show chronological order
  stageEntries.sort((a, b) => {
    const aTime = a[1].startedAt || '';
    const bTime = b[1].startedAt || '';
    return aTime.localeCompare(bTime);
  });

  for (const [name, stage] of stageEntries) {
    const duration = stage.durationMs ?? 0;
    const status = stage.status === 'failed' ? ' ✗' : '';
    lines.push(`  ${formatStageName(name)} ${Math.round(duration)}ms${status}`);
  }

  lines.push('');
  lines.push(`TOTAL: ${Math.round(timing.totalDurationMs ?? sumDurations(stages))}ms`);

  return lines.join('\n');
}

/**
 * Format a stage name for display.
 * Converts camelCase or dot-separated to title case.
 *
 * @param {string} name - Stage name (e.g., 'live.discovery', 'corpusLookup')
 * @returns {string} Formatted name
 */
function formatStageName(name) {
  // Handle dot-separated names
  if (name.includes('.')) {
    const parts = name.split('.');
    return parts.map(capitalize).join('.');
  }
  // Handle camelCase
  return name
    .replace(/([A-Z])/g, '.$1')
    .split('.')
    .filter(Boolean)
    .map(capitalize)
    .join('.');
}

/**
 * Capitalize the first letter of a string.
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Sum all stage durations.
 */
function sumDurations(stages) {
  let total = 0;
  for (const stage of Object.values(stages)) {
    if (stage.durationMs != null) {
      total += stage.durationMs;
    }
  }
  return total;
}

/**
 * Format a search trace timing as plain terminal text.
 *
 * @param {Object} timing - Output from searchTrace().timing
 * @returns {string} Formatted text
 */
export function formatSearchTiming(timing) {
  if (!timing || !timing.stages) {
    return 'SEARCH TIMING\n\nNo timing data available.';
  }

  const lines = [];
  lines.push('SEARCH TIMING');
  lines.push('');

  const stages = timing.stages;
  const stageEntries = Object.entries(stages);

  // Sort by startedAt
  stageEntries.sort((a, b) => {
    const aTime = a[1].startedAt || '';
    const bTime = b[1].startedAt || '';
    return aTime.localeCompare(bTime);
  });

  for (const [name, stage] of stageEntries) {
    const duration = stage.durationMs ?? 0;
    const status = stage.status === 'failed' ? ' ✗' : '';
    lines.push(`  ${formatStageName(name)} ${Math.round(duration)}ms${status}`);
  }

  lines.push('');
  lines.push(`TOTAL: ${Math.round(timing.totalDurationMs ?? sumDurations(stages))}ms`);

  return lines.join('\n');
}

/**
 * Format timing comparison between multiple requests.
 * Useful for seeing how the same query performs over time.
 *
 * @param {Array<Object>} timings - Array of timing summaries
 * @returns {string} Formatted text
 */
export function formatTimingComparison(timings) {
  if (!timings || timings.length === 0) {
    return 'TIMING COMPARISON\n\nNo timing data available.';
  }

  const lines = [];
  lines.push('TIMING COMPARISON');
  lines.push('');

  // Get all unique stage names
  const stageNames = new Set();
  for (const t of timings) {
    if (t.stages) {
      Object.keys(t.stages).forEach(n => stageNames.add(n));
    }
  }

  const sortedNames = Array.from(stageNames).sort();

  // Header
  lines.push(`  ${'Stage'.padEnd(25)} ${'Latest'.padStart(10)} ${'Average'.padStart(10)} ${'Min'.padStart(10)} ${'Max'.padStart(10)}`);
  lines.push(`  ${'-'.repeat(25)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);

  for (const name of sortedNames) {
    const durations = [];
    for (const t of timings) {
      if (t.stages?.[name]?.durationMs != null) {
        durations.push(t.stages[name].durationMs);
      }
    }

    if (durations.length === 0) continue;

    const latest = durations[durations.length - 1];
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);

    lines.push(
      `  ${formatStageName(name).padEnd(25)} ` +
      `${Math.round(latest).toString().padStart(8)}ms ` +
      `${Math.round(avg).toString().padStart(8)}ms ` +
      `${Math.round(min).toString().padStart(8)}ms ` +
      `${Math.round(max).toString().padStart(8)}ms`
    );
  }

  return lines.join('\n');
}

/**
 * Format a failed request trace as plain terminal text.
 *
 * Shows the failure point, error details, and all previous successful stages.
 *
 * @param {Object} debug - Debug response from getRequestDebug()
 * @returns {string} Formatted text
 */
export function formatFailedRequest(debug) {
  if (!debug || !debug.found) {
    return 'REQUEST NOT FOUND\n\nNo request data available.';
  }

  const lines = [];
  lines.push('REQUEST FAILED');
  lines.push('');

  // Request ID
  lines.push('RequestId:');
  lines.push(`  ${debug.requestId}`);
  lines.push('');

  // Failure details from timing
  const timing = debug.timing || debug.request?.timing;
  const failure = timing?.failure || debug.failure;

  if (failure) {
    lines.push('Failure:');
    lines.push(`  Stage=${failure.stage || 'unknown'}`);
    if (failure.errorCode) {
      lines.push(`  Reason=${failure.errorCode}`);
    }
    if (failure.error) {
      lines.push(`  Error=${failure.error}`);
    }
    if (failure.component) {
      lines.push(`  Component=${failure.component}`);
    }
    if (failure.elapsedMs != null) {
      lines.push(`  Elapsed=${Math.round(failure.elapsedMs)}ms`);
    }
    lines.push('');
  }

  // Timeline
  if (timing?.stages) {
    lines.push('Timeline:');

    const stageEntries = Object.entries(timing.stages);
    stageEntries.sort((a, b) => {
      const aTime = a[1].startedAt || '';
      const bTime = b[1].startedAt || '';
      return aTime.localeCompare(bTime);
    });

    for (const [name, stage] of stageEntries) {
      const duration = stage.durationMs ?? 0;
      const isFailed = stage.status === 'failed';
      const isCompleted = stage.status === 'completed' || stage.status === 'complete';
      const prefix = isFailed ? '✗' : (isCompleted ? '✓' : '○');
      lines.push(`  ${prefix} ${formatStageName(name)} ${Math.round(duration)}ms`);
    }
  }

  // Error details from debug response
  if (debug.finalState?.lastError) {
    lines.push('');
    lines.push('Last Error:');
    lines.push(`  ${debug.finalState.lastError}`);
  }

  return lines.join('\n');
}
