import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTorznabItem,
  loadTorznabIndexers,
} from '../src/lib/torznab/torznab.js';
import { normalizeStream, mergeStreams } from '../src/lib/stremio/normalize.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function installFetchMock(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('normalizeTorznabItem extracts infoHash directly', () => {
  const item = normalizeTorznabItem(
    {
      title: 'Test Movie 2024 2160p',
      infoHash: HASH,
      size: 1234567890,
      seeders: 50,
      leechers: 10,
      pubDate: '2024-01-15T12:00:00Z',
    },
    { addonId: 'torznab.0', name: 'Test Indexer', sortOrder: 100 }
  );

  assert.ok(item);
  assert.equal(item.infoHash, HASH);
  assert.equal(item.key, `ih:${HASH}`);
  assert.equal(item.title, 'Test Movie 2024 2160p');
  assert.equal(item.size, 1234567890);
  assert.equal(item.sources[0].addonId, 'torznab.0');
  assert.equal(item.sources[0].addonName, 'Test Indexer');
});

test('normalizeTorznabItem extracts infoHash from magnet link', () => {
  const item = normalizeTorznabItem(
    {
      title: 'Test Movie',
      link: `magnet:?xt=urn:btih:${HASH}&dn=Test%20Movie`,
    },
    { addonId: 'torznab.0', name: 'Test Indexer' }
  );

  assert.ok(item);
  assert.equal(item.infoHash, HASH);
  assert.equal(item.torznab.magnet, `magnet:?xt=urn:btih:${HASH}&dn=Test%20Movie`);
});

test('normalizeTorznabItem preserves seeders/leechers/date/source', () => {
  const item = normalizeTorznabItem(
    {
      title: 'Test Release',
      infoHash: HASH,
      size: 5000000000,
      seeders: 100,
      leechers: 25,
      pubDate: '2024-06-15T08:30:00Z',
    },
    { addonId: 'torznab.0', name: 'My Indexer', provider: 'torbox' }
  );

  assert.ok(item);
  assert.equal(item.torznab.seeders, 100);
  assert.equal(item.torznab.leechers, 25);
  assert.equal(item.torznab.publishDate, '2024-06-15T08:30:00.000Z');
  assert.equal(item.size, 5000000000);
  assert.equal(item.sources[0].indexer, 'My Indexer');
});

test('normalizeTorznabItem returns null for missing infoHash', () => {
  const item = normalizeTorznabItem(
    {
      title: 'No Hash Release',
      size: 1000,
    },
    { addonId: 'torznab.0', name: 'Test Indexer' }
  );

  assert.equal(item, null);
});

test('normalizeTorznabItem returns null for empty title', () => {
  const item = normalizeTorznabItem(
    {
      infoHash: HASH,
    },
    { addonId: 'torznab.0', name: 'Test Indexer' }
  );

  assert.equal(item, null);
});

test('loadTorznabIndexers parses JSON config', async () => {
  process.env.TORZNAB_URLS = JSON.stringify([
    {
      id: 'prowlarr',
      name: 'Prowlarr',
      url: 'https://prowlarr.example.com/api/v1/indexer/1/torznab',
      role: 'discovery',
      enabled: true,
      sortOrder: 100,
    },
    {
      id: 'jackett',
      name: 'Jackett',
      url: 'https://jackett.example.com/api/v2.0/indexers/all/results/torznab',
      role: 'discovery',
      sortOrder: 101,
    },
  ]);

  try {
    const indexers = await loadTorznabIndexers();
    assert.equal(indexers.length, 2);
    assert.equal(indexers[0].addonId, 'prowlarr');
    assert.equal(indexers[0].name, 'Prowlarr');
    assert.equal(indexers[0].url, 'https://prowlarr.example.com/api/v1/indexer/1/torznab');
    assert.equal(indexers[0].sort_order, 100);
    assert.equal(indexers[1].addonId, 'jackett');
    assert.equal(indexers[1].sort_order, 101);
  } finally {
    delete process.env.TORZNAB_URLS;
  }
});

test('loadTorznabIndexers returns empty when TORZNAB_URLS not set', async () => {
  delete process.env.TORZNAB_URLS;
  const indexers = await loadTorznabIndexers();
  assert.equal(indexers.length, 0);
});

test('loadTorznabIndexers handles invalid JSON', async () => {
  process.env.TORZNAB_URLS = 'not valid json';
  try {
    const indexers = await loadTorznabIndexers();
    assert.equal(indexers.length, 0);
  } finally {
    delete process.env.TORZNAB_URLS;
  }
});

test('same hash from Torznab and Stremio merges exactly once', () => {
  const stremioItem = normalizeStream(
    {
      name: 'Stremio Release',
      infoHash: HASH,
      resolution: '1080p',
    },
    { addonId: 'torrentio.torbox', addonName: 'Torrentio (TorBox)' }
  );

  const torznabItem = normalizeTorznabItem(
    {
      title: 'Torznab Release',
      infoHash: HASH,
      size: 5000000000,
      seeders: 50,
    },
    { addonId: 'torznab.0', name: 'Test Indexer' }
  );

  assert.ok(stremioItem);
  assert.ok(torznabItem);

  const merged = mergeStreams([], [stremioItem, torznabItem]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].infoHash, HASH);
});

test('source provenance from both Torznab and Stremio survives merge', () => {
  const stremioItem = normalizeStream(
    {
      name: 'Stremio Release',
      infoHash: HASH,
      resolution: '1080p',
    },
    { addonId: 'torrentio.torbox', addonName: 'Torrentio (TorBox)' }
  );

  const torznabItem = normalizeTorznabItem(
    {
      title: 'Torznab Release',
      infoHash: HASH,
      size: 5000000000,
      seeders: 50,
    },
    { addonId: 'torznab.0', name: 'Test Indexer' }
  );

  const merged = mergeStreams([], [stremioItem, torznabItem]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sources.length, 2);
  assert.ok(merged[0].sources.some((s) => s.addonId === 'torrentio.torbox'));
  assert.ok(merged[0].sources.some((s) => s.addonId === 'torznab.0'));
});

test('one failed discovery source does not poison successful sources', async () => {
  const restore = installFetchMock(async (url) => {
    if (url.includes('failing')) {
      throw new Error('Connection refused');
    }
    return {
      ok: true,
      json: async () => ({
        rss: {
          channel: {
            item: [
              {
                title: 'Test Release',
                infoHash: HASH,
                size: 1000,
              },
            ],
          },
        },
      }),
    };
  });

  try {
    process.env.TORZNAB_URLS = JSON.stringify([
      {
        id: 'working',
        name: 'Working',
        url: 'https://working.example.com/api',
        sortOrder: 100,
      },
      {
        id: 'failing',
        name: 'Failing',
        url: 'https://failing.example.com/api',
        sortOrder: 101,
      },
    ]);

    const { searchTorznab } = await import('../src/lib/torznab/torznab.js');
    const results = await searchTorznab({
      type: 'movie',
      mediaId: 'tt1234567',
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].infoHash, HASH);
  } finally {
    restore();
    delete process.env.TORZNAB_URLS;
  }
});

test('no credentials in public release/source data', async () => {
  process.env.TORZNAB_URLS = JSON.stringify([
    {
      id: 'prowlarr',
      name: 'Prowlarr',
      url: 'https://prowlarr.example.com/api/v1/indexer/1/torznab?apikey=secret123',
      sortOrder: 100,
    },
  ]);

  try {
    const restore = installFetchMock(async () => ({
      ok: true,
      json: async () => ({
        rss: {
          channel: {
            item: [
              {
                title: 'Test Release',
                infoHash: HASH,
                size: 1000,
              },
            ],
          },
        },
      }),
    }));

    try {
      const { searchTorznab } = await import('../src/lib/torznab/torznab.js');
      const results = await searchTorznab({
        type: 'movie',
        mediaId: 'tt1234567',
      });

      assert.equal(results.length, 1);
      const release = results[0];
      // Source data should not contain API key
      assert.ok(!JSON.stringify(release.sources).includes('secret123'));
      assert.ok(!JSON.stringify(release).includes('secret123'));
    } finally {
      restore();
    }
  } finally {
    delete process.env.TORZNAB_URLS;
  }
});

test('malformed Torznab results fail safely', () => {
  assert.equal(normalizeTorznabItem(null, {}), null);
  assert.equal(normalizeTorznabItem({}, {}), null);
  assert.equal(normalizeTorznabItem({ title: '', infoHash: HASH }, {}), null);
  assert.equal(normalizeTorznabItem({ title: 'No Hash' }, {}), null);
});

test('GUID only yields hash when GUID is itself a 40-hex infoHash', () => {
  const direct = normalizeTorznabItem(
    { title: 'Direct', guid: HASH },
    { addonId: 'torznab.0', name: 'Idx' }
  );
  assert.ok(direct, 'GUID equal to infoHash should be accepted');
  assert.equal(direct.infoHash, HASH);
});

test('GUID with embedded 40-hex substring is rejected', () => {
  const prefixed = normalizeTorznabItem(
    { title: 'Prefixed', guid: `prefix-${HASH}-suffix` },
    { addonId: 'torznab.0', name: 'Idx' }
  );
  assert.equal(prefixed, null, 'GUID with embedded hash should not yield infoHash');
});

test('malformed GUID variants do not leak a hash', () => {
  for (const guid of [
    `info:${HASH}`,
    `https://tracker.example.com/${HASH}`,
    `uuid-${HASH}`,
    `${HASH}extra`,
  ]) {
    const item = normalizeTorznabItem(
      { title: 'X', guid },
      { addonId: 'torznab.0', name: 'Idx' }
    );
    assert.equal(item, null, `guid "${guid}" should not leak a hash`);
  }
});

test('searchTorznab propagates AbortSignal into fetch operations', async () => {
  let capturedSignal = null;

  const restore = installFetchMock(async (url, options) => {
    capturedSignal = options?.signal || null;
    return {
      ok: true,
      json: async () => ({ rss: { channel: { item: [] } } }),
    };
  });

  try {
    process.env.TORZNAB_URLS = JSON.stringify([
      { id: 'idx', name: 'Idx', url: 'https://idx.example.com/api', sortOrder: 100 },
    ]);

    const { searchTorznab } = await import('../src/lib/torznab/torznab.js');
    await searchTorznab({ type: 'movie', mediaId: 'tt1234567' });

    assert.ok(capturedSignal instanceof AbortSignal, 'fetch should receive an AbortSignal');
    assert.equal(capturedSignal.aborted, false, 'signal should not be pre-aborted');
  } finally {
    restore();
    delete process.env.TORZNAB_URLS;
  }
});
