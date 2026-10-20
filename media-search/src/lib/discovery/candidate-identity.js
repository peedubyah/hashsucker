/**
 * CANDIDATE IDENTITY — how strong a candidate's evidence is about WHICH
 * file it names.
 *
 * A TorrentFile is (infoHash, canonicalInternalPath, exact positive size).
 * The discovery chain knows the release for certain, and it knows a byte
 * count for the file a source pointed at. Whether it knows the file's
 * canonical torrent-relative PATH depends on the source, and today the
 * corpus does not (the audit: 1 593 141 corpus rows, 0 of them carry a
 * file-level path; the corpus's `filename` is the RELEASE's name).
 *
 * So a candidate's identity has a STRENGTH, and the strength must be
 * visible to every consumer:
 *
 *   EXACT_FILE          hash + canonical path + exact size — the candidate
 *                       names a TorrentFile.
 *   SIZE_CORROBORATED   hash + exact size, no path — the candidate names
 *                       a file BY ITS BYTE COUNT. This may DISCOVER a
 *                       provider resource, and inside that resource it may
 *                       select a file — but it may not authorize a route
 *                       unless the provider's own file identity confirms
 *                       it.
 *   RELEASE_ONLY        the release, no per-file fact at all.
 *
 * A weaker candidate must never masquerade as an exact one: the strength
 * travels with the candidate, and the consumers branch on it.
 */

/** The identity strengths a candidate can carry. */
export const CANDIDATE_IDENTITY = Object.freeze({
  EXACT_FILE: 'exact-file',
  SIZE_CORROBORATED: 'size-corroborated',
  RELEASE_ONLY: 'release-only',
});

/**
 * Classify a candidate's identity strength.
 *
 * @param {Object} params
 * @param {string|null} [params.infoHash]
 * @param {string|null} [params.internalPath] - the canonical torrent-relative path
 * @param {number|null} [params.exactFileSize] - the exact byte count
 * @returns {{strength: string, exact: boolean, reason: string|null}}
 */
export function classifyCandidateIdentity({
  infoHash = null,
  internalPath = null,
  exactFileSize = null,
} = {}) {
  const hasHash = typeof infoHash === 'string' && /^[0-9a-f]{40}$/i.test(infoHash.trim());
  const hasPath = typeof internalPath === 'string' && internalPath.trim().length > 0;
  const hasSize = Number.isSafeInteger(Number(exactFileSize)) && Number(exactFileSize) > 0;
  if (!hasHash) {
    return { strength: CANDIDATE_IDENTITY.RELEASE_ONLY, exact: false, reason: 'no-info-hash' };
  }
  if (hasPath && hasSize) {
    return { strength: CANDIDATE_IDENTITY.EXACT_FILE, exact: true, reason: null };
  }
  if (hasSize) {
    return {
      strength: CANDIDATE_IDENTITY.SIZE_CORROBORATED,
      exact: false,
      reason: 'no-file-path',
    };
  }
  if (hasPath) {
    return {
      strength: CANDIDATE_IDENTITY.SIZE_CORROBORATED,
      exact: false,
      reason: 'no-exact-size',
    };
  }
  return { strength: CANDIDATE_IDENTITY.RELEASE_ONLY, exact: false, reason: 'no-per-file-fact' };
}

/**
 * The evidence label a consumer should record for a candidate.
 *
 * @param {Object} candidate
 * @returns {string}
 */
export function identityLabelFor(candidate) {
  return candidate?.identityStrength
    ?? classifyCandidateIdentity(candidate).strength;
}
