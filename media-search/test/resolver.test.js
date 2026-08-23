import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createRequestHandler } from '../src/server/app.js';
import {
  resolveProjection,
  findActiveBinding,
  findExposure,
  evaluateReadiness,
  parseIdentityFromParams,
  ResolverError,
} from '../src/lib/resolver/resolver.js';
import { resolveMountRoot, listConfiguredMounts, getMountScopeEnvVar } from '../src/lib/resolver/mounts.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = '1234567890abcdef1234567890abcdef12345678';
const THIRD_HASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const NOW = 10_000;

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
    relativePath: options.relativePath ?? '/provider/The.Matrix.1999.mkv',
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

function createRequest(handler) {
  return async (url, { method = 'GET', body } = {}) => {
    const input = Readable.from(body ? [Buffer.from(body)] : []);
    input.method = method;
    input.url = url;
    return new Promise((resolve, reject) => {
      const chunks = [];
      const response = {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(chunk) {
          if (chunk) chunks.push(Buffer.from(chunk));
          resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers });
        },
      };
      handler(input, response).catch(reject);
    });
  };
}

// ---------------------------------------------------------------------------
// Mount resolution tests
// ---------------------------------------------------------------------------

test('resolveMountRoot returns configured for known scope with env var set', () => {
  const result = resolveMountRoot('default', { REALDEBRID_MOUNT_PATH: '/mnt/zurg' });
  assert.equal(result.configured, true);
  assert.equal(result.mountScope, 'default');
  assert.equal(result.envVar, 'REALDEBRID_MOUNT_PATH');
  assert.equal(result.root, '/mnt/zurg');
});

test('resolveMountRoot returns not-configured for known scope without env var', () => {
  const result = resolveMountRoot('default', {});
  assert.equal(result.configured, false);
  assert.equal(result.mountScope, 'default');
  assert.equal(result.envVar, 'REALDEBRID_MOUNT_PATH');
  assert.equal(result.root, null);
});

test('resolveMountRoot returns not-configured for unknown scope', () => {
  const result = resolveMountRoot('unknown-scope', { REALDEBRID_MOUNT_PATH: '/mnt/zurg' });
  assert.equal(result.configured, false);
  assert.equal(result.mountScope, 'unknown-scope');
  assert.equal(result.envVar, null);
  assert.equal(result.root, null);
});

test('resolveMountRoot returns not-configured for empty scope', () => {
  const result = resolveMountRoot('', { REALDEBRID_MOUNT_PATH: '/mnt/zurg' });
  assert.equal(result.configured, false);
  assert.equal(result.mountScope, '');
  assert.equal(result.envVar, null);
  assert.equal(result.root, null);
});

test('listConfiguredMounts returns all scopes with their configuration state', () => {
  const mounts = listConfiguredMounts({
    REALDEBRID_MOUNT_PATH: '/mnt/zurg',
    TORBOX_MOUNT_PATH: '/mnt/torbox',
  });
  assert.equal(mounts.length, 3);
  const defaultMount = mounts.find((m) => m.mountScope === 'default');
  const torboxMount = mounts.find((m) => m.mountScope === 'torbox');
  const canonicalMount = mounts.find((m) => m.mountScope === 'canonical');
  assert.equal(defaultMount.configured, true);
  assert.equal(defaultMount.root, '/mnt/zurg');
  assert.equal(torboxMount.configured, true);
  assert.equal(torboxMount.root, '/mnt/torbox');
  assert.equal(canonicalMount.configured, false);
  assert.equal(canonicalMount.root, null);
});

test('getMountScopeEnvVar returns correct env var for known scope', () => {
  assert.equal(getMountScopeEnvVar('default'), 'REALDEBRID_MOUNT_PATH');
  assert.equal(getMountScopeEnvVar('torbox'), 'TORBOX_MOUNT_PATH');
  assert.equal(getMountScopeEnvVar('canonical'), 'CANONICAL_LIBRARY_PATH');
  assert.equal(getMountScopeEnvVar('unknown'), null);
});

// ---------------------------------------------------------------------------
// Identity parsing tests
// ---------------------------------------------------------------------------

test('parseIdentityFromParams accepts valid infoHash and fileIndex', () => {
  const identity = parseIdentityFromParams(HASH, '0');
  assert.equal(identity.infoHash, HASH);
  assert.equal(identity.fileIndex, 0);
  assert.equal(identity.releaseKey, `${HASH}:0`);
});

test('parseIdentityFromParams accepts "torrent" as fileIndex', () => {
  const identity = parseIdentityFromParams(HASH, 'torrent');
  assert.equal(identity.infoHash, HASH);
  assert.equal(identity.fileIndex, null);
  assert.equal(identity.releaseKey, `${HASH}:torrent`);
});

test('parseIdentityFromParams throws ResolverError for invalid infoHash', () => {
  assert.throws(
    () => parseIdentityFromParams('not-a-hash', '0'),
    (err) => err instanceof ResolverError && err.status === 400 && err.code === 'invalid-identity',
  );
});

test('parseIdentityFromParams throws ResolverError for negative fileIndex', () => {
  assert.throws(
    () => parseIdentityFromParams(HASH, '-1'),
    (err) => err instanceof ResolverError && err.status === 400 && err.code === 'invalid-identity',
  );
});

test('parseIdentityFromParams throws ResolverError for non-integer fileIndex', () => {
  assert.throws(
    () => parseIdentityFromParams(HASH, 'abc'),
    (err) => err instanceof ResolverError && err.status === 400 && err.code === 'invalid-identity',
  );
});

// ---------------------------------------------------------------------------
// Binding lookup tests
// ---------------------------------------------------------------------------

test('findActiveBinding returns null when no binding exists', () => {
  const store = createStore();
  const binding = findActiveBinding(store, HASH, 0);
  assert.equal(binding, null);
  store.close();
});

test('findActiveBinding returns active binding', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  const binding = findActiveBinding(store, HASH, 0);
  assert.ok(binding);
  assert.equal(binding.status, 'active');
  assert.equal(binding.info_hash, HASH);
  assert.equal(binding.file_index_key, 0);
  store.close();
});

test('findActiveBinding does not return superseded binding', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  const binding = activateBinding(store, item, identity, exposure, providerFileId);
  store.db.prepare("UPDATE bindings SET status = 'superseded' WHERE id = ?").run(binding.id);
  const result = findActiveBinding(store, HASH, 0);
  assert.equal(result, null);
  store.close();
});

test('findActiveBinding does not return failed binding', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  const binding = activateBinding(store, item, identity, exposure, providerFileId);
  store.db.prepare("UPDATE bindings SET status = 'failed' WHERE id = ?").run(binding.id);
  const result = findActiveBinding(store, HASH, 0);
  assert.equal(result, null);
  store.close();
});

// ---------------------------------------------------------------------------
// Exposure lookup tests
// ---------------------------------------------------------------------------

test('findExposure returns null for non-existent exposure', () => {
  const store = createStore();
  const exposure = findExposure(store, 'non-existent-id');
  assert.equal(exposure, null);
  store.close();
});

test('findExposure returns exposure by ID', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure } = setupBindableExposure(store, item, identity);
  const found = findExposure(store, exposure.id);
  assert.ok(found);
  assert.equal(found.id, exposure.id);
  assert.equal(found.state, 'visible');
  store.close();
});

// ---------------------------------------------------------------------------
// Readiness evaluation tests
// ---------------------------------------------------------------------------

test('evaluateReadiness returns no-binding when binding is null', () => {
  const result = evaluateReadiness({ binding: null, exposure: null, mount: { configured: false } });
  assert.equal(result.servable, false);
  assert.equal(result.reason, 'no-binding');
});

test('evaluateReadiness returns binding-failed for failed binding', () => {
  const result = evaluateReadiness({
    binding: { status: 'failed' },
    exposure: null,
    mount: { configured: false },
  });
  assert.equal(result.servable, false);
  assert.equal(result.reason, 'binding-failed');
});

test('evaluateReadiness returns no-exposure when exposure is null', () => {
  const result = evaluateReadiness({
    binding: { status: 'active' },
    exposure: null,
    mount: { configured: false },
  });
  assert.equal(result.servable, false);
  assert.equal(result.reason, 'no-exposure');
});

test('evaluateReadiness returns exposure-missing for missing exposure', () => {
  const result = evaluateReadiness({
    binding: { status: 'active' },
    exposure: { state: 'missing' },
    mount: { configured: false },
  });
  assert.equal(result.servable, false);
  assert.equal(result.reason, 'exposure-missing');
});

test('evaluateReadiness returns mount-not-configured when mount not configured', () => {
  const result = evaluateReadiness({
    binding: { status: 'active' },
    exposure: { state: 'visible', relative_path: '/movie.mkv' },
    mount: { configured: false },
  });
  assert.equal(result.servable, false);
  assert.equal(result.reason, 'mount-not-configured');
});

test('evaluateReadiness returns relative-path-null when relative_path is null', () => {
  const result = evaluateReadiness({
    binding: { status: 'active' },
    exposure: { state: 'visible', relative_path: null },
    mount: { configured: true },
  });
  assert.equal(result.servable, false);
  assert.equal(result.reason, 'relative-path-null');
});

test('evaluateReadiness returns ready when all conditions met', () => {
  const result = evaluateReadiness({
    binding: { status: 'active' },
    exposure: { state: 'visible', relative_path: '/movie.mkv' },
    mount: { configured: true },
  });
  assert.equal(result.servable, true);
  assert.equal(result.reason, 'ready');
});

// ---------------------------------------------------------------------------
// Full projection tests
// ---------------------------------------------------------------------------

test('resolveProjection returns no-binding for unknown identity', () => {
  const store = createStore();
  const projection = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 0,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  assert.equal(projection.binding, null);
  assert.equal(projection.exposure, null);
  assert.equal(projection.readiness.servable, false);
  assert.equal(projection.readiness.reason, 'no-binding');
  assert.equal(projection.identity.infoHash, HASH);
  assert.equal(projection.identity.fileIndex, 0);
  assert.equal(projection.identity.fileIndexKey, 0);
  store.close();
});

test('resolveProjection returns full projection for active binding with visible exposure', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 0,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  assert.ok(projection.binding);
  assert.equal(projection.binding.status, 'active');
  assert.ok(projection.exposure);
  assert.equal(projection.exposure.state, 'visible');
  assert.equal(projection.mount.configured, true);
  assert.equal(projection.mount.root, '/mnt/zurg');
  assert.equal(projection.readiness.servable, true);
  assert.equal(projection.readiness.reason, 'ready');
  store.close();
});

test('resolveProjection returns mount-not-configured for unconfigured mount scope', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, { mountScope: 'custom-scope' });
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 0,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  assert.equal(projection.mount.configured, false);
  assert.equal(projection.mount.mountScope, 'custom-scope');
  assert.equal(projection.readiness.servable, false);
  assert.equal(projection.readiness.reason, 'mount-not-configured');
  store.close();
});

test('resolveProjection returns exposure-missing for missing exposure state', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  // Update exposure state to missing after binding activation
  store.db.prepare("UPDATE exposures SET state = 'missing' WHERE id = ?").run(exposure.id);
  const projection = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 0,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  assert.equal(projection.exposure.state, 'missing');
  assert.equal(projection.readiness.servable, false);
  assert.equal(projection.readiness.reason, 'exposure-missing');
  store.close();
});

test('resolveProjection returns relative-path-null for null relative_path', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  // Set relative_path to null after binding activation
  store.db.prepare("UPDATE exposures SET relative_path = NULL WHERE id = ?").run(exposure.id);
  const projection = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 0,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  assert.equal(projection.exposure.relativePath, null);
  assert.equal(projection.readiness.servable, false);
  assert.equal(projection.readiness.reason, 'relative-path-null');
  store.close();
});

test('resolveProjection returns binding-failed for failed binding', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  const binding = activateBinding(store, item, identity, exposure, providerFileId);
  store.db.prepare("UPDATE bindings SET status = 'failed' WHERE id = ?").run(binding.id);
  const projection = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 0,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  assert.equal(projection.binding, null);
  assert.equal(projection.readiness.servable, false);
  assert.equal(projection.readiness.reason, 'no-binding');
  store.close();
});

test('resolveProjection handles torrent-level identity (fileIndex=null)', () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: null, releaseKey: `${HASH}:torrent` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  const projection = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: null,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  assert.equal(projection.identity.fileIndex, null);
  assert.equal(projection.identity.fileIndexKey, -1);
  assert.ok(projection.binding);
  assert.equal(projection.readiness.servable, true);
  store.close();
});

test('resolveProjection maintains identity isolation between different hashes', () => {
  const store = createStore();
  const item1 = createMovieItem(store, { mediaId: 'tt-first' });
  const item2 = createMovieItem(store, { mediaId: 'tt-second' });
  const identity1 = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const identity2 = { infoHash: OTHER_HASH, fileIndex: 0, releaseKey: `${OTHER_HASH}:0` };
  const { exposure: exp1, providerFileId: pf1 } = setupBindableExposure(store, item1, identity1);
  const { exposure: exp2, providerFileId: pf2 } = setupBindableExposure(store, item2, identity2);
  activateBinding(store, item1, identity1, exp1, pf1);
  activateBinding(store, item2, identity2, exp2, pf2);
  const projection1 = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 0,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  const projection2 = resolveProjection({
    store,
    infoHash: OTHER_HASH,
    fileIndex: 0,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  assert.notEqual(projection1.binding.id, projection2.binding.id);
  assert.equal(projection1.identity.infoHash, HASH);
  assert.equal(projection2.identity.infoHash, OTHER_HASH);
  store.close();
});

test('resolveProjection maintains identity isolation between different file indices', () => {
  const store = createStore();
  const item1 = createMovieItem(store, { mediaId: 'tt-first' });
  const item2 = createMovieItem(store, { mediaId: 'tt-second' });
  const identity1 = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const identity2 = { infoHash: HASH, fileIndex: 1, releaseKey: `${HASH}:1` };
  const { exposure: exp1, providerFileId: pf1 } = setupBindableExposure(store, item1, identity1);
  const { exposure: exp2, providerFileId: pf2 } = setupBindableExposure(store, item2, identity2);
  activateBinding(store, item1, identity1, exp1, pf1);
  activateBinding(store, item2, identity2, exp2, pf2);
  const projection1 = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 0,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  const projection2 = resolveProjection({
    store,
    infoHash: HASH,
    fileIndex: 1,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  assert.notEqual(projection1.binding.id, projection2.binding.id);
  assert.equal(projection1.identity.fileIndex, 0);
  assert.equal(projection2.identity.fileIndex, 1);
  store.close();
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests
// ---------------------------------------------------------------------------

test('GET /media/lookup returns 400 for invalid infoHash', async () => {
  const store = createStore();
  const handler = createRequestHandler({ controlPlaneStore: store });
  const request = createRequest(handler);
  const response = await request('/media/lookup/invalid-hash/0');
  assert.equal(response.status, 400);
  const body = JSON.parse(response.text);
  assert.match(body.error, /infoHash must be 40 hexadecimal characters/);
  store.close();
});

test('GET /media/lookup returns 400 for invalid fileIndex', async () => {
  const store = createStore();
  const handler = createRequestHandler({ controlPlaneStore: store });
  const request = createRequest(handler);
  const response = await request(`/media/lookup/${HASH}/abc`);
  assert.equal(response.status, 400);
  const body = JSON.parse(response.text);
  assert.match(body.error, /fileIndex must be torrent or a non-negative integer/);
  store.close();
});

test('GET /media/lookup returns projection for unknown identity', async () => {
  const store = createStore();
  const handler = createRequestHandler({ controlPlaneStore: store });
  const request = createRequest(handler);
  const response = await request(`/media/lookup/${HASH}/0`);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.binding, null);
  assert.equal(body.readiness.servable, false);
  assert.equal(body.readiness.reason, 'no-binding');
  store.close();
});

test('GET /media/lookup returns full projection for active binding', async () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  const handler = createRequestHandler({
    controlPlaneStore: store,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  const request = createRequest(handler);
  const response = await request(`/media/lookup/${HASH}/0`);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.ok(body.binding);
  assert.equal(body.binding.status, 'active');
  assert.ok(body.exposure);
  assert.equal(body.exposure.state, 'visible');
  assert.equal(body.mount.configured, true);
  assert.equal(body.mount.root, '/mnt/zurg');
  assert.equal(body.readiness.servable, true);
  store.close();
});

test('GET /media/lookup returns 400 for negative fileIndex', async () => {
  const store = createStore();
  const handler = createRequestHandler({ controlPlaneStore: store });
  const request = createRequest(handler);
  const response = await request(`/media/lookup/${HASH}/-1`);
  assert.equal(response.status, 400);
  store.close();
});

test('GET /media/lookup accepts "torrent" as fileIndex', async () => {
  const store = createStore();
  const item = createMovieItem(store);
  const identity = { infoHash: HASH, fileIndex: null, releaseKey: `${HASH}:torrent` };
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity);
  activateBinding(store, item, identity, exposure, providerFileId);
  const handler = createRequestHandler({
    controlPlaneStore: store,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/zurg' },
  });
  const request = createRequest(handler);
  const response = await request(`/media/lookup/${HASH}/torrent`);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.identity.fileIndex, null);
  assert.equal(body.identity.fileIndexKey, -1);
  assert.ok(body.binding);
  store.close();
});

test('GET /media/lookup returns 502 when control plane store is not configured', async () => {
  const handler = createRequestHandler({});
  const request = createRequest(handler);
  const response = await request(`/media/lookup/${HASH}/0`);
  assert.equal(response.status, 502);
});

// ---------------------------------------------------------------------------
// ResolverError tests
// ---------------------------------------------------------------------------

test('ResolverError has correct properties', () => {
  const error = new ResolverError('test message', 'test-code', 400);
  assert.equal(error.message, 'test message');
  assert.equal(error.code, 'test-code');
  assert.equal(error.status, 400);
  assert.equal(error.name, 'ResolverError');
});
