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

    const failed = torbox.failed instanceof Set
      ? torbox.failed
      : new Set();

    if (failed.size > 0) {
      cacheStatus = failed.size >= new Set(hashes).size
        ? 'unknown'
        : 'partial';
    }
  } catch (error) {
    cacheStatus = 'unknown';
    torbox = {
      cached: new Set(),
      details: new Map(),
      failed: new Set(hashes),
    };
    console.error(`TorBox cache enrichment unavailable: ${error.message}`);
  }

  const failed = torbox.failed instanceof Set
    ? torbox.failed
    : new Set();

  results = results.map((item) => {
    const hash = item.infoHash
      ? item.infoHash.toLowerCase()
      : null;

    const cached = !hash
      ? (cacheStatus === 'unknown' ? null : false)
      : failed.has(hash)
        ? null
        : torbox.cached.has(hash);

    return {
      ...item,
      providers: {
        torbox: { cached },
      },
    };
  });

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
