#!/usr/bin/env node
/**
 * Background-durability-pass Benchmark V1.
 *
 * Measures the per-(provider, accountScope) snapshot-fetch call budget
 * for one scheduler pass with a deterministic batch of N due items in
 * the same scope. The background-durability executor contract is:
 *
 *   - exactly 1 snapshot fetch for N due items in the same scope
 *   - exactly 1 snapshot fetch for N due items split across 2 scopes
 *   - 0 side effects (no requestdl/inventory/create) for HEALTHY items
 *   - exactly 1 markPlacementRemoved per STALE_CONFIRMED item
 *
 * This script is intentionally a thin scenario; it inlines a counting
 * snapshot adapter and an in-memory control plane store so it can be
 * run in any sandbox (no live provider, no build, no deploy). It is
 * designed to surface regressions in the call budget for the
 * scheduling→execution seam named-repair wiring.
 *
 * Usage: node scripts/bench-background-durability-pass.mjs [batchSize] [staleCount]
 *   batchSize:   number of due items to enroll (default 5)
 *   staleCount:  number of those to mark stale upstream (default 0)
 *
 * Exits 0 on success, 1 on any call-budget violation.
 */
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDurabilityScheduler } from '../src/lib/control-plane/durability-scheduler.js';
import { createDurabilityRuntime } from '../src/lib/control-plane/durability-runtime.js';
import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';

const batchSize = Number(process.argv[2] ?? 5);
const staleCount = Number(process.argv[3] ?? 0);
const now = () => 1_000;

function hexHash(seed) {
  // 40-char lowercase hex; the first 6 chars are unique per seed so
  // providerResourceId and torrentFileId can be derived from them
  // without collisions for small batch sizes (< 2^20).
  const padded = seed.toString(16).padStart(8, '0');
  // Force the first 6 chars to encode the seed, so different seeds
  // produce visibly different prefixes.
  return (padded + '00000000000000000000000000000000000000').slice(0, 40);
}

function makeTorboxInventory({ snapshot }) {
  let calls = 0;
  return {
    provider: 'torbox',
    accountScope: 'default',
    capabilities: {
      [PROVIDER_CAPABILITIES.MYLIST_SNAPSHOT]: {
        async getMylistSnapshot() {
          calls += 1;
          return snapshot();
        },
      },
    },
    get callCount() { return calls; },
  };
}

function makeStore() {
  return createControlPlaneStore({ now });
}

function seedTorBoxPlacement(store, { infoHash, providerResourceId, torrentFileId, internalPath }) {
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default',
    infoHash, providerResourceId, state: 'ready',
    ownership: 'owned', ownerKey: 'vfs-bench', provenance: 'bench',
    observedAt: now(), expiresAt: now() + 5 * 60_000,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: 'pf-1', path: `/${internalPath}`,
    name: internalPath.split('/').at(-1), size: 1_000_000, selected: true,
  }], { authoritative: true, complete: true, observedAt: now(), expiresAt: now() + 5 * 60_000 });
  store.db.prepare(`
    INSERT OR IGNORE INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(torrentFileId, infoHash, internalPath, 1_000_000, now());
  store.recordFileMapping({
    infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`,
    placementId: placement.id, providerFileId: 'pf-1',
    state: 'mapped', method: 'provider-filename-exact', authoritative: true,
    evidence: {}, mappedAt: now(),
  });
  return placement;
}

function seedActiveBinding(store, { libraryItemId, placement }) {
  const path = store.ensureCanonicalPath(libraryItemId);
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId: 'pf-1',
    transport: 'zurg-rclone', exposureKey: `${placement.id}:pf-1`,
    relativePath: '/Release/movie.mkv', state: 'visible', readOnly: true,
    observedAt: 0, expiresAt: 9_999_999_999_999,
  });
  store.activateBinding({
    libraryItemId, libraryPathId: path.id,
    releaseKey: `${placement.infoHash}:0`, infoHash: placement.infoHash,
    fileIndex: 0, placementId: placement.id, providerFileId: 'pf-1',
    exposureId: exposure.id, reason: 'bench',
  });
}

const store = makeStore();
const sched = createDurabilityScheduler({ controlPlaneStore: store, mode: 'execute', now });
const inventory = makeTorboxInventory({
  snapshot: () => ({
    provider: 'torbox', accountScope: 'default', observedAt: now(),
    resources: items
      .filter((item) => !item.stale)
      .map((item) => ({ providerResourceId: `res-${item.hash.slice(0, 8)}`, infoHash: item.hash })),
  }),
});
const runtime = createDurabilityRuntime({
  controlPlaneStore: store, durabilityScheduler: sched,
  torboxInventoryProvider: inventory, now,
});

const items = [];
for (let i = 0; i < batchSize; i += 1) {
  const hash = hexHash(i + 1);
  const stale = i < staleCount;
  const li = store.ensureLibraryItem({
    mediaType: 'movie', mediaId: `tt:bench${i}`, title: `Bench ${i}`,
    year: 2020, desiredState: 'present',
  });
  const placement = seedTorBoxPlacement(store, {
    infoHash: hash,
    // Use 8 hex chars at the start of the resourceId so different seeds
    // produce visibly distinct provider resource ids (avoids the 6-char
    // collision for small seeds).
    providerResourceId: `res-${hash.slice(0, 8)}`,
    torrentFileId: `tf:bench${i}`,
    internalPath: `Release/bench${i}.mkv`,
  });
  seedActiveBinding(store, { libraryItemId: li.id, placement });
  sched.enrollNewlyFulfilled({
    libraryItemId: li.id, enrollmentKey: `binding:${li.id}:1`, observedAt: 0,
  });
  items.push({ libraryItemId: li.id, hash, stale });
}
store.db.prepare(`UPDATE durability_due_state SET next_due_at = 0`).run();

const before = inventory.callCount;
const { passSummary, perRow } = await runtime.runOnePass();
const after = inventory.callCount;
const snapshotFetches = after - before;

const expectedSnapshots = 1; // one scope
const expectedStaleMarks = staleCount;
const expectedHealthies = batchSize - staleCount;

const results = {
  batchSize,
  staleCount,
  snapshotFetches,
  expectedSnapshots,
  passSummary: {
    selected: passSummary.selected,
    succeeded: passSummary.succeeded,
    failed: passSummary.failed,
    skipped: passSummary.skipped,
  },
  perRowOutcomes: perRow.map((r) => r.outcome),
  callsPerDueItem: snapshotFetches / batchSize,
  markPlacementRemovedCount: store.db.prepare(
    `SELECT COUNT(*) AS n FROM provider_placements WHERE state = 'removed'`,
  ).get().n,
  lifecycleEventCount: store.db.prepare(
    `SELECT COUNT(*) AS n FROM repair_evidence WHERE failure_category = 'stale-placement-unrecoverable'`,
  ).get().n,
};

const violations = [];
if (snapshotFetches !== expectedSnapshots) {
  violations.push(`snapshotFetches: expected ${expectedSnapshots}, got ${snapshotFetches}`);
}
if (results.markPlacementRemovedCount !== expectedStaleMarks) {
  violations.push(`markPlacementRemovedCount: expected ${expectedStaleMarks}, got ${results.markPlacementRemovedCount}`);
}
if (results.lifecycleEventCount !== expectedStaleMarks) {
  violations.push(`lifecycleEventCount: expected ${expectedStaleMarks}, got ${results.lifecycleEventCount}`);
}
if (passSummary.succeeded !== expectedHealthies + expectedStaleMarks) {
  violations.push(`succeeded: expected ${expectedHealthies + expectedStaleMarks}, got ${passSummary.succeeded}`);
}

console.log(JSON.stringify({ results, violations }, null, 2));
store.close();
process.exit(violations.length === 0 ? 0 : 1);
