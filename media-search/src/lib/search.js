import { searchStremio } from './stremio/search.js';
import { checkTorBoxCached } from './providers/torbox.js';

export async function searchMedia(intent, dependencies = {}) {
  const startedAt = performance.now();
  const search = dependencies.searchStremio || searchStremio;
  const cacheCheck = dependencies.checkTorBoxCached || checkTorBoxCached;
  let results = await search({
    type: intent.streamType,
    mediaId: intent.mediaId,
  });
  const discoveryMs = performance.now() - startedAt;

  const hashes = results
    .map((item) => item.infoHash)
    .filter(Boolean);

  let torbox;
  let cacheStatus = 'known';
  const cacheStartedAt = performance.now();

  try {
    torbox = await cacheCheck(hashes);
  } catch (error) {
    cacheStatus = 'unknown';
    torbox = { cached: new Set(), details: new Map() };
    console.error(`TorBox cache enrichment unavailable: ${error.message}`);
  }

  results = results.map((item) => ({
    ...item,
    providers: {
      torbox: {
        cached: cacheStatus === 'known'
          ? Boolean(item.infoHash) && torbox.cached.has(item.infoHash.toLowerCase())
          : null,
      },
    },
  }));

  // Stable sort: cached TorBox releases first while preserving
  // Stremio's existing ordering within each group.
  results.sort(
    (a, b) =>
      Number(b.providers.torbox.cached === true) -
      Number(a.providers.torbox.cached === true)
  );

  return {
    intent,
    results,
    providerStatus: { torbox: cacheStatus },
    timings: {
      discoveryMs: Math.round(discoveryMs),
      torboxMs: Math.round(performance.now() - cacheStartedAt),
      totalMs: Math.round(performance.now() - startedAt),
    },
  };
}
