import fs from 'node:fs/promises';

import { checkTorBoxCached } from '../lib/providers/torbox.js';

import { buildStreamUrl } from '../lib/stremio/manifest.js';
import {
  normalizeStream,
  mergeStreams,
  sortStreams,
} from '../lib/stremio/normalize.js';

const [type, mediaId] = process.argv.slice(2);

if (!type || !mediaId) {
  console.error('Usage: node src/scripts/search.js <movie|series> <mediaId>');
  console.error('Example: node src/scripts/search.js series tt0944947:1:1');
  process.exit(1);
}

if (!['movie', 'series'].includes(type)) {
  console.error(`Invalid type: ${type}`);
  process.exit(1);
}

const configUrl = new URL('../../config/addons.discovery.local.json', import.meta.url);
const addons = JSON.parse(await fs.readFile(configUrl, 'utf8'))
  .filter((addon) => Boolean(addon.enabled));

if (addons.length === 0) {
  console.error('No enabled Stremio addons.');
  process.exit(1);
}

console.error(`Searching ${addons.length} addon(s) for ${type} ${mediaId}`);

const batches = await Promise.all(
  addons.map(async (addon, index) => {
    const streamUrl = buildStreamUrl(
      addon.manifest_url,
      type,
      mediaId
    );

    console.error(`→ ${addon.name}`);

    try {
      const response = await fetch(streamUrl, {
        headers: {
          'user-agent': 'media-search/0.0.1',
          accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const streams = Array.isArray(data.streams) ? data.streams : [];

      const normalized = streams
        .map((raw) =>
          normalizeStream(raw, {
            addonId: addon.addon_id,
            addonName: addon.name,
            sortOrder: addon.sort_order ?? index,
            streamType: type,
          })
        )
        .filter(Boolean);

      console.error(`  ${normalized.length} usable result(s)`);

      return normalized;
    } catch (error) {
      console.error(`  ERROR: ${error.message}`);
      return [];
    }
  })
);

let results = [];

for (const batch of batches) {
  results = mergeStreams(results, batch);
}

results = sortStreams(results);

console.error(`\n${results.length} unique result(s)`);

const hashes = results
  .map((result) => result.infoHash)
  .filter(Boolean);

console.error(`Checking TorBox cache for ${hashes.length} hashes...`);

const torbox = await checkTorBoxCached(hashes);

results = results.map((item) => ({
  ...item,
  torboxCached: item.infoHash
    ? torbox.cached.has(item.infoHash.toLowerCase())
    : false,
}));

console.error(
  `${torbox.cached.size} TorBox cached result(s)\n`
);

const summary = {
  uniqueResults: results.length,
  withInfoHash: results.filter((r) => r.infoHash).length,
  torboxCached: results.filter((r) => r.torboxCached).length,
  withUrl: results.filter((r) => r.url).length,
  withNzb: results.filter((r) => r.nzbUrl).length,
};

console.log('\nSummary:');
console.table(summary);

console.log('\nFirst 20 results:');

console.table(
  results.slice(0, 20).map((item) => ({
    resolution: item.resolution,
    quality: item.quality,
    sizeGB: item.size ? (item.size / 1024 ** 3).toFixed(2) : null,
    hash: item.infoHash ? item.infoHash.slice(0, 12) : null,
    url: Boolean(item.url),
    torbox: item.torboxCached ? 'CACHED' : '-',
    filename: item.filename,
  }))
);