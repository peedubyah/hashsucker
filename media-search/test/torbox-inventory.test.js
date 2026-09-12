import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { ProviderOperationError } from '../src/lib/providers/errors.js';
import { createTorBoxInventoryProvider } from '../src/lib/providers/torbox-inventory.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = '1234567890abcdef1234567890abcdef12345678';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}
function mylist(data) { return response({ success: true, data }); }
function resource(overrides = {}) {
  return {
    id: 77,
    hash: HASH,
    name: 'Release',
    download_state: 'completed',
    files: [
      { id: 900, name: 'Release/movie.mkv', size: 1000, selected: true },
      { id: 901, name: 'Release/subtitle.srt', size: 100, selected: false },
    ],
    ...overrides,
  };
}

test('TorBox mylist exposes lookup, readiness, and inventory without creation or removal', () => {
  const adapter = createTorBoxInventoryProvider({ apiKey: 'token', fetchFn: async () => mylist([]) });
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP), true);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.RESOURCE_READINESS), true);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.FILE_INVENTORY), true);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.PLACEMENT_CREATE), false);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.REMOVAL), false);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.EXPOSURE), false);
});

test('TorBox mylist lookup is hash-authoritative but never ownership evidence', async () => {
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token', accountScope: 'primary', now: () => 10_000, observationTtlMs: 2_000,
    fetchFn: async () => mylist([resource()]),
  });
  const placement = await adapter.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
    .lookupPlacement({ infoHash: HASH, fileIndex: 0 });

  assert.equal(placement.providerResourceId, '77');
  assert.equal(placement.infoHash, HASH);
  assert.equal(placement.fileIndex, null);
  assert.equal(placement.state, 'ready');
  assert.equal(placement.ownership, 'external');
  assert.equal(placement.expiresAt, 12_000);
});

test('TorBox lookup returns null for absence and fails closed for duplicate hash matches', async () => {
  const absent = createTorBoxInventoryProvider({
    apiKey: 'token', fetchFn: async () => mylist([resource({ hash: OTHER_HASH })]),
  });
  assert.equal(await absent.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
    .lookupPlacement({ infoHash: HASH }), null);

  const ambiguous = createTorBoxInventoryProvider({
    apiKey: 'token', fetchFn: async () => mylist([resource(), resource({ id: 78 })]),
  });
  await assert.rejects(
    () => ambiguous.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP).lookupPlacement({ infoHash: HASH }),
    (error) => error instanceof ProviderOperationError && error.category === 'conflict',
  );
});

test('TorBox readiness verifies provider ID and hash independently', async () => {
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token', fetchFn: async () => mylist([resource({ download_state: 'downloading' })]),
  });
  const readiness = await adapter.require(PROVIDER_CAPABILITIES.RESOURCE_READINESS)
    .observeReadiness({ infoHash: HASH, providerResourceId: '77', ownership: 'external' });
  assert.equal(readiness.state, 'pending');

  const mismatch = createTorBoxInventoryProvider({
    apiKey: 'token', fetchFn: async () => mylist([resource({ hash: OTHER_HASH })]),
  });
  await assert.rejects(
    () => mismatch.require(PROVIDER_CAPABILITIES.RESOURCE_READINESS)
      .observeReadiness({ infoHash: HASH, providerResourceId: '77' }),
    (error) => error instanceof ProviderOperationError && error.category === 'conflict',
  );
});

test('TorBox file inventory preserves opaque file IDs and never guesses corpus indexes', async () => {
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token', now: () => 10_000, fetchFn: async () => mylist([resource()]),
  });
  const inventory = await adapter.require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
    .getFileInventory({ providerResourceId: '77' });

  assert.equal(inventory.authoritative, true);
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.files.map((file) => file.providerFileId), ['900', '901']);
  assert.deepEqual(inventory.files.map((file) => file.corpusFileIndex), [null, null]);
  assert.equal(inventory.files[0].path, 'Release/movie.mkv');
  assert.equal(inventory.files[0].name, 'movie.mkv');
});

test('TorBox mylist transport and response failures are typed', async () => {
  const auth = createTorBoxInventoryProvider({ apiKey: 'token', fetchFn: async () => response({}, 401) });
  await assert.rejects(
    () => auth.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP).lookupPlacement({ infoHash: HASH }),
    (error) => error instanceof ProviderOperationError && error.category === 'authentication',
  );

  const malformed = createTorBoxInventoryProvider({ apiKey: 'token', fetchFn: async () => response({ success: true }) });
  await assert.rejects(
    () => malformed.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP).lookupPlacement({ infoHash: HASH }),
    (error) => error instanceof ProviderOperationError && error.category === 'invalid-response',
  );
});

test('TorBox request-scoped coordinator shares one mylist fetch across lookup and inventory', async () => {
  const { TorBoxCallCoordinator } = await import('../src/lib/providers/torbox-call-coordinator.js');
  let fetches = 0;
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    fetchFn: async () => { fetches += 1; return mylist([resource()]); },
    coordinator: new TorBoxCallCoordinator({ scope: 'test-request' }),
  });
  await adapter.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
    .lookupPlacement({ infoHash: HASH });
  await adapter.require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
    .getFileInventory({ providerResourceId: '77' });
  await adapter.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
    .lookupPlacement({ infoHash: OTHER_HASH });
  assert.equal(fetches, 1, 'lookup + inventory + second lookup share one snapshot fetch');
});

test('TorBox invalidateMylistSnapshot forces a re-fetch on next read', async () => {
  const { TorBoxCallCoordinator } = await import('../src/lib/providers/torbox-call-coordinator.js');
  let fetches = 0;
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    fetchFn: async () => { fetches += 1; return mylist([resource()]); },
    coordinator: new TorBoxCallCoordinator({ scope: 'test-request' }),
  });
  await adapter.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
    .lookupPlacement({ infoHash: HASH });
  assert.equal(fetches, 1);
  adapter.invalidateMylistSnapshot();
  await adapter.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
    .lookupPlacement({ infoHash: HASH });
  assert.equal(fetches, 2, 'invalidation drops the memoized snapshot');
});

test('TorBox invalidateMylistSnapshot is a safe no-op without a coordinator', async () => {
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    fetchFn: async () => mylist([resource()]),
  });
  assert.equal(typeof adapter.invalidateMylistSnapshot, 'function');
  adapter.invalidateMylistSnapshot();
});

test('TorBox ensure binds a just-created torrent through invalidate-then-refetch', async () => {
  const { TorBoxCallCoordinator } = await import('../src/lib/providers/torbox-call-coordinator.js');
  const { ensureTorBoxFileIdentity } = await import('../src/lib/resolver/torbox-file-identity.js');
  const { createControlPlaneStore } = await import('../src/lib/control-plane/store.js');
  const store = createControlPlaneStore();
  const NEW_HASH = 'cccccccccccccccccccccccccccccccccccccccc';
  const bodies = [
    // First snapshot: account does not contain the hash yet.
    { success: true, data: [] },
    // Second snapshot: created torrent present with files.
    {
      success: true,
      data: [{
        id: 99, hash: NEW_HASH, name: 'New.Movie.2024.mkv', download_state: 'cached',
        files: [{ id: 900, name: 'New.Movie.2024.mkv', size: 777, selected: true }],
      }],
    },
  ];
  let fetches = 0;
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    fetchFn: async () => {
      fetches += 1;
      const body = bodies[Math.min(fetches - 1, bodies.length - 1)];
      return { ok: true, status: 200, async json() { return body; } };
    },
    coordinator: new TorBoxCallCoordinator({ scope: 'test-create' }),
  });
  const torBoxProvider = {
    supports: () => true,
    require: () => ({
      createPlacement: async () => ({ providerResourceId: '99' }),
    }),
  };
  const result = await ensureTorBoxFileIdentity({
    infoHash: NEW_HASH,
    selectedFileSize: 777,
    controlPlaneStore: store,
    torBoxInventoryProvider: adapter,
    torBoxProvider,
  });
  assert.equal(result.size, 777);
  assert.equal(result.providerFileId, '900');
  assert.equal(fetches, 2, 'lookup miss + one refetch after create (no third fetch)');
  assert.ok(result.torrentFileId, 'durable TorrentFile mapped');
  store.close();
});

test('TorBox ensure create-first binds without a prior lookup fetch', async () => {
  const { TorBoxCallCoordinator } = await import('../src/lib/providers/torbox-call-coordinator.js');
  const { ensureTorBoxFileIdentity } = await import('../src/lib/resolver/torbox-file-identity.js');
  const { createControlPlaneStore } = await import('../src/lib/control-plane/store.js');
  const store = createControlPlaneStore();
  const FRESH_HASH = 'dddddddddddddddddddddddddddddddddddddddd';
  let fetches = 0;
  let creates = 0;
  const snapshot = {
    success: true,
    data: [{
      id: 55, hash: FRESH_HASH, name: 'Fresh.Movie.2024.mkv', download_state: 'cached',
      files: [{ id: 901, name: 'Fresh.Movie.2024.mkv', size: 4242, selected: true }],
    }],
  };
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    fetchFn: async () => { fetches += 1; return { ok: true, status: 200, async json() { return snapshot; } }; },
    coordinator: new TorBoxCallCoordinator({ scope: 'test-create-first' }),
  });
  const torBoxProvider = {
    supports: (cap) => cap === 'placement-create',
    require: () => ({
      createPlacement: async () => { creates += 1; return { providerResourceId: '55' }; },
    }),
  };
  const result = await ensureTorBoxFileIdentity({
    infoHash: FRESH_HASH,
    selectedFileSize: 4242,
    controlPlaneStore: store,
    torBoxInventoryProvider: adapter,
    torBoxProvider,
  });
  assert.equal(result.size, 4242);
  assert.equal(result.providerFileId, '901');
  assert.equal(creates, 1);
  assert.equal(fetches, 1, 'verify + inventory share one memoized snapshot fetch');
  store.close();
});

test('TorBox ensure uncached create fails with zero list fetches', async () => {
  const { TorBoxCallCoordinator } = await import('../src/lib/providers/torbox-call-coordinator.js');
  const { ensureTorBoxFileIdentity } = await import('../src/lib/resolver/torbox-file-identity.js');
  const { createControlPlaneStore } = await import('../src/lib/control-plane/store.js');
  const store = createControlPlaneStore();
  let fetches = 0;
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    fetchFn: async () => { fetches += 1; return mylist([]); },
    coordinator: new TorBoxCallCoordinator({ scope: 'test-create-fail' }),
  });
  const torBoxProvider = {
    supports: () => true,
    require: () => ({
      createPlacement: async () => { throw new Error('DOWNLOAD_NOT_CACHED'); },
    }),
  };
  await assert.rejects(
    ensureTorBoxFileIdentity({
      infoHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      selectedFileSize: 10,
      controlPlaneStore: store,
      torBoxInventoryProvider: adapter,
      torBoxProvider,
    }),
    /No TorBox placement/,
  );
  assert.equal(fetches, 0, 'failed create costs no mylist download');
  store.close();
});

test('TorBox ensure preserves duplicate-hash conflict through verify', async () => {
  const { TorBoxCallCoordinator } = await import('../src/lib/providers/torbox-call-coordinator.js');
  const { ensureTorBoxFileIdentity } = await import('../src/lib/resolver/torbox-file-identity.js');
  const { createControlPlaneStore } = await import('../src/lib/control-plane/store.js');
  const store = createControlPlaneStore();
  const DUP_HASH = 'ffffffffffffffffffffffffffffffffffffffff';
  const dupBody = {
    success: true,
    data: [
      { id: 61, hash: DUP_HASH, name: 'A.mkv', download_state: 'cached', files: [] },
      { id: 62, hash: DUP_HASH, name: 'B.mkv', download_state: 'cached', files: [] },
    ],
  };
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    fetchFn: async () => ({ ok: true, status: 200, async json() { return dupBody; } }),
    coordinator: new TorBoxCallCoordinator({ scope: 'test-conflict' }),
  });
  const torBoxProvider = {
    supports: () => true,
    require: () => ({
      createPlacement: async () => ({ providerResourceId: '61' }),
    }),
  };
  await assert.rejects(
    ensureTorBoxFileIdentity({
      infoHash: DUP_HASH,
      selectedFileSize: 10,
      controlPlaneStore: store,
      torBoxInventoryProvider: adapter,
      torBoxProvider,
    }),
    (err) => err?.category === 'conflict',
    'duplicate hash still throws conflict, never binds',
  );
  store.close();
});

test('TorBox ensure falls back to passive lookup when creation is unavailable', async () => {
  const { ensureTorBoxFileIdentity } = await import('../src/lib/resolver/torbox-file-identity.js');
  const { createControlPlaneStore } = await import('../src/lib/control-plane/store.js');
  const store = createControlPlaneStore();
  let fetches = 0;
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    fetchFn: async () => { fetches += 1; return mylist([resource()]); },
  });
  const torBoxProvider = { supports: () => false, require: () => { throw new Error('no create'); } };
  const result = await ensureTorBoxFileIdentity({
    infoHash: HASH,
    selectedFileSize: 1000,
    controlPlaneStore: store,
    torBoxInventoryProvider: adapter,
    torBoxProvider,
  });
  assert.equal(result.providerFileId, '900');
  assert.ok(fetches >= 1);
  store.close();
});
