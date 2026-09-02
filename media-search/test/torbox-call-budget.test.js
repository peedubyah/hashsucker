/**
 * Slice 2.7 — Provider API Efficiency.
 *
 * Budget + coordinator behavior, in isolation, with fake fetch
 * implementations. No external network. No real timers.
 *
 * The tests exercise three properties:
 *
 *   1. Bounded retry: a 5xx on the first mylist attempt is retried
 *      once (maxRetries=1), yielding exactly 2 fetches before the
 *      second attempt succeeds.
 *
 *   2. Single-flight per request: concurrent `lookupPlacement` and
 *      `getFileInventory` calls within the same request scope share
 *      one HTTP fetch. The second caller is served from the
 *      coordinator's memoized promise.
 *
 *   3. Delivery-lifecycle reuse: a cached-only placement
 *      (createtorrent POST + mylist snapshot reused for both lookup
 *      and inventory) uses exactly 1 mylist fetch total, not 2 or 3.
 *
 *   4. Budget hygiene: counters are accurate, snapshot is stable,
 *     and detach() makes future updates no-ops.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { createTorBoxInventoryProvider } from '../src/lib/providers/torbox-inventory.js';
import { TorBoxCallBudget } from '../src/lib/providers/torbox-call-budget.js';
import { TorBoxCallCoordinator } from '../src/lib/providers/torbox-call-coordinator.js';

const API_BASE = 'https://api.torbox.app/v1/api';
const API_KEY = 'test-api-key';
const INFO_HASH = 'a'.repeat(40);
const PROVIDER_RESOURCE_ID = '12345';

function makeMylistPayload(resources = []) {
  return { success: true, data: resources };
}

function makeMylistResource({ id = PROVIDER_RESOURCE_ID, hash = INFO_HASH, files = [] } = {}) {
  return {
    id,
    hash,
    download_state: 'cached',
    download_finished: true,
    files: files.map((f, i) => ({
      id: f.id ?? `file-${i}`,
      name: f.name,
      size: f.size ?? 1024,
      selected: f.selected ?? true,
    })),
  };
}

function makeFile({ name, size = 1024, id } = {}) {
  return { id, name, size, selected: true };
}

/**
 * Build a fake fetch implementation that walks a queue of responses.
 * Each entry is either a Response-shaped object (for success) or an
 * Error-shaped object (for failure). One entry is consumed per call.
 */
function makeFakeFetch(responses) {
  const calls = [];
  let index = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (index >= responses.length) {
      throw new Error(`fakeFetch: no more queued responses (call ${index + 1})`);
    }
    const next = responses[index++];
    if (next instanceof Error) throw next;
    if (next && typeof next.status === 'number' && next.status >= 400) {
      const err = new Error(`HTTP ${next.status}`);
      err.status = next.status;
      throw err;
    }
    return next;
  };
  fn.calls = calls;
  fn.consumed = () => index;
  return fn;
}

function makeOkResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function makeErrorResponse(status, body = null) {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  return err;
}

/**
 * Build a fake sleep that advances deterministically without waiting
 * real wall-clock time. Records every requested delay.
 */
function makeFakeSleep() {
  const delays = [];
  const fn = async (ms) => {
    delays.push(ms);
    // No real time. The promise resolves on next microtask.
    return Promise.resolve();
  };
  fn.delays = delays;
  return fn;
}

function buildCoordinator({ maxRetries = 1, retryDelayMs = 0, scope = 'unit-test' } = {}) {
  const budget = new TorBoxCallBudget({ scope });
  const sleep = makeFakeSleep();
  const coordinator = new TorBoxCallCoordinator({
    scope,
    budget,
    maxRetries,
    retryDelayMs: () => retryDelayMs,
    sleep,
  });
  return { coordinator, budget, sleep };
}

function buildProvider({ coordinator, fetchFn } = {}) {
  return createTorBoxInventoryProvider({
    apiKey: API_KEY,
    apiBase: API_BASE,
    fetchFn,
    coordinator,
  });
}

// ---------------------------------------------------------------------------
// 1) Budget: per-operation counter hygiene
// ---------------------------------------------------------------------------

test('budget: starts with zero counters across all known operations', () => {
  const budget = new TorBoxCallBudget({ scope: 'snapshot' });
  const snap = budget.snapshot();
  assert.equal(snap.scope, 'snapshot');
  assert.equal(snap.detached, false);
  for (const op of ['mylist', 'checkcached', 'createtorrent', 'other']) {
    const c = snap.operations[op];
    assert.equal(c.fetches, 0, `${op}.fetches`);
    assert.equal(c.retries, 0, `${op}.retries`);
    assert.equal(c.inflight, 0, `${op}.inflight`);
    assert.equal(c.hits, 0, `${op}.hits`);
    assert.equal(c.misses, 0, `${op}.misses`);
    assert.equal(c.failures, 0, `${op}.failures`);
  }
  assert.equal(budget.totalFetches(), 0);
});

test('budget: recordFetchStart + recordFetchEnd reflects a single successful call', () => {
  const budget = new TorBoxCallBudget({ scope: 'success' });
  const start = budget.recordFetchStart('mylist');
  assert.equal(budget.snapshot().operations.mylist.fetches, 1);
  assert.equal(budget.snapshot().operations.mylist.inflight, 1);
  budget.recordFetchEnd('mylist', { startedAt: start, error: null });
  const c = budget.snapshot().operations.mylist;
  assert.equal(c.fetches, 1);
  assert.equal(c.inflight, 0);
  assert.equal(c.failures, 0);
});

test('budget: retry flag increments both fetches and retries', () => {
  const budget = new TorBoxCallBudget({ scope: 'retry' });
  budget.recordFetchStart('mylist', { retry: false });
  budget.recordFetchEnd('mylist', { error: null });
  budget.recordFetchStart('mylist', { retry: true });
  budget.recordFetchEnd('mylist', { error: null });
  const c = budget.snapshot().operations.mylist;
  assert.equal(c.fetches, 2);
  assert.equal(c.retries, 1);
  assert.equal(c.failures, 0);
});

test('budget: detach() makes subsequent calls no-ops', () => {
  const budget = new TorBoxCallBudget({ scope: 'detach' });
  budget.recordFetchStart('mylist');
  budget.detach();
  assert.equal(budget.snapshot().detached, true);
  budget.recordFetchStart('mylist');
  budget.recordHit('mylist');
  budget.recordMiss('mylist');
  assert.equal(budget.totalFetches(), 1, 'pre-detach fetch should still be counted');
  // No new counters, no errors.
  assert.equal(budget.snapshot().operations.mylist.fetches, 1);
  assert.equal(budget.snapshot().operations.mylist.hits, 0);
  assert.equal(budget.snapshot().operations.mylist.misses, 0);
});

test('budget: rejects unknown operation', () => {
  const budget = new TorBoxCallBudget({ scope: 'unknown-op' });
  assert.throws(() => budget.recordFetchStart('not-a-real-op'), /Unknown TorBox call operation/);
});

// ---------------------------------------------------------------------------
// 2) Coordinator: single-flight + memoization
// ---------------------------------------------------------------------------

test('coordinator: same args share a single fetch (single-flight)', async () => {
  const { coordinator, budget } = buildCoordinator({ scope: 'single-flight' });
  let fetchCalls = 0;
  const fetcher = async () => {
    fetchCalls += 1;
    return makeMylistPayload([makeMylistResource()]);
  };
  const [a, b, c] = await Promise.all([
    coordinator.run('mylist', [API_BASE, API_KEY, null], fetcher),
    coordinator.run('mylist', [API_BASE, API_KEY, null], fetcher),
    coordinator.run('mylist', [API_BASE, API_KEY, null], fetcher),
  ]);
  assert.equal(fetchCalls, 1);
  assert.equal(budget.snapshot().operations.mylist.fetches, 1);
  assert.equal(budget.snapshot().operations.mylist.misses, 1);
  // Two of the three callers are hits, not misses.
  assert.equal(budget.snapshot().operations.mylist.hits, 2);
  assert.equal(a.observedAt, b.observedAt);
  assert.equal(b.observedAt, c.observedAt);
});

test('coordinator: different args issue separate fetches', async () => {
  const { coordinator, budget } = buildCoordinator({ scope: 'distinct-args' });
  let fetchCalls = 0;
  const fetcher = async (key) => {
    fetchCalls += 1;
    return makeMylistPayload(key === 'A' ? [makeMylistResource({ id: 'A' })] : [makeMylistResource({ id: 'B' })]);
  };
  await coordinator.run('mylist', ['A'], fetcher);
  await coordinator.run('mylist', ['B'], fetcher);
  assert.equal(fetchCalls, 2);
  assert.equal(budget.snapshot().operations.mylist.fetches, 2);
  assert.equal(budget.snapshot().operations.mylist.misses, 2);
  assert.equal(budget.snapshot().operations.mylist.hits, 0);
});

// ---------------------------------------------------------------------------
// 3) Inventory provider: 5xx retry is bounded (maxRetries=1) → 2 total fetches
// ---------------------------------------------------------------------------

test('inventory: 5xx on mylist retries bounded (maxRetries=1) → 2 total fetches', async () => {
  const fakeFetch = makeFakeFetch([
    makeErrorResponse(503),                       // original → 5xx
    makeOkResponse(makeMylistPayload([            // retry → success
      makeMylistResource({
        files: [makeFile({ name: 'movie.mkv' })],
      }),
    ])),
  ]);

  const { coordinator, budget, sleep } = buildCoordinator({
    scope: 'inventory-5xx-retry',
    maxRetries: 1,
    retryDelayMs: 0,
  });

  const provider = buildProvider({ coordinator, fetchFn: fakeFetch });
  const lookup = provider.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP);
  const placement = await lookup.lookupPlacement({ infoHash: INFO_HASH });

  assert.equal(fakeFetch.consumed(), 2, 'expected exactly 1 original + 1 retry');
  assert.equal(placement.providerResourceId, PROVIDER_RESOURCE_ID);
  assert.equal(placement.infoHash, INFO_HASH);

  const c = budget.snapshot().operations.mylist;
  assert.equal(c.fetches, 2);
  assert.equal(c.retries, 1);
  assert.equal(c.misses, 1, 'one coordinator-level miss for the whole request');
  assert.equal(c.hits, 0, 'no other caller; retry is part of the same slot');
  assert.equal(c.failures, 0, 'final attempt succeeded; no recorded failure');
  // retryDelayMs=0 means the sleep fn should never have been called for a non-zero delay.
  assert.ok(sleep.delays.every((d) => d === 0), 'all delays should be 0 for retryDelayMs=0');
});

test('inventory: 5xx on every attempt with maxRetries=1 → 2 fetches, error surfaces', async () => {
  const fakeFetch = makeFakeFetch([
    makeErrorResponse(500),
    makeErrorResponse(502),
  ]);

  const { coordinator, budget } = buildCoordinator({
    scope: 'inventory-5xx-exhausted',
    maxRetries: 1,
    retryDelayMs: 0,
  });

  const provider = buildProvider({ coordinator, fetchFn: fakeFetch });
  const lookup = provider.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP);

  let caught;
  try {
    await lookup.lookupPlacement({ infoHash: INFO_HASH });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected lookupPlacement to reject');
  assert.equal(caught.cause?.status, 502, 'final error cause should preserve the last response status');
  assert.equal(caught.category, 'temporarily-unavailable', '5xx should classify as temporarily-unavailable');

  assert.equal(fakeFetch.consumed(), 2, 'expected 1 original + 1 retry');
  const c = budget.snapshot().operations.mylist;
  assert.equal(c.fetches, 2);
  assert.equal(c.retries, 1);
  assert.equal(c.failures, 1, 'final settled state was a failure');
});

test('inventory: 4xx on mylist is NOT retried (not retryable) → 1 fetch only', async () => {
  const fakeFetch = makeFakeFetch([
    makeErrorResponse(401), // auth error, not retryable
  ]);

  const { coordinator, budget } = buildCoordinator({
    scope: 'inventory-4xx',
    maxRetries: 1,
    retryDelayMs: 0,
  });

  const provider = buildProvider({ coordinator, fetchFn: fakeFetch });
  const lookup = provider.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP);

  let caught;
  try {
    await lookup.lookupPlacement({ infoHash: INFO_HASH });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected lookupPlacement to reject');
  assert.equal(caught.category, 'authentication', '4xx 401 should classify as authentication');

  assert.equal(fakeFetch.consumed(), 1, '4xx must not be retried');
  const c = budget.snapshot().operations.mylist;
  assert.equal(c.fetches, 1);
  assert.equal(c.retries, 0);
  assert.equal(c.failures, 1);
});

// ---------------------------------------------------------------------------
// 4) Inventory provider: single-flight across capabilities in one lifecycle
// ---------------------------------------------------------------------------

test('delivery lifecycle: cached-only → 1 placement-create, mylist used for lookup+inventory', async () => {
  // Two different endpoints: createtorrent (POST) + mylist (GET) used for both
  // lookup AND inventory. The key assertion: only 1 mylist fetch for the
  // entire request, because lookup and inventory share the same snapshot.
  // Note: placement-create is owned by the cache-observation provider
  // (torbox.js), not the inventory provider. The lifecycle uses both.
  let mylistCalls = 0;
  let createCalls = 0;
  const fakeFetch = async (url, init) => {
    if (init?.method === 'POST') {
      createCalls += 1;
      return makeOkResponse({
        success: true,
        data: { torrent_id: PROVIDER_RESOURCE_ID, hash: INFO_HASH, filename: 'cached-release' },
      });
    }
    if (url.includes('/torrents/mylist')) {
      mylistCalls += 1;
      return makeOkResponse(makeMylistPayload([
        makeMylistResource({
          files: [makeFile({ name: 'episode.mkv' })],
        }),
      ]));
    }
    throw new Error(`Unexpected URL in fakeFetch: ${url}`);
  };

  const { coordinator, budget } = buildCoordinator({
    scope: 'delivery-lifecycle',
    maxRetries: 1,
    retryDelayMs: 0,
  });

  // Step A: placement-create (POST). This is NOT mylist; do not count it.
  // The cache-observation provider owns PLACEMENT_CREATE.
  const { createTorBoxProvider } = await import('../src/lib/providers/torbox.js');
  const create = createTorBoxProvider({
    apiKey: API_KEY,
    apiBase: API_BASE,
    fetchFn: fakeFetch,
  });
  const placementResult = await create
    .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
    .createPlacement({
      magnet: `magnet:?xt=urn:btih:${INFO_HASH}`,
      addOnlyIfCached: true,
    });
  assert.equal(placementResult.providerResourceId, PROVIDER_RESOURCE_ID);
  assert.equal(createCalls, 1);

  // Step B: build a placement shape the inventory capability expects.
  const placement = {
    provider: 'torbox',
    accountScope: 'default',
    infoHash: INFO_HASH,
    providerResourceId: PROVIDER_RESOURCE_ID,
    ownership: 'external',
    ownerKey: null,
  };

  // Step C: lookupPlacement (1st mylist use) + getFileInventory (2nd mylist use).
  // With the per-request coordinator, these must share one mylist fetch.
  const provider = buildProvider({ coordinator, fetchFn: fakeFetch });
  const lookup = provider.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP);
  const inventory = provider.require(PROVIDER_CAPABILITIES.FILE_INVENTORY);

  const looked = await lookup.lookupPlacement({ infoHash: INFO_HASH });
  assert.equal(looked.providerResourceId, PROVIDER_RESOURCE_ID);

  const inv = await inventory.getFileInventory(placement, {});
  assert.equal(inv.files.length, 1);
  assert.equal(inv.files[0].name, 'episode.mkv');

  // ASSERTION: exactly 1 mylist fetch across the entire delivery lifecycle.
  assert.equal(mylistCalls, 1, 'expected mylist to be called exactly once per request');
  assert.equal(createCalls, 1, 'expected createtorrent to be called exactly once');

  // Budget reflects the lifecycle: 1 mylist miss, 1 mylist hit (lookup was
  // the miss, inventory was the hit). The createtorrent POST is not
  // tracked through the inventory coordinator (it goes through
  // torbox.js / createPlacement directly).
  const c = budget.snapshot().operations.mylist;
  assert.equal(c.fetches, 1);
  assert.equal(c.misses, 1);
  assert.equal(c.hits, 1);
  assert.equal(c.failures, 0);
});

test('delivery lifecycle: mylist hit short-circuits second inventory read', async () => {
  // Two sequential inventory reads on the same request scope must not
  // produce two mylist fetches. The first populates the coordinator;
  // the second is served from memoization.
  const fakeFetch = makeFakeFetch([
    makeOkResponse(makeMylistPayload([
      makeMylistResource({ files: [makeFile({ name: 'movie.mkv' })] }),
    ])),
  ]);

  const { coordinator, budget } = buildCoordinator({
    scope: 'sequential-inventory',
    maxRetries: 1,
    retryDelayMs: 0,
  });
  const provider = buildProvider({ coordinator, fetchFn: fakeFetch });

  const inventory = provider.require(PROVIDER_CAPABILITIES.FILE_INVENTORY);
  const placement = {
    provider: 'torbox',
    accountScope: 'default',
    infoHash: INFO_HASH,
    providerResourceId: PROVIDER_RESOURCE_ID,
  };

  const first = await inventory.getFileInventory(placement, {});
  const second = await inventory.getFileInventory(placement, {});

  assert.equal(fakeFetch.consumed(), 1);
  assert.equal(first.files[0].name, 'movie.mkv');
  assert.equal(second.files[0].name, 'movie.mkv');
  assert.equal(budget.snapshot().operations.mylist.fetches, 1);
  assert.equal(budget.snapshot().operations.mylist.hits, 1);
  assert.equal(budget.snapshot().operations.mylist.misses, 1);
});
