/**
 * FILE-SIZE EVIDENCE — what a byte count actually proves.
 *
 * A byte count is EITHER the size of one file OR the size of a whole
 * release. The two are not interchangeable, and mixing them is a
 * correctness bug, not a rounding detail:
 *
 *   - a release total is the SUM of the release's files. It equals no
 *     single file's size (unless the release has exactly one non-empty
 *     file), so it can never PROVE a file. Presenting it as an exact file
 *     size guarantees a failed match and silently consumes a provider
 *     round-trip per candidate.
 *   - a per-file size identifies a file by its byte count within a
 *     release. It is meaningful evidence, and it is what the exact-file
 *     proof consumes.
 *
 * The two live sources differ in what they publish:
 *
 *   - the CORPUS is release-level by construction. Its byte count is the
 *     release's total: the corpus holds 1 593 139 candidate rows and
 *     1 593 141 release-attribute rows, and NOT ONE of them carries a
 *     file_index, a file_path, or a file_size. Every corpus row is
 *     release-level (file_index_key = -1). The corpus therefore has no
 *     per-file byte count to give, ever.
 *   - the UPSTREAM (a Stremio/debrid addon) publishes
 *     behaviorHints.videoSize. That number is the FILE's size when the
 *     stream identifies a file; when the stream identifies only the
 *     RELEASE, the number is the release's total.
 *
 * MEASURED, with the provider's authoritative file list as the referee:
 * a stream that names a FILE carries that file's exact size 97-99 % of
 * the time; a stream that names a RELEASE carries the release TOTAL
 * 44 % of the time (and 44 % a number close to but not equal to it).
 *
 * The discriminator is the SOURCE'S OWN SHAPE, never the number:
 *   - a stream names a FILE when it carries fileIdx, or when the
 *     filename it publishes names a file (a media extension).
 *   - a stream names the RELEASE when it carries neither.
 *
 * The number alone cannot decide this: a release total and a file size
 * are both "a plausible byte count", and only the provider's inventory
 * can tell them apart after the fact. Deciding BEFORE the fact is what
 * this module exists for.
 *
 * This module owns that discrimination. It NEVER lets a release total
 * reach the exact-file proof.
 */

/** The scope a byte count belongs to. */
export const SIZE_SCOPE = Object.freeze({
  /** The count is one file's exact byte count. */
  PER_FILE: 'per-file',
  /** The count is the release's total. */
  RELEASE: 'release',
  /** No usable byte count. */
  UNKNOWN: 'unknown',
});

/**
 * Media extensions that mark a published filename as naming a FILE.
 *
 * Mirrors the playable-video extension set used by the provider-side
 * TorrentFile filter (tv-episode-resolver.js), so "this name names a
 * file" means the same thing here as "this TorrentFile is playable
 * media" there. Kept local (not imported) so this module stays a pure
 * leaf with no dependency on the resolver layer.
 */
const MEDIA_FILE_EXTENSION = /\.(mkv|mp4|avi|mov|m4v|m2ts|ts|webm|mpg|mpeg|wmv|flv|vob|ogv)([ ._-]|$)/i;

/**
 * Does this published filename name a FILE inside the release?
 *
 * A scene release's name is the RELEASE's name ("Slow.Horses.S06E02.1080p
 * .x265-ELiTE"); the FILE it names carries a media extension
 * ("Slow.Horses.S06E02.1080p.x265-ELiTE.mkv"). The extension is the
 * difference, and it is a property of the SOURCE's published name, not
 * of anything we inferred.
 *
 * @param {string|null|undefined} name - the source's published filename
 * @returns {boolean}
 */
export function namesAFile(name) {
  if (typeof name !== 'string' || name.trim().length === 0) return false;
  return MEDIA_FILE_EXTENSION.test(name);
}

/**
 * Classify a byte count by what it can prove.
 *
 * @param {Object} params
 * @param {number|null|undefined} params.size - the byte count
 * @param {boolean} [params.namesFile] - whether the source's stream
 *   identifies a FILE inside the release (an upstream stream that carries
 *   fileIdx, or whose published filename names a file). A release-level
 *   source (the corpus) is never per-file.
 * @returns {string} one of SIZE_SCOPE
 */
export function classifySizeScope({ size, namesFile = false } = {}) {
  if (!Number.isSafeInteger(size) || size <= 0) return SIZE_SCOPE.UNKNOWN;
  return namesFile === true ? SIZE_SCOPE.PER_FILE : SIZE_SCOPE.RELEASE;
}

/**
 * Split a byte count into the two facts it may be.
 *
 * The result is deliberately explicit: `exactFileSize` is non-null ONLY
 * for a per-file count, so no consumer can accidentally treat a release
 * total as a file identity. `releaseSizeBytes` is release-level evidence
 * and is never an exact-file identity.
 *
 * @param {Object} params
 * @param {number|null|undefined} params.size
 * @param {boolean} [params.namesFile]
 * @returns {{scope: string, exactFileSize: number|null, releaseSizeBytes: number|null}}
 */
export function splitSizeEvidence({ size, namesFile = false } = {}) {
  const scope = classifySizeScope({ size, namesFile });
  if (scope === SIZE_SCOPE.PER_FILE) {
    return { scope, exactFileSize: size, releaseSizeBytes: null };
  }
  if (scope === SIZE_SCOPE.RELEASE) {
    return { scope, exactFileSize: null, releaseSizeBytes: size };
  }
  return { scope, exactFileSize: null, releaseSizeBytes: null };
}

/**
 * The per-file byte count of a candidate, or null.
 *
 * The single accessor the exact-file proof should use. It returns null
 * rather than a release total, so a release total can never satisfy the
 * proof by accident.
 *
 * @param {Object} candidate
 * @returns {number|null}
 */
export function exactFileSizeOf(candidate) {
  const size = candidate?.exactFileSize ?? candidate?.selectedFileSize;
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}
