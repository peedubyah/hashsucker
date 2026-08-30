/**
 * Seerr (Overseerr/Jellyseerr) Webhook — pure helpers
 *
 * Inbound webhook source. The HTTP handler at /api/ingress/seerr
 * translates an approved Seerr request into a MediaIntent and
 * inserts it through the existing media_intents pipeline. This
 * module owns the pure functions for that translation; it does NOT
 * register a provider with the intent registry (Seerr is push-only).
 *
 * Source semantics:
 * - source:      'seerr'
 * - sourceType:  'request'
 * - sourceId:    Seerr request_id (idempotency key)
 * - sourceLabel: Seerr {{subject}} (human readable context)
 *
 * Identity bundle (imdb_id, tmdb_id, tvdb_id) is preserved on the
 * media_intents row even though only one of those IDs becomes the
 * operational mediaId. The operational mediaId rules are:
 *   1. IMDb ID when present (raw `tt...`)
 *   2. otherwise TMDB form: `tmdb:<id>`
 *   3. otherwise TVDB form: `tvdb:<id>` (best-effort; the
 *      createRequestIntent seam accepts a string mediaId)
 *
 * Approval notification types are whitelisted. Other request events
 * are acknowledged but ignored. The Seerr "Test" notification is
 * not treated as actionable.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * Notification types we treat as actionable approvals.
 * Confirmed against this Seerr build:
 *   - MEDIA_AUTO_APPROVED  : real auto-approved request (e.g. Overseerr auto-approve)
 *   - MEDIA_APPROVED       : manually approved request
 * Speculative aliases (REQUEST_APPROVED, REQUEST_AUTOMATICALLY_APPROVED, ...)
 * are intentionally NOT in the whitelist until observed from this Seerr version.
 */
const APPROVAL_NOTIFICATION_TYPES = new Set([
  'MEDIA_AUTO_APPROVED',
  'MEDIA_APPROVED',
]);

/**
 * Notification type used by Seerr's "Test" button. Never actionable.
 */
const TEST_NOTIFICATION_TYPES = new Set([
  'TEST_NOTIFICATION',
  'TEST',
]);

const SEERR_PROVIDER_NAME = 'seerr';
const SEERR_PROVIDER_TYPE = 'request';

/**
 * Normalize a raw value that may be a string number, an actual number,
 * or a string with whitespace. Returns null for empty/'null'/'undefined'.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeIdString(value) {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value.trim() : String(value);
  if (!raw) return null;
  if (raw === 'null' || raw === 'undefined') return null;
  return raw;
}

/**
 * Normalize a TMDB/TVDB numeric ID to its canonical string form.
 * Rejects non-numeric content to keep the column clean.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeNumericIdString(value) {
  const raw = normalizeIdString(value);
  if (raw == null) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  return raw;
}

/**
 * Extract the media-bearing object from a Seerr payload. The template
 * renders {{media}} into a key whose literal name varies by Seerr
 * implementation, so we locate it by shape.
 *
 * Accepts these shapes:
 *   { media: { ... } }   // most Overseerr builds
 *   { Media: { ... } }
 *   { subject: "...", extra: [ { ... } ] }  // Test notifications
 *   top-level fields     // some custom builds
 *
 * @param {Object} body
 * @returns {{media: Object|null, request: Object|null, extra: any, notificationType: string|null, subject: string|null}}
 */
function extractSeerrEnvelope(body) {
  if (!body || typeof body !== 'object') {
    return { media: null, request: null, extra: null, notificationType: null, subject: null };
  }

  const media = body.media || body.Media || null;
  const request = body.request || body.Request || null;
  const extra = Object.prototype.hasOwnProperty.call(body, 'extra')
    ? body.extra
    : (Object.prototype.hasOwnProperty.call(body, 'Extra') ? body.Extra : null);
  const notificationType = normalizeIdString(
    body.notification_type || body.notificationType || body.event || null,
  );
  const subject = normalizeIdString(body.subject || body.Subject || null);

  return { media, request, extra, notificationType, subject };
}

/**
 * Derive the operational mediaId from a Seerr media object.
 * Rules (smallest compatible):
 *   1. IMDb when present and well-formed (tt followed by 7+ digits)
 *   2. otherwise TMDB in the seam's existing supported form `tmdb:<id>`
 *   3. otherwise TVDB in best-effort form `tvdb:<id>`
 *
 * @param {Object} mediaObj
 * @returns {{ mediaId: string, imdbId: string|null, tmdbId: string|null, tvdbId: string|null }|null}
 */
export function deriveMediaIdentity(mediaObj) {
  if (!mediaObj || typeof mediaObj !== 'object') return null;

  const imdbId = normalizeIdString(mediaObj.imdbId || mediaObj.imdb_id || null);
  const tmdbId = normalizeNumericIdString(mediaObj.tmdbId || mediaObj.tmdb_id || null);
  const tvdbId = normalizeNumericIdString(mediaObj.tvdbId || mediaObj.tvdb_id || null);

  if (imdbId && /^tt[0-9]{7,}$/.test(imdbId)) {
    return { mediaId: imdbId, imdbId, tmdbId, tvdbId };
  }
  if (tmdbId) {
    return { mediaId: `tmdb:${tmdbId}`, imdbId, tmdbId, tvdbId };
  }
  if (tvdbId) {
    return { mediaId: `tvdb:${tvdbId}`, imdbId, tmdbId, tvdbId };
  }
  return null;
}

/**
 * Normalize Seerr media_type to HashSucker's operational form.
 * @param {string|null} mediaType
 * @returns {'movie'|'series'|null}
 */
function deriveMediaType(mediaType) {
  const t = normalizeIdString(mediaType);
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === 'movie' || lower === 'film') return 'movie';
  if (lower === 'tv' || lower === 'series' || lower === 'show') return 'series';
  return null;
}

/**
 * Build a MediaIntent from a Seerr payload. Pure function; no I/O.
 * Returns `{ ignored: true, reason }` for non-actionable payloads.
 * Returns `{ ok: true, intent }` for actionable payloads.
 * Returns `{ error: string }` for malformed payloads.
 *
 * @param {Object} body
 * @returns {{ok: true, intent: Object, notificationType: string, subject: string|null, extra: any}|{ignored: true, reason: string, notificationType: string|null}|{error: string}}
 */
export function buildSeerrIntent(body) {
  const { media, request, extra, notificationType, subject } = extractSeerrEnvelope(body);

  if (notificationType && TEST_NOTIFICATION_TYPES.has(notificationType)) {
    return { ignored: true, reason: 'test-notification', notificationType };
  }

  const isApproval = !notificationType || APPROVAL_NOTIFICATION_TYPES.has(notificationType);

  // Need at least a request id for idempotency and the media object
  // for identity. Without those we cannot process.
  const requestId = request
    ? normalizeIdString(request.request_id || request.requestId || request.id)
    : null;

  if (!requestId) {
    return { error: 'Missing Seerr request_id' };
  }
  if (!media || typeof media !== 'object') {
    return { error: 'Missing Seerr media object' };
  }

  const mediaType = deriveMediaType(media.media_type || media.mediaType);
  if (!mediaType) {
    return { error: 'Missing or invalid Seerr media_type' };
  }

  const identity = deriveMediaIdentity(media);
  if (!identity) {
    return { error: 'Seerr media object lacks IMDb, TMDB, or TVDB identity' };
  }

  if (!isApproval) {
    // Not an approval-equivalent notification. Acknowledge but ignore.
    return {
      ignored: true,
      reason: `non-approval-notification:${notificationType || 'unknown'}`,
      notificationType,
    };
  }

  // Preserve library-object identifiers in sourceLabel as a compact
  // human-readable marker. They are NOT canonical media IDs and must
  // never be used as the operational mediaId.
  const libraryHints = [];
  const plexRatingKey = normalizeIdString(media.plexRatingKey || media.plex_rating_key);
  const jellyfinMediaId = normalizeIdString(media.jellyfinMediaId || media.jellyfin_media_id);
  if (plexRatingKey) libraryHints.push(`plex:${plexRatingKey}`);
  if (jellyfinMediaId) libraryHints.push(`jf:${jellyfinMediaId}`);
  const baseLabel = subject || '';
  const sourceLabel = libraryHints.length
    ? (baseLabel ? `${baseLabel} [${libraryHints.join(' ')}]` : `[${libraryHints.join(' ')}]`)
    : (baseLabel || null);

  const intent = {
    mediaId: identity.mediaId,
    mediaType,
    season: null,
    episode: null,
    source: SEERR_PROVIDER_NAME,
    sourceType: SEERR_PROVIDER_TYPE,
    sourceId: requestId,
    sourceLabel,
    status: 'active',
    priority: 100, // explicit user request, above background work
    requestedBy: null, // do not capture user data
    imdbId: identity.imdbId,
    tmdbId: identity.tmdbId,
    tvdbId: identity.tvdbId,
    // Raw extras are intentionally not preserved in v1; we will
    // observe the real Seerr `extra` shape via the canary and decide
    // later whether a schema field is warranted.
  };

  return { ok: true, intent, notificationType: notificationType || 'REQUEST_APPROVED', subject, extra };
}

/**
 * Parse the requested-season list from a Seerr webhook extra field.
 *
 * Seerr emits:
 *   extra: [{ name: 'Requested Seasons', value: '1, 3' }]
 *
 * Contract:
 *  - find the entry whose name is 'Requested Seasons' (case-insensitive)
 *  - split its string value on comma
 *  - trim each token
 *  - accept only positive integers
 *  - dedupe
 *  - numeric sort ascending
 *
 * Failure modes (return { valid: false, reason }):
 *  - extra is not an array                       → 'extra-not-an-array'
 *  - entry's value is not a string               → 'extra-season-value-not-a-string'
 *  - entry's value is empty or whitespace-only   → 'extra-season-value-empty'
 *  - any token is not a positive integer         → 'extra-season-value-not-integer:<token>'
 *  - any token is zero/negative                  → 'extra-season-value-not-positive:<token>'
 *
 * Pass 1: this helper does NOT touch app.js, the handler, searchByMedia,
 * the DB, or production. It only parses; the caller decides what to do
 * with the result.
 *
 * @param {any} extra
 * @returns {{ valid: true, seasons: number[] } | { valid: false, reason: string }}
 */
export function parseRequestedSeasons(extra) {
  if (!Array.isArray(extra)) {
    return { valid: false, reason: 'extra-not-an-array' };
  }

  const entry = extra.find(
    (e) =>
      e &&
      typeof e === 'object' &&
      typeof e.name === 'string' &&
      e.name.trim().toLowerCase() === 'requested seasons',
  );

  if (!entry) {
    // No 'Requested Seasons' entry is present. Missing season
    // information is treated as an explicit failure — we never
    // interpret a missing entry as "all seasons" or "no seasons".
    return { valid: false, reason: 'requested-seasons-missing' };
  }

  const rawValue = entry.value;
  if (typeof rawValue !== 'string') {
    return { valid: false, reason: 'extra-season-value-not-a-string' };
  }
  if (!rawValue.trim()) {
    return { valid: false, reason: 'extra-season-value-empty' };
  }

  const tokens = rawValue.split(',');
  const seen = new Set();
  const seasons = [];

  for (const raw of tokens) {
    const trimmed = raw.trim();
    if (!trimmed) {
      // Empty segment from a stray comma — not malformed, just skip.
      continue;
    }
    if (!/^[1-9][0-9]*$/.test(trimmed)) {
      return { valid: false, reason: `extra-season-value-not-positive-integer:${trimmed}` };
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num <= 0) {
      // Defensive: the regex above already guarantees positive, but keep
      // the explicit guard in case the regex is ever loosened.
      return { valid: false, reason: `extra-season-value-not-positive:${trimmed}` };
    }
    if (!seen.has(num)) {
      seen.add(num);
      seasons.push(num);
    }
  }

  seasons.sort((a, b) => a - b);
  return { valid: true, seasons };
}

/**
 * Fetch concrete episodes for one TV season via the Seerr TV API.
 *
 *   GET {SEERR_URL}/api/v1/tv/{tmdbId}/season/{seasonNumber}
 *
 * Reuses the same env seam (SEERR_URL, SEERR_API_KEY, fetch) and the
 * same 5–8s abort pattern as `resolveSeerrIdentity`. Returns only the
 * fields the caller needs to drive episode-level searchByMedia.
 *
 * Failure modes (rejected promise with .code):
 *  - missing env (no SEERR_URL or no SEERR_API_KEY) → 'identity-misconfigured'
 *  - non-OK response                                → 'identity-not-found' (404)
 *                                                    or 'identity-unavailable' (other)
 *  - non-JSON body                                  → 'identity-unparseable'
 *  - abort / network                                → 'identity-unavailable'
 *
 * @param {number|string} tmdbId
 * @param {number} seasonNumber
 * @param {{ SEERR_URL: string, SEERR_API_KEY: string, fetch?: typeof fetch }} env
 * @returns {Promise<Array<{ episodeNumber: number, name: string, airDate: string|null, id: number }>>}
 */
export async function resolveSeerrSeasonEpisodes(tmdbId, seasonNumber, env = process.env) {
  const baseUrl = String(env.SEERR_URL || '').trim();
  const apiKey = String(env.SEERR_API_KEY || '').trim();
  if (!baseUrl || !apiKey) {
    const err = new Error('seerr-env-missing');
    err.code = 'identity-misconfigured';
    throw err;
  }

  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/v1/tv/${encodeURIComponent(String(tmdbId))}/season/${encodeURIComponent(String(seasonNumber))}`;
  const f = typeof env.fetch === 'function' ? env.fetch : fetch;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let resp;
  try {
    resp = await f(endpoint, {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        Accept: 'application/json',
        'User-Agent': 'hashsucker-seerr-ingress/1.0',
      },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const code = resp.status === 404 ? 'identity-not-found' : 'identity-unavailable';
    const err = new Error(`seerr-season-api-${code}:${resp.status}`);
    err.code = code;
    err.status = resp.status;
    throw err;
  }

  let body;
  try {
    body = await resp.json();
  } catch {
    const err = new Error('seerr-season-api-unparseable');
    err.code = 'identity-unparseable';
    throw err;
  }

  if (!body || !Array.isArray(body.episodes)) {
    return [];
  }

  return body.episodes
    .filter((e) => e && typeof e.episodeNumber === 'number' && e.episodeNumber > 0)
    .map((e) => ({
      episodeNumber: e.episodeNumber,
      name: typeof e.name === 'string' ? e.name : '',
      airDate: e.airDate != null ? String(e.airDate) : null,
      id: typeof e.id === 'number' ? e.id : 0,
    }));
}

/**
 * Constant-time string equality for bearer token validation. Uses
 * node:crypto.timingSafeEqual with equal-length buffers.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Validate a Seerr webhook Authorization header against the configured
 * shared token. Fails closed when no token is configured.
 *
 * @param {string|null|undefined} authHeader
 * @param {string|null|undefined} configuredToken
 * @returns {{ ok: true }|{ ok: false, status: number, reason: string }}
 */
export function checkSeerrAuth(authHeader, configuredToken) {
  if (!configuredToken || typeof configuredToken !== 'string') {
    return { ok: false, status: 503, reason: 'service-misconfigured' };
  }
  if (!authHeader || typeof authHeader !== 'string') {
    return { ok: false, status: 401, reason: 'missing-authorization' };
  }
  const match = /^Bearer\s+(.+)$/.exec(authHeader.trim());
  if (!match) {
    return { ok: false, status: 401, reason: 'malformed-authorization' };
  }
  if (!safeEqualString(match[1], configuredToken)) {
    return { ok: false, status: 401, reason: 'invalid-token' };
  }
  return { ok: true };
}

export const SEERR_CONSTANTS = Object.freeze({
  NAME: SEERR_PROVIDER_NAME,
  TYPE: SEERR_PROVIDER_TYPE,
  APPROVAL_NOTIFICATION_TYPES: Array.from(APPROVAL_NOTIFICATION_TYPES),
  TEST_NOTIFICATION_TYPES: Array.from(TEST_NOTIFICATION_TYPES),
});
