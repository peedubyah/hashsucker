import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { resolveProjection } from '../src/lib/resolver/resolver.js';
import { buildMediaSource, canBuildSource, SourceError } from '../src/lib/resolver/source.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = '1234567890abcdef1234567890abcdef12345678';

const NOW = 10_000;
const ENV = { REALDEBRID_MOUNT_PATH: '/mnt/zurg' };

function createStore() {
  return createControlPlaneStore({ now: () => NOW });
}

function createMovieItem(store, overrides = {}) {
  return store.ensureLibraryItem({
    mediaType: 'movie',
    mediaId: 'tt0133093',
    title: 'The Matrix',
    year: 1999,
    desiredState: 'present',
    ...overrides,
  });
}

function setupBindableExposure(store, item, identity, options = {}) {
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
    name: options.filename ?? 'The.Matrix.1999.mkv',
    size: options.size ?? 1_000_000_000,
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
    relativePath: options.relativePath ?? 'The.Matrix.1999.mkv',
    state: options.exposureState ?? 'visible',
    readOnly: true,
    observedAt: 0,
    expiresAt: 9_999_999_999_999,
    mountScope: options.mountScope ?? 'default',
  });
  return { path, placement, exposure, providerFileId: fileId };
}

function activateBinding(store, item, identity, exposure, providerFileId) {
  return store.activateBinding({
    libraryItemId: item.id,
    libraryPathId: store.getActiveCanonicalPath(item.id).id,
    ...identity,
    placementId: exposure.placement_id ?? store.db.prepare('SELECT placement_id FROM exposures WHERE id = ?').get(exposure.id).placement_id,
    providerFileId,
    exposureId: exposure.id,
    reason: 'test-activation',
  });
}

// ---------------------------------------------------------------------------
// MediaSource construction tests
// ---------------------------------------------------------------------------

test('buildMediaSource produces MediaSource for visible exposure', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const source = buildMediaSource({ projection, env: ENV });
  assert.equal(source.identity.infoHash, HASH);
  assert.equal(source.identity.fileIndex, 0);
  assert.equal(source.identity.releaseKey, `${HASH}:0`);
  assert.equal(source.transport, 'zurg-rclone');
  assert.equal(source.absolutePath, '/mnt/zurg/The.Matrix.1999.mkv');
  assert.equal(source.relativePath, 'The.Matrix.1999.mkv');
  assert.equal(source.size, 1_000_000_000);
  assert.equal(source.filename, 'The.Matrix.1999.mkv');
  assert.equal(source.contentType, 'video/x-matroska');
  assert.equal(source.exposureId, exposure.id);
  assert.equal(source.bindingId, projection.binding.id);
  store.close();
});

test('buildMediaSource resolves mount_scope correctly', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, { mountScope: 'torbox' });
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 0,
    env: { TORBOX_MOUNT_PATH: '/mnt/torbox' },
  });
  const source = buildMediaSource({ projection, env: { TORBOX_MOUNT_PATH: '/mnt/torbox' } });
  assert.equal(source.absolutePath, '/mnt/torbox/The.Matrix.1999.mkv');
  store.close();
});

test('buildMediaSource throws on missing mount configuration', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, { mountScope: 'unknown-scope' });
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  assert.throws(
    () => buildMediaSource({ projection, env: ENV }),
    (err) => err instanceof SourceError && err.code === 'mount-not-configured' && err.reason === 'unavailable',
  );
  store.close();
});

test('buildMediaSource throws on NULL relative_path', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  store.db.prepare('UPDATE exposures SET relative_path = NULL WHERE id = ?').run(exposure.id);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  assert.throws(
    () => buildMediaSource({ projection, env: ENV }),
    (err) => err instanceof SourceError && err.code === 'null-relative-path' && err.reason === 'unavailable',
  );
  store.close();
});

test('buildMediaSource rejects path traversal', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
    relativePath: '../../../etc/passwd',
  });
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  assert.throws(
    () => buildMediaSource({ projection, env: ENV }),
    (err) => err instanceof SourceError && err.code === 'path-traversal' && err.reason === 'invalid-path',
  );
  store.close();
});

test('buildMediaSource rejects absolute path traversal', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
    relativePath: '/etc/passwd',
  });
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  assert.throws(
    () => buildMediaSource({ projection, env: ENV }),
    (err) => err instanceof SourceError && err.code === 'path-traversal',
  );
  store.close();
});

test('buildMediaSource maintains identity isolation', () => {
  const store = createStore();
  const item1 = createMovieItem(store, { mediaId: 'tt-first' });
  const item2 = createMovieItem(store, { mediaId: 'tt-second' });
  const identity1 = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const identity2 = { infoHash: OTHER_HASH, fileIndex: 0, releaseKey: `${OTHER_HASH}:0` };
  const { exposure: exp1, providerFileId: pf1 } = setupBindableExposure(store, item1, identity1);
  const { exposure: exp2, providerFileId: pf2 } = setupBindableExposure(store, item2, identity2);
  activateBinding(store, item1, identity1, exp1, pf1);
  activateBinding(store, item2, identity2, exp2, pf2);
  const projection1 = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const projection2 = resolveProjection({ store, infoHash: OTHER_HASH, fileIndex: 0, env: ENV });
  const source1 = buildMediaSource({ projection: projection1, env: ENV });
  const source2 = buildMediaSource({ projection: projection2, env: ENV });
  assert.notEqual(source1.bindingId, source2.bindingId);
  assert.equal(source1.identity.infoHash, HASH);
  assert.equal(source2.identity.infoHash, OTHER_HASH);
  store.close();
});

test('buildMediaSource propagates size and name from provider_files', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
    filename: 'Custom.Name.2024.1080p.mkv',
    size: 5_500_000_000,
  });
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const source = buildMediaSource({ projection, env: ENV });
  assert.equal(source.size, 5_500_000_000);
  assert.equal(source.filename, 'Custom.Name.2024.1080p.mkv');
  assert.equal(source.contentType, 'video/x-matroska');
  store.close();
});

test('buildMediaSource derives content type from filename extension', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
    filename: 'movie.mp4',
    relativePath: 'movie.mp4',
  });
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const source = buildMediaSource({ projection, env: ENV });
  assert.equal(source.contentType, 'video/mp4');
  store.close();
});

test('buildMediaSource defaults content type to application/octet-stream for unknown extension', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
    filename: 'movie.xyz',
    relativePath: 'movie.xyz',
  });
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const source = buildMediaSource({ projection, env: ENV });
  assert.equal(source.contentType, 'application/octet-stream');
  store.close();
});

test('buildMediaSource throws when no binding exists', () => {
  const store = createStore();
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  assert.throws(
    () => buildMediaSource({ projection, env: ENV }),
    (err) => err instanceof SourceError && err.code === 'no-binding',
  );
  store.close();
});

test('buildMediaSource throws when no exposure exists', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  const binding = activateBinding(store, item, identity, exposure, providerFileId);
  // Manually null out exposure in projection to simulate missing exposure
  // (FK constraints prevent actually deleting the exposure, but the resolver
  // handles this case by returning null for non-existent exposures)
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  projection.exposure = null;
  assert.throws(
    () => buildMediaSource({ projection, env: ENV }),
    (err) => err instanceof SourceError && err.code === 'no-exposure',
  );
  store.close();
});

// ---------------------------------------------------------------------------
// canBuildSource tests
// ---------------------------------------------------------------------------

test('canBuildSource returns valid for servable projection', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const result = canBuildSource(projection);
  assert.equal(result.valid, true);
  store.close();
});

test('canBuildSource returns invalid for missing mount', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, { mountScope: 'unknown' });
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const result = canBuildSource(projection);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'mount-not-configured');
  store.close();
});

test('canBuildSource returns invalid for null relative_path', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  store.db.prepare('UPDATE exposures SET relative_path = NULL WHERE id = ?').run(exposure.id);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const result = canBuildSource(projection);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'null-relative-path');
  store.close();
});

test('canBuildSource returns invalid for no binding', () => {
  const store = createStore();
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const result = canBuildSource(projection);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'no-binding');
  store.close();
});

// ---------------------------------------------------------------------------
// MediaSource immutability tests
// ---------------------------------------------------------------------------

test('MediaSource is frozen and immutable', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({ store, infoHash: HASH, fileIndex: 0, env: ENV });
  const source = buildMediaSource({ projection, env: ENV });
  assert.throws(() => {
    source.absolutePath = '/evil';
  }, TypeError);
  assert.throws(() => {
    source.identity.infoHash = 'evil';
  }, TypeError);
  store.close();
});

// ---------------------------------------------------------------------------
// SourceError tests
// ---------------------------------------------------------------------------

test('SourceError has correct properties', () => {
  const error = new SourceError('test message', 'test-code', 'test-reason');
  assert.equal(error.message, 'test message');
  assert.equal(error.code, 'test-code');
  assert.equal(error.reason, 'test-reason');
  assert.equal(error.name, 'SourceError');
});
