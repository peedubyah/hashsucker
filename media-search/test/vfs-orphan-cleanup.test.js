/**
 * Orphaned VFS projection cleanup after a failed Binding activation.
 *
 * Regression coverage for a production-observed defect: the cleanup added
 * in "fix: remove orphan VFS entries after binding failure" referenced a
 * `searchCache` parameter that tryActivateAuthoritativeBinding never
 * received, so every invocation threw a ReferenceError that the catch
 * swallowed ("[vfs] orphan VFS cleanup failed: searchCache is not
 * defined"). A series entry whose Binding activation failed therefore
 * stayed consumer-visible with no active Binding — exactly the state the
 * cleanup exists to prevent.
 *
 * Contract proven here:
 *   O1  When activateBinding fails for an episode-shaped handoff (the live
 *       failure mode is a stale/unbounded provider inventory
 *       observation), the exact TV VFS row is deleted, the durable
 *       TorrentFile/provider truth survives, and no binding is written.
 *   O2  The cleanup is gated on the binding being genuinely absent: when
 *       an active Binding exists for the library item, materialization
 *       replay keeps the row.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const INFO_HASH = 'a07b84404989fccee1d55c247cb03e22c8847ecc';
const MEDIA_ID = 'tt7137906';
const TORRENT_FILE_ID = 'tf_orphan_e01';
const INTERNAL_PATH = 'When They See Us S01 HDR WEB-DL 2160p/When They See Us S01E01 WEB-DL 2160p.mkv';

function buildStores(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'vfs-orphan-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const cache = createDiscoveryCache({ dbPath: join(tmp, 'discovery.db') });
  const store = createControlPlaneStore({ dbPath: join(tmp, 'control-plane.db'), now: () => 1_000 });
  t.after(() => {
    cache.close();
    store.close();
  });
  return { cache, store };
}

/**
 * Seed one durable episode: TorrentFile + placement + (optionally expired)
 * inventory snapshot + readiness. The expiry knob is what makes
 * activateBinding fail the way it fails in production.
 */
function seedEpisode(store, { inventoryExpired }) {
  const now = 1_000;
  const freshUntil = now + 6 * 60 * 60 * 1000;
  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(TORRENT_FILE_ID, INFO_HASH, INTERNAL_PATH, 7_952_732_164, now);

  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: INFO_HASH,
    providerResourceId: 'tb-resource-orphan',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'placement_orphan',
    provenance: 'vfs-orphan-cleanup',
    observedAt: now,
    expiresAt: freshUntil,
  });

  const inventoryExpiresAt = inventoryExpired ? now - 1 : freshUntil;
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: '0',
    path: INTERNAL_PATH,
    name: INTERNAL_PATH.split('/').pop(),
    size: 7_952_732_164,
    selected: true,
  }], {
    authoritative: true,
    complete: true,
    observedAt: now,
    expiresAt: inventoryExpiresAt,
  });
  store.db.prepare(`
    UPDATE provider_files
    SET torrent_file_id = ?, mapping_state = 'mapped', inventory_observed_at = ?, inventory_expires_at = ?
    WHERE placement_id = ? AND provider_file_id = '0'
  `).run(TORRENT_FILE_ID, now, inventoryExpiresAt, placement.id);

  store.recordReadinessObservation({
    placementId: placement.id,
    state: 'ready',
    source: 'vfs-orphan-cleanup',
    observedAt: now,
    expiresAt: freshUntil,
  });

  return { placementId: placement.id };
}

function episodeHandoff(placementId, mediaType) {
  return {
    mediaId: MEDIA_ID,
    mediaType,
    season: 1,
    episode: 1,
    releaseKey: `${INFO_HASH}:0`,
    infoHash: INFO_HASH,
    fileIndex: 0,
    filename: INTERNAL_PATH.split('/').pop(),
    torrentFileId: TORRENT_FILE_ID,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'vfs-orphan-cleanup',
    selectedAt: 1_000,
    torrentFileIdentity: {
      status: 'tv-episode',
      torrentFileId: TORRENT_FILE_ID,
      placementId,
      providerFileId: '0',
      size: 7_952_732_164,
      season: 1,
      episode: 1,
    },
  };
}

// Episode-shaped handoffs reach the materializer as 'series' (pipeline) or
// 'tv' (operator fan-out rows); the cleanup must cover both, not just the
// pipeline's 'series'. ('episode' handoffs are rejected by the TV
// materializer before any binding work.)
for (const mediaType of ['series', 'tv']) {
  test(`O1 — failed binding activation removes the orphaned TV row (mediaType=${mediaType})`, async (t) => {
    const { cache, store } = buildStores(t);
    const { placementId } = seedEpisode(store, { inventoryExpired: true });

    await materializeVfsEntry(
      cache,
      episodeHandoff(placementId, mediaType),
      store,
      () => 1_000,
      { allowLegacy: false },
    );

    // The VFS row was written by the same call whose binding activation then
    // failed; the cleanup must have removed it.
    assert.equal(cache.getVfsTvEntry(MEDIA_ID, 1, 1), null,
      'an episode row without an active Binding must not stay consumer-visible');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM bindings').get().c, 0,
      'a failed activation must not leave a binding behind');
    assert.ok(store.getTorrentFile(TORRENT_FILE_ID),
      'durable TorrentFile truth survives a failed binding activation');
  });
}

test('O2 — an existing active binding keeps the row on replay', async (t) => {
  const { cache, store } = buildStores(t);
  const { placementId } = seedEpisode(store, { inventoryExpired: false });

  const first = await materializeVfsEntry(
    cache,
    episodeHandoff(placementId, 'series'),
    store,
    () => 1_000,
    { allowLegacy: false },
  );
  assert.ok(first, 'fresh inventory must materialize an authoritative row');
  assert.ok(cache.getVfsTvEntry(MEDIA_ID, 1, 1), 'the materialized row must be present');

  // Replay is idempotent and must not delete the now-bound row.
  await materializeVfsEntry(
    cache,
    episodeHandoff(placementId, 'series'),
    store,
    () => 1_000,
    { allowLegacy: false },
  );
  assert.ok(cache.getVfsTvEntry(MEDIA_ID, 1, 1),
    'a bound row survives replay');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM bindings').get().c, 1,
    'replay must not create a second binding');
});
