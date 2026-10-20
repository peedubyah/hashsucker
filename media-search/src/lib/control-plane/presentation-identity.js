/**
 * PRESENTATION IDENTITY — the one authority for consumer-visible names.
 *
 * A media intent has exactly ONE durable presentation identity: the name a
 * consumer sees and the paths it is reached through. It is resolved ONCE,
 * at a commit point, from an explicit source precedence, and every surface
 * afterwards reads it instead of recomputing a name.
 *
 * Before this module there were two resolvers with two precedences:
 *
 *   VFS path   media-search/src/lib/vfs/materialize.js
 *              request canonical title -> catalog metadata -> filename
 *   .strm path media-search/src/lib/requests/strm-publisher.js
 *              catalog metadata -> release title -> filename -> media id
 *
 * They disagreed on which source wins, on whether a year is part of the
 * name, and on whether a request's explicit canonical title is honoured at
 * all. The .strm path was recomputed on EVERY publish, so a metadata
 * outage or a metadata correction could write a SECOND artifact for the
 * same media, and the consumer library grew a duplicate.
 *
 * WHAT THIS MODULE OWNS
 *   - the source precedence for a presentation identity;
 *   - the derivation of the consumer-visible paths from that identity.
 *
 * WHAT IT DOES NOT OWN
 *   - Release/TorrentFile/Binding identity (those are frozen elsewhere);
 *   - the durable storage of the identity (the control plane owns it);
 *   - descriptive metadata (summary, poster, genres) — that may enrich
 *     without ever renaming a published item.
 *
 * PRECEDENCE (explicit, and the same for every surface)
 *
 *   title   1. the request's canonical title  (explicit intent)
 *           2. the catalog title              (canonical catalog metadata)
 *           3. the filename inference         (release grammar, last resort)
 *           4. the media id                   (a stable, honest floor)
 *   year    1. the request's canonical year   (explicit intent)
 *           2. the catalog year, NORMALIZED   (catalog enrichment)
 *           3. the year parsed from the filename
 *
 * The release ATTRIBUTES are not a presentation source: a release title
 * is release grammar ("Deadwood (2004) S01E01 Deadwood (1080p BluRay x265
 * Silence)") and it belongs to a release, not to the media intent. The
 * filename inference is the last resort only — it can carry release
 * grammar into a consumer-visible name — and the path that carries it is
 * committed once, so it can never move afterwards.
 *
 * The release filename and the release attributes are NOT presentation
 * sources. A release name is release grammar ("Deadwood (2004) S01E01
 * Deadwood (1080p BluRay x265 Silence)") and it belongs to a RELEASE, not
 * to the media intent: a representation reselection would rename the item
 * through it. The filename's EXTENSION is still read from the physical
 * TorrentFile, but only the extension — and the path that carries it is
 * committed once, so even that cannot move afterwards.
 *
 * The request's canonical title/year is IDENTITY AUTHORITY: it is what the
 * requester asked for. The catalog is ENRICHMENT: it fills a gap, it does
 * not overrule. Enrichment is only consulted when the explicit identity
 * is absent, so a catalog correction can never rename a published item.
 *
 * The year is normalized to a four-digit year or nothing. A catalog that
 * answers "2016-2019" or "2024-02-27" contributes "2016" / "2024"; a
 * catalog that answers a range or a date never leaks punctuation into a
 * directory name.
 */

import path from 'node:path';

import { sanitizePathSegment, normalizeCanonicalPath, normalizeExtension } from './canonical-path.js';

/** The two media shapes a presentation identity can have. */
export const PRESENTATION_KINDS = Object.freeze({
  MOVIE: 'movie',
  EPISODE: 'episode',
});

/**
 * Normalize a year-ish value to a four-digit year, or null.
 *
 * Accepts a number, a numeric string, an ISO date, or a range: only the
 * first four-digit year is meaningful for a directory name, and anything
 * else (a range, a full date, prose) must not reach the filesystem.
 *
 * @param {*} value
 * @returns {number|null}
 */
export function normalizePresentationYear(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1000 || value > 2999) return null;
    return value;
  }
  const text = String(value).trim();
  const match = text.match(/(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isSafeInteger(year) || year < 1000 || year > 2999) return null;
  return year;
}

/**
 * The LAST-RESORT inference from a release filename.
 *
 * A release filename is release grammar, not a display name: it carries a
 * year, a resolution, a source and a group. Only the year is trustworthy
 * enough to keep; the rest is cleaned to something a human would write.
 *
 * @param {string} filename
 * @param {string} mediaId
 * @returns {{title: string, year: number|null, extension: string}}
 */
export function inferMoviePresentation(filename, mediaId) {
  const basename = path.posix.basename(String(filename || '').replaceAll('\\', '/'));
  const parsed = path.posix.parse(basename);
  const stem = parsed.name || basename || mediaId;
  const yearMatch = stem.match(/(?:^|[. _-])((?:19|20)\d{2})(?=$|[. _-])/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const titlePart = yearMatch ? stem.slice(0, yearMatch.index).trim() : stem.trim();
  const title = titlePart
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || mediaId;
  const extension = /^\.[a-z0-9]{1,10}$/i.test(parsed.ext) ? parsed.ext : '.mkv';
  return { title, year, extension };
}

/**
 * The last-resort inference for an EPISODE filename.
 *
 * @param {string} filename
 * @param {string} mediaId
 * @returns {{title: string, extension: string}}
 */
export function inferEpisodePresentation(filename, mediaId) {
  const basename = path.posix.basename(String(filename || '').replaceAll('\\', '/'));
  const parsed = path.posix.parse(basename);
  const base = parsed.name || basename || mediaId;
  const title = base
    .replace(/[._-]+/g, ' ')
    .replace(/\s+S\d+E\d+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || mediaId;
  const extension = /^\.[a-z0-9]{1,10}$/i.test(parsed.ext) ? parsed.ext : '.mkv';
  return { title, extension };
}

/**
 * The display name components of a presentation identity.
 *
 * @param {Object} params
 * @param {string|null} [params.canonicalTitle] - the request's explicit title
 * @param {number|null} [params.canonicalYear] - the request's explicit year
 * @param {string|null} [params.catalogTitle] - the catalog's title (enrichment)
 * @param {string|number|null} [params.catalogYear] - the catalog's year (enrichment)
 * @param {string|null} [params.fallbackTitle] - the release/filename inference
 * @param {string|null} [params.fallbackYear] - the year parsed from the filename
 * @returns {{title: string, year: number|null}}
 */
export function resolvePresentationName({
  canonicalTitle = null,
  canonicalYear = null,
  catalogTitle = null,
  catalogYear = null,
  inferredTitle = null,
  inferredYear = null,
  mediaId = null,
} = {}) {
  const explicitTitle = typeof canonicalTitle === 'string' ? canonicalTitle.trim() : '';
  const catalog = typeof catalogTitle === 'string' ? catalogTitle.trim() : '';
  const inferred = typeof inferredTitle === 'string' ? inferredTitle.trim() : '';
  const fallback = typeof mediaId === 'string' ? mediaId.trim() : '';

  const title = explicitTitle || catalog || inferred || fallback || 'Untitled';

  // The year follows the TITLE's authority: an explicit year is used with
  // any title, and an enrichment year is used only where that enrichment
  // supplied the title. The catalog fills the gaps the request left; it
  // never adds facts to a title the request already named. That also keeps
  // the catalog OUT of the path when the request was explicit, which is
  // what makes the identity resolvable without a network call.
  //
  // The year is normalized everywhere it enters. A catalog that answers a
  // range ("2016-2019") or a date ("2024-02-27") contributes its year and
  // nothing else: a directory name must never carry a range or a
  // punctuation mark that no consumer expects.
  const year = normalizePresentationYear(canonicalYear)
    ?? (!explicitTitle
      ? (normalizePresentationYear(catalogYear) ?? normalizePresentationYear(inferredYear))
      : null);
  return { title, year };
}

/**
 * The canonical VFS path for a presentation identity.
 *
 * Shape: `Movies/<Title> (<Year>)/<Title> (<Year>).<ext>` and
 * `TV/<Title> (<Year>)/Season NN/<Title> (<Year>) - SNNENN.<ext>`.
 *
 * @param {Object} params
 * @param {string} params.mediaType - 'movie' | 'episode'
 * @param {string} params.title
 * @param {number|null} params.year
 * @param {string} params.extension - the physical extension, e.g. '.mkv'
 * @param {number} [params.season]
 * @param {number} [params.episode]
 * @returns {string} the canonical path, relative to the VFS root
 */
export function buildPresentationCanonicalPath({
  mediaType, title, year, extension, season, episode,
}) {
  const kind = mediaType === 'episode' ? PRESENTATION_KINDS.EPISODE : PRESENTATION_KINDS.MOVIE;
  const safeTitle = sanitizePathSegment(title, 'Untitled');
  const ext = normalizeExtension(extension);
  const yearSuffix = year == null ? '' : ` (${year})`;
  const display = `${safeTitle}${yearSuffix}`;
  if (kind === PRESENTATION_KINDS.MOVIE) {
    return normalizeCanonicalPath(`Movies/${display}/${display}${ext}`);
  }
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) {
    throw new TypeError('Episode presentation paths require season and episode');
  }
  const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return normalizeCanonicalPath(
    `TV/${display}/Season ${String(season).padStart(2, '0')}/${display} - ${code}${ext}`,
  );
}

/**
 * The consumer `.strm` path for a presentation identity, RELATIVE to the
 * `.strm` output root (the root is a deployment detail; the identity is
 * not).
 *
 * Shape: `Movies/<Title> (<Year>)/<Title> (<Year>).strm` and
 * `TV Shows/<Title> (<Year>)/Season NN/<Title> (<Year>) - SNNENN.strm`.
 *
 * The collection segment differs from the VFS tree on purpose: the `.strm`
 * tree is the consumer's library layout, the VFS tree is the byte source.
 * Everything INSIDE those trees is the same identity.
 *
 * @param {Object} params
 * @param {string} params.mediaType - 'movie' | 'episode'
 * @param {string} params.title
 * @param {number|null} params.year
 * @param {number} [params.season]
 * @param {number} [params.episode]
 * @returns {string}
 */
export function buildPresentationStrmPath({
  mediaType, title, year, season, episode,
}) {
  const kind = mediaType === 'episode' ? PRESENTATION_KINDS.EPISODE : PRESENTATION_KINDS.MOVIE;
  const safeTitle = sanitizePathSegment(title, 'Untitled');
  const yearSuffix = year == null ? '' : ` (${year})`;
  const display = `${safeTitle}${yearSuffix}`;
  if (kind === PRESENTATION_KINDS.MOVIE) {
    return `${'Movies'}/${display}/${display}.strm`;
  }
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) {
    throw new TypeError('Episode presentation paths require season and episode');
  }
  const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return `TV Shows/${display}/Season ${String(season).padStart(2, '0')}/${display} - ${code}.strm`;
}

/**
 * Derive the whole presentation identity from its parts.
 *
 * @param {Object} params
 * @param {string} params.mediaType - 'movie' | 'episode'
 * @param {string} params.title
 * @param {number|null} params.year
 * @param {string} params.extension
 * @param {number} [params.season]
 * @param {number} [params.episode]
 * @returns {{title:string, year:number|null, canonicalPath:string, strmPath:string}}
 */
export function derivePresentationIdentity({
  mediaType, title, year, extension, season, episode,
}) {
  const kind = mediaType === 'episode' ? PRESENTATION_KINDS.EPISODE : PRESENTATION_KINDS.MOVIE;
  const normalizedTitle = sanitizePathSegment(title, 'Untitled');
  const normalizedYear = normalizePresentationYear(year);
  return {
    title: normalizedTitle,
    year: normalizedYear,
    canonicalPath: buildPresentationCanonicalPath({
      mediaType: kind, title: normalizedTitle, year: normalizedYear, extension, season, episode,
    }),
    strmPath: buildPresentationStrmPath({
      mediaType: kind, title: normalizedTitle, year: normalizedYear, season, episode,
    }),
  };
}
