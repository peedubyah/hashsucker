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
