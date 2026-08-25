/**
 * Stream Resolver Interface
 *
 * Answers: "Given a media identity, where should playback redirect?"
 *
 * This module provides the streaming redirect resolution boundary.
 * It takes a media identity and returns a redirect target for playback.
 *
 * Current state: stub implementation returning not_implemented.
 * Future: integrate with provider availability, discovery sources, and
 * playback handoff to return actual redirect URLs.
 */

import { createReleaseIdentity } from '../../api/release-contract.js';

/**
 * Error thrown when stream resolution fails.
 */
export class StreamResolverError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'StreamResolverError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Resolve stream redirect target for a media identity.
 *
 * @param {Object} params - Resolution parameters
 * @param {string} params.mediaId - Media identifier (IMDB, TMDB, etc.)
 * @param {string} params.mediaType - 'movie' or 'series'
 * @param {number} [params.season] - Season number (series only)
 * @param {number} [params.episode] - Episode number (series only)
 * @param {Object} [params.options] - Additional resolution options
 * @returns {Promise<Object>} Resolution result with redirect information
 */
export async function resolveStream({ mediaId, mediaType, season, episode, options = {} }) {
  if (!mediaId) {
    throw new StreamResolverError('mediaId is required', 'MISSING_MEDIA_ID', 400);
  }

  if (!mediaType) {
    throw new StreamResolverError('mediaType is required', 'MISSING_MEDIA_TYPE', 400);
  }

  if (!['movie', 'series'].includes(mediaType)) {
    throw new StreamResolverError(
      `Invalid mediaType: ${mediaType}. Must be 'movie' or 'series'`,
      'INVALID_MEDIA_TYPE',
      400
    );
  }

  if (mediaType === 'series' && (season == null || episode == null)) {
    throw new StreamResolverError(
      'season and episode are required for series',
      'MISSING_EPISODE_INFO',
      400
    );
  }

  // Stub response — provider logic will be added in future phases
  return {
    status: 'not_implemented',
    provider: null,
    redirectUrl: null,
    mediaId,
    mediaType,
    season: season ?? null,
    episode: episode ?? null,
  };
}

/**
 * Validate and normalize media identity parameters.
 *
 * @param {Object} params - Input parameters
 * @returns {{ mediaId: string, mediaType: string, season: number|null, episode: number|null }}
 * @throws {StreamResolverError}
 */
export function parseMediaIdentity({ mediaId, mediaType, season, episode }) {
  const normalizedMediaId = String(mediaId || '').trim();
  const normalizedType = String(mediaType || '').trim().toLowerCase();

  if (!normalizedMediaId) {
    throw new StreamResolverError('mediaId is required', 'MISSING_MEDIA_ID', 400);
  }

  if (!['movie', 'series'].includes(normalizedType)) {
    throw new StreamResolverError(
      `Invalid mediaType: ${mediaType}`,
      'INVALID_MEDIA_TYPE',
      400
    );
  }

  const normalizedSeason = season != null ? parseInt(season, 10) : null;
  const normalizedEpisode = episode != null ? parseInt(episode, 10) : null;

  if (normalizedType === 'series' && (normalizedSeason == null || normalizedEpisode == null)) {
    throw new StreamResolverError(
      'season and episode are required for series',
      'MISSING_EPISODE_INFO',
      400
    );
  }

  return {
    mediaId: normalizedMediaId,
    mediaType: normalizedType,
    season: normalizedSeason,
    episode: normalizedEpisode,
  };
}
