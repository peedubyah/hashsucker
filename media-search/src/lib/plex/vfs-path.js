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
export function vfsPartFile(canonicalPath, env = process.env) {
  if (typeof canonicalPath !== 'string') return null;
  const trimmed = canonicalPath.replace(/^\/+/, '').trim();
  if (!trimmed) return null;
  const segments = trimmed.split('/');
  const collection = segments[0];
  // The section root the operator configured is the deployment truth; the
  // historical mount point is the fallback. ONE derivation, so the two
  // surfaces that compare a Part file cannot disagree about it.
  const root = collection === 'Movies'
    ? (env.PLEX_MOVIES_ROOT || `${PLEX_VFS_ROOT}/Movies`)
    : collection === 'TV'
      ? (env.PLEX_TV_ROOT || `${PLEX_VFS_ROOT}/TV`)
      : null;
  if (!root) return null;
  return `${root}/${segments.slice(1).join('/')}`;
}

/**
 * True when a Plex MediaPart path is the authoritative publication for
 * `canonicalPath`. Consumers use this so path construction and identity
 * comparison cannot drift apart.
 */
export function isAuthoritativePartFile(partFile, canonicalPath, env = process.env) {
  const expected = vfsPartFile(canonicalPath, env);
  return expected != null && partFile === expected;
}
