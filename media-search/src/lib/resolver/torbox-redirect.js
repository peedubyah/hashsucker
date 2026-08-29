/**
 * TorBox Redirect Resolver
 *
 * Resolves a selected candidate to a TorBox `requestdl` permalink for HTTP 307
 * redirect. This module is a pure function over persisted state — it makes
 * zero provider calls and persists nothing.
 *
 * Resolution contract:
 *   selected candidate (infoHash + fileIndex)
 *     → provider placement (torrent_id = provider_resource_id)
 *     → candidate_file_mappings (provider_file_id = actual TorBox file_id)
 *     → TorBox requestdl permalink
 *
 * Safety constraints:
 * - FileIndex is NEVER assumed to equal provider_file_id.
 * - fileIndex = null is NEVER coerced to 0.
 * - A missing mapping is a hard failure — we refuse to guess.
 */

const TORBOX_API_BASE = 'https://api.torbox.app/v1/api';

export class RedirectResolutionError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'RedirectResolutionError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Resolve a selected candidate to a TorBox requestdl permalink.
 *
 * @param {Object} selection - From getExistingSelection() with status='selected'
 * @param {Object} controlPlane - Control plane store with findPlacementByInfoHash + findFileMapping
 * @param {Object} [options] - Resolution options
 * @param {string} [options.apiKey] - TorBox API key (defaults to TORBOX_API_KEY env)
 * @param {string} [options.apiBase] - TorBox API base URL
 * @returns {Object} Resolution result with redirect URL and metadata
 * @throws {RedirectResolutionError} When resolution fails at any step
 */
export function resolveTorBoxRedirect(selection, controlPlane, options = {}) {
  if (!selection || selection.status !== 'selected') {
    throw new RedirectResolutionError(
      'No stored selection available',
      'NO_SELECTION',
      404
    );
  }

  if (selection.provider !== 'torbox') {
    throw new RedirectResolutionError(
      `Provider '${selection.provider}' is not resolvable via TorBox`,
      'PROVIDER_NOT_TORBOX',
      400
    );
  }

  const apiKey = options.apiKey || process.env.TORBOX_API_KEY;
  if (!apiKey) {
    throw new RedirectResolutionError(
      'TORBOX_API_KEY is required for redirect resolution',
      'MISSING_API_KEY',
      500
    );
  }

  const apiBase = options.apiBase || TORBOX_API_BASE;

  // Step 1: Find the TorBox placement by infoHash
  const placement = controlPlane.findPlacementByInfoHash('torbox', selection.selectedHash);
  if (!placement) {
    throw new RedirectResolutionError(
      'No TorBox torrent mapping found for selected hash',
      'MISSING_TORRENT_MAPPING',
      404
    );
  }

  const torrentId = placement.providerResourceId;

  // Step 2: Find the exact file mapping for this release
  // CRITICAL: We use releaseKey (infoHash:fileIndex), NOT an assumed file_id.
  // The mapping gives us the actual TorBox provider_file_id.
  const releaseKey = selection.releaseKey;
  const mapping = controlPlane.findFileMapping(releaseKey, placement.id);
  if (!mapping) {
    throw new RedirectResolutionError(
      `No file mapping found for release ${releaseKey}`,
      'MISSING_FILE_MAPPING',
      404
    );
  }

  if (mapping.state !== 'mapped') {
    throw new RedirectResolutionError(
      `File mapping in '${mapping.state}' state — cannot identify exact file safely`,
      'MAPPING_NOT_MAPPED',
      404
    );
  }

  const providerFileId = mapping.providerFileId;

  // Step 3: Build the TorBox requestdl permalink with redirect=true
  // TorBox recommends redirect=true for consumer permalinks.
  // This avoids minting fresh CDN URLs on every reconnect.
  const params = new URLSearchParams({
    token: apiKey,
    torrent_id: torrentId,
    file_id: providerFileId,
    redirect: 'true',
  });
  const permalink = `${apiBase}/torrents/requestdl?${params.toString()}`;

  return {
    status: 'redirect',
    redirectUrl: permalink,
    provider: 'torbox',
    torrentId,
    providerFileId,
    releaseKey,
    infoHash: selection.selectedHash,
    fileIndex: selection.fileIndex,
    mediaId: selection.mediaId,
    mediaType: selection.mediaType,
  };
}

/**
 * Format redirect metadata for logging (no secrets exposed).
 */
export function formatRedirectLog(result) {
  return {
    mediaId: result.mediaId,
    mediaType: result.mediaType,
    releaseKey: result.releaseKey,
    infoHash: result.infoHash,
    provider: result.provider,
    torrentId: result.torrentId,
    providerFileId: result.providerFileId,
  };
}
