/**
 * Library listing tests.
 *
 * Proves GET /api/library's model (listLibrary) derives published/absent/
 * incomplete state from existing durable truth without new state, keeps TV
 * identity per-episode, and leaks no provider internals or capabilities.
 * Real in-memory discovery cache + real :memory: control-plane store.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseIdentity } from '../src/api/release-contract.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { listLibrary } from '../src/lib/library/listing.js';

const HASH_M = 'aabbccddeeff00112233445566778899aabbccdd';
const HASH_E = 'eeff00112233445566778899aabbccddeeff0011';

function seedMoviePublication(store, cache, { mediaId, tfId, size, withBinding, tag = null }) {
  const suffix = tag == null ? '' : `-${tag}`;
  const item = store.ensureLibraryItem({
    mediaType: 'movie', mediaId, title: 'List Movie', year: 2024, desiredState: 'present',
  });
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'primary', infoHash: HASH_M,
    providerResourceId: `res-${mediaId}${suffix}`, state: 'ready', ownership: 'owned',
    ownerKey: item.id, provenance: 'test',
    idempotencyKey: `placement:torbox:${HASH_M}:${mediaId}`,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: 'pf-1', path: `/List.Movie.2024${suffix}.mkv`, name: `List.Movie.2024${suffix}.mkv`, size,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  store.db.prepare(
    `INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tfId, HASH_M, `/List.Movie.2024${suffix}.mkv`, size, 1);
  store.db.prepare(
    `UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped'
     WHERE placement_id = ? AND provider_file_id = 'pf-1'`,
  ).run(tfId, placement.id);
  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null }, [],
  );
  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${HASH_M}:torrent`, infoHash: HASH_M, fileIndex: null,
    filename: `List.Movie.2024${suffix}.mkv`, provider: 'torbox', providerState: 'cached',
    identityTier: 'ProviderConfirmed', resolutionState: 'resolved',
    selectionReason: 'r', selectedAt: 1, torrentFileId: tfId,
  });
  cache.createVfsMovieEntry({
    mediaId, releaseKey: `${HASH_M}:torrent`, infoHash: HASH_M, fileIndex: null,
    canonicalPath: `Movies/List Movie (2024)/List Movie (2024)${suffix}.mkv`,
    torrentFileId: tfId, size, createdAt: 1, updatedAt: 1,
  });
  if (withBinding) {
    const path = store.ensureCanonicalPath(item.id);
    const identity = createReleaseIdentity(HASH_M, null);
    store.recordFileMapping({
      ...identity, placementId: placement.id, providerFileId: 'pf-1',
      state: 'mapped', method: 'provider-file-id', authoritative: true,
    });
    const exposure = store.recordExposure({
      placementId: placement.id, providerFileId: 'pf-1', transport: 'zurg-rclone',
      exposureKey: `${placement.id}:pf-1`, state: 'visible', readOnly: true,
      observedAt: 0, expiresAt: 9_999_999_999_999,
    });
    store.activateBinding({
      libraryItemId: item.id, libraryPathId: path.id, ...identity,
      placementId: placement.id, providerFileId: 'pf-1',
      exposureId: exposure.id, reason: 'test',
    });
  }
  return item;
}

function seedEpisodePublication(store, cache, { mediaId, season, episode, tfId, size }) {
  const item = store.ensureLibraryItem({
    mediaType: 'episode', mediaId, title: 'List Show', season, episode,
    desiredState: 'present',
  });
  store.db.prepare(
    `INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tfId, HASH_E, `/Show.S01E0${episode}.mkv`, size, 1);
  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'series', season, episode }, [],
  );
  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'series', season, episode,
    releaseKey: `${HASH_E}:${episode - 1}`, infoHash: HASH_E, fileIndex: episode - 1,
    filename: `Show S01E0${episode}.mkv`, provider: 'torbox', providerState: 'cached',
    identityTier: 'ProviderScoped', resolutionState: 'resolved',
    selectionReason: 'r', selectedAt: 1, torrentFileId: tfId,
  });
  cache.createVfsTvEntry({
    mediaId, season, episode, releaseKey: `${HASH_E}:${episode - 1}`, infoHash: HASH_E,
    fileIndex: episode - 1,
    canonicalPath: `TV/List Show (2024)/Season 01/List Show - S01E0${episode}.mkv`,
    torrentFileId: tfId, size, createdAt: 1, updatedAt: 1,
  });
  return item;
}

test('listLibrary: published movie exposes product state without internals', () => {
  const cache = createDiscoveryCache();
  const store = createControlPlaneStore();
  seedMoviePublication(store, cache, { mediaId: 'tt_list_1', tfId: 'tf_list_1', size: 1000, withBinding: true });

  const { items, total } = listLibrary({ cache, controlPlaneStore: store });
  assert.equal(total, 1);
  const it = items[0];
  assert.equal(it.mediaId, 'tt_list_1');
  assert.equal(it.mediaType, 'movie');
  assert.equal(it.state, 'published');
  assert.equal(it.desiredState, 'present');
  assert.equal(it.canonicalPath, 'Movies/List Movie (2024)/List Movie (2024).mkv');
  assert.equal(it.torrentFileId, 'tf_list_1');
  assert.equal(it.size, 1000);
  assert.equal(it.hasServingCoordinates, true);
  assert.equal(it.hasActiveBinding, true);
  const flat = JSON.stringify(it);
  assert.ok(!flat.includes('res-tt_list_1'), 'no placement ids leak');
  assert.ok(!flat.includes('pf-1'), 'no provider file ids leak');
  assert.ok(!flat.includes('127.0.0.1') && !flat.includes('requestdl'), 'no URLs leak');
  cache.close();
  store.close();
});

test('listLibrary: absent and incomplete states derive from existing truth', () => {
  const cache = createDiscoveryCache();
  const store = createControlPlaneStore();
  seedMoviePublication(store, cache, { mediaId: 'tt_list_abs', tfId: 'tf_abs', size: 100, withBinding: false, tag: 'abs' });
  seedMoviePublication(store, cache, { mediaId: 'tt_list_inc', tfId: 'tf_inc', size: 100, withBinding: false, tag: 'inc' });
  // Absent: desired_state flipped, VFS row removed (unpublish shape).
  store.unpublishLibraryItem('movie:tt_list_abs:default');
  cache.deleteVfsMovieEntry('tt_list_abs');
  // Incomplete: desired present but VFS row missing.
  cache.deleteVfsMovieEntry('tt_list_inc');

  const { items } = listLibrary({ cache, controlPlaneStore: store });
  const byId = Object.fromEntries(items.map((i) => [i.mediaId, i]));
  assert.equal(byId.tt_list_abs.state, 'absent');
  assert.equal(byId.tt_list_abs.desiredState, 'absent');
  assert.equal(byId.tt_list_abs.hasActiveBinding, false);
  assert.equal(byId.tt_list_inc.state, 'incomplete');
  assert.equal(byId.tt_list_inc.hasServingCoordinates, true);
  cache.close();
  store.close();
});

test('listLibrary: TV identity stays per-episode with mediaType filter', () => {
  const cache = createDiscoveryCache();
  const store = createControlPlaneStore();
  seedEpisodePublication(store, cache, { mediaId: 'tt_list_ep', season: 1, episode: 1, tfId: 'tf_ep1', size: 100 });
  seedEpisodePublication(store, cache, { mediaId: 'tt_list_ep', season: 1, episode: 2, tfId: 'tf_ep2', size: 200 });
  seedMoviePublication(store, cache, { mediaId: 'tt_list_mv', tfId: 'tf_mv', size: 300, withBinding: false });

  const all = listLibrary({ cache, controlPlaneStore: store });
  assert.equal(all.total, 3);
  const eps = listLibrary({ cache, controlPlaneStore: store, mediaType: 'episode' });
  assert.equal(eps.total, 2);
  assert.deepEqual(eps.items.map((i) => i.episode).sort(), [1, 2]);
  assert.ok(eps.items.every((i) => i.mediaType === 'episode' && i.season === 1));
  assert.ok(eps.items[0].torrentFileId !== eps.items[1].torrentFileId, 'episodes keep distinct tfIds');
  const mov = listLibrary({ cache, controlPlaneStore: store, mediaType: 'movie' });
  assert.equal(mov.total, 1);
  assert.equal(mov.items[0].state, 'published');
  cache.close();
  store.close();
});

test('listLibrary: legacy duplicate episode rows collapse to the canonical key', () => {
  const cache = createDiscoveryCache();
  const store = createControlPlaneStore();
  seedEpisodePublication(store, cache, { mediaId: 'tt_list_dup', season: 1, episode: 1, tfId: 'tf_dup', size: 100 });
  // Legacy writer row: same episode, 3-part identity key form.
  store.db.prepare(
    `INSERT INTO library_items (id, identity_key, media_type, media_id, edition_key, title, year, season, episode, desired_state, created_at, updated_at)
     VALUES ('li_legacy', 'episode:tt_list_dup:default', 'episode', 'tt_list_dup', 'default', 'Legacy', 2024, 1, 1, 'present', 1, 1)`,
  ).run();
  const { items } = listLibrary({ cache, controlPlaneStore: store, mediaType: 'episode' });
  const dup = items.filter((i) => i.mediaId === 'tt_list_dup');
  assert.equal(dup.length, 1, 'duplicate episode rows collapse to one entry');
  assert.equal(dup[0].state, 'published');
  assert.equal(dup[0].torrentFileId, 'tf_dup');
  cache.close();
  store.close();
});
