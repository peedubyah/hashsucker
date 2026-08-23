import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseIdentity } from '../src/api/release-contract.js';
import { createRdZurgControlPlaneSlice } from '../src/lib/control-plane/rd-zurg-slice.js';
import { createRdZurgRepairExecutor } from '../src/lib/control-plane/repair-executor.js';
import { REPAIR_ACTIONS, planRdZurgRepair } from '../src/lib/control-plane/repair-planner.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createZurgExposureProvider } from '../src/lib/providers/filesystem-exposure.js';
import { createRealDebridProvider } from '../src/lib/providers/realdebrid.js';
import { createZurgTorrentMetadataObserver } from '../src/lib/providers/zurg-metadata.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const RELEASE = createReleaseIdentity(HASH, 0);
const SCOPE = { accountScope: 'primary', instanceScope: 'zurg-a', mountScope: 'mount-a' };

function metadata(state = 'ok_torrent') {
  return JSON.stringify({
    Hash: HASH,
    State: state,
    StateWhen: 100,
    SelectedFiles: {
      opaque: {
        File: { id: 'zurg-file', path: '/Release/movie.mkv', bytes: 1000, selected: 1 },
        State: 'ok_file',
      },
    },
  });
}

async function createHarness(t, options = {}) {
  let time = options.time ?? 10_000;
  let resourceId = options.resourceId ?? 'rd-resource-1';
  let providerFileId = options.providerFileId ?? 'rd-file-1';
  let placementMissing = false;
  let readinessState = 'ready';
  let selected = true;
  let exposureState = 'visible';
  let metadataState = 'ok_torrent';
  let selectFailure = null;
  const mutations = [];
  const now = () => time;
  const dbPath = options.dbPath ?? ':memory:';
  let store = createControlPlaneStore({ dbPath, now });

  const gateway = {
    async lookupPlacement() {
      if (placementMissing) return null;
      return { providerResourceId: resourceId, state: readinessState };
    },
    async observeReadiness() {
      return { state: readinessState };
    },
    async getFileInventory() {
      return {
        authoritative: true,
        complete: true,
        files: [{
          providerFileId,
          path: '/Release/movie.mkv',
          name: 'movie.mkv',
          size: 1000,
          selected,
          corpusFileIndex: 0,
        }],
      };
    },
    async selectKnownFiles(request) {
      mutations.push({ action: 'select', request });
      if (selectFailure) throw selectFailure;
      selected = true;
      return { accepted: true, idempotencyGuaranteed: true, operationId: 'selection-1' };
    },
    async requestRepair(request) {
      mutations.push({ action: 'repair', request });
      placementMissing = false;
      readinessState = 'ready';
      return { accepted: true, idempotencyGuaranteed: true, operationId: 'repair-1' };
    },
  };
  const realDebrid = createRealDebridProvider({
    accountScope: SCOPE.accountScope, gateway, now, observationTtlMs: 5_000,
  });
  const zurgMetadata = createZurgTorrentMetadataObserver({
    accountScope: SCOPE.accountScope,
    instanceScope: SCOPE.instanceScope,
    dataPath: '/zurg/data',
    readOnly: true,
    now,
    observationTtlMs: 5_000,
    lstatFn: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1000 }),
    readFileFn: async () => metadata(metadataState),
  });
  const exposure = createZurgExposureProvider({
    accountScope: SCOPE.accountScope,
    mountScope: SCOPE.mountScope,
    rootPath: '/mnt/rd',
    readOnly: true,
    now,
    exposureTtlMs: 5_000,
    lstatFn: async () => {
      if (exposureState === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true, isSymbolicLink: () => false, size: 1000 };
    },
  });

  function buildSlice() {
    const slice = createRdZurgControlPlaneSlice({ store, realDebrid, zurgMetadata, exposure });
    const executor = createRdZurgRepairExecutor({ store, slice, realDebrid });
    return { slice, executor };
  }
  let { slice, executor } = buildSlice();
  const item = store.ensureLibraryItem({
    mediaType: 'movie', mediaId: 'tt0133093', title: 'The Matrix', year: 1999,
  });
  const libraryPath = store.ensureCanonicalPath(item.id);

  async function observeAndBind() {
    const placement = await slice.observePlacement(RELEASE);
    await slice.observeReadiness(RELEASE, placement);
    await slice.observeInventory(placement);
    await slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');
    slice.mapExactFile(RELEASE, placement, providerFileId, { now: time });
    const exposureFact = await slice.observeExposure(
      RELEASE, placement, { providerFileId }, 'Release/movie.mkv',
    );
    const current = store.listBindings(item.id).find((binding) => binding.status === 'active');
    return slice.activateBinding({
      libraryItemId: item.id,
      libraryPathId: libraryPath.id,
      release: RELEASE,
      resource: placement,
      providerFileId,
      exposureId: exposureFact.id,
      expectedBindingVersion: current?.version ?? 0,
      reason: current ? 'test-reconcile' : 'test-initial-binding',
    });
  }

  function plan() {
    return planRdZurgRepair({
      snapshot: slice.getState(item.id, RELEASE),
      lifecycle: store.getLifecycle(item.id),
      scope: SCOPE,
      now: time,
    });
  }

  return {
    get store() { return store; }, get slice() { return slice; }, get executor() { return executor; },
    item, libraryPath, mutations, observeAndBind, plan,
    setTime(value) { time = value; },
    setResourceId(value) { resourceId = value; },
    setProviderFileId(value) { providerFileId = value; },
    setPlacementMissing(value) { placementMissing = value; },
    setReadinessState(value) { readinessState = value; },
    setSelected(value) { selected = value; },
    setExposureState(value) { exposureState = value; },
    setMetadataState(value) { metadataState = value; },
    setSelectFailure(value) { selectFailure = value; },
    close() { store.close(); },
  };
}

function authorize(h, plan, actions) {
  const transaction = h.executor.persistPlan(h.item.id, plan);
  return h.executor.authorize(transaction.id, { actions, authorizedBy: 'lifecycle-test' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: active binding becomes degraded
test('active binding becomes degraded when placement goes missing', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();
  assert.equal(initial.status, 'active');
  assert.equal(initial.version, 1);

  // Degrade the binding
  h.store.markBindingDegraded({
    libraryItemId: h.item.id,
    failureCategory: 'missing-provider-placement',
    expectedBindingVersion: initial.version,
  });

  const bindings = h.store.listBindings(h.item.id);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].status, 'degraded');
  assert.equal(bindings[0].failureCategory, 'missing-provider-placement');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: degraded binding creates repair transaction
test('degraded binding creates repair transaction', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();

  // Degrade
  h.store.markBindingDegraded({
    libraryItemId: h.item.id,
    failureCategory: 'missing-provider-placement',
    expectedBindingVersion: initial.version,
  });

  // Plan repair from degraded state
  h.setTime(11_000);
  h.setPlacementMissing(true);
  await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });
  const plan = h.plan();
  assert.equal(plan.status, 'repair-required');
  assert.equal(plan.binding.version, initial.version);

  // Create repair transaction
  const transaction = h.executor.persistPlan(h.item.id, plan);
  assert.equal(transaction.status, 'planned');
  assert.equal(transaction.expectedBindingVersion, initial.version);
  assert.equal(transaction.planKey, plan.planKey);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: repair transaction executes but postconditions fail without full repair
test('repair transaction executes authorized actions', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();

  // Degrade
  h.store.markBindingDegraded({
    libraryItemId: h.item.id,
    failureCategory: 'missing-provider-placement',
    expectedBindingVersion: initial.version,
  });

  // Plan
  h.setTime(11_000);
  h.setPlacementMissing(true);
  await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });
  const plan = h.plan();

  // Authorize and execute reobserve only (no reconcile)
  const repair = authorize(h, plan, [REPAIR_ACTIONS.REOBSERVE_PROVIDER]);
  assert.equal(repair.status, 'authorized');

  h.setTime(12_000);
  h.setPlacementMissing(false);
  // Postconditions fail because binding is still degraded (no reconcile)
  await assert.rejects(
    h.executor.execute(repair.id, { now: 12_000 }),
    /Repair postconditions not met/,
  );
  const failed = h.store.getRepairTransaction(repair.id);
  assert.equal(failed.status, 'failed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: successful repair creates new active binding
test('successful repair creates new active binding via reconcile', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();

  // Degrade
  h.store.markBindingDegraded({
    libraryItemId: h.item.id,
    failureCategory: 'missing-provider-placement',
    expectedBindingVersion: initial.version,
  });

  // Plan with full repair sequence
  h.setTime(11_000);
  h.setPlacementMissing(true);
  await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });
  const plan = h.plan();
  assert.ok(plan.permittedActions.includes(REPAIR_ACTIONS.RECONCILE_BINDING));

  // Authorize full repair
  h.setTime(12_000);
  h.setResourceId('rd-resource-2');
  h.setProviderFileId('rd-file-2');
  h.setPlacementMissing(false);
  const repair = authorize(h, plan, [
    REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR,
    REPAIR_ACTIONS.REOBSERVE_PROVIDER,
    REPAIR_ACTIONS.RECONCILE_BINDING,
  ]);
  await h.executor.execute(repair.id, { now: 12_000, relativePath: 'Release/movie.mkv' });

  // Verify new active binding
  const bindings = h.store.listBindings(h.item.id);
  const active = bindings.find((b) => b.status === 'active');
  assert.ok(active, 'should have an active binding');
  assert.equal(active.version, initial.version + 1);
  assert.equal(active.releaseKey, RELEASE.releaseKey);
  assert.equal(active.infoHash, RELEASE.infoHash);
  assert.equal(active.fileIndex, RELEASE.fileIndex);
  assert.notEqual(active.providerFileId, initial.providerFileId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: old binding becomes superseded after recovery
test('old binding becomes superseded after successful repair', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();

  // Degrade
  h.store.markBindingDegraded({
    libraryItemId: h.item.id,
    failureCategory: 'missing-provider-placement',
    expectedBindingVersion: initial.version,
  });

  // Repair with reconcile
  h.setTime(11_000);
  h.setPlacementMissing(true);
  await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });
  const plan = h.plan();

  h.setTime(12_000);
  h.setResourceId('rd-resource-2');
  h.setProviderFileId('rd-file-2');
  h.setPlacementMissing(false);
  const repair = authorize(h, plan, [
    REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR,
    REPAIR_ACTIONS.REOBSERVE_PROVIDER,
    REPAIR_ACTIONS.RECONCILE_BINDING,
  ]);
  await h.executor.execute(repair.id, { now: 12_000, relativePath: 'Release/movie.mkv' });

  // Verify old binding is superseded
  const bindings = h.store.listBindings(h.item.id);
  const oldBinding = bindings.find((b) => b.id === initial.id);
  assert.equal(oldBinding.status, 'superseded');
  assert.ok(oldBinding.supersededAt > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: failed repair leaves binding degraded
test('failed repair leaves binding degraded', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();

  // Degrade
  h.store.markBindingDegraded({
    libraryItemId: h.item.id,
    failureCategory: 'missing-provider-placement',
    expectedBindingVersion: initial.version,
  });

  // Plan
  h.setTime(11_000);
  h.setMetadataState('broken_torrent');
  await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');
  const plan = h.plan();
  assert.equal(plan.status, 'repair-required');

  // Authorize but don't fix the problem
  const repair = authorize(h, plan, [REPAIR_ACTIONS.REOBSERVE_ZURG_METADATA]);

  // Execute should fail because postconditions aren't met
  await assert.rejects(
    h.executor.execute(repair.id, { now: 11_000, metadataPath: 'Release.zurgtorrent' }),
    /Repair postconditions not met/,
  );

  // Verify binding is still degraded
  const bindings = h.store.listBindings(h.item.id);
  const current = bindings.find((b) => b.version === initial.version);
  assert.equal(current.status, 'degraded');

  // Verify transaction failed
  const failed = h.store.getRepairTransaction(repair.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCategory, 'repair-postcondition-failed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: stale repair version is rejected at authorization time
test('stale repair version is rejected', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();

  // Degrade
  h.store.markBindingDegraded({
    libraryItemId: h.item.id,
    failureCategory: 'missing-provider-placement',
    expectedBindingVersion: initial.version,
  });

  // Plan
  h.setTime(11_000);
  h.setPlacementMissing(true);
  await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });
  const plan = h.plan();

  // Create repair transaction with correct version
  const transaction = h.executor.persistPlan(h.item.id, plan);
  assert.equal(transaction.status, 'planned');

  // Simulate concurrent recovery: a new binding version 2 is created
  // This makes the repair's expected version (1) stale
  h.setPlacementMissing(false);
  const placement = await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });
  await h.slice.observeReadiness(RELEASE, placement);
  await h.slice.observeInventory(placement);
  await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');
  h.slice.mapExactFile(RELEASE, placement, 'rd-file-1', { now: 11_000 });
  const exposureFact = await h.slice.observeExposure(
    RELEASE, placement, { providerFileId: 'rd-file-1' }, 'Release/movie.mkv',
  );
  h.slice.activateBinding({
    libraryItemId: h.item.id,
    libraryPathId: h.libraryPath.id,
    release: RELEASE,
    resource: placement,
    providerFileId: 'rd-file-1',
    exposureId: exposureFact.id,
    expectedBindingVersion: 1,
    reason: 'concurrent-recovery',
  });

  // Authorization should fail because binding version changed (planKey mismatch)
  assert.throws(
    () => h.executor.authorize(transaction.id, {
      actions: [REPAIR_ACTIONS.REOBSERVE_PROVIDER],
      authorizedBy: 'stale-test',
    }),
    /Persisted repair plan does not match trusted control-plane evidence/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: concurrent reconciliation/repair loses via optimistic concurrency
test('concurrent repair loses via optimistic concurrency', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();

  // Degrade
  h.store.markBindingDegraded({
    libraryItemId: h.item.id,
    failureCategory: 'missing-provider-placement',
    expectedBindingVersion: initial.version,
  });

  // Plan
  h.setTime(11_000);
  h.setPlacementMissing(true);
  await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });
  const plan = h.plan();

  // Authorize repair
  h.setTime(12_000);
  h.setResourceId('rd-resource-2');
  h.setProviderFileId('rd-file-2');
  h.setPlacementMissing(false);
  const repair = authorize(h, plan, [
    REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR,
    REPAIR_ACTIONS.REOBSERVE_PROVIDER,
    REPAIR_ACTIONS.RECONCILE_BINDING,
  ]);

  // Simulate concurrent reconciliation that creates a new binding first
  // This makes the repair's expected version stale
  const placement = await h.slice.observePlacement(RELEASE);
  await h.slice.observeReadiness(RELEASE, placement);
  await h.slice.observeInventory(placement);
  await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');
  h.slice.mapExactFile(RELEASE, placement, 'rd-file-2', { now: 12_000 });
  const exposureFact = await h.slice.observeExposure(
    RELEASE, placement, { providerFileId: 'rd-file-2' }, 'Release/movie.mkv',
  );
  // This creates version 2, making repair's expected version (1) stale
  h.slice.activateBinding({
    libraryItemId: h.item.id,
    libraryPathId: h.libraryPath.id,
    release: RELEASE,
    resource: placement,
    providerFileId: 'rd-file-2',
    exposureId: exposureFact.id,
    expectedBindingVersion: 1,
    reason: 'concurrent-reconcile',
  });

  // Now repair execution should fail because binding version changed
  await assert.rejects(
    h.executor.execute(repair.id, { now: 12_000, relativePath: 'Release/movie.mkv' }),
    /Repair binding version is no longer current/,
  );
});
