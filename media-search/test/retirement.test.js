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
