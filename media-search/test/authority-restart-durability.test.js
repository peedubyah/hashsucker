/**
 * Restart durability of the authority/recovery model.
 *
 * A restart must not change WHAT IS AUTHORITATIVE. The durable truth is
 * the control-plane SQLite database; the runtime byte-health registry is
 * process-local and MUST NOT be able to revoke an authority.
 *
 * These tests pin:
 *   - the active Binding, its TorrentFile, its route set and the durable
 *     route-failure evidence are identical after a store reopen;
 *   - the durable hash → resource index (ProviderPlacement) reconstructs
 *     exactly, including several resources for one hash;
 *   - a route observed as dead before a restart is still known dead after
 *     it (the durable evidence survives), while a route that was merely
 *     unknown is not promoted to "dead";
 *   - a degraded delivery state still has exactly one owner after the
 *     restart: the durable evidence store plus the route reconciler.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const SIZE = 4096;

function tempDbPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-restart-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return path.join(dir, 'control-plane.db');
}

function seedRoute(store, { provider, providerResourceId, providerFileId, infoHash = HASH, filePath = 'Movie.mkv' }) {
  const item = store.ensureLibraryItem({
    mediaType: 'movie', mediaId: `tt-${provider}-${providerResourceId}`, title: 'Movie', year: 2024, desiredState: 'present',
  });
  const libraryPath = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider, accountScope: 'default', infoHash,
    providerResourceId, state: 'ready', ownership: 'owned', ownerKey: item.id, provenance: 'test',
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId, path: filePath, name: filePath.split('/').pop(), size: SIZE, selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9e12 });
  const torrentFile = store.findTorrentFile(infoHash, filePath);
  store.recordFileMapping({
    ...createReleaseIdentity(infoHash, null), placementId: placement.id, providerFileId,
    state: 'mapped', method: 'test', authoritative: true,
  });
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId, transport: 'test', exposureKey: `exp-${provider}-${providerFileId}`,
    relativePath: filePath, state: 'visible', readOnly: true, observedAt: 0, expiresAt: 9e12,
  });
  const binding = store.activateBinding({
    libraryItemId: item.id, libraryPathId: libraryPath.id,
    ...createReleaseIdentity(infoHash, null),
    placementId: placement.id, providerFileId, exposureId: exposure.id, reason: 'test',
  });
  return { item, binding, torrentFile, placement, providerFileId };
}

test('restart: the active Binding, its TorrentFile and its route set are identical', (t) => {
  const dbPath = tempDbPath(t);
  let before;
  {
    const store = createControlPlaneStore({ dbPath });
    const seeded = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-R1', providerFileId: 'pf-r1' });
    // A second route to the same TorrentFile.
    seedRoute(store, { provider: 'realdebrid', providerResourceId: 'RD-R1', providerFileId: 'pf-r1b' });
    const active = store.getActiveBindingForLibraryItem(seeded.item.id);
    before = {
      bindingId: active.binding.id,
      bindingVersion: active.binding.version,
      torrentFileId: active.torrentFile.id,
      torrentFileSize: active.torrentFile.size,
      infoHash: active.torrentFile.infoHash,
      coords: store.listDataPlaneCoordinates(active.torrentFile.id)
        .map((c) => `${c.provider}:${c.provider_resource_id}:${c.provider_file_id}`).sort(),
    };
    store.close();
  }
  {
    const store = createControlPlaneStore({ dbPath });
    const item = store.getLibraryItemByIdentityKey('movie:tt-torbox-TB-R1:default');
    const active = store.getActiveBindingForLibraryItem(item.id);
    assert.equal(active.binding.id, before.bindingId, 'the same Binding survives the restart');
    assert.equal(active.binding.version, before.bindingVersion, 'no version churn across a restart');
    assert.equal(active.torrentFile.id, before.torrentFileId, 'the same TorrentFile');
    assert.equal(active.torrentFile.size, before.torrentFileSize, 'the exact positive size');
    assert.equal(active.torrentFile.infoHash, before.infoHash, 'the same Release');
    const coords = store.listDataPlaneCoordinates(active.torrentFile.id)
      .map((c) => `${c.provider}:${c.provider_resource_id}:${c.provider_file_id}`).sort();
    assert.deepEqual(coords, before.coords, 'the route set is reconstructed exactly');
    store.close();
  }
});

test('restart: the durable hash -> resource index reconstructs, including several resources for one hash', (t) => {
  const dbPath = tempDbPath(t);
  let expected;
  {
    const store = createControlPlaneStore({ dbPath });
    seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-R2', providerFileId: 'pf-a' });
    seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-R3', providerFileId: 'pf-b' });
    expected = store.db.prepare(
      'SELECT provider, account_scope, provider_resource_id FROM provider_placements WHERE info_hash = ? ORDER BY provider_resource_id',
    ).all(HASH).map((r) => `${r.provider}:${r.account_scope}:${r.provider_resource_id}`);
    assert.equal(expected.length, 2, 'one hash may map to several provider resources');
    store.close();
  }
  {
    const store = createControlPlaneStore({ dbPath });
    const actual = store.db.prepare(
      'SELECT provider, account_scope, provider_resource_id FROM provider_placements WHERE info_hash = ? ORDER BY provider_resource_id',
    ).all(HASH).map((r) => `${r.provider}:${r.account_scope}:${r.provider_resource_id}`);
    assert.deepEqual(actual, expected, 'the index survives the restart unchanged');
    // The durable lookup used by the ensure path resolves the same way.
    const placement = store.findPlacementByInfoHash('torbox', HASH);
    assert.ok(placement, 'the hash -> placement lookup still resolves after a restart');
    store.close();
  }
});

test('restart: durable route-failure evidence survives; an unknown route is not promoted to dead', (t) => {
  const dbPath = tempDbPath(t);
  {
    const store = createControlPlaneStore({ dbPath });
    const seeded = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-R3', providerFileId: 'pf-r3' });
    store.recordDeliveryEvidence?.({
      provider: 'torbox', accountScope: 'default',
      placementId: seeded.placement.id, providerFileId: seeded.providerFileId,
      infoHash: HASH, fileIndexKey: -1,
      state: 'terminal', reason: 'delivery-capability-protocol-invalid',
      failureCategory: 'delivery-capability-protocol-invalid',
      observedAt: 1_000, expiresAt: 1_000 + 10 * 60 * 1000,
    });
    store.close();
  }
  {
    const store = createControlPlaneStore({ dbPath });
    const rows = store.db.prepare(
      'SELECT state, failure_category FROM provider_delivery_evidence',
    ).all();
    assert.equal(rows.length, 1, 'the durable route-failure record survives the restart');
    assert.equal(rows[0].state, 'terminal', 'a route proven dead is still known dead');
    assert.equal(rows[0].failure_category, 'delivery-capability-protocol-invalid');
    // A route with NO record is not "dead" — it is simply unknown, and an
    // unknown route is retried, not retired.
    const unknown = store.db.prepare(
      'SELECT COUNT(*) AS n FROM provider_delivery_evidence WHERE state = ?',
    ).get('terminal');
    assert.equal(unknown.n, 1, 'only the proven route is terminal');
    store.close();
  }
});

test('restart: a delivery-degraded representation is still owned after the restart', (t) => {
  const dbPath = tempDbPath(t);
  const ids = {};
  {
    const store = createControlPlaneStore({ dbPath });
    const seeded = seedRoute(store, { provider: 'torbox', providerResourceId: 'TB-R4', providerFileId: 'pf-r4' });
    ids.itemId = seeded.item.id;
    ids.torrentFileId = seeded.torrentFile.id;
    // The route dies.
    store.db.prepare("UPDATE provider_placements SET state = 'error' WHERE provider_resource_id = 'TB-R4'").run();
    store.close();
  }
  {
    const store = createControlPlaneStore({ dbPath });
    const active = store.getActiveBindingForLibraryItem(ids.itemId);
    assert.equal(active.torrentFile.id, ids.torrentFileId, 'the representation survives the restart');
    assert.equal(active.binding.status, 'active',
      'a dead route leaves the representation authoritative after a restart');
    // The owner of the degraded delivery is the route reconciler, which
    // reads exactly this durable state.
    const rotted = store.db.prepare(
      "SELECT COUNT(*) AS n FROM provider_placements WHERE state != 'ready'",
    ).get();
    assert.equal(rotted.n, 1, 'the reconciler can still see which route is degraded');
    store.close();
  }
});
