/**
 * Fulfillment → binding write proof (Slice 2.10 / Worker B).
 *
 * Proves that the production cold-start path persists the durable control-plane
 * state required by the durability scheduler:
 *
 *   1. handoff.torrentFileIdentity.placementId / providerFileId are present
 *      (selection-step invariant)
 *   2. materializeVfsEntry() runs the same way it does in production
 *      (allowLegacy=false, real controlPlaneStore)
 *   3. After VFS materialization, the control plane MUST contain:
 *        - library_items row keyed by (mediaType, mediaId, season, episode)
 *        - library_paths row with stable canonical path
 *        - bindings row with status='active', release_key, infoHash,
 *          fileIndex, placementId, providerFileId, exposureId
 *        - 1 row each (cold invariant: no duplicates)
 *   4. Re-running the same fulfillment is idempotent:
 *        - library_items count = 1
 *        - bindings count = 1 (no new version)
 *        - the active binding is unchanged
 *
 * This test is the RED-side proof of the missing binding-write seam. Before
 * the production fix, steps 3+4 fail because media-request.js writes the VFS
 * row but never invokes the control-plane store. After the fix (in
 * materializeVfsEntry or its caller in api/media-request.js), the same call
 * must produce a durable binding.
 *
 * The fix is intentionally not imported here: this test is the contract.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const INFO_HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const MEDIA_ID = 'tt7366338';
const CANONICAL_PATH = 'TV/Chernobyl/Season 01/Chernobyl - S01E01.mkv';
const TORRENT_FILE_ID = 'tf_fulfillment_proof_01';
const PROVIDER_FILE_ID = 'pf_fulfillment_proof_01';

function seedAuthoritativeFulfillmentFixture(store) {
  // TorrentFile is the durable physical identity.
  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(TORRENT_FILE_ID, INFO_HASH, 'Chernobyl.S01.2019/Episode01.mkv', 25_000_000_000, 1_000);

  // Provider placement (TorBox cached-only).
  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: INFO_HASH,
    providerResourceId: 'tb-resource-1',
    state: 'ready',
    ownership: 'owned',
    ownerKey: `library_item_for_${MEDIA_ID}_S1E1`,
    provenance: 'fulfillment-binding-write-proof',
    observedAt: 1_000,
    expiresAt: 1_000 + 5 * 60_000,
  });
  // recordPlacement returns an auto-generated id; use it for downstream
  // inventory/file-mapping writes so the test reflects the production seam.
  const actualPlacementId = placement.id;

  store.replaceProviderFileInventory(actualPlacementId, [{
    providerFileId: PROVIDER_FILE_ID,
    path: 'Chernobyl.S01.2019/Episode01.mkv',
    name: 'Episode01.mkv',
    size: 25_000_000_000,
    selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000, expiresAt: 1_000 + 5 * 60_000 });

  store.recordFileMapping({
    infoHash: INFO_HASH,
    fileIndex: 0,
    releaseKey: `${INFO_HASH}:0`,
    placementId: actualPlacementId,
    providerFileId: PROVIDER_FILE_ID,
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    evidence: {},
    mappedAt: 1_000,
  });

  // Readiness observation: required by activateBinding() to prove
  // the provider is in a 'ready' state. Cold fixtures should look
  // like a successful TorBox mylist snapshot.
  store.recordReadinessObservation({
    placementId: actualPlacementId,
    state: 'ready',
    source: 'fulfillment-binding-write-proof',
    observedAt: 1_000,
    expiresAt: 1_000 + 5 * 60_000,
  });

  return { placementId: actualPlacementId };
}

function authoritativeHandoff(placementId) {
  return {
    mediaId: MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 1,
    releaseKey: `${INFO_HASH}:0`,
    infoHash: INFO_HASH,
    fileIndex: 0,
    filename: 'Chernobyl.S01.2019/Episode01.mkv',
    canonicalTitle: 'Chernobyl',
    torrentFileId: TORRENT_FILE_ID,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test-binding-write',
    selectedAt: 1_000,
    torrentFileIdentity: {
      status: 'tv-episode',
      torrentFileId: TORRENT_FILE_ID,
      placementId,
      providerFileId: PROVIDER_FILE_ID,
      size: 25_000_000_000,
      season: 1,
      episode: 1,
    },
  };
}

test('production-style fulfillment writes a durable control-plane binding (not just VFS)', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'fwd-proof-'));
  const discoveryPath = join(tmp, 'discovery.db');
  const controlPath = join(tmp, 'control-plane.db');
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const cache = createDiscoveryCache({ dbPath: discoveryPath });
  const store = createControlPlaneStore({ dbPath: controlPath, now: () => 1_000 });
  t.after(() => {
    cache.close();
    store.close();
  });

  const { placementId } = seedAuthoritativeFulfillmentFixture(store);

  // Production path: media-request.js calls materializeVfsEntry with
  // allowLegacy=false and the real controlPlaneStore.
  const vfsEntry = materializeVfsEntry(
    cache,
    authoritativeHandoff(placementId),
    store,
    () => 1_000,
    { allowLegacy: false },
  );
  assert.ok(vfsEntry, 'VFS materialization must return a row');
  assert.equal(vfsEntry.torrentFileId, TORRENT_FILE_ID);
  assert.equal(vfsEntry.canonicalPath, CANONICAL_PATH);

  // Cold invariant: the VFS row exists.
  const vfsRows = cache.db.prepare(
    'SELECT * FROM vfs_tv_entries WHERE media_id = ? AND season = ? AND episode = ?',
  ).all(MEDIA_ID, 1, 1);
  assert.equal(vfsRows.length, 1, 'exactly one durable vfs_tv_entries row');

  // ── Contract assertions (RED before the production fix) ──────────────
  // A successful VFS materialization in the production seam MUST
  // write a library_items + library_paths + bindings row, because
  // the durability scheduler (and the operational dashboard) read
  // those tables to determine what to enroll / inspect. Without
  // them, the orphan authoritative state is invisible to durability.

  const libItem = store.db.prepare(
    'SELECT * FROM library_items WHERE media_id = ? AND media_type = ? AND season = ? AND episode = ?',
  ).get(MEDIA_ID, 'episode', 1, 1);
  assert.ok(libItem, 'library_items row must exist for the fulfilled alias');
  assert.equal(libItem.desired_state, 'present');
  assert.equal(libItem.title, 'Chernobyl');

  const libPath = store.db.prepare(
    'SELECT * FROM library_paths WHERE library_item_id = ? AND active = 1',
  ).get(libItem.id);
  assert.ok(libPath, 'library_paths row must exist and be active');
  assert.equal(libPath.canonical_path, CANONICAL_PATH);

  const bindings = store.db.prepare(
    'SELECT * FROM bindings WHERE library_item_id = ?',
  ).all(libItem.id);
  assert.equal(bindings.length, 1, 'exactly one binding row (cold invariant)');
  const [binding] = bindings;
  assert.equal(binding.status, 'active');
  assert.equal(binding.info_hash, INFO_HASH);
  assert.equal(binding.file_index, 0);
  assert.equal(binding.placement_id, placementId);
  assert.equal(binding.provider_file_id, PROVIDER_FILE_ID);
  assert.ok(binding.exposure_id, 'binding must carry an exposure_id (read-only zurg-rclone)');
  assert.equal(binding.release_key, `${INFO_HASH}:0`);
  assert.ok(
    binding.reason === 'fulfillment-binding-write-proof'
      || binding.reason === 'vfs-tv-materialize',
    `binding reason must come from the production finalize call, got: ${binding.reason}`,
  );
});

test('replaying the same fulfillment is idempotent — no duplicate library_items, no new binding version', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'fwd-proof-'));
  const discoveryPath = join(tmp, 'discovery.db');
  const controlPath = join(tmp, 'control-plane.db');
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const cache = createDiscoveryCache({ dbPath: discoveryPath });
  const store = createControlPlaneStore({ dbPath: controlPath, now: () => 1_000 });
  t.after(() => {
    cache.close();
    store.close();
  });

  const { placementId } = seedAuthoritativeFulfillmentFixture(store);

  const handoff = authoritativeHandoff(placementId);
  const first = materializeVfsEntry(cache, handoff, store, () => 1_000, { allowLegacy: false });
  const second = materializeVfsEntry(cache, handoff, store, () => 1_500, { allowLegacy: false });

  assert.equal(first.torrentFileId, second.torrentFileId);
  assert.equal(first.canonicalPath, second.canonicalPath);

  const libItems = store.db.prepare(
    'SELECT * FROM library_items WHERE media_id = ? AND media_type = ? AND season = ? AND episode = ?',
  ).all(MEDIA_ID, 'episode', 1, 1);
  assert.equal(libItems.length, 1, 'replay must not create a second library_items row');

  const bindings = store.db.prepare(
    'SELECT * FROM bindings WHERE library_item_id = ?',
  ).all(libItems[0].id);
  assert.equal(bindings.length, 1, 'replay must not create a new binding version');
  assert.equal(bindings[0].status, 'active');
  assert.equal(bindings[0].version, 1, 'first binding is version 1; replay returns same row');
});
