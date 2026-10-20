/**
 * The playback object route — `/play/:token`.
 *
 * This is the resolver-first surface: one HashSucker-owned URL, bound to one
 * authoritative TorrentFile, that streams the bytes through the existing
 * authoritative byte path.
 *
 * Ownership boundary — unchanged from the byte route, deliberately:
 *
 *   Node  owns identity: it verifies the token and resolves the exact
 *         TorrentFile the token names. It performs no Range arithmetic and
 *         no byte-exactness logic.
 *   Rust  owns bytes: the fixed-grid cache, per-chunk single-flight
 *         coalescing, provider recovery and the reactive same-TorrentFile
 *         failover all live there.
 *
 * Consequences that matter:
 *
 *   - The client never receives a provider URL, so it never holds a provider
 *     credential and never learns provider identity.
 *   - A route change underneath the SAME TorrentFile is invisible to the
 *     client: the URL, the TorrentFile and the bytes are unchanged, and the
 *     data plane re-opens at the same byte offset on another route.
 *   - A DIFFERENT TorrentFile can never silently satisfy this URL: the token
 *     names one exact file, and the data plane is asked for exactly that
 *     file's bytes.
 */

import { serveAuthoritativeBytes } from './bytes-route.js';
import {
  verifyPlaybackToken,
  PlaybackObjectError,
} from '../lib/resolver/playback-object.js';

/**
 * Serve `/play/:token`.
 *
 * @param {Object} params
 * @param {http.IncomingMessage} params.request
 * @param {http.ServerResponse} params.response
 * @param {string} params.token - the playback token
 * @param {string} params.secret - playback signing secret
 * @param {string} params.dataPlaneBaseUrl
 * @param {Function} params.fetchFn - injectable fetch (tests)
 * @param {number} [params.now] - epoch milliseconds
 * @param {Function} [params.onServingAttribution]
 * @returns {Promise<void>}
 */
export async function servePlaybackObject({
  request,
  response,
  token,
  secret,
  dataPlaneBaseUrl,
  fetchFn,
  now = Date.now(),
  onServingAttribution = null,
}) {
  // Verify first: an invalid or expired token must never reach the byte path.
  const { torrentFileId } = verifyPlaybackToken({ token, secret, now });

  // The byte path is the authoritative one; this route adds no byte logic of
  // its own. A data-plane failure surfaces as the data plane's own typed
  // status (416 / 502 / 503) and is never retargeted at a provider URL.
  await serveAuthoritativeBytes({
    request,
    response,
    tfId: torrentFileId,
    dataPlaneBaseUrl,
    fetchFn,
    onServingAttribution,
  });
}

export { PlaybackObjectError };
