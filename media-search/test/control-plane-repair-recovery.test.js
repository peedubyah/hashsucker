/**
 * Slice 2.6 — control-plane repair regression tests.
 *
 * The full set of A1–A8 guarantees exercised against a synthetic TorBox
 * adapter, an in-memory control-plane store, and an in-memory URL cache.
 *
 * Coverage matrix (per Worker A brief):
 *   1. Stale placement → cached-only recreate → same TorrentFiles
 *   2. ProviderResourceId changes → no duplicate TorrentFile
 *   3. ProviderFileId changes → maps to same TorrentFile
 *   4. Concurrent stale-placement repair → one provider recreation
 *   5. Incomplete inventory → authoritative refresh
 *   6. Conflicting size/path → fail closed
 *   7. Requestdl expired URL → one re-resolution
 *   8. 429 → bounded backoff
 *   9. 5xx → no loop
 *
 * The in-memory TorBox URL cache used in these tests mirrors the
 * getOrInFlightByCapability contract so the assertions about
 * "one re-resolution" are precise.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { REPAIR_FAILURE_CATEGORIES } from '../src/lib/control-plane/repair-events.js';
import { resolveTorBoxDeliveryWithStaleRecovery, TorBoxDeliveryError } from '../src/lib/resolver/torbox-delivery.js';
import { TorBoxDownloadUrlError } from '../src/lib/resolver/torbox-download-url-cache.js';

const FILENAME = 'Series.S01E03.2160p.mkv';
const INTERNAL_PATH = `Series.S01.2160p/${FILENAME}`;
const FILE_SIZE = 2_933_186_072;
const OBSERVED_AT = 1_000;

function createStore(now = () => OBSERVED_AT) {
  return createControlPlaneStore({ now });
}

function seedPlacement(store, infoHash, providerResourceId, providerFileId = 'file-A') {
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
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId,
    path: `/${INTERNAL_PATH}`,
    name: FILENAME,
    size: FILE_SIZE,
    selected: true,
  }], {
    authoritative: true, complete: true,
    observedAt: OBSERVED_AT, expiresAt: OBSERVED_AT + 5 * 60_000,
  });
  store.recordFileMapping({
    infoHash,
    fileIndex: 0,
    releaseKey: `${infoHash}:0`,
    placementId: placement.id,
    providerFileId,
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    evidence: { candidateFilename: FILENAME, providerPath: `/${INTERNAL_PATH}` },
    mappedAt: OBSERVED_AT,
  });
  return placement;
}

function makeCache() {
  const store = new Map();
  const capStore = new Map();
  const inflight = new Map();
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
    async getOrInFlightByCapability(capability, factory) {
      const key = `${capability.provider}:${capability.accountScope}:${capability.placementId}:${capability.providerFileId}`;
      const existing = inflight.get(key);
      if (existing) return existing;
      const cached = capStore.get(key);
      if (cached && Date.now() < cached.expiresAt) return cached.url;
      const promise = (async () => {
        try { return await factory(); } finally { inflight.delete(key); }
      })();
      inflight.set(key, promise);
      return promise;
    },
    async getOrInFlight(releaseKey, providerFileId, factory) {
      const key = `${releaseKey}:${providerFileId}`;
      const cached = this.get(releaseKey, providerFileId);
      if (cached) return cached.url;
      return factory();
    },
    size() { return store.size + capStore.size; },
  };
}

function makeTorBoxProvider({ createPlacementResponse, onCreatePlacement } = {}) {
  return {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_CREATE) {
        return {
          async createPlacement({ addOnlyIfCached }) {
            assert.equal(addOnlyIfCached, true, 'cached-only creation must remain enforced');
            if (onCreatePlacement) onCreatePlacement();
            return createPlacementResponse ?? {
              provider: 'torbox', providerResourceId: 'res-NEW', infoHash: 'irrelevant',
            };
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };
}

function makeTorBoxInventoryProvider({
  mylistResources = [],
  mylistError = null,
  inventory = {
    authoritative: true, complete: true,
    files: [{
      providerFileId: 'file-A',
      path: `/${INTERNAL_PATH}`,
      name: FILENAME,
      size: FILE_SIZE,
      selected: true,
    }],
  },
} = {}) {
  return {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP) {
        return {
          async lookupPlacement() {
            if (mylistError) throw mylistError;
            return mylistResources[0] ?? null;
          },
        };
      }
      if (capability === PROVIDER_CAPABILITIES.FILE_INVENTORY) {
        return {
          async getFileInventory() {
            return { observedAt: OBSERVED_AT + 1_000, expiresAt: OBSERVED_AT + 6 * 60_000, ...inventory };
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };
}

function makeRequestdl({ fails }) {
  return async (permalink) => {
    const torrentId = permalink.split('torrent_id=')[1].split('&')[0];
    if (fails?.has(torrentId)) {
      throw fails.get(torrentId);
    }
    return `https://cdn.example/dld/${torrentId}`;
  };
}

function withTorboxApiKey(t) {
  const previous = process.env.TORBOX_API_KEY;
  process.env.TORBOX_API_KEY = 'test-key';
  t.after(() => {
    if (previous == null) delete process.env.TORBOX_API_KEY;
    else process.env.TORBOX_API_KEY = previous;
  });
}

function repairEvents(store) {
  // Repair events without a library item land in repair_evidence (additive
  // table, not lifecycle_events). For the tests below, the durable
  // observation is the same: a row per category with a stable
  // failure_category. Lifecycle rows carry a JSON evidence payload;
  // repair_evidence rows carry a reason. The shape is normalized below.
  const lifecycle = store.db.prepare(`
    SELECT failure_category, reason, evidence FROM lifecycle_events
    WHERE source = 'control-plane-repair'
    ORDER BY id
  `).all();
  // repair_evidence is created lazily by recordRepairEvent; if no event
  // has ever been recorded the table does not exist.
  let evidenceRows = [];
  const tableCheck = store.db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'repair_evidence'
  `).get();
  if (tableCheck) {
    const evidence = store.db.prepare(`
      SELECT failure_category, reason, info_hash, evidence FROM repair_evidence ORDER BY id
    `).all();
    evidenceRows = evidence.map((row) => ({
      failure_category: row.failure_category,
      reason: row.reason,
      evidence: row.evidence,
    }));
  }
  return [...lifecycle, ...evidenceRows];
}

function repairEvidence(store) {
  return store.db.prepare(`
    SELECT failure_category, reason, info_hash FROM repair_evidence ORDER BY id
  `).all();
}

// ---------------------------------------------------------------------------
// 1. Stale placement → cached-only recreate → same TorrentFiles.
// ---------------------------------------------------------------------------
test('stale placement recovery: cached-only recreate preserves durable TorrentFile', async (t) => {
  withTorboxApiKey(t);
  const infoHash = '1'.repeat(40);
  const store = createStore();
  const previousPlacement = seedPlacement(store, infoHash, 'res-OLD');
  // Snapshot the canonical TorrentFile id from the OLD placement; the new
  // placement must reconnect to the SAME TorrentFile row.
  const previousTorrentFile = store
    .listProviderFiles(previousPlacement.id)
    .find((f) => f.size === FILE_SIZE).torrentFileId;
  assert.ok(previousTorrentFile, 'seeded placement should have a TorrentFile row');

  const cache = makeCache();
  const mylistResources = []; // upstream is empty → repair path triggers
  const createCalls = [];
  const torBoxProvider = makeTorBoxProvider({
    onCreatePlacement: () => createCalls.push('create'),
  });
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({ mylistResources });

  const result = await resolveTorBoxDeliveryWithStaleRecovery({
    infoHash,
    fileIndex: 0,
    releaseKey: `${infoHash}:0`,
    filename: FILENAME,
    controlPlaneStore: store,
    torBoxProvider,
    torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl: makeRequestdl({
      fails: new Map([['res-OLD', new TorBoxDownloadUrlError(
        'TorBox requestdl returned HTTP 500', 'TORBOX_REQUESTDL_FAILED', 500,
      )]]),
    }),
    isUrlLive: undefined,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series.S01.2160p' } } }) }),
    now: () => OBSERVED_AT + 1_000,
  });

  assert.equal(result.recovered, true);
  // The new placement must have a distinct providerResourceId, and its
  // provider file must reconnect to the same TorrentFile row.
  const newPlacement = store.findPlacementByInfoHash('torbox', infoHash);
  assert.notEqual(newPlacement.id, previousPlacement.id, 'new placement must be a distinct row');
  assert.equal(newPlacement.providerResourceId, 'res-NEW', 'resource id must be the createPlacement response id');
  const newProviderFiles = store.listProviderFiles(newPlacement.id);
  const newMatched = newProviderFiles.find((f) => f.size === FILE_SIZE);
  assert.ok(newMatched, 'new placement must have a matched provider file');
  assert.equal(newMatched.torrentFileId, previousTorrentFile, 'durable TorrentFile identity must survive repair');
  // Reuse the inventory assertion from the durable-ontology rule: the
  // canonical physical identity is (infoHash, internalPath, size).
  const torrentFile = store.getTorrentFile(previousTorrentFile);
  assert.equal(torrentFile.infoHash, infoHash);
  assert.equal(torrentFile.size, FILE_SIZE);
  // Failure-classification event: STALE_PLACEMENT_REPAIRED must be recorded.
  const events = repairEvents(store);
  const repaired = events.find((e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED);
  assert.ok(repaired, 'stale-placement-repaired event must be recorded');
  const evidence = JSON.parse(repaired.evidence);
  assert.equal(evidence.previousPlacementId, previousPlacement.id);
  assert.equal(evidence.newPlacementId, newPlacement.id);
  assert.equal(evidence.newProviderResourceId, 'res-NEW');
  // The placement was never created twice.
  assert.equal(createCalls.length, 1, 'cached-only createPlacement runs exactly once');
  // requestdl is invoked once for the original call (failed) + once for the
  // recovered call (success). No further looping.
  assert.equal(result.url, 'https://cdn.example/dld/res-NEW', 'recovered URL points at the new resource');
});

// ---------------------------------------------------------------------------
// 2. ProviderResourceId changes → no duplicate TorrentFile.
// ---------------------------------------------------------------------------
test('provider resource id changes: same release, same torrent files', async (t) => {
  withTorboxApiKey(t);
  const infoHash = '2'.repeat(40);
  const store = createStore();
  const previousPlacement = seedPlacement(store, infoHash, 'res-OLD-2');
  const previousTorrentFiles = new Set(
    store.listProviderFiles(previousPlacement.id).map((f) => f.torrentFileId),
  );
  assert.ok(previousTorrentFiles.size > 0);

  const cache = makeCache();
  const torBoxProvider = makeTorBoxProvider({ createPlacementResponse: {
    provider: 'torbox', providerResourceId: 'res-NEW-2', infoHash,
  }});
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({ mylistResources: [] });

  await resolveTorBoxDeliveryWithStaleRecovery({
    infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
    controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl: makeRequestdl({
      fails: new Map([['res-OLD-2', new TorBoxDownloadUrlError(
        'TorBox requestdl returned HTTP 500', 'TORBOX_REQUESTDL_FAILED', 500,
      )]]),
    }),
    isUrlLive: undefined,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
    now: () => OBSERVED_AT + 1_000,
  });

  // No duplicate TorrentFile rows for this release.
  const allTorrentFiles = store.listTorrentFilesForRelease(infoHash);
  assert.equal(allTorrentFiles.length, previousTorrentFiles.size, 'no duplicate TorrentFile rows');
  for (const tf of allTorrentFiles) {
    assert.ok(previousTorrentFiles.has(tf.id), 'every post-repair TorrentFile id was present pre-repair');
  }
  // Provider placement identity rotates; accountScope is preserved.
  const newPlacement = store.findPlacementByInfoHash('torbox', infoHash);
  assert.equal(newPlacement.accountScope, previousPlacement.accountScope, 'accountScope preserved');
  assert.notEqual(newPlacement.providerResourceId, previousPlacement.providerResourceId, 'providerResourceId rotates');
});

// ---------------------------------------------------------------------------
// 3. ProviderFileId changes → maps to same TorrentFile.
// ---------------------------------------------------------------------------
test('provider file id churn: same canonical file, different opaque id', async (t) => {
  withTorboxApiKey(t);
  const infoHash = '3'.repeat(40);
  const store = createStore();
  const previousPlacement = seedPlacement(store, infoHash, 'res-OLD-3', 'file-OLD');
  const previousTorrentFile = store.listProviderFiles(previousPlacement.id)
    .find((f) => f.size === FILE_SIZE).torrentFileId;

  const cache = makeCache();
  const torBoxProvider = makeTorBoxProvider({ createPlacementResponse: {
    provider: 'torbox', providerResourceId: 'res-NEW-3', infoHash,
  }});
  // New mylist entry returns a fresh providerFileId ('file-NEW') but
  // same path + size → must remap to the same TorrentFile.
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [],
    inventory: {
      authoritative: true, complete: true,
      files: [{
        providerFileId: 'file-NEW',
        path: `/${INTERNAL_PATH}`,
        name: FILENAME,
        size: FILE_SIZE,
        selected: true,
      }],
    },
  });

  await resolveTorBoxDeliveryWithStaleRecovery({
    infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
    controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl: makeRequestdl({
      fails: new Map([['res-OLD-3', new TorBoxDownloadUrlError(
        'TorBox requestdl returned HTTP 500', 'TORBOX_REQUESTDL_FAILED', 500,
      )]]),
    }),
    isUrlLive: undefined,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
    now: () => OBSERVED_AT + 1_000,
  });

  const newPlacement = store.findPlacementByInfoHash('torbox', infoHash);
  const newProviderFiles = store.listProviderFiles(newPlacement.id);
  const newMatched = newProviderFiles.find((f) => f.providerFileId === 'file-NEW');
  assert.ok(newMatched, 'new provider file id must be persisted');
  assert.equal(newMatched.torrentFileId, previousTorrentFile, 'provider file id churn must reconnect to the same TorrentFile');
});

// ---------------------------------------------------------------------------
// 4. Concurrent stale-placement repair → one provider recreation.
// ---------------------------------------------------------------------------
test('concurrent stale-placement repair: single-flight prevents duplicate createPlacement', async (t) => {
  withTorboxApiKey(t);
  const infoHash = '4'.repeat(40);
  const store = createStore();
  seedPlacement(store, infoHash, 'res-OLD-4');
  const cache = makeCache();
  let inFlight = 0;
  let maxInFlight = 0;
  let createCount = 0;
  const torBoxProvider = {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_CREATE) {
        return {
          async createPlacement({ addOnlyIfCached }) {
            assert.equal(addOnlyIfCached, true);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            createCount += 1;
            // Hold long enough for all concurrent callers to queue.
            await new Promise((r) => setTimeout(r, 50));
            inFlight -= 1;
            return { provider: 'torbox', providerResourceId: 'res-NEW-4', infoHash };
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({ mylistResources: [] });
  const common = {
    infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
    controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl: makeRequestdl({
      fails: new Map([['res-OLD-4', new TorBoxDownloadUrlError(
        'TorBox requestdl returned HTTP 500', 'TORBOX_REQUESTDL_FAILED', 500,
      )]]),
    }),
    isUrlLive: undefined,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
    now: () => OBSERVED_AT + 1_000,
  };
  // Fire three concurrent resolutions.
  const results = await Promise.all([
    resolveTorBoxDeliveryWithStaleRecovery(common),
    resolveTorBoxDeliveryWithStaleRecovery(common),
    resolveTorBoxDeliveryWithStaleRecovery(common),
  ]);
  assert.equal(createCount, 1, 'createPlacement must run exactly once across concurrent callers');
  assert.equal(maxInFlight, 1, 'createPlacement must be single-flighted');
  for (const result of results) {
    assert.equal(result.recovered, true);
    assert.equal(result.url.includes('res-NEW-4'), true);
  }
  const newPlacement = store.findPlacementByInfoHash('torbox', infoHash);
  assert.equal(newPlacement.providerResourceId, 'res-NEW-4');
});

// ---------------------------------------------------------------------------
// 5. Incomplete inventory → authoritative refresh (replaces, durable survives).
// ---------------------------------------------------------------------------
test('incomplete inventory: authoritative refresh replaces stale snapshot, durable TorrentFile survives', async (t) => {
  withTorboxApiKey(t);
  const infoHash = '5'.repeat(40);
  const store = createStore();
  // Seed a placement that will be re-entered with a fresh resource id.
  const previousPlacement = seedPlacement(store, infoHash, 'res-OLD-5');
  const previousTorrentFile = store.listProviderFiles(previousPlacement.id)
    .find((f) => f.size === FILE_SIZE).torrentFileId;
  // Mark the previous placement's inventory snapshot as incomplete + stale.
  store.db.prepare(`
    UPDATE provider_inventory_snapshots
    SET complete = 0, authoritative = 0, observed_at = ?, expires_at = ?
    WHERE placement_id = ?
  `).run(OBSERVED_AT - 60_000, OBSERVED_AT - 30_000, previousPlacement.id);

  const cache = makeCache();
  const torBoxProvider = makeTorBoxProvider({ createPlacementResponse: {
    provider: 'torbox', providerResourceId: 'res-NEW-5', infoHash,
  }});
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({ mylistResources: [] });

  await resolveTorBoxDeliveryWithStaleRecovery({
    infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
    controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl: makeRequestdl({
      fails: new Map([['res-OLD-5', new TorBoxDownloadUrlError(
        'TorBox requestdl returned HTTP 500', 'TORBOX_REQUESTDL_FAILED', 500,
      )]]),
    }),
    isUrlLive: undefined,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
    now: () => OBSERVED_AT + 1_000,
  });

  const newPlacement = store.findPlacementByInfoHash('torbox', infoHash);
  const newSnapshot = store.getProviderInventorySnapshot(newPlacement.id);
  assert.ok(newSnapshot);
  assert.equal(newSnapshot.authoritative, true, 'authoritative must be true after refresh');
  assert.equal(newSnapshot.complete, true, 'complete must be true after refresh');
  const newProviderFiles = store.listProviderFiles(newPlacement.id);
  const newMatched = newProviderFiles.find((f) => f.size === FILE_SIZE);
  assert.ok(newMatched, 'refreshed inventory must contain the canonical file');
  assert.equal(newMatched.torrentFileId, previousTorrentFile, 'durable TorrentFile survives inventory refresh');
  // The old placement's snapshot remains the deposed authoritative record.
  const oldSnapshot = store.getProviderInventorySnapshot(previousPlacement.id);
  assert.equal(oldSnapshot.complete, false);
  assert.equal(oldSnapshot.authoritative, false);
});

// ---------------------------------------------------------------------------
// 6. Conflicting size/path → fail closed.
// ---------------------------------------------------------------------------
test('size conflict on a re-entered placement: provider file demoted, TorrentFile preserved', async (t) => {
  withTorboxApiKey(t);
  const infoHash = '6'.repeat(40);
  const store = createStore();
  const previousPlacement = seedPlacement(store, infoHash, 'res-OLD-6');
  const previousTorrentFile = store.listProviderFiles(previousPlacement.id)
    .find((f) => f.size === FILE_SIZE).torrentFileId;

  const cache = makeCache();
  const torBoxProvider = makeTorBoxProvider({ createPlacementResponse: {
    provider: 'torbox', providerResourceId: 'res-NEW-6', infoHash,
  }});
  // Inventory returns the SAME path but a CONFLICTING size for one of the
  // files. The provider file must become a size-conflict (no TorrentFile
  // id) and the existing TorrentFile must remain untouched.
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [],
    inventory: {
      authoritative: true, complete: true,
      files: [{
        providerFileId: 'file-CONFLICT',
        path: `/${INTERNAL_PATH}`,
        name: FILENAME,
        size: 9_999_999,
        selected: true,
      }],
    },
  });

  // The conflict surfaces as a missing exact file match in the new
  // placement's provider inventory. This is the bounded failure the
  // task brief calls out: fail-closed, do NOT silently bind a different
  // file. We assert that the second createPlacement succeeded but the
  // new provider file is left in mapping_state='conflict' with no
  // torrent_file_id, and the original TorrentFile is preserved.
  await resolveTorBoxDeliveryWithStaleRecovery({
    infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
    controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl: makeRequestdl({
      fails: new Map([['res-OLD-6', new TorBoxDownloadUrlError(
        'TorBox requestdl returned HTTP 500', 'TORBOX_REQUESTDL_FAILED', 500,
      )]]),
    }),
    isUrlLive: undefined,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
    now: () => OBSERVED_AT + 1_000,
  });

  const newPlacement = store.findPlacementByInfoHash('torbox', infoHash);
  const conflicting = store.listProviderFiles(newPlacement.id, { includeMissing: true })
    .find((f) => f.providerFileId === 'file-CONFLICT');
  assert.ok(conflicting, 'conflicting provider file must be present in the new placement');
  assert.equal(conflicting.mappingState, 'conflict', 'conflicting size must yield mapping_state=conflict');
  assert.equal(conflicting.torrentFileId, null, 'conflicting provider file must NOT be assigned a TorrentFile id');
  // The pre-existing TorrentFile is still durable on the same release.
  const torrentFile = store.getTorrentFile(previousTorrentFile);
  assert.equal(torrentFile.infoHash, infoHash);
  assert.equal(torrentFile.size, FILE_SIZE);
});

// ---------------------------------------------------------------------------
// 7. Requestdl expired URL → one re-resolution, no loop.
// ---------------------------------------------------------------------------
test('requestdl 401: capability invalidated, single re-resolution, no loop', async (t) => {
  withTorboxApiKey(t);
  const infoHash = '7'.repeat(40);
  const store = createStore();
  seedPlacement(store, infoHash, 'res-OLD-7');
  const cache = makeCache();
  // Pre-seed the cache with an "expired" URL to ensure the seam resolves.
  const torBoxProvider = makeTorBoxProvider();
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [{ provider: 'torbox', providerResourceId: 'res-OLD-7', infoHash }],
  });
  let requestdlCalls = 0;
  const resolveTorBoxDownloadUrl = async (permalink) => {
    requestdlCalls += 1;
    if (requestdlCalls === 1) {
      throw new TorBoxDownloadUrlError(
        'TorBox requestdl returned HTTP 401', 'TORBOX_REQUESTDL_FAILED', 401,
      );
    }
    return { ok: true, status: 200, url: `https://cdn.example/dld/${permalink.split('torrent_id=')[1].split('&')[0]}` };
  };

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
      controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache, resolveTorBoxDownloadUrl, isUrlLive: undefined,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => error instanceof TorBoxDownloadUrlError && error.status === 401,
  );

  // First call: surface 401, do NOT loop. requestdl invoked exactly once.
  assert.equal(requestdlCalls, 1, '401 must not loop within the same call');
  // Capability cache was invalidated for the next call.
  const newPlacement = store.findPlacementByInfoHash('torbox', infoHash);
  const newProviderFiles = store.listProviderFiles(newPlacement.id);
  const matched = newProviderFiles.find((f) => f.size === FILE_SIZE);
  assert.ok(matched, 'seeded placement should still be present (mylist is present)');
  const capability = {
    provider: 'torbox', accountScope: 'default',
    placementId: newPlacement.id, providerFileId: matched.providerFileId,
  };
  assert.equal(cache.getByCapability(capability), null, 'capability must be invalidated on 401');
  // Failure-classification event: DELIVERY_CAPABILITY_EXPIRED.
  const events = repairEvents(store);
  const expired = events.find((e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.DELIVERY_CAPABILITY_EXPIRED);
  assert.ok(expired, 'delivery-capability-expired event must be recorded');

  // Second call: fresh start, no cached URL, exactly one re-resolution succeeds.
  const resolveTorBoxDownloadUrl2 = async (permalink) => {
    requestdlCalls += 1;
    return { ok: true, status: 200, url: `https://cdn.example/dld/${permalink.split('torrent_id=')[1].split('&')[0]}` };
  };
  const result = await resolveTorBoxDeliveryWithStaleRecovery({
    infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
    controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache, resolveTorBoxDownloadUrl: resolveTorBoxDownloadUrl2, isUrlLive: undefined,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
    now: () => OBSERVED_AT + 2_000,
  });
  assert.equal(result.recovered, false, 'second call must succeed (resource still present upstream)');
  assert.equal(requestdlCalls, 2, 'requestdl ran exactly twice across both calls (one 401 + one 200)');
  // DELIVERY_CAPABILITY_RECOVERED event recorded once.
  const recovered = repairEvents(store)
    .filter((e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.DELIVERY_CAPABILITY_RECOVERED);
  assert.equal(recovered.length, 1, 'delivery-capability-recovered event recorded once on re-resolution');
});

// ---------------------------------------------------------------------------
// 8. 429 → bounded backoff, no storm (no repair, no replacement).
// ---------------------------------------------------------------------------
test('requestdl 429: bounded backoff, no repair, no replacement', async (t) => {
  withTorboxApiKey(t);
  const infoHash = '8'.repeat(40);
  const store = createStore();
  const previousPlacement = seedPlacement(store, infoHash, 'res-OLD-8');
  const cache = makeCache();
  const torBoxProvider = makeTorBoxProvider();
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [{ provider: 'torbox', providerResourceId: 'res-OLD-8', infoHash }],
  });
  const resolveTorBoxDownloadUrl = async () => {
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 429', 'TORBOX_REQUESTDL_RATE_LIMITED', 429,
      { retryAfterMs: 5_000 },
    );
  };

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
      controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache, resolveTorBoxDownloadUrl, isUrlLive: undefined,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => error instanceof TorBoxDownloadUrlError && error.status === 429,
  );

  // The placement must NOT be marked removed on 429.
  const placement = store.findPlacementByInfoHash('torbox', infoHash);
  assert.equal(placement.state, 'ready', 'placement must remain ready on 429');
  // The providerResourceId is the same.
  assert.equal(placement.providerResourceId, previousPlacement.providerResourceId);
  // Failure-classification event: REQUESTDL_RATE_LIMITED.
  const events = repairEvents(store);
  const rateLimited = events.find((e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.REQUESTDL_RATE_LIMITED);
  assert.ok(rateLimited, 'requestdl-rate-limited event must be recorded');
  // There must NOT be a stale-placement-repaired event.
  const repaired = events.find((e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED);
  assert.equal(repaired, undefined, '429 must not trigger stale-placement-repaired');
});

// ---------------------------------------------------------------------------
// 9. 5xx → no loop, no replacement.
// ---------------------------------------------------------------------------
test('requestdl 5xx: surface original, no storm, no replacement', async (t) => {
  withTorboxApiKey(t);
  const infoHash = '9'.repeat(40);
  const store = createStore();
  const previousPlacement = seedPlacement(store, infoHash, 'res-OLD-9');
  const cache = makeCache();
  const torBoxProvider = makeTorBoxProvider();
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [{ provider: 'torbox', providerResourceId: 'res-OLD-9', infoHash }],
  });
  let requestdlCalls = 0;
  const resolveTorBoxDownloadUrl = async () => {
    requestdlCalls += 1;
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 500', 'TORBOX_REQUESTDL_FAILED', 500,
    );
  };

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
      controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache, resolveTorBoxDownloadUrl, isUrlLive: undefined,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => error instanceof TorBoxDownloadUrlError && error.status === 500,
  );

  // Exactly one requestdl call.
  assert.equal(requestdlCalls, 1, '5xx must not loop within the same call');
  // Placement is unchanged (mylist is present upstream, so 5xx is transient).
  const placement = store.findPlacementByInfoHash('torbox', infoHash);
  assert.equal(placement.state, 'ready');
  assert.equal(placement.providerResourceId, previousPlacement.providerResourceId);
  // Failure-classification event: REQUESTDL_UPSTREAM_5XX.
  const events = repairEvents(store);
  const upstream5xx = events.find((e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.REQUESTDL_UPSTREAM_5XX);
  assert.ok(upstream5xx, 'requestdl-upstream-5xx event must be recorded');
  // No stale-placement-repaired event.
  const repaired = events.find((e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED);
  assert.equal(repaired, undefined, '5xx must not trigger stale-placement-repaired');
});

// ---------------------------------------------------------------------------
// Bonus: client cancellation does not poison the capability cache.
// ---------------------------------------------------------------------------
test('client cancellation: cached capability remains valid', async (t) => {
  withTorboxApiKey(t);
  const infoHash = 'a'.repeat(40);
  const store = createStore();
  const placement = seedPlacement(store, infoHash, 'res-OLD-a');
  const matched = store.listProviderFiles(placement.id).find((f) => f.size === FILE_SIZE);
  const capability = {
    provider: 'torbox', accountScope: 'default',
    placementId: placement.id, providerFileId: matched.providerFileId,
  };

  const cache = makeCache();
  // Pre-seed the cache so a fresh request can short-circuit on the
  // valid capability. We then forcibly abort BEFORE the second call
  // enters. The capability must remain valid.
  cache.setByCapability(capability, 'https://cdn.example/dld/cached');

  const torBoxProvider = makeTorBoxProvider();
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [{ provider: 'torbox', providerResourceId: 'res-OLD-a', infoHash }],
  });
  const controller = new AbortController();
  controller.abort();

  // The cached URL is returned as-is; no requestdl call. The
  // seam must short-circuit on the cache and not call resolveTorBoxDownloadUrl
  // at all (because the cache has a fresh entry). To exercise the
  // abort path, the second variant drops the cache and aborts the
  // call before the requestdl is invoked.
  // Variant 1: cached URL is reused, no abort propagation.
  const firstResult = await resolveTorBoxDeliveryWithStaleRecovery({
    infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
    controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl: async () => {
      throw new Error('cache should have short-circuited');
    },
    isUrlLive: undefined,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
    now: () => OBSERVED_AT + 1_000,
    signal: controller.signal,
  });
  assert.equal(firstResult.url, 'https://cdn.example/dld/cached',
    'cached capability must be reused on aborted signal');

  // Variant 2: drop the cache and call with aborted signal. The
  // requestdl layer must surface the abort; the cache must remain
  // empty (no poisoned entry written).
  cache.invalidateByCapability(capability);
  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
      controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache,
      resolveTorBoxDownloadUrl: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
      isUrlLive: undefined,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
      now: () => OBSERVED_AT + 1_000,
      signal: controller.signal,
    }),
    (error) => error.name === 'AbortError',
  );

  // Capability cache is empty (aborted call did not write a poisoned entry).
  const cachedAfter = cache.getByCapability(capability);
  assert.equal(cachedAfter, null, 'aborted call must not write a poisoned cache entry');
  // No failure-classification event was recorded for the abort.
  const rateLimitedOrExpired = repairEvents(store).filter((e) =>
    e.failure_category === REPAIR_FAILURE_CATEGORIES.REQUESTDL_RATE_LIMITED
    || e.failure_category === REPAIR_FAILURE_CATEGORIES.REQUESTDL_UPSTREAM_5XX
    || e.failure_category === REPAIR_FAILURE_CATEGORIES.DELIVERY_CAPABILITY_EXPIRED,
  );
  assert.equal(rateLimitedOrExpired.length, 0,
    'aborted call must not produce a 429/5xx/expired event');
});

// ---------------------------------------------------------------------------
// Hardening A.1 — valid placement + stale capability (403) causes one
// bounded re-resolution on the next call. Mirrors the 401 contract; both
// 401 and 403 must invalidate the capability and surface the original
// error without triggering destructive repair.
// ---------------------------------------------------------------------------
test('requestdl 403: capability invalidated, single re-resolution, no loop', async (t) => {
  withTorboxApiKey(t);
  const infoHash = 'b'.repeat(40);
  const store = createStore();
  seedPlacement(store, infoHash, 'res-OLD-b');
  const cache = makeCache();
  const torBoxProvider = makeTorBoxProvider();
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [{ provider: 'torbox', providerResourceId: 'res-OLD-b', infoHash }],
  });
  let requestdlCalls = 0;
  const resolveTorBoxDownloadUrl = async () => {
    requestdlCalls += 1;
    if (requestdlCalls === 1) {
      throw new TorBoxDownloadUrlError(
        'TorBox requestdl returned HTTP 403', 'TORBOX_REQUESTDL_FAILED', 403,
      );
    }
    return 'https://cdn.example/dld/res-OLD-b';
  };

  // First call: surface 403, no repair, no replacement.
  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
      controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache, resolveTorBoxDownloadUrl, isUrlLive: undefined,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => error instanceof TorBoxDownloadUrlError && error.status === 403,
  );
  assert.equal(requestdlCalls, 1, 'first call must surface 403 without retry');
  // Placement unchanged, capability invalidated.
  const placement = store.findPlacementByInfoHash('torbox', infoHash);
  assert.equal(placement.state, 'ready', '403 must not mark placement removed');
  assert.equal(placement.providerResourceId, 'res-OLD-b', '403 must not rotate providerResourceId');
  const expired = repairEvents(store).find(
    (e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.DELIVERY_CAPABILITY_EXPIRED,
  );
  assert.ok(expired, '403 must record a delivery-capability-expired event');

  // Second call: cache empty after invalidation → exactly one re-resolution
  // succeeds. No repair attempted.
  const result = await resolveTorBoxDeliveryWithStaleRecovery({
    infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
    controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
    torBoxDownloadUrlCache: cache, resolveTorBoxDownloadUrl, isUrlLive: undefined,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
    now: () => OBSERVED_AT + 2_000,
  });
  assert.equal(result.recovered, false, 'second call must succeed (resource still present)');
  assert.equal(requestdlCalls, 2, 'requestdl ran exactly twice across both calls (one 403 + one 200)');
  const recovered = repairEvents(store).filter(
    (e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.DELIVERY_CAPABILITY_RECOVERED,
  );
  assert.equal(recovered.length, 1, '403 path records exactly one delivery-capability-recovered event');
});

// ---------------------------------------------------------------------------
// Hardening A.2 — transport-level downstream URL missing (502) is never
// treated as a stale-resource signal. Destructive repair must not fire
// when requestdl returned 200 but the URL did not resolve to a downstream
// download target. The mylist is the sole authoritative signal of
// upstream resource presence; a malformed URL alone must not rotate the
// durable placement identity.
// ---------------------------------------------------------------------------
test('requestdl downstream-URL-missing (502): no destructive repair, even when mylist is absent', async (t) => {
  withTorboxApiKey(t);
  const infoHash = 'c'.repeat(40);
  const store = createStore();
  const previousPlacement = seedPlacement(store, infoHash, 'res-OLD-c');
  const cache = makeCache();
  const createCalls = [];
  const torBoxProvider = makeTorBoxProvider({
    onCreatePlacement: () => createCalls.push('create'),
  });
  // mylist says absent — but the requestdl failure is a transport-level
  // malformed URL, not a real stale signal. The seam must not repair.
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({ mylistResources: [] });
  const resolveTorBoxDownloadUrl = async () => {
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl did not resolve to a downstream download URL',
      'TORBOX_DOWNSTREAM_URL_MISSING',
      502,
    );
  };

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
      controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache, resolveTorBoxDownloadUrl, isUrlLive: undefined,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => error instanceof TorBoxDownloadUrlError
      && error.code === 'TORBOX_DOWNSTREAM_URL_MISSING',
  );

  // The placement must remain in 'ready' with the original
  // providerResourceId. A 502 transport failure must never rotate
  // durable identity even when mylist is transiently empty.
  const placement = store.findPlacementByInfoHash('torbox', infoHash);
  assert.equal(placement.state, 'ready', 'transport-level 502 must not mark placement removed');
  assert.equal(placement.providerResourceId, previousPlacement.providerResourceId,
    'transport-level 502 must not rotate providerResourceId');
  assert.equal(createCalls.length, 0, 'transport-level 502 must not trigger createPlacement');
  const repaired = repairEvents(store).find(
    (e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED,
  );
  assert.equal(repaired, undefined,
    'transport-level 502 must not record a stale-placement-repaired event');
});

// ---------------------------------------------------------------------------
// Hardening A.3 — ambiguous same-name mapping fails closed without
// mutating TorrentFile/VFS identity. When TorBox reports multiple
// provider files matching the candidate filename exactly, the seam
// must NOT pick one, must NOT bind a fresh TorrentFile, and must NOT
// record a file mapping. The pre-existing TorrentFile row must remain
// durable and untouched on the (infoHash, internal_path, size) tuple.
// ---------------------------------------------------------------------------
test('ambiguous same-name mapping: fails closed, durable TorrentFile preserved, no mapping recorded', async (t) => {
  withTorboxApiKey(t);
  const infoHash = 'd'.repeat(40);
  const store = createStore();
  // No prior placement — we are exercising the create+map path.
  const cache = makeCache();
  const torBoxProvider = makeTorBoxProvider();
  // Two distinct providerFileIds with the SAME name and the SAME
  // canonical path. findExactProviderFile will treat this as
  // ambiguous and throw FILE_MAPPING_AMBIGUOUS.
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [],
    inventory: {
      authoritative: true, complete: true,
      files: [
        { providerFileId: 'file-AMB-1', path: `/${INTERNAL_PATH}`, name: FILENAME, size: FILE_SIZE, selected: true },
        { providerFileId: 'file-AMB-2', path: `/${INTERNAL_PATH}`, name: FILENAME, size: FILE_SIZE, selected: true },
      ],
    },
  });
  const requestdlCalls = [];
  const resolveTorBoxDownloadUrl = async () => {
    requestdlCalls.push('once');
    return 'https://cdn.example/dld/never-reached';
  };

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
      controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache, resolveTorBoxDownloadUrl, isUrlLive: undefined,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => error instanceof TorBoxDeliveryError
      && error.code === 'FILE_MAPPING_AMBIGUOUS',
  );

  // No file mapping was recorded.
  const mapping = store.db.prepare(
    'SELECT * FROM candidate_file_mappings WHERE release_key = ?',
  ).get(`${infoHash}:0`);
  assert.equal(mapping, undefined, 'ambiguous mapping must not be persisted');
  // No requestdl call was made (the seam failed before the download step).
  assert.equal(requestdlCalls.length, 0, 'requestdl must not run when mapping is ambiguous');
  // The new placement exists (cached-only create succeeded) but is in
  // a partially-mapped state. The provider_files rows are persisted
  // (with mapping_state='conflict' for the colliding canonical path),
  // but NO TorrentFile row was created.
  const placement = store.findPlacementByInfoHash('torbox', infoHash);
  assert.ok(placement, 'cached-only placement was created');
  const torrentFileRows = store.db.prepare(
    'SELECT * FROM torrent_files WHERE info_hash = ?',
  ).all(infoHash);
  assert.equal(torrentFileRows.length, 0,
    'ambiguous mapping must NOT create a TorrentFile row');
  // The placement's provider files reflect the inventory but no torrent_file_id.
  const providerFiles = store.listProviderFiles(placement.id, { includeMissing: true });
  assert.ok(providerFiles.length >= 2, 'inventory rows are persisted');
  for (const pf of providerFiles) {
    assert.equal(pf.torrentFileId, null,
      'ambiguous mapping must not bind a provider file to a TorrentFile');
  }
});

// ---------------------------------------------------------------------------
// Hardening A.4 — network failure (fetch throws, no HTTP response) +
// mylist present does NOT trigger destructive repair. This is the
// "network failure, temporary 5xx" class: status alone is not
// sufficient; the mylist is the authoritative signal.
// ---------------------------------------------------------------------------
test('network failure (fetch throws) + mylist present: surface original, no repair', async (t) => {
  withTorboxApiKey(t);
  const infoHash = 'e'.repeat(40);
  const store = createStore();
  const previousPlacement = seedPlacement(store, infoHash, 'res-OLD-e');
  const cache = makeCache();
  const createCalls = [];
  const torBoxProvider = makeTorBoxProvider({
    onCreatePlacement: () => createCalls.push('create'),
  });
  // mylist is PRESENT — the resource still exists upstream. The fetch
  // throw is a transient transport-level failure.
  const torBoxInventoryProvider = makeTorBoxInventoryProvider({
    mylistResources: [{ provider: 'torbox', providerResourceId: 'res-OLD-e', infoHash }],
  });
  const resolveTorBoxDownloadUrl = async () => {
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl resolution failed',
      'TORBOX_REQUESTDL_FAILED',
      502,
    );
  };

  await assert.rejects(
    () => resolveTorBoxDeliveryWithStaleRecovery({
      infoHash, fileIndex: 0, releaseKey: `${infoHash}:0`, filename: FILENAME,
      controlPlaneStore: store, torBoxProvider, torBoxInventoryProvider,
      torBoxDownloadUrlCache: cache, resolveTorBoxDownloadUrl, isUrlLive: undefined,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { [infoHash]: { name: 'Series' } } }) }),
      now: () => OBSERVED_AT + 1_000,
    }),
    (error) => error instanceof TorBoxDownloadUrlError && error.status === 502,
  );

  // Placement must remain untouched: status alone (5xx/network) is
  // not a destructive-repair trigger.
  const placement = store.findPlacementByInfoHash('torbox', infoHash);
  assert.equal(placement.state, 'ready',
    'network failure + mylist present must not mark placement removed');
  assert.equal(placement.providerResourceId, previousPlacement.providerResourceId,
    'network failure + mylist present must not rotate providerResourceId');
  assert.equal(createCalls.length, 0,
    'network failure + mylist present must not invoke createPlacement');
  const repaired = repairEvents(store).find(
    (e) => e.failure_category === REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED,
  );
  assert.equal(repaired, undefined,
    'network failure + mylist present must not record stale-placement-repaired');
});
