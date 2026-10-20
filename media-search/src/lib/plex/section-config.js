/**
 * Plex section geometry — single owner.
 *
 * Maps a media type to its Plex library section, filesystem root, and the
 * VFS collection segment that canonical paths must start with. Every Plex
 * surface (refresh notifier, deterministic ingest, request-path
 * confirmation) reads geometry from here so they can never disagree.
 *
 * Configuration is resolved per call (not at module load) so tests and
 * operators can repoint it via env.
 */

/**
 * @param {string} mediaType - 'movie', 'series', or 'tv'
 * @param {Object} [env=process.env]
 * @returns {{ sectionId: string|null, root: string|null, collection: string|null }}
 */
export function sectionConfigFor(mediaType, env = process.env) {
  if (mediaType === 'movie') {
    return {
      sectionId: env.PLEX_MOVIES_SECTION_ID || null,
      root: env.PLEX_MOVIES_ROOT || null,
      collection: 'Movies',
    };
  }
  if (mediaType === 'series' || mediaType === 'tv') {
    return {
      sectionId: env.PLEX_TV_SECTION_ID || null,
      root: env.PLEX_TV_ROOT || null,
      collection: 'TV',
    };
  }
  return { sectionId: null, root: null, collection: null };
}

/**
 * Host-side absolute path of a VFS entry's parent directory, used by
 * deterministic ingest to prove the file PMS actually scanned.
 *
 * @param {string} mediaType
 * @param {string} canonicalPath - VFS-relative canonical path ("TV/Show/Season 01/x.mkv")
 * @param {Object} [env]
 * @returns {string|null}
 */
export function sectionPartFileFor(mediaType, canonicalPath, env = process.env) {
  const { root } = sectionConfigFor(mediaType, env);
  if (!root || typeof canonicalPath !== 'string') return null;
  const segments = canonicalPath.split('/');
  if (segments.length < 2) return null;
  return `${root}/${segments.slice(1).join('/')}`;
}

/**
 * The expected Part file for a canonical path, derived ONCE.
 *
 * The two historical derivations — the section root and the mount point —
 * agreed only because the deployment happens to configure the roots that
 * way. A consumer Part comparison must not depend on that coincidence, so
 * both surfaces now read the same function.
 */
export { vfsPartFile as partFileForCanonicalPath } from './vfs-path.js';
