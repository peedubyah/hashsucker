import assert from 'node:assert/strict';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  const directory = options.persisted ? await mkdtemp(path.join(tmpdir(), 'repair-cp-')) : null;
  if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = directory ? path.join(directory, 'control-plane.sqlite') : ':memory:';
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
    restart() {
      store.close();
      store = createControlPlaneStore({ dbPath, now });
      ({ slice, executor } = buildSlice());
    },
    close() { store.close(); },
  };
}

function authorize(h, plan, actions) {
  const transaction = h.executor.persistPlan(h.item.id, plan);
  return h.executor.authorize(transaction.id, { actions, authorizedBy: 'stage6-test' });
}

test('healthy to broken to repair planned to repaired preserves canonical identity', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();
  assert.equal(h.plan().status, 'healthy');

  h.setTime(11_000);
  h.setMetadataState('broken_torrent');
  await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');
  const plan = h.plan();
  assert.equal(plan.status, 'repair-required');
  assert.deepEqual(plan.triggers.map((entry) => entry.category), ['stale-zurg-metadata-state']);
  assert.deepEqual(plan.permittedActions, [REPAIR_ACTIONS.REOBSERVE_ZURG_METADATA]);
  assert.deepEqual(plan.actionSequence, [REPAIR_ACTIONS.REOBSERVE_ZURG_METADATA]);
  assert.equal(h.store.listBindings(h.item.id)[0].id, initial.id);

  h.setTime(12_000);
  h.setMetadataState('ok_torrent');
  const repair = authorize(h, plan, [REPAIR_ACTIONS.REOBSERVE_ZURG_METADATA]);
  const completed = await h.executor.execute(repair.id, {
    now: 12_000, metadataPath: 'Release.zurgtorrent', relativePath: 'Release/movie.mkv',
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(h.plan().status, 'healthy');
  assert.equal(h.store.listBindings(h.item.id)[0].id, initial.id);
});

test('provider resource replacement reconciles without changing canonical identity', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();
  h.setTime(11_000);
  h.setPlacementMissing(true);
  await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });
  const plan = h.plan();
  assert.equal(plan.status, 'repair-required');
  assert.ok(plan.permittedActions.includes(REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR));
  assert.ok(
    plan.actionSequence.indexOf(REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR)
      < plan.actionSequence.indexOf(REPAIR_ACTIONS.REOBSERVE_PROVIDER),
  );
  assert.ok(
    plan.actionSequence.indexOf(REPAIR_ACTIONS.REOBSERVE_PROVIDER)
      < plan.actionSequence.indexOf(REPAIR_ACTIONS.RECONCILE_BINDING),
  );

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

  const bindings = h.store.listBindings(h.item.id);
  const active = bindings.find((binding) => binding.status === 'active');
  assert.equal(bindings.length, 2);
  assert.equal(active.version, initial.version + 1);
  assert.equal(active.releaseKey, RELEASE.releaseKey);
  assert.equal(active.infoHash, RELEASE.infoHash);
  assert.equal(active.fileIndex, RELEASE.fileIndex);
  assert.notEqual(active.providerFileId, initial.providerFileId);
  assert.equal(h.plan().status, 'healthy');
});

test('partial repair reselects only the known bound file and preserves file identity', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();
  h.setTime(11_000);
  h.setSelected(false);
  const placement = h.slice.getState(h.item.id, RELEASE).placements[0];
  await h.slice.observeInventory(placement);
  const plan = h.plan();
  assert.ok(plan.triggers.some((entry) => entry.category === 'known-file-selection-lost'));
  const repair = authorize(h, plan, [
    REPAIR_ACTIONS.RESELECT_KNOWN_FILES,
    REPAIR_ACTIONS.REOBSERVE_PROVIDER,
  ]);
  await h.executor.execute(repair.id, { now: 11_000, relativePath: 'Release/movie.mkv' });

  assert.equal(h.mutations.length, 1);
  assert.deepEqual(h.mutations[0].request.providerFileIds, ['rd-file-1']);
  assert.equal(h.store.listBindings(h.item.id)[0].id, initial.id);
  assert.equal(h.plan().status, 'healthy');
});

test('failed repair preserves prior evidence and can resume without replaying successful steps', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  const initial = await h.observeAndBind();
  h.setTime(11_000);
  h.setSelected(false);
  const placement = h.slice.getState(h.item.id, RELEASE).placements[0];
  await h.slice.observeInventory(placement);
  const priorSnapshot = h.slice.getState(h.item.id, RELEASE);
  const plan = h.plan();
  const repair = authorize(h, plan, [
    REPAIR_ACTIONS.RESELECT_KNOWN_FILES,
    REPAIR_ACTIONS.REOBSERVE_PROVIDER,
  ]);
  const failure = Object.assign(new Error('provider unavailable'), { status: 503 });
  h.setSelectFailure(failure);
  await assert.rejects(
    h.executor.execute(repair.id, { now: 11_000, relativePath: 'Release/movie.mkv' }),
    /provider unavailable/,
  );

  const failed = h.store.getRepairTransaction(repair.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCategory, 'temporarily-unavailable');
  assert.deepEqual(h.slice.getState(h.item.id, RELEASE), priorSnapshot);
  assert.equal(h.store.listBindings(h.item.id)[0].id, initial.id);

  h.setSelectFailure(null);
  const completed = await h.executor.execute(repair.id, {
    resume: true, now: 11_000, relativePath: 'Release/movie.mkv',
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.steps.length, 3);
  assert.deepEqual(
    completed.steps.map((step) => [step.action, step.status]),
    [
      [REPAIR_ACTIONS.RESELECT_KNOWN_FILES, 'failed'],
      [REPAIR_ACTIONS.RESELECT_KNOWN_FILES, 'succeeded'],
      [REPAIR_ACTIONS.REOBSERVE_PROVIDER, 'succeeded'],
    ],
  );
});

test('repair transaction survives restart and resumes from durable state', async (t) => {
  const h = await createHarness(t, { persisted: true });
  t.after(() => h.close());
  await h.observeAndBind();
  h.setTime(11_000);
  h.setMetadataState('broken_torrent');
  await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');
  const plan = h.plan();
  const repair = authorize(h, plan, [REPAIR_ACTIONS.REOBSERVE_ZURG_METADATA]);

  h.restart();
  const restored = h.store.getRepairTransaction(repair.id);
  assert.equal(restored.status, 'authorized');
  assert.deepEqual(restored.plan.desiredIdentity, RELEASE);

  h.setTime(12_000);
  h.setMetadataState('ok_torrent');
  const completed = await h.executor.execute(restored.id, {
    now: 12_000, metadataPath: 'Release.zurgtorrent', relativePath: 'Release/movie.mkv',
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(h.plan().status, 'healthy');
});

test('missing mount exposure permits observation only and never provider deletion or repair', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  await h.observeAndBind();
  h.setTime(11_000);
  h.setExposureState('missing');
  const state = h.slice.getState(h.item.id, RELEASE);
  const placement = state.placements[0];
  await h.slice.observeExposure(
    RELEASE, placement, { providerFileId: 'rd-file-1' }, 'Release/movie.mkv',
  );
  const plan = h.plan();
  assert.deepEqual(plan.triggers.map((entry) => entry.category), ['missing-filesystem-exposure']);
  assert.deepEqual(plan.permittedActions, [REPAIR_ACTIONS.REOBSERVE_FILESYSTEM_EXPOSURE]);
  assert.equal(plan.permittedActions.includes(REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR), false);
});

test('authorization rejects reordered dependent provider repair actions', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  await h.observeAndBind();
  h.setTime(11_000);
  h.setPlacementMissing(true);
  await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });
  const plan = h.plan();
  const transaction = h.executor.persistPlan(h.item.id, plan);

  assert.throws(() => h.executor.authorize(transaction.id, {
    actions: [
      REPAIR_ACTIONS.RECONCILE_BINDING,
      REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR,
      REPAIR_ACTIONS.REOBSERVE_PROVIDER,
    ],
    authorizedBy: 'stage6-test',
  }), /preserve the plan action order/);
});

test('postcondition failure durably fails the transaction', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  await h.observeAndBind();
  h.setTime(11_000);
  h.setMetadataState('broken_torrent');
  await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');
  const plan = h.plan();
  const repair = authorize(h, plan, [REPAIR_ACTIONS.REOBSERVE_ZURG_METADATA]);

  await assert.rejects(
    h.executor.execute(repair.id, { now: 11_000, metadataPath: 'Release.zurgtorrent' }),
    /Repair postconditions not met/,
  );
  const failed = h.store.getRepairTransaction(repair.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCategory, 'repair-postcondition-failed');
  assert.equal(failed.steps[0].status, 'succeeded');
});

test('restart with a running mutation fails closed without replay', async (t) => {
  const h = await createHarness(t, { persisted: true });
  t.after(() => h.close());
  await h.observeAndBind();
  h.setTime(11_000);
  h.setSelected(false);
  const placement = h.slice.getState(h.item.id, RELEASE).placements[0];
  await h.slice.observeInventory(placement);
  const plan = h.plan();
  const repair = authorize(h, plan, [
    REPAIR_ACTIONS.RESELECT_KNOWN_FILES,
    REPAIR_ACTIONS.REOBSERVE_PROVIDER,
  ]);
  h.store.startRepairStep(repair.id, REPAIR_ACTIONS.RESELECT_KNOWN_FILES, {
    action: REPAIR_ACTIONS.RESELECT_KNOWN_FILES,
  });

  h.restart();
  await assert.rejects(
    h.executor.execute(repair.id, { now: 11_000 }),
    /ambiguous running operation requiring manual resolution/,
  );
  assert.equal(h.mutations.length, 0);
  assert.equal(h.store.getRepairTransaction(repair.id).status, 'executing');
});

test('repair failures persist only redacted typed metadata', async (t) => {
  const h = await createHarness(t);
  t.after(() => h.close());
  await h.observeAndBind();
  h.setTime(11_000);
  h.setSelected(false);
  const placement = h.slice.getState(h.item.id, RELEASE).placements[0];
  await h.slice.observeInventory(placement);
  const plan = h.plan();
  const repair = authorize(h, plan, [
    REPAIR_ACTIONS.RESELECT_KNOWN_FILES,
    REPAIR_ACTIONS.REOBSERVE_PROVIDER,
  ]);
  h.setSelectFailure(Object.assign(
    new Error('https://provider.invalid?token=secret-value'),
    { status: 503 },
  ));

  await assert.rejects(h.executor.execute(repair.id, { now: 11_000 }));
  const persisted = h.store.getRepairTransaction(repair.id);
  assert.equal(persisted.steps[0].failureCategory, 'temporarily-unavailable');
  assert.deepEqual(persisted.steps[0].result, { name: 'ProviderOperationError' });
  assert.equal(JSON.stringify(persisted).includes('secret-value'), false);
});
