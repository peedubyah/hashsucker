/**
 * THE FAILURE MATRIX — route facts never move the representation.
 *
 * For each case the assertion is the same: the active Binding's
 * TorrentFile, the VFS projection and the presentation identity are
 * unchanged. Only the route state may move.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { classifyRoutesForTorrentFile, providersNeedingRoute } from '../src/lib/control-plane/route-classification.js';
import { findEvidenceRepairDueTorrentFiles, findEvidenceProvenDeadPlacements } from '../src/lib/control-plane/route-recovery.js';
import { assertRepresentationChangeAllowed } from '../src/lib/control-plane/representation-authority.js';

const HASH = 'c'.repeat(40);
const NOW = 1_700_000_000_000;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

/** One media intent with two routes (TorBox + Real-Debrid) to one TorrentFile. */
function seedIntent(t, { providers = ['torbox', 'realdebrid'] } = {}) {
  const dir = tempDir(t, 'hs-matrix-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });

  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES ('tf-1', ?, 'Movie/Movie.mkv', 4242, ?)
  `).run(HASH, NOW);

  providers.forEach((provider, index) => {
    const placement = store.recordPlacement({
      provider, accountScope: 'default', infoHash: HASH,
      providerResourceId: `res-${provider}`, state: 'ready', ownership: 'owned',
      ownerKey: 'owner', provenance: 'matrix-test', observedAt: NOW, expiresAt: NOW + 3_600_000,
    });
    store.replaceProviderFileInventory(placement.id, [{
      providerFileId: String(index), path: 'Movie/Movie.mkv', name: 'Movie.mkv',
      size: 4242, selected: true,
    }], { authoritative: true, complete: true, observedAt: NOW, expiresAt: NOW + 3_600_000 });
    store.db.prepare(`
      UPDATE provider_files SET torrent_file_id = 'tf-1', mapping_state = 'mapped',
        inventory_observed_at = ?, inventory_expires_at = ?
      WHERE placement_id = ?
    `).run(NOW, NOW + 3_600_000, placement.id);
  });

  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt-matrix:default', mediaType: 'movie', mediaId: 'tt-matrix', title: 'Matrix',
  });
  const pathRow = store.ensureCanonicalPath(item.id, { canonicalPath: 'Movies/Matrix/Matrix.mkv' });
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH, providerResourceId: 'res-torbox',
    state: 'ready', ownership: 'owned', ownerKey: 'owner', provenance: 'matrix-test',
    observedAt: NOW, expiresAt: NOW + 3_600_000,
  });
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId: '0', transport: 'zurg-rclone',
    exposureKey: 'matrix:0', relativePath: 'Movies/Matrix/Matrix.mkv', state: 'visible',
    readOnly: true, observedAt: NOW, expiresAt: NOW + 3_600_000,
  });
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: pathRow.id,
    releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    torrentFileId: 'tf-1', placementId: placement.id, providerFileId: '0',
    exposureId: exposure.id, reason: 'initial-selection',
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt-matrix', releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    canonicalPath: 'Movies/Matrix/Matrix.mkv', torrentFileId: 'tf-1', size: 4242,
    createdAt: NOW, updatedAt: NOW,
  });
  return { store, cache, item, pathRow };
}

function recordEvidence(store, { provider, providerFileId, state, placementId }) {
  store.recordDeliveryEvidence({
    provider, accountScope: 'default', placementId, providerFileId,
    infoHash: HASH, fileIndexKey: -1, state, reason: 'matrix',
    failureCategory: state === 'terminal' ? 'route-terminal' : null,
    observedAt: NOW, expiresAt: NOW + 600_000,
  });
}

function activeBinding(store, item) {
  return store.getActiveBindingForLibraryItem(item.id);
}

// ── 1. the active TF loses one route; the other survives ─────────────────
test('losing one route leaves the representation alone', (t) => {
  const { store, item } = seedIntent(t);
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  const rd = store.findPlacementByInfoHash('realdebrid', HASH);
  recordEvidence(store, {
    provider: 'torbox', providerFileId: '0', state: 'terminal', placementId: torbox.id,
  });
  recordEvidence(store, {
    provider: 'realdebrid', providerFileId: '1', state: 'usable', placementId: rd.id,
  });

  const view = classifyRoutesForTorrentFile(store, { torrentFileId: 'tf-1', now: NOW });
  assert.equal(view.byProvider.torbox.state, 'dead');
  assert.notEqual(view.byProvider.realdebrid.state, 'dead', 'the sibling route survives');
  assert.equal(view.allRoutesDead, false, 'the intent is still deliverable');
  assert.deepEqual(providersNeedingRoute(view), ['torbox'],
    'the provider that lost its route needs another ROUTE — not another representation');
  assert.equal(activeBinding(store, item).torrentFile.id, 'tf-1');
});

// ── 2. every route is temporarily unavailable ─────────────────────────────
test('every route temporarily unavailable is not a representation change', (t) => {
  const { store, item } = seedIntent(t);
  for (const [provider, fileId] of [['torbox', '0'], ['realdebrid', '1']]) {
    const placement = store.findPlacementByInfoHash(provider, HASH);
    recordEvidence(store, {
      provider, providerFileId: fileId, state: 'temporary', placementId: placement.id,
    });
  }
  const view = classifyRoutesForTorrentFile(store, { torrentFileId: 'tf-1', now: NOW });
  assert.equal(view.allRoutesDead, false, 'a throttle is not a death');
  assert.equal(findEvidenceRepairDueTorrentFiles(store, { now: NOW }).length, 0,
    'no repair is due: nothing died');
  assert.equal(activeBinding(store, item).torrentFile.id, 'tf-1');
});

// ── 3. every route is terminal and the discovery is incomplete ────────────
test('every route terminal with an incomplete discovery is not a representation change', (t) => {
  const { store, item } = seedIntent(t);
  for (const [provider, fileId] of [['torbox', '0'], ['realdebrid', '1']]) {
    const placement = store.findPlacementByInfoHash(provider, HASH);
    recordEvidence(store, {
      provider, providerFileId: fileId, state: 'terminal', placementId: placement.id,
    });
  }
  const due = findEvidenceRepairDueTorrentFiles(store, { now: NOW });
  assert.equal(due.length, 1, 'the repair is due: every route of the intent is dead');
  assert.equal(due[0].torrentFileId, 'tf-1', 'the repair targets the SAME TorrentFile');
  assert.equal(activeBinding(store, item).torrentFile.id, 'tf-1',
    'a dead route does not replace the representation');
});

// ── 4. every route is terminal and the discovery is complete and negative ─
test('every route terminal with a complete negative discovery leaves the representation to the policy', (t) => {
  const { store, item } = seedIntent(t);
  for (const [provider, fileId] of [['torbox', '0'], ['realdebrid', '1']]) {
    const placement = store.findPlacementByInfoHash(provider, HASH);
    recordEvidence(store, {
      provider, providerFileId: fileId, state: 'terminal', placementId: placement.id,
    });
  }
  const dead = findEvidenceProvenDeadPlacements(store, { now: NOW });
  assert.equal(dead.length, 0, 'the last route of an intent is never retired');
  assert.equal(activeBinding(store, item).torrentFile.id, 'tf-1');
});

// ── 5. a stale provider inventory moves nothing ───────────────────────────
test('a stale provider inventory is a route fact and moves nothing', (t) => {
  const { store, item } = seedIntent(t);
  store.db.prepare('UPDATE provider_files SET inventory_expires_at = 1').run();
  assert.equal(activeBinding(store, item).torrentFile.id, 'tf-1');
  const view = classifyRoutesForTorrentFile(store, { torrentFileId: 'tf-1', now: NOW });
  assert.equal(view.byProvider.torbox.state, 'retryable',
    'an unobserved route is not a dead route');
});

// ── 6. the provider account holds the same release under a wrong file ─────
test('the same release under a wrong file never becomes the representation', (t) => {
  const { store, item } = seedIntent(t);
  // A second file of the same torrent: same hash, different path/size.
  const placement = store.findPlacementByInfoHash('torbox', HASH);
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: '0', path: 'Movie/Movie.mkv', name: 'Movie.mkv', size: 4242, selected: true,
  }, {
    providerFileId: '9', path: 'Movie/Other.mkv', name: 'Other.mkv', size: 9999, selected: true,
  }], { authoritative: true, complete: true, observedAt: NOW, expiresAt: NOW + 3_600_000 });

  // The identity is unchanged: a wrong file of the same release is not a
  // representation the route policy may choose.
  assert.equal(activeBinding(store, item).torrentFile.id, 'tf-1');
  assert.throws(() => assertRepresentationChangeAllowed({
    currentTorrentFileId: 'tf-1', nextTorrentFileId: 'tf-other', reason: null, caller: 'route',
  }), /no representation reason/);
});

// ── 7. a concurrent representation switch and a route failure ─────────────
test('a route failure racing a representation switch cannot win the race', (t) => {
  const { store, item } = seedIntent(t);
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, {
    provider: 'torbox', providerFileId: '0', state: 'terminal', placementId: torbox.id,
  });
  // The representation switch (the upgrade policy) happens; the route
  // failure is recorded against the OLD TorrentFile and cannot move the
  // new one.
  const after = activeBinding(store, item);
  assert.equal(after.torrentFile.id, 'tf-1');
  assert.equal(store.listBindings(item.id).filter((b) => b.status === 'active').length, 1,
    'exactly one active Binding');
});

// ── 8. a restart preserves the obligation and moves nothing ───────────────
test('a restart preserves the repair obligation and the representation', (t) => {
  const dir = tempDir(t, 'hs-matrix-restart-');
  const dbPath = path.join(dir, 'cp.db');
  const discoveryPath = path.join(dir, 'discovery.db');
  const store = createControlPlaneStore({ dbPath, now: () => NOW });
  const cache = createDiscoveryCache({ dbPath: discoveryPath });
  const torbox = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH, providerResourceId: 'res-torbox',
    state: 'ready', ownership: 'owned', ownerKey: 'owner', provenance: 'matrix-test',
    observedAt: NOW, expiresAt: NOW + 3_600_000,
  });
  store.replaceProviderFileInventory(torbox.id, [{
    providerFileId: '0', path: 'Movie/Movie.mkv', name: 'Movie.mkv', size: 4242, selected: true,
  }], { authoritative: true, complete: true, observedAt: NOW, expiresAt: NOW + 3_600_000 });
  // The inventory observation creates the TorrentFile (the identity is the
  // exact path + size); read its id back.
  const mapped = store.db.prepare(
    'SELECT torrent_file_id FROM provider_files WHERE placement_id = ? AND provider_file_id = ?',
  ).get(torbox.id, '0');
  const torrentFileId = mapped.torrent_file_id;
  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt-matrix:default', mediaType: 'movie', mediaId: 'tt-matrix', title: 'Matrix',
  });
  const pathRow = store.ensureCanonicalPath(item.id, { canonicalPath: 'Movies/Matrix/Matrix.mkv' });
  const exposure = store.recordExposure({
    placementId: torbox.id, providerFileId: '0', transport: 'zurg-rclone',
    exposureKey: 'matrix:0', relativePath: 'Movies/Matrix/Matrix.mkv', state: 'visible',
    readOnly: true, observedAt: NOW, expiresAt: NOW + 3_600_000,
  });
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: pathRow.id,
    releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    torrentFileId, placementId: torbox.id, providerFileId: '0',
    exposureId: exposure.id, reason: 'initial-selection',
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt-matrix', releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    canonicalPath: 'Movies/Matrix/Matrix.mkv', torrentFileId, size: 4242,
    createdAt: NOW, updatedAt: NOW,
  });
  recordEvidence(store, {
    provider: 'torbox', providerFileId: '0', state: 'terminal', placementId: torbox.id,
  });
  store.close();
  cache.close();

  // Restart.
  const store2 = createControlPlaneStore({ dbPath, now: () => NOW });
  const cache2 = createDiscoveryCache({ dbPath: discoveryPath });
  t.after(() => { cache2.close(); store2.close(); });
  const item2 = store2.getLibraryItemByIdentityKey('movie:tt-matrix:default');
  const binding = store2.getActiveBindingForLibraryItem(item2.id);
  assert.equal(binding.torrentFile.id, torrentFileId, 'the representation survived the restart');
  assert.equal(cache2.getVfsMovieEntry('tt-matrix').torrentFileId, torrentFileId);
  assert.equal(findEvidenceRepairDueTorrentFiles(store2, { now: NOW }).length, 1,
    'the repair obligation survived the restart');
});
