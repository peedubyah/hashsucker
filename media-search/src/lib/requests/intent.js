export function createRequestIntent({ type, mediaId }) {
  const streamType = String(type || '').trim().toLowerCase();
  const id = String(mediaId || '').trim();

  if (!['movie', 'series'].includes(streamType)) {
    throw new Error(`Invalid media type: ${streamType}`);
  }

  if (!id) {
    throw new Error('mediaId is required');
  }

  if (streamType === 'movie') {
    return {
      streamType: 'movie',
      mediaType: 'movie',
      scope: 'movie',
      mediaId: id,
      baseMediaId: id,
      season: null,
      episodes: [],
    };
  }

  // Handles:
  // tt0944947:1:1
  // tmdb:1399:1:1
  //
  // The base ID may itself contain a colon, so parse from the end.
  const episodeMatch = id.match(/^(.*):(\d+):(\d+)$/);

  if (!episodeMatch) {
    return {
      streamType: 'series',
      mediaType: 'tv',
      scope: 'series',
      mediaId: id,
      baseMediaId: id,
      season: null,
      episodes: [],
    };
  }

  const [, baseMediaId, seasonRaw, episodeRaw] = episodeMatch;

  const season = Number(seasonRaw);
  const episode = Number(episodeRaw);

  if (
    !baseMediaId ||
    !Number.isInteger(season) ||
    !Number.isInteger(episode) ||
    season < 0 ||
    episode < 1
  ) {
    throw new Error(`Invalid episode media ID: ${id}`);
  }

  return {
    streamType: 'series',
    mediaType: 'tv',
    scope: 'episode',
    mediaId: id,
    baseMediaId,
    season,
    episodes: [episode],
  };
}