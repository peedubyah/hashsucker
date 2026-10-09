import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createSeasonReconciler } from '../src/lib/anticipation/season-reconciliation.js';

test('season reconciliation owns known episodes and updates release schedule', async () => {
  const store = createFutureIntentStore({ db: new DatabaseSync(':memory:'), clock: () => 1_000_000 });
  let snapshot = [
    { episodeNumber: 1, airDate: '1970-01-01' },
    { episodeNumber: 2, airDate: '2030-01-01' },
  ];
  const reconciler = createSeasonReconciler({ store, resolveEpisodes: async () => snapshot, clock: () => 1_000_000 });
  const first = await reconciler.reconcileSeason({ mediaId: 'tt-season', tmdbId: 1, season: 1 });
  assert.equal(first.created, 2);
  assert.equal(store.findByIdentity({ mediaId: 'tt-season', season: 1, episode: 1 }).season_owners, 'season:tt-season:s01');
  assert.equal(store.findByIdentity({ mediaId: 'tt-season', season: 1, episode: 2 }).defer_reason, 'future-not-released');
  snapshot = [{ episodeNumber: 1, airDate: '1970-01-01' }, { episodeNumber: 2, airDate: '1970-01-02' }, { episodeNumber: 3, airDate: '1970-01-03' }];
  const second = await reconciler.reconcileSeason({ mediaId: 'tt-season', tmdbId: 1, season: 1 });
  assert.equal(second.created, 1);
  assert.equal(store.findByIdentity({ mediaId: 'tt-season', season: 1, episode: 2 }).expected_at, Date.parse('1970-01-02'));
  assert.equal(store.findByIdentity({ mediaId: 'tt-season', season: 1, episode: 3 }).state, 'anticipated');
});

test('season ownership withdrawal preserves other owners and fulfilled truth', async () => {
  const store = createFutureIntentStore({ db: new DatabaseSync(':memory:'), clock: () => 1_000_000 });
  store.ensureSeasonEpisode({ mediaId: 'tt-shared', season: 1, episode: 1, owner: 'season:tt-shared:s01' });
  store.ensureSeasonEpisode({ mediaId: 'tt-shared', season: 1, episode: 1, owner: 'seerr:req-1:s01:e01' });
  const row = store.findByIdentity({ mediaId: 'tt-shared', season: 1, episode: 1 });
  store.transition(row.id, 'playable', { torrent_file_id: 'tf-exact' });
  assert.equal(store.withdrawSeasonEpisodes({ mediaId: 'tt-shared', season: 1, owner: 'season:tt-shared:s01', keepEpisodes: [] }), 1);
  const retained = store.findByIdentity({ mediaId: 'tt-shared', season: 1, episode: 1 });
  assert.equal(retained.state, 'playable');
  assert.equal(retained.torrent_file_id, 'tf-exact');
  assert.equal(retained.season_owners, 'seerr:req-1:s01:e01');
});
