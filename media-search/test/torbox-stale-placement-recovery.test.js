/**
 * Stale TorBox placement recovery tests.
 *
 * Production failure (Batman Knightfall / tt32333324):
 *   - Local placement persisted with a TorBox provider_resource_id.
 *   - User deletes that resource from their mylist.
 *   - TorBox /checkcached (content cache) still reports the hash as cached.
 *   - HashSucker's revalidator trusts the content cache, persists state=cached.
 *   - /stream resolves the placement's requestdl permalink. TorBox returns
 *     HTTP 500 because the dld-id has been reaped.
 *
 * Required behaviour of the authoritative TorBox delivery seam:
 *   1. Surface the original requestdl failure unchanged when the resource
 *      is still upstream (rate-limit or transient).
 *   2. Invalidate the stale local placement and re-enter the existing
 *      authoritative TorBox lifecycle ONCE for the SAME (releaseKey,
 *      infoHash, fileIndex, filename) when the resource is absent upstream.
 *   3. Bounded to one repair attempt per resolver request.
 *   4. Preserve the existing CDN URL cache, error taxonomy, and 429
 *      throttling behaviour.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { resolveTorBoxDeliveryWithStaleRecovery } from '../src/lib/resolver/torbox-delivery.js';
import { TorBoxDownloadUrlError } from '../src/lib/resolver/torbox-download-url-cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { HASH } from './fixtures/torbox-response-fixtures.js';

const FILENAME = 'Batman.Knightfall.2025.1080p.mkv';
const RELEASE_KEY = `${HASH}:0`;
const FILE_INDEX = 0;
const OBSERVED_AT = 1_000;

function createStore() {
  return createControlPlaneStore({ now: () => OBSERVED_AT });
}

function seedPlacement(store, infoHash, providerResourceId) {
  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash,
    providerResourceId,
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'vfs-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: OBSERVED_AT,
    expiresAt: OBSERVED_AT + 5 * 60_000,
  });
  store.replaceProviderFileInventory(placement.id, [
    {
      providerFileId: 'file-1',
      path: `/${FILENAME}`,
      name: FILENAME,
      size: 1_000_000,
      selected: true,
    },
  ], { authoritative: true, complete: true, observedAt: OBSERVED_AT, expiresAt: OBSERVED_AT + 5 * 60_000 });
  store.recordFileMapping({
    infoHash,
    fileIndex: FILE_INDEX,
    releaseKey: RELEASE_KEY,
    placementId: placement.id,
    providerFileId: 'file-1',
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    evidence: { candidateFilename: FILENAME, providerPath: `/${FILENAME}` },
    mappedAt: OBSERVED_AT,
  });
  return placement;
}

function makeCache() {
  const store = new Map();
  const capStore = new Map();
  return {
    get(releaseKey, providerFileId) {
      const key = `${releaseKey}:${providerFileId}`;
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return { url: entry.url };
    },
    set(releaseKey, providerFileId, url) {
      store.set(`${releaseKey}:${providerFileId}`, { url, expiresAt: Date.now() + 60_000 });
    },
    delete(releaseKey, providerFileId) {
      store.delete(`${releaseKey}:${providerFileId}`);
    },
    getByCapability(capability) {
      const key = `${capability.provider}:${capability.accountScope}:${capability.placementId}:${capability.providerFileId}`;
      const entry = capStore.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        capStore.delete(key);
        return null;
      }
      return { url: entry.url, capability: entry.capability };
    },
    setByCapability(capability, url) {
      const key = `${capability.provider}:${capability.accountScope}:${capability.placementId}:${capability.providerFileId}`;
      capStore.set(key, { url, capability: { ...capability }, expiresAt: Date.now() + 60_000 });
    },
    invalidateByCapability(capability) {
      const key = `${capability.provider}:${capability.accountScope}:${capability.placementId}:${capability.providerFileId}`;
      capStore.delete(key);
    },
    async getOrInFlight(releaseKey, providerFileId, factory) {
      const key = `${releaseKey}:${providerFileId}`;
      const cached = this.get(releaseKey, providerFileId);
      if (cached) return cached.url;
      const url = await factory();
      this.set(releaseKey, providerFileId, url);
      return url;
    },
    async getOrInFlightByCapability(capability, factory) {
      const cached = this.getByCapability(capability);
      if (cached) return cached.url;
      const url = await factory();
      this.setByCapability(capability, url);
      return url;
    },
    size() { return store.size + capStore.size; },
    _peek(releaseKey, providerFileId) {
      return store.get(`${releaseKey}:${providerFileId}`) || null;
    },
  };
}

function fetchResponseOk(url) {
  return {
    ok: true,
    status: 200,
    url: `https://cdn.example/dld/${url.split('torrent_id=')[1].split('&')[0]}`,
  };
}

function fetchResponseFail(url, status) {
  return {
    ok: false,
    status,
    url,
  };
}

function makeTorBoxProvider({ createResponse }) {
  return {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_CREATE) {
        return {
          async createPlacement({ addOnlyIfCached }) {
            assert.equal(addOnlyIfCached, true, 'cached-only creation must remain enforced');
            return { provider: 'torbox', providerResourceId: '9990001', infoHash: HASH };
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };
}

function makeTorBoxInventoryProvider({ mylistResources, createResponse }) {
  return {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP) {
        return {
          async lookupPlacement({ infoHash }) {
            const matches = mylistResources.filter((resource) => resource?.hash === infoHash);
            if (matches.length === 0) return null;
            return {
              provider: 'torbox',
              accountScope: 'default',
              infoHash,
              providerResourceId: String(matches[0].id),
              state: 'ready',
              ownership: 'reused',
              provenance: 'torbox-mylist-v1',
              observedAt: OBSERVED_AT,
              expiresAt: OBSERVED_AT + 60_000,
            };
          },
        };
      }
      if (capability === PROVIDER_CAPABILITIES.FILE_INVENTORY) {
        return {
          async getFileInventory() {
            return {
              files: [
                { providerFileId: 'file-1', path: `/${FILENAME}`, name: FILENAME, size: 1_000_000 },
              ],
              authoritative: true,
              complete: true,
              observedAt: OBSERVED_AT,
              expiresAt: OBSERVED_AT + 60_000,
            };
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };
}

test('stale placement recovery: mylist absent → re-enter lifecycle → requestdl 200', async () => {
  const previousApiKey = process.env.TORBOX_API_KEY;
  process.env.TORBOX_API_KEY = 'test-key';
  try {
  const store = createStore();
  const existing = seedPlacement(store, HASH, '7777777');

  const cache = makeCache();
  const requestdlCalls = [];
  const resolveTorBoxDownloadUrl = async (permalink) => {
    requestdlCalls.push(permalink);
    if (requestdlCalls.length === 1) {
      throw new TorBoxDownloadUrlError(
        'TorBox requestdl returned HTTP 500',
        'TORBOX_REQUESTDL_FAILED',
        500,
      );
    }
    return fetchResponseOk(permalink).url;
  };

  const torBoxProvider = makeTorBoxProvider({});
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [], // resource absent upstream
  });

  const result = await resolveTorBoxDeliveryWithStaleRecovery({
    infoHash: HASH,
    fileIndex: FILE_INDEX,
    releaseKey: RELEASE_KEY,
    filename: FILENAME,
    controlPlaneStore: store,
    torBoxProvider,
    torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl,
    isUrlLive: undefined,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { [HASH]: { name: FILENAME } } }),
    }),
    now: () => OBSERVED_AT + 1_000,
  });

  // Same identity preserved
  assert.equal(result.recovered, true);
  assert.ok(result.url.startsWith('https://cdn.example/dld/'), 'should return CDN URL');
  // requestdl called twice (initial 500, recovery 200)
  assert.equal(requestdlCalls.length, 2);
  // New placement has new provider_resource_id, the old one is marked removed
  const newPlacement = store.findPlacementByInfoHash('torbox', HASH);
  assert.notEqual(newPlacement.id, existing.id, 'recovery should produce a new placement');
  assert.equal(newPlacement.providerResourceId, '9990001');
  const oldRow = store.db.prepare('SELECT state, failure_category FROM provider_placements WHERE id = ?').get(existing.id);
  assert.equal(oldRow.state, 'removed');
  assert.equal(oldRow.failure_category, 'upstream-resource-absent');
  // New mapping points at the new placement
  const mapping = store.findFileMapping(RELEASE_KEY, newPlacement.id);
  assert.equal(mapping.state, 'mapped');
  assert.equal(mapping.providerFileId, 'file-1');
  } finally {
    if (previousApiKey == null) delete process.env.TORBOX_API_KEY;
    else process.env.TORBOX_API_KEY = previousApiKey;
  }
});

test('stale placement recovery: mylist present → surface original 500, no recreation', async () => {
  const store = createStore();
  seedPlacement(store, HASH, '7777777');

  const cache = makeCache();
  const requestdlCalls = [];
  const resolveTorBoxDownloadUrl = async (permalink) => {
    requestdlCalls.push(permalink);
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 500',
      'TORBOX_REQUESTDL_FAILED',
      500,
    );
  };

  const torBoxProvider = makeTorBoxProvider({});
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [{ id: 7777777, hash: HASH }],
  });

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash: HASH,
      fileIndex: FILE_INDEX,
      releaseKey: RELEASE_KEY,
      filename: FILENAME,
      controlPlaneStore: store,
      torBoxProvider,
      torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache,
      resolveTorBoxDownloadUrl,
      isUrlLive: undefined,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { [HASH]: { name: FILENAME } } }),
      }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => {
      assert.ok(error instanceof TorBoxDownloadUrlError);
      assert.equal(error.status, 500);
      return true;
    },
  );

  assert.equal(requestdlCalls.length, 1, 'requestdl should not be reattempted when resource is upstream');
  const placement = store.findPlacementByInfoHash('torbox', HASH);
  assert.equal(placement.providerResourceId, '7777777', 'placement must not be replaced');
  assert.notEqual(placement.state, 'removed', 'placement must not be invalidated');
});

test('stale placement recovery: 429 is never repaired', async () => {
  const store = createStore();
  seedPlacement(store, HASH, '7777777');

  const cache = makeCache();
  const requestdlCalls = [];
  const resolveTorBoxDownloadUrl = async (permalink) => {
    requestdlCalls.push(permalink);
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 429',
      'TORBOX_REQUESTDL_FAILED',
      429,
    );
  };

  const torBoxProvider = makeTorBoxProvider({});
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [],
  });

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash: HASH,
      fileIndex: FILE_INDEX,
      releaseKey: RELEASE_KEY,
      filename: FILENAME,
      controlPlaneStore: store,
      torBoxProvider,
      torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache,
      resolveTorBoxDownloadUrl,
      isUrlLive: undefined,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { [HASH]: { name: FILENAME } } }),
      }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => {
      assert.ok(error instanceof TorBoxDownloadUrlError);
      assert.equal(error.status, 429);
      return true;
    },
  );

  assert.equal(requestdlCalls.length, 1, 'no reattempt for 429');
  const placement = store.findPlacementByInfoHash('torbox', HASH);
  assert.notEqual(placement.state, 'removed', '429 must not invalidate placement');
});

test('stale placement recovery: no existing placement → requestdl 500 surfaces unchanged', async () => {
  const previousApiKey = process.env.TORBOX_API_KEY;
  process.env.TORBOX_API_KEY = 'test-key';
  try {
  const store = createStore();
  // No existing placement
  const cache = makeCache();
  const requestdlCalls = [];
  const resolveTorBoxDownloadUrl = async (permalink) => {
    requestdlCalls.push(permalink);
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 500',
      'TORBOX_REQUESTDL_FAILED',
      500,
    );
  };

  const torBoxProvider = makeTorBoxProvider({});
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [],
  });

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash: HASH,
      fileIndex: FILE_INDEX,
      releaseKey: RELEASE_KEY,
      filename: FILENAME,
      controlPlaneStore: store,
      torBoxProvider,
      torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache,
      resolveTorBoxDownloadUrl,
      isUrlLive: undefined,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { [HASH]: { name: FILENAME } } }),
      }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => error instanceof TorBoxDownloadUrlError && error.status === 500,
  );

  // The fresh-creation path was taken; the 500 from requestdl surfaces.
  // No recovery was attempted (reusedExistingPlacementId was null), and the
  // placement that was just created in the same call is left as-is.
  const placement = store.findPlacementByInfoHash('torbox', HASH);
  assert.ok(placement, 'placement was created in the fresh-creation path');
  assert.equal(placement.providerResourceId, '9990001');
  assert.equal(placement.state, 'ready');
  } finally {
    if (previousApiKey == null) delete process.env.TORBOX_API_KEY;
    else process.env.TORBOX_API_KEY = previousApiKey;
  }
});

test('stale placement recovery: mylist lookup error → original 500 surfaces unchanged', async () => {
  const store = createStore();
  seedPlacement(store, HASH, '7777777');
  const cache = makeCache();
  const resolveTorBoxDownloadUrl = async () => {
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 500',
      'TORBOX_REQUESTDL_FAILED',
      500,
    );
  };

  const torBoxProvider = makeTorBoxProvider({});
  const torBoxInventoryProvider = {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP) {
        return {
          async lookupPlacement() {
            throw new Error('mylist 503');
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash: HASH,
      fileIndex: FILE_INDEX,
      releaseKey: RELEASE_KEY,
      filename: FILENAME,
      controlPlaneStore: store,
      torBoxProvider,
      torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache,
      resolveTorBoxDownloadUrl,
      isUrlLive: undefined,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { [HASH]: { name: FILENAME } } }),
      }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => error instanceof TorBoxDownloadUrlError && error.status === 500,
  );

  const placement = store.findPlacementByInfoHash('torbox', HASH);
  assert.equal(placement.providerResourceId, '7777777', 'no replacement on lookup failure');
});
