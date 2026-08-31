/**
 * Plex Notifier
 *
 * Asks Plex to partial-scan the VFS path of a newly fulfilled item, so the
 * library picks up the file that Hashsucker's WebDAV server has just
 * materialized under `/vfs/Movies/...` and `/vfs/TV/...`.
 *
 * Configuration (all optional — integration disabled if not set):
 *   - PLEX_URL              e.g. http://host.docker.internal:32400
 *   - PLEX_TOKEN            Plex API token
 *   - PLEX_MOVIES_SECTION_ID  e.g. 2
 *   - PLEX_TV_SECTION_ID      e.g. 3
 *
 * Behavior:
 *   - No configuration → disabled without affecting Hashsucker
 *   - Uses host-gateway route from container (PLEX_URL is expected to use
 *     host.docker.internal, not localhost)
 *   - Issues a Plex partial-scan via
 *     GET {PLEX_URL}/library/sections/{sectionId}/refresh?path={urlEncodedPath}
 *   - Plex failure does NOT roll back request/handoff/STRM
 */

import { buildPreferredCanonicalPath } from '../control-plane/canonical-path.js';

const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const PLEX_MOVIES_SECTION_ID = process.env.PLEX_MOVIES_SECTION_ID;
const PLEX_TV_SECTION_ID = process.env.PLEX_TV_SECTION_ID;
const PLEX_TIMEOUT_MS = 5000;

/**
 * Check if Plex notification is enabled.
 *
 * @returns {boolean}
 */
export function isPlexEnabled() {
  return Boolean(
    PLEX_URL && PLEX_TOKEN && PLEX_MOVIES_SECTION_ID && PLEX_TV_SECTION_ID,
  );
}

/**
 * Notify Plex of a newly fulfilled item by requesting a partial scan of the
 * VFS directory that contains the new file.
 *
 * @param {Object} params
 * @param {string} params.mediaId - Media identifier (e.g. tt0903747)
 * @param {string} params.mediaType - 'movie' or 'series' (handoff mediaType)
 * @param {number} [params.season] - Season number (for episodes)
 * @param {number} [params.episode] - Episode number (for episodes)
 * @param {string} params.filename - Original release filename (used to derive title)
 * @returns {Promise<{notified: boolean, method: ?string, error: ?string}>}
 */
export async function notifyPlex({
  mediaId,
  mediaType,
  season,
  episode,
  filename,
}) {
  if (!isPlexEnabled()) {
    return { notified: false, method: null, error: null };
  }

  try {
    const { sectionId, scanPath } = resolvePlexTarget({
      mediaType,
      mediaId,
      season,
      episode,
      filename,
    });

    if (!sectionId || !scanPath) {
      return { notified: false, method: null, error: 'unable to derive VFS path' };
    }

    const url = `${PLEX_URL}/library/sections/${sectionId}/refresh?path=${encodeURIComponent(scanPath)}`;
    console.log(`[Plex] Requesting partial scan: section=${sectionId} path=${scanPath}`);

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'X-Plex-Token': PLEX_TOKEN,
        Accept: 'application/json',
      },
    }, PLEX_TIMEOUT_MS);

    if (response.status === 200 || response.status === 201) {
      return { notified: true, method: 'partial-refresh', error: null };
    }

    throw new Error(`Plex partial scan returned HTTP ${response.status}`);
  } catch (error) {
    const errorMsg = error.message || 'Unknown Plex error';
    console.error(`[Plex] Notification failed for ${mediaId}: ${errorMsg}`);
    return { notified: false, method: null, error: errorMsg };
  }
}

/**
 * Map a handoff to a Plex section id and a VFS path (directory) for partial
 * scan. Path is the directory containing the new file, not the file itself,
 * so Plex re-scans siblings and metadata.
 *
 * @param {Object} handoff
 * @returns {{sectionId: ?string, scanPath: ?string}}
 */
function resolvePlexTarget({ mediaType, mediaId, season, episode, filename }) {
  if (mediaType === 'movie') {
    const title = extractMovieTitle(filename, mediaId);
    const year = extractYear(filename);
    const filePath = buildPreferredCanonicalPath({
      mediaType: 'movie',
      mediaId,
      title,
      year,
    });
    return {
      sectionId: PLEX_MOVIES_SECTION_ID,
      scanPath: pathDirname(filePath),
    };
  }

  if (mediaType === 'series') {
    const title = extractSeriesTitle(filename, mediaId);
    const year = extractYear(filename);
    const filePath = buildPreferredCanonicalPath({
      mediaType: 'episode',
      mediaId,
      title,
      year,
      season,
      episode,
    });
    return {
      sectionId: PLEX_TV_SECTION_ID,
      scanPath: pathDirname(filePath),
    };
  }

  return { sectionId: null, scanPath: null };
}

/**
 * Strip the filename from a relative VFS path, returning the parent
 * directory path.
 *
 * @param {string} filePath
 * @returns {string}
 */
function pathDirname(filePath) {
  if (!filePath) return filePath;
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? filePath : filePath.slice(0, idx);
}

/**
 * Parse a movie title from a release filename. Mirrors the convention used
 * by `lib/vfs/movie-webdav.js#movieNameFromFilename` so the resulting path
 * matches the VFS canonical path that the WebDAV materializer will create.
 *
 * @param {string} filename
 * @param {string} mediaId
 * @returns {string}
 */
function extractMovieTitle(filename, mediaId) {
  if (!filename) return mediaId;
  const stem = stripExtension(filename);
  return stemToTitle(stem, mediaId);
}

/**
 * Parse a series title from a release filename. Mirrors the convention used
 * by `lib/vfs/tv-webdav.js#episodeNameFromFilename`.
 *
 * @param {string} filename
 * @param {string} mediaId
 * @returns {string}
 */
function extractSeriesTitle(filename, mediaId) {
  if (!filename) return mediaId;
  const stem = stripExtension(filename);
  const cleaned = stem
    .replace(/\s+S\d+E\d+.*$/i, '')
    .replace(/\s+\b(19|20)\d{2}\b.*$/, '');
  return stemToTitle(cleaned, mediaId);
}

/**
 * Convert a release filename stem into a human-readable title.
 *
 * @param {string} stem
 * @param {string} mediaId
 * @returns {string}
 */
function stemToTitle(stem, mediaId) {
  const yearMatch = stem.match(/(?:^|[. _-])((?:19|20)\d{2})(?=$|[. _-])/);
  const titlePart = yearMatch
    ? stem.slice(0, yearMatch.index).trim()
    : stem.trim();
  return (
    titlePart
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || mediaId
  );
}

/**
 * Extract a year from a release filename, or null if not found.
 *
 * @param {string} filename
 * @returns {?number}
 */
function extractYear(filename) {
  if (!filename) return null;
  const m = filename.match(/(?:^|[. _-])((?:19|20)\d{2})(?=$|[. _-])/);
  return m ? Number(m[1]) : null;
}

/**
 * Strip the file extension from a filename.
 *
 * @param {string} filename
 * @returns {string}
 */
function stripExtension(filename) {
  return filename.replace(/\.[a-z0-9]{1,10}$/i, '');
}

/**
 * Fetch with timeout.
 *
 * @param {string} url
 * @param {Object} options - Fetch options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
