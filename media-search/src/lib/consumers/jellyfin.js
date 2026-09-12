/**
 * Jellyfin consumer adapter.
 *
 * Lists the Jellyfin library (movies, series, episodes) and normalizes to
 * HashSucker media identity: IMDb id (+ season/episode for TV). Episodes
 * carry their own episode IMDb, so series are listed first and episodes
 * join through SeriesId to the series IMDb. Items without a usable series
 * IMDb are skipped — they can never count as presence OR absence.
 *
 * Read-only: three bounded list calls per pass. Throws on any transport /
 * auth failure so the caller records UNKNOWN, never absence.
 */

const FETCH_TIMEOUT_MS = 10_000;

function baseUrl() {
  const raw = String(process.env.JELLYFIN_URL || '').replace(/\/$/, '');
  if (!raw) throw new Error('jellyfin-unconfigured: JELLYFIN_URL is not set');
  return raw;
}

function apiKey() {
  const key = String(process.env.JELLYFIN_API_KEY || '');
  if (!key) throw new Error('jellyfin-unconfigured: JELLYFIN_API_KEY is not set');
  return key;
}

async function getJson(pathname, params = {}) {
  const url = new URL(baseUrl() + pathname);
  url.searchParams.set('api_key', apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const response = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`jellyfin-http-${response.status}`);
  return response.json();
}

function imdbOf(item) {
  const id = item?.ProviderIds?.Imdb;
  return typeof id === 'string' && /^tt\d+$/.test(id) ? id : null;
}

/**
 * @returns {Promise<Array<{mediaId, season, episode, consumerItemId}>>}
 *   season/episode are null for movies.
 */
export async function listJellyfinLibrary() {
  const [movies, series, episodes] = await Promise.all([
    getJson('/Items', {
      Recursive: true, IncludeItemTypes: 'Movie', Fields: 'ProviderIds,Path', Limit: 2000,
    }),
    getJson('/Items', {
      Recursive: true, IncludeItemTypes: 'Series', Fields: 'ProviderIds', Limit: 2000,
    }),
    getJson('/Items', {
      Recursive: true, IncludeItemTypes: 'Episode', Fields: 'ProviderIds', Limit: 5000,
    }),
  ]);
  const out = [];
  for (const m of movies?.Items ?? []) {
    const imdb = imdbOf(m);
    if (!imdb) continue;
    out.push({ mediaId: imdb, season: null, episode: null, consumerItemId: m.Id ?? null });
  }
  const seriesImdb = new Map();
  for (const s of series?.Items ?? []) {
    const imdb = imdbOf(s);
    if (imdb && s.Id) seriesImdb.set(s.Id, imdb);
  }
  for (const e of episodes?.Items ?? []) {
    const seriesId = e.SeriesId ?? null;
    const imdb = (seriesId && seriesImdb.get(seriesId)) || null;
    const season = Number.isSafeInteger(e.ParentIndexNumber) ? e.ParentIndexNumber : null;
    const episode = Number.isSafeInteger(e.IndexNumber) ? e.IndexNumber : null;
    if (!imdb || season == null || episode == null) continue;
    out.push({ mediaId: imdb, season, episode, consumerItemId: e.Id ?? null });
  }
  return out;
}

export const jellyfinAdapter = { name: 'jellyfin', listLibrary: listJellyfinLibrary };
