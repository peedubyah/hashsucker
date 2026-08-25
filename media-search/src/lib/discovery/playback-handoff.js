/**
 * Playback Handoff Builder
 *
 * Constructs a stable handoff contract from a successful candidate selection.
 * Pure function — no I/O, no provider calls, no URL generation.
 *
 * The handoff represents the exact candidate chosen for playback, preserving
 * all identity and availability context needed for subsequent resolution.
 */

/**
 * Build a playback handoff from a selection result.
 *
 * @param {Object} selection - Result from selectBestCandidate()
 * @param {Object} request - Original media request context
 * @param {string} request.requestId - Media request ID
 * @param {string} request.mediaId - Media identifier
 * @param {string} request.mediaType - 'movie' or 'series'
 * @param {number} [request.season] - Season number
 * @param {number} [request.episode] - Episode number
 * @returns {Object|null} Handoff object, or null if selection is invalid
 */
export function buildPlaybackHandoff(selection, request) {
  // Refuse to build handoff for no-selection or ineligible candidates
  if (!selection || !selection.selected) {
    return null;
  }

  const sel = selection.selected;

  // Validate required fields
  if (!sel.infoHash || !sel.filename) {
    return null;
  }

  // Determine provider from availability observation
  // Default to 'torbox' if no specific provider info available
  const provider = sel.torboxState ? 'torbox' : 'unknown';

  // Build release key from infoHash and fileIndex
  // Preserve fileIndex = null distinctly from 0
  const fileIndex = sel.fileIndex != null ? sel.fileIndex : null;
  const releaseKey = `${sel.infoHash}:${fileIndex === null ? 'torrent' : fileIndex}`;

  // Extract resolution state from release metadata or identity
  const resolutionState = sel.release?.resolution
    ? 'resolved'
    : (sel.identityTier === 'Verified' ? 'confirmed' : 'probable');

  return {
    requestId: request.requestId || null,
    mediaId: request.mediaId || null,
    mediaType: request.mediaType || 'movie',
    season: request.season ?? null,
    episode: request.episode ?? null,
    releaseKey,
    infoHash: sel.infoHash,
    fileIndex,
    filename: sel.filename,
    provider,
    providerState: sel.torboxState || 'unknown',
    identityTier: sel.identityTier || 'unknown',
    resolutionState,
    selectionReason: selection.reason || 'unknown',
    selectedAt: Date.now(),
  };
}

/**
 * Validate a handoff object structure.
 *
 * @param {Object} handoff - Handoff to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePlaybackHandoff(handoff) {
  const errors = [];

  if (!handoff || typeof handoff !== 'object') {
    return { valid: false, errors: ['handoff must be an object'] };
  }

  if (!handoff.infoHash || typeof handoff.infoHash !== 'string') {
    errors.push('infoHash is required');
  }

  if (!handoff.releaseKey || typeof handoff.releaseKey !== 'string') {
    errors.push('releaseKey is required');
  }

  if (!handoff.mediaId || typeof handoff.mediaId !== 'string') {
    errors.push('mediaId is required');
  }

  if (!handoff.mediaType || !['movie', 'series'].includes(handoff.mediaType)) {
    errors.push('mediaType must be movie or series');
  }

  if (!handoff.provider || typeof handoff.provider !== 'string') {
    errors.push('provider is required');
  }

  if (!handoff.providerState || !['cached', 'uncached', 'unknown'].includes(handoff.providerState)) {
    errors.push('providerState must be cached, uncached, or unknown');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
