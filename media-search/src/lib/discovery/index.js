/**
 * Discovery Engine - Main Facade
 *
 * Primary entry point for discovery operations.
 * Coordinates adapters, merges results, and enriches with provider availability.
 */

import { buildDiscoveryRequest } from './request.js';
import { loadSourceRegistry } from './sources.js';
import { discoverViaStremio } from './adapters/stremio.js';
import { discoverViaTorznab } from './adapters/torznab.js';
import { mergeCandidates } from './merger.js';
import { discoverViaTorrentio } from './adapters/torrentio.js';

const ADAPTER_MAP = {
  stremio: discoverViaStremio,
  torznab: discoverViaTorznab,
  torrentio: discoverViaTorrentio
};

export async function discoverMedia(request, options = {}) {
  const globalDeadline = options.globalDeadlineMs || 10000;
  const perSourceTimeout = options.perSourceTimeoutMs || 5000;

  const sources = options.sources || loadSourceRegistry();
  const enabledSources = sources.filter((s) => s.enabled);

  if (enabledSources.length === 0) {
    return {
      candidates: [],
      sourceHealth: [],
      timings: { totalMs: 0, discoveryMs: 0 },
    };
  }

  const startTime = performance.now();

  const results = await Promise.allSettled(
    enabledSources.map((source) => executeSourceAdapter(request, source, perSourceTimeout))
  );

  const candidates = [];
  const sourceHealth = [];

  results.forEach((result, index) => {
    const source = enabledSources[index];
    if (result.status === 'fulfilled') {
      candidates.push(...result.value.candidates);
      sourceHealth.push({
        sourceId: source.id,
        status: result.value.candidates.length > 0 ? 'ok' : 'empty',
        durationMs: result.value.durationMs,
        rawCount: result.value.candidates.length,
        normalizedCount: result.value.candidates.length,
        acceptedCount: result.value.candidates.length,
      });
    } else {
      const errorMessage = result.reason?.message || 'Unknown error';
      const isTimeout = result.reason?.name === 'AbortError' || errorMessage.includes('abort');
      sourceHealth.push({
        sourceId: source.id,
        status: isTimeout ? 'timeout' : 'error',
        durationMs: perSourceTimeout,
        error: errorMessage,
        rawCount: 0,
        normalizedCount: 0,
        acceptedCount: 0,
      });
    }
  });

  const mergedCandidates = mergeCandidates(candidates);
  const discoveryMs = performance.now() - startTime;

  return {
    candidates: mergedCandidates,
    sourceHealth,
    timings: {
      discoveryMs: Math.round(discoveryMs),
      totalMs: Math.round(performance.now() - startTime),
    },
  };
}

async function executeSourceAdapter(request, source, timeoutMs) {
  const adapter = ADAPTER_MAP[source.kind];
  if (!adapter) {
    throw new Error(`No adapter registered for kind: ${source.kind}`);
  }

  const startTime = performance.now();

  const candidates = await adapter(request, {
    ...source,
    timeoutMs: source.timeoutMs || timeoutMs,
  });

  const durationMs = performance.now() - startTime;

  return {
    candidates: candidates || [],
    durationMs: Math.round(durationMs),
  };
}

export { buildDiscoveryRequest };
