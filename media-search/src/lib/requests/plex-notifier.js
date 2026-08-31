/**
 * Plex Notifier
 *
 * Asks Plex to partial-scan the VFS path of a newly fulfilled item, so the
 * library picks up the file that Hashsucker's WebDAV server has just
 * materialized under `/vfs/Movies/...` and `/vfs/TV/...`.
 *
 * Configuration: PLEX_URL, PLEX_TOKEN, section IDs, and Plex-visible roots.
 * Failure is non-fatal to fulfillment.
 */

import path from 'node:path';

const PLEX_TIMEOUT_MS = 5000;

function configFor(mediaType) {
  if (mediaType === 'movie') {
    return {
      sectionId: process.env.PLEX_MOVIES_SECTION_ID,
      root: process.env.PLEX_MOVIES_ROOT,
      collection: 'Movies',
    };
  }
  if (mediaType === 'series' || mediaType === 'tv') {
    return {
      sectionId: process.env.PLEX_TV_SECTION_ID,
      root: process.env.PLEX_TV_ROOT,
      collection: 'TV',
    };
  }
  return { sectionId: null, root: null, collection: null };
}

export function isPlexEnabled() {
  return Boolean(process.env.PLEX_URL && process.env.PLEX_TOKEN);
}

export async function notifyPlex({ mediaId, mediaType, canonicalPath }) {
  if (!isPlexEnabled()) {
    return { notified: false, method: null, error: null };
  }

  try {
    const { sectionId, root, collection } = configFor(mediaType);
    if (!sectionId || !root || !canonicalPath) {
      return { notified: false, method: null, error: 'Plex section, root, or canonical path is not configured' };
    }

    const segments = canonicalPath.split('/');
    if (path.posix.isAbsolute(canonicalPath)
      || !path.posix.isAbsolute(root)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
      || segments[0] !== collection
      || segments.length < 3) {
      throw new Error('Invalid canonical VFS path or Plex root');
    }
    const scanPath = path.posix.join(root, ...segments.slice(1, -1));
    const baseUrl = process.env.PLEX_URL.replace(/\/$/, '');
    const url = `${baseUrl}/library/sections/${sectionId}/refresh?path=${encodeURIComponent(scanPath)}`;
    console.log(`[Plex] Requesting partial scan: section=${sectionId} path=${scanPath}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Plex-Token': process.env.PLEX_TOKEN,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(PLEX_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Plex partial scan returned HTTP ${response.status}`);
    return { notified: true, method: 'partial-refresh', error: null };
  } catch (error) {
    const message = error.message || 'Unknown Plex error';
    console.error(`[Plex] Notification failed for ${mediaId}: ${message}`);
    return { notified: false, method: null, error: message };
  }
}
