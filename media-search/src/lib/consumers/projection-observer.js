/**
 * CONSUMER PROJECTION OBSERVER — what the consumer ACTUALLY holds.
 *
 * The observer is the only place that reads a consumer library. It returns
 * what the consumer holds for one media intent — every item, every Part —
 * and it NEVER decides what should be there: that is
 * `desired-projection.js`, derived from HashSucker's durable truth.
 *
 * The two are compared by `classifyProjection`, and the comparison is the
 * thing that says "the consumer is missing our projection" or "the
 * consumer's Part points somewhere else". A consumer that cannot be
 * observed yields `observed: false` — never an absence.
 *
 * Identity is by the IMDb guid ONLY. A consumer title is never used to
 * match a HashSucker intent: the consumer's title is a projection of
 * metadata we do not own, and matching on it would let a consumer rename
 * decide which of our items it is.
 */

import { getJson } from './plex-transport.js';

/**
 * Every Plex item that carries the given media intent.
 *
 * @param {Object} params
 * @param {string} params.mediaId - the IMDb id of the intent (a series id for an episode)
 * @param {string} params.mediaType - 'movie' | 'episode'
 * @param {number|null} [params.season]
 * @param {number|null} [params.episode]
 * @returns {Promise<{observed: boolean, items: Array<Object>, error: string|null}>}
 */
export async function observePlexProjection({ mediaId, mediaType, season = null, episode = null }) {
  try {
    if (mediaType === 'movie') {
      const sectionId = process.env.PLEX_MOVIES_SECTION_ID;
      if (!sectionId) return { observed: false, items: [], error: 'plex-no-movies-section' };
      const all = await getJson(`/library/sections/${sectionId}/all`, { includeGuids: 1 });
      const items = [];
      for (const candidate of all?.MediaContainer?.Metadata ?? []) {
        const ids = (candidate.Guid ?? []).map((g) => imdbFromGuid(g.id));
        if (!ids.includes(mediaId)) continue;
        items.push(...await partsOf(candidate));
      }
      return { observed: true, items, error: null };
    }

    const sectionId = process.env.PLEX_TV_SECTION_ID;
    if (!sectionId) return { observed: false, items: [], error: 'plex-no-tv-section' };
    const all = await getJson(`/library/sections/${sectionId}/all`, { includeGuids: 1 });
    const items = [];
    for (const show of all?.MediaContainer?.Metadata ?? []) {
      if (show.type !== 'show') continue;
      const ids = (show.Guid ?? []).map((g) => imdbFromGuid(g.id));
      if (!ids.includes(mediaId)) continue;
      const seasons = (await getJson(show.key.endsWith('/children') ? show.key : `${show.key}/children`))?.MediaContainer?.Metadata ?? [];
      for (const seasonEntry of seasons) {
        if (season != null && seasonEntry.index !== season) continue;
        const episodes = (await getJson(seasonEntry.key.endsWith('/children') ? seasonEntry.key : `${seasonEntry.key}/children`))?.MediaContainer?.Metadata ?? [];
        for (const entry of episodes) {
          if (episode != null && entry.index !== episode) continue;
          items.push(...await partsOf(entry));
        }
      }
    }
    return { observed: true, items, error: null };
  } catch (error) {
    return { observed: false, items: [], error: String(error?.message ?? error) };
  }
}

/**
 * The Parts of a consumer item, as observation facts.
 *
 * A consumer item may carry several Parts (an edition list). Every Part is
 * reported: the reconciliation decides which one is authoritative, and a
 * consumer that holds a wrong Part must be visible as such, not hidden
 * behind the first one.
 */
async function partsOf(entry) {
  const item = (await getJson(entry.key, { includeExtras: 0, includeMarkers: 0, includeRelated: 0 }))?.MediaContainer?.Metadata?.[0] ?? entry;
  const parts = item.Media?.flatMap((m) => m.Part ?? []).filter((p) => p.file) ?? [];
  return parts.map((part) => ({
    itemId: String(item.ratingKey ?? '') || null,
    partId: part.id == null ? null : String(part.id),
    partFile: part.file ?? null,
    partSize: part.size == null ? null : Number(part.size),
    container: part.container ?? null,
    title: item.title ?? null,
  }));
}

function imdbFromGuid(guid) {
  if (typeof guid !== 'string') return null;
  const m = guid.match(/(?:com\.plexapp\.agents\.imdb:\/\/|imdb:\/\/)(tt\d+)/);
  return m ? m[1] : null;
}
