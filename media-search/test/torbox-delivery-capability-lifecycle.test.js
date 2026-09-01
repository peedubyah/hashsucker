/**
 * Provider Delivery Capability Lifecycle tests.
 *
 * Verifies the smallest correct reuse layer on top of the existing
 * authoritative TorBox delivery seam. These tests exercise the
 * capability-keyed cache and the bounded invalidation contract
 * independently of any live TorBox calls.
 *
 * Production problem the tests guard against:
 *   Routine Range/seek traffic used to be able to amplify into
 *   repeated requestdl calls when the ephemeral CDN URL cache could
 *   not be evicted correctly (the legacy key was keyed by
 *   releaseKey:fileIndex but the in-memory entry was keyed by
 *   releaseKey:providerFileId). The cache now uses a provider-stable
 *   capability tuple (provider, accountScope, placementId, providerFileId)
 *   and the VFS layer invalidates on actual byte-read failure.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { resolveTorBoxDeliveryWithStaleRecovery } from '../src/lib/resolver/torbox-delivery.js';
import { TorBoxDownloadUrlError } from '../src/lib/resolver/torbox-download-url-cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { HASH } from './fixtures/torbox-response-fixtures.js';

const FILENAME = 'Capability.Lifecycle.2025.1080p.mkv';
const RELEASE_KEY = `${HASH}:0`;
const FILE_INDEX = 0;
const PLACEMENT_RESOURCE_ID = '1111111';
const PROVIDER_FILE_ID = 'file-1';
const ACCOUNT_SCOPE = 'default';
const OBSERVED_AT = 1_000;

function createStore() {
  return createControlPlaneStore({ now: () => OBSERVED_AT });
}

function seedPlacement(store) {
  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    infoHash: HASH,
    providerResourceId: PLACEMENT_RESOURCE_ID,
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'vfs-capability-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: OBSERVED_AT,
    expiresAt: OBSERVED_AT + 5 * 60_000,
  });
  store.replaceProviderFileInventory(placement.id, [
    {
      providerFileId: PROVIDER_FILE_ID,
      path: `/${FILENAME}`,
      name: FILENAME,
      size: 1_000_000,
      selected: true,
    },
  ], { authoritative: true, complete: true, observedAt: OBSERVED_AT, expiresAt: OBSERVED_AT + 5 * 60_000 });
  store.recordFileMapping({
    infoHash: HASH,
    fileIndex: FILE_INDEX,
    releaseKey: RELEASE_KEY,
    placementId: placement.id,
    providerFileId: PROVIDER_FILE_ID,
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    evidence: { candidateFilename: FILENAME, providerPath: `/${FILENAME}` },
    mappedAt: OBSERVED_AT,
  });
  return placement;
}

function capabilityFor(placement) {
  return Object.freeze({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: placement.id,
    providerFileId: PROVIDER_FILE_ID,
  });
}

function makeCapabilityCache() {
  const entries = new Map();
  const inFlight = new Map();
  return {
    entries,
    inFlight,
    getByCapability(capability) {
      const key = `${capability.provider}:${capability.accountScope}:${capability.placementId}:${capability.providerFileId}`;
      const entry = entries.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        entries.delete(key);
        return null;
      }
      return { url: entry.url, capability: entry.capability };
    },
    setByCapability(capability, url, ttlMs = 60_000) {
      const key = `${capability.provider}:${capability.accountScope}:${capability.placementId}:${capability.providerFileId}`;
      entries.set(key, { url, capability: { ...capability }, expiresAt: Date.now() + ttlMs });
    },
    invalidateByCapability(capability) {
      const key = `${capability.provider}:${capability.accountScope}:${capability.placementId}:${capability.providerFileId}`;
      entries.delete(key);
    },
    async getOrInFlightByCapability(capability, factory) {
      const key = `${capability.provider}:${capability.accountScope}:${capability.placementId}:${capability.providerFileId}`;
      const cached = this.getByCapability(capability);
      if (cached) return cached.url;
      const existing = inFlight.get(key);
      if (existing) return existing;
      try {
        const promise = factory();
        inFlight.set(key, promise);
        return await promise;
      } finally {
        inFlight.delete(key);
      }
    },
    // Legacy API stubs (unused by capability seam, but the cache shim
    // must remain fully duck-type compatible with existing tests).
    get() { return null; },
    set() {},
    delete() {},
    async getOrInFlight(_releaseKey, _providerFileId, factory) {
      return factory();
    },
    clear() { entries.clear(); inFlight.clear(); },
    size() { return entries.size; },
  };
}

function makeTorBoxProvider() {
  return {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_CREATE) {
        return {
          async createPlacement({ addOnlyIfCached }) {
            assert.equal(addOnlyIfCached, true);
            return { provider: 'torbox', providerResourceId: '9999999', infoHash: HASH };
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };
}

function makeTorBoxInventoryProvider() {
  return {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP) {
        return {
          async lookupPlacement() {
            return null;
          },
        };
      }
      if (capability === PROVIDER_CAPABILITIES.FILE_INVENTORY) {
        return {
          async getFileInventory() {
            return {
              files: [{ providerFileId: PROVIDER_FILE_ID, path: `/${FILENAME}`, name: FILENAME, size: 1_000_000 }],
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

function runResolveWith(requestdlImpl, cache, store) {
  const previousApiKey = process.env.TORBOX_API_KEY;
  process.env.TORBOX_API_KEY = 'test-key';
  return resolveTorBoxDeliveryWithStaleRecovery({
    infoHash: HASH,
    fileIndex: FILE_INDEX,
    releaseKey: RELEASE_KEY,
    filename: FILENAME,
    controlPlaneStore: store,
    torBoxProvider: makeTorBoxProvider(),
    torBoxInventoryProvider: makeTorBoxInventoryProvider(),
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl: requestdlImpl,
    isUrlLive: undefined,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { [HASH]: { name: FILENAME } } }),
    }),
    now: () => OBSERVED_AT + 1_000,
  }).finally(() => {
    if (previousApiKey == null) delete process.env.TORBOX_API_KEY;
    else process.env.TORBOX_API_KEY = previousApiKey;
  });
}

// ---------------------------------------------------------------------------
// 1. Two sequential reads → ONE requestdl resolution.
// ---------------------------------------------------------------------------
test('capability lifecycle: two sequential reads share one requestdl resolution', async () => {
  const store = createStore();
  seedPlacement(store);
  const cache = makeCapabilityCache();

  const requestdlCalls = [];
  const requestdl = async (permalink) => {
    requestdlCalls.push(permalink);
    return `https://cdn.example/${requestdlCalls.length}`;
  };

  const first = await runResolveWith(requestdl, cache, store);
  const second = await runResolveWith(requestdl, cache, store);

  assert.equal(requestdlCalls.length, 1, 'second read must reuse cached capability');
  assert.equal(first.url, second.url, 'both reads must observe the same resolved URL');
  assert.equal(first.placementId, second.placementId);
  assert.equal(first.providerFileId, second.providerFileId);
  assert.equal(cache.size(), 1, 'one cache entry persisted');
});

// ---------------------------------------------------------------------------
// 2. Concurrent reads → ONE in-flight requestdl resolution.
// ---------------------------------------------------------------------------
test('capability lifecycle: concurrent reads share one in-flight requestdl resolution', async () => {
  const store = createStore();
  seedPlacement(store);
  const cache = makeCapabilityCache();

  const requestdlCalls = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const requestdl = async (permalink) => {
    requestdlCalls.push(permalink);
    // Hold the in-flight factory open until we have confirmed there is
    // exactly one concurrent caller waiting on the single-flight seam.
    await barrier;
    return 'https://cdn.example/concurrent';
  };

  const p1 = runResolveWith(requestdl, cache, store);
  const p2 = runResolveWith(requestdl, cache, store);
  const p3 = runResolveWith(requestdl, cache, store);

  // Let all three callers reach the seam before releasing.
  await new Promise((r) => setImmediate(r));
  assert.equal(requestdlCalls.length, 1, 'single-flight must collapse concurrent callers');
  release();

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.url, r2.url);
  assert.equal(r2.url, r3.url);
  assert.equal(requestdlCalls.length, 1, 'no extra requestdl under concurrency');
});

// ---------------------------------------------------------------------------
// 3. Cached capability reuse across a separate resolver call path.
// ---------------------------------------------------------------------------
test('capability lifecycle: explicit cache.set is reused by a later resolver call', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = makeCapabilityCache();

  // Pre-populate the cache to simulate a previous resolver call having
  // already minted a fresh capability.
  cache.setByCapability(capabilityFor(placement), 'https://cdn.example/preset');

  const requestdlCalls = [];
  const requestdl = async (permalink) => {
    requestdlCalls.push(permalink);
    return 'https://cdn.example/factory';
  };

  const result = await runResolveWith(requestdl, cache, store);

  assert.equal(requestdlCalls.length, 0, 'pre-set capability must short-circuit requestdl');
  assert.equal(result.url, 'https://cdn.example/preset');
});

// ---------------------------------------------------------------------------
// 4. Invalid capability → invalidate + one re-resolution.
// ---------------------------------------------------------------------------
test('capability lifecycle: invalidateByCapability triggers one fresh requestdl on next read', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = makeCapabilityCache();

  const requestdlCalls = [];
  let seq = 0;
  const requestdl = async (permalink) => {
    requestdlCalls.push(permalink);
    seq += 1;
    return `https://cdn.example/resolve-${seq}`;
  };

  // First resolution populates the cache.
  const first = await runResolveWith(requestdl, cache, store);
  assert.equal(requestdlCalls.length, 1);
  assert.equal(first.url, 'https://cdn.example/resolve-1');

  // Caller observes the cached URL is no longer valid (e.g., upstream
  // 403/404 on a byte read) and invalidates by capability.
  cache.invalidateByCapability(capabilityFor(placement));

  // The next resolver call must mint exactly one fresh requestdl.
  const second = await runResolveWith(requestdl, cache, store);
  assert.equal(requestdlCalls.length, 2, 'invalidation must allow exactly one re-resolution');
  assert.equal(second.url, 'https://cdn.example/resolve-2');
});

// ---------------------------------------------------------------------------
// 5. requestdl 429 → no retry storm; surface typed rate-limit error.
// ---------------------------------------------------------------------------
test('capability lifecycle: requestdl 429 is not retried by the seam', async () => {
  const store = createStore();
  seedPlacement(store);
  const cache = makeCapabilityCache();

  const requestdlCalls = [];
  const requestdl = async (permalink) => {
    requestdlCalls.push(permalink);
    const error = new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 429',
      'TORBOX_REQUESTDL_RATE_LIMITED',
      429,
      { retryAfterMs: 30_000 },
    );
    throw error;
  };

  await assert.rejects(
    () => runResolveWith(requestdl, cache, store),
    (error) => {
      assert.ok(error instanceof TorBoxDownloadUrlError);
      assert.equal(error.code, 'TORBOX_REQUESTDL_RATE_LIMITED');
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    },
  );

  assert.equal(requestdlCalls.length, 1, 'no retry storm — one 429 surfaces immediately');
  assert.equal(cache.size(), 0, '429 must not populate the cache');
});

test('capability lifecycle: 429 honors Retry-After when present in upstream headers', async () => {
  const store = createStore();
  seedPlacement(store);
  const cache = makeCapabilityCache();

  const headers = new Map([['retry-after', '45']]);
  const fakeResponse = {
    status: 429,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    body: null,
  };
  const fetchFn = async () => fakeResponse;
  const resolveTorBoxDownloadUrl = (await import('../src/lib/resolver/torbox-download-url-cache.js')).resolveTorBoxDownloadUrl;

  await assert.rejects(
    () => resolveTorBoxDownloadUrl('https://api.torbox.example/requestdl', { fetchFn }),
    (error) => {
      assert.equal(error.code, 'TORBOX_REQUESTDL_RATE_LIMITED');
      assert.equal(error.retryAfterMs, 45_000);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 6. Process-local cache only — no durable URL identity persists.
// ---------------------------------------------------------------------------
test('capability lifecycle: cache is process-local; set/get do not write to durable storage', async () => {
  const store = createStore();
  seedPlacement(store);
  const cache = makeCapabilityCache();

  const requestdlCalls = [];
  const requestdl = async (permalink) => {
    requestdlCalls.push(permalink);
    return 'https://cdn.example/lifecycle-test';
  };

  await runResolveWith(requestdl, cache, store);

  // The control plane must NOT contain any resolved URL — only the
  // canonical requestdl permalink and provider identity metadata.
  const dbRows = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%url%' OR name LIKE '%cdn%' OR name LIKE '%capability%'",
  ).all();
  assert.deepEqual(dbRows, [], 'no durable storage table for ephemeral URLs');

  // The provider_placements table must NOT contain any URL-shaped column.
  const placementSchema = store.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_placements'",
  ).get();
  assert.ok(placementSchema?.sql, 'provider_placements table expected');
  assert.equal(
    /url|cdn|capability/i.test(placementSchema.sql),
    false,
    'provider_placements schema must not persist ephemeral URLs',
  );
});