/**
 * Canonical Discovery Request
 *
 * Represents a provider-neutral media search request.
 * Individual adapters translate this into their specific query format.
 */

export function buildDiscoveryRequest({ type, mediaId, title, year, season, episode }) {
  if (!['movie', 'series'].includes(type)) {
    throw new Error(`Invalid media type: ${type}`);
  }
  if (!mediaId) {
    throw new Error('mediaId is required');
  }

  const mediaOnlyId = extractBaseMediaId(mediaId);
  const searchTitles = buildSearchTitles({ title, year, season, episode });

  return {
    mediaType: type,
    mediaId,
    mediaOnlyId,
    title: title || null,
    year: year || null,
    season: season ?? null,
    episode: episode ?? null,
    searchTitles,
  };
}

function extractBaseMediaId(mediaId) {
  if (typeof mediaId !== 'string') return mediaId;
  const match = mediaId.match(/^(tt\d+)/);
  return match ? match[1] : mediaId.split(':')[0];
}

function buildSearchTitles({ title, year, season, episode }) {
  const titles = new Set();

  if (title) {
    titles.add(title);
    if (year) {
      titles.add(`${title} ${year}`);
    }
  }

  if (season != null) {
    const padded = String(season).padStart(2, '0');
    if (title) {
      titles.add(`${title} S${padded}`);
    }
    if (episode != null) {
      const epPadded = String(episode).padStart(2, '0');
      if (title) {
        titles.add(`${title} S${padded}E${epPadded}`);
      }
    }
  }

  return [...titles];
}

export function isEpisodeRequest(request) {
  return request.mediaType === 'series' && request.episode != null;
}

export function isMovieRequest(request) {
  return request.mediaType === 'movie';
}
