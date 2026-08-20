import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestIntent } from '../src/lib/requests/intent.js';
import { searchMedia } from '../src/lib/search.js';
import { normalizeStream, mergeStreams } from '../src/lib/stremio/normalize.js';
import { mergeCandidates } from '../src/lib/discovery/merger.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const THIRD_HASH = 'cccccccccccccccccccccccccccccccccccccccc';

function clearEnv() {
  delete process.env.TORBOX_API_KEY;
  delete process.env.REALDEBRID_API_KEY;
  delete process.env.COMET_MANIFEST_URL;
}

test('multi-provider: TorBox and Real-Debrid sources coexist', async () => {
  clearEnv();
  process.env.TORBOX_API_KEY = 'test-torbox-key';
  process.env.REALDEBRID_API_KEY = 'test-rd-key';

  try {
    const torboxStream = normalizeStream(
      { infoHash: HASH, title: 'TorBox Release', resolution: '1080p' },
      { addonId: 'torrentio.torbox', provider: 'torbox' }
    );
    const rdStream = normalizeStream(
      { infoHash: OTHER_HASH, title: 'RD Release', resolution: '2160p' },
      { addonId: 'torrentio.realdebrid', provider: 'realdebrid' }
    );

    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });
    const result = await searchMedia(intent, {
      searchStremio: async () => [torboxStream, rdStream],
      searchTorznab: async () => [],
      checkTorBoxCached: async () => ({ cached: new Set([HASH]), details: new Map() }),
    });

    const byHash = Object.fromEntries(result.results.map((r) => [r.infoHash, r]));
    assert.ok(byHash[HASH]);
    assert.equal(byHash[HASH].providers.torbox.cached, true);
    assert.ok(byHash[OTHER_HASH]);
    assert.equal(byHash[OTHER_HASH].providers.realdebrid.cached, null);
  } finally {
    clearEnv();
  }
});

test('multi-provider: broad-only releases remain unknown', async () => {
  clearEnv();
  process.env.TORBOX_API_KEY = 'test-torbox-key';
  process.env.REALDEBRID_API_KEY = 'test-rd-key';

  try {
    const torboxStream = normalizeStream(
      { infoHash: HASH, title: 'TorBox Cached' },
      { addonId: 'torrentio.torbox', provider: 'torbox' }
    );
    const rdStream = normalizeStream(
      { infoHash: OTHER_HASH, title: 'RD Only' },
      { addonId: 'torrentio.realdebrid', provider: 'realdebrid' }
    );

    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });
    const result = await searchMedia(intent, {
      searchStremio: async () => [torboxStream, rdStream],
      searchTorznab: async () => [],
      checkTorBoxCached: async () => ({ cached: new Set([HASH]), details: new Map() }),
    });

    const byHash = Object.fromEntries(result.results.map((r) => [r.infoHash, r]));
    assert.equal(byHash[HASH].providers.torbox.cached, true);
    // OTHER_HASH was checked but NOT cached → false (not null)
    assert.equal(byHash[OTHER_HASH].providers.torbox.cached, false);
    assert.equal(byHash[OTHER_HASH].providers.realdebrid.cached, null);
  } finally {
    clearEnv();
  }
});

test('fallback: bulk cache enrichment when TorBox configured', async () => {
  clearEnv();
  process.env.TORBOX_API_KEY = 'test-key';

  try {
    const stream1 = normalizeStream({ infoHash: HASH, title: 'Release 1' }, {});
    const stream2 = normalizeStream({ infoHash: OTHER_HASH, title: 'Release 2' }, {});

    const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });
    const result = await searchMedia(intent, {
      searchStremio: async () => [stream1, stream2],
      searchTorznab: async () => [],
      checkTorBoxCached: async () => ({ cached: new Set([HASH]), details: new Map() }),
    });

    const byHash = Object.fromEntries(result.results.map((r) => [r.infoHash, r]));
    assert.equal(byHash[HASH].providers.torbox.cached, true);
    assert.equal(byHash[OTHER_HASH].providers.torbox.cached, false);
  } finally {
    clearEnv();
  }
});

test('normalizeStream preserves role in sources', () => {
  const stream = normalizeStream(
    {
      name: 'Test Release',
      infoHash: HASH,
    },
    {
      addonId: 'torrentio.torbox',
      addonName: 'Torrentio (TorBox)',
      role: 'torbox-cached',
    }
  );

  assert.ok(stream);
  assert.equal(stream.sources.length, 1);
  assert.equal(stream.sources[0].role, 'torbox-cached');
  assert.equal(stream.sources[0].addonId, 'torrentio.torbox');
});

test('normalizeStream defaults role to discovery when not provided', () => {
  const stream = normalizeStream(
    {
      name: 'Test Release',
      infoHash: HASH,
    },
    {
      addonId: 'some.addon',
      addonName: 'Some Addon',
    }
  );

  assert.ok(stream);
  assert.equal(stream.sources[0].role, 'discovery');
});

test('mergeStreams preserves torbox-cached role from preferred source', () => {
  const cachedStream = normalizeStream(
    { infoHash: HASH, title: 'Cached Version' },
    { addonId: 'configured.discovery.1', addonName: 'Comet | TB', role: 'torbox-cached' }
  );

  const discoveryStream = normalizeStream(
    { infoHash: HASH, title: 'Discovery Version', size: 5000 },
    { addonId: 'configured.discovery.2', addonName: 'Comet | TB+TORRENT', role: 'discovery' }
  );

  // discoveryStream wins on richness (has size)
  const merged = mergeStreams([], [cachedStream, discoveryStream]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].infoHash, HASH);
  // Both sources preserved
  assert.equal(merged[0].sources.length, 2);
  assert.ok(merged[0].sources.some((s) => s.role === 'torbox-cached'));
  assert.ok(merged[0].sources.some((s) => s.role === 'discovery'));
});

test('discovery merger preserves distinct files within same torrent via fileIndex', () => {
  const file0 = {
    infoHash: HASH,
    fileIndex: 0,
    title: 'Episode 1',
    size: 1000,
    sources: [{ id: 's1', kind: 'stremio' }],
    providers: { torbox: { cached: true } },
  };
  const file1 = {
    infoHash: HASH,
    fileIndex: 1,
    title: 'Episode 2',
    size: 1000,
    sources: [{ id: 's1', kind: 'stremio' }],
    providers: { torbox: { cached: false } },
  };

  const merged = mergeCandidates([file0, file1]);

  // Same hash but different fileIndex => two distinct candidates
  assert.equal(merged.length, 2, 'same torrent, different fileIndex must remain separate');
  const byIndex = Object.fromEntries(merged.map((c) => [c.fileIndex, c]));
  assert.equal(byIndex[0].title, 'Episode 1');
  assert.equal(byIndex[1].title, 'Episode 2');
});

test('discovery merger dedupes identical (infoHash, fileIndex) pairs', () => {
  const a = {
    infoHash: HASH,
    fileIndex: 3,
    title: 'First',
    sources: [{ id: 's1', kind: 'stremio' }],
    providers: { torbox: { cached: true } },
  };
  const b = {
    infoHash: HASH,
    fileIndex: 3,
    title: 'Second',
    size: 5000,
    sources: [{ id: 's2', kind: 'torznab' }],
    providers: { torbox: { cached: false } },
  };

  const merged = mergeCandidates([a, b]);
  assert.equal(merged.length, 1, 'identical (hash, fileIndex) should merge to one');
  assert.equal(merged[0].infoHash, HASH);
  assert.equal(merged[0].fileIndex, 3);
  // Both sources preserved
  assert.equal(merged[0].sources.length, 2);
});

test('discovery merger does not collapse null-fileIndex hash-only matches', () => {
  const a = {
    infoHash: HASH,
    title: 'First',
    sources: [{ id: 's1', kind: 'stremio' }],
    providers: { torbox: { cached: true } },
  };
  const b = {
    infoHash: HASH,
    title: 'Second',
    size: 5000,
    sources: [{ id: 's2', kind: 'torznab' }],
    providers: { torbox: { cached: false } },
  };

  const merged = mergeCandidates([a, b]);
  assert.equal(merged.length, 1, 'same hash, both null fileIndex, should merge');
});

