/**
 * Binding authority: an already-authorized binding is not re-authorized.
 *
 * The WebDAV catalog sweep converges every handoff on the READ path, so
 * every sweep re-attempted the activation of every published item. The
 * store's activation guard proves the ROUTE OBSERVATION is fresh before
 * it authorizes anything, and the provider inventory observation expires
 * on its own TTL — so an unchanged, already-authorized binding was
 * re-checked against an expired observation and reported as a failure,
 * forever (measured 2026-10-19: 330 such warnings in 30 minutes, and
 * binding-version churn for unchanged identities).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

function movie() {
  return {
    mediaType: 'movie', mediaId: 'tt-binding-reuse', title: 'Binding Reuse',
    year: 2026, desiredState: 'present',
  };
}

function bindable(store, item, identity, suffix, { internalPath = null, expiresAt = 9e12 } = {}) {
  const libraryPath = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: identity.infoHash,
    providerResourceId: `resource-${suffix}`, state: 'ready', ownership: 'owned',
    ownerKey: item.id, provenance: 'binding-reuse-test',
  });
  const providerPath = internalPath ?? `/movie-${suffix}.mkv`;
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: `file-${suffix}`, path: providerPath,
    name: providerPath.split('/').pop(), size: 1000, selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt });
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

function handoff(infoHash, torrentFileId) {
  return {
    mediaId: 'tt-binding-reuse', mediaType: 'movie',
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    filename: 'Movie.mkv', provider: 'torbox',
    torrentFileId, requestId: 'req-1',
  };
}

function expireInventory(store, placementId) {
  store.db.prepare(
    'UPDATE provider_inventory_snapshots SET expires_at = 1 WHERE placement_id = ?',
  ).run(placementId);
  store.db.prepare(
    'UPDATE provider_files SET inventory_expires_at = 1 WHERE placement_id = ?',
  ).run(placementId);
}

function bindingRows(store, itemId) {
  return store.db.prepare(
    'SELECT id, version, status FROM bindings WHERE library_item_id = ? ORDER BY version',
  ).all(itemId);
}

test('an unchanged active Binding is not re-authorized (no version churn)', async () => {
  const store = createControlPlaneStore();
  const cache = createDiscoveryCache();
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, null);
  const route = bindable(store, item, identity, 'x');
  const torrentFile = store.findTorrentFile(HASH, '/movie-x.mkv');

  await materializeVfsEntry(cache, handoff(HASH, torrentFile.id), store, undefined, { allowLegacy: false });
  const afterFirst = bindingRows(store, item.id);
  assert.equal(afterFirst.length, 1, 'the first publication creates the Binding');

  await materializeVfsEntry(cache, handoff(HASH, torrentFile.id), store, undefined, { allowLegacy: false });
  const afterSecond = bindingRows(store, item.id);
  assert.equal(afterSecond.length, 1, 'an unchanged identity must not create a new Binding version');
  assert.equal(afterSecond[0].status, 'active');
  cache.close();
  store.close();
});

test('an unchanged active Binding survives an expired provider inventory observation', async () => {
  const store = createControlPlaneStore();
  const cache = createDiscoveryCache();
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, null);
  const route = bindable(store, item, identity, 'x');
  const torrentFile = store.findTorrentFile(HASH, '/movie-x.mkv');

  await materializeVfsEntry(cache, handoff(HASH, torrentFile.id), store, undefined, { allowLegacy: false });
  const activeBefore = store.getActiveBindingForLibraryItem(item.id);
  assert.ok(activeBefore, 'the first publication creates the active Binding');

  // The provider inventory observation expires on its own TTL. The Binding
  // was already authorized; re-authorizing it against an expired
  // observation proves nothing and can only fail.
  expireInventory(store, route.placement.id);

  await materializeVfsEntry(cache, handoff(HASH, torrentFile.id), store, undefined, { allowLegacy: false });
  const rows = bindingRows(store, item.id);
  assert.equal(rows.length, 1, 'an expired observation must not churn the Binding');
  assert.equal(rows[0].status, 'active', 'the active Binding must survive');
  const activeAfter = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(activeAfter.binding.id, activeBefore.binding.id, 'the same Binding stays active');
  assert.equal(activeAfter.torrentFile.id, torrentFile.id, 'the exact TorrentFile identity is preserved');
  cache.close();
  store.close();
});

test('the skip never blocks a legitimate activation (no active Binding)', async () => {
  const store = createControlPlaneStore();
  const cache = createDiscoveryCache();
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, null);
  const route = bindable(store, item, identity, 'x');
  const torrentFile = store.findTorrentFile(HASH, '/movie-x.mkv');

  await materializeVfsEntry(cache, handoff(HASH, torrentFile.id), store, undefined, { allowLegacy: false });
  const first = bindingRows(store, item.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'active');

  // Nothing is active any more (e.g. the Binding was superseded): the
  // publication must authorize again.
  store.db.prepare("UPDATE bindings SET status = 'superseded' WHERE id = ?").run(first[0].id);
  assert.equal(store.getActiveBindingForLibraryItem(item.id), null);

  await materializeVfsEntry(cache, handoff(HASH, torrentFile.id), store, undefined, { allowLegacy: false });
  const rows = bindingRows(store, item.id);
  assert.equal(rows.length, 2, 'a missing active Binding must be authorized again');
  assert.equal(rows.at(-1).status, 'active');
  cache.close();
  store.close();
});
