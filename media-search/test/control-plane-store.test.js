import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

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

test('inventory refresh preserves mapped history and marks disappeared files absent', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  const identity = createReleaseIdentity(HASH, 0);
  const data = setupBindable(store, item, identity, { providerFileId: 'mapped-file' });

  store.replaceProviderFileInventory(data.placement.id, [{
    providerFileId: 'replacement-file', path: '/new.mkv', name: 'new.mkv',
    corpusFileIndex: 1,
  }], { observedAt: 2_000, expiresAt: 3_000 });

  assert.deepEqual(store.listProviderFiles(data.placement.id).map((file) => file.providerFileId), [
    'replacement-file',
  ]);
  const history = store.listProviderFiles(data.placement.id, { includeMissing: true });
  const missing = history.find((file) => file.providerFileId === 'mapped-file');
  assert.equal(missing.present, false);
  assert.equal(missing.missingSince, 2_000);
  assert.equal(store.listBindings(item.id).length, 0);
  store.close();
});

test('writable exposure cannot be bound even if visible', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  const path = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: 'realdebrid', accountScope: 'primary', infoHash: HASH,
    providerResourceId: 'rd-writable', state: 'ready', ownership: 'external',
    provenance: 'test',
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: 'file-1', path: '/movie.mkv', name: 'movie.mkv', corpusFileIndex: 0,
  }]);
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId: 'file-1', transport: 'test-mount',
    exposureKey: 'writable:file-1', state: 'visible', readOnly: false,
  });
  assert.throws(() => store.activateBinding({
    libraryItemId: item.id, libraryPathId: path.id,
    ...createReleaseIdentity(HASH, 0), placementId: placement.id,
    providerFileId: 'file-1', exposureId: exposure.id, reason: 'unsafe',
  }), /writable exposure/);
  store.close();
});

test('reconciliation snapshot is account-scoped evidence with exact file indices', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem(movie());
  store.ensureCanonicalPath(item.id);
  const identity = createReleaseIdentity(HASH, 0);
  const data = setupBindable(store, item, identity, { providerFileId: 'file-900' });
  store.replaceProviderFileInventory(data.placement.id, [{
    providerFileId: 'file-900', path: '/movie.mkv', name: 'movie.mkv',
    corpusFileIndex: 0,
  }], { observedAt: 10_000, expiresAt: 20_000 });
  const snapshot = store.getReconciliationSnapshot(item.id, identity);

  assert.equal(snapshot.desired.libraryItemId, item.id);
  assert.equal(snapshot.desired.releaseKey, identity.releaseKey);
  assert.equal(snapshot.placements[0].accountScope, 'primary');
  assert.equal(snapshot.placements[0].dependentBindingCount, 0);
  assert.equal(snapshot.providerFiles[0].corpusFileIndex, 0);
  assert.equal(snapshot.mappings[0].providerFileId, 'file-900');
  assert.equal(snapshot.exposures[0].readOnly, true);
  assert.equal(snapshot.currentBinding, null);
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

test('legacy exposure schema migrates in place without retargeting evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hashsucker-stage6-'));
  const dbPath = join(directory, 'control-plane.sqlite');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE provider_placements (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        account_scope TEXT NOT NULL,
        info_hash TEXT NOT NULL,
        provider_resource_id TEXT NOT NULL,
        state TEXT NOT NULL,
        ownership TEXT NOT NULL,
        provenance TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE provider_files (
        id TEXT PRIMARY KEY,
        placement_id TEXT NOT NULL,
        provider_file_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        present INTEGER NOT NULL,
        inventory_observed_at INTEGER NOT NULL,
        UNIQUE (placement_id, provider_file_id)
      );
      CREATE TABLE exposures (
        id TEXT PRIMARY KEY,
        placement_id TEXT NOT NULL,
        provider_file_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        exposure_key TEXT NOT NULL,
        relative_path TEXT,
        state TEXT NOT NULL,
        read_only INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        expires_at INTEGER,
        failure_category TEXT,
        retryable INTEGER,
        UNIQUE (transport, exposure_key),
        FOREIGN KEY (placement_id, provider_file_id)
          REFERENCES provider_files(placement_id, provider_file_id)
      );
      INSERT INTO provider_placements (
        id, provider, account_scope, info_hash, provider_resource_id, state,
        ownership, provenance, observed_at, created_at, updated_at
      ) VALUES (
        'legacy-placement', 'realdebrid', 'primary', '${HASH}', 'rd-legacy',
        'ready', 'external', 'legacy', 1000, 1000, 1000
      );
      INSERT INTO provider_files (
        id, placement_id, provider_file_id, path, name, present, inventory_observed_at
      ) VALUES (
        'legacy-file', 'legacy-placement', 'rd-file', '/movie.mkv', 'movie.mkv', 1, 1000
      );
      INSERT INTO exposures (
        id, placement_id, provider_file_id, transport, exposure_key, relative_path,
        state, read_only, observed_at, expires_at
      ) VALUES (
        'legacy-exposure', 'legacy-placement', 'rd-file', 'zurg-rclone',
        'Release/movie.mkv', 'Release/movie.mkv', 'visible', 1, 1000, 2000
      );
    `);
    legacy.close();

    const store = createControlPlaneStore({ dbPath, now: () => 1_500 });
    const migrated = store.db.prepare(
      'SELECT * FROM exposures WHERE id = ?'
    ).get('legacy-exposure');
    const uniqueTargets = store.db.prepare('PRAGMA index_list(exposures)').all()
      .filter((row) => row.unique === 1)
      .map((row) => store.db.prepare(`PRAGMA index_info(${row.name})`).all()
        .map((entry) => entry.name).join(','));
    assert.equal(migrated.account_scope, 'primary');
    assert.equal(migrated.mount_scope, 'legacy-unverified');
    assert.equal(migrated.placement_id, 'legacy-placement');
    assert.equal(migrated.provider_file_id, 'rd-file');
    assert(uniqueTargets.includes('transport,exposure_key,placement_id,provider_file_id'));
    store.close();

    const reopened = createControlPlaneStore({ dbPath, now: () => 1_500 });
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM exposures').get().count, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
