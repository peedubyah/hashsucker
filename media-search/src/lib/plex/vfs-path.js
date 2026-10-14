/**
 * Authoritative VFS -> Plex-visible mount path.
 *
 * The Plex-facing path is always `<PLEX_VFS_ROOT>/<canonicalPath>`, where the
 * canonical path is the durable publication truth (library_paths /
 * vfs_tv_entries). Nothing may synthesise a filename or extension: a guessed
 * path can never match the real Plex MediaPart, so it silently turns a
 * converged publication into an unconfirmed one.
 *
 * Measured in production: every series intent in `prepared`,
 * `published_preparing` or `playable` state carries an authoritative VFS
 * canonical path, so a fallback path is not merely unnecessary, it is
 * unreachable.
 */

/** VFS mount root that Plex scans. */
export const PLEX_VFS_ROOT = '/mnt/hashsucker-vfs';

/**
 * Absolute Plex-visible path for a durable canonical path, or null when there
 * is no authoritative publication to point at.
 */
export function vfsPartFile(canonicalPath) {
  if (typeof canonicalPath !== 'string') return null;
  const trimmed = canonicalPath.replace(/^\/+/, '').trim();
  if (!trimmed) return null;
  return `${PLEX_VFS_ROOT}/${trimmed}`;
}

/**
 * True when a Plex MediaPart path is the authoritative publication for
 * `canonicalPath`. Consumers use this so path construction and identity
 * comparison cannot drift apart.
 */
export function isAuthoritativePartFile(partFile, canonicalPath) {
  const expected = vfsPartFile(canonicalPath);
  return expected != null && partFile === expected;
}
