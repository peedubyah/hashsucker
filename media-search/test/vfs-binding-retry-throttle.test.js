import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function storeStub(calls) {
  return {
    getTorrentFile: () => ({
      id: 'tf-retry', infoHash: HASH, internalPath: 'Show/Episode.mkv', size: 10,
    }),
    listDataPlaneCoordinates: () => [{ provider: 'torbox', size: 10 }],
    getLibraryItemByIdentityKey: () => null,
    getActiveBindingForLibraryItem: () => null,
    ensureLibraryItem: () => ({ id: 'li-retry' }),
    ensureCanonicalPath: () => ({ id: 'lp-retry' }),
    recordExposure: () => ({ id: 'ex-retry' }),
    activateBinding: () => {
      calls.push(1);
      throw new Error('Cannot bind through a stale or unbounded provider inventory observation');
    },
  };
}

function handoff() {
  return {
    mediaId: 'tt-retry', mediaType: 'tv', season: 1, episode: 1,
    releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    filename: 'Episode.mkv', provider: 'torbox', torrentFileId: 'tf-retry',
    torrentFileIdentity: {
      status: 'mapped', torrentFileId: 'tf-retry', placementId: 'placement-retry',
      providerFileId: 'provider-file-retry',
    },
  };
}

test('stale binding activation is throttled until its bounded retry window', async () => {
  const cache = createDiscoveryCache();
  const calls = [];
  const store = storeStub(calls);
  const fixture = handoff();

  const first = await materializeVfsEntry(cache, fixture, store, () => 1_000, { allowLegacy: false });
  const second = await materializeVfsEntry(cache, fixture, store, () => 1_000, { allowLegacy: false });
  const afterWindow = await materializeVfsEntry(cache, fixture, store, () => 31_001, { allowLegacy: false });

  assert.ok(first);
  assert.ok(second);
  assert.ok(afterWindow);
  assert.equal(calls.length, 2);
  cache.close();
});
