/**
 * Arr sync tests (Sonarr/Radarr intent ingestion tranche).
 *
 * Fixture API payloads shaped like the documented v3 responses; no network.
 * Covers: exact movie identity, exact S/E identity, date mapping, repeat
 * sync idempotency, unmonitored withdrawal (prepared rows survive),
 * local-file satisfaction parking, retirement guard exactness.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  mapRadarrMovie,
  mapSonarrEntry,
  diffArrIntents,
  applyDescriptors,
  arrNextCheck,
  createArrSync,
} from '../src/lib/anticipation/arr-sync.js';
import { createFutureIntentStore, isWantedByArr } from '../src/lib/anticipation/future-intents.js';

function memStore() {
  const db = new DatabaseSync(':memory:');
  return createFutureIntentStore({ db });
}

const RADARR_MOVIE = {
  id: 0, title: 'Dune', year: 2021, monitored: true, hasFile: false,
  imdbId: 'tt1160419', tmdbId: 438631,
  digitalRelease: '2021-10-22T00:00:00Z', physicalRelease: null, inCinemas: '2021-10-22T00:00:00Z',
};

const SONARR_ENTRY = {
  id: 7, seriesId: 9, seasonNumber: 1, episodeNumber: 2,
  title: 'Pilot', airDateUtc: '2026-09-20T00:00:00Z', monitored: true,
  episodeFile: null,
  series: { title: 'Show', imdbId: 'tt0903747', tvdbId: 81189, monitored: true },
};

test('radarr movie maps exact identity, dates, satisfaction', () => {
  const d = mapRadarrMovie(RADARR_MOVIE);
  assert.equal(d.mediaType, 'movie');
  assert.equal(d.mediaId, 'tt1160419');
  assert.equal(d.source, 'radarr:movie:tmdb438631');
  assert.equal(mapRadarrMovie({ ...RADARR_MOVIE, id: 42 }).source, 'radarr:movie:42');
  assert.equal(d.satisfied, false);
  assert.equal(d.expectedAt, Date.parse('2021-10-22T00:00:00Z'));
  assert.equal(mapRadarrMovie({ ...RADARR_MOVIE, hasFile: true }).satisfied, true);
  assert.equal(mapRadarrMovie({ ...RADARR_MOVIE, monitored: false }).skip, 'unmonitored');
  assert.equal(mapRadarrMovie({ ...RADARR_MOVIE, imdbId: null }).skip, 'no-imdb-id');
  assert.equal(mapRadarrMovie({ ...RADARR_MOVIE, digitalRelease: null, physicalRelease: '2022-01-11T00:00:00Z' }).expectedAt,
    Date.parse('2022-01-11T00:00:00Z'));
});

test('sonarr entry maps exact S/E identity', () => {
  const d = mapSonarrEntry(SONARR_ENTRY);
  assert.equal(d.mediaType, 'series');
  assert.equal(d.mediaId, 'tt0903747');
  assert.equal(d.season, 1);
  assert.equal(d.episode, 2);
  assert.equal(d.source, 'sonarr:9:S01E02');
  assert.equal(d.satisfied, false);
  assert.equal(d.expectedAt, Date.parse('2026-09-20T00:00:00Z'));
  assert.equal(mapSonarrEntry({ ...SONARR_ENTRY, episodeFile: { id: 5 } }).satisfied, true);
  assert.equal(mapSonarrEntry({ ...SONARR_ENTRY, monitored: false }).skip, 'episode-unmonitored');
  assert.equal(mapSonarrEntry({ ...SONARR_ENTRY, series: { ...SONARR_ENTRY.series, monitored: false } }).skip, 'series-unmonitored');
  assert.equal(mapSonarrEntry({ ...SONARR_ENTRY, series: { ...SONARR_ENTRY.series, imdbId: null } }).skip, 'no-imdb-id');
  assert.equal(mapSonarrEntry({ ...SONARR_ENTRY, episodeNumber: 0 }).skip, 'bad-coordinates');
});

test('repeat sync is idempotent; date changes refresh', () => {
  const store = memStore();
  const d1 = { ...mapRadarrMovie(RADARR_MOVIE), expectedAt: 1000 };
  const r1 = applyDescriptors(store, [d1], { prepareDays: 30, nowMs: 2000 });
  assert.equal(r1.applied, 1);
  const r2 = applyDescriptors(store, [d1], { prepareDays: 30, nowMs: 2000 });
  assert.equal(r2.applied, 0, 'identical re-sync applies nothing');
  assert.equal(store.list({}).length, 1);
  const d2 = { ...d1, expectedAt: 2000 };
  const r3 = applyDescriptors(store, [d2], { prepareDays: 30, nowMs: 3000 });
  assert.equal(r3.applied, 1, 'date change refreshes');
  assert.equal(store.list({})[0].expected_at, 2000);
});

test('unmonitored source withdraws only never-prepared rows', () => {
  const store = memStore();
  applyDescriptors(store, [
    { mediaType: 'movie', mediaId: 'tt1', season: null, episode: null, source: 'radarr:movie:1', expectedAt: null, satisfied: false },
    { mediaType: 'movie', mediaId: 'tt2', season: null, episode: null, source: 'radarr:movie:2', expectedAt: null, satisfied: false },
  ], { nowMs: 1000 });
  // tt2 binds (simulating preparation downstream).
  store.transition(store.list({}).find((r) => r.media_id === 'tt2').id, 'prepared', { torrent_file_id: 'tf1', next_check_at: 0 });
  const r = applyDescriptors(store, [
    { mediaType: 'movie', mediaId: 'tt1', season: null, episode: null, source: 'radarr:movie:1', expectedAt: null, satisfied: false },
  ], { nowMs: 2000 });
  assert.equal(r.withdrawn, 0, 'prepared tt2 survives its vanished source');
  const states = Object.fromEntries(store.list({}).map((x) => [x.media_id, x.state]));
  // ...but tt2 was prepared, so it survives; only anticipated rows withdraw.
  assert.equal(states.tt2, 'prepared');
  // tt1 stays anticipated; craft the vanish case explicitly:
  applyDescriptors(store, [], { nowMs: 3000 });
  const states2 = Object.fromEntries(store.list({}).map((x) => [x.media_id, x.state]));
  assert.equal(states2.tt1, 'withdrawn', 'anticipated row withdrawn on vanish');
  assert.equal(states2.tt2, 'prepared', 'prepared truth preserved');
});

test('satisfied items park without fulfillment state', () => {
  const store = memStore();
  applyDescriptors(store, [
    { mediaType: 'movie', mediaId: 'tt1', season: null, episode: null, source: 'radarr:movie:1', expectedAt: null, satisfied: true },
  ], { nowMs: 1000 });
  const row = store.list({})[0];
  assert.equal(row.arr_satisfied, 1);
  assert.equal(row.state, 'anticipated');
  assert.ok(row.next_check_at > 1000 + 20 * 86400 * 1000, 'parked far future');
});

test('arrNextCheck windows: released due, far-future sparse', () => {
  const now = 1_000_000_000;
  const day = 86400 * 1000;
  assert.equal(arrNextCheck({ expectedAt: null }, now, { prepareDays: 30 }), now);
  assert.equal(arrNextCheck({ expectedAt: now - day }, now, { prepareDays: 30 }), now);
  assert.equal(arrNextCheck({ expectedAt: now + 60 * day }, now, { prepareDays: 30 }), now + 30 * day);
  assert.equal(arrNextCheck({ expectedAt: now + 10 * day }, now, { prepareDays: 30 }), now);
  assert.ok(arrNextCheck({ expectedAt: null, satisfied: true }, now, {}) > now + 20 * day);
});

test('retirement guard matches exactly or not at all', () => {
  const db = new DatabaseSync(':memory:');
  const store = createFutureIntentStore({ db });
  store.seed({ mediaType: 'series', mediaId: 'ttS', season: 1, episode: 2, source: 'sonarr:9:S01E02' });
  store.seed({ mediaType: 'movie', mediaId: 'ttM', source: 'operator:intent' });
  assert.equal(isWantedByArr(db, { mediaId: 'ttS', season: 1, episode: 2 }), true);
  assert.equal(isWantedByArr(db, { mediaId: 'ttS', season: 1, episode: 3 }), false, 'sibling not guarded');
  assert.equal(isWantedByArr(db, { mediaId: 'ttS' }), false, 'scope mismatch');
  assert.equal(isWantedByArr(db, { mediaId: 'ttM' }), false, 'operator source does not guard');
  assert.equal(isWantedByArr(db, {}), false);
  assert.equal(isWantedByArr(null, { mediaId: 'ttS' }), false);
});

test('sync failure leaves existing intents intact', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createFutureIntentStore({ db });
  store.seed({ mediaType: 'movie', mediaId: 'tt1', source: 'radarr:movie:1' });
  const sync = createArrSync({
    db,
    radarr: { radarrMovies: async () => { throw new Error('net down'); } },
    sonarr: null,
    clock: () => 1000,
    log: () => {},
  });
  const summary = await sync.syncOnce({ store });
  assert.equal(summary.radarr.ok, false);
  assert.equal(store.list({}).length, 1, 'existing intent preserved');
  assert.equal(store.list({})[0].state, 'anticipated');
});
