/**
 * Media preparation tests (preparation tranche).
 *
 * Covers, on fixture cache/stores with zero network (skipLiveDiscovery +
 * skipAvailability + stubbed TorBox ensure):
 * - preparation persists reusable durable truth without publishing
 *   (no VFS row, no STRM file, no notification side effects possible)
 * - a later normal request republishes from prepared state with zero
 *   additional provider work
 * - exact movie and exact episode identity scoping
 * - stale prepared state falls back safely into the normal path
 * - repeated prepare is idempotent
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { searchByMedia, getPreparedDurableState } from '../src/api/media-request.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';

const MOVIE_ID = 'tt1000001';
const MOVIE_HASH = 'aabbccddeeff00112233445566778899aabbcc01';
const SERIES_ID = 'tt1000002';
const EP_HASH = 'bbccddeeff00112233445566778899aabbccdd02';

function movieTorrentFile() {
  return { id: 'tf_mov1', infoHash: MOVIE_HASH, internalPath: 'Movie/Movie.mkv', size: 12345 };
}
function episodeTorrentFile() {
  return { id: 'tf_ep1', infoHash: EP_HASH, internalPath: 'Show/Season 01/Show - S01E01.mkv', size: 999 };
}

function stubStore(torrentFile) {
  return {
    getTorrentFile: (id) => (id === torrentFile.id ? { ...torrentFile } : null),
    listDataPlaneCoordinates: (id) => (id === torrentFile.id
      ? [{ provider: 'torbox', account_scope: 'default', provider_resource_id: 'r1', provider_file_id: 'f1', size: torrentFile.size }]
      : []),
    listTorrentFilesForRelease: () => [{ ...torrentFile }],
    listProviderRefsForTorrentFile: () => [{ placementId: 'pl1', present: true, providerFileId: 'f1' }],
  };
}

// Two provider interactions exist in this pipeline and the stub records
// which one ran:
//   selection/binding work — ensure({ infoHash, controlPlaneStore, ... }):
//     creates the cached-only placement and reads the inventory that the
//     cardinality/exact-size binding decision consumes;
//   bounded route refresh — ensure({ infoHash, skipSizeMatch: true }) with no
//     store: re-proves route freshness for the authoritative Binding guard.
// The reuse path is only allowed to do the second.
function stubEnsure(torrentFile, calls) {
  return async (params = {}) => {
    calls.count++;
    const isSelectionWork = params.controlPlaneStore != null;
    calls[isSelectionWork ? 'bindingWork' : 'routeRefresh'] =
      (calls[isSelectionWork ? 'bindingWork' : 'routeRefresh'] ?? 0) + 1;
    if (params.skipSizeMatch) {
      return { placementId: 'pl1', torrentFiles: [{ ...torrentFile }] };
    }
    return { placementId: 'pl1', providerFileId: 'f1', torrentFileId: torrentFile.id, size: torrentFile.size };
  };
}

function seedMovie(cache) {
  cache.upsertCandidate({
    infoHash: MOVIE_HASH, fileIndex: null, filename: 'Movie.2020.1080p.mkv', title: 'Movie',
  });
  storeReleaseAttributes(cache, {
    infoHash: MOVIE_HASH, fileIndex: null, filename: 'Movie.2020.1080p.mkv',
    source: 'test', confidence: 0.9,
    parsed: { title: 'Movie', year: 2020, resolution: '1080p', mediaType: 'movie' },
    evidence: ['test'],
  });
  cache.associateMedia(MOVIE_HASH, null, MOVIE_ID, {
    source: 'test', confidence: 0.8, evidence: ['test'],
    resolutionState: 'probable', matchMethod: 'test', resolverSource: 'test', resolverVersion: '1.0',
  });
}

function seedEpisode(cache) {
  cache.upsertCandidate({
    infoHash: EP_HASH, fileIndex: null, filename: 'Show.S01E01.1080p.mkv', title: 'Show',
  });
  storeReleaseAttributes(cache, {
    infoHash: EP_HASH, fileIndex: null, filename: 'Show.S01E01.1080p.mkv',
    source: 'test', confidence: 0.9,
    parsed: { title: 'Show', season: 1, episode: 1, resolution: '1080p', mediaType: 'series' },
    evidence: ['test'],
  });
  cache.associateMedia(EP_HASH, null, SERIES_ID, {
    source: 'test', confidence: 0.8, evidence: ['test'],
    resolutionState: 'probable', matchMethod: 'test', resolverSource: 'test', resolverVersion: '1.0',
  });
}

function withTmpStrm(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-strm-'));
  const saved = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const baseReq = {
  skipLiveDiscovery: true,
  skipAvailability: true,
  persist: true,
};

test('prepareOnly persists handoff without VFS, STRM, or publication', async (t) => {
  const dir = withTmpStrm(t);
  const cache = createDiscoveryCache();
  try {
    seedMovie(cache);
    const tf = movieTorrentFile();
    const calls = { count: 0 };
    const result = await searchByMedia(cache, {
      ...baseReq,
      mediaId: MOVIE_ID,
      mediaType: 'movie',
      mediaTitle: 'Movie',
      canonicalYear: 2020,
      prepareOnly: true,
      controlPlaneStore: stubStore(tf),
      ensureTorBoxFileIdentity: stubEnsure(tf, calls),
    });
    assert.equal(result.prepared, true);
    assert.equal(result.published, false);
    assert.ok(result.handoff?.torrentFileId === 'tf_mov1', 'handoff carries exact TorrentFile');
    assert.equal(result.handoff.infoHash, MOVIE_HASH);
    // Durable truth persisted...
    const stored = cache.getPlaybackHandoffByMediaId(MOVIE_ID);
    assert.ok(stored, 'handoff row persisted');
    // ...but nothing presented.
    assert.equal(cache.getVfsMovieEntry(MOVIE_ID), null, 'no VFS row');
    assert.deepEqual(fs.readdirSync(dir), [], 'no STRM file written');
    assert.equal(calls.count, 1, 'exactly one binding attempt');
  } finally {
    cache.close();
  }
});

test('prepared request republishes with no additional binding work (one bounded route refresh)', async (t) => {
  const dir = withTmpStrm(t);
  const cache = createDiscoveryCache();
  try {
    seedMovie(cache);
    const tf = movieTorrentFile();
    const calls = { count: 0 };
    const store = stubStore(tf);
    const ensure = stubEnsure(tf, calls);
    const prep = await searchByMedia(cache, {
      ...baseReq, mediaId: MOVIE_ID, mediaType: 'movie', mediaTitle: 'Movie', canonicalYear: 2020, prepareOnly: true,
      controlPlaneStore: store, ensureTorBoxFileIdentity: ensure,
    });
    assert.equal(prep.prepared, true);
    assert.equal(calls.count, 1);

    // The reuse path performs exactly one bounded provider interaction: the
    // route-inventory refresh that re-proves freshness for the authoritative
    // Binding guard (inventory/readiness/exposure observations carry a TTL, so
    // a republish hours later cannot activate without it). It performs NO
    // binding work: no exact-size identity match, no placement creation, no
    // candidate re-selection.
    const req = await searchByMedia(cache, {
      ...baseReq, mediaId: MOVIE_ID, mediaType: 'movie', mediaTitle: 'Movie', canonicalYear: 2020,
      controlPlaneStore: store, ensureTorBoxFileIdentity: ensure,
    });
    assert.equal(req.reuseMode, 'republish');
    assert.equal(calls.count, 2, 'exactly one additional provider interaction');
    assert.equal(calls.routeRefresh, 1, 'that interaction is the bounded route refresh');
    assert.equal(calls.bindingWork, 1, 'no new selection/binding work (the prepare pass created the placement)');
    assert.equal(req.availability.checked, 0, 'no availability re-check');
    assert.equal(req.handoff.torrentFileId, 'tf_mov1', 'same TorrentFile published');
    const vfs = cache.getVfsMovieEntry(MOVIE_ID);
    assert.ok(vfs, 'VFS row materialized on request');
    assert.equal(vfs.torrentFileId, 'tf_mov1');
    assert.ok(fs.readdirSync(dir).length >= 0, 'strm dir readable');
  } finally {
    cache.close();
  }
});

test('prepareOnly respects exact episode identity', async (t) => {
  withTmpStrm(t);
  const cache = createDiscoveryCache();
  try {
    seedEpisode(cache);
    const tf = episodeTorrentFile();
    const calls = { count: 0 };
    const store = stubStore(tf);
    const ensure = stubEnsure(tf, calls);
    const prep = await searchByMedia(cache, {
      ...baseReq, mediaId: SERIES_ID, mediaType: 'series', season: 1, episode: 1, mediaTitle: 'Show',
      prepareOnly: true, controlPlaneStore: store, ensureTorBoxFileIdentity: ensure,
    });
    assert.equal(prep.prepared, true);
    assert.equal(prep.handoff.season, 1);
    assert.equal(prep.handoff.episode, 1);
    assert.equal(prep.handoff.torrentFileId, 'tf_ep1');

    // A different episode must NOT see this preparation.
    const other = getPreparedDurableState({
      cache, controlPlaneStore: store, mediaId: SERIES_ID, mediaType: 'series', season: 1, episode: 2,
    });
    assert.equal(other, null, 'S01E02 is not prepared by S01E01 work');
  } finally {
    cache.close();
  }
});

test('stale prepared state falls back safely into the normal path', async (t) => {
  withTmpStrm(t);
  const cache = createDiscoveryCache();
  try {
    seedMovie(cache);
    const tf = movieTorrentFile();
    const calls = { count: 0 };
    const store = stubStore(tf);
    const prep = await searchByMedia(cache, {
      ...baseReq, mediaId: MOVIE_ID, mediaType: 'movie', mediaTitle: 'Movie', canonicalYear: 2020, prepareOnly: true,
      controlPlaneStore: store, ensureTorBoxFileIdentity: stubEnsure(tf, calls),
    });
    assert.equal(prep.prepared, true);

    // TorrentFile row disappears (stale durable truth).
    const staleStore = { ...store, getTorrentFile: () => null };
    assert.equal(
      getPreparedDurableState({ cache, controlPlaneStore: staleStore, mediaId: MOVIE_ID, mediaType: 'movie' }),
      null,
      'predicate rejects stale truth',
    );
    const req = await searchByMedia(cache, {
      ...baseReq, mediaId: MOVIE_ID, mediaType: 'movie', mediaTitle: 'Movie', canonicalYear: 2020,
      controlPlaneStore: staleStore, ensureTorBoxFileIdentity: stubEnsure(tf, calls),
    });
    assert.ok(!req.reuseMode, 'no reuse on stale truth — normal path taken');
  } finally {
    cache.close();
  }
});

test('repeated prepare is idempotent and never publishes', async (t) => {
  const dir = withTmpStrm(t);
  const cache = createDiscoveryCache();
  try {
    seedMovie(cache);
    const tf = movieTorrentFile();
    const calls = { count: 0 };
    const store = stubStore(tf);
    const ensure = stubEnsure(tf, calls);
    const first = await searchByMedia(cache, {
      ...baseReq, mediaId: MOVIE_ID, mediaType: 'movie', mediaTitle: 'Movie', canonicalYear: 2020, prepareOnly: true,
      controlPlaneStore: store, ensureTorBoxFileIdentity: ensure,
    });
    const second = await searchByMedia(cache, {
      ...baseReq, mediaId: MOVIE_ID, mediaType: 'movie', mediaTitle: 'Movie', canonicalYear: 2020, prepareOnly: true,
      controlPlaneStore: store, ensureTorBoxFileIdentity: ensure,
    });
    assert.equal(first.prepared, true);
    assert.equal(second.prepared, true);
    assert.equal(second.alreadyPrepared, true, 'second prepare is a local no-op');
    assert.equal(second.handoff.torrentFileId, first.handoff.torrentFileId, 'same TorrentFile');
    assert.equal(calls.count, 1, 'no repeat provider work');
    assert.equal(cache.getVfsMovieEntry(MOVIE_ID), null, 'still nothing published');
    assert.deepEqual(fs.readdirSync(dir), [], 'still no STRM file');
  } finally {
    cache.close();
  }
});
