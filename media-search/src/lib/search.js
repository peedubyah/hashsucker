import { createReleaseIdentity } from '../api/release-contract.js';
import { emit, EVENTS } from '../lib/trace/events.js';
import { searchStremio, loadDiscoveryAddons } from './stremio/search.js';
import { mergeStreams } from './stremio/normalize.js';
import { searchTorznab } from './torznab/torznab.js';
import { checkTorBoxCached } from './providers/torbox.js';
import { createDiscoveryCache, withCacheFailureIsolation, StaleWhileRefresher } from './discovery/cache.js';

// Module-level cache singleton. Cache is additive: live discovery remains
// authoritative. Cache write failures never affect search responses.
let cacheInstance = null;
let cacheInitError = null;

function getCache() {
  if (cacheInstance || cacheInitError) return cacheInstance;
  try {
    const dbPath = process.env.DISCOVERY_CACHE_PATH || '/config/discovery-cache.db';
    cacheInstance = createDiscoveryCache({ dbPath });
  } catch (error) {
    cacheInitError = error;
    emit(EVENTS.DISCOVERY_ERROR, { scope: 'cache_init', error: error.message });
  }
  return cacheInstance;
}

/**
 * Reset the module-level cache singleton. Used by tests to isolate cache state
 * between test cases. Not part of the public API.
 */
export function _resetCacheForTests() {
  if (cacheInstance) {
    try { cacheInstance.close(); } catch {}
  }
  cacheInstance = null;
  cacheInitError = null;
}

/**
 * Get the current cache instance for test inspection. Not part of the public API.
 */
export function _getCacheForTests() {
  return getCache();
}

/**
 * Write-through discovery results to cache. Never throws — cache failures
 * are logged but do not affect the returned results.
 */
async function writeToCache(results, providerStatus, searchKey = null) {
  const cache = getCache();
  if (!cache || cache.isClosed()) return;

  const safe = withCacheFailureIsolation(cache, (error) => {
    if (!cache.isClosed()) {
        emit(EVENTS.DISCOVERY_ERROR, { scope: 'cache_write', error: error.message });

  for (const item of results) {
    const candidate = {
      infoHash: item.infoHash,
      fileIndex: item.fileIndex ?? null,
      searchKey,
      title: item.title,
      filename: item.filename,
      size: item.size,
      seeders: item.seeders,
      leechers: item.leechers,
      publishDate: item.publishDate,
      magnet: item.magnet,
      downloadUrl: item.downloadUrl,
      metadata: item.metadata || {},
      sources: item.sources || [],
    };

    await safe.ingestCandidate(candidate);

    // Record provider observations separately from the candidate
    for (const [provider, state] of Object.entries(item.providers || {})) {
      if (state && state.cached !== undefined) {
        await safe.recordProviderObservation(item.infoHash, item.fileIndex, provider, {
          cached: state.cached,
          evidence: state.evidence,
          checkedAt: Date.now(),
        });
      }
    }
  }
}

function getProvidersForResult(result) {
  const providers = new Set();
  for (const source of result.sources || []) {
    if (source.provider) {
      providers.add(source.provider);
    } else if (source.addonId === 'torrentio.torbox') {
      providers.add('torbox');
    } else if (source.addonId === 'torrentio.realdebrid') {
      providers.add('realdebrid');
    }
  }
  return providers;
}

/**
 * Convert a cache candidate into a normalized search result shape.
 * Preserves all candidate fields and adds a sources array from the candidate.
 */
function candidateToResult(candidate) {
  const identity = createReleaseIdentity(candidate.infoHash, candidate.fileIndex);
  return {
    key: identity.releaseKey,
    ...identity,
    title: candidate.title,
    filename: candidate.filename,
    size: candidate.size,
    seeders: candidate.seeders,
    leechers: candidate.leechers,
    publishDate: candidate.publishDate,
    magnet: candidate.magnet,
    downloadUrl: candidate.downloadUrl,
    metadata: candidate.metadata || {},
    sources: candidate.sources || [],
    behaviorHints: {},
    raw: null,
  };
}

/**
 * Execute live discovery pipeline (Stremio + Torznab adapters).
 * Extracted for reuse by both cache miss and background refresh paths.
 */
async function runLiveDiscovery(intent, search, torznabSearch, mergeStreamsFn) {
  const [stremioResults, torznabResults] = await Promise.allSettled([
    search({
      type: intent.streamType,
      mediaId: intent.mediaId,
    }),
    torznabSearch({
      type: intent.streamType,
      mediaId: intent.mediaId,
    }),
  ]);

  let results = [];
  if (stremioResults.status === 'fulfilled') {
    results = stremioResults.value;
  }
  if (torznabResults.status === 'fulfilled') {
    results = mergeStreamsFn(results, torznabResults.value);
  }
  return results;
}

/**
 * Enrich results with provider cache state and write through to discovery cache.
 * Shared by both live discovery and cache read paths.
 */
async function enrichAndFinalize(results, intent, dependencies) {
  const loadAddons = dependencies.loadDiscoveryAddons || loadDiscoveryAddons;
  const cacheCheck = dependencies.checkTorBoxCached || checkTorBoxCached;

  const startedAt = performance.now();
  const addons = await loadAddons();
  const configuredProviders = new Set(addons?.map((a) => a.debridProvider).filter(Boolean) || []);

  const hasTorboxKey = configuredProviders.has('torbox');
  const hashes = results.map((item) => item.infoHash).filter(Boolean);

  let torbox;
  let torboxStatus = 'known';
  const cacheStartedAt = performance.now();

  if (hasTorboxKey && hashes.length > 0) {
    try {
      torbox = await cacheCheck(hashes);
      const failed = torbox.failed instanceof Set ? torbox.failed : new Set();
      if (failed.size > 0) {
        torboxStatus = failed.size >= new Set(hashes).size ? 'unknown' : 'partial';
      }
    } catch (error) {
      torboxStatus = 'unknown';
      torbox = { cached: new Set(), details: new Map(), failed: new Set(hashes) };
      console.error(`TorBox cache enrichment unavailable: ${error.message}`);
    }
  }

  const torboxFailed = torbox?.failed instanceof Set ? torbox.failed : new Set();

  results = results.map((item) => {
    const hash = item.infoHash ? item.infoHash.toLowerCase() : null;
    const resultProviders = getProvidersForResult(item);
    const providers = {};

    if (resultProviders.has('torbox') || configuredProviders.has('torbox')) {
      const cached = !hash
        ? (torboxStatus === 'unknown' ? null : false)
        : torboxFailed.has(hash) ? null : torbox?.cached.has(hash) || false;
      providers.torbox = { cached };
    }
    if (resultProviders.has('realdebrid') || configuredProviders.has('realdebrid')) {
      providers.realdebrid = { cached: null };
    }
    return { ...item, providers };
  });

  results.sort((a, b) => {
    const aCached = Object.values(a.providers).some((p) => p.cached === true);
    const bCached = Object.values(b.providers).some((p) => p.cached === true);
    return Number(bCached) - Number(aCached);
  });

  const providerStatus = {};
  if (configuredProviders.has('torbox')) providerStatus.torbox = torboxStatus;
  if (configuredProviders.has('realdebrid')) providerStatus.realdebrid = 'configured';

  writeToCache(results, providerStatus, intent.mediaId).catch(() => {});

  return { results, providerStatus, cacheStartedAt, startedAt };
}

export async function searchMedia(intent, dependencies = {}) {
  const startedAt = performance.now();
  const search = dependencies.searchStremio || searchStremio;
  const torznabSearch = dependencies.searchTorznab || searchTorznab;
  const mergeStreamsFn = dependencies.mergeStreams || mergeStreams;
  const cache = getCache();

  // Cache read path: stale-while-refresh
  if (cache) {
    const refresher = new StaleWhileRefresher({
      cache,
      maxAgeMs: 30000,
      searchKey: intent.mediaId,
      withObservations: false,
      refresh: async () => {
        const liveResults = await runLiveDiscovery(intent, search, torznabSearch, mergeStreamsFn);
        await enrichAndFinalize(liveResults, intent, dependencies);
      },
    });

    const cacheResult = await refresher.query();

    if (cacheResult.status === 'fresh') {
      const candidates = cacheResult.candidates.map(candidateToResult);
      const { results, providerStatus } = await enrichAndFinalize(candidates, intent, dependencies);
      return {
        intent,
        results,
        providerStatus,
        fromCache: true,
        timings: {
          discoveryMs: Math.round(performance.now() - startedAt),
          torboxMs: 0,
          totalMs: Math.round(performance.now() - startedAt),
        },
      };
    }

    if (cacheResult.status === 'stale') {
      const candidates = cacheResult.candidates.map(candidateToResult);
      const { results, providerStatus } = await enrichAndFinalize(candidates, intent, dependencies);
      return {
        intent,
        results,
        providerStatus,
        fromCache: true,
        timings: {
          discoveryMs: Math.round(performance.now() - startedAt),
          torboxMs: 0,
          totalMs: Math.round(performance.now() - startedAt),
        },
      };
    }
    // fall through to live discovery on miss
  }

  // Live discovery path (cache miss or no cache)
  const discoveryMs = performance.now() - startedAt;
  const liveResults = await runLiveDiscovery(intent, search, torznabSearch, mergeStreamsFn);
  const { results, providerStatus, cacheStartedAt } = await enrichAndFinalize(
    liveResults, intent, dependencies
  );

  return {
    intent,
    results,
    providerStatus,
    timings: {
      discoveryMs: Math.round(discoveryMs),
      torboxMs: Math.round(performance.now() - cacheStartedAt),
      totalMs: Math.round(performance.now() - startedAt),
    },
  };
}
