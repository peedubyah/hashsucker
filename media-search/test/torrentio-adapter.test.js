/**
 * Torrentio Adapter Tests
 *
 * Validates the Torrentio discovery adapter normalization behavior.
 * Uses mocked fetch for deterministic tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverViaTorrentio } from '../src/lib/discovery/adapters/torrentio.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function installFetchMock(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function makeTorrentioResponse(streams) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ streams }),
  };
}

const source = {
  id: 'torrentio.torbox',
  kind: 'torrentio',
  provider: 'torbox',
  endpoint: 'https://torrentio.strem.fun/torbox=test-key/manifest.json',
  timeoutMs: 5000,
  capabilities: { textSearch: true },
};

test('normal: movie result extracts explicit infoHash', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      infoHash: HASH,
      name: '[TB] The.Matrix.1999.2160p',
      url: `magnet:?xt=urn:btih:${HASH}`,
      behaviorHints: {
        filename: 'The.Matrix.1999.2160p.UHD.BluRay.REMUX.mkv',
        videoSize: 85899345920,
      },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt0133093' },
      source
    );

    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.infoHash, HASH);
    assert.equal(r.filename, 'The.Matrix.1999.2160p.UHD.BluRay.REMUX.mkv');
    assert.equal(r.size, 85899345920);
    assert.equal(r.title, '[TB] The.Matrix.1999.2160p');
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].id, 'torrentio.torbox');
    assert.equal(r.sources[0].kind, 'torrentio');
  } finally {
    restore();
  }
});

test('normal: TV episode result with behaviorHints.filename', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      infoHash: HASH,
      name: '[RD] Breaking.Bad.S05E14.1080p',
      url: `magnet:?xt=urn:btih:${HASH}`,
      behaviorHints: {
        filename: 'Breaking.Bad.S05E14.Felina.1080p.WEB-DL.x264-GROUP.mkv',
        videoSize: 1073741824,
      },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'series', mediaId: 'tt0903747:5:14' },
      source
    );

    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.infoHash, HASH);
    assert.equal(r.filename, 'Breaking.Bad.S05E14.Felina.1080p.WEB-DL.x264-GROUP.mkv');
    assert.equal(r.size, 1073741824);
  } finally {
    restore();
  }
});

test('behaviorHints.filename takes precedence over raw.name for filename', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      infoHash: HASH,
      name: '[TB] 2160p UHD',  // Display label, NOT release name
      url: `magnet:?xt=urn:btih:${HASH}`,
      behaviorHints: {
        filename: 'Actual.Release.Name.2160p.mkv',  // Authoritative
      },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    assert.equal(results.length, 1);
    // Filename should be behaviorHints.filename, NOT display name
    assert.equal(results[0].filename, 'Actual.Release.Name.2160p.mkv');
    // Title can be the display name
    assert.equal(results[0].title, '[TB] 2160p UHD');
  } finally {
    restore();
  }
});

test('cache hints [TB] [RD] [PM] are extracted but providers remain null', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      infoHash: HASH,
      name: '[TB] 2160p',
      url: `magnet:?xt:urn:btih:${HASH}`,
      behaviorHints: { filename: 'Release.2160p.mkv' },
    },
    {
      infoHash: OTHER_HASH,
      name: '[RD] 1080p',
      url: `magnet:?xt:urn:btih:${OTHER_HASH}`,
      behaviorHints: { filename: 'Other.Release.1080p.mkv' },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    assert.equal(results.length, 2);

    // [TB] hint should be in cacheHints
    const tbResult = results.find(r => r.infoHash === HASH);
    assert.ok(tbResult);
    assert.equal(tbResult.cacheHints.length, 1);
    assert.equal(tbResult.cacheHints[0].provider, 'torbox');
    assert.equal(tbResult.cacheHints[0].label, '[TB]');

    // [RD] hint should be in cacheHints
    const rdResult = results.find(r => r.infoHash === OTHER_HASH);
    assert.ok(rdResult);
    assert.equal(rdResult.cacheHints.length, 1);
    assert.equal(rdResult.cacheHints[0].provider, 'realdebrid');
    assert.equal(rdResult.cacheHints[0].label, '[RD]');

    // CRITICAL: providers must remain null — cache hints are NOT observations
    assert.equal(tbResult.providers.torbox.cached, null);
    assert.equal(rdResult.providers.realdebrid.cached, null);
  } finally {
    restore();
  }
});

test('cache hint does NOT create provider_observations (providers object)', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      infoHash: HASH,
      name: '[TB] Cached.Release',
      url: `magnet:?xt:urn:btih:${HASH}`,
      behaviorHints: { filename: 'Cached.Release.mkv' },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    const r = results[0];
    // Providers object should always have cached: null from Torrentio
    assert.deepEqual(r.providers.torbox, { cached: null, evidence: null });
    assert.deepEqual(r.providers.realdebrid, { cached: null, evidence: null });
  } finally {
    restore();
  }
});

test('malformed result without infoHash is rejected', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      name: 'No Hash Here',
      url: 'https://example.com/download',  // Not a magnet
      behaviorHints: { filename: 'No.Hash.mkv' },
    },
    {
      infoHash: HASH,
      name: 'Valid Result',
      url: `magnet:?xt:urn:btih:${HASH}`,
      behaviorHints: { filename: 'Valid.Result.mkv' },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    // Only the valid result should be returned
    assert.equal(results.length, 1);
    assert.equal(results[0].infoHash, HASH);
  } finally {
    restore();
  }
});

test('infoHash from magnet URL when explicit field missing', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      // No explicit infoHash field
      name: 'Magnet Only',
      url: `magnet:?xt:urn:btih:${HASH}`,
      behaviorHints: { filename: 'Magnet.Only.mkv' },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].infoHash, HASH);
    assert.equal(results[0].magnet, `magnet:?xt:urn:btih:${HASH}`);
  } finally {
    restore();
  }
});

test('duplicate hashes from same source are preserved', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      infoHash: HASH,
      name: '[TB] Duplicate 1',
      url: `magnet:?xt:urn:btih:${HASH}`,
      behaviorHints: { filename: 'Duplicate.1.mkv' },
    },
    {
      infoHash: HASH,
      name: '[TB] Duplicate 2',
      url: `magnet:?xt:urn:btih:${HASH}`,
      behaviorHints: { filename: 'Duplicate.2.mkv' },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    // Both results returned — merge logic downstream handles dedup
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.infoHash === HASH));
  } finally {
    restore();
  }
});

test('upstream failure returns error without breaking', async () => {
  const restore = installFetchMock(async () => {
    throw new Error('network timeout');
  });

  try {
    await assert.rejects(
      () => discoverViaTorrentio(
        { mediaType: 'movie', mediaId: 'tt1234567' },
        source
      ),
      { message: 'network timeout' }
    );
  } finally {
    restore();
  }
});

test('upstream HTTP error returns error without breaking', async () => {
  const restore = installFetchMock(async () => ({
    ok: false,
    status: 503,
  }));

  try {
    await assert.rejects(
      () => discoverViaTorrentio(
        { mediaType: 'movie', mediaId: 'tt1234567' },
        source
      ),
      { message: /Torrentio .* HTTP 503/ }
    );
  } finally {
    restore();
  }
});

test('empty streams returns empty array', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    assert.deepEqual(results, []);
  } finally {
    restore();
  }
});

test('null/undefined streams returns empty array', async () => {
  const restore = installFetchMock(async () => ({
    ok: true,
    json: async () => ({ streams: null }),
  }));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    assert.deepEqual(results, []);
  } finally {
    restore();
  }
});

test('fileIndex is always null from Torrentio', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      infoHash: HASH,
      name: 'Release',
      url: `magnet:?xt:urn:btih:${HASH}`,
      behaviorHints: { filename: 'Release.mkv' },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    assert.equal(results[0].fileIndex, null);
  } finally {
    restore();
  }
});

test('cache hint evidence does not leak to providers (integration contract)', async () => {
  const restore = installFetchMock(async () => makeTorrentioResponse([
    {
      infoHash: HASH,
      name: '[TB] Release.Name',
      url: `magnet:?xt:urn:btih:${HASH}`,
      behaviorHints: { filename: 'Release.Name.mkv' },
    },
  ]));

  try {
    const results = await discoverViaTorrentio(
      { mediaType: 'movie', mediaId: 'tt1234567' },
      source
    );

    const r = results[0];
    // Even with [TB] hint, providers object must NOT assert cached=true
    // This is the critical contract: cache hints ≠ provider observations
    assert.equal(r.providers.torbox.cached, null, 'Cache hint must not create provider observation');
  } finally {
    restore();
  }
});
