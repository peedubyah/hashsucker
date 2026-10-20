/**
 * CONSUMER PROJECTION OBSERVER — what the consumer ACTUALLY holds.
 *
 * The observer is the only place that reads a consumer library. It returns
 * what the consumer holds for one media intent — every matching item, its
 * Part and its size — and it NEVER decides what should be there: that is
 * `desired-projection.js`, derived from HashSucker's durable truth.
 *
 * HOW AN ITEM IS MATCHED
 *
 *   1. by its PART FILE — the exact path our durable truth published.
 *      This is the precise matcher and it is the one that counts: the file
 *      IS the projection.
 *   2. by its IMDb guid — the loose matcher, for a consumer item whose
 *      file we do not expect (an edition we did not publish).
 *
 * The order matters. A consumer's metadata is derived from the FILE, and
 * the file's embedded tags can be wrong: a release tagged with another
 * film's IMDb id makes the guid matcher miss an item that IS ours. The
 * Part file cannot be wrong — it is our path.
 *
 * A consumer that cannot be observed yields `observed: false` — never an
 * absence.
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
 * @param {string|null} [params.expectedPartFile] - our durable path under the section root
 * @returns {Promise<{observed: boolean, items: Array<Object>, error: string|null}>}
 */
export async function observePlexProjection({
  mediaId, mediaType, season = null, episode = null, expectedPartFile = null,
}) {
  try {
    if (mediaType === 'movie') {
      const sectionId = process.env.PLEX_MOVIES_SECTION_ID;
      if (!sectionId) return { observed: false, items: [], error: 'plex-no-movies-section' };
      const all = await getJson(`/library/sections/${sectionId}/all`, { type: 1, includeGuids: 1 });
      return {
        observed: true,
        items: matchItems(all?.MediaContainer?.Metadata ?? [], { mediaId, expectedPartFile }),
        error: null,
      };
    }

    const sectionId = process.env.PLEX_TV_SECTION_ID;
    if (!sectionId) return { observed: false, items: [], error: 'plex-no-tv-section' };
    const all = await getJson(`/library/sections/${sectionId}/all`, { type: 4, includeGuids: 1 });
    const candidates = (all?.MediaContainer?.Metadata ?? []).filter((candidate) => {
      if (season != null && candidate.parentIndex !== season) return false;
      if (episode != null && candidate.index !== episode) return false;
      return true;
    });
    const byFile = matchItems(candidates, { mediaId, expectedPartFile });
    if (byFile.length > 0) return { observed: true, items: byFile, error: null };
    // No Part matched our path: fall back to the show's IMDb guid, which
    // is the series id (an episode's own guid is the episode's id).
    return {
      observed: true,
      items: await matchBySeriesGuid({ mediaId, season, episode }),
      error: null,
    };
  } catch (error) {
    return { observed: false, items: [], error: String(error?.message ?? error) };
  }
}

/**
 * The consumer items that carry our projection.
 *
 * @param {Array<Object>} candidates - the consumer's items
 * @param {Object} params
 * @param {string} params.mediaId
 * @param {string|null} params.expectedPartFile
 * @returns {Array<Object>} the matching items, as observation facts
 */
function matchItems(candidates, { mediaId, expectedPartFile }) {
  const out = [];
  for (const candidate of candidates) {
    const parts = partsOf(candidate);
    const byFile = expectedPartFile
      ? parts.find((part) => part.partFile === expectedPartFile) ?? null
      : null;
    const byGuid = (candidate.Guid ?? []).map((g) => imdbFromGuid(g.id)).includes(mediaId);
    if (!byFile && !byGuid) continue;
    const part = byFile ?? parts[0] ?? null;
    out.push({
      itemId: candidate.ratingKey == null ? null : String(candidate.ratingKey),
      partId: part?.partId ?? null,
      partFile: part?.partFile ?? null,
      partSize: part?.partSize ?? null,
      container: part?.container ?? null,
      title: candidate.title ?? null,
      matchedBy: byFile ? 'part-file' : 'imdb-guid',
    });
  }
  return out;
}

/**
 * The episode items whose SERIES carries our IMDb id.
 */
async function matchBySeriesGuid({ mediaId, season, episode }) {
  const sectionId = process.env.PLEX_TV_SECTION_ID;
  if (!sectionId) return [];
  const all = await getJson(`/library/sections/${sectionId}/all`, { includeGuids: 1 });
  const out = [];
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
        const parts = partsOf(entry);
        out.push({
          itemId: entry.ratingKey == null ? null : String(entry.ratingKey),
          partId: parts[0]?.partId ?? null,
          partFile: parts[0]?.partFile ?? null,
          partSize: parts[0]?.partSize ?? null,
          container: parts[0]?.container ?? null,
          title: entry.title ?? null,
          matchedBy: 'imdb-guid',
        });
      }
    }
  }
  return out;
}

/**
 * The Parts of a consumer item, as observation facts.
 *
 * A consumer item may carry several Parts (an edition list). Every Part is
 * reported: the reconciliation decides which one is authoritative, and a
 * consumer that holds a wrong Part must be visible as such, not hidden
 * behind the first one.
 */
function partsOf(entry) {
  const parts = entry?.Media?.flatMap((m) => m.Part ?? []).filter((p) => p?.file) ?? [];
  return parts.map((part) => ({
    itemId: entry.ratingKey == null ? null : String(entry.ratingKey),
    partId: part.id == null ? null : String(part.id),
    partFile: part.file ?? null,
    partSize: part.size == null ? null : Number(part.size),
    container: part.container ?? null,
  }));
}

function imdbFromGuid(guid) {
  if (typeof guid !== 'string') return null;
  const m = guid.match(/(?:com\.plexapp\.agents\.imdb:\/\/|imdb:\/\/)(tt\d+)/);
  return m ? m[1] : null;
}
