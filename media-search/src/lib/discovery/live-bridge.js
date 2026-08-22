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
  const { season, episode } = options;
  const mediaType = episode != null ? 'series' : 'movie';

  const results = await Promise.allSettled([
    // Stremio/Torrentio discovery
    searchStremio({ type: mediaType, mediaId }),
    // Torznab discovery
    searchTorznab({ type: mediaType, mediaId }),
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
    }));
}
