import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestIntent } from '../src/lib/requests/intent.js';
import { searchMedia } from '../src/lib/search.js';
import { checkTorBoxCached } from '../src/lib/providers/torbox.js';
import { normalizeStream } from '../src/lib/stremio/normalize.js';

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
