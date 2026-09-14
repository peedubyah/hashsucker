/**
 * Download staging destination contract (download-intent tranche).
 *
 * One explicit root, derived namespaces, no downloader tags, no Arr
 * categories or root-folder/profile semantics — media identity alone
 * determines the namespace:
 *
 *   <root>/movies/Title (Year)/Title (Year).ext
 *   <root>/tv/Series (Year)/Season XX/Series (Year) - SxxExx.ext
 *
 * Deterministic, human-readable, suitable for external importers.
 * Original media extension preserved from the TorrentFile internal
 * path. This tree is HashSucker-owned staging/output: HashSucker owns
 * .partial files, failed artifacts, and empty dirs it created — never
 * whatever final library path a downstream importer moves files into.
 */

import path from 'node:path';

import { sanitizeSegment, extensionOf } from '../promotion/paths.js';

export const STAGING_DIRNAME = '.staging';
export { PARTIAL_SUFFIX } from '../materialize/materialize.js';

export function resolveStagedTarget({
  root,
  mediaType,
  title,
  year,
  season,
  episode,
  internalPath,
}) {
  if (!root) throw new Error('download storage root is required');
  const safeTitle = sanitizeSegment(title, 'Unknown Title');
  const yearSuffix = Number.isSafeInteger(year) && year > 0 ? ` (${year})` : '';
  const ext = extensionOf(internalPath);
  if (mediaType === 'episode') {
    const seasonDir = `Season ${String(season ?? 0).padStart(2, '0')}`;
    const epTag = `S${String(season ?? 0).padStart(2, '0')}E${String(episode ?? 0).padStart(2, '0')}`;
    const dir = path.join(root, 'tv', `${safeTitle}${yearSuffix}`, seasonDir);
    return path.join(dir, `${safeTitle}${yearSuffix} - ${epTag}${ext}`);
  }
  const dir = path.join(root, 'movies', `${safeTitle}${yearSuffix}`);
  return path.join(dir, `${safeTitle}${yearSuffix}${ext}`);
}

/** True when a candidate final path stays inside the owned root. */
export function isWithinRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}
