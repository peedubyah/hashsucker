/** Durable requested-season reconciliation over the existing future-intent worker. */

function ownerKey(mediaId, season) {
  return `season:${mediaId}:s${String(season).padStart(2, '0')}`;
}

export function createSeasonReconciler({ store, resolveEpisodes, clock = () => Date.now() } = {}) {
  if (!store) throw new Error('season reconciler requires intent store');
  if (typeof resolveEpisodes !== 'function') throw new Error('season reconciler requires episode resolver');

  async function reconcileSeason({ mediaId, tmdbId, season, source = null } = {}) {
    if (!mediaId || !Number.isSafeInteger(Number(season)) || Number(season) < 1) {
      throw new Error('season identity is invalid');
    }
    const seasonNumber = Number(season);
    const owner = ownerKey(mediaId, seasonNumber);
    store.ensureRequestedSeason({ mediaId, tmdbId, season: seasonNumber, source: source || owner });
    const episodes = await resolveEpisodes(tmdbId, seasonNumber);
    const known = new Set();
    let created = 0;
    let updated = 0;
    for (const episode of episodes) {
      const number = Number(episode.episodeNumber);
      if (!Number.isSafeInteger(number) || number < 1) continue;
      known.add(number);
      const expectedAt = episode.airDate ? Date.parse(episode.airDate) : null;
      const validExpectedAt = Number.isSafeInteger(expectedAt) ? expectedAt : null;
      const existing = store.findByIdentity({ mediaId, season: seasonNumber, episode: number });
      const result = store.ensureSeasonEpisode({
        mediaId,
        season: seasonNumber,
        episode: number,
        owner,
        source: source || owner,
        expectedAt: validExpectedAt,
      });
      if (!existing) created += 1;
      else if (result?.changed) updated += 1;
    }
    const withdrawn = store.withdrawSeasonEpisodes({ mediaId, season: seasonNumber, owner, keepEpisodes: [...known] });
    return { mediaId, season: seasonNumber, owner, known: known.size, created, updated, withdrawn, reconciledAt: clock() };
  }

  return { reconcileSeason };
}

export { ownerKey };
