import fs from 'node:fs/promises';

import { buildStreamUrl } from './manifest.js';
import {
  normalizeStream,
  mergeStreams,
  sortStreams,
} from './normalize.js';

const DEFAULT_CONCURRENCY = 6;

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

export async function loadDiscoveryAddons() {
  const addons = [];

  // Torrentio/TorBox — generated from TORBOX_API_KEY
  if (process.env.TORBOX_API_KEY) {
    addons.push({
      addon_id: 'torrentio.torbox',
      name: 'Torrentio (TorBox)',
      manifest_url: buildTorrentioUrl('torbox', process.env.TORBOX_API_KEY),
      provider: 'torbox',
      role: 'discovery',
      enabled: true,
      sort_order: 0,
    });
  }

  // Torrentio/Real-Debrid — generated from REALDEBRID_API_KEY
  if (process.env.REALDEBRID_API_KEY) {
    addons.push({
      addon_id: 'torrentio.realdebrid',
      name: 'Torrentio (Real-Debrid)',
      manifest_url: buildTorrentioUrl('realdebrid', process.env.REALDEBRID_API_KEY),
      provider: 'realdebrid',
      role: 'discovery',
      enabled: true,
      sort_order: 1,
    });
  }

  // Comet manual manifest — optional, user-provided URL
  if (process.env.COMET_MANIFEST_URL) {
    addons.push({
      addon_id: 'comet.manual',
      name: 'Comet (manual)',
      manifest_url: process.env.COMET_MANIFEST_URL,
      provider: 'comet',
      role: 'discovery',
      enabled: true,
      sort_order: 2,
    });
  }

  if (addons.length > 0) {
    return addons;
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

export async function searchStremio({
  type,
  mediaId,
  addons,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  if (!['movie', 'series'].includes(type)) {
    throw new Error(`Invalid Stremio type: ${type}`);
  }

  if (!mediaId) {
    throw new Error('mediaId is required');
  }

  const enabledAddons =
    addons?.filter((addon) => Boolean(addon.enabled)) ??
    await loadDiscoveryAddons();

  const tasks = enabledAddons.map((addon, index) => async () => {
    const streamUrl = buildStreamUrl(
      addon.manifest_url,
      type,
      mediaId
    );

    const response = await fetch(streamUrl, {
      headers: {
        'user-agent': 'media-search/0.0.1',
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `${addon.name}: HTTP ${response.status}`
      );
    }

    const data = await response.json();
    const streams = Array.isArray(data.streams)
      ? data.streams
      : [];

    return streams
      .map((raw) =>
        normalizeStream(raw, {
          addonId: addon.addon_id,
          addonName: addon.name,
          sortOrder: addon.sort_order ?? index,
          streamType: type,
        })
      )
      .filter(Boolean);
  });

  const batches = await runPool(
    tasks.map((task) => async () => {
      try {
        return await task();
      } catch (error) {
        console.error(error.message);
        return [];
      }
    }),
    concurrency
  );

  let results = [];

  for (const batch of batches) {
    results = mergeStreams(results, batch);
  }

  return sortStreams(results);
}
