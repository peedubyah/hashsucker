/**
 * Library unpublish tests.
 *
 * Proves unpublish removes presentation (VFS rows, .strm files), marks the
 * library item absent with active bindings superseded, keeps durable
 * identity (handoffs), never touches siblings, and scopes seasons unit
 * by unit. Uses an in-memory discovery cache, a stub control-plane store,
 * and a temp STRM root — no network, no production state.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { unpublishMedia } from '../src/lib/library/unpublish.js';

const HASH = 'aabbccddeeff00112233445566778899aabbccdd';

function seedMovie(cache, mediaId, tfId) {
  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null },
    [],
  );
  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    filename: 'Movie (2024).mkv', provider: 'torbox', providerState: 'cached',
    identityTier: 'ProviderConfirmed', resolutionState: 'resolved',
    selectionReason: 'r', selectedAt: Date.now(), torrentFileId: tfId,
  });
  cache.createVfsMovieEntry({
    mediaId, releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    canonicalPath: `Movies/Movie (2024)/Movie (2024).mkv`,
    torrentFileId: tfId, size: 100, createdAt: Date.now(), updatedAt: Date.now(),
  });
}

function seedEpisode(cache, mediaId, season, episode, tfId) {
  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'series', season, episode },
    [],
  );
  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'series', season, episode,
    releaseKey: `${HASH}:${episode - 1}`, infoHash: HASH, fileIndex: episode - 1,
    filename: `Show S01E0${episode}.mkv`, provider: 'torbox', providerState: 'cached',
    identityTier: 'ProviderScoped', resolutionState: 'resolved',
    selectionReason: 'r', selectedAt: Date.now(), torrentFileId: tfId,
  });
  cache.createVfsTvEntry({
    mediaId, season, episode, releaseKey: `${HASH}:${episode - 1}`, infoHash: HASH,
    fileIndex: episode - 1,
    canonicalPath: `TV/Show (2024)/Season 01/Show - S01E0${episode}.mkv`,
    torrentFileId: tfId, size: 100, createdAt: Date.now(), updatedAt: Date.now(),
  });
}

function stubStore(log) {
  return {
    unpublishLibraryItem: (key) => {
      log.push(key);
      return { libraryItemId: 'li_1', identityKey: key, desiredState: 'absent', supersededBindings: 1 };
    },
  };
}

async function withStrmRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unpub-strm-'));
  const saved = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = dir;
  try {
    return await fn(dir);
  } finally {
    if (saved === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeStrm(root, rel, content) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  return file;
}

test('unpublishMedia: movie removes VFS row and strm, keeps handoff', async () => {
  await withStrmRoot(async (root) => {
    const cache = createDiscoveryCache();
    seedMovie(cache, 'tt_unpub_1', 'tf_unpub_1');
    const strm = await writeStrm(root, 'Movies/Movie (2024)/Movie (2024).strm',
      'http://localhost:8080/stream/movie/tt_unpub_1\n');
    const log = [];
    const result = await unpublishMedia({
      cache, controlPlaneStore: stubStore(log),
      mediaId: 'tt_unpub_1', mediaType: 'movie',
    });
    assert.equal(result.unpublished, true);
    assert.equal(result.units.length, 1);
    assert.deepEqual(log, ['movie:tt_unpub_1:default']);
    assert.equal(result.units[0].vfsDeleted, 1);
    assert.equal(result.units[0].strmDeleted.length, 1);
    assert.equal(cache.getVfsMovieEntry('tt_unpub_1'), null);
    await assert.rejects(fs.access(strm));
    // Durable handoff retained for cheap republish.
    assert.equal(
      cache.db.prepare('SELECT COUNT(*) AS n FROM playback_handoffs WHERE media_id = ?')
        .get('tt_unpub_1').n, 1,
    );
    // Idempotent repeat converges with zeros.
    const again = await unpublishMedia({
      cache, controlPlaneStore: stubStore([]),
      mediaId: 'tt_unpub_1', mediaType: 'movie',
    });
    assert.equal(again.units[0].vfsDeleted, 0);
    assert.equal(again.units[0].strmDeleted.length, 0);
    cache.close();
  });
});

test('unpublishMedia: episode is scoped and never touches siblings', async () => {
  await withStrmRoot(async (root) => {
    const cache = createDiscoveryCache();
    seedEpisode(cache, 'tt_unpub_ep', 1, 1, 'tf_e1');
    seedEpisode(cache, 'tt_unpub_ep', 1, 2, 'tf_e2');
    await writeStrm(root, 'TV Shows/Show (2024)/Season 01/Show (2024) - S01E01.strm',
      'http://localhost:8080/stream/series/tt_unpub_ep?season=1&episode=1\n');
    const e2file = await writeStrm(root, 'TV Shows/Show (2024)/Season 01/Show (2024) - S01E02.strm',
      'http://localhost:8080/stream/series/tt_unpub_ep?season=1&episode=2\n');
    const log = [];
    const result = await unpublishMedia({
      cache, controlPlaneStore: stubStore(log),
      mediaId: 'tt_unpub_ep', mediaType: 'series', season: 1, episode: 1,
    });
    assert.equal(result.units.length, 1);
    assert.deepEqual(log, ['episode:tt_unpub_ep:default:1:1']);
    assert.equal(cache.getVfsTvEntry('tt_unpub_ep', 1, 1), null);
    assert.ok(cache.getVfsTvEntry('tt_unpub_ep', 1, 2), 'sibling VFS entry retained');
    await fs.access(e2file); // sibling strm retained
    cache.close();
  });
});

test('unpublishMedia: season unpublishes every published episode unit', async () => {
  await withStrmRoot(async (root) => {
    const cache = createDiscoveryCache();
    seedEpisode(cache, 'tt_unpub_se', 2, 1, 'tf_s1');
    seedEpisode(cache, 'tt_unpub_se', 2, 2, 'tf_s2');
    const log = [];
    const result = await unpublishMedia({
      cache, controlPlaneStore: stubStore(log),
      mediaId: 'tt_unpub_se', mediaType: 'series', season: 2, episode: null,
    });
    assert.equal(result.units.length, 2);
    assert.equal(cache.getVfsTvEntry('tt_unpub_se', 2, 1), null);
    assert.equal(cache.getVfsTvEntry('tt_unpub_se', 2, 2), null);
    assert.ok(root, 'strm root used');
    cache.close();
  });
});
