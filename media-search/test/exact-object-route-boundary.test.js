import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const MEDIA_ID = 'tt-route-boundary';

function fixture() {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem({ mediaType: 'movie', mediaId: MEDIA_ID, title: 'Route Boundary', year: 2026 });
  const identity = createReleaseIdentity(HASH, null);
  const path = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH,
    providerResourceId: 'resource-x', state: 'ready', ownership: 'owned',
    ownerKey: item.id, provenance: 'exact-object-route-test',
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: 'provider-x', path: '/route-boundary.mkv', name: 'route-boundary.mkv', size: 1000,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9e12 });
  const tf = store.findTorrentFile(HASH, '/route-boundary.mkv');
  store.recordFileMapping({ ...identity, placementId: placement.id, providerFileId: 'provider-x', state: 'mapped', method: 'test', authoritative: true });
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId: 'provider-x', transport: 'test', exposureKey: 'route-x',
    relativePath: '/route-boundary.mkv', state: 'visible', readOnly: true, observedAt: 0, expiresAt: 9e12,
  });
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: path.id, ...identity,
    torrentFileId: tf.id, placementId: placement.id, providerFileId: 'provider-x',
    exposureId: exposure.id, reason: 'initial',
  });
  return { store, item, tf, placement };
}

test('S-1 route inventory is keyed by TorrentFile, not Binding route pointers', () => {
  const { store, item, tf, placement } = fixture();
  const before = store.getActiveBindingForLibraryItem(item.id);
  store.db.prepare('UPDATE provider_files SET present = 0, mapping_state = \'incomplete\' WHERE placement_id = ?').run(placement.id);
  const active = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(active.torrentFile.id, tf.id);
  assert.equal(active.binding.torrentFileId, tf.id);
  assert.deepEqual(store.listDataPlaneCoordinates(tf.id), [], 'stale route is absent from current inventory');
  store.close();
});

test('zero routes preserve exact TorrentFile identity', () => {
  const { store, item, tf, placement } = fixture();
  store.db.prepare("UPDATE provider_placements SET state = 'removed' WHERE id = ?").run(placement.id);
  const active = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(active.torrentFile.id, tf.id);
  assert.deepEqual(store.listDataPlaneCoordinates(tf.id), []);
  store.close();
});

test('same-TorrentFile route restoration leaves Binding unchanged', () => {
  const { store, item, tf, placement } = fixture();
  const before = store.getActiveBindingForLibraryItem(item.id);
  store.db.prepare("UPDATE provider_placements SET state = 'removed' WHERE id = ?").run(placement.id);
  store.db.prepare("UPDATE provider_placements SET state = 'ready' WHERE id = ?").run(placement.id);
  store.db.prepare("UPDATE provider_files SET present = 1, mapping_state = 'mapped' WHERE placement_id = ?").run(placement.id);
  const after = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(after.torrentFile.id, tf.id);
  assert.equal(after.binding.id, before.binding.id);
  store.close();
});
