import { createRequestIntent } from '../lib/requests/intent.js';
import { searchMedia } from '../lib/search.js';
import { createHandoff } from '../lib/requests/handoff.js';
import { queueHandoff } from '../lib/requests/queue.js';

const [type, mediaId] = process.argv.slice(2);

if (!type || !mediaId) {
  console.error(
    'Usage: node src/scripts/search.js <movie|series> <mediaId>'
  );
  process.exit(1);
}

const intent = createRequestIntent({
  type,
  mediaId,
});

console.log('\nRequest intent:');
console.log(JSON.stringify(intent, null, 2));

console.error(
  `\nSearching Stremio for ${intent.streamType} ${intent.mediaId}...`
);

const search = await searchMedia(intent);
const results = search.results;

const summary = {
  uniqueResults: results.length,
  withInfoHash: results.filter((r) => r.infoHash).length,
  torboxCached: results.filter(
    (r) => r.providers.torbox.cached
  ).length,
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
    torbox: item.providers.torbox.cached
      ? 'CACHED'
      : '-',
    filename: item.filename,
  }))
);

const selected = results.find(
  (item) => item.providers.torbox.cached
);

if (selected) {
  const handoff = createHandoff({
    intent,
    release: selected,
    provider: 'torbox',
  });

  console.log('\nExample handoff using first TorBox-cached result:');
  console.log(JSON.stringify(handoff, null, 2));

  const queuedPath = await queueHandoff(handoff);
  console.log(`\nQueued request: ${queuedPath}`);
}