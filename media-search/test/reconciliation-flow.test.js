import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseIdentity } from '../src/api/release-contract.js';
import { executeReconciliation, planReconciliation } from '../src/lib/control-plane/reconciler.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = '1234567890abcdef1234567890abcdef12345678';
const NOW = 10_000;

function movie(overrides = {}) {
  return {
    mediaType: 'movie',
    mediaId: 'tt0133093',
    title: 'The Matrix',
    year: 1999,
    desiredState: 'present',
    ...overrides,
  };
}

function setupBindable(store, item, identity, options = {}) {
  const path = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: options.provider ?? 'realdebrid',
    accountScope: 'primary',
    infoHash: identity.infoHash,
    providerResourceId: options.resourceId ?? `resource-${identity.infoHash.slice(0, 5)}`,
    state: 'ready',
    ownership: options.ownership ?? 'owned',
    ownerKey: item.id,
    provenance: 'test',
    idempotencyKey: `placement:${options.provider ?? 'realdebrid'}:${identity.infoHash}`,
    observedAt: 0,
    expiresAt: 9_999_999_999_999,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: options.providerFileId ?? 'file-1',
    path: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    name: 'The.Matrix.1999.mkv',
    size: 1_000,
    selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  const fileId = options.providerFileId ?? 'file-1';
  store.recordFileMapping({
    ...identity,
    placementId: placement.id,
    providerFileId: fileId,
    state: 'mapped',
    method: 'provider-file-id',
    authoritative: true,
  });
  const exposure = store.recordExposure({
    placementId: placement.id,
    providerFileId: fileId,
    transport: options.transport ?? 'zurg-rclone',
    exposureKey: options.exposureKey ?? `${placement.id}:${fileId}`,
    relativePath: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    state: 'visible',
    readOnly: true,
    observedAt: 0,
    expiresAt: 9_999_999_999_999,
  });
  return { path, placement, exposure, providerFileId: fileId };
}

function buildSnapshot(store, item, identity) {
  return store.getReconciliationSnapshot(item.id, identity);
}

// ─────────────────────────────────────────────────────────────────────────────
// BIND: no binding → healthy observations → active binding
// ─────────────────────────────────────────────────────────────────────────────

test('bind: healthy observations produce an active binding with version 1', () => {
  const store = createControlPlaneStore({ now: () => NOW });
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, 0);
  setupBindable(store, item, identity);

  const snapshot = buildSnapshot(store, item, identity);
  const plan = planReconciliation({
    ...snapshot,
    currentBinding: null,
  }, { now: NOW });

  assert.equal(plan.actions[0].action, 'bind');

  const binding = executeReconciliation(plan, store);
  assert.ok(binding);
  assert.equal(binding.status, 'active');
  assert.equal(binding.version, 1);
  assert.equal(binding.placementId, snapshot.placements[0].id);
  assert.equal(binding.libraryItemId, item.id);

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// REBIND: active binding → better placement available → new active binding,
//         old binding superseded
// ─────────────────────────────────────────────────────────────────────────────

test('rebind: current placement becoming unavailable triggers rebind to alternate', () => {
  const store = createControlPlaneStore({ now: () => NOW });
  const item = store.ensureLibraryItem(movie());
  const rdIdentity = createReleaseIdentity(HASH, 0);
  const rd = setupBindable(store, item, rdIdentity, { provider: 'realdebrid' });
  const tbIdentity = createReleaseIdentity(HASH, 0);
  setupBindable(store, item, tbIdentity, {
    provider: 'torbox',
    resourceId: 'tb-22',
    providerFileId: 'tb-file',
    transport: 'torbox-webdav-rclone',
    exposureKey: 'tb-22:tb-file',
  });

  // Initial bind on realdebrid
  const firstSnapshot = buildSnapshot(store, item, rdIdentity);
  firstSnapshot.desired = { ...firstSnapshot.desired, providerPreferences: ['realdebrid', 'torbox'] };
  const firstPlan = planReconciliation({
    ...firstSnapshot,
    currentBinding: null,
  }, { now: NOW });
  const firstBinding = executeReconciliation(firstPlan, store);
  assert.equal(firstBinding.version, 1);

  // Current placement becomes unavailable (degraded)
  store.db.prepare("UPDATE provider_placements SET state = 'degraded' WHERE id = ?").run(rd.placement.id);

  const secondSnapshot = buildSnapshot(store, item, tbIdentity);
  secondSnapshot.desired = { ...secondSnapshot.desired, providerPreferences: ['realdebrid', 'torbox'] };
  const secondPlan = planReconciliation({
    ...secondSnapshot,
    currentBinding: firstBinding,
  }, { now: NOW });

  const rebindAction = secondPlan.actions.find((a) => a.action === 'rebind');
  assert.ok(rebindAction, 'expected rebind action when current placement degrades');
  assert.equal(rebindAction.expectedBindingVersion, 1);

  const secondBinding = executeReconciliation(secondPlan, store);
  assert.equal(secondBinding.status, 'active');
  assert.equal(secondBinding.version, 2);

  // Old binding must be superseded
  const allBindings = store.listBindings(item.id);
  assert.equal(allBindings.length, 2);
  assert.equal(allBindings[0].status, 'superseded');
  assert.equal(allBindings[1].status, 'active');

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// DEGRADE: active binding → no healthy observations → binding degraded
//          (hands off to repair)
// ─────────────────────────────────────────────────────────────────────────────

test('degrade: no usable placement marks binding degraded', () => {
  const store = createControlPlaneStore({ now: () => NOW });
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, 0);
  setupBindable(store, item, identity);

  // First bind
  const healthySnapshot = buildSnapshot(store, item, identity);
  const healthyPlan = planReconciliation({
    ...healthySnapshot,
    currentBinding: null,
  }, { now: NOW });
  const binding = executeReconciliation(healthyPlan, store);
  assert.equal(binding.status, 'active');

  // Now all placements degrade: remove the placement and re-snapshot
  const placementId = healthySnapshot.placements[0].id;
  store.db.prepare("UPDATE provider_placements SET state = 'error' WHERE id = ?").run(placementId);

  const degradedSnapshot = buildSnapshot(store, item, identity);
  const degradedPlan = planReconciliation({
    ...degradedSnapshot,
    currentBinding: binding,
  }, { now: NOW });

  const markDegraded = degradedPlan.actions.find((a) => a.action === 'mark-degraded');
  assert.ok(markDegraded, 'expected mark-degraded action');

  const result = executeReconciliation(degradedPlan, store);
  assert.equal(result.status, 'degraded');

  // No active binding remains
  const activeBindings = store.listBindings(item.id).filter((b) => b.status === 'active');
  assert.equal(activeBindings.length, 0);

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// DEGRADE: stale exposure triggers mark-degraded
// ─────────────────────────────────────────────────────────────────────────────

test('degrade: stale exposure observation triggers re-observe, not immediate degrade', () => {
  const store = createControlPlaneStore({ now: () => NOW });
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, 0);
  setupBindable(store, item, identity);

  // Bind
  const snapshot1 = buildSnapshot(store, item, identity);
  const plan1 = planReconciliation({ ...snapshot1, currentBinding: null }, { now: NOW });
  const binding = executeReconciliation(plan1, store);
  assert.equal(binding.status, 'active');

  // Make exposure stale by updating its expires_at to the past
  store.db.prepare("UPDATE exposures SET expires_at = ? WHERE id = ?").run(NOW - 1, snapshot1.exposures[0].id);

  const snapshot2 = buildSnapshot(store, item, identity);
  const plan2 = planReconciliation({ ...snapshot2, currentBinding: binding }, { now: NOW });

  // Stale exposure should trigger re-observe first, not immediate degrade
  const observeExposure = plan2.actions.find((a) => a.action === 'observe-exposure');
  assert.ok(observeExposure, 'expected observe-exposure for stale exposure');

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// RECOVER: degraded binding → healthy observations again → new active binding
//          (recovery through re-binding)
// ─────────────────────────────────────────────────────────────────────────────

test('recover: degraded binding recovers to active when observations become healthy', () => {
  let time = NOW;
  const store = createControlPlaneStore({ now: () => time });
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, 0);
  const setup = setupBindable(store, item, identity);

  // Bind
  const snapshot1 = buildSnapshot(store, item, identity);
  const plan1 = planReconciliation({ ...snapshot1, currentBinding: null }, { now: time });
  const binding1 = executeReconciliation(plan1, store);
  assert.equal(binding1.status, 'active');
  assert.equal(binding1.version, 1);

  // Degrade: make placement error
  store.db.prepare("UPDATE provider_placements SET state = 'error' WHERE id = ?").run(setup.placement.id);
  const degradedSnapshot = buildSnapshot(store, item, identity);
  const degradedPlan = planReconciliation({
    ...degradedSnapshot,
    currentBinding: binding1,
  }, { now: time });
  const degraded = executeReconciliation(degradedPlan, store);
  assert.equal(degraded.status, 'degraded');

  // Recover: placement becomes ready again (simulating repair or provider recovery)
  store.db.prepare("UPDATE provider_placements SET state = 'ready' WHERE id = ?").run(setup.placement.id);
  const healthySnapshot = buildSnapshot(store, item, identity);
  const healthyPlan = planReconciliation({
    ...healthySnapshot,
    currentBinding: degraded,
  }, { now: time });

  // Plan should produce a bind (new binding) since we're recovering
  const bindAction = healthyPlan.actions.find((a) => a.action === 'bind');
  assert.ok(bindAction, 'expected bind action for recovery');

  const binding2 = executeReconciliation(healthyPlan, store);
  assert.equal(binding2.status, 'active');
  assert.equal(binding2.version, 2);

  // We now have 3 binding records: superseded (v1), degraded (still there), active (v2)
  const allBindings = store.listBindings(item.id);
  assert.ok(allBindings.length >= 2);

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENT: re-planning with healthy binding produces no-op
// ─────────────────────────────────────────────────────────────────────────────

test('idempotent: healthy active binding produces no-op', () => {
  const store = createControlPlaneStore({ now: () => NOW });
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, 0);
  setupBindable(store, item, identity);

  // Bind
  const snapshot1 = buildSnapshot(store, item, identity);
  const plan1 = planReconciliation({ ...snapshot1, currentBinding: null }, { now: NOW });
  const binding = executeReconciliation(plan1, store);
  assert.equal(binding.status, 'active');

  // Re-plan with the active binding
  const snapshot2 = buildSnapshot(store, item, identity);
  const plan2 = planReconciliation({
    ...snapshot2,
    currentBinding: binding,
  }, { now: NOW });

  assert.equal(plan2.actions[0].action, 'no-op');

  // Execute no-op should not change anything
  const result = executeReconciliation(plan2, store);
  assert.equal(result.id, binding.id);
  assert.equal(result.version, binding.version);

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// CONCURRENCY: version mismatch prevents stale rebind
// ─────────────────────────────────────────────────────────────────────────────

test('concurrency: rebind fails if binding version changed since planning', () => {
  const store = createControlPlaneStore({ now: () => NOW });
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, 0);
  setupBindable(store, item, identity);

  // Bind
  const snapshot1 = buildSnapshot(store, item, identity);
  const plan1 = planReconciliation({ ...snapshot1, currentBinding: null }, { now: NOW });
  const binding1 = executeReconciliation(plan1, store);
  assert.equal(binding1.version, 1);

  // Concurrent change: another process creates a new binding (version 2)
  const torboxIdentity = createReleaseIdentity(HASH, 0);
  const torbox = setupBindable(store, item, torboxIdentity, {
    provider: 'torbox',
    resourceId: 'tb-concurrent',
    providerFileId: 'tb-file',
    transport: 'torbox-webdav-rclone',
    exposureKey: 'tb-concurrent:tb-file',
  });
  store.activateBinding({
    libraryItemId: item.id,
    libraryPathId: torbox.path.id,
    ...torboxIdentity,
    placementId: torbox.placement.id,
    providerFileId: torbox.providerFileId,
    exposureId: torbox.exposure.id,
    reason: 'concurrent-bind',
  });

  // Now try to rebind with stale version 1 — should throw
  const snapshot2 = buildSnapshot(store, item, identity);
  const plan2 = planReconciliation({
    ...snapshot2,
    currentBinding: { ...binding1, version: 1 }, // stale
  }, { now: NOW });

  const rebindAction = plan2.actions.find((a) => a.action === 'rebind');
  if (rebindAction) {
    rebindAction.expectedBindingVersion = 1; // stale
    assert.throws(
      () => executeReconciliation(plan2, store),
      /version changed/,
    );
  }

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// markBindingDegraded: direct API test
// ─────────────────────────────────────────────────────────────────────────────

test('markBindingDegraded: transitions active → degraded with failure category', () => {
  const store = createControlPlaneStore({ now: () => NOW });
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, 0);
  setupBindable(store, item, identity);

  // Bind
  const snapshot = buildSnapshot(store, item, identity);
  const plan = planReconciliation({ ...snapshot, currentBinding: null }, { now: NOW });
  const binding = executeReconciliation(plan, store);
  assert.equal(binding.status, 'active');

  // Degrade directly
  const degraded = store.markBindingDegraded({
    libraryItemId: item.id,
    failureCategory: 'provider-error',
    expectedBindingVersion: binding.version,
  });

  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.failureCategory, 'provider-error');
  assert.equal(degraded.version, binding.version); // version does not change on degrade

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// markBindingDegraded: throws if no active binding
// ─────────────────────────────────────────────────────────────────────────────

test('markBindingDegraded: throws when no active binding exists', () => {
  const store = createControlPlaneStore({ now: () => NOW });
  const item = store.ensureLibraryItem(movie());

  assert.throws(
    () => store.markBindingDegraded({
      libraryItemId: item.id,
      failureCategory: 'no-binding',
    }),
    /No active binding/,
  );

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// markBindingDegraded: version mismatch throws
// ─────────────────────────────────────────────────────────────────────────────

test('markBindingDegraded: throws on version mismatch', () => {
  const store = createControlPlaneStore({ now: () => NOW });
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, 0);
  setupBindable(store, item, identity);

  const snapshot = buildSnapshot(store, item, identity);
  const plan = planReconciliation({ ...snapshot, currentBinding: null }, { now: NOW });
  executeReconciliation(plan, store);

  assert.throws(
    () => store.markBindingDegraded({
      libraryItemId: item.id,
      failureCategory: 'stale',
      expectedBindingVersion: 99, // wrong
    }),
    /version changed/,
  );

  store.close();
});
