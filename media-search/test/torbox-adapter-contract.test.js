import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { createTorBoxProvider } from '../src/lib/providers/torbox.js';
import { createTorBoxInventoryProvider } from '../src/lib/providers/torbox-inventory.js';
import {
  HASH,
  OTHER_HASH,
  checkcachedHit,
  checkcachedMiss,
  checkcachedMixed,
  checkcachedAuthError,
  checkcachedServiceError,
  mylistResource,
  mylistEmpty,
} from './fixtures/torbox-response-fixtures.js';

const NOW = 20_000;

/**
 * Wrap a raw API payload in a Response-like object, matching the shape
 * expected by checkTorBoxCached / getSnapshot.
 */
function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

/**
 * Slice 1D contract verification: the existing TorBox adapters already satisfy
 * the adapter boundary. This test proves the contract using fixture-shaped
 * responses — no new adapter code is required.
 */

// ---------------------------------------------------------------------------
// Torrent cache observation — checkcached → torrent-scoped cache observation
// ---------------------------------------------------------------------------

test('checkcached hit → authoritative torrent-scoped cached observation', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    cacheObservationTtlMs: 2_000,
    fetchFn: async () => response(checkcachedHit(HASH)),
  });

  const [obs] = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.equal(obs.provider, 'torbox');
  assert.equal(obs.accountScope, 'primary');
  assert.equal(obs.scope, 'torrent');
  assert.equal(obs.fileIndex, null);
  assert.equal(obs.kind, 'authoritative');
  assert.equal(obs.state, 'cached');
  assert.equal(obs.observedAt, NOW);
  assert.equal(obs.expiresAt, NOW + 2_000);
  assert.equal(obs.source, 'torbox-checkcached');
  assert.ok(Object.isFrozen(obs));
});

test('checkcached miss → authoritative torrent-scoped uncached observation', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    cacheObservationTtlMs: 2_000,
    fetchFn: async () => response(checkcachedMiss()),
  });

  const [obs] = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.equal(obs.state, 'uncached');
  assert.equal(obs.scope, 'torrent');
  assert.equal(obs.fileIndex, null);
});

test('checkcached mixed → per-hash cached/uncached', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedMixed(HASH, OTHER_HASH)),
  });

  const obs = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }, { infoHash: OTHER_HASH }]);

  assert.deepEqual(obs.map((o) => o.state), ['cached', 'uncached']);
  assert.ok(obs.every((o) => o.scope === 'torrent'));
  assert.ok(obs.every((o) => o.fileIndex === null));
});

test('checkcached service error → unknown with retryable', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedServiceError(), 503),
  });

  const [obs] = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.equal(obs.state, 'unknown');
  assert.equal(obs.retryable, true);
  assert.equal(obs.scope, 'torrent');
});

test('checkcached auth error → error observation with category', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'bad-token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedAuthError(), 401),
  });

  const [obs] = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.equal(obs.state, 'error');
  assert.equal(obs.errorCategory, 'authentication');
  assert.equal(obs.retryable, false);
  assert.equal(obs.scope, 'torrent');
});

test('checkcached never emits file-level candidate observations', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedHit(HASH)),
  });

  const obs = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([
      { infoHash: HASH, fileIndex: 0 },
      { infoHash: HASH, fileIndex: null },
    ]);

  assert.ok(obs.every((o) => o.scope === 'torrent'));
  assert.ok(obs.every((o) => o.fileIndex === null));
  assert.ok(obs.every((o) => o.subjectType === 'torrent'));
});

// ---------------------------------------------------------------------------
// File inventory observation — mylist → inventory scope only
// ---------------------------------------------------------------------------

test('mylist resource → inventory observation with opaque file IDs', async () => {
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    accountScope: 'primary',
    now: () => NOW,
    observationTtlMs: 5_000,
    fetchFn: async () => response({ success: true, data: [mylistResource()] }),
  });

  const inventory = await adapter
    .require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
    .getFileInventory({ providerResourceId: '77' });

  assert.equal(inventory.provider, 'torbox');
  assert.equal(inventory.accountScope, 'primary');
  assert.equal(inventory.providerResourceId, '77');
  assert.equal(inventory.authoritative, true);
  assert.deepEqual(inventory.files.map((f) => f.providerFileId), ['900', '901']);
  assert.deepEqual(inventory.files.map((f) => f.corpusFileIndex), [null, null]);
  assert.equal(inventory.observedAt, NOW);
  assert.equal(inventory.expiresAt, NOW + 5_000);
});

test('mylist empty → not-found for unknown providerResourceId', async () => {
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(mylistEmpty()),
  });

  await assert.rejects(
    () => adapter.require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
      .getFileInventory({ providerResourceId: '77' }),
    (error) => error.category === 'not-found' && error.provider === 'torbox',
  );
});

test('inventory never maps TorBox file IDs to corpus fileIndex', async () => {
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response({ success: true, data: [mylistResource()] }),
  });

  const inventory = await adapter
    .require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
    .getFileInventory({ providerResourceId: '77' });

  for (const file of inventory.files) {
    assert.equal(file.corpusFileIndex, null, 'corpusFileIndex must remain null');
    assert.ok(file.providerFileId, 'providerFileId preserved as opaque');
  }
});

test('inventory is not a cache observation — no scope/state leakage', async () => {
  const adapter = createTorBoxInventoryProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response({ success: true, data: [mylistResource()] }),
  });

  const inventory = await adapter
    .require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
    .getFileInventory({ providerResourceId: '77' });

  // Inventory has no cache-observation fields
  assert.equal(inventory.state, undefined);
  assert.equal(inventory.scope, undefined);
  assert.equal(inventory.infoHash, undefined);
});

// ---------------------------------------------------------------------------
// Provider/account isolation preserved
// ---------------------------------------------------------------------------

test('different account scopes produce independent observations', async () => {
  const makeAdapter = (accountScope) => createTorBoxProvider({
    accountScope,
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedHit(HASH)),
  });

  const [obsA] = await makeAdapter('primary')
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);
  const [obsB] = await makeAdapter('secondary')
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.equal(obsA.accountScope, 'primary');
  assert.equal(obsB.accountScope, 'secondary');
});
