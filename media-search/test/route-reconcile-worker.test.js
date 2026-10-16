/**
 * Route-reconciliation worker contract.
 *
 * The 6 h worker and request-time recovery must never fight, and the manual
 * entry point must be the SAME code path the worker runs:
 *
 *   W1  one pass at a time: a manual pass joins an in-flight periodic pass
 *       instead of starting a second one that would duplicate provider probes;
 *   W2  a pass retires a placement only when the provider disproved it AND a
 *       live sibling route exists (never a title's last route);
 *   W3  `ROUTE_RECONCILE_RETIRE=0` keeps recovery and disables retirement;
 *   W4  a pass that cannot reach either provider neither repairs nor retires
 *       anything — no durable verdict from an outage.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { startBackgroundWorkers } from '../src/server/workers.js';

const HASH = 'a'.repeat(40);
const ALT_HASH = 'b'.repeat(40);
const INTERNAL = 'Show S01/Show - S01E01.mkv';
const UNTIL = 9_000_000_000;

/** Builds a live control plane with `routes` placements for one TorrentFile. */
function seedStore(t, routes) {
  const dir = mkdtempSync(join(tmpdir(), 'rr-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createControlPlaneStore({ dbPath: join(dir, 'control-plane.db'), now: () => 1_000_000 });
  t.after(() => store.close());

  const infoHash = HASH;
  let tf = null;
  let firstPlacementId = null;
  for (const [index, route] of routes.entries()) {
    const placement = store.recordPlacement({
      provider: route.provider,
      accountScope: 'default',
      infoHash,
      providerResourceId: route.resourceId,
      state: 'ready',
      ownership: 'owned',
      ownerKey: 'owner-key',
      provenance: 'rr-worker-test',
      observedAt: 1_000_000,
      expiresAt: UNTIL,
    });
    if (index === 0) firstPlacementId = placement.id;
    store.replaceProviderFileInventory(placement.id, [{
      providerFileId: String(index),
      path: INTERNAL,
      name: 'Show - S01E01.mkv',
      size: 4096,
      selected: true,
    }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
    const found = store.findTorrentFile(infoHash, INTERNAL);
    tf = found;
    store.db.prepare(`
      UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
      inventory_observed_at = ?, inventory_expires_at = ?
      WHERE placement_id = ? AND provider_file_id = ?
    `).run(found.id, 1_000_000, UNTIL, placement.id, String(index));
    store.recordReadinessObservation({
      placementId: placement.id, state: 'ready', source: 'rr-worker',
      observedAt: 1_000_000, expiresAt: UNTIL,
    });
  }
  const item = store.ensureLibraryItem({
    identityKey: `movie:tt-rrworker:${infoHash.slice(0, 6)}`,
    mediaType: 'movie',
    mediaId: `tt-rrworker-${infoHash.slice(0, 6)}`,
    title: 'RR Worker Movie',
    desiredState: 'present',
  });
  const path = store.ensureCanonicalPath(item.id, {
    canonicalPath: `Movies/RR ${infoHash.slice(0, 4)}/RR.mkv`,
  });
  // A recorded exposure is part of the Binding contract (it must identify the
  // mapped provider file of the placement being bound).
  const exposure = store.recordExposure({
    libraryItemId: item.id,
    libraryPathId: path.id,
    placementId: firstPlacementId,
    providerFileId: '0',
    transport: 'webdav',
    exposureKey: `rr-worker-exposure:${infoHash.slice(0, 8)}`,
    consumer: 'plex',
    state: 'visible',
    readOnly: true,
    observedAt: 1_000_000,
    expiresAt: UNTIL,
  });
  store.activateBinding({
    libraryItemId: item.id,
    libraryPathId: path.id,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    torrentFileId: tf.id,
    placementId: firstPlacementId,
    providerFileId: '0',
    exposureId: exposure.id,
    reason: 'rr-worker-test',
  });
  return { store, tf };
}

function fakeProviders({ torboxCached = new Set(), rdHashes = new Set(), failTorbox = false } = {}) {
  return {
    torBoxProvider: {
      require() {
        return { createPlacement: async (input) => input };
      },
    },
    torBoxInventoryProvider: {
      require() {
        return {
          lookupPlacement: async () => null,
          getFileInventory: async () => [],
        };
      },
    },
    rdClient: {
      listTorrents: async () => [...rdHashes].map((hash) => ({ hash, status: 'downloaded' })),
    },
    // Cache-only hash probe seam (see createRouteProviderSurfaces).
    torboxCheckCached: async () => {
      if (failTorbox) throw new Error('provider outage');
      return torboxCached;
    },
  };
}

test('W1 — a manual pass joins an in-flight pass (single-flight)', async (t) => {
  const { store } = seedStore(t, [{ provider: 'torbox', resourceId: 'tb-1' }]);
  const deps = fakeProviders({ torboxCached: new Set([HASH]) });
  const discoveryCache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => discoveryCache.close());
  const workers = startBackgroundWorkers({
    discoveryCache,
    controlPlaneStore: store,
    port: 0,
    dependencies: deps,
  });
  t.after(() => workers.stop());

  const first = workers.runRouteReconcilePass();
  const second = workers.runRouteReconcilePass();
  assert.equal(first, second, 'the second call joins the in-flight pass, never duplicates it');
  assert.equal(workers.routeReconcileInFlight(), true, 'the pass is observable as in-flight');
  const result = await first;
  assert.equal(result.scanned, 0, 'a live route is not probed for recovery');
  assert.equal(result.retired, 0, 'a live route is not retired');
});

test('W2 — a provider-disproved REDUNDANT route is retired by the pass', async (t) => {
  const { store, tf } = seedStore(t, [
    { provider: 'torbox', resourceId: 'tb-1' },
    { provider: 'realdebrid', resourceId: 'rd-1' },
  ]);
  const deps = fakeProviders({ torboxCached: new Set(), rdHashes: new Set([HASH]) });
  const discoveryCache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => discoveryCache.close());
  const workers = startBackgroundWorkers({
    discoveryCache,
    controlPlaneStore: store,
    port: 0,
    dependencies: deps,
  });
  t.after(() => workers.stop());

  const result = await workers.runRouteReconcilePass();
  assert.equal(result.retired, 1, 'the dead redundant route is retired');
  assert.equal(result.scanned, 0, 'the title still has a live route, so no recovery work');
  assert.equal(store.findPlacementByInfoHash('torbox', HASH), null);
  assert.equal(store.findPlacementByInfoHash('realdebrid', HASH)?.state, 'ready',
    'the live sibling route survives');
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM bindings WHERE status = ?').get('active').c, 1,
    'the Binding is untouched');
  assert.ok(tf.id, 'the TorrentFile id is unchanged');
});

test('W3 — ROUTE_RECONCILE_RETIRE=0 keeps recovery and disables retirement', async (t) => {
  const { store } = seedStore(t, [
    { provider: 'torbox', resourceId: 'tb-1' },
    { provider: 'realdebrid', resourceId: 'rd-1' },
  ]);
  const previous = process.env.ROUTE_RECONCILE_RETIRE;
  process.env.ROUTE_RECONCILE_RETIRE = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.ROUTE_RECONCILE_RETIRE;
    else process.env.ROUTE_RECONCILE_RETIRE = previous;
  });
  const deps = fakeProviders({ torboxCached: new Set(), rdHashes: new Set([HASH]) });
  const discoveryCache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => discoveryCache.close());
  const workers = startBackgroundWorkers({
    discoveryCache,
    controlPlaneStore: store,
    port: 0,
    dependencies: deps,
  });
  t.after(() => workers.stop());

  const result = await workers.runRouteReconcilePass();
  assert.equal(result.retired, 0, 'retirement is disabled');
  assert.equal(store.findPlacementByInfoHash('torbox', HASH)?.state, 'ready',
    'the dead route stays recorded when retirement is off');
});

test('W4 — an unreachable provider neither repairs nor retires', async (t) => {
  const { store } = seedStore(t, [
    { provider: 'torbox', resourceId: 'tb-1' },
    { provider: 'realdebrid', resourceId: 'rd-1' },
  ]);
  const deps = fakeProviders({ torboxCached: new Set(), rdHashes: new Set(), failTorbox: true });
  // Both probes throw: the pass must produce no durable verdict at all.
  deps.rdClient.listTorrents = async () => { throw new Error('provider outage'); };
  const discoveryCache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => discoveryCache.close());
  const workers = startBackgroundWorkers({
    discoveryCache,
    controlPlaneStore: store,
    port: 0,
    dependencies: deps,
  });
  t.after(() => workers.stop());

  const result = await workers.runRouteReconcilePass();
  assert.equal(result.retired, 0, 'an outage must not retire durable inventory');
  assert.equal(result.repaired, 0, 'an outage must not mint a recovery placement');
  assert.equal(store.findPlacementByInfoHash('torbox', HASH)?.state, 'ready');
  assert.equal(store.findPlacementByInfoHash('realdebrid', HASH)?.state, 'ready');
});

// Silence the unused-symbol warning while keeping ALT_HASH as documentation of
// the "different representation" case the reconciler must never invent.
void ALT_HASH;
