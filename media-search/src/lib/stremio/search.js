import fs from 'node:fs/promises';

import { buildStreamUrl } from './manifest.js';
import {
  normalizeStream,
  mergeStreams,
  sortStreams,
} from './normalize.js';
import { discoveryAccounting } from '../discovery/discovery-accounting.js';

const DEFAULT_CONCURRENCY = 6;

// Per-addon fetch bound (torznab parity): one hanging manifest must never
// stall the whole pass. Generous vs observed latencies (tens–hundreds of
// ms); a timeout is recorded per-source as a timeout disposition, and the
// remaining sources merge normally.
const ADDON_FETCH_TIMEOUT_MS = 5000;

const TORRENTIO_BASE = 'https://torrentio.strem.fun';

function buildTorrentioUrl(provider, apiKey) {
  const encoded = encodeURIComponent(apiKey);
  return `${TORRENTIO_BASE}/${provider}=${encoded}/manifest.json`;
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

/**
 * Load configured live discovery sources.
 * Env vars take precedence; falls back to local config file.
 * @returns {Array<{id, provider, debridProvider, manifestUrl, enabled}>}
 */
export async function loadDiscoveryAddons() {
  const sources = [];

  // Torrentio + TorBox (auto-generated from TORBOX_API_KEY)
  if (process.env.TORBOX_API_KEY) {
    sources.push({
      id: 'torrentio-torbox',
      provider: 'torrentio',
      debridProvider: 'torbox',
      manifestUrl: buildTorrentioUrl('torbox', process.env.TORBOX_API_KEY),
      enabled: true,
    });
  }

  // Torrentio + Real-Debrid (auto-generated from REALDEBRID_API_KEY)
  if (process.env.REALDEBRID_API_KEY) {
    sources.push({
      id: 'torrentio-realdebrid',
      provider: 'torrentio',
      debridProvider: 'realdebrid',
      manifestUrl: buildTorrentioUrl('realdebrid', process.env.REALDEBRID_API_KEY),
      enabled: true,
    });
  }

  // Comet + TorBox
  if (process.env.COMET_TORBOX_MANIFEST_URL) {
    sources.push({
      id: 'comet-torbox',
      provider: 'comet',
      debridProvider: 'torbox',
      manifestUrl: process.env.COMET_TORBOX_MANIFEST_URL,
      enabled: true,
    });
  }

  // Comet + Real-Debrid
  if (process.env.COMET_REALDEBRID_MANIFEST_URL) {
    sources.push({
      id: 'comet-realdebrid',
      provider: 'comet',
      debridProvider: 'realdebrid',
      manifestUrl: process.env.COMET_REALDEBRID_MANIFEST_URL,
      enabled: true,
    });
  }

  // Legacy single manifest (kept for backward compat)
  if (process.env.COMET_MANIFEST_URL) {
    sources.push({
      id: 'comet-manual',
      provider: 'comet',
      debridProvider: null,
      manifestUrl: process.env.COMET_MANIFEST_URL,
      enabled: true,
    });
  }

  if (sources.length > 0) {
    logDiscoverySources(sources);
    return sources;
  }

  const configUrl = new URL(
    '../../../config/addons.discovery.local.json',
    import.meta.url
  );

  const localAddons = JSON.parse(
    await fs.readFile(configUrl, 'utf8')
  );

  return localAddons.filter((addon) => Boolean(addon.enabled));
}

/**
 * Map a source object to the shape expected by searchStremio/normalizeStream.
 * The internal source model uses camelCase ({id, provider, debridProvider, manifestUrl})
 * but the Stremio pipeline expects snake_case ({addon_id, name, manifest_url, sort_order}).
 */
function toStremioAddon(source, index) {
  return {
    addon_id: source.id,
    name: source.debridProvider
      ? `${capitalize(source.provider)} (${capitalize(source.debridProvider)})`
      : capitalize(source.provider),
    manifest_url: source.manifestUrl,
    enabled: source.enabled,
    sort_order: index,
    provider: source.provider,
    debridProvider: source.debridProvider,
  };
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function logDiscoverySources(sources) {
  console.log('Live discovery sources:');
  for (const source of sources) {
    console.log(`✓ ${source.id}`);
    console.log(`  provider: ${source.provider}`);
    if (source.debridProvider) {
      console.log(`  debrid: ${source.debridProvider}`);
    }
  }
}

export async function searchStremio({
  type,
  mediaId,
  addons,
  concurrency = DEFAULT_CONCURRENCY,
  // Optional per-source observer: called exactly once per addon with
  // { addonId, addonName, provider, debridProvider, latencyMs, rawCount,
  //   parsedCount, error }. Additive only — success/failure behavior is
  // unchanged (failures still resolve to []).
  onSourceResult = null,
}) {
  if (!['movie', 'series'].includes(type)) {
    throw new Error(`Invalid Stremio type: ${type}`);
  }

  if (!mediaId) {
    throw new Error('mediaId is required');
  }

  const rawAddons = addons ?? (await loadDiscoveryAddons());
  // Map camelCase source model → snake_case addon shape expected downstream
  const enabledAddons = rawAddons
    .filter((addon) => Boolean(addon.enabled))
    .map((addon) =>
      addon.manifest_url ? addon : toStremioAddon(addon, rawAddons.indexOf(addon))
    );

  const tasks = enabledAddons.map((addon, index) => async () => {
    const startedAt = Date.now();
    const sourceMeta = {
      addonId: addon.addon_id,
      addonName: addon.name,
      provider: addon.provider || addon.provider_name || addon.addon_id,
      debridProvider: addon.debridProvider || null,
    };
    const report = (partial) => {
      if (typeof onSourceResult === 'function') {
        try {
          onSourceResult({ ...sourceMeta, latencyMs: Date.now() - startedAt, ...partial });
        } catch {
          // Observer must never break discovery.
        }
      }
    };
    const streamUrl = buildStreamUrl(
      addon.manifest_url,
      type,
      mediaId
    );

    // Account the outbound HTTP call. The accounting key is the
    // operator-assigned addonId (e.g. "torrentio-torbox") — never
    // the URL or any credential.
    discoveryAccounting.recordRequest(addon.addon_id);

    let response;
    try {
      response = await fetch(streamUrl, {
        headers: {
          'user-agent': 'media-search/0.0.1',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(ADDON_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      discoveryAccounting.recordError(addon.addon_id);
      const message = `${addon.name}: network error: ${err?.message || 'unknown'}`;
      console.error(message);
      report({ rawCount: 0, parsedCount: 0, error: message });
      return [];
    }

    if (!response.ok) {
      discoveryAccounting.recordError(addon.addon_id);
      const message = `${addon.name}: HTTP ${response.status}`;
      console.error(message);
      report({ rawCount: 0, parsedCount: 0, error: message });
      return [];
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      discoveryAccounting.recordError(addon.addon_id);
      const message = `${addon.name}: invalid JSON: ${err?.message || 'unknown'}`;
      console.error(message);
      report({ rawCount: 0, parsedCount: 0, error: message });
      return [];
    }
    const streams = Array.isArray(data.streams)
      ? data.streams
      : [];

    let normalized;
    try {
      normalized = streams
        .map((raw, sourceOrdinal) =>
          normalizeStream(raw, {
            addonId: addon.addon_id,
            addonName: addon.name,
            provider: addon.provider || addon.provider_name || addon.addon_id,
            sourceClass: 'stremio',
            sortOrder: addon.sort_order ?? index,
            streamType: type,
            // The position WITHIN this addon's response. It is source-local:
            // it is never a global rank and never compared across addons.
            sourceOrdinal,
          })
        )
        .filter(Boolean);
    } catch (err) {
      discoveryAccounting.recordError(addon.addon_id);
      const message = `${addon.name}: normalize failed: ${err?.message || 'unknown'}`;
      console.error(message);
      report({ rawCount: streams.length, parsedCount: 0, error: message });
      return [];
    }
    // Account the per-source candidate count AFTER normalization
    // (so the count is the number of bindable candidates, not the
    // raw stream list size).
    discoveryAccounting.recordCandidates(addon.addon_id, normalized.length);
    report({ rawCount: streams.length, parsedCount: normalized.length, error: null });
    return normalized;
  });

  const batches = await runPool(tasks, concurrency);

  let results = [];

  for (const batch of batches) {
    results = mergeStreams(results, batch);
  }

  return sortStreams(results);
}
