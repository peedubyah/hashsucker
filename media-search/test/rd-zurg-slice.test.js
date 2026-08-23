import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseIdentity } from '../src/api/release-contract.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createRdZurgControlPlaneSlice } from '../src/lib/control-plane/rd-zurg-slice.js';
import { createZurgExposureProvider } from '../src/lib/providers/filesystem-exposure.js';
import { createRealDebridProvider } from '../src/lib/providers/realdebrid.js';
import { createZurgTorrentMetadataObserver } from '../src/lib/providers/zurg-metadata.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const RELEASE = createReleaseIdentity(HASH, 0);
const ACCOUNT = 'primary';
const INSTANCE = 'zurg-a';
const MOUNT = 'mount-a';

function movie() {
  return {
    mediaType: 'movie', mediaId: 'tt0133093', title: 'The Matrix', year: 1999,
  };
}

function stat({ size = 1000 } = {}) {
  return { isFile: () => true, isSymbolicLink: () => false, size };
}

function metadata(overrides = {}) {
  return JSON.stringify({
    Hash: HASH,
    State: 'ok_torrent',
    StateWhen: 100,
    SelectedFiles: {
      opaque: {
        File: { id: 'zurg-file-9', path: '/Release/movie.mkv', bytes: 1000, selected: 1 },
        Link: 'https://provider.invalid/unrestricted-secret',
        State: 'ok_file',
      },
    },
    DownloadedIDs: ['temporary-secret'],
    IDsToDelete: ['delete-secret'],
    ...overrides,
  });
}

function harness(options = {}) {
  let time = options.time ?? 10_000;
  let resourceId = options.resourceId ?? 'rd-resource-1';
  let providerFileId = options.providerFileId ?? 'rd-file-9';
  let placementResult = options.placementResult ?? 'present';
  let exposureState = options.exposureState ?? 'visible';
  let metadataBody = options.metadataBody ?? metadata();
  let metadataError = options.metadataError ?? null;
  const now = () => time;
  const store = createControlPlaneStore({ now });
  const gateway = {
    async lookupPlacement() {
      if (placementResult === 'missing') return null;
      return { providerResourceId: resourceId, state: 'pending' };
    },
    async observeReadiness() {
      return { state: 'ready' };
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
          selected: true,
          corpusFileIndex: 0,
        }],
      };
    },
  };
  const realDebrid = createRealDebridProvider({
    accountScope: options.accountScope ?? ACCOUNT,
    gateway,
    now,
    observationTtlMs: 5_000,
  });
  const zurgMetadata = createZurgTorrentMetadataObserver({
    accountScope: options.accountScope ?? ACCOUNT,
    instanceScope: options.instanceScope ?? INSTANCE,
    dataPath: '/zurg/data',
    readOnly: true,
    now,
    observationTtlMs: 5_000,
    lstatFn: async () => {
      if (metadataError) throw metadataError;
      return stat();
    },
    readFileFn: async () => metadataBody,
  });
  const exposure = createZurgExposureProvider({
    accountScope: options.accountScope ?? ACCOUNT,
    mountScope: options.mountScope ?? MOUNT,
    rootPath: '/mnt/rd',
    readOnly: true,
    now,
    exposureTtlMs: 5_000,
    lstatFn: async () => {
      if (exposureState === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return stat();
    },
  });
  const slice = createRdZurgControlPlaneSlice({ store, realDebrid, zurgMetadata, exposure });
  const item = store.ensureLibraryItem(movie());
  const libraryPath = store.ensureCanonicalPath(item.id);
  const scope = {
    accountScope: options.accountScope ?? ACCOUNT,
    instanceScope: options.instanceScope ?? INSTANCE,
    mountScope: options.mountScope ?? MOUNT,
  };

  return {
    store, slice, item, libraryPath, scope,
    now,
    setResourceId(value) { resourceId = value; },
    setProviderFileId(value) { providerFileId = value; },
    setPlacementResult(value) { placementResult = value; },
    setExposureState(value) { exposureState = value; },
    setMetadataBody(value) { metadataBody = value; },
    setMetadataError(value) { metadataError = value; },
    setTime(value) { time = value; },
  };
}

async function ingestReadyInventory(h, resourceId = 'rd-resource-1') {
  const pending = await h.slice.observePlacement(RELEASE);
  assert.equal(pending.providerResourceId, resourceId);
  const ready = await h.slice.observeReadiness(RELEASE, pending);
  await h.slice.observeInventory(ready);
  return ready;
}

async function mapAndExpose(h, resource, providerFileId = 'rd-file-9') {
  const mapping = h.slice.mapExactFile(RELEASE, resource, providerFileId, { now: h.now() });
  const exposure = await h.slice.observeExposure(
    RELEASE, resource, { providerFileId }, 'Release/movie.mkv',
  );
  return { mapping, exposure };
}

function project(h) {
  return h.slice.projectLifecycle(h.item.id, RELEASE, { ...h.scope, now: h.now() });
}

test('canonical identity stays stable across same-hash RD resource replacement', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  const before = await ingestReadyInventory(h);
  await mapAndExpose(h, before);

  h.setResourceId('rd-resource-replacement');
  h.setProviderFileId('rd-file-replacement');
  h.setTime(11_000);
  const after = await ingestReadyInventory(h, 'rd-resource-replacement');
  await mapAndExpose(h, after, 'rd-file-replacement');

  const state = h.slice.getState(h.item.id, RELEASE);
  assert.deepEqual(new Set(state.placements.map((placement) => placement.providerResourceId)), new Set([
    'rd-resource-1', 'rd-resource-replacement',
  ]));
  assert.deepEqual(new Set(state.mappings.map((mapping) => mapping.releaseKey)), new Set([RELEASE.releaseKey]));
  assert.equal(state.exposures.length, 2, 'same path keeps distinct immutable target observations');
  assert.equal(state.exposures[0].exposureKey, state.exposures[1].exposureKey);
  assert.notEqual(state.exposures[0].id, state.exposures[1].id);
  assert.equal(project(h).release.releaseKey, RELEASE.releaseKey);
});

test('metadata present remains representable while RD placement is absent', async (t) => {
  const h = harness({ placementResult: 'missing' });
  t.after(() => h.store.close());
  assert.equal(await h.slice.observePlacement(RELEASE, {
    observedAt: h.now(), expiresAt: h.now() + 5_000,
  }), null);
  await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');

  const facts = project(h).facts;
  assert.equal(facts.placement.state, 'missing');
  assert.equal(facts.readiness.state, 'unknown');
  assert.equal(facts.zurgMetadata.state, 'present');
  assert.equal(facts.zurgMetadata.zurgState, 'ok_torrent');
});

test('authoritative absent lookup replaces prior placement presence without deleting history', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  await h.slice.observePlacement(RELEASE);
  h.setPlacementResult('missing');
  h.setTime(11_000);
  await h.slice.observePlacement(RELEASE, { observedAt: 11_000, expiresAt: 16_000 });

  assert.equal(project(h).facts.placement.state, 'missing');
  assert.equal(h.slice.getState(h.item.id, RELEASE).placements.length, 1);
});

test('RD placement and readiness remain present while exact exposure is missing', async (t) => {
  const h = harness({ exposureState: 'missing' });
  t.after(() => h.store.close());
  const resource = await ingestReadyInventory(h);
  await mapAndExpose(h, resource);

  const facts = project(h).facts;
  assert.equal(facts.placement.state, 'present');
  assert.equal(facts.readiness.state, 'ready');
  assert.equal(facts.exposure.state, 'missing');
  assert.equal(facts.binding.state, 'unbound');
});

test('exact exposure can be present while Zurg metadata is missing', async (t) => {
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const h = harness({ metadataError: missing });
  t.after(() => h.store.close());
  const resource = await ingestReadyInventory(h);
  await mapAndExpose(h, resource);
  await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');

  const facts = project(h).facts;
  assert.equal(facts.exposure.state, 'visible');
  assert.equal(facts.zurgMetadata.state, 'missing');
});

test('Zurg broken and under-repair state does not erase existing placement', async (t) => {
  for (const zurgState of ['broken_torrent', 'under_repair_torrent']) {
    await t.test(zurgState, async () => {
      const h = harness({ metadataBody: metadata({ State: zurgState }) });
      try {
        await ingestReadyInventory(h);
        await h.slice.observeZurgMetadata(RELEASE, `${zurgState}.zurgtorrent`);
        const facts = project(h).facts;
        assert.equal(facts.placement.state, 'present');
        assert.equal(facts.readiness.state, 'ready');
        assert.equal(facts.zurgMetadata.zurgState, zurgState);
      } finally {
        h.store.close();
      }
    });
  }
});

test('exact mapping rejects a provider file that does not uniquely match canonical fileIndex', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  const resource = await ingestReadyInventory(h);
  h.store.replaceProviderFileInventory(resource.id, [
    { providerFileId: 'wrong', path: '/wrong.mkv', name: 'wrong.mkv', corpusFileIndex: 1 },
    { providerFileId: 'right', path: '/right.mkv', name: 'right.mkv', corpusFileIndex: 0 },
  ], { authoritative: true, complete: true, observedAt: h.now(), expiresAt: h.now() + 5_000 });

  assert.throws(
    () => h.slice.mapExactFile(RELEASE, resource, 'wrong', { now: h.now() }),
    /does not uniquely match canonical fileIndex/,
  );
  assert.equal(h.slice.mapExactFile(RELEASE, resource, 'right', { now: h.now() }).releaseKey, RELEASE.releaseKey);
});

test('exact mapping fails closed for duplicate and null canonical file indices', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  const resource = await ingestReadyInventory(h);
  h.store.replaceProviderFileInventory(resource.id, [
    { providerFileId: 'duplicate-a', path: '/a.mkv', name: 'a.mkv', corpusFileIndex: 0 },
    { providerFileId: 'duplicate-b', path: '/b.mkv', name: 'b.mkv', corpusFileIndex: 0 },
  ], { authoritative: true, complete: true, observedAt: h.now(), expiresAt: h.now() + 5_000 });
  assert.throws(
    () => h.slice.mapExactFile(RELEASE, resource, 'duplicate-a', { now: h.now() }),
    /provider-file-ambiguous/,
  );

  h.store.replaceProviderFileInventory(resource.id, [
    { providerFileId: 'torrent-file', path: '/movie.mkv', name: 'movie.mkv', corpusFileIndex: 0 },
  ], { authoritative: true, complete: true, observedAt: h.now(), expiresAt: h.now() + 5_000 });
  assert.throws(
    () => h.slice.mapExactFile(createReleaseIdentity(HASH, null), resource, 'torrent-file', { now: h.now() }),
    /does not uniquely match canonical fileIndex/,
  );
});

test('provider file-ID churn changes mapping evidence without changing release identity', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  const resource = await ingestReadyInventory(h);
  const before = h.slice.mapExactFile(RELEASE, resource, 'rd-file-9', { now: h.now() });

  h.setProviderFileId('rd-file-10');
  h.setTime(11_000);
  await h.slice.observeInventory(resource);
  const after = h.slice.mapExactFile(RELEASE, resource, 'rd-file-10', { now: h.now() });

  assert.equal(before.releaseKey, RELEASE.releaseKey);
  assert.equal(after.releaseKey, RELEASE.releaseKey);
  assert.equal(after.fileIndex, 0);
  assert.equal(after.providerFileId, 'rd-file-10');
  assert.equal(h.store.listProviderFiles(resource.id, { includeMissing: true })
    .find((file) => file.providerFileId === 'rd-file-9').present, false);
});

test('account, Zurg instance, and mount scopes stay isolated', async (t) => {
  const store = createControlPlaneStore({ now: () => 10_000 });
  t.after(() => store.close());
  const item = store.ensureLibraryItem(movie());
  store.ensureCanonicalPath(item.id);

  const primary = harness({ accountScope: 'primary', instanceScope: 'zurg-a', mountScope: 'mount-a' });
  const secondary = harness({ accountScope: 'secondary', instanceScope: 'zurg-b', mountScope: 'mount-b' });
  t.after(() => primary.store.close());
  t.after(() => secondary.store.close());

  // Recreate coordinators over one shared store so scope filtering is exercised.
  const primarySlice = createRdZurgControlPlaneSlice({
    store,
    realDebrid: createRealDebridProvider({
      accountScope: 'primary', now: () => 10_000,
      gateway: {
        lookupPlacement: async () => ({ providerResourceId: 'rd-primary', state: 'ready' }),
        getFileInventory: async () => ({ authoritative: true, complete: true, files: [{
          providerFileId: 'file-primary', path: '/movie.mkv', name: 'movie.mkv', corpusFileIndex: 0,
        }] }),
      },
    }),
    zurgMetadata: createZurgTorrentMetadataObserver({
      accountScope: 'primary', instanceScope: 'zurg-a', dataPath: '/zurg/a', readOnly: true,
      now: () => 10_000, lstatFn: async () => stat(), readFileFn: async () => metadata(),
    }),
    exposure: createZurgExposureProvider({
      accountScope: 'primary', mountScope: 'mount-a', rootPath: '/mnt/a', readOnly: true,
      now: () => 10_000, lstatFn: async () => stat(),
    }),
  });
  const secondarySlice = createRdZurgControlPlaneSlice({
    store,
    realDebrid: createRealDebridProvider({
      accountScope: 'secondary', now: () => 10_000,
      gateway: {
        lookupPlacement: async () => ({ providerResourceId: 'rd-secondary', state: 'ready' }),
        getFileInventory: async () => ({ authoritative: true, complete: true, files: [{
          providerFileId: 'file-secondary', path: '/movie.mkv', name: 'movie.mkv', corpusFileIndex: 0,
        }] }),
      },
    }),
    zurgMetadata: createZurgTorrentMetadataObserver({
      accountScope: 'secondary', instanceScope: 'zurg-b', dataPath: '/zurg/b', readOnly: true,
      now: () => 10_000, lstatFn: async () => stat(), readFileFn: async () => metadata(),
    }),
    exposure: createZurgExposureProvider({
      accountScope: 'secondary', mountScope: 'mount-b', rootPath: '/mnt/b', readOnly: true,
      now: () => 10_000, lstatFn: async () => stat(),
    }),
  });

  const primaryResource = await primarySlice.observePlacement(RELEASE);
  await primarySlice.observeInventory(primaryResource);
  primarySlice.mapExactFile(RELEASE, primaryResource, 'file-primary', { now: 10_000 });
  await primarySlice.observeExposure(RELEASE, primaryResource, { providerFileId: 'file-primary' }, 'movie.mkv');
  await primarySlice.observeZurgMetadata(RELEASE, 'primary.zurgtorrent');

  const secondaryResource = await secondarySlice.observePlacement(RELEASE);
  await secondarySlice.observeInventory(secondaryResource);
  secondarySlice.mapExactFile(RELEASE, secondaryResource, 'file-secondary', { now: 10_000 });
  await secondarySlice.observeExposure(RELEASE, secondaryResource, { providerFileId: 'file-secondary' }, 'movie.mkv');
  await secondarySlice.observeZurgMetadata(RELEASE, 'secondary.zurgtorrent');

  const primaryState = primarySlice.projectLifecycle(item.id, RELEASE, {
    instanceScope: 'zurg-a', mountScope: 'mount-a',
  });
  assert.equal(primaryState.scope.accountScope, 'primary');
  assert.equal(primaryState.facts.zurgMetadata.instanceScope, 'zurg-a');
  assert.equal(primaryState.facts.exposure.mountScope, 'mount-a');
  assert.equal(primaryState.facts.inventory.fileCount, 1);
});

test('malformed and stale metadata cannot poison placement or exposure truth', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  const resource = await ingestReadyInventory(h);
  await mapAndExpose(h, resource);

  h.setMetadataBody('{');
  const malformed = await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');
  assert.equal(malformed.observationState, 'error');
  let facts = project(h).facts;
  assert.equal(facts.placement.state, 'present');
  assert.equal(facts.exposure.state, 'visible');
  assert.equal(facts.zurgMetadata.state, 'error');

  h.setTime(9_000);
  h.setMetadataError(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await h.slice.observeZurgMetadata(RELEASE, 'Release.zurgtorrent');
  facts = project(h).facts;
  assert.equal(facts.zurgMetadata.state, 'error', 'older metadata evidence cannot replace newer evidence');
  assert.equal(facts.placement.state, 'present');
  assert.equal(facts.exposure.state, 'visible');

  const serialized = JSON.stringify(h.slice.getState(h.item.id, RELEASE));
  assert.doesNotMatch(serialized, /unrestricted-secret|temporary-secret|delete-secret/);
});

test('exact mapped visible file can create a logical binding without implying catalog or playback', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  const resource = await ingestReadyInventory(h);
  const { exposure } = await mapAndExpose(h, resource);
  const binding = h.slice.activateBinding({
    libraryItemId: h.item.id,
    libraryPathId: h.libraryPath.id,
    release: RELEASE,
    resource,
    providerFileId: 'rd-file-9',
    exposureId: exposure.id,
    expectedBindingVersion: 0,
    reason: 'stage-6-logical-binding',
  });

  const facts = project(h).facts;
  assert.equal(binding.releaseKey, RELEASE.releaseKey);
  assert.equal(facts.binding.state, 'active');
  assert.equal(facts.cataloging.state, 'unknown');
  assert.equal(facts.cataloging.scope, 'library-item');
  assert.equal(facts.playback.state, 'unknown');
  assert.equal(facts.playback.scope, 'library-item');

  const wrongMount = h.slice.projectLifecycle(h.item.id, RELEASE, {
    accountScope: ACCOUNT, instanceScope: INSTANCE, mountScope: 'other-mount', now: h.now(),
  });
  assert.equal(wrongMount.facts.binding.state, 'unbound');
});

test('same-path RD replacement cannot silently retarget an active binding', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  const original = await ingestReadyInventory(h);
  const { exposure: originalExposure } = await mapAndExpose(h, original);
  h.slice.activateBinding({
    libraryItemId: h.item.id,
    libraryPathId: h.libraryPath.id,
    release: RELEASE,
    resource: original,
    providerFileId: 'rd-file-9',
    exposureId: originalExposure.id,
    expectedBindingVersion: 0,
    reason: 'initial-target',
  });

  h.setResourceId('rd-resource-replacement');
  h.setProviderFileId('rd-file-replacement');
  h.setTime(11_000);
  const replacement = await ingestReadyInventory(h, 'rd-resource-replacement');
  await mapAndExpose(h, replacement, 'rd-file-replacement');

  const facts = project(h).facts;
  const active = h.store.listBindings(h.item.id).find((binding) => binding.status === 'active');
  assert.equal(active.placementId, original.id);
  assert.equal(active.exposureId, originalExposure.id);
  assert.equal(facts.binding.state, 'degraded');
  assert.equal(facts.binding.failureCategory, 'exposure-target-changed');
});

test('binding rejects stale or unbounded Stage 6 evidence', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  const resource = await ingestReadyInventory(h);
  const { exposure } = await mapAndExpose(h, resource);
  h.setTime(20_000);
  assert.throws(() => h.slice.activateBinding({
    libraryItemId: h.item.id,
    libraryPathId: h.libraryPath.id,
    release: RELEASE,
    resource,
    providerFileId: 'rd-file-9',
    exposureId: exposure.id,
    expectedBindingVersion: 0,
    reason: 'stale-evidence',
  }), /stale provider readiness observation/);
});

test('expired current evidence projects unknown instead of healthy', async (t) => {
  const h = harness();
  t.after(() => h.store.close());
  const resource = await ingestReadyInventory(h);
  await mapAndExpose(h, resource);
  h.setTime(20_000);

  const facts = project(h).facts;
  assert.equal(facts.placement.state, 'unknown');
  assert.equal(facts.placement.freshness, 'stale');
  assert.equal(facts.readiness.state, 'unknown');
  assert.equal(facts.inventory.state, 'unknown');
  assert.equal(facts.exposure.state, 'unknown');
});
