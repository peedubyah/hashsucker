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

// The transport lives in its own module so the consumer adapter and the
// projection observer share one way of talking to Plex.
import { getJson } from './plex-transport.js';

function imdbFromGuid(guid) {
  if (typeof guid !== 'string') return null;
  const m = guid.match(/(?:com\.plexapp\.agents\.imdb:\/\/|imdb:\/\/)(tt\d+)/);
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

export async function confirmPlexEpisode({ mediaId, season, episode, expectedPartFile = null }) {
  // Movies carry no season/episode coordinates: match by IMDb guid in the
  // movies section and verify the authoritative part file, exactly like
  // the episode path below. Without this branch movie publications could
  // never confirm (the TV lookup cannot match them) and wedged in
  // published_preparing forever despite exact Plex visibility.
  if (season == null || episode == null) {
    const sectionId = process.env.PLEX_MOVIES_SECTION_ID;
    if (!sectionId) return { visible: false, ratingKey: null, mediaPart: null };
    const all = await getJson(`/library/sections/${sectionId}/all`, { includeGuids: 1 });
    const found = (all?.MediaContainer?.Metadata ?? []).find((candidate) => {
      const ids = (candidate.Guid ?? []).map((g) => imdbFromGuid(g.id));
      return ids.includes(mediaId);
    });
    if (!found) return { visible: false, ratingKey: null, mediaPart: null };
    const movie = (await getJson(found.key, { includeExtras: 0, includeMarkers: 0, includeRelated: 0 }))?.MediaContainer?.Metadata?.[0] ?? found;
    // Multi-edition items carry several Parts: match the authoritative
    // projection when one is expected, otherwise take the first file.
    // (Taking the first Part and comparing afterwards misconfirms
    // whenever our edition is not listed first.)
    const movieParts = movie.Media?.flatMap((m) => m.Part ?? []).filter((p) => p.file) ?? [];
    const exactMoviePart = expectedPartFile
      ? movieParts.find((p) => p.file === expectedPartFile) ?? null
      : movieParts[0] ?? null;
    return {
      visible: exactMoviePart != null,
      ratingKey: movie.ratingKey ?? null,
      mediaPart: exactMoviePart ? { id: exactMoviePart.id ?? null, file: exactMoviePart.file, size: exactMoviePart.size ?? null, container: exactMoviePart.container ?? null } : null,
    };
  }
  const sectionId = process.env.PLEX_TV_SECTION_ID;
  if (!sectionId) return { visible: false, ratingKey: null, mediaPart: null };
  const all = await getJson(`/library/sections/${sectionId}/all`, { includeGuids: 1 });
  // The IMDb guid ONLY. A consumer title is never an identity fallback:
  // the consumer's title is a projection of metadata HashSucker does not
  // own, and matching on it would let a consumer rename decide which of
  // our items this is.
  const show = (all?.MediaContainer?.Metadata ?? []).find((candidate) => {
    if (candidate.type !== 'show') return false;
    const ids = (candidate.Guid ?? []).map((g) => imdbFromGuid(g.id));
    return ids.includes(mediaId);
  });
  if (!show) return { visible: false, ratingKey: null, mediaPart: null };
  const seasons = (await getJson(show.key.endsWith('/children') ? show.key : `${show.key}/children`))?.MediaContainer?.Metadata ?? [];
  const seasonEntry = seasons.find((candidate) => candidate.index === season);
  if (!seasonEntry) return { visible: false, ratingKey: null, mediaPart: null };
  const episodes = (await getJson(seasonEntry.key.endsWith('/children') ? seasonEntry.key : `${seasonEntry.key}/children`))?.MediaContainer?.Metadata ?? [];
  const entry = episodes.find((candidate) => candidate.index === episode);
  if (!entry) return { visible: false, ratingKey: null, mediaPart: null };
  const item = (await getJson(entry.key, { includeExtras: 0, includeMarkers: 0, includeRelated: 0 }))?.MediaContainer?.Metadata?.[0] ?? entry;
  const parts = item.Media?.flatMap((m) => m.Part ?? []).filter((p) => p.file) ?? [];
  const exactPart = expectedPartFile
    ? parts.find((p) => p.file === expectedPartFile) ?? null
    : parts[0] ?? null;
  return {
    visible: exactPart != null,
    ratingKey: item.ratingKey ?? null,
    mediaPart: exactPart ? { id: exactPart.id ?? null, file: exactPart.file, size: exactPart.size ?? null, container: exactPart.container ?? null } : null,
  };
}

export const plexAdapter = { name: 'plex', listLibrary: listPlexLibrary, confirmPlexEpisode };
