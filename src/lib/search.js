import { searchStremio } from './stremio/search.js';
import { checkTorBoxCached } from './providers/torbox.js';

export async function searchMedia(intent) {
  let results = await searchStremio({
    type: intent.streamType,
    mediaId: intent.mediaId,
  });

  const hashes = results
    .map((item) => item.infoHash)
    .filter(Boolean);

  const torbox = await checkTorBoxCached(hashes);

  results = results.map((item) => ({
    ...item,
    providers: {
      torbox: {
        cached:
          Boolean(item.infoHash) &&
          torbox.cached.has(item.infoHash.toLowerCase()),
      },
    },
  }));

  // Stable sort: cached TorBox releases first while preserving
  // Stremio's existing ordering within each group.
  results.sort(
    (a, b) =>
      Number(b.providers.torbox.cached) -
      Number(a.providers.torbox.cached)
  );

  return {
    intent,
    results,
  };
}