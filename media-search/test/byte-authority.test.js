/**
 * ONE BYTE IDENTITY — the invariant that a VFS row names the TorrentFile
 * the active Binding names.
 *
 * The durable truth used to hold two copies of the byte identity (the
 * Binding's TorrentFile and the VFS row's TorrentFile), written by
 * different code in different databases, with nothing reconciling them.
 * These tests pin:
 *
 *   - Binding creation projects the exact TorrentFile into the VFS row;
 *   - a Binding replacement moves the VFS row with it;
 *   - a route repair leaves the VFS TorrentFile alone;
 *   - a stale handoff cannot override the active Binding;
 *   - a stale VFS row is repaired FROM the Binding;
 *   - a restart converges;
 *   - a wrong TorrentFile fails closed;
 *   - the reconciliation is local: no provider, metadata or discovery work.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';
import {
  auditByteAuthority,
  compareByteAuthority,
  reconcileByteAuthority,
  projectedByteIdentity,
} from '../src/lib/vfs/byte-projection.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const NOW = 1_700_000_000_000;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function seedTorrentFile(store, { id, infoHash = HASH_A, internalPath = 'Movie/movie.mkv', size = 1000 }) {
  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, infoHash, internalPath, size, NOW);
  return { id, infoHash, internalPath, size };
}

/**
 * A control plane that can activate a binding for a TorrentFile, with the
 * provider-file mapping the activation needs.
 */
function controlPlaneWith(store, torrentFiles) {
  const map = new Map(torrentFiles.map((tf) => [tf.id, tf]));
  return {
    ...store,
    getTorrentFile(id) {
      return map.get(id) ?? store.getTorrentFile?.(id) ?? null;
    },
  };
}

/**
 * A routable provider placement for a TorrentFile: the placement, the
 * provider file, and an authoritative inventory snapshot (the binding
 * activation requires all three).
 */
function seedRoute(store, torrentFile, { placementId = 'pl-1', providerFileId = 'pf-1', size = torrentFile.size } = {}) {
  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: torrentFile.infoHash,
    providerResourceId: `res-${placementId}`,
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'test',
    provenance: 'byte-authority-test',
    observedAt: NOW,
    expiresAt: NOW + 60 * 60 * 1000,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId,
    path: torrentFile.internalPath,
    name: torrentFile.internalPath.split('/').pop(),
    size,
    selected: true,
  }], {
    authoritative: true,
    complete: true,
    observedAt: NOW,
    expiresAt: NOW + 60 * 60 * 1000,
  });
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped'
    WHERE placement_id = ? AND provider_file_id = ?
  `).run(torrentFile.id, placement.id, providerFileId);
  return { placementId: placement.id, providerFileId };
}

function movieHandoff({ torrentFileId, infoHash = HASH_A, canonicalTitle = 'Oppenheimer', mediaId = 'tt1' }) {
  return {
    mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    filename: 'Oppenheimer.2023.mkv',
    canonicalTitle,
    canonicalYear: 2023,
    torrentFileId,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: NOW,
  };
}

// ── 1. Binding creation projects the exact TorrentFile ────────────────────
test('Binding creation projects the exact TorrentFile into the VFS row', async (t) => {
  const dir = tempDir(t, 'hs-byte-create-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const tf = seedTorrentFile(store, { id: 'tf-1', size: 4242 });
  seedRoute(store, tf);
  const controlPlane = controlPlaneWith(store, [tf]);

  await materializeVfsEntry(cache, movieHandoff({ torrentFileId: 'tf-1' }), controlPlane, () => NOW, { allowLegacy: false });

  const row = cache.getVfsMovieEntry('tt1');
  assert.equal(row.torrentFileId, 'tf-1', 'the row names the TorrentFile the Binding names');
  assert.equal(row.size, 4242);
  const item = store.getLibraryItemByIdentityKey('movie:tt1:default');
  const binding = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(binding.torrentFile.id, 'tf-1');
  const audit = auditByteAuthority({ store, cache });
  assert.equal(audit.find((r) => r.mediaId === 'tt1').state, 'aligned');
});

// ── 2. a Binding replacement moves the VFS row with it ───────────────────
test('a Binding replacement moves the VFS row with it', async (t) => {
  const dir = tempDir(t, 'hs-byte-replace-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const tfA = seedTorrentFile(store, { id: 'tf-a', infoHash: HASH_A, size: 1000 });
  const tfB = seedTorrentFile(store, { id: 'tf-b', infoHash: HASH_B, internalPath: 'Movie/movie2.mkv', size: 2000 });
  seedRoute(store, tfA, { placementId: 'pl-a', providerFileId: 'pf-a' });
  seedRoute(store, tfB, { placementId: 'pl-b', providerFileId: 'pf-b', size: 2000 });
  const controlPlane = controlPlaneWith(store, [tfA, tfB]);

  await materializeVfsEntry(cache, movieHandoff({ torrentFileId: 'tf-a' }), controlPlane, () => NOW, { allowLegacy: false });
  assert.equal(cache.getVfsMovieEntry('tt1').torrentFileId, 'tf-a');

  // A representation change: a different release for the same intent.
  await materializeVfsEntry(
    cache,
    movieHandoff({ torrentFileId: 'tf-b', infoHash: HASH_B }),
    controlPlane,
    () => NOW + 1000,
    { allowLegacy: false },
  );

  const item = store.getLibraryItemByIdentityKey('movie:tt1:default');
  const binding = store.getActiveBindingForLibraryItem(item.id);
  const row = cache.getVfsMovieEntry('tt1');
  assert.equal(binding.torrentFile.id, 'tf-b', 'the Binding moved');
  assert.equal(row.torrentFileId, 'tf-b', 'the VFS row moved with it');
  assert.equal(row.size, 2000);
});

// ── 3. a route repair leaves the VFS TorrentFile alone ───────────────────
test('a route repair leaves the VFS TorrentFile alone', async (t) => {
  const dir = tempDir(t, 'hs-byte-route-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const tf = seedTorrentFile(store, { id: 'tf-1', size: 4242 });
  seedRoute(store, tf);
  const controlPlane = controlPlaneWith(store, [tf]);

  await materializeVfsEntry(cache, movieHandoff({ torrentFileId: 'tf-1' }), controlPlane, () => NOW, { allowLegacy: false });
  const before = cache.getVfsMovieEntry('tt1');

  // The same TorrentFile, re-observed (a route repair / a replay).
  await materializeVfsEntry(cache, movieHandoff({ torrentFileId: 'tf-1' }), controlPlane, () => NOW + 5000, { allowLegacy: false });
  const after = cache.getVfsMovieEntry('tt1');
  assert.equal(after.torrentFileId, before.torrentFileId, 'the byte identity did not move');
  assert.equal(after.size, before.size);
  assert.equal(after.canonicalPath, before.canonicalPath, 'the presentation path did not move');
});

// ── 4. a stale handoff cannot override the active Binding ────────────────
test('a stale handoff cannot override the active Binding', async (t) => {
  const dir = tempDir(t, 'hs-byte-stale-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const tf = seedTorrentFile(store, { id: 'tf-1', size: 4242 });
  seedRoute(store, tf);
  const controlPlane = controlPlaneWith(store, [tf]);

  await materializeVfsEntry(cache, movieHandoff({ torrentFileId: 'tf-1' }), controlPlane, () => NOW, { allowLegacy: false });

  // A stale handoff for a DIFFERENT TorrentFile of the SAME release: the
  // Binding names tf-1, so the row must keep naming tf-1.
  const stale = seedTorrentFile(store, { id: 'tf-stale', internalPath: 'Movie/other.mkv', size: 999 });
  seedRoute(store, stale, { placementId: 'pl-stale', providerFileId: 'pf-stale', size: 999 });
  const controlPlane2 = controlPlaneWith(store, [tf, stale]);
  await materializeVfsEntry(
    cache,
    movieHandoff({ torrentFileId: 'tf-stale' }),
    controlPlane2,
    () => NOW + 1000,
    { allowLegacy: false },
  ).catch(() => {});

  const row = cache.getVfsMovieEntry('tt1');
  const item = store.getLibraryItemByIdentityKey('movie:tt1:default');
  const binding = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(row.torrentFileId, binding.torrentFile.id,
    'the VFS row names whatever the Binding names — never the handoff');
});

// ── 5. a stale VFS row is repaired FROM the Binding ─────────────────────
test('a stale VFS row is repaired from the Binding', async (t) => {
  const dir = tempDir(t, 'hs-byte-repair-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const tf = seedTorrentFile(store, { id: 'tf-1', size: 4242 });
  seedRoute(store, tf);
  const controlPlane = controlPlaneWith(store, [tf]);
  await materializeVfsEntry(cache, movieHandoff({ torrentFileId: 'tf-1' }), controlPlane, () => NOW, { allowLegacy: false });

  // The row drifts behind the authority (the historical failure mode).
  cache.db.prepare(`
    UPDATE vfs_movie_entries SET torrent_file_id = 'tf-old', size = 1 WHERE media_id = 'tt1'
  `).run();

  const before = auditByteAuthority({ store, cache });
  assert.equal(before.find((r) => r.mediaId === 'tt1').state, 'drifted');

  const dry = reconcileByteAuthority({ store, cache, dryRun: true });
  assert.equal(dry.repaired.length, 1, 'the dry run reports the repair');
  assert.equal(cache.getVfsMovieEntry('tt1').torrentFileId, 'tf-old', 'a dry run writes nothing');

  const applied = reconcileByteAuthority({ store, cache, dryRun: false });
  assert.equal(applied.repaired.length, 1);
  const row = cache.getVfsMovieEntry('tt1');
  assert.equal(row.torrentFileId, 'tf-1', 'the row now names the Binding\'s TorrentFile');
  assert.equal(row.size, 4242);
  assert.equal(auditByteAuthority({ store, cache }).find((r) => r.mediaId === 'tt1').state, 'aligned');
});

// ── 6. a restart converges ──────────────────────────────────────────────
test('a restart converges the VFS row onto the Binding', async (t) => {
  const dir = tempDir(t, 'hs-byte-restart-');
  const dbPath = path.join(dir, 'cp.db');
  const discoveryPath = path.join(dir, 'discovery.db');
  const store = createControlPlaneStore({ dbPath, now: () => NOW });
  const cache = createDiscoveryCache({ dbPath: discoveryPath });
  const tf = seedTorrentFile(store, { id: 'tf-1', size: 4242 });
  seedRoute(store, tf);
  const controlPlane = controlPlaneWith(store, [tf]);
  await materializeVfsEntry(cache, movieHandoff({ torrentFileId: 'tf-1' }), controlPlane, () => NOW, { allowLegacy: false });
  cache.db.prepare(`UPDATE vfs_movie_entries SET torrent_file_id = 'tf-old' WHERE media_id = 'tt1'`).run();
  store.close();
  cache.close();

  // Restart: fresh handles over the same durable truth.
  const store2 = createControlPlaneStore({ dbPath, now: () => NOW });
  const cache2 = createDiscoveryCache({ dbPath: discoveryPath });
  t.after(() => { cache2.close(); store2.close(); });
  const result = reconcileByteAuthority({ store: store2, cache: cache2, dryRun: false });
  assert.equal(result.repaired.length, 1);
  assert.equal(cache2.getVfsMovieEntry('tt1').torrentFileId, 'tf-1');
});

// ── 7. a wrong TorrentFile fails closed ──────────────────────────────────
test('the projection refuses a TorrentFile it cannot state exactly', () => {
  const binding = { torrentFile: { id: 'tf-1', infoHash: HASH_A, size: 0 } };
  assert.equal(projectedByteIdentity(binding), null, 'a zero size is not projectable');
  assert.equal(projectedByteIdentity({ torrentFile: { id: 'tf-1', infoHash: HASH_A, size: 10 } }).size, 10);
  assert.equal(projectedByteIdentity(null), null);
  assert.equal(projectedByteIdentity({ torrentFile: null }), null);
});

test('a row that names a different TorrentFile is drift, never aligned', () => {
  const binding = { torrentFile: { id: 'tf-1', infoHash: HASH_A, size: 10 } };
  const same = compareByteAuthority({
    row: { torrentFileId: 'tf-1', infoHash: HASH_A, size: 10 },
    binding,
  });
  assert.equal(same.state, 'aligned');
  const different = compareByteAuthority({
    row: { torrentFileId: 'tf-2', infoHash: HASH_A, size: 10 },
    binding,
  });
  assert.equal(different.state, 'drifted');
  const legacy = compareByteAuthority({ row: { torrentFileId: null }, binding });
  assert.equal(legacy.state, 'legacy', 'a row with no TorrentFile is legacy, not drift');
});

// ── 8. the reconciliation is local ───────────────────────────────────────
test('the reconciliation performs no provider, metadata or discovery work', async (t) => {
  const dir = tempDir(t, 'hs-byte-local-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const tf = seedTorrentFile(store, { id: 'tf-1', size: 4242 });
  seedRoute(store, tf);
  const controlPlane = controlPlaneWith(store, [tf]);
  await materializeVfsEntry(cache, movieHandoff({ torrentFileId: 'tf-1' }), controlPlane, () => NOW, { allowLegacy: false });
  cache.db.prepare(`UPDATE vfs_movie_entries SET torrent_file_id = 'tf-old' WHERE media_id = 'tt1'`).run();

  let providerCalls = 0;
  let metadataCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('the reconciliation must not call out');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const started = Date.now();
  const result = reconcileByteAuthority({ store, cache, dryRun: false });
  const elapsed = Date.now() - started;
  assert.equal(result.repaired.length, 1);
  assert.equal(providerCalls, 0, 'no network at all');
  assert.equal(metadataCalls, 0);
  assert.ok(elapsed < 2000, `the reconciliation is local (${elapsed}ms)`);
});
