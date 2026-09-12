/**
 * Plex consumer adapter.
 *
 * Same normalized shape as the Jellyfin adapter (IMDb id + season/episode).
 * Movies resolve from the item guid; episodes resolve the SERIES IMDb from
 * grandparentGuid and coordinates from parentIndex/index.
 *
 * NOTE: Plex integration is currently parked as an operator issue
 * (bridge→host reachability + invalid token). Until the operator repairs
 * endpoint and credential, every call here fails and the reconciler
 * records UNKNOWN (fail closed). The adapter is implemented for real so
 * no code change is needed once the operator issue is fixed. Do not fake
 * observations.
 */

const FETCH_TIMEOUT_MS = 10_000;

function baseUrl() {
  const raw = String(process.env.PLEX_URL || '').replace(/\/$/, '');
  if (!raw) throw new Error('plex-unconfigured: PLEX_URL is not set');
  return raw;
}

function token() {
  const t = String(process.env.PLEX_TOKEN || '');
  if (!t) throw new Error('plex-unconfigured: PLEX_TOKEN is not set');
  return t;
}

async function getJson(pathname, params = {}) {
  const url = new URL(baseUrl() + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const response = await fetch(url.toString(), {
    headers: { accept: 'application/json', 'X-Plex-Token': token() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`plex-http-${response.status}`);
  return response.json();
}

function imdbFromGuid(guid) {
  if (typeof guid !== 'string') return null;
  const m = guid.match(/com\.plexapp\.agents\.imdb:\/\/(tt\d+)/);
  return m ? m[1] : null;
}

/**
 * @returns {Promise<Array<{mediaId, season, episode, consumerItemId}>>}
 */
export async function listPlexLibrary() {
  const sections = await getJson('/library/sections');
  const dirs = sections?.MediaContainer?.Directory ?? [];
  const out = [];
  for (const dir of dirs) {
    if (dir.type !== 'movie' && dir.type !== 'show') continue;
    // Movies: one row per film. Shows: episode rows only (type=4); the
    // series IMDb comes from each episode's guid list, coordinates from
    // parentIndex/index. Anything unmappable is skipped, never absence.
    const params = dir.type === 'show' ? { type: 4, includeGuids: 1 } : { includeGuids: 1 };
    const items = await getJson(`/library/sections/${dir.key}/all`, params);
    for (const m of items?.MediaContainer?.Metadata ?? []) {
      const guids = Array.isArray(m.Guid) ? m.Guid : [];
      const imdb = guids.map((g) => imdbFromGuid(g.id)).find(Boolean)
        ?? imdbFromGuid(m.guid);
      if (!imdb) continue;
      if (dir.type === 'movie') {
        out.push({ mediaId: imdb, season: null, episode: null, consumerItemId: String(m.ratingKey ?? '') || null });
        continue;
      }
      const season = Number.isSafeInteger(m.parentIndex) ? m.parentIndex : null;
      const episode = Number.isSafeInteger(m.index) ? m.index : null;
      if (season == null || episode == null) continue;
      // Episodes carry their own episode IMDb in Guid; the SERIES IMDb
      // (the HashSucker mediaId) lives in grandparentGuid. Without it the
      // row is unmappable — skip, never absence.
      const seriesImdb = imdbFromGuid(m.grandparentGuid);
      if (!seriesImdb) continue;
      out.push({
        mediaId: seriesImdb, season, episode,
        consumerItemId: String(m.ratingKey ?? '') || null,
      });
    }
  }
  return out;
}

export const plexAdapter = { name: 'plex', listLibrary: listPlexLibrary };
