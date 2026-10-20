/**
 * EXACT FILE IDENTITY — the contract a provider file must satisfy before
 * it may carry a route to a TorrentFile.
 *
 * A TorrentFile is (infoHash, canonicalInternalPath, exact positive size).
 * A provider resource holds MANY files: renamed paths, reordered lists,
 * extras, samples, two files of the same size. So:
 *
 *   - the same infoHash proves the same RELEASE, not the same file;
 *   - a provider resource id proves the resource, not the file;
 *   - a file index proves a position in one listing, not an identity;
 *   - a size alone proves a number, not a file;
 *   - a path alone proves a name, not the bytes.
 *
 * A provider file may enter the route set of an authoritative TorrentFile
 * ONLY when its exact path AND its exact size match that TorrentFile.
 *
 * The providers do NOT frame a file's path the same way, so the comparison
 * is provider-specific:
 *
 *   TorBox       the file's `name` IS the torrent-relative path
 *                ("Root/file.mkv"), including the torrent's root folder.
 *   Real-Debrid  the file's `path` is RELATIVE to the torrent root; the
 *                full path is `<original_filename>/<path>`.
 *
 * The normalization below is the minimum needed to compare two framings
 * of the same logical file. It never loosens the comparison: a wrong file
 * still fails closed.
 */

/** Why an exact-file comparison failed. */
export const EXACT_FILE_REJECTIONS = Object.freeze({
  NO_PATH: 'no-path',
  NO_SIZE: 'no-size',
  PATH_MISMATCH: 'path-mismatch',
  SIZE_MISMATCH: 'size-mismatch',
  AMBIGUOUS: 'ambiguous',
  NOT_FOUND: 'not-found',
});

/**
 * The canonical form of a provider file path, for comparison.
 *
 * The rules are the minimum a comparison needs and no more:
 *   - a leading "/" is a framing artifact (Real-Debrid vs TorBox);
 *   - a leading "./" is a framing artifact;
 *   - the separators are forward slashes (a backslash is rejected: no
 *     provider in scope uses them);
 *   - the comparison is case-SENSITIVE (the providers preserve case, and
 *     loosening it would make "Movie.mkv" and "movie.mkv" the same file).
 *
 * @param {string} rawPath
 * @returns {string|null} the canonical path, or null when it is unusable
 */
export function canonicalProviderPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let p = rawPath.trim();
  if (p.length === 0) return null;
  if (p.includes('\\') || p.includes('\0')) return null;
  while (p.startsWith('/')) p = p.slice(1);
  while (p.startsWith('./')) p = p.slice(2);
  if (p.length === 0 || p === '.' || p === '..') return null;
  if (p.includes('/../') || p.endsWith('/..') || p.startsWith('../')) return null;
  return p;
}

/**
 * The full torrent-relative path of a Real-Debrid file.
 *
 * Real-Debrid lists each file RELATIVE to the torrent root and names the
 * root separately (`original_filename`). TorBox's file name already
 * includes the root. The two framings are reconciled here, once.
 *
 * @param {string} filePath - the provider's file path
 * @param {string} root - the provider's torrent root (Real-Debrid)
 * @returns {string|null}
 */
export function canonicalProviderFilePath(provider, filePath, root = null) {
  const relative = canonicalProviderPath(filePath);
  if (!relative) return null;
  if (provider !== 'realdebrid') return relative;
  const base = canonicalProviderPath(root ?? '');
  if (!base) return relative;
  return `${base}/${relative}`;
}

/**
 * The paths a provider file may be known by.
 *
 * Real-Debrid lists a file RELATIVE to the torrent root and names the root
 * separately, while a corpus release filename may carry either framing
 * (the full "Root/file.mkv" or the bare "file.mkv"). Both are the same
 * logical file, so both are accepted — and nothing else is. A file in a
 * subdirectory keeps its subdirectory in both framings, so it can never be
 * confused with a root-level file of the same name.
 */
export function canonicalProviderFilePathCandidates(provider, filePath, root = null) {
  const relative = canonicalProviderPath(filePath);
  if (!relative) return [];
  if (provider !== 'realdebrid') return [relative];
  const base = canonicalProviderPath(root ?? '');
  if (!base) return [relative];
  return [`${base}/${relative}`, relative];
}

/**
 * Does this provider file prove it IS this TorrentFile?
 *
 * @param {Object} params
 * @param {string} params.provider - 'torbox' | 'realdebrid'
 * @param {string} params.providerPath - the provider's path for the file
 * @param {string} [params.providerRoot] - the provider's torrent root (Real-Debrid)
 * @param {number|null} params.providerSize - the provider's exact byte count
 * @param {string} params.torrentFilePath - the TorrentFile's canonicalInternalPath
 * @param {number|null} params.torrentFileSize - the TorrentFile's exact size
 * @returns {{matched: boolean, reason: string|null}}
 */
export function exactFileIdentity({
  provider,
  providerPath,
  providerRoot = null,
  providerSize = null,
  torrentFilePath,
  torrentFileSize = null,
  caseInsensitive = false,
} = {}) {
  const candidates = canonicalProviderFilePathCandidates(provider, providerPath, providerRoot);
  if (candidates.length === 0) return { matched: false, reason: EXACT_FILE_REJECTIONS.NO_PATH };
  const actual = candidates[0];
  if (!Number.isSafeInteger(Number(providerSize)) || Number(providerSize) <= 0) {
    return { matched: false, reason: EXACT_FILE_REJECTIONS.NO_SIZE };
  }
  const expected = canonicalProviderPath(torrentFilePath);
  if (!expected) return { matched: false, reason: EXACT_FILE_REJECTIONS.NO_PATH };
  // The TorrentFile contract is CASE-SENSITIVE: a TorrentFile's path came
  // from the provider's own listing, so the two are the same string. The
  // case-insensitive mode exists for the ONE comparison that is not
  // against a TorrentFile: the discovery's release filename against a
  // provider's file name, where the casing is the corpus's own.
  const samePath = candidates.some((candidate) => (caseInsensitive
    ? candidate.toLowerCase() === expected.toLowerCase()
    : candidate === expected));
  if (!samePath) return { matched: false, reason: EXACT_FILE_REJECTIONS.PATH_MISMATCH };
  if (!Number.isSafeInteger(Number(torrentFileSize)) || Number(torrentFileSize) <= 0) {
    return { matched: false, reason: EXACT_FILE_REJECTIONS.NO_SIZE };
  }
  if (Number(providerSize) !== Number(torrentFileSize)) {
    return { matched: false, reason: EXACT_FILE_REJECTIONS.SIZE_MISMATCH };
  }
  return { matched: true, reason: null };
}

/**
 * Select the ONE provider file that proves it is the given TorrentFile.
 *
 * Zero matches → no route. Exactly one → the route. More than one →
 * ambiguous: fail closed (a provider-native identity would be needed to
 * disambiguate safely, and no provider offers one that is stable across a
 * refresh).
 *
 * @param {Object} params
 * @param {Array<{path: string, size: number|null, root?: string|null}>} params.providerFiles
 * @param {string} params.torrentFilePath
 * @param {number|null} params.torrentFileSize
 * @param {string} params.provider
 * @returns {{file: Object|null, matches: number, reason: string|null}}
 */
export function selectExactProviderFile({
  provider,
  providerFiles = [],
  torrentFilePath,
  torrentFileSize = null,
} = {}) {
  const matches = [];
  for (const file of providerFiles) {
    if (!file) continue;
    const identity = exactFileIdentity({
      provider,
      providerPath: file.path,
      providerRoot: file.root ?? null,
      providerSize: file.size ?? null,
      torrentFilePath,
      torrentFileSize,
    });
    if (identity.matched) matches.push(file);
  }
  if (matches.length === 1) return { file: matches[0], matches: 1, reason: null };
  if (matches.length === 0) return { file: null, matches: 0, reason: EXACT_FILE_REJECTIONS.NOT_FOUND };
  return { file: null, matches: matches.length, reason: EXACT_FILE_REJECTIONS.AMBIGUOUS };
}
