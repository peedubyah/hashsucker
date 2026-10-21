/**
 * The playback object API — one step from a media intent to a stable,
 * HashSucker-owned playback URL.
 *
 * This is NOT a second discovery or ranking path. It is a thin adapter over
 * the authority that already exists:
 *
 *   title → media identity      the existing metadata search (`searchTitles`)
 *   media identity → Binding    the existing request pipeline (`searchByMedia`)
 *   Binding → TorrentFile       the control plane's active Binding
 *   TorrentFile → playback URL  the signed playback object
 *
 * The warm path (the media already has an active Binding) performs **no
 * discovery, no provider inventory and no provider API call**: it reads the
 * Binding and mints the object. The cold path runs the existing request
 * pipeline — the same chain a Seerr request runs — and then mints the object.
 *
 * The client never sees a provider, a placement, a route, a capability URL or
 * a credential. It receives a media identity, a display title, the
 * authoritative TorrentFile id (diagnostics) and the playback URL.
 */

import { createLibraryIdentityKey } from '../lib/control-plane/canonical-path.js';
import { searchTitles } from '../lib/metadata/unified-search.js';
import {
  mintPlaybackToken,
  playbackObjectPath,
  readPlaybackSecret,
  readPlaybackTtlSeconds,
} from '../lib/resolver/playback-object.js';

/**
 * A typed, client-facing failure. `status` is the HTTP status, `code` the
 * stable machine code, `candidates` the disambiguation list when the intent
 * was ambiguous. Nothing provider-specific ever appears in any of them.
 */
export class PlaybackObjectApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'PlaybackObjectApiError';
    this.status = status;
    this.code = code;
    this.candidates = extra.candidates ?? null;
  }
}

const MEDIA_ID_PATTERN = /^(tt\d{6,10}|tmdb\d+|imdb\d+|tv\d+|movie\d+)$/i;

/**
 * Does this input name a media identity directly?
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeMediaId(value) {
  return typeof value === 'string' && MEDIA_ID_PATTERN.test(value.trim());
}

function libraryIdentityKey({ mediaType, mediaId, season, episode }) {
  return createLibraryIdentityKey({
    mediaType: mediaType === 'movie' ? 'movie' : 'episode',
    mediaId,
    season: mediaType === 'movie' ? null : season,
    episode: mediaType === 'movie' ? null : episode,
  });
}

/**
 * Read the active Binding's TorrentFile for one media coordinate.
 *
 * @returns {{ torrentFileId: string, itemId: string }|null}
 */
function readAuthoritativeBinding({ controlPlaneStore, mediaType, mediaId, season, episode }) {
  if (!controlPlaneStore
    || typeof controlPlaneStore.getLibraryItemByIdentityKey !== 'function'
    || typeof controlPlaneStore.getActiveBindingForLibraryItem !== 'function') {
    return null;
  }
  let item;
  let binding;
  try {
    item = controlPlaneStore.getLibraryItemByIdentityKey(
      libraryIdentityKey({ mediaType, mediaId, season, episode }),
    );
    if (!item) return null;
    binding = controlPlaneStore.getActiveBindingForLibraryItem(item.id);
  } catch {
    return null;
  }
  const torrentFileId = binding?.torrentFile?.id ?? null;
  if (!torrentFileId || typeof torrentFileId !== 'string') return null;
  return { torrentFileId, itemId: item.id };
}

/**
 * Resolve a title into candidate media identities.
 *
 * @returns {Promise<{ candidates: Array<{mediaId, title, year, mediaType}> }>}
 */
async function resolveTitle(query, searchFn) {
  const search = await searchFn(query);
  const candidates = (search?.results ?? [])
    .map((row) => ({
      mediaId: String(row.id ?? '').trim(),
      title: row.title ?? null,
      year: row.year ?? null,
      mediaType: row.type === 'series' ? 'series' : 'movie',
    }))
    .filter((row) => row.mediaId !== '');
  return { candidates };
}

/**
 * Resolve a media intent to a playback object.
 *
 * @param {object} args
 * @param {object} args.controlPlaneStore
 * @param {object} args.env
 * @param {string} [args.mediaId]        an explicit media identity
 * @param {string} [args.mediaType]     'movie' | 'series'
 * @param {number} [args.season]
 * @param {number} [args.episode]
 * @param {string} [args.query]         a title, when the identity is unknown
 * @param {Function} args.prepareFn      (cache, request) => Promise<result> — the existing pipeline
 * @param {object} [args.cache]
 * @param {object} [args.extraRequest]   extra fields for the pipeline request
 * @param {Function} [args.now]
 * @returns {Promise<object>}
 */
export async function resolvePlaybackIntent({
  controlPlaneStore,
  env,
  mediaId = null,
  mediaType = null,
  season = null,
  episode = null,
  query = null,
  prepareFn,
  cache = null,
  extraRequest = {},
  searchFn = searchTitles,
  now = () => Date.now(),
}) {
  const startedAt = now();
  const secret = readPlaybackSecret(env);
  if (!secret) {
    throw new PlaybackObjectApiError(
      503,
      'PLAYBACK_OBJECT_UNAVAILABLE',
      'playback objects are unavailable: no usable signing secret is configured',
    );
  }

  let resolvedMediaId = typeof mediaId === 'string' ? mediaId.trim() : '';
  let resolvedType = mediaType === 'series' || mediaType === 'movie' ? mediaType : null;
  let resolvedTitle = null;
  let resolvedYear = null;
  let candidates = null;

  if (!resolvedMediaId) {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new PlaybackObjectApiError(400, 'INTENT_REQUIRED', 'a media id or a title is required');
    }
    const search = await resolveTitle(query.trim(), searchFn);
    candidates = search.candidates;
    if (candidates.length === 0) {
      throw new PlaybackObjectApiError(404, 'INTENT_NOT_FOUND', 'no media matched that title');
    }
    if (candidates.length > 1) {
      // Never silently choose between two legitimate works. The client
      // disambiguates; the server refuses to guess.
      throw new PlaybackObjectApiError(
        409,
        'AMBIGUOUS_INTENT',
        'that title matches more than one work; choose one',
        { candidates },
      );
    }
    resolvedMediaId = candidates[0].mediaId;
    resolvedType = resolvedType ?? candidates[0].mediaType;
    resolvedTitle = candidates[0].title;
    resolvedYear = candidates[0].year;
  }

  if (!resolvedType) {
    // A media id does not encode its type. Movie first, then series: the
    // identity namespaces are disjoint, so this is deterministic.
    resolvedType = 'movie';
  }

  const isEpisode = resolvedType === 'series';
  if (isEpisode && (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1)) {
    throw new PlaybackObjectApiError(
      400,
      'EPISODE_COORDINATES_REQUIRED',
      'a series intent needs --season and --episode (there is no episode zero)',
    );
  }

  // ── WARM PATH ──────────────────────────────────────────────────────────
  // The media already has an active Binding: no discovery, no provider
  // inventory, no provider API call. Just the object.
  let binding = readAuthoritativeBinding({
    controlPlaneStore, mediaType: resolvedType, mediaId: resolvedMediaId, season, episode,
  });
  const warm = binding != null;

  // ── COLD PATH ──────────────────────────────────────────────────────────
  // No authoritative Binding: run the existing request pipeline — the same
  // chain a Seerr request runs — and read the Binding it produced.
  let prepareResult = null;
  if (!binding) {
    if (typeof prepareFn !== 'function') {
      throw new PlaybackObjectApiError(
        503, 'REQUEST_PIPELINE_UNAVAILABLE', 'the request pipeline is unavailable',
      );
    }
    try {
      prepareResult = await prepareFn(cache, {
        mediaId: resolvedMediaId,
        mediaType: resolvedType,
        season,
        episode,
        controlPlaneStore,
        ...extraRequest,
      });
    } catch (error) {
      throw new PlaybackObjectApiError(
        502, 'REQUEST_PIPELINE_FAILED', `the request pipeline failed: ${error?.message ?? error}`,
      );
    }
    binding = readAuthoritativeBinding({
      controlPlaneStore, mediaType: resolvedType, mediaId: resolvedMediaId, season, episode,
    });
    if (!binding) {
      throw new PlaybackObjectApiError(
        409,
        'NO_AUTHORITATIVE_REPRESENTATION',
        'no authoritative representation could be established for that intent',
      );
    }
  }

  const ttlSeconds = readPlaybackTtlSeconds(env);
  const { token } = mintPlaybackToken({
    torrentFileId: binding.torrentFileId,
    secret,
    ttlSeconds,
    now: now(),
  });

  const resolvedAt = now();
  return {
    mediaId: resolvedMediaId,
    mediaType: resolvedType,
    season: isEpisode ? season : null,
    episode: isEpisode ? episode : null,
    title: resolvedTitle,
    year: resolvedYear,
    torrentFileId: binding.torrentFileId,
    playbackUrl: playbackObjectPath(token),
    // How long the playback URL lives. The client needs this to renew
    // BEFORE the expiry instead of discovering it as a failed request.
    playbackUrlExpiresInSeconds: ttlSeconds > 0 ? ttlSeconds : null,
    warm,
    alreadyPrepared: prepareResult?.alreadyPrepared === true,
    published: prepareResult?.published === true,
    timings: {
      resolveMs: resolvedAt - startedAt,
      totalMs: resolvedAt - startedAt,
    },
  };
}
