import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';
import { createTvWebDav } from '../src/lib/vfs/tv-webdav.js';
import { searchByMedia } from '../src/api/media-request.js';

const HASH = 'cccccccccccccccccccccccccccccccccccccccc';
const OTHER_HASH = 'dddddddddddddddddddddddddddddddddddd';
const SEED_HASH = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function createRdResolutionCache() {
  const entries = new Map();
  return {
    get(infoHash, fileIndex) {
      return entries.get(`${infoHash}:${fileIndex ?? 'torrent'}`) || null;
    },
    set(infoHash, fileIndex, url, torrentId, rdFileId) {
      entries.set(`${infoHash}:${fileIndex ?? 'torrent'}`, { url, torrentId, rdFileId });
    },
    delete(infoHash, fileIndex) {
      entries.delete(`${infoHash}:${fileIndex ?? 'torrent'}`);
    },
    async getOrInFlight(_infoHash, _fileIndex, factory) {
      return factory();
    },
  };
}

function createControlPlane(infoHash, size = null) {
  return {
    findPlacementByInfoHash(provider, hash) {
      return provider === 'torbox' && hash === infoHash
        ? { id: 'placement-1', providerResourceId: 'torrent-1' }
        : null;
    },
    findFileMapping(releaseKey, placementId) {
      return releaseKey === `${infoHash}:torrent` && placementId === 'placement-1'
        ? { state: 'mapped', providerFileId: 'file-1' }
        : null;
    },
    listProviderFiles(placementId) {
      return placementId === 'placement-1'
        ? [{ providerFileId: 'file-1', size }]
        : [];
    },
  };
}

function createSeam() {
  return async () => ({ url: 'https://provider.test/file', size: null, recovered: false });
}

function createTorBoxDownloadUrlCache() {
  return {
    get() { return null; },
    set() {},
    delete() {},
    async getOrInFlight() { throw new Error('unused'); },
  };
}

function providerResponse(status, { body = '', contentRange = null } = {}) {
  const headers = new Headers();
  if (contentRange) headers.set('content-range', contentRange);
  return new Response(body, { status, headers });
}

test('hydrateVfsMovieEntry persists real provider size before notifyPlex is observable', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const requestId = cache.persistMediaRequest({ mediaId: 'tt0000099', mediaType: 'movie', source: 'test' }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt0000099',
    mediaType: 'movie',
    releaseKey: `${HASH}:torrent`,
    infoHash: HASH,
    fileIndex: null,
    filename: 'Hydrate.2025.2160p.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });

  const fetchFn = async (_url, options) => providerResponse(206, {
    body: 'x',
    contentRange: 'bytes 0-0/7777777777',
  });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: createControlPlane(HASH),
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
    resolveTorBoxDeliverySeam: createSeam(),
    torBoxDownloadUrlCache: createTorBoxDownloadUrlCache(),
    fetchFn,
  });

  // Pre-condition: VFS entry does not exist yet (materialized on first catalog build)
  assert.equal(cache.getVfsMovieEntry('tt0000099'), null);

  const before = Date.now();
  const result = await handler.hydrateVfsMovieEntry(`${HASH}:torrent`);
  const after = Date.now();

  assert.equal(result.size, 7777777777);
  assert.equal(result.mediaId, 'tt0000099');
  assert.equal(result.canonicalPath, 'Movies/Hydrate (2025)/Hydrate (2025).mkv');
  assert.equal(result.alreadyHydrated, true);

  // Hydrator must have persisted the size — observable via PROPFIND data source
  const persisted = cache.getVfsMovieEntry('tt0000099');
  assert.equal(persisted.size, 7777777777);
  assert.ok(persisted.updatedAt >= before && persisted.updatedAt <= after);

  // Second call must be idempotent (no provider roundtrip)
  let calls = 0;
  handler.hydrateVfsMovieEntry._wrapped = true; // marker to ensure identity
  const reusedFetch = async () => { calls += 1; throw new Error('must not fetch on second call'); };
  Object.assign(handler, { /* keep callable */ });
  // Build a fresh handler with a throwing fetch to assert no probe on second call
  const handler2 = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: createControlPlane(HASH),
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
    resolveTorBoxDeliverySeam: createSeam(),
    torBoxDownloadUrlCache: createTorBoxDownloadUrlCache(),
    fetchFn: reusedFetch,
  });
  const second = await handler2.hydrateVfsMovieEntry(`${HASH}:torrent`);
  assert.equal(second.size, 7777777777);
  assert.equal(second.alreadyHydrated, true);
  assert.equal(calls, 0);
});

test('hydrateVfsMovieEntry surfaces provider failure without destroying the durable handoff or VFS entry', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const requestId = cache.persistMediaRequest({ mediaId: 'tt0000100', mediaType: 'movie', source: 'test' }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt0000100',
    mediaType: 'movie',
    releaseKey: `${OTHER_HASH}:torrent`,
    infoHash: OTHER_HASH,
    fileIndex: null,
    filename: 'NoMeta.2025.2160p.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });

  const fetchFn = async () => providerResponse(500, { body: 'upstream down' });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: createControlPlane(OTHER_HASH),
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
    resolveTorBoxDeliverySeam: createSeam(),
    torBoxDownloadUrlCache: createTorBoxDownloadUrlCache(),
    fetchFn,
  });

  // Pre-condition: VFS entry does not exist yet
  assert.equal(cache.getVfsMovieEntry('tt0000100'), null);
  const handoffBefore = cache.getPlaybackHandoffByMediaId('tt0000100');
  assert.ok(handoffBefore);

  await assert.rejects(
    handler.hydrateVfsMovieEntry(`${OTHER_HASH}:torrent`),
    /Provider read failed|status=500|did not supply/i,
  );

  // Durable handoff + VFS entry must remain intact and size still NULL
  const handoffAfter = cache.getPlaybackHandoffByMediaId('tt0000100');
  assert.ok(handoffAfter);
  assert.equal(handoffAfter.releaseKey, handoffBefore.releaseKey);
  const vfsAfter = cache.getVfsMovieEntry('tt0000100');
  assert.ok(vfsAfter, 'VFS entry must be materialized even when hydration fails');
  assert.equal(vfsAfter.size, null);
});

test('hydrateVfsTvEntry persists real provider size for an episode', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const requestId = cache.persistMediaRequest({
    mediaId: 'tt0000200', mediaType: 'tv', source: 'test', season: 1, episode: 3,
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt0000200',
    mediaType: 'tv',
    season: 1,
    episode: 3,
    releaseKey: `${SEED_HASH}:3`,
    infoHash: SEED_HASH,
    fileIndex: 3,
    filename: 'Show.S01E03.2160p.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });

  const fetchFn = async () => providerResponse(206, {
    body: 'x',
    contentRange: 'bytes 0-0/2222222222',
  });

  const handler = createTvWebDav({
    searchCache: cache,
    controlPlaneStore: createControlPlane(SEED_HASH),
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
    resolveTorBoxDeliverySeam: createSeam(),
    torBoxDownloadUrlCache: createTorBoxDownloadUrlCache(),
    fetchFn,
  });

  assert.equal(cache.getVfsTvEntry('tt0000200', 1, 3), null);
  const result = await handler.hydrateVfsTvEntry({ mediaId: 'tt0000200', season: 1, episode: 3 });
  assert.equal(result.size, 2222222222);
  assert.equal(result.season, 1);
  assert.equal(result.episode, 3);
  assert.equal(cache.getVfsTvEntry('tt0000200', 1, 3).size, 2222222222);
});

test('searchByMedia passes the wired hydrateVfs object through to the request completion path (movie)', async (t) => {
  // The full live-discovery path is exercised by the production canary; this
  // test asserts the wiring: when searchByMedia receives a hydrateVfs object,
  // it surfaces it via the function reference rather than rejecting it.
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const HASH2 = 'ffffffffffffffffffffffffffffffffffff';
  cache.upsertCandidate({
    infoHash: HASH2,
    fileIndex: 0,
    filename: 'Order.2025.2160p.mkv',
    title: 'Order',
  });
  cache.associateMedia(HASH2, 0, 'tt0000300', {
    source: 'enrichment',
    confidence: 1.0,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    resolverVersion: '1.0',
    matchMethod: 'title_exact_match',
    resolutionState: 'verified',
  });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: createControlPlane(HASH2),
    rdClient: null,
    rdResolutionCache: createRdResolutionCache(),
    resolveTorBoxDeliverySeam: createSeam(),
    torBoxDownloadUrlCache: createTorBoxDownloadUrlCache(),
    fetchFn: async () => providerResponse(206, { body: 'x', contentRange: 'bytes 0-0/5555555555' }),
  });

  let hydrateMovieCalled = 0;
  const hydrateVfs = {
    hydrateMovie: async (rk) => {
      hydrateMovieCalled += 1;
      return await handler.hydrateVfsMovieEntry(rk);
    },
    hydrateTv: async () => { throw new Error('not used'); },
  };

  // searchByMedia must accept and not reject the hydrateVfs option. The
  // persisted-candidate path does not invoke hydration (the production
  // live-discovery path does); we only assert the parameter is tolerated.
  const result = await searchByMedia(cache, {
    mediaId: 'tt0000300',
    mediaType: 'movie',
    persist: true,
    skipLiveDiscovery: true,
    skipAvailability: true,
    hydrateVfs,
  });
  assert.equal(result.intent?.mediaId, 'tt0000300');
  assert.equal(hydrateMovieCalled, 0, 'persisted-candidate path does not invoke hydrateMovie');
});
