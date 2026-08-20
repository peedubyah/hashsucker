import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestIntent } from '../src/lib/requests/intent.js';
import { searchMedia, _resetCacheForTests, _getCacheForTests } from '../src/lib/search.js';
import { checkTorBoxCached } from '../src/lib/providers/torbox.js';
import { normalizeStream } from '../src/lib/stremio/normalize.js';

// Use in-memory cache for tests to avoid filesystem dependencies
process.env.DISCOVERY_CACHE_PATH = ':memory:';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

function makeHash(n) {
  return String(n).padStart(40, '0');
}

function release(infoHash, title) {
  return normalizeStream(
    { infoHash, name: title },
    { addonId: 'torrentio.torbox', addonName: 'Torrentio (TorBox)', provider: 'torbox' }
  );
}

function installFetchMock(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('TorBox cached state is enrichment and provider failures become unknown', async () => {
  _resetCacheForTests();
  process.env.TORBOX_API_KEY = 'test-key';

  try {
    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });
    const result = await searchMedia(intent, {
      searchStremio: async () => [release(HASH, 'Season pack')],
      searchTorznab: async () => [],
      checkTorBoxCached: async () => ({ cached: new Set([HASH]), details: new Map() }),
    });
    assert.equal(result.results[0].providers.torbox.cached, true);
    assert.equal(typeof result.timings.discoveryMs, 'number');
    assert.equal(typeof result.timings.torboxMs, 'number');
    assert.equal(typeof result.timings.totalMs, 'number');
    assert.deepEqual(result.intent.episodes, [3]);
    assert.equal('providers' in result.intent, false);

    const unknown = await searchMedia(intent, {
      searchStremio: async () => [release(HASH, 'Season pack')],
      searchTorznab: async () => [],
      checkTorBoxCached: async () => { throw new Error('offline'); },
    });
    assert.equal(unknown.results[0].providers.torbox.cached, null);
    assert.equal(unknown.providerStatus.torbox, 'unknown');
  } finally {
    delete process.env.TORBOX_API_KEY;
  }
});

test('checkTorBoxCached sends explicit User-Agent header', async () => {
  const restore = installFetchMock(async (url, options) => {
    assert.equal(options?.headers?.['User-Agent'], 'media-search/0.0.1');
    return {
      ok: true,
      json: async () => ({ success: true, data: {} }),
    };
  });

  try {
    process.env.TORBOX_API_KEY = 'test-key';
    await checkTorBoxCached(['abc0123456789abcdef0123456789abcdef0123']);
  } finally {
    restore();
    delete process.env.TORBOX_API_KEY;
  }
});

test('checkTorBoxCached batches 11 hashes into 2 requests', async () => {
  const requests = [];
  const restore = installFetchMock(async (url, options) => {
    const hashCount = url.toString().match(/hash=/g)?.length || 0;
    requests.push(hashCount);
    return {
      ok: true,
      json: async () => ({ success: true, data: {} }),
    };
  });

  try {
    process.env.TORBOX_API_KEY = 'test-key';
    const hashes = Array.from({ length: 11 }, (_, i) => makeHash(i + 1));
    await checkTorBoxCached(hashes);
  } finally {
    restore();
    delete process.env.TORBOX_API_KEY;
  }

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.sort((a, b) => a - b), [1, 10]);
});

test('non-auth batch failure preserves successful results and exposes failed hashes separately', async () => {
  const restore = installFetchMock(async (url) => {
    const hashCount = url.toString().match(/hash=/g)?.length || 0;
    if (hashCount === 10) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [
              makeHash(i + 1),
              { name: `file${i}.mkv`, size: 1000 + i },
            ])
          ),
        }),
      };
    }
    // Single-hash batch fails with a non-auth error
    throw new Error('transient network error');
  });

  try {
    process.env.TORBOX_API_KEY = 'test-key';
    const hashes = Array.from({ length: 11 }, (_, i) => makeHash(i + 1));
    const result = await checkTorBoxCached(hashes);

    assert.equal(result.cached.size, 10);
    assert.equal(result.failed.size, 1);
    assert.ok(result.failed.has(makeHash(11)));
  } finally {
    restore();
    delete process.env.TORBOX_API_KEY;
  }
});

test('searchMedia produces providerStatus partial with mixed cache results', async () => {
  _resetCacheForTests();
  const restore = installFetchMock(async (url) => {
    const hashCount = url.toString().match(/hash=/g)?.length || 0;
    if (hashCount === 10) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [
              makeHash(i + 1),
              i < 5 ? { name: `file${i}.mkv`, size: 1000 + i } : null,
            ])
          ),
        }),
      };
    }
    // Last hash batch fails with non-auth error
    const error = new Error('transient');
    error.status = 500;
    throw error;
  });

  try {
    process.env.TORBOX_API_KEY = 'test-key';
    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });
    const hashes = Array.from({ length: 11 }, (_, i) => makeHash(i + 1));
    const result = await searchMedia(intent, {
      searchStremio: async () => hashes.map((infoHash) => release(infoHash, 'x')),
      checkTorBoxCached,
    });

    assert.equal(result.providerStatus.torbox, 'partial');
    assert.equal(result.results.length, 11);

    const cachedTrue = result.results.filter((r) => r.providers.torbox.cached === true);
    const cachedFalse = result.results.filter((r) => r.providers.torbox.cached === false);
    const cachedNull = result.results.filter((r) => r.providers.torbox.cached === null);

    assert.equal(cachedTrue.length, 5);
    assert.equal(cachedFalse.length, 5);
    assert.equal(cachedNull.length, 1);
    assert.equal(cachedNull[0].infoHash, makeHash(11));
  } finally {
    restore();
    delete process.env.TORBOX_API_KEY;
  }
});

test('global auth failure produces providerStatus unknown', async () => {
  _resetCacheForTests();
  const restore = installFetchMock(async () => {
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: 'BAD_TOKEN' }),
    };
  });

  try {
    process.env.TORBOX_API_KEY = 'bad-token';
    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });
    const result = await searchMedia(intent, {
      searchStremio: async () => [release(HASH, 'x')],
      checkTorBoxCached,
    });

    assert.equal(result.providerStatus.torbox, 'unknown');
    assert.equal(result.results[0].providers.torbox.cached, null);
  } finally {
    restore();
    delete process.env.TORBOX_API_KEY;
  }
});

// =============================================================================
// Cache Read Path Integration Tests (TDD — must fail before implementation)
// =============================================================================

test('fresh cache hit avoids live discovery adapters', async () => {
  _resetCacheForTests();
  process.env.TORBOX_API_KEY = 'test-key';

  try {
    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });

    // Pre-populate cache with a fresh candidate for this search key
    const cache = _getCacheForTests();
    cache.upsertCandidate({
      infoHash: HASH,
      fileIndex: null,
      searchKey: 'tt1:7:3',
      title: 'Cached Release',
      filename: 'cached.mkv',
      size: 2048,
      seeders: 5,
      leechers: 1,
      sources: [{ id: 'stremio.torbox', kind: 'stremio' }],
      metadata: { resolution: '1080p' },
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });

    let adapterCalled = false;
    const result = await searchMedia(intent, {
      searchStremio: async () => { adapterCalled = true; return []; },
      searchTorznab: async () => { adapterCalled = true; return []; },
      checkTorBoxCached: async () => ({ cached: new Set(), details: new Map() }),
    });

    assert.equal(adapterCalled, false, 'adapters should not be called on fresh cache hit');
    assert.ok(result.results.length > 0, 'results should come from cache');
    assert.equal(result.results[0].infoHash, HASH);
    assert.equal(result.results[0].title, 'Cached Release');
    assert.equal(result.fromCache, true);
  } finally {
    _resetCacheForTests();
    delete process.env.TORBOX_API_KEY;
  }
});

test('cache miss invokes live discovery adapters', async () => {
  _resetCacheForTests();
  process.env.TORBOX_API_KEY = 'test-key';

  try {
    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });

    let adapterCalled = false;
    const result = await searchMedia(intent, {
      searchStremio: async () => { adapterCalled = true; return [release(HASH, 'Live Release')]; },
      searchTorznab: async () => { adapterCalled = true; return []; },
      checkTorBoxCached: async () => ({ cached: new Set(), details: new Map() }),
    });

    assert.equal(adapterCalled, true, 'adapters should be called on cache miss');
    assert.ok(result.results.length > 0, 'results should come from live discovery');
    assert.equal(result.results[0].infoHash, HASH);
    assert.equal(result.fromCache, undefined);
  } finally {
    _resetCacheForTests();
    delete process.env.TORBOX_API_KEY;
  }
});

test('stale cache returns results immediately and refreshes in background', async () => {
  _resetCacheForTests();
  process.env.TORBOX_API_KEY = 'test-key';

  try {
    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });

    const cache = _getCacheForTests();
    cache.upsertCandidate({
      infoHash: HASH,
      fileIndex: null,
      searchKey: 'tt1:7:3',
      title: 'Stale Release',
      filename: 'stale.mkv',
      size: 1024,
      seeders: 3,
      leechers: 1,
      sources: [{ id: 'stremio.torbox', kind: 'stremio' }],
      metadata: { resolution: '720p' },
      firstSeen: Date.now() - 120000,
      lastSeen: Date.now() - 120000,
    });

    let adapterCalled = false;
    const result = await searchMedia(intent, {
      searchStremio: async () => { adapterCalled = true; return []; },
      searchTorznab: async () => { adapterCalled = true; return []; },
      checkTorBoxCached: async () => ({ cached: new Set(), details: new Map() }),
    });

    assert.equal(result.fromCache, true, 'stale results should be served from cache');
    assert.equal(result.results[0].title, 'Stale Release');
    assert.equal(adapterCalled, true, 'background refresh should trigger adapters');
  } finally {
    _resetCacheForTests();
    delete process.env.TORBOX_API_KEY;
  }
});

test('live discovery results write through to cache', async () => {
  _resetCacheForTests();
  process.env.TORBOX_API_KEY = 'test-key';

  try {
    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });

    const result = await searchMedia(intent, {
      searchStremio: async () => [release(HASH, 'Fresh Release')],
      searchTorznab: async () => [],
      checkTorBoxCached: async () => ({ cached: new Set([HASH]), details: new Map() }),
    });

    assert.equal(result.results[0].infoHash, HASH);

    // Verify write-through occurred
    const cache = _getCacheForTests();
    const cached = cache.queryCachedCandidates({ searchKey: 'tt1:7:3' });
    assert.ok(cached.length > 0, 'live results should be written to cache');
    assert.equal(cached[0].infoHash, HASH);
    assert.equal(cached[0].searchKey, 'tt1:7:3');
  } finally {
    _resetCacheForTests();
    delete process.env.TORBOX_API_KEY;
  }
});
