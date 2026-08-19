import { searchStremio } from '../lib/stremio/search.js';
import { checkTorBoxCached } from '../lib/providers/torbox.js';

const [type, mediaId] = process.argv.slice(2);

if (!type || !mediaId) {
  console.error(
    'Usage: node src/scripts/search.js <movie|series> <mediaId>'
  );
  process.exit(1);
}

console.error(`Searching Stremio for ${type} ${mediaId}...`);

let results = await searchStremio({
  type,
  mediaId,
});

console.error(`${results.length} unique result(s)`);

const hashes = results
  .map((item) => item.infoHash)
  .filter(Boolean);

console.error(
  `Checking TorBox cache for ${hashes.length} hashes...`
);

const torbox = await checkTorBoxCached(hashes);

results = results.map((item) => ({
  ...item,
  torboxCached:
    Boolean(item.infoHash) &&
    torbox.cached.has(item.infoHash.toLowerCase()),
}));

// For now, prefer TorBox-cached results before normal Stremio ordering.
results.sort(
  (a, b) =>
    Number(b.torboxCached) - Number(a.torboxCached)
);

const summary = {
  uniqueResults: results.length,
  withInfoHash: results.filter((r) => r.infoHash).length,
  torboxCached: results.filter((r) => r.torboxCached).length,
};

console.log('\nSummary:');
console.table(summary);

console.log('\nFirst 20 results:');

console.table(
  results.slice(0, 20).map((item) => ({
    resolution: item.resolution,
    quality: item.quality,
    sizeGB: item.size
      ? (item.size / 1024 ** 3).toFixed(2)
      : null,
    hash: item.infoHash?.slice(0, 12) ?? null,
    torbox: item.torboxCached ? 'CACHED' : '-',
    filename: item.filename,
  }))
);