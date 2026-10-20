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

function publishedStoreWithActiveBinding(t, { infoHash, mediaId = 'tt-regression', size = 4096, tfId = 'tf-a' }) {
  const dir = mkdtempSync(join(tmpdir(), 'vfs-projection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createControlPlaneStore({ dbPath: join(dir, 'cp.db'), now: () => 1_000_000 });
  t.after(() => store.close());

  const path = 'Movies/Regression/Reg.mkv';
  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tfId, infoHash, path, size, 1_000_000);

  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash,
    providerResourceId: `res-${infoHash.slice(0, 6)}`, state: 'ready',
    ownership: 'owned', ownerKey: 'owner-key', provenance: 'projection-regression-test',
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: '0', path, name: 'Reg.mkv', size, selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
    inventory_observed_at = ?, inventory_expires_at = ?
    WHERE placement_id = ?
  `).run(tfId, 1_000_000, UNTIL, placement.id);

  const item = store.ensureLibraryItem({
    identityKey: `movie:${mediaId}:default`,
    mediaType: 'movie', mediaId, title: 'Regression Movie', desiredState: 'present',
  });
  const canonicalPath = store.ensureCanonicalPath(item.id, { canonicalPath: `Movies/Regression/Reg.mkv` });
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId: '0',
    accountScope: 'default', mountScope: 'default', transport: 'zurg-rclone',
    exposureKey: `proj:${infoHash.slice(0, 8)}`,
    relativePath: canonicalPath.canonicalPath, state: 'visible', readOnly: true,
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: canonicalPath.id,
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    torrentFileId: tfId, placementId: placement.id, providerFileId: '0',
    exposureId: exposure.id, reason: 'test-active-binding', observedAt: 1_000_000,
  });
  return { store, item, canonicalPath, placement, tfId, infoHash };
}

function handoff({ mediaId = 'tt-regression', infoHash, torrentFileId, size = 4096, representationReason = null }) {
  return {
    mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    filename: 'Regression.mkv',
    canonicalTitle: 'Regression Movie',
    canonicalYear: 2026,
    torrentFileId,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test-new-release',
    // WHY this handoff may replace the intent's representation. A handoff
    // without a reason may not (the store refuses a representation change
    // that does not declare one).
    ...(representationReason ? { representationReason } : {}),
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

test('materializeVfsEntry does not project a new release onto a different active Binding', async (t) => {
  const active = publishedStoreWithActiveBinding(t, { infoHash: HASH_A, tfId: 'tf-a', size: 4096 });
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Release B is a genuinely different release with its own valid chain.
  const tfB = 'tf-b';
  active.store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tfB, HASH_B, 'Movies/Regression/RegB.mkv', 8192, 1_000_000);
  const placementB = active.store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH_B,
    providerResourceId: 'res-b', state: 'ready',
    ownership: 'owned', ownerKey: 'owner-key', provenance: 'projection-regression-test',
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  active.store.replaceProviderFileInventory(placementB.id, [{
    providerFileId: '0', path: 'Movies/Regression/RegB.mkv', name: 'RegB.mkv', size: 8192, selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
  active.store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
    inventory_observed_at = ?, inventory_expires_at = ?
    WHERE placement_id = ?
  `).run(tfB, 1_000_000, UNTIL, placementB.id);

  const newHandoff = handoff({
    infoHash: HASH_B, torrentFileId: tfB, size: 8192,
    // A different release is a representation decision: the upgrade
    // policy owns it and says so.
    representationReason: 'quality-upgrade',
  });
  const entry = await materializeVfsEntry(cache, newHandoff, active.store, () => 1_788_000_000_000, { allowLegacy: false });

  assert.equal(entry.torrentFileId, tfB, 'VFS row must point at the new TorrentFile');
  assert.equal(newHandoff.torrentFileId, tfB, 'handoff must remain the new release');
  assert.equal(newHandoff.infoHash, HASH_B, 'handoff must remain the new release');

  // A new Binding version must have been activated for B.
  const binding = active.store.getActiveBindingForLibraryItem(active.item.id);
  assert.ok(binding, 'an active Binding must exist');
  assert.equal(binding.binding.infoHash, HASH_B, 'active Binding must be Release B');
  assert.equal(binding.torrentFile.id, tfB, 'active Binding must point at TorrentFile B');
  assert.equal(binding.torrentFile.infoHash, HASH_B, 'Binding/TorrentFile infoHash must agree');
});

test('materializeVfsEntry may reuse an active Binding for the same release', async (t) => {
  const active = publishedStoreWithActiveBinding(t, { infoHash: HASH_A, tfId: 'tf-a', size: 4096 });
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const entry = await materializeVfsEntry(
    cache,
    handoff({ infoHash: HASH_A, torrentFileId: 'tf-a', size: 4096 }),
    active.store,
    () => 1_788_000_000_000,
    { allowLegacy: false },
  );

  assert.equal(entry.torrentFileId, 'tf-a');
  const binding = active.store.getActiveBindingForLibraryItem(active.item.id);
  assert.equal(binding.binding.infoHash, HASH_A);
});
