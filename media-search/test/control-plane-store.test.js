import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseIdentity } from '../src/api/release-contract.js';
import {
  addDeterministicCollisionSuffix,
  buildPreferredCanonicalPath,
  createLibraryIdentityKey,
} from '../src/lib/control-plane/canonical-path.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = '1234567890abcdef1234567890abcdef12345678';

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
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: options.providerFileId ?? 'file-1',
    path: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    name: 'The.Matrix.1999.mkv',
    size: 1_000,
    selected: true,
  }]);
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
  });
  return { path, placement, exposure, providerFileId: fileId };
}

test('canonical item and path identities are provider-independent and idempotent', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const first = store.ensureLibraryItem(movie());
  const path = store.ensureCanonicalPath(first.id);
  const repeated = store.ensureLibraryItem(movie({ title: 'The Matrix Updated' }));
  const repeatedPath = store.ensureCanonicalPath(first.id);

  assert.equal(first.id, repeated.id);
  assert.equal(first.identityKey, 'movie:tt0133093:default');
  assert.equal(path.canonicalPath, 'Movies/The Matrix (1999)/The Matrix (1999).mkv');
  assert.equal(repeatedPath.id, path.id);
  assert.equal(repeatedPath.canonicalPath, path.canonicalPath, 'metadata updates cannot churn canonical paths');
  assert.equal(path.canonicalPath.includes('realdebrid'), false);
  store.close();
});

test('episode paths are deterministic and custom paths reject parent traversal', () => {
  const expected = 'TV/Show Name (2024)/Season 02/Show Name - S02E03.mkv';
  assert.equal(buildPreferredCanonicalPath({
    mediaType: 'episode', mediaId: 'tt1:2:3', title: 'Show / Name', year: 2024,
    season: 2, episode: 3,
  }), expected);
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem({
    mediaType: 'episode', mediaId: 'tt1:1:1', title: 'Show', season: 1, episode: 1,
  });
  assert.throws(
    () => store.ensureCanonicalPath(item.id, { canonicalPath: '../escape.mkv' }),
    /parent segments/,
  );
  store.close();
});

test('same preferred basename receives a deterministic item-identity collision suffix', () => {
  const store = createControlPlaneStore();
  const first = store.ensureLibraryItem(movie({ mediaId: 'tt-first' }));
  const second = store.ensureLibraryItem(movie({ mediaId: 'tt-second' }));
  const firstPath = store.ensureCanonicalPath(first.id);
  const secondPath = store.ensureCanonicalPath(second.id);
  const expected = addDeterministicCollisionSuffix(
    firstPath.canonicalPath,
    createLibraryIdentityKey(movie({ mediaId: 'tt-second' })),
  );

  assert.equal(secondPath.preferredPath, firstPath.preferredPath);
  assert.equal(secondPath.canonicalPath, expected);
  assert.notEqual(secondPath.canonicalPath, firstPath.canonicalPath);
  store.close();
});

test('provider file IDs remain separate from corpus fileIndex in multi-file torrents', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  const placement = store.recordPlacement({
    provider: 'realdebrid', accountScope: 'primary', infoHash: HASH,
    providerResourceId: 'rd-17', state: 'ready', ownership: 'owned',
    ownerKey: item.id, provenance: 'test',
  });
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: '900', path: '/Disc/file.mkv', name: 'file.mkv', size: 100 },
    { providerFileId: '901', path: '/Bonus/file.mkv', name: 'file.mkv', size: 50 },
  ]);

  const mapped = store.recordFileMapping({
    ...createReleaseIdentity(HASH, 0),
    placementId: placement.id,
    providerFileId: '901',
    method: 'authoritative-inventory-match',
    authoritative: true,
  });
  assert.equal(mapped.fileIndex, 0);
  assert.equal(mapped.providerFileId, '901');
  assert.notEqual(String(mapped.fileIndex), mapped.providerFileId);
  assert.throws(() => store.recordFileMapping({
    ...createReleaseIdentity(HASH, 1), placementId: placement.id,
    providerFileId: 'missing', method: 'guess', authoritative: false,
  }), /not present in authoritative placement inventory/);
  store.close();
});

test('placement, exposure, mapping, and binding remain independent boundaries', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  const path = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: 'realdebrid', accountScope: 'primary', infoHash: HASH,
    providerResourceId: 'rd-17', state: 'ready', ownership: 'owned',
    provenance: 'test',
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: 'file-1', path: '/movie.mkv', name: 'movie.mkv', size: 100,
  }]);
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId: 'file-1', transport: 'zurg-rclone',
    exposureKey: 'rd-17:file-1', state: 'missing', readOnly: true,
  });

  assert.equal(store.listBindings(item.id).length, 0);
  assert.throws(() => store.activateBinding({
    libraryItemId: item.id, libraryPathId: path.id,
    ...createReleaseIdentity(HASH, null), placementId: placement.id,
    providerFileId: 'file-1', exposureId: exposure.id, reason: 'test',
  }), /without visible exposure/);
  store.close();
});

test('provider failover preserves canonical path and creates binding history', () => {
  let time = 1_000;
  const store = createControlPlaneStore({ now: () => ++time });
  const item = store.ensureLibraryItem(movie());
  const rdIdentity = createReleaseIdentity(HASH, 0);
  const rd = setupBindable(store, item, rdIdentity, { provider: 'realdebrid' });
  const first = store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...rdIdentity,
    placementId: rd.placement.id, providerFileId: rd.providerFileId,
    exposureId: rd.exposure.id, reason: 'initial-preference',
  });
  const torboxIdentity = createReleaseIdentity(OTHER_HASH, 7);
  const torbox = setupBindable(store, item, torboxIdentity, {
    provider: 'torbox', resourceId: 'tb-22', providerFileId: 'tb-file',
    transport: 'torbox-webdav-rclone', exposureKey: 'tb-22:tb-file',
  });
  const second = store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...torboxIdentity,
    placementId: torbox.placement.id, providerFileId: torbox.providerFileId,
    exposureId: torbox.exposure.id, reason: 'provider-failover',
  });
  const history = store.listBindings(item.id);

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(history[0].status, 'superseded');
  assert.equal(history[1].status, 'active');
  assert.equal(history[0].libraryPathId, history[1].libraryPathId);
  assert.equal(rd.path.canonicalPath, store.ensureCanonicalPath(item.id).canonicalPath);
  store.close();
});

test('repeated binding activation is idempotent and does not create versions', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, null);
  const data = setupBindable(store, item, identity);
  const input = {
    libraryItemId: item.id, libraryPathId: data.path.id, ...identity,
    placementId: data.placement.id, providerFileId: data.providerFileId,
    exposureId: data.exposure.id, reason: 'reconcile',
  };
  const first = store.activateBinding(input);
  const repeated = store.activateBinding(input);
  assert.equal(first.id, repeated.id);
  assert.equal(store.listBindings(item.id).length, 1);
  store.close();
});

test('lifecycle milestones are orthogonal and binding does not imply catalog or playback', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  store.appendLifecycleEvent({
    libraryItemId: item.id, milestone: 'requested', status: 'satisfied', source: 'api',
  });
  store.appendLifecycleEvent({
    libraryItemId: item.id, milestone: 'bound', status: 'satisfied', source: 'reconciler',
  });
  store.appendLifecycleEvent({
    libraryItemId: item.id, milestone: 'cataloged', status: 'failed',
    failureCategory: 'catalog-missing', retryable: true, source: 'plex-observer',
  });
  const lifecycle = store.getLifecycle(item.id);

  assert.equal(lifecycle.milestones.bound.status, 'satisfied');
  assert.equal(lifecycle.milestones.cataloged.status, 'failed');
  assert.equal(lifecycle.milestones.playable, null);
  assert.equal(lifecycle.events.length, 3);
  store.close();
});
