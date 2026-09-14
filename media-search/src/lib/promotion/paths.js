/**
 * Permanent-storage destination contract (promotion tranche).
 *
 * Promotion destination lives under an explicit owned-storage root,
 * separate from appdata, the STRM publication tree, and hy4-cache.
 * HASHSUCKER_MEDIA_PATH remains STRM-only; this root exists because a
 * permanent copy is a genuine human storage decision, not tuning.
 *
 * Layout mirrors the STRM publication tree so one library item maps to
 * one obvious file, but with the REAL extension taken from the
 * TorrentFile internal path (STRM tree carries .strm pointers only).
 *
 * Partial files live in `<root>/.staging/` and are never valid final
 * output: restart recovery discards them and re-fetches cleanly.
 */

import path from 'node:path';

export const STAGING_DIRNAME = '.staging';
export const PARTIAL_SUFFIX = '.partial';

export function sanitizeSegment(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+$/g, '')
    .trim();
  return cleaned || fallback;
}

export function extensionOf(internalPath) {
  const base = path.posix.basename(String(internalPath ?? ''));
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '.bin';
  return base.slice(dot).toLowerCase();
}

/**
 * Resolve the final permanent path for a library item's TorrentFile.
 * Pure function of identity + TorrentFile: stable across restarts, so
 * recovery and serving never disagree about where bytes belong.
 */
export function resolvePermanentTarget({
  root,
  mediaType,
  title,
  year,
  season,
  episode,
  internalPath,
}) {
  if (!root) throw new Error('permanent storage root is required');
  const safeTitle = sanitizeSegment(title, 'Unknown Title');
  const yearSuffix = Number.isSafeInteger(year) && year > 0 ? ` (${year})` : '';
  const ext = extensionOf(internalPath);
  if (mediaType === 'episode' || (season != null && episode != null)) {
    const seasonDir = `Season ${String(season ?? 0).padStart(2, '0')}`;
    const epTag = `S${String(season ?? 0).padStart(2, '0')}E${String(episode ?? 0).padStart(2, '0')}`;
    const dir = path.join(root, 'TV Shows', `${safeTitle}${yearSuffix}`, seasonDir);
    return path.join(dir, `${safeTitle}${yearSuffix} - ${epTag}${ext}`);
  }
  const dir = path.join(root, 'Movies', `${safeTitle}${yearSuffix}`);
  return path.join(dir, `${safeTitle}${yearSuffix}${ext}`);
}

/** Temporary partial path for an in-flight materialization. */
export function resolveStagingTarget(root, torrentFileId) {
  if (!root) throw new Error('permanent storage root is required');
  if (!torrentFileId || /[/\\]/.test(String(torrentFileId))) {
    throw new Error('valid torrentFileId is required');
  }
  return path.join(root, STAGING_DIRNAME, `${torrentFileId}${PARTIAL_SUFFIX}`);
}

/** True when a candidate final path stays inside the owned root. */
export function isWithinRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}
