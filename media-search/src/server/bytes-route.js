/**
 * Cached byte delivery for external consumers (Jellyfin, and any client that
 * follows an `/stream` intent URL).
 *
 * The `/stream` resolver used to 307-redirect straight to the provider CDN,
 * so every client session pulled its own copy of the same bytes: two
 * concurrent sessions on one TorrentFile meant two full-file provider
 * transfers, and a full-quality transcode could exceed Jellyfin's own
 * budget over an uncached provider stream.
 *
 * This route is the redirect target instead. Node owns identity (the
 * caller resolved the authoritative Binding/TorrentFile before redirecting
 * here); the Rust data plane owns bytes, so the fixed-grid cache, per-chunk
 * single-flight coalescing, and provider recovery all apply exactly as they
 * do for Plex's VFS path.
 *
 * Range semantics are forwarded verbatim and the data plane's response is
 * proxied verbatim, so 206 / Content-Range / Content-Length / Accept-Ranges
 * / 416 / Retry-After keep their authoritative meaning. Nothing here is
 * Jellyfin-specific; it is the ordinary HTTP byte path.
 */

import { createLibraryIdentityKey } from '../lib/control-plane/canonical-path.js';
import { streamFromDataPlane, DataPlaneError } from '../lib/vfs/data-plane-forward.js';
import { WATERFALL_SESSION_HEADER, readSessionId } from '../lib/measurement/playback-waterfall.js';
import { markSession } from '../lib/measurement/session-store.js';

export class ByteRouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ByteRouteError';
  }
}

/**
 * Resolve the authoritative byte route for one media coordinate.
 *
 * Binding authority is the source of truth: the active Binding for the exact
 * library identity names the TorrentFile whose bytes the consumer should
 * receive. Returns the cached-byte URL for that TorrentFile, or null when
 * no Binding exists (the caller keeps the historical provider redirect).
 *
 * This does NOT re-run selection or discovery: it reads the Binding that
 * publication already wrote.
 *
 * @returns {Promise<{ torrentFileId: string, url: string }|null>}
 */
export async function resolveAuthoritativeByteRoute({
  controlPlaneStore,
  mediaType,
  mediaId,
  season = null,
  episode = null,
}) {
  if (!controlPlaneStore
    || typeof controlPlaneStore.getLibraryItemByIdentityKey !== 'function'
    || typeof controlPlaneStore.getActiveBindingForLibraryItem !== 'function') {
    return null;
  }
  let item;
  let binding;
  try {
    const itemKey = createLibraryIdentityKey({
      mediaType: mediaType === 'movie' ? 'movie' : 'episode',
      mediaId,
      season: mediaType === 'movie' ? null : season,
      episode: mediaType === 'movie' ? null : episode,
    });
    item = controlPlaneStore.getLibraryItemByIdentityKey(itemKey);
    if (!item) return null;
    binding = controlPlaneStore.getActiveBindingForLibraryItem(item.id);
  } catch {
    // An unreadable control plane is not a Binding: keep the existing route.
    return null;
  }
  const torrentFileId = binding?.torrentFile?.id ?? null;
  if (!torrentFileId || typeof torrentFileId !== 'string') return null;
  return {
    torrentFileId,
    url: `/bytes/${encodeURIComponent(torrentFileId)}`,
  };
}

/**
 * Serve `/bytes/:tfId` by proxying the Rust data plane's `/files/:tfId`.
 *
 * @param {Object} params
 * @param {http.IncomingMessage} params.request
 * @param {http.ServerResponse} params.response
 * @param {string} params.tfId - authoritative TorrentFile id (S-1 host id)
 * @param {string} params.dataPlaneBaseUrl
 * @param {Function} params.fetchFn - injectable fetch (tests)
 * @param {Function} [params.onServingAttribution]
 * @returns {Promise<void>}
 */
export async function serveAuthoritativeBytes({
  request,
  response,
  tfId,
  dataPlaneBaseUrl,
  fetchFn,
  contentType = null,
  onServingAttribution = null,
}) {
  const id = String(tfId ?? '').trim();
  if (!id || id.length > 128) {
    throw new ByteRouteError(400, 'INVALID_TORRENT_FILE_ID',
      'a TorrentFile id is required');
  }

  // The session id rides on to the data plane so its byte stages (first
  // byte request, provider request, provider first byte, first byte to
  // client) land on the SAME timeline as the server's and the player's.
  const sessionId = readSessionId(request.headers);
  // The player's first HTTP request has reached the server. Everything
  // after this is the byte path's cost.
  markSession(sessionId, 'first_http');

  try {
    await streamFromDataPlane({
      fetchFn,
      baseUrl: dataPlaneBaseUrl,
      tfId: id,
      request,
      response,
      contentType,
      onServingAttribution,
      ...(sessionId ? { sessionId } : {}),
    });
  } catch (error) {
    if (error instanceof DataPlaneError) {
      // Honest failure surface: the data plane's own classification is the
      // truth (client Range 416, provider exhaustion 502, transient 5xx).
      // Never retarget the client at a provider URL from here.
      throw new ByteRouteError(
        Number.isSafeInteger(error.status) ? error.status : 502,
        error.code,
        error.message,
      );
    }
    throw error;
  }
}
