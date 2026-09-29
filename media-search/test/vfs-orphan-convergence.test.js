import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function storeStub(active = null) {
  const files = new Map([
    ['tf-a', { id: 'tf-a', infoHash: HASH_A, internalPath: 'Show/A.mkv', size: 10 }],
    ['tf-b', { id: 'tf-b', infoHash: HASH_B, internalPath: 'Show/B.mkv', size: 20 }],
  ]);
  return {
    getTorrentFile: (id) => files.get(id) ?? null,
    listDataPlaneCoordinates: () => [{ provider: 'torbox', size: 20 }],
    getLibraryItemByIdentityKey: () => (active ? { id: 'li-1' } : null),
    getActiveBindingForLibraryItem: () => active,
    ensureLibraryItem: () => ({ id: 'li-1' }),
    ensureCanonicalPath: () => ({ id: 'lp-1' }),
    recordExposure: () => ({ id: 'ex-1' }),
    activateBinding: () => active ?? ({ id: 'binding-b' }),
  };
}

function handoff(id, hash, status = 'mapped') {
  return {
    mediaId: 'tt-orphan', mediaType: 'tv', season: 1, episode: 1,
    releaseKey: `${hash}:torrent`, infoHash: hash, fileIndex: null,
    filename: `${id}.mkv`, provider: 'torbox', torrentFileId: id,
    torrentFileIdentity: { status, torrentFileId: id, placementId: 'p', providerFileId: 'f' },
  };
}

test('orphan VFS converges to authoritative B when no active Binding exists', async () => {
  const cache = createDiscoveryCache();
  cache.createVfsTvEntry({ mediaId: 'tt-orphan', season: 1, episode: 1, releaseKey: `${HASH_A}:torrent`, infoHash: HASH_A, fileIndex: null, canonicalPath: 'TV/Orphan/S01E01.mkv', torrentFileId: 'tf-a', size: 10, createdAt: 1, updatedAt: 1 });
  const entry = await materializeVfsEntry(cache, handoff('tf-b', HASH_B), storeStub(), () => 2, { allowLegacy: false });
  assert.equal(entry.torrentFileId, 'tf-b');
  cache.close();
});

test('active Binding prevents implicit VFS representation change', async () => {
  const cache = createDiscoveryCache();
  cache.createVfsTvEntry({ mediaId: 'tt-orphan', season: 1, episode: 1, releaseKey: `${HASH_A}:torrent`, infoHash: HASH_A, fileIndex: null, canonicalPath: 'TV/Orphan/S01E01.mkv', torrentFileId: 'tf-a', size: 10, createdAt: 1, updatedAt: 1 });
  const entry = await materializeVfsEntry(
    cache,
    handoff('tf-b', HASH_B),
    storeStub({ torrentFile: { id: 'tf-a', infoHash: HASH_A, internalPath: 'Show/A.mkv', size: 10 }, binding: { releaseKey: `${HASH_A}:torrent`, infoHash: HASH_A, fileIndex: null } }),
    () => 2,
    { allowLegacy: false },
  );
  assert.equal(entry.torrentFileId, 'tf-a', 'active Binding remains authoritative');
  cache.close();
});
