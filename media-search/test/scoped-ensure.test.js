import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { buildRequestScopedEnsureFn } from '../src/lib/requests/scoped-ensure.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

function mylistResponse(data) {
  return { ok: true, status: 200, async json() { return { success: true, data }; } };
}
function resource() {
  return {
    id: 99, hash: HASH, name: 'Release', download_state: 'completed',
    files: [{ id: 900, name: 'Release/movie.mkv', size: 1000, selected: true }],
  };
}
function stubStore() {
  return {
    findPlacementByInfoHash: () => null,
    recordPlacement: () => ({ id: 'pl1', providerResourceId: '99' }),
    recordPlacementLookupObservation: () => ({}),
    replaceProviderFileInventory: () => [],
    listTorrentFilesForRelease: () => [{ id: 'tf1' }],
    getProviderInventorySnapshot: () => null,
  };
}
function stubTorBoxProvider() {
  return {
    supports: (cap) => cap === PROVIDER_CAPABILITIES.PLACEMENT_CREATE,
    require: () => ({ createPlacement: async () => ({ providerResourceId: '99' }) }),
  };
}

test('scoped ensure falls back unchanged when scoping is unavailable', () => {
  const fallback = () => 'fallback';
  assert.equal(buildRequestScopedEnsureFn({ fallbackFn: fallback }), fallback);
  assert.equal(
    buildRequestScopedEnsureFn({ fallbackFn: fallback, controlPlaneStore: stubStore() }),
    fallback,
  );
  assert.equal(
    buildRequestScopedEnsureFn({
      fallbackFn: fallback, controlPlaneStore: stubStore(),
      torBoxProvider: stubTorBoxProvider(), apiKey: 'k', explicitFn: true,
    }),
    fallback,
  );
});

test('scoped ensure shares one mylist snapshot across verify and inventory', async () => {
  let mylistFetches = 0;
  const fetchFn = async (url) => {
    if (String(url).includes('/torrents/mylist')) mylistFetches++;
    return mylistResponse([resource()]);
  };
  const fn = buildRequestScopedEnsureFn({
    fallbackFn: null,
    controlPlaneStore: stubStore(),
    torBoxProvider: stubTorBoxProvider(),
    apiKey: 'k',
    scope: 'test',
    fetchFn,
  });
  assert.equal(typeof fn, 'function');
  // skipSizeMatch path: create + verify lookup + inventory from one snapshot.
  const result = await fn({ infoHash: HASH, controlPlaneStore: stubStore(), skipSizeMatch: true });
  assert.equal(result.placementId, 'pl1');
  assert.equal(mylistFetches, 1);
});
