import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { ProviderOperationError } from '../src/lib/providers/errors.js';
import { createRealDebridProvider } from '../src/lib/providers/realdebrid.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

function fullGateway(overrides = {}) {
  return {
    async lookupPlacement() {
      return { providerResourceId: 'rd-resource-1', state: 'ready' };
    },
    async createPlacement() {
      return { providerResourceId: 'rd-resource-2', state: 'pending', created: true };
    },
    async observeReadiness() {
      return { state: 'ready' };
    },
    async getFileInventory() {
      return {
        authoritative: true,
        complete: true,
        files: [{
          providerFileId: 'rd-file-9', path: '/Release/movie.mkv', name: 'movie.mkv',
          size: 1000, selected: true, corpusFileIndex: 0,
        }],
      };
    },
    ...overrides,
  };
}

test('Real-Debrid adapter exposes only independently injected gateway capabilities', () => {
  const adapter = createRealDebridProvider({
    accountScope: 'primary',
    gateway: { lookupPlacement: fullGateway().lookupPlacement },
  });

  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP), true);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.PLACEMENT_CREATE), false);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.RESOURCE_READINESS), false);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.FILE_INVENTORY), false);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.EXPOSURE), false);
});

test('Real-Debrid lookup normalizes external torrent-level placement authority', async () => {
  let request;
  const adapter = createRealDebridProvider({
    accountScope: 'primary', now: () => 10_000, observationTtlMs: 2_000,
    gateway: { async lookupPlacement(input) { request = input; return { providerResourceId: 'rd-7', state: 'ready' }; } },
  });

  const placement = await adapter.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP)
    .lookupPlacement({ infoHash: HASH, fileIndex: 0 });

  assert.equal(request.infoHash, HASH);
  assert.equal(request.fileIndex, null);
  assert.equal(placement.provider, 'realdebrid');
  assert.equal(placement.providerResourceId, 'rd-7');
  assert.equal(placement.ownership, 'external');
  assert.equal(placement.expiresAt, 12_000);
});

test('Real-Debrid placement creation requires ownership and idempotency evidence', async () => {
  let request;
  const adapter = createRealDebridProvider({
    now: () => 10_000,
    gateway: fullGateway({
      async createPlacement(input) {
        request = input;
        return { providerResourceId: 'rd-8', state: 'pending', created: true };
      },
    }),
  });
  const capability = adapter.require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE);

  await assert.rejects(() => capability.createPlacement({ infoHash: HASH }), /ownerKey/);
  const placement = await capability.createPlacement({
    infoHash: HASH, ownerKey: 'library-item-1', idempotencyKey: `realdebrid:${HASH}`,
  });

  assert.equal(request.magnetUri, `magnet:?xt=urn:btih:${HASH}`);
  assert.equal(placement.ownership, 'owned');
  assert.equal(placement.ownerKey, 'library-item-1');
  assert.equal(placement.idempotencyKey, `realdebrid:${HASH}`);
});

test('Real-Debrid reused placement never claims ownership', async () => {
  const adapter = createRealDebridProvider({
    gateway: fullGateway({
      async createPlacement() {
        return { providerResourceId: 'rd-existing', state: 'ready', created: false };
      },
    }),
  });

  const placement = await adapter.require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
    .createPlacement({ infoHash: HASH, ownerKey: 'owner', idempotencyKey: 'key' });
  assert.equal(placement.ownership, 'reused');
  assert.equal(placement.ownerKey, null);
});

test('Real-Debrid readiness and inventory preserve opaque provider identities', async () => {
  const adapter = createRealDebridProvider({ gateway: fullGateway(), now: () => 20_000 });
  const readiness = await adapter.require(PROVIDER_CAPABILITIES.RESOURCE_READINESS)
    .observeReadiness({ infoHash: HASH, providerResourceId: 'rd-resource-1', ownership: 'external' });
  const inventory = await adapter.require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
    .getFileInventory({ providerResourceId: 'rd-resource-1' });

  assert.equal(readiness.state, 'ready');
  assert.equal(readiness.providerResourceId, 'rd-resource-1');
  assert.equal(inventory.authoritative, true);
  assert.equal(inventory.complete, true);
  assert.equal(inventory.files[0].providerFileId, 'rd-file-9');
  assert.equal(inventory.files[0].corpusFileIndex, 0);
});

test('Real-Debrid gateway errors are typed and malformed results fail closed', async () => {
  const authAdapter = createRealDebridProvider({
    gateway: { async lookupPlacement() { throw Object.assign(new Error('bad token'), { status: 401 }); } },
  });
  await assert.rejects(
    () => authAdapter.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP).lookupPlacement({ infoHash: HASH }),
    (error) => error instanceof ProviderOperationError && error.category === 'authentication',
  );

  const malformedAdapter = createRealDebridProvider({
    gateway: { async getFileInventory() { return { complete: true }; } },
  });
  await assert.rejects(
    () => malformedAdapter.require(PROVIDER_CAPABILITIES.FILE_INVENTORY)
      .getFileInventory({ providerResourceId: 'rd-resource-1' }),
    (error) => error instanceof ProviderOperationError && error.category === 'invalid-response',
  );
});
