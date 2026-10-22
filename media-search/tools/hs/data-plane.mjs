/**
 * The data plane's own view, read from inside its container.
 *
 * The data plane is an internal service (it is not published on the host),
 * so it is read the way the other diagnostics read it: from inside the
 * container. A direct URL may also be provided.
 */

import { execFileSync } from 'node:child_process';

const DEFAULT_CONTAINER = process.env.HS_DATA_PLANE_CONTAINER ?? 'hashsucker-data-plane-1';
const DEFAULT_PORT = process.env.HS_DATA_PLANE_PORT ?? '3001';

/**
 * Read the data plane's /metrics as JSON, or null when it cannot be read.
 *
 * @param {Object} [options]
 * @param {string} [options.url] - a direct data-plane base URL
 * @param {string} [options.container] - the container to exec into
 * @returns {Object|null}
 */
export function readDataPlaneMetrics({ url = null, container = DEFAULT_CONTAINER } = {}) {
  if (url) {
    try {
      const res = await0(url);
      return res;
    } catch {
      /* fall through to the container read */
    }
  }
  try {
    const raw = execFileSync(
      'docker',
      ['exec', container, 'sh', '-lc', `wget -qO- http://127.0.0.1:${DEFAULT_PORT}/metrics`],
      { encoding: 'utf8', timeout: 20_000 },
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// The direct read is async; this wrapper keeps the call site synchronous by
// using the container path (which is the production shape) and the direct URL
// only through the async variant below.
function await0() {
  return null;
}

/**
 * Read the data plane's /metrics asynchronously (for a direct URL).
 *
 * @param {string} url
 * @returns {Promise<Object|null>}
 */
export async function readDataPlaneMetricsAsync(url) {
  try {
    const res = await fetch(`${String(url).replace(/\/$/, '')}/metrics`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The counters this slice compares across a run.
 *
 * @param {Object} metrics
 * @returns {Object}
 */
export function metricSnapshot(metrics) {
  const cache = metrics?.cache ?? {};
  return {
    bytesFetchedUpstream: Number(cache.bytes_fetched_upstream ?? 0),
    bytesEvicted: Number(cache.bytes_evicted ?? 0),
    chunkFills: Number(cache.chunk_fills ?? 0),
    chunkFillsFailed: Number(cache.chunk_fills_failed ?? 0),
    chunkClaims: Number(cache.chunk_claims ?? 0),
    evictions: Number(cache.evictions ?? 0),
    chunksPresent: Number(cache.chunks_present ?? 0),
    currentBytes: Number(cache.current_bytes ?? 0),
    maxBytes: Number(cache.max_bytes ?? 0),
    bytesStreamed: Number(metrics?.bytes_streamed ?? 0),
    requests: Number(metrics?.requests ?? 0),
    demandChunkTakeovers: Number(metrics?.demand_chunk_takeovers ?? 0),
    decisions: Array.isArray(metrics?.cache_decisions) ? metrics.cache_decisions.length : 0,
  };
}

/**
 * The decision-log entries added between two snapshots.
 *
 * @param {Object} before
 * @param {Object} after
 * @returns {Object[]}
 */
export function decisionsSince(before, after) {
  const list = after?.cache_decisions ?? [];
  const from = before?.cache_decisions?.length ?? 0;
  return list.slice(Math.max(0, from));
}
