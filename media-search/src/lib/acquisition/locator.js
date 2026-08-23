export const LOCATOR_TYPES = Object.freeze({
  MAGNET: 'magnet',
});

const MAGNET_INFO_HASH_PATTERN = /xt=urn:btih:([0-9a-fA-F]{40})/;

/**
 * Pure acquisition locator resolver — the boundary between a ranked candidate
 * and future provider execution.
 *
 * This function resolves an acquisition-capable locator from a candidate
 * without performing any provider execution, downloads, or network calls.
 *
 * The resolver does NOT:
 * - generate magnets from infoHash
 * - contact providers
 * - mutate the candidate
 * - execute placement
 *
 * @param {Object} input
 * @param {Object} input.candidate - Ranked candidate with magnet field.
 * @returns {Object} Frozen locator result.
 */
export function resolveAcquisitionLocator({ candidate } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('candidate is required');
  }

  if (!candidate.infoHash || typeof candidate.infoHash !== 'string') {
    throw new TypeError('candidate.infoHash is required');
  }

  if (!candidate.magnet || typeof candidate.magnet !== 'string') {
    throw new TypeError('candidate.magnet is required');
  }

  const magnet = candidate.magnet.trim();
  if (!magnet.startsWith('magnet:?')) {
    throw new TypeError('malformed magnet URI');
  }

  const match = magnet.match(MAGNET_INFO_HASH_PATTERN);
  if (!match) {
    throw new TypeError('malformed magnet URI: missing xt=urn:btih');
  }

  const magnetInfoHash = match[1].toLowerCase();
  const candidateInfoHash = candidate.infoHash.toLowerCase();

  if (magnetInfoHash !== candidateInfoHash) {
    throw new TypeError(
      `infoHash mismatch: candidate has ${candidateInfoHash}, magnet has ${magnetInfoHash}`
    );
  }

  return Object.freeze({
    locatorType: LOCATOR_TYPES.MAGNET,
    locatorValue: magnet,
    source: 'candidate',
  });
}
