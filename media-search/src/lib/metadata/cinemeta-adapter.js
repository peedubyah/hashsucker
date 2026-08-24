/**
 * Cinemeta Metadata Provider Adapter
 *
 * Adapt the Cinemeta Stremio addon API to the provider-agnostic interface.
 * This is the first metadata provider; TMDB will be added later.
 *
 * Cinemeta API: https://v3-cinemeta.strem.io
 * - Search: /catalog/{type}/search={query}.json
 * - Meta: /meta/{type}/{id}.json
 */

import { createNormalizedMedia } from './types.js';
import { createProviderAdapter } from './provider-adapter.js';

const DEFAULT_BASE = 'https://v3-cinemeta.strem.io';

function baseUrl() {
  return String(process.env.CINEMETA_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

async function getJson(pathname, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl()}${pathname}`, {
    headers: { accept: 'application/json', 'user-agent': 'media-search/0.1.0' },
  });
  if (!response.ok) throw new Error(`Cinemeta returned HTTP ${response.status}`);
  return response.json();
}

/**
 * Convert a Cinemeta meta object to our normalized media shape.
 */
function cinemetaToNormalized(meta) {
  return createNormalizedMedia({
    id: meta.id,
    type: meta.type,
    title: meta.name,
    year: parseYear(meta.year || meta.releaseInfo),
    posterUrl: meta.poster || null,
    backdropUrl: meta.background || null,
    overview: meta.description || null,
  });
}

/**
 * Parse year from Cinemeta's various year formats.
 * Cinemeta returns: "2011", "2011-", "2011-2019", "2011-2019-"
 */
function parseYear(yearStr) {
  if (!yearStr) return null;
  const match = String(yearStr).match(/^(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Check if a query is an IMDb ID and return the type if so.
 * @param {string} query
 * @returns {{ isImdb: boolean, type: 'movie'|'series'|null, id: string|null }}
 */
function parseImdbId(query) {
  const q = String(query || '').trim().toLowerCase();
  // IMDb IDs start with tt followed by digits
  const imdbMatch = q.match(/^(tt\d+)$/);
  if (imdbMatch) {
    return { isImdb: true, type: null, id: imdbMatch[1] };
  }
  // Remove URL prefix if present
  const urlMatch = q.match(/imdb\.com\/title\/(tt\d+)/);
  if (urlMatch) {
    return { isImdb: true, type: null, id: urlMatch[1] };
  }
  return { isImdb: false, type: null, id: null };
}

/**
 * Search Cinemeta for titles matching the query.
 * If query is an IMDb ID, performs direct lookup.
 *
 * @param {string} query - Search query (2-120 chars) or IMDb ID
 * @param {function} [fetchImpl] - Injectable fetch for testing
 * @returns {Promise<NormalizedMedia[]>} Normalized results
 */
async function searchCinemeta(query, fetchImpl = fetch) {
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 120) {
    throw new Error('Search must be 2–120 characters');
  }

  // Check if query is an IMDb ID for direct lookup
  const imdbCheck = parseImdbId(q);
  if (imdbCheck.isImdb && imdbCheck.id) {
    // Try movie first, then series
    const types = ['movie', 'series'];
    for (const type of types) {
      try {
        const result = await getCinemetaMedia(type, imdbCheck.id, fetchImpl);
        if (result) {
          return [result];
        }
      } catch {
        // Continue to next type
      }
    }
    return [];
  }

  // Text search: use the search catalog endpoint for each type
  const types = ['series', 'movie'];
  const attempts = await Promise.allSettled(types.map((type) =>
    getJson(`/catalog/${type}/search=${encodeURIComponent(q)}.json`, fetchImpl)
  ));

  const payloads = attempts
    .filter((attempt) => attempt.status === 'fulfilled')
    .map((attempt) => attempt.value);

  if (payloads.length === 0) {
    throw attempts[0].reason || new Error('Cinemeta search failed');
  }

  const needle = q.toLowerCase();
  const relevance = (meta) => {
    const name = String(meta.name || '').toLowerCase();
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    return 3;
  };

  // Confidence gate: reject unrelated fuzzy matches
  // Cinemeta's search endpoint returns static popular results for all queries,
  // so we must verify the result actually matches the query tokens.
  const queryTokens = new Set(needle.split(/\s+/).filter(t => t.length > 2));
  const confidenceThreshold = 0.5;

  const hasOverlap = (resultTitle) => {
    const resultTokens = new Set(String(resultTitle || '').toLowerCase().split(/\s+/).filter(t => t.length > 2));
    const overlap = [...queryTokens].filter(t => resultTokens.has(t)).length;
    const confidence = overlap / Math.max(queryTokens.size, 1);
    return confidence >= confidenceThreshold;
  };

  const allResults = payloads
    .flatMap((payload) => payload.metas || [])
    .map(cinemetaToNormalized)
    .map((meta, index) => ({ meta, index }))
    .sort((a, b) => relevance({ name: a.meta.title }) - relevance({ name: b.meta.title }) || a.index - b.index)
    .map(({ meta }) => meta);

  // Filter to results that actually match the query
  const confidentResults = allResults.filter(r => hasOverlap(r.title));

  // If no results pass confidence gate, return unresolved (empty)
  // Do not accept unrelated fuzzy matches — metadata is optional enrichment
  if (confidentResults.length === 0) {
    return [];
  }

  return confidentResults.slice(0, 40);
}

/**
 * Get a specific media item by type and ID.
 *
 * @param {string} type - "movie" or "series"
 * @param {string} id - Media identifier
 * @param {function} [fetchImpl] - Injectable fetch for testing
 * @returns {Promise<NormalizedMedia|null>} Normalized media or null
 */
async function getCinemetaMedia(type, id, fetchImpl = fetch) {
  if (!['series', 'movie'].includes(type)) throw new Error('Invalid media type');
  if (!/^[a-z0-9:_-]+$/i.test(String(id || ''))) throw new Error('Invalid media ID');

  const payload = await getJson(`/meta/${type}/${encodeURIComponent(id)}.json`, fetchImpl);
  if (!payload.meta) return null;

  const media = cinemetaToNormalized(payload.meta);
  // Attach videos for series (used by episode picker)
  if (type === 'series') {
    media.videos = (payload.meta.videos || [])
      .filter((video) => Number.isInteger(video.season) && Number.isInteger(video.episode) && video.episode > 0)
      .map((video) => ({
        id: video.id,
        season: video.season,
        episode: video.episode,
        title: video.title || `Episode ${video.episode}`,
        released: video.released || null,
        thumbnail: video.thumbnail || null,
      }));
  }
  return media;
}

/**
 * Check if Cinemeta is reachable.
 *
 * @param {function} [fetchImpl] - Injectable fetch for testing
 * @returns {Promise<boolean>}
 */
async function cinemetaHealthCheck(fetchImpl = fetch) {
  try {
    await getJson(`/catalog/series/top/search=test.json`, fetchImpl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the Cinemeta provider adapter.
 *
 * @param {Object} [options]
 * @param {function} [options.fetchImpl] - Injectable fetch for testing
 * @returns {ProviderAdapter} Cinemeta provider adapter
 */
export function createCinemetaAdapter(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  return createProviderAdapter({
    name: 'cinemeta',
    priority: 10,
    search: (query) => searchCinemeta(query, fetchImpl),
    getMedia: (type, id) => getCinemetaMedia(type, id, fetchImpl),
    healthCheck: () => cinemetaHealthCheck(fetchImpl),
  });
}
