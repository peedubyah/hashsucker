/**
 * Representative TorBox API response shapes for observation mapping.
 *
 * Sourced from the documented TorBox v1 API and the existing
 * capability adapter contracts (torbox.js, torbox-inventory.js).
 * These are static fixtures — no live API calls.
 *
 * Granularity finding:
 *   - checkcached  : torrent-level only (infoHash, no fileIndex)
 *   - mylist       : placement + provider file inventory (opaque file IDs,
 *                    corpusFileIndex is explicitly null)
 */

export const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
export const OTHER_HASH = '1234567890abcdef1234567890abcdef12345678';

// ---------------------------------------------------------------------------
// checkcached — cache observation endpoint
// ---------------------------------------------------------------------------

/** Cached torrent: hash present with a truthy value. */
export function checkcachedHit(hash = HASH) {
  return {
    success: true,
    data: {
      [hash]: { name: 'Some.Release.2024.720p', size: 1_500_000_000 },
    },
  };
}

/** Missing torrent: hash absent (or falsy). */
export function checkcachedMiss() {
  return {
    success: true,
    data: {},
  };
}

/** Per-hash mixed: one cached, one not. */
export function checkcachedMixed(hitHash = HASH, missHash = OTHER_HASH) {
  return {
    success: true,
    data: {
      [hitHash]: { name: 'Cached.Release' },
      [missHash]: null,
    },
  };
}

/** Global failure: HTTP-level error (e.g., 401/403). */
export function checkcachedAuthError() {
  return {
    success: false,
    error: 'bad_token',
    detail: 'Invalid API key',
  };
}

/** Global failure: service-level error (e.g., 503). */
export function checkcachedServiceError() {
  return {
    success: false,
    error: 'service_unavailable',
    detail: 'Temporary failure',
  };
}

// ---------------------------------------------------------------------------
// mylist — account inventory endpoint
// ---------------------------------------------------------------------------

/** A ready/cached placement with provider file inventory. */
export function mylistResource(overrides = {}) {
  return {
    id: 77,
    hash: HASH,
    name: 'Some.Release.2024.720p',
    download_state: 'completed',
    files: [
      { id: 900, name: 'Some.Release.2024.720p/movie.mkv', size: 1_500_000_000, selected: true },
      { id: 901, name: 'Some.Release.2024.720p/subtitle.srt', size: 50_000, selected: false },
    ],
    ...overrides,
  };
}

/** Empty inventory (nothing placed). */
export function mylistEmpty() {
  return { success: true, data: [] };
}

/** A pending (downloading) placement. */
export function mylistPendingResource() {
  return mylistResource({ id: 88, download_state: 'downloading' });
}

/** A placement in an error state. */
export function mylistErrorResource() {
  return mylistResource({ id: 99, download_state: 'error' });
}

/** Multiple resources matching the same hash (ambiguous). */
export function mylistDuplicateHashResources() {
  return { success: true, data: [mylistResource(), mylistResource({ id: 78 })] };
}

/** Resource with no files (unusable for file inventory). */
export function mylistResourceNoFiles() {
  return mylistResource({ files: [] });
}

/** Resource with a malformed file entry (missing id). */
export function mylistResourceMalformedFile() {
  return mylistResource({ files: [{ name: 'broken.mkv', size: 100 }] });
}

/** Malformed top-level response (no data array). */
export function mylistMalformed() {
  return { success: true };
}

// ---------------------------------------------------------------------------
// createtorrent — placement creation endpoint
// ---------------------------------------------------------------------------

export const MAGNET = 'magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=Some+Release';

/** Successful torrent creation. */
export function createTorrentSuccess(id = 12345, hash = HASH) {
  return {
    success: true,
    data: {
      torrent_id: id,
      hash,
      filename: 'Some.Release.2024.720p.torrent',
    },
  };
}

/** Successful cached-only creation. */
export function createTorrentCachedOnlySuccess(id = 12345, hash = HASH) {
  return createTorrentSuccess(id, hash);
}

/** Provider rejection: hash not cached (when add_only_if_cached=true). */
export function createTorrentNotCached() {
  return {
    success: false,
    error: 'not_cached',
    detail: 'This torrent is not cached',
  };
}

/** Malformed response (success but no torrent_id). */
export function createTorrentMalformed() {
  return {
    success: true,
    data: { hash: HASH },
  };
}

/** Global failure: HTTP-level error (e.g., 401). */
export function createTorrentAuthError() {
  return {
    success: false,
    error: 'bad_token',
    detail: 'Invalid API key',
  };
}
