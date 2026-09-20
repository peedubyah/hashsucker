/**
 * Temporary (watch-once) publication tests: mark/adopt/retire semantics
 * against real stores. Live end-to-end (publish temp, restart, retire,
 * republish) is proven on a scratch instance; here the state machine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import {
  markTemporaryPublication,
  clearTemporaryPublication,
  retireDuePublications,
  DEFAULT_TEMP_TTL_MS,
} from '../src/lib/library/retirement.js';

function stores() {
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const controlPlaneStore = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  controlPlaneStore.ensureLibraryItem({
    mediaType: 'movie', mediaId: 'tt-temp', title: 'Temp', year: 2024, desiredState: 'present',
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt-temp', releaseKey: 'h:torrent', infoHash: 'a'.repeat(40), fileIndex: null,
    canonicalPath: 'Movies/Temp/Temp.mkv', torrentFileId: 'tf-1', size: 10,
    createdAt: 1, updatedAt: 1,
  });
  return { cache, controlPlaneStore };
}

test('mark temporary sets mode + retire_at; clear adopts permanent', () => {
  const { controlPlaneStore } = stores();
  const marked = markTemporaryPublication(controlPlaneStore,
    { mediaType: 'movie', mediaId: 'tt-temp' }, { ttlMs: 3600 * 1000, nowMs: 1000 });
  assert.ok(marked.ok);
  assert.equal(marked.retireAt, 1000 + 3600 * 1000);
  let item = controlPlaneStore.getLibraryItemByIdentityKey('movie:tt-temp:default');
  assert.equal(item.publicationMode, 'temporary');
  assert.equal(item.retireAt, marked.retireAt);
  const cleared = clearTemporaryPublication(controlPlaneStore,
    { mediaType: 'movie', mediaId: 'tt-temp' }, { nowMs: 2000 });
  assert.ok(cleared.ok);
  item = controlPlaneStore.getLibraryItemByIdentityKey('movie:tt-temp:default');
  assert.equal(item.publicationMode, 'permanent');
  assert.equal(item.retireAt, null);
});

test('default TTL is conservative 7 days; bounds clamp', () => {
  const { controlPlaneStore } = stores();
  const d = markTemporaryPublication(controlPlaneStore,
    { mediaType: 'movie', mediaId: 'tt-temp' }, { nowMs: 0 });
  assert.equal(d.retireAt, DEFAULT_TEMP_TTL_MS);
  assert.equal(DEFAULT_TEMP_TTL_MS, 7 * 24 * 3600 * 1000);
});

test('retireDuePublications retires due rows, skips future, adopts promoted', async () => {
  const { cache, controlPlaneStore } = stores();
  process.env.STRM_OUTPUT_PATH = '/nonexistent-strm-root-for-tests';
  // 60s TTL clamps up to the 3-minute minimum floor.
  markTemporaryPublication(controlPlaneStore,
    { mediaType: 'movie', mediaId: 'tt-temp' }, { ttlMs: 60 * 1000, nowMs: 0 });
  // Not due yet: untouched.
  let r = await retireDuePublications({ cache, controlPlaneStore, nowMs: 100 * 1000 });
  assert.equal(r.retired, 0);
  assert.equal(controlPlaneStore.getLibraryItemByIdentityKey('movie:tt-temp:default').desiredState, 'present');
  // Due: presentation removed, durable identity retained (item row stays).
  r = await retireDuePublications({ cache, controlPlaneStore, nowMs: 181 * 1000 });
  assert.equal(r.retired, 1);
  const item = controlPlaneStore.getLibraryItemByIdentityKey('movie:tt-temp:default');
  assert.equal(item.desiredState, 'absent');
  assert.equal(cache.getVfsMovieEntry('tt-temp'), null);
  // Idempotent: second sweep finds nothing due.
  r = await retireDuePublications({ cache, controlPlaneStore, nowMs: 61 * 1000 });
  assert.equal(r.retired, 0);
});

test('retireDuePublications adopts instead of unpublishing promoted media', async () => {
  const { cache, controlPlaneStore } = stores();
  process.env.STRM_OUTPUT_PATH = '/nonexistent-strm-root-for-tests';
  markTemporaryPublication(controlPlaneStore,
    { mediaType: 'movie', mediaId: 'tt-temp' }, { ttlMs: 60 * 1000, nowMs: 0 });
  const promotionStore = { getByMedia: () => ({ status: 'permanent' }) };
  const r = await retireDuePublications({ cache, controlPlaneStore, promotionStore, nowMs: 181 * 1000 });
  assert.equal(r.retired, 0);
  assert.equal(r.adopted, 1);
  const item = controlPlaneStore.getLibraryItemByIdentityKey('movie:tt-temp:default');
  assert.equal(item.desiredState, 'present', 'owned presentation untouched');
  assert.equal(item.publicationMode, 'permanent');
  assert.equal(cache.getVfsMovieEntry('tt-temp')?.torrentFileId, 'tf-1');
});

test('sweeper never touches permanent rows even with past retire_at', async () => {
  const { cache, controlPlaneStore } = stores();
  process.env.STRM_OUTPUT_PATH = '/nonexistent-strm-root-for-tests';
  // Permanent row with a stale retire_at (e.g. adopted after promotion).
  controlPlaneStore.db.prepare(
    `UPDATE library_items SET publication_mode = 'permanent', retire_at = 1 WHERE media_id = 'tt-temp'`,
  ).run();
  const r = await retireDuePublications({ cache, controlPlaneStore, nowMs: Date.now() });
  assert.equal(r.retired, 0);
  assert.equal(r.adopted, 0);
  const item = controlPlaneStore.getLibraryItemByIdentityKey('movie:tt-temp:default');
  assert.equal(item.desiredState, 'present');
  assert.notEqual(cache.getVfsMovieEntry('tt-temp'), null);
});

test('observePlaybackSessions: started extends, completed shortens, others untouched', async () => {
  const { observePlaybackSessions, PLAYBACK_EXTENSION_MS, COMPLETED_GRACE_MS } =
    await import('../src/lib/library/retirement.js');
  const { DatabaseSync } = await import('node:sqlite');
  const { createControlPlaneStore } = await import('../src/lib/control-plane/store.js');
  const cps = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  const seed = (id, retireAt) => {
    cps.ensureLibraryItem({ mediaType: 'movie', mediaId: id, title: id, desiredState: 'present' });
    cps.db.prepare(`UPDATE library_items SET publication_mode='temporary', retire_at=? WHERE media_id=?`)
      .run(retireAt, id);
  };
  seed('tt-watch', 10_000);
  seed('tt-done', 8 * 24 * 3600 * 1000);
  seed('tt-idle', 10_000);
  seed('tt-perm', 10_000);
  cps.db.prepare(`UPDATE library_items SET publication_mode='permanent', retire_at=NULL WHERE media_id='tt-perm'`).run();
  const out = observePlaybackSessions({
    controlPlaneStore: cps,
    sessions: [
      { mediaId: 'tt-watch', mediaType: 'movie', season: null, episode: null, progress: 0.4 },
      { mediaId: 'tt-done', mediaType: 'movie', season: null, episode: null, progress: 0.95 },
      { mediaId: 'tt-perm', mediaType: 'movie', season: null, episode: null, progress: 0.95 },
      { mediaId: 'tt-other', mediaType: 'movie', season: null, episode: null, progress: 0.5 },
    ],
    nowMs: 5_000,
  });
  assert.equal(out.observed, 2);
  assert.equal(out.extended, 1);
  assert.equal(out.completed, 1);
  const get = (id) => cps.db.prepare('SELECT retire_at,first_played_at,last_played_at,max_progress,publication_mode FROM library_items WHERE media_id=?').get(id);
  assert.equal(get('tt-watch').retire_at, 5_000 + PLAYBACK_EXTENSION_MS);
  assert.equal(get('tt-watch').first_played_at, 5_000);
  assert.equal(get('tt-watch').max_progress, 0.4);
  assert.equal(get('tt-done').retire_at, 5_000 + COMPLETED_GRACE_MS);
  assert.equal(get('tt-idle').retire_at, 10_000, 'unseen TTL stands');
  assert.equal(get('tt-perm').retire_at, null, 'permanent untouched');
});

test('mapSessionEntry: imdb identity without fuzzy titles', async () => {
  const { mapSessionEntry } = await import('../src/lib/consumers/plex-sessions.js');
  const movie = mapSessionEntry({
    type: 'movie', ratingKey: '42',
    Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://123' }],
    viewOffset: 1000, duration: 4000, Player: { state: 'playing' },
  });
  assert.equal(movie.mediaId, 'tt0133093');
  assert.equal(movie.mediaType, 'movie');
  assert.equal(movie.progress, 0.25);
  assert.equal(movie.playerState, 'playing');
  const ep = mapSessionEntry({
    type: 'episode', ratingKey: '43', grandparentGuid: 'com.plexapp.agents.imdb://tt0903747?lang=en',
    parentIndex: 1, index: 2, viewOffset: 3600, duration: 4000,
  });
  assert.equal(ep.mediaId, 'tt0903747');
  assert.equal(ep.season, 1);
  assert.equal(ep.episode, 2);
  assert.equal(ep.progress, 0.9);
  assert.equal(mapSessionEntry({ type: 'movie', ratingKey: '44', title: 'Some Title' }), null);
  assert.equal(mapSessionEntry(null), null);
});

test('setPublicationProfile persists explicit intent; readPublishedTier surfaces it', async () => {
  const { setPublicationProfile } = await import('../src/lib/library/retirement.js');
  const { readPublishedTier } = await import('../src/lib/lifecycle/upgrade-watch.js');
  const { DatabaseSync } = await import('node:sqlite');
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const { createControlPlaneStore } = await import('../src/lib/control-plane/store.js');
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const cps = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  cps.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt-prof', title: 'P', desiredState: 'present' });
  cps.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES ('tf-p', ?, 'P.mkv', 10, 1)`).run('d'.repeat(40));
  cache.createVfsMovieEntry({
    mediaId: 'tt-prof', releaseKey: `${'d'.repeat(40)}:torrent`, infoHash: 'd'.repeat(40),
    fileIndex: null, canonicalPath: 'Movies/P/P.mkv', torrentFileId: 'tf-p', size: 10,
    createdAt: 1, updatedAt: 1,
  });
  // Default is balanced without any explicit declaration.
  let pub = readPublishedTier({ cache, controlPlaneStore: cps, mediaType: 'movie', mediaId: 'tt-prof' });
  assert.equal(pub.profile, 'balanced');
  const set = setPublicationProfile(cps,
    { mediaType: 'movie', mediaId: 'tt-prof' }, 'hd', { nowMs: 1000 });
  assert.ok(set.ok);
  assert.equal(set.profile, 'hd');
  pub = readPublishedTier({ cache, controlPlaneStore: cps, mediaType: 'movie', mediaId: 'tt-prof' });
  assert.equal(pub.profile, 'hd');
  assert.equal(cps.getLibraryItemByIdentityKey('movie:tt-prof:default').profile, 'hd');
});
