import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const UNTIL = 9_000_000_000;

function publishedStoreWithActiveBinding(t, { infoHash, mediaId = 'tt-rk', size = 4096, tfId = 'tf-a', releaseKey = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'vfs-rk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createControlPlaneStore({ dbPath: join(dir, 'cp.db'), now: () => 1_000_000 });
  t.after(() => store.close());

  const rk = releaseKey || `${infoHash}:torrent`;
  const path = 'Movies/RK/RK.mkv';
  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tfId, infoHash, path, size, 1_000_000);

  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash,
    providerResourceId: `res-${infoHash.slice(0, 6)}`, state: 'ready',
    ownership: 'owned', ownerKey: 'owner-key', provenance: 'rk-test',
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: '0', path, name: 'RK.mkv', size, selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
    inventory_observed_at = ?, inventory_expires_at = ?
    WHERE placement_id = ?
  `).run(tfId, 1_000_000, UNTIL, placement.id);

  const item = store.ensureLibraryItem({
    identityKey: `movie:${mediaId}:default`,
    mediaType: 'movie', mediaId, title: 'RK Movie', desiredState: 'present',
  });
  const canonicalPath = store.ensureCanonicalPath(item.id, { canonicalPath: `Movies/RK/RK.mkv` });
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId: '0',
    accountScope: 'default', mountScope: 'default', transport: 'zurg-rclone',
    exposureKey: `rk:${infoHash.slice(0, 8)}`,
    relativePath: canonicalPath.canonicalPath, state: 'visible', readOnly: true,
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: canonicalPath.id,
    releaseKey: rk, infoHash, fileIndex: null,
    torrentFileId: tfId, placementId: placement.id, providerFileId: '0',
    exposureId: exposure.id, reason: 'test-active-binding', observedAt: 1_000_000,
  });
  return { store, item, canonicalPath, placement, tfId, infoHash, releaseKey: rk };
}

function handoff({ mediaId = 'tt-rk', infoHash, torrentFileId, size = 4096, releaseKey = null }) {
  return {
    mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: releaseKey || `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    filename: 'RK.mkv',
    canonicalTitle: 'RK Movie',
    canonicalYear: 2026,
    torrentFileId,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test-new-release',
    selectedAt: 1_788_000_000_000,
    torrentFileIdentity: {
      status: 'exact-size',
      torrentFileId,
      placementId: null,
      providerFileId: null,
      size,
    },
  };
}

test('same release: VFS release key is normalized to the active Binding release key', async (t) => {
  const active = publishedStoreWithActiveBinding(t, { infoHash: HASH_A, tfId: 'tf-a', size: 4096 });
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const entry = await materializeVfsEntry(
    cache,
    handoff({ infoHash: HASH_A, torrentFileId: 'tf-a', size: 4096, releaseKey: `${HASH_A}:torrent` }),
    active.store,
    () => 1_788_000_000_000,
    { allowLegacy: false },
  );

  const binding = active.store.getActiveBindingForLibraryItem(active.item.id);
  assert.equal(entry.releaseKey, binding.binding.releaseKey, 'VFS releaseKey must equal Binding releaseKey');
  assert.equal(entry.infoHash, binding.binding.infoHash, 'VFS infoHash must equal Binding infoHash');
  assert.equal(entry.torrentFileId, binding.torrentFile.id, 'VFS TF must equal Binding TF');
  assert.equal(binding.binding.infoHash, binding.torrentFile.infoHash, 'Binding/TF infoHash must agree');
  const placement = active.store.db.prepare('SELECT info_hash FROM provider_placements WHERE id = ?').get(binding.binding.placementId);
  assert.equal(placement.info_hash, binding.binding.infoHash, 'ProviderPlacement hash must equal Binding hash');
  assert.ok(String(entry.releaseKey).startsWith(HASH_A), 'VFS releaseKey must retain release A hash');
});

test('different release: never project onto old Binding; new Binding/version created', async (t) => {
  const active = publishedStoreWithActiveBinding(t, { infoHash: HASH_A, tfId: 'tf-a', size: 4096 });
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const tfB = 'tf-b';
  active.store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tfB, HASH_B, 'Movies/RK/RKB.mkv', 8192, 1_000_000);
  const placementB = active.store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH_B,
    providerResourceId: 'res-b', state: 'ready',
    ownership: 'owned', ownerKey: 'owner-key', provenance: 'rk-test',
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  active.store.replaceProviderFileInventory(placementB.id, [{
    providerFileId: '0', path: 'Movies/RK/RKB.mkv', name: 'RKB.mkv', size: 8192, selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
  active.store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
    inventory_observed_at = ?, inventory_expires_at = ?
    WHERE placement_id = ?
  `).run(tfB, 1_000_000, UNTIL, placementB.id);

  const newHandoff = handoff({ infoHash: HASH_B, torrentFileId: tfB, size: 8192, releaseKey: `${HASH_B}:torrent` });
  const entry = await materializeVfsEntry(cache, newHandoff, active.store, () => 1_788_000_000_000, { allowLegacy: false });

  const binding = active.store.getActiveBindingForLibraryItem(active.item.id);
  assert.equal(binding.binding.infoHash, HASH_B, 'active Binding must be release B');
  assert.equal(binding.torrentFile.id, tfB, 'active Binding must point at TF B');
  assert.equal(binding.torrentFile.infoHash, HASH_B, 'Binding/TF infoHash must agree');
  assert.equal(entry.infoHash, HASH_B, 'VFS infoHash must be release B');
  assert.equal(entry.torrentFileId, tfB, 'VFS TF must be release B');
  assert.ok(String(entry.releaseKey).startsWith(HASH_B), 'VFS releaseKey must retain release B hash');
  const placement = active.store.db.prepare('SELECT info_hash FROM provider_placements WHERE id = ?').get(binding.binding.placementId);
  assert.equal(placement.info_hash, HASH_B, 'ProviderPlacement hash must equal Binding hash');
});
