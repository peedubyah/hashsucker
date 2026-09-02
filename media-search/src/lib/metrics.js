/**
 * Pipeline Metrics — counters for observability.
 *
 * Not analytics UI. Just counters.
 * Exposed via /api/metrics endpoint for scraping.
 */

import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

// ─── Counters ───────────────────────────────────────────────────────────────
const counters = {
  // Pipeline
  requests_created_total: 0,
  requests_completed_total: 0,
  requests_failed_total: 0,

  // Stream
  stream_success_total: 0,
  stream_failure_total: 0,

  // Download
  download_success_total: 0,
  download_failure_total: 0,

  // Discovery
  candidate_sources_total: 0,
  torrentio_candidates: 0,
  comet_candidates: 0,
  cached_candidates: 0,
  uncached_candidates: 0,
  unknown_cache_state: 0,

  // Ranking
  winner_source_corpus: 0,
  winner_source_live: 0,
  winner_source_merged: 0,
  winner_cache_cached: 0,
  winner_cache_uncached: 0,
  winner_cache_unknown: 0,
};

// Plex refresh coalescer snapshot. Mirrored from
// createRefreshCoalescer via bindPlexMetricsSink(). Snapshot, not
// monotonic counters — the coalescer owns the source of truth.
let plexRefreshAccount = {
  refresh_requested: 0,
  refresh_coalesced: 0,
  actual_refresh_sent: 0,
  full_section_refresh: 0,
  refresh_failed: 0,
  pending: 0,
};

export function setPlexRefreshAccount(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  plexRefreshAccount = {
    refresh_requested: Number(snapshot.refresh_requested) || 0,
    refresh_coalesced: Number(snapshot.refresh_coalesced) || 0,
    actual_refresh_sent: Number(snapshot.actual_refresh_sent) || 0,
    full_section_refresh: Number(snapshot.full_section_refresh) || 0,
    refresh_failed: Number(snapshot.refresh_failed) || 0,
    pending: Number(snapshot.pending) || 0,
  };
  emitter.emit('change', 'plex_refresh', plexRefreshAccount);
}

// ─── Histograms (for score distribution) ────────────────────────────────────
const scoreBuckets = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const scoreDistribution = new Array(scoreBuckets.length).fill(0);

// ─── Top-N cache state tracking ─────────────────────────────────────────────
let top1CachedCount = 0;
let top1Total = 0;
let top10CachedCount = 0;
let top10Total = 0;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Increment a counter by 1.
 */
export function inc(counterName) {
  if (counterName in counters) {
    counters[counterName]++;
    emitter.emit('change', counterName, counters[counterName]);
  }
}

/**
 * Record a candidate score into the distribution histogram.
 */
export function recordScore(score) {
  const bucketIndex = Math.min(
    scoreBuckets.length - 1,
    Math.floor(score * scoreBuckets.length)
  );
  scoreDistribution[bucketIndex]++;
}

/**
 * Record top-N cache state for ranking analysis.
 * @param {number} position - 1-based rank position
 * @param {boolean} cached - whether the candidate is cached
 */
export function recordTopNCacheState(position, cached) {
  if (position === 1) {
    top1Total++;
    if (cached) top1CachedCount++;
  }
  if (position <= 10) {
    top10Total++;
    if (cached) top10CachedCount++;
  }
}

/**
 * Get current metrics snapshot.
 */
export function getMetrics() {
  return {
    timestamp: new Date().toISOString(),
    counters: { ...counters },
    plex_refresh: { ...plexRefreshAccount },
    ranking: {
      score_distribution: {
        buckets: scoreBuckets,
        counts: [...scoreDistribution],
      },
      top1_cached_percentage: top1Total > 0 ? top1CachedCount / top1Total : null,
      top10_cached_percentage: top10Total > 0 ? top10CachedCount / top10Total : null,
    },
  };
}

/**
 * Subscribe to metric changes.
 * @returns {Function} unsubscribe
 */
export function onMetricChange(handler) {
  emitter.on('change', handler);
  return () => emitter.off('change', handler);
}

/**
 * Get the underlying EventEmitter.
 */
export function getEmitter() {
  return emitter;
}
