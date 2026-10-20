/**
 * Route-failure matrix.
 *
 * Representation authority (the Binding + its TorrentFile) and delivery
 * (the routes to those bytes) are separate facts. This matrix pins, for
 * every route-level failure the product can meet, that:
 *
 *   - the authoritative Binding is NOT changed by a route failure;
 *   - the same TorrentFile keeps its identity (infoHash + canonical
 *     internal path + exact positive size);
 *   - delivery either succeeds through a surviving route or fails closed
 *     with a typed error — never with a silently substituted representation;
 *   - a route that cannot prove the exact file identity is never used.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const SIZE = 4096;

function seedRoute(store, { provider, providerResourceId, providerFileId, infoHash = HASH, path = 'Movie.mkv', size = SIZE, state = 'ready', mappingState = 'mapped' }) {
  const item = store.ensureLibraryItem({
    mediaType: 'movie', mediaId: `tt-${provider}-${providerResourceId}`, title: 'Movie', year: 2024, desiredState: 'present',
  });
  const libraryPath = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider, accountScope: 'default', infoHash: HASH,
    providerResourceId, state, ownership: 'owned', ownerKey: item.id, provenance: 'test',
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId, path, name: path.split('/').pop(), size, selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9e12 });
  const torrentFile = store.findTorrentFile(infoHash, path);
  store.recordFileMapping({
    ...createReleaseIdentity(HASH, null), placementId: placement.id, providerFileId,
    state: mappingState, method: 'test', authoritative: true,
  });
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId, transport: 'test', exposureKey: `exp-${provider}-${providerFileId}`,
    relativePath: path, state: 'visible', readOnly: true, observedAt: 0, expiresAt: 9e12,
  });
  return { item, libraryPath, placement, providerFileId, exposure, torrentFile };
}

function bind(store, seeded) {
  return store.activateBinding({
    libraryItemId: seeded.item.id,
    libraryPathId: seeded.libraryPath.id,
    ...createReleaseIdentity(HASH, null),
    placementId: seeded.placement.id,
    providerFileId: seeded.providerFileId,
    exposureId: seeded.exposure.id,
    reason: 'test',
  });
}

function activeBinding(store, itemId) {
  return store.getActiveBindingForLibraryItem(itemId);
}

// ── 1. The active TorBox route disappears, an RD same-TorrentFile route exists
test('matrix: the active TorBox route disappears while an RD route to the SAME TorrentFile survives', () => {
  const store = createControlPlaneStore();
  const torbox = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-1', providerFileId: 'pf-tb' });
  const torrentFileId = torbox.torrentFile.id;
  bind(store, torbox);
  // The same physical file is also reachable through Real-Debrid.
  seedRoute(store, { provider: 'realdebrid', providerResourceId: 'RD-1', providerFileId: 'pf-rd' });
  const rdTorrentFile = store.findTorrentFile(HASH, 'Movie.mkv');
  assert.equal(rdTorrentFile.id, torrentFileId, 'one TorrentFile, two routes');

  // The TorBox route disappears (the provider dropped the resource).
  store.db.prepare("UPDATE provider_placements SET state = 'removed' WHERE provider_resource_id = 'TB-1'").run();

  const coords = store.listDataPlaneCoordinates(torrentFileId);
  assert.deepEqual(coords.map((c) => c.provider_resource_id), ['RD-1'],
    'only the surviving route is offered to the data plane');
  const active = activeBinding(store, torbox.item.id);
  assert.equal(active.binding.status, 'active', 'a dead route does not degrade the representation');
  assert.equal(active.torrentFile.id, torrentFileId, 'the authoritative TorrentFile is unchanged');
  store.close();
});

// ── 2. The active RD route disappears, a TorBox same-TorrentFile route exists
test('matrix: the active Real-Debrid route disappears while a TorBox route to the SAME TorrentFile survives', () => {
  const store = createControlPlaneStore();
  const rd = seedRoute(store, { provider: 'realdebrid', providerResourceId: 'RD-2', providerFileId: 'pf-rd2' });
  const torrentFileId = rd.torrentFile.id;
  bind(store, rd);
  seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-2', providerFileId: 'pf-tb2' });

  store.db.prepare("UPDATE provider_placements SET state = 'removed' WHERE provider_resource_id = 'RD-2'").run();

  const coords = store.listDataPlaneCoordinates(torrentFileId);
  assert.deepEqual(coords.map((c) => c.provider_resource_id), ['TB-2']);
  const active = activeBinding(store, rd.item.id);
  assert.equal(active.binding.status, 'active');
  assert.equal(active.torrentFile.id, torrentFileId);
  store.close();
});

// ── 3. The active resource id disappears, another resource with the same hash exists
test('matrix: a vanished provider resource does not remove the route set of the TorrentFile', () => {
  const store = createControlPlaneStore();
  const first = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-OLD', providerFileId: 'pf-old' });
  const torrentFileId = first.torrentFile.id;
  bind(store, first);
  // A second resource for the same hash, carrying the same file.
  seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-NEW', providerFileId: 'pf-new' });

  // The old resource vanishes from the provider; the durable observation for
  // it is not authoritative any more.
  store.db.prepare("UPDATE provider_placements SET state = 'removed' WHERE provider_resource_id = 'TB-OLD'").run();

  const coords = store.listDataPlaneCoordinates(torrentFileId);
  assert.deepEqual(coords.map((c) => c.provider_resource_id), ['TB-NEW'],
    'the surviving resource with the same hash still serves the same TorrentFile');
  assert.equal(activeBinding(store, first.item.id).torrentFile.id, torrentFileId);
  store.close();
});

// ── 4. A stale local ProviderPlacement cannot authorize a NEW binding
test('matrix: a stale inventory observation refuses to authorize a binding but never invalidates an existing one', () => {
  const store = createControlPlaneStore();
  const seeded = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-3', providerFileId: 'pf-3' });
  const binding = bind(store, seeded);

  // The route evidence expires (the 5-minute inventory observation TTL).
  store.db.prepare('UPDATE provider_inventory_snapshots SET expires_at = 1').run();
  store.db.prepare('UPDATE provider_files SET inventory_expires_at = 1').run();

  // A NEW authorization for the same identity now fails closed...
  assert.throws(() => bind(store, seeded), /stale or unbounded provider inventory observation/);

  // ...but the already-authorized representation is untouched: it is not
  // re-derived from a volatile observation.
  const active = activeBinding(store, seeded.item.id);
  assert.equal(active.binding.id, binding.id, 'the active Binding is unchanged');
  assert.equal(active.binding.status, 'active');
  assert.equal(active.torrentFile.id, seeded.torrentFile.id);
  store.close();
});

// ── 5. A stale ProviderFile mapping cannot authorize a binding
test('matrix: a provider file that is no longer present cannot back a new binding', () => {
  const store = createControlPlaneStore();
  const seeded = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-4', providerFileId: 'pf-4' });
  bind(store, seeded);
  store.db.prepare("UPDATE provider_files SET present = 0 WHERE provider_file_id = 'pf-4'").run();
  assert.throws(() => bind(store, seeded));
  assert.equal(activeBinding(store, seeded.item.id).binding.status, 'active',
    'the existing representation survives its route file going missing');
  store.close();
});

// ── 6. A route that cannot prove the exact file identity is never offered
test('matrix: a route with a mismatched size can never satisfy the authoritative TorrentFile', () => {
  const store = createControlPlaneStore();
  const seeded = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-5', providerFileId: 'pf-5' });
  const torrentFileId = seeded.torrentFile.id;
  bind(store, seeded);

  // A second route for the same release whose file has a DIFFERENT size
  // must not be usable for the authoritative TorrentFile.
  const other = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH,
    providerResourceId: 'TB-5B', state: 'ready', ownership: 'owned',
    ownerKey: seeded.item.id, provenance: 'test',
  });
  store.replaceProviderFileInventory(other.id, [{
    providerFileId: 'pf-5b', path: 'Movie.mkv', name: 'Movie.mkv', size: SIZE + 1, selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9e12 });

  const coords = store.listDataPlaneCoordinates(torrentFileId);
  const sizes = coords.map((c) => c.size);
  assert.ok(sizes.includes(SIZE));
  assert.ok(!sizes.includes(SIZE + 1),
    'a different-size file is a different TorrentFile and must not be offered for this one');
  // The authoritative size is what the data plane matches against.
  assert.equal(store.getTorrentFile(torrentFileId).size, SIZE);
  store.close();
});

// ── 7/8/9. Provider 404/410, 429 and a network timeout are DELIVERY facts
test('matrix: provider 404/410, 429 and a network timeout leave the representation authoritative', () => {
  const store = createControlPlaneStore();
  const seeded = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-6', providerFileId: 'pf-6' });
  const binding = bind(store, seeded);
  for (const failure of ['404', '410', '429', 'timeout']) {
    // The provider answers with a failure for this route.
    store.db.prepare(
      "UPDATE provider_placements SET state = 'error', failure_category = ? WHERE provider_resource_id = 'TB-6'",
    ).run(failure);
    // The route is gone, the representation is not.
    const active = activeBinding(store, seeded.item.id);
    assert.equal(active.binding.id, binding.id, `${failure}: the Binding is not replaced`);
    assert.equal(active.binding.status, 'active', `${failure}: the representation stays authoritative`);
    assert.equal(active.torrentFile.id, seeded.torrentFile.id, `${failure}: the TorrentFile is unchanged`);
  }
  store.close();
});

// ── 10. Both providers unavailable
test('matrix: with no provider available the representation stays authoritative', () => {
  const store = createControlPlaneStore();
  const torbox = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-7', providerFileId: 'pf-7' });
  const binding = bind(store, torbox);
  store.db.prepare("UPDATE provider_placements SET state = 'error'").run();

  const active = activeBinding(store, torbox.item.id);
  assert.equal(active.binding.id, binding.id);
  assert.equal(active.binding.status, 'active',
    'an outage degrades delivery, never the representation');
  const coords = store.listDataPlaneCoordinates(torbox.torrentFile.id);
  assert.equal(coords.length, 1, 'the route is still offered — with its state visible');
  assert.equal(coords[0].placement_state, 'error',
    'the route state travels with the coordinate: execution decides, Node does not hide it');
  store.close();
});

// ── 11. A different TorrentFile can never silently substitute
test('matrix: a different TorrentFile is a different representation and cannot satisfy the authoritative one', () => {
  const store = createControlPlaneStore();
  const seeded = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-8', providerFileId: 'pf-8' });
  bind(store, seeded);
  const authoritative = store.getTorrentFile(seeded.torrentFile.id);

  // A different file for the same release (different canonical path/size).
  store.replaceProviderFileInventory(seeded.placement.id, [{
    providerFileId: 'pf-8-other', path: 'Other.Movie.mkv', name: 'Other.Movie.mkv', size: SIZE, selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9e12 });

  const other = store.findTorrentFile(HASH, 'Other.Movie.mkv');
  assert.ok(other, 'a different canonical internal path is a different TorrentFile');
  assert.notEqual(other.id, authoritative.id, 'different bytes are a different representation');
  const coords = store.listDataPlaneCoordinates(authoritative.id);
  assert.ok(!coords.some((c) => c.provider_file_id === 'pf-8-other'),
    'the other file is never offered for the authoritative TorrentFile');
  store.close();
});
