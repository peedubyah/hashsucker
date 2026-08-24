/**
 * Enrichment Diagnostics
 *
 * Aggregate observability for the identity enrichment pipeline.
 * Collects corpus-wide metrics for monitoring resolver effectiveness,
 * coverage gaps, and confidence distributions.
 *
 * Metrics collected:
 * - candidate_media coverage (total, with media, with resolved media)
 * - resolver success rates (per-source resolution stats)
 * - confidence distribution (buckets: very_high/high/medium/low/very_low)
 * - unresolved candidate counts (pending + retryable failed)
 * - match method distribution (how associations were created)
 *
 * Guarantees:
 * - Read-only: never modifies the cache
 * - No ranking behavior changes
 * - Never throws: returns empty/zeroed metrics if cache is empty
 */

/**
 * Gather all enrichment diagnostics into a single snapshot.
 *
 * @param {Object} cache - Discovery cache instance
 * @returns {Object} Diagnostics snapshot
 */
export function getEnrichmentDiagnostics(cache) {
  if (!cache) {
    throw new Error('getEnrichmentDiagnostics requires a cache');
  }

  const queueStats = cache.getEnrichmentStats();
  const coverage = cache.getCandidateMediaCoverage();
  const resolverRates = cache.getResolverSuccessRates();
  const confidenceDist = cache.getConfidenceDistribution();
  const unresolved = cache.getUnresolvedStats();
  const matchMethods = cache.getMatchMethodDistribution();
  const resolutionStates = cache.getResolutionStateDistribution();

  // Compute derived metrics
  const totalResolved = queueStats.resolved || 0;
  const totalFailed = queueStats.failed || 0;
  const totalProcessed = totalResolved + totalFailed;
  const overallSuccessRate = totalProcessed > 0 ? totalResolved / totalProcessed : 0;

  // Compute average confidence (weighted by bucket midpoint)
  const confidenceMidpoints = {
    very_high: 0.95,
    high: 0.8,
    medium: 0.6,
    low: 0.4,
    very_low: 0.15,
  };
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const [bucket, count] of Object.entries(confidenceDist)) {
    confidenceSum += (confidenceMidpoints[bucket] || 0) * count;
    confidenceCount += count;
  }
  const averageConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;

  return {
    timestamp: new Date().toISOString(),
    queue: {
      total: queueStats.total,
      pending: queueStats.pending,
      processing: queueStats.processing,
      resolved: queueStats.resolved,
      failed: queueStats.failed,
      unresolved: unresolved.totalUnresolved,
    },
    coverage: {
      totalCandidates: coverage.totalCandidates,
      candidatesWithMedia: coverage.candidatesWithMedia,
      candidatesWithResolvedMedia: coverage.candidatesWithResolvedMedia,
      coveragePercentage: coverage.coveragePercentage,
      resolvedPercentage: coverage.resolvedPercentage,
    },
    resolverPerformance: {
      overallSuccessRate,
      bySource: resolverRates,
    },
    confidence: {
      distribution: confidenceDist,
      average: averageConfidence,
    },
    matchMethods,
    resolutionStates,
  };
}

/**
 * Format diagnostics as human-readable text for console/terminal output.
 *
 * @param {Object} diagnostics - Output from getEnrichmentDiagnostics()
 * @returns {string} Formatted text
 */
export function formatEnrichmentDiagnostics(diagnostics) {
  const lines = [];
  lines.push('=== Identity Enrichment Diagnostics ===');
  lines.push(`Generated: ${diagnostics.timestamp}`);
  lines.push('');

  // Queue summary
  lines.push('Queue Summary:');
  lines.push(`  Total:      ${diagnostics.queue.total}`);
  lines.push(`  Pending:    ${diagnostics.queue.pending}`);
  lines.push(`  Processing: ${diagnostics.queue.processing}`);
  lines.push(`  Resolved:   ${diagnostics.queue.resolved}`);
  lines.push(`  Failed:     ${diagnostics.queue.failed}`);
  lines.push(`  Unresolved: ${diagnostics.queue.unresolved}`);
  lines.push('');

  // Coverage
  lines.push('Candidate Coverage:');
  lines.push(`  Total Candidates:          ${diagnostics.coverage.totalCandidates}`);
  lines.push(`  With Media:                ${diagnostics.coverage.candidatesWithMedia}`);
  lines.push(`  With Resolved Media:       ${diagnostics.coverage.candidatesWithResolvedMedia}`);
  lines.push(`  Coverage:                  ${(diagnostics.coverage.coveragePercentage * 100).toFixed(1)}%`);
  lines.push(`  Resolved:                  ${(diagnostics.coverage.resolvedPercentage * 100).toFixed(1)}%`);
  lines.push('');

  // Resolver performance
  lines.push('Resolver Performance:');
  lines.push(`  Overall Success Rate:      ${(diagnostics.resolverPerformance.overallSuccessRate * 100).toFixed(1)}%`);
  if (diagnostics.resolverPerformance.bySource.length > 0) {
    lines.push('  By Source:');
    for (const source of diagnostics.resolverPerformance.bySource) {
      lines.push(`    ${source.resolverSource}: ${source.resolved}/${source.totalAttempts} (${(source.successRate * 100).toFixed(1)}%)`);
    }
  }
  lines.push('');

  // Confidence
  lines.push('Confidence Distribution:');
  lines.push(`  Average: ${diagnostics.confidence.average.toFixed(2)}`);
  lines.push(`  Very High (>=0.9): ${diagnostics.confidence.distribution.very_high}`);
  lines.push(`  High (0.7-0.9):    ${diagnostics.confidence.distribution.high}`);
  lines.push(`  Medium (0.5-0.7):  ${diagnostics.confidence.distribution.medium}`);
  lines.push(`  Low (0.3-0.5):     ${diagnostics.confidence.distribution.low}`);
  lines.push(`  Very Low (<0.3):   ${diagnostics.confidence.distribution.very_low}`);
  lines.push('');

  // Match methods
  lines.push('Match Methods:');
  if (diagnostics.matchMethods.length > 0) {
    for (const method of diagnostics.matchMethods) {
      lines.push(`  ${method.matchMethod}: ${method.count}`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  // Resolution states
  lines.push('Resolution States:');
  if (diagnostics.resolutionStates && diagnostics.resolutionStates.length > 0) {
    for (const state of diagnostics.resolutionStates) {
      lines.push(`  ${state.resolutionState}: ${state.count}`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  return lines.join('\n');
}
