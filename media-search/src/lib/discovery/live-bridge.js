/**
 * Live Discovery Bridge
 *
 * Integrates live discovery sources (Torrentio, Torznab) into the
 * DMM corpus search pipeline. Called by combinedSearch when includeLive=true.
 *
 * This is the integration point between the new ranking pipeline and
 * the legacy live discovery adapters.
 */

import { createReleaseIdentity } from '../../api/release-contract.js';
import { searchStremio } from '../stremio/search.js';
import { searchTorznab } from '../torznab/torznab.js';
import { createProwlarrClient, searchProwlarr } from './prowlarr.js';

/**
 * Build a Prowlarr client from environment. Returns null when unconfigured
 * (Prowlarr stays a disabled source — never an error).
 */
function prowlarrClientFromEnv(env = process.env) {
  const baseUrl = env.PROWLARR_URL;
  const apiKey = env.PROWLARR_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return createProwlarrClient({ baseUrl, apiKey });
}

/**
 * Run live discovery for a given media ID.
 *
 * @param {string} mediaId - Media identifier (e.g., "tt0944947:5:14")
 * @param {Object} options
 * @param {number} [options.season] - Season number
 * @param {number} [options.episode] - Episode number
 * @returns {Promise<Array>} Normalized release candidates
 */
export async function runLiveDiscovery(mediaId, options = {}) {
  const { season, episode, title, year, wantedImdbId } = options;
  const mediaType = episode != null ? 'series' : 'movie';

  // Stremio requires full episode identifier format: tt0944947:5:14
  let stremioMediaId = mediaId;
  if (season != null && episode != null) {
    stremioMediaId = `${mediaId}:${season}:${episode}`;
  } else if (season != null) {
    stremioMediaId = `${mediaId}:${season}`;
  }

  // Prowlarr is optional: unconfigured (or failing) means fewer candidates,
  // never a failed request. Failure isolation via allSettled, same as peers.
  const prowlarrClient = prowlarrClientFromEnv(options.env);
  const prowlarrTask = prowlarrClient
    ? searchProwlarr({
      type: mediaType, title: title ?? null, year: year ?? null,
      season, episode, wantedImdbId: wantedImdbId ?? mediaId, client: prowlarrClient,
    })
    : Promise.resolve([]);

  const results = await Promise.allSettled([
    // Stremio/Torrentio discovery
    searchStremio({ type: mediaType, mediaId: stremioMediaId }),
    // Torznab discovery
    searchTorznab({ type: mediaType, mediaId }),
    prowlarrTask,
  ]);

  const allReleases = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      // Legacy searchStremio returns streams with infoHash
      // Legacy searchTorznab returns items with infoHash
      allReleases.push(...result.value);
    }
  }

  // Normalize to UI-compatible shape
  return allReleases
    .filter(r => r.infoHash)
    .map(r => ({
      ...createReleaseIdentity(r.infoHash, r.fileIndex),
      filename: r.filename || r.title,
      // Prefer actual release filename for title (accurate identity source),
      // fall back to Stremio UI label only when no filename available
      title: r.filename || r.title,
      year: r.year,
      season: r.season,
      episode: r.episode,
      resolution: r.resolution,
      source: r.source || r.quality,
      codec: r.codec,
      hdr: r.hdr,
      audio: r.audio,
      releaseGroup: r.releaseGroup,
      providers: r.providers || {},
      confidence: r.confidence ?? 0.5,
      // Slice 1.75: the RAW byte size from behaviorHints.videoSize on the
      // source stream. Sourced from the strict `exactFileSize` field emitted
      // by normalize.js — NEVER from `size`, which may be a parseSizeFromText
      // round (GiB*1024^3) or torrent total size. Survives into
      // media_request_results so the pre-publication TorBox identity helper
      // can match by exact integer byte count.
      selectedFileSize:
        Number.isSafeInteger(r.exactFileSize) && r.exactFileSize > 0
          ? r.exactFileSize
          : null,
    }));
}

/**
 * Run live discovery with per-source counts.
 *
 * Like runLiveDiscovery but returns a breakdown of counts per source
 * for diagnostic trace output. Source failures do not fail the whole
 * trace — they are reported with count 0 and an error field.
 *
 * @param {string} mediaId - Media identifier
 * @param {Object} options
 * @param {number} [options.season]
 * @param {number} [options.episode]
 * @returns {Promise<{ releases: Array, sources: Object }>}
 */
export async function runLiveDiscoveryWithCounts(mediaId, options = {}) {
  const { season, episode, title, year, wantedImdbId } = options;
  const mediaType = episode != null ? 'series' : 'movie';

  const prowlarrClient = prowlarrClientFromEnv(options.env);
  const prowlarrTask = prowlarrClient
    ? searchProwlarr({
      type: mediaType, title: title ?? null, year: year ?? null,
      season, episode, wantedImdbId: wantedImdbId ?? mediaId, client: prowlarrClient,
    })
    : Promise.resolve([]);

  const results = await Promise.allSettled([
    searchStremio({ type: mediaType, mediaId }),
    searchTorznab({ type: mediaType, mediaId }),
    prowlarrTask,
  ]);

  const sources = {
    torrentio: { count: 0, error: null },
    torznab: { count: 0, error: null },
    prowlarr: { count: 0, error: null },
  };

  const allReleases = [];

  const [stremioResult, torznabResult, prowlarrResult] = results;

  if (stremioResult.status === 'fulfilled' && Array.isArray(stremioResult.value)) {
    const valid = stremioResult.value.filter(r => r.infoHash);
    sources.torrentio.count = valid.length;
    allReleases.push(...valid);
  } else if (stremioResult.status === 'rejected') {
    sources.torrentio.error = stremioResult.reason?.message || 'unknown error';
  }

  if (torznabResult.status === 'fulfilled' && Array.isArray(torznabResult.value)) {
    const valid = torznabResult.value.filter(r => r.infoHash);
    sources.torznab.count = valid.length;
    allReleases.push(...valid);
  } else if (torznabResult.status === 'rejected') {
    sources.torznab.error = torznabResult.reason?.message || 'unknown error';
  }

  if (prowlarrResult.status === 'fulfilled' && Array.isArray(prowlarrResult.value)) {
    const valid = prowlarrResult.value.filter(r => r.infoHash);
    sources.prowlarr.count = valid.length;
    allReleases.push(...valid);
  } else if (prowlarrResult.status === 'rejected') {
    sources.prowlarr.error = prowlarrResult.reason?.message || 'unknown error';
  }

  // Normalize (same as runLiveDiscovery)
  const releases = allReleases.map(r => ({
    ...createReleaseIdentity(r.infoHash, r.fileIndex),
    filename: r.filename || r.title,
    title: r.title || r.filename,
    year: r.year,
    season: r.season,
    episode: r.episode,
    resolution: r.resolution,
    source: r.source || r.quality,
    codec: r.codec,
    hdr: r.hdr,
    audio: r.audio,
    releaseGroup: r.releaseGroup,
    providers: r.providers || {},
    confidence: r.confidence ?? 0.5,
    // Slice 1.75: prefer the strict `exactFileSize` (behaviorHints.videoSize
    // only, safe integer > 0) over `size`, which may be a parseSizeFromText
    // round. Identity helper needs an exact integer byte count.
    selectedFileSize:
      Number.isSafeInteger(r.exactFileSize) && r.exactFileSize > 0
        ? r.exactFileSize
        : null,
  }));

  return { releases, sources };
}
