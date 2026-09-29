import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';
import { createLibraryIdentityKey } from '../src/lib/control-plane/canonical-path.js';

const HASH_X = 'abcdef0123456789abcdef0123456789abcdef01';
const HASH_Y = '1234567890abcdef1234567890abcdef12345678';

function movie() {
  return {
    mediaType: 'movie', mediaId: 'tt-binding-authority', title: 'Binding Authority',
    year: 2026, desiredState: 'present',
  };
}

function bindable(store, item, identity, suffix, { internalPath = null } = {}) {
  const libraryPath = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: suffix === 'x' ? 'torbox' : 'realdebrid',
    accountScope: 'default', infoHash: identity.infoHash,
    providerResourceId: `resource-${suffix}`, state: 'ready', ownership: 'owned',
    ownerKey: item.id, provenance: 'binding-authority-test',
  });
  const providerPath = internalPath ?? `/movie-${suffix}.mkv`;
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: `file-${suffix}`, path: providerPath,
    name: providerPath.split('/').pop(), size: 1000, selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9e12 });
  store.recordFileMapping({
    ...identity, placementId: placement.id, providerFileId: `file-${suffix}`,
    state: 'mapped', method: 'test', authoritative: true,
  });
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId: `file-${suffix}`,
    transport: 'test', exposureKey: `exposure-${suffix}`,
    relativePath: providerPath, state: 'visible', readOnly: true,
    observedAt: 0, expiresAt: 9e12,
  });
  return { libraryPath, placement, providerFileId: `file-${suffix}`, exposure };
}

function handoff(infoHash, torrentFileId, suffix) {
  return {
    mediaId: 'tt-binding-authority', mediaType: 'movie',
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    filename: `Movie.${suffix}.mkv`, provider: suffix === 'x' ? 'torbox' : 'realdebrid',
    torrentFileId, requestId: `req-${suffix}`,
  };
}

test('active Binding resolves the exact TorrentFile and ignores stale handoff/result state', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  const x = bindable(store, item, createReleaseIdentity(HASH_X, null), 'x');
  const binding = store.activateBinding({
    libraryItemId: item.id, libraryPathId: x.libraryPath.id,
    ...createReleaseIdentity(HASH_X, null), placementId: x.placement.id,
    providerFileId: x.providerFileId, exposureId: x.exposure.id, reason: 'initial',
  });

  const authoritative = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(authoritative.binding.id, binding.id);
  assert.equal(authoritative.torrentFile.infoHash, HASH_X);
  assert.equal(authoritative.torrentFile.id, store.listProviderRefsForTorrentFile(authoritative.torrentFile.id)[0].torrentFileId);
  assert.notEqual(HASH_Y, authoritative.torrentFile.infoHash, 'stale rank-1 result cannot override Binding');
  store.close();
});

test('route change preserves Binding and exact TorrentFile identity', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH_X, null);
  const first = bindable(store, item, identity, 'x');
  const initial = store.activateBinding({
    libraryItemId: item.id, libraryPathId: first.libraryPath.id, ...identity,
    placementId: first.placement.id, providerFileId: first.providerFileId,
    exposureId: first.exposure.id, reason: 'initial',
  });
  const route = bindable(store, item, identity, 'route', { internalPath: '/movie-x.mkv' });
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: first.libraryPath.id, ...identity,
    placementId: route.placement.id, providerFileId: route.providerFileId,
    exposureId: route.exposure.id, reason: 'provider-route-change',
  });
  const current = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(current.torrentFile.id, store.getTorrentFile(current.torrentFile.id).id);
  assert.equal(current.torrentFile.infoHash, HASH_X);
  assert.equal(current.binding.id, initial.id, 'same TorrentFile route change preserves Binding identity');
  assert.equal(current.binding.providerFileId, route.providerFileId);
  store.close();
});

test('stale VFS projection converges to active Binding without rewriting Binding', async () => {
  const store = createControlPlaneStore();
  const cache = createDiscoveryCache();
  const item = store.ensureLibraryItem(movie());
  const x = bindable(store, item, createReleaseIdentity(HASH_X, null), 'x');
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: x.libraryPath.id,
    ...createReleaseIdentity(HASH_X, null), placementId: x.placement.id,
    providerFileId: x.providerFileId, exposureId: x.exposure.id, reason: 'initial',
  });
  const y = bindable(store, item, createReleaseIdentity(HASH_Y, null), 'y');
  const yTf = store.listProviderRefsForTorrentFile(store.findTorrentFile(HASH_Y, 'movie-y.mkv')?.id ?? '').at(0);
  const yTorrentFile = yTf ? store.getTorrentFile(yTf.torrentFileId) : store.findTorrentFile(HASH_Y, 'movie-y.mkv');
  cache.createVfsMovieEntry({
    mediaId: item.mediaId, releaseKey: `${HASH_Y}:torrent`, infoHash: HASH_Y,
    fileIndex: null, canonicalPath: 'Movies/Binding Authority (2026)/Binding Authority (2026).mkv',
    torrentFileId: yTorrentFile.id, size: yTorrentFile.size, createdAt: 1, updatedAt: 1,
  });
  const result = await materializeVfsEntry(cache, handoff(HASH_Y, yTorrentFile.id, 'y'), store, () => 2, { allowLegacy: false });
  assert.equal(result.torrentFileId, store.getActiveBindingForLibraryItem(item.id).torrentFile.id);
  assert.equal(result.infoHash, HASH_X);
  assert.equal(store.getActiveBindingForLibraryItem(item.id).torrentFile.infoHash, HASH_X);
  cache.close();
  store.close();
});

test('route loss does not erase Binding identity and route restoration is identity-stable', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH_X, null);
  const route = bindable(store, item, identity, 'x');
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: route.libraryPath.id, ...identity,
    placementId: route.placement.id, providerFileId: route.providerFileId,
    exposureId: route.exposure.id, reason: 'initial',
  });
  const before = store.getActiveBindingForLibraryItem(item.id);
  const providerRow = store.db.prepare(
    'SELECT id FROM provider_files WHERE placement_id = ? AND provider_file_id = ?',
  ).get(route.placement.id, route.providerFileId);
  store.db.prepare('UPDATE provider_files SET present = 0, mapping_state = \'incomplete\' WHERE id = ?').run(providerRow.id);
  store.db.prepare("UPDATE provider_placements SET state = 'removed' WHERE id = ?").run(route.placement.id);

  const exhausted = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(exhausted.torrentFile.id, before.torrentFile.id);
  assert.equal(exhausted.binding.torrentFileId, before.binding.torrentFileId);
  assert.deepEqual(store.listDataPlaneCoordinates(before.torrentFile.id), [], 'route inventory is separately exhausted');

  store.db.prepare('UPDATE provider_files SET present = 1, mapping_state = \'mapped\' WHERE id = ?').run(providerRow.id);
  store.db.prepare("UPDATE provider_placements SET state = 'ready' WHERE id = ?").run(route.placement.id);
  const restored = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(restored.torrentFile.id, before.torrentFile.id);
  assert.equal(restored.binding.id, before.binding.id, 'same-object route restoration does not change Binding');
  store.close();
});

test('identity key remains the durable library lookup key', () => {
  assert.equal(createLibraryIdentityKey(movie()), 'movie:tt-binding-authority:default');
});
