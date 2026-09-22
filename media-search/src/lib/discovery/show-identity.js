/**
 * Conservative show-identity agreement for local episode retrieval.
 * Exact canonical/alias matches are safe; a longer release title only agrees
 * when its suffix is a supplied known episode title.
 */
import { parsedReleaseTitle } from './identity-agreement.js';

/**
 * @typedef {Object} ShowIdentityContext
 * @property {string} canonicalTitle
 * @property {string|null} [originalTitle]
 * @property {string[]} [alternateTitles]
 * @property {number|null} [firstAirYear]
 * @property {Object} [externalIds]
 * @property {string|null} [episodeTitle]
 * @property {string[]} [episodeTitles]
 */

export function normalizeShowTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[“”‘’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function yearAgrees(releaseYear, expectedYear) {
  if (releaseYear == null || expectedYear == null) return true;
  return Math.abs(Number(releaseYear) - Number(expectedYear)) <= 1;
}

function boundarySuffix(title, show) {
  if (title === show) return '';
  if (!title.startsWith(`${show} `)) return null;
  return title.slice(show.length + 1).trim();
}

/** @param {ShowIdentityContext & {release: Object, year?: number|null}} input */
export function agreeShowIdentity({
  canonicalTitle,
  alternateTitles = [],
  originalTitle = null,
  release,
  firstAirYear = null,
  year = null,
  episodeTitle = null,
  episodeTitles = [],
} = {}) {
  const expectedYear = firstAirYear ?? year;
  const knownEpisodeTitles = episodeTitle ? [...episodeTitles, episodeTitle] : episodeTitles;
  const references = [...new Set([canonicalTitle, originalTitle, ...alternateTitles]
    .map(normalizeShowTitle).filter(Boolean))];
  if (references.length === 0) return { matched: false, reason: 'no-reference-title', confidence: 0 };
  const parsed = parsedReleaseTitle(release);
  const rawFilename = String(release?.filename ?? '').split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
  const title = normalizeShowTitle(parsed.title || rawFilename);
  const rawTitle = normalizeShowTitle(rawFilename);
  const titles = new Set([title, rawTitle].filter(Boolean));
  if (titles.size === 0 || !yearAgrees(parsed.year, expectedYear)) return { matched: false, reason: 'title-or-year-mismatch', confidence: 0 };
  if ([...titles].some((candidate) => references.includes(candidate))) return { matched: true, reason: 'exact-title', confidence: 1 };
  const knownEpisodes = knownEpisodeTitles.map(normalizeShowTitle).filter(Boolean);
  for (const reference of references) {
    const suffix = boundarySuffix(title, reference);
    if (suffix && knownEpisodes.some((episode) => suffix === episode || suffix.startsWith(`${episode} `))) {
      return { matched: true, reason: 'known-episode-title', confidence: 0.95 };
    }
  }
  return { matched: false, reason: 'not-exact-or-known-episode-title', confidence: 0 };
}
