import { searchStremio, loadDiscoveryAddons } from './stremio/search.js';
import { mergeStreams } from './stremio/normalize.js';
import { searchTorznab } from './torznab/torznab.js';
import { checkTorBoxCached } from './providers/torbox.js';
import { createDiscoveryCache, withCacheFailureIsolation } from './discovery/cache.js';

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
    console.error(`Discovery cache initialization failed: ${error.message}`);
  }
  return cacheInstance;
}

/**
 * Write-through discovery results to cache. Never throws — cache failures
 * are logged but do not affect the returned results.
 */
async function writeToCache(results, providerStatus) {
  const cache = getCache();
  if (!cache) return;

  const safe = withCacheFailureIsolation(cache, (error) => {
    console.error(`Discovery cache write failed: ${error.message}`);
  });

  for (const item of results) {
    const candidate = {
      infoHash: item.infoHash,
      fileIndex: item.fileIndex ?? null,
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

export async function searchMedia(intent, dependencies = {}) {
  const startedAt = performance.now();
  const search = dependencies.searchStremio || searchStremio;
  const torznabSearch = dependencies.searchTorznab || searchTorznab;
  const cacheCheck = dependencies.checkTorBoxCached || checkTorBoxCached;
  const loadAddons = dependencies.loadDiscoveryAddons || loadDiscoveryAddons;

  const mergeStreamsFn = dependencies.mergeStreams || mergeStreams;

  // Execute Stremio and Torznab searches independently
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

  const discoveryMs = performance.now() - startedAt;

  const addons = await loadAddons();
  const configuredProviders = new Set(addons?.map((a) => a.provider) || []);

  // Determine if TorBox bulk enrichment should run
  const hasTorboxKey = configuredProviders.has('torbox');
  const hashes = results
    .map((item) => item.infoHash)
    .filter(Boolean);

  let torbox;
  let torboxStatus = 'known';
  const cacheStartedAt = performance.now();

  if (hasTorboxKey && hashes.length > 0) {
    try {
      torbox = await cacheCheck(hashes);

      const failed = torbox.failed instanceof Set
        ? torbox.failed
        : new Set();

      if (failed.size > 0) {
        torboxStatus = failed.size >= new Set(hashes).size
          ? 'unknown'
          : 'partial';
      }
    } catch (error) {
      torboxStatus = 'unknown';
      torbox = {
        cached: new Set(),
        details: new Map(),
        failed: new Set(hashes),
      };
      console.error(`TorBox cache enrichment unavailable: ${error.message}`);
    }
  }

  const torboxFailed = torbox?.failed instanceof Set
    ? torbox.failed
    : new Set();

  // Build multi-provider state for each result
  results = results.map((item) => {
    const hash = item.infoHash
      ? item.infoHash.toLowerCase()
      : null;

    const resultProviders = getProvidersForResult(item);

    const providers = {};

    // TorBox state
    if (resultProviders.has('torbox') || configuredProviders.has('torbox')) {
      const cached = !hash
        ? (torboxStatus === 'unknown' ? null : false)
        : torboxFailed.has(hash)
          ? null
          : torbox?.cached.has(hash) || false;
      providers.torbox = { cached };
    }

    // Real-Debrid state — preserved for future availability semantics
    if (resultProviders.has('realdebrid') || configuredProviders.has('realdebrid')) {
      providers.realdebrid = { cached: null };
    }

    return {
      ...item,
      providers,
    };
  });

  // Stable sort: cached releases first while preserving
  // Stremio's existing ordering within each group.
  results.sort((a, b) => {
    const aCached = Object.values(a.providers).some((p) => p.cached === true);
    const bCached = Object.values(b.providers).some((p) => p.cached === true);
    return Number(bCached) - Number(aCached);
  });

  const providerStatus = {};
  if (configuredProviders.has('torbox')) {
    providerStatus.torbox = torboxStatus;
  }
  if (configuredProviders.has('realdebrid')) {
    providerStatus.realdebrid = 'configured';
  }

  // Write-through to discovery cache. Fire-and-forget: cache failures
  // never affect the search response.
  writeToCache(results, providerStatus).catch(() => {});

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
