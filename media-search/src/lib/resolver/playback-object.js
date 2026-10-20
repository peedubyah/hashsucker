/**
 * The playback object — HashSucker's own, stable playback URL.
 *
 * WHY THIS EXISTS
 *
 * The resolver (`/stream/:type/:id`) used to answer with `307` to a
 * provider-backed URL (a Real-Debrid / TorBox CDN link). That handed the
 * client a bearer credential for the provider's cache and moved the byte
 * path outside HashSucker, so:
 *
 *   - a route change underneath the same exact TorrentFile was invisible to
 *     HashSucker and unavoidable for the client (the client had the provider
 *     URL in its hand), and
 *   - the provider URL — a credential — was exposed to every client that
 *     resolved the item.
 *
 * The playback object replaces that with one HashSucker-owned URL that is
 * bound to the authoritative TorrentFile and proxies the bytes through the
 * existing authoritative byte path (`/bytes/:tfId` → the Rust data plane).
 *
 * IDENTITY — WHAT THE URL IS BOUND TO
 *
 *   durable media identity : the TorrentFile (its exact row id; the row
 *                             carries infoHash + canonicalInternalPath +
 *                             exact size)
 *   runtime session material: an expiry
 *
 * Deliberately NOT bound to: a provider, a placement, a current route, a
 * consumer item, a library path, or a `.strm` target. Those are replaceable
 * observations; the TorrentFile is the fact.
 *
 * The same-TorrentFile route changes MAY occur underneath this URL. A
 * different-TorrentFile representation change is NOT expressible here: the
 * token names one exact file and the bytes served are always that file's.
 *
 * MECHANICS
 *
 * The token is `base64url(payload).base64url(HMAC-SHA256(secret, payload))`.
 * It is:
 *
 *   - opaque to the client (it names no provider and no path),
 *   - tamper-evident (a forged or edited token fails verification),
 *   - stateless (no new persistence table; the media identity stays durable
 *     in the TorrentFile row and the token only carries its id),
 *   - restart-safe (the signing secret is configuration, not runtime state,
 *     so a HashSucker restart does not invalidate an outstanding URL).
 *
 * The payload is base64, not encrypted: the TorrentFile id is recoverable by
 * anyone who decodes the token. That is deliberate and acceptable — the
 * TorrentFile id is internal identity, not a credential, and it is already
 * exposed by the existing `/bytes/:tfId` route. What the token adds is
 * tamper-evidence and an explicit expiry, not secrecy.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Payload schema version. A token minted by another version is rejected. */
export const PLAYBACK_OBJECT_VERSION = 1;

/** Default lifetime of a playback URL: one day (long enough for any session). */
export const DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** Minimum accepted signing-secret length. Short secrets are refused. */
export const MIN_PLAYBACK_SECRET_LENGTH = 16;

/** Maximum accepted TorrentFile id length (matches the byte route's bound). */
const MAX_TORRENT_FILE_ID_LENGTH = 128;

/**
 * A typed, bounded failure of the playback object.
 *
 * `status` is the client-facing HTTP status; `code` is the stable machine
 * code. Nothing provider-specific ever appears in either.
 */
export class PlaybackObjectError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PlaybackObjectError';
    this.status = status;
    this.code = code;
  }
}

function base64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(value, 'base64url');
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest();
}

/**
 * Read the playback signing secret from the environment.
 *
 * @param {object} env
 * @returns {string|null} the secret, or null when it is not configured
 */
export function readPlaybackSecret(env) {
  const raw = env?.PLAYBACK_TOKEN_SECRET;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < MIN_PLAYBACK_SECRET_LENGTH) return null;
  return trimmed;
}

/**
 * Resolve the effective TTL in seconds.
 *
 * `PLAYBACK_TOKEN_TTL_SECONDS` overrides the default. `0` means "no expiry",
 * and must be set explicitly — an unbounded playback URL is never the
 * default.
 *
 * @param {object} env
 * @returns {number} seconds (0 = no expiry)
 */
export function readPlaybackTtlSeconds(env) {
  const raw = env?.PLAYBACK_TOKEN_TTL_SECONDS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS;
  return parsed;
}

function assertUsableSecret(secret) {
  if (typeof secret !== 'string' || secret.length < MIN_PLAYBACK_SECRET_LENGTH) {
    throw new PlaybackObjectError(
      503,
      'PLAYBACK_OBJECT_UNAVAILABLE',
      'playback objects are unavailable: no usable signing secret is configured',
    );
  }
}

function assertUsableTorrentFileId(torrentFileId) {
  if (typeof torrentFileId !== 'string' || torrentFileId.trim() === '') {
    throw new PlaybackObjectError(400, 'INVALID_TORRENT_FILE_ID', 'a TorrentFile id is required');
  }
  const trimmed = torrentFileId.trim();
  if (trimmed.length > MAX_TORRENT_FILE_ID_LENGTH) {
    throw new PlaybackObjectError(400, 'INVALID_TORRENT_FILE_ID', 'the TorrentFile id is malformed');
  }
  return trimmed;
}

/**
 * Mint a playback URL token for one exact TorrentFile.
 *
 * @param {object} args
 * @param {string} args.torrentFileId - authoritative TorrentFile row id
 * @param {string} args.secret - signing secret (>= 16 chars)
 * @param {number} [args.ttlSeconds] - lifetime; 0 means no expiry
 * @param {number} [args.now] - epoch milliseconds
 * @returns {{ token: string, expiresAt: number|null }}
 */
export function mintPlaybackToken({ torrentFileId, secret, ttlSeconds, now = Date.now() }) {
  assertUsableSecret(secret);
  const tfId = assertUsableTorrentFileId(torrentFileId);
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds >= 0
    ? Math.floor(ttlSeconds)
    : DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS;
  const expiresAt = ttl > 0 ? Math.floor(now / 1000) + ttl : null;
  const payload = JSON.stringify({
    v: PLAYBACK_OBJECT_VERSION,
    tf: tfId,
    ...(expiresAt != null ? { exp: expiresAt } : {}),
  });
  const encoded = base64urlEncode(Buffer.from(payload, 'utf8'));
  const signature = base64urlEncode(sign(encoded, secret));
  return { token: `${encoded}.${signature}`, expiresAt };
}

/**
 * Verify a playback token and return the TorrentFile it names.
 *
 * Never throws for an ordinary bad token beyond the typed
 * `PlaybackObjectError`: an invalid signature, an unknown version, a
 * malformed payload and an expired token are four distinct, stable
 * outcomes.
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.secret
 * @param {number} [args.now] - epoch milliseconds
 * @returns {{ torrentFileId: string, expiresAt: number|null }}
 */
export function verifyPlaybackToken({ token, secret, now = Date.now() }) {
  assertUsableSecret(secret);
  if (typeof token !== 'string' || token.trim() === '') {
    throw new PlaybackObjectError(403, 'PLAYBACK_TOKEN_INVALID', 'the playback token is not valid');
  }
  const trimmed = token.trim();
  const separator = trimmed.indexOf('.');
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new PlaybackObjectError(403, 'PLAYBACK_TOKEN_INVALID', 'the playback token is not valid');
  }
  const encoded = trimmed.slice(0, separator);
  const provided = trimmed.slice(separator + 1);
  const expected = sign(encoded, secret);
  let providedBytes;
  try {
    providedBytes = base64urlDecode(provided);
  } catch {
    throw new PlaybackObjectError(403, 'PLAYBACK_TOKEN_INVALID', 'the playback token is not valid');
  }
  if (providedBytes.length !== expected.length || !timingSafeEqual(providedBytes, expected)) {
    throw new PlaybackObjectError(403, 'PLAYBACK_TOKEN_INVALID', 'the playback token is not valid');
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encoded).toString('utf8'));
  } catch {
    throw new PlaybackObjectError(403, 'PLAYBACK_TOKEN_INVALID', 'the playback token is not valid');
  }
  if (!payload || payload.v !== PLAYBACK_OBJECT_VERSION) {
    throw new PlaybackObjectError(403, 'PLAYBACK_TOKEN_INVALID', 'the playback token is not valid');
  }
  const tfId = assertUsableTorrentFileId(payload.tf);
  const expiresAt = Number.isFinite(payload.exp) ? payload.exp : null;
  if (expiresAt != null && Math.floor(now / 1000) >= expiresAt) {
    throw new PlaybackObjectError(410, 'PLAYBACK_TOKEN_EXPIRED', 'the playback token has expired');
  }
  return { torrentFileId: tfId, expiresAt };
}

/**
 * Build the absolute path of a playback URL for a minted token.
 *
 * @param {string} token
 * @returns {string}
 */
export function playbackObjectPath(token) {
  return `/play/${encodeURIComponent(token)}`;
}
