import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDiscoveryAddons } from '../src/lib/stremio/search.js';
import { normalizeStream, mergeStreams } from '../src/lib/stremio/normalize.js';
import { discoverViaStremio } from '../src/lib/discovery/adapters/stremio.js';
import { discoverViaTorznab } from '../src/lib/discovery/adapters/torznab.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function clearEnv() {
  delete process.env.TORBOX_API_KEY;
  delete process.env.REALDEBRID_API_KEY;
  delete process.env.COMET_MANIFEST_URL;
}

test('Torrentio/TorBox URL generated from TORBOX_API_KEY', async () => {
  clearEnv();
  process.env.TORBOX_API_KEY = 'test-torbox-key-123';

  try {
    const addons = await loadDiscoveryAddons();
    const torbox = addons.find((a) => a.addon_id === 'torrentio.torbox');

    assert.ok(torbox, 'torrentio.torbox addon should exist');
    assert.equal(torbox.name, 'Torrentio (TorBox)');
    assert.equal(torbox.provider, 'torbox');
    assert.equal(torbox.sort_order, 0);
    assert.ok(torbox.manifest_url.includes('torrentio.strem.fun'));
    assert.ok(torbox.manifest_url.includes('torbox='));
    assert.ok(torbox.manifest_url.includes(encodeURIComponent('test-torbox-key-123')));
    assert.ok(torbox.manifest_url.endsWith('/manifest.json'));
  } finally {
    clearEnv();
  }
});

test('Torrentio/Real-Debrid URL generated from REALDEBRID_API_KEY', async () => {
  clearEnv();
  process.env.REALDEBRID_API_KEY = 'test-rd-key-456';

  try {
    const addons = await loadDiscoveryAddons();
    const rd = addons.find((a) => a.addon_id === 'torrentio.realdebrid');

    assert.ok(rd, 'torrentio.realdebrid addon should exist');
    assert.equal(rd.name, 'Torrentio (Real-Debrid)');
    assert.equal(rd.provider, 'realdebrid');
    assert.equal(rd.sort_order, 1);
    assert.ok(rd.manifest_url.includes('realdebrid='));
    assert.ok(rd.manifest_url.includes(encodeURIComponent('test-rd-key-456')));
  } finally {
    clearEnv();
  }
});

test('proper URL encoding of credentials with special characters', async () => {
  clearEnv();
  process.env.TORBOX_API_KEY = 'key with spaces & special=chars?';

  try {
    const addons = await loadDiscoveryAddons();
    const torbox = addons.find((a) => a.addon_id === 'torrentio.torbox');

    assert.ok(torbox);
    // The encoded key should be URL-encoded
    assert.ok(torbox.manifest_url.includes(encodeURIComponent('key with spaces & special=chars?')));
    // The raw key should NOT appear in the URL
    assert.ok(!torbox.manifest_url.includes('key with spaces'));
  } finally {
    clearEnv();
  }
});

test('no TorBox source generated when TORBOX_API_KEY is absent', async () => {
  clearEnv();
  process.env.REALDEBRID_API_KEY = 'test-rd-key';

  try {
    const addons = await loadDiscoveryAddons();
    const torbox = addons.find((a) => a.addon_id === 'torrentio.torbox');

    assert.ok(!torbox, 'torrentio.torbox should not exist without TORBOX_API_KEY');
  } finally {
    clearEnv();
  }
});

test('no Real-Debrid source generated when REALDEBRID_API_KEY is absent', async () => {
  clearEnv();
  process.env.TORBOX_API_KEY = 'test-tb-key';

  try {
    const addons = await loadDiscoveryAddons();
    const rd = addons.find((a) => a.addon_id === 'torrentio.realdebrid');

    assert.ok(!rd, 'torrentio.realdebrid should not exist without REALDEBRID_API_KEY');
  } finally {
    clearEnv();
  }
});

test('Comet manual manifest is optional', async () => {
  clearEnv();
  process.env.TORBOX_API_KEY = 'test-tb-key';

  try {
    // Without COMET_MANIFEST_URL
    let addons = await loadDiscoveryAddons();
    let comet = addons.find((a) => a.addon_id === 'comet.manual');
    assert.ok(!comet, 'comet.manual should not exist without COMET_MANIFEST_URL');

    // With COMET_MANIFEST_URL
    process.env.COMET_MANIFEST_URL = 'https://comet.example.com/manifest.json';
    addons = await loadDiscoveryAddons();
    comet = addons.find((a) => a.addon_id === 'comet.manual');
    assert.ok(comet, 'comet.manual should exist with COMET_MANIFEST_URL');
    assert.equal(comet.provider, 'comet');
    assert.equal(comet.manifest_url, 'https://comet.example.com/manifest.json');
    assert.equal(comet.sort_order, 2);
  } finally {
    clearEnv();
  }
});

test('two providers contributing to one exact-hash merged release preserves provenance', () => {
  const torboxStream = normalizeStream(
    { infoHash: HASH, title: 'Release via TorBox', resolution: '1080p' },
    { addonId: 'torrentio.torbox', addonName: 'Torrentio (TorBox)', provider: 'torbox' }
  );

  const rdStream = normalizeStream(
    { infoHash: HASH, title: 'Release via RD', size: 5000 },
    { addonId: 'torrentio.realdebrid', addonName: 'Torrentio (Real-Debrid)', provider: 'realdebrid' }
  );

  assert.ok(torboxStream);
  assert.ok(rdStream);

  // Merge: rdStream wins on richness (has size)
  const merged = mergeStreams([], [torboxStream, rdStream]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].infoHash, HASH);

  // Both providers preserved in sources
  assert.equal(merged[0].sources.length, 2);
  assert.ok(merged[0].sources.some((s) => s.provider === 'torbox'));
  assert.ok(merged[0].sources.some((s) => s.provider === 'realdebrid'));
});

test('stable source IDs and provider metadata', async () => {
  clearEnv();
  process.env.TORBOX_API_KEY = 'test-tb-key';
  process.env.REALDEBRID_API_KEY = 'test-rd-key';
  process.env.COMET_MANIFEST_URL = 'https://comet.example.com/manifest.json';

  try {
    const addons = await loadDiscoveryAddons();

    // Should have 3 addons in stable order
    assert.equal(addons.length, 3);
    assert.equal(addons[0].addon_id, 'torrentio.torbox');
    assert.equal(addons[0].provider, 'torbox');
    assert.equal(addons[0].sort_order, 0);
    assert.equal(addons[1].addon_id, 'torrentio.realdebrid');
    assert.equal(addons[1].provider, 'realdebrid');
    assert.equal(addons[1].sort_order, 1);
    assert.equal(addons[2].addon_id, 'comet.manual');
    assert.equal(addons[2].provider, 'comet');
    assert.equal(addons[2].sort_order, 2);
  } finally {
    clearEnv();
  }
});

test('normalizeStream preserves provider in sources', () => {
  const stream = normalizeStream(
    { name: 'Test', infoHash: HASH },
    { addonId: 'torrentio.torbox', addonName: 'Torrentio (TorBox)', provider: 'torbox' }
  );

  assert.ok(stream);
  assert.equal(stream.sources[0].provider, 'torbox');
  assert.equal(stream.sources[0].addonId, 'torrentio.torbox');
});

test('normalizeStream handles missing provider gracefully', () => {
  const stream = normalizeStream(
    { name: 'Test', infoHash: HASH },
    { addonId: 'legacy.addon', addonName: 'Legacy Addon' }
  );

  assert.ok(stream);
  assert.equal(stream.sources[0].provider, null);
});

test('Stremio discovery adapter propagates AbortSignal into fetch', async () => {
  let capturedSignal = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    capturedSignal = options?.signal || null;
    return {
      ok: true,
      json: async () => ({ streams: [] }),
    };
  };

  try {
    const request = { mediaType: 'movie', mediaId: 'tt1234567', searchTitles: ['Test'] };
    const source = { id: 'test', kind: 'stremio', endpoint: 'https://example.com/manifest.json', timeoutMs: 5000 };
    await discoverViaStremio(request, source);

    assert.ok(capturedSignal instanceof AbortSignal, 'Stremio adapter must pass AbortSignal to fetch');
    assert.equal(capturedSignal.aborted, false, 'signal should not be pre-aborted');
  } finally {
    globalThis.fetch = original;
  }
});

test('Torznab discovery adapter propagates AbortSignal into fetch', async () => {
  let capturedSignal = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    capturedSignal = options?.signal || null;
    return {
      ok: true,
      json: async () => ({ rss: { channel: { item: [] } } }),
    };
  };

  try {
    const request = { mediaType: 'movie', mediaId: 'tt1234567', searchTitles: ['Test'] };
    const source = { id: 'test', kind: 'torznab', endpoint: 'https://example.com/api', timeoutMs: 5000 };
    await discoverViaTorznab(request, source);

    assert.ok(capturedSignal instanceof AbortSignal, 'Torznab adapter must pass AbortSignal to fetch');
    assert.equal(capturedSignal.aborted, false, 'signal should not be pre-aborted');
  } finally {
    globalThis.fetch = original;
  }
});

test('Stremio discovery adapter aborts fetch after timeout', async () => {
  const original = globalThis.fetch;
  let capturedSignal = null;
  globalThis.fetch = async (url, options) => {
    capturedSignal = options?.signal || null;
    // Simulate a hanging request — the AbortSignal should fire after timeout
    return new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  try {
    const request = { mediaType: 'movie', mediaId: 'tt1234567', searchTitles: ['Test'] };
    const source = { id: 'test', kind: 'stremio', endpoint: 'https://example.com/manifest.json', timeoutMs: 50 };
    let threw = false;
    try {
      await discoverViaStremio(request, source);
    } catch {
      threw = true;
    }

    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, true, 'signal should be aborted after timeout');
    assert.ok(threw, 'adapter should propagate the AbortError');
  } finally {
    globalThis.fetch = original;
  }
});
