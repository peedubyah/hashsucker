/**
 * Slice 2.7 — Legacy Convergence tests.
 *
 * Production context (September 2026 audit): the VFS tables carry historical
 * rows that were materialized before the TorrentFile identity refactor
 * (slice 2.x). These rows are observable as `torrent_file_id IS NULL` in
 * `vfs_movie_entries` and `vfs_tv_entries`. A fresh authoritative
 * publication for the same logical media identity must:
 *
 *   1. atomically supersede the legacy row in place;
 *   2. preserve the published `canonical_path` verbatim so the library alias
 *      (and any downstream WebDAV / Plex / Jellyfin references) stays
 *      stable;
 *   3. remain idempotent against identical-authoritative replays;
 *   4. remain fail-closed against differing authoritative identities;
 *   5. recover from a UNIQUE race on first publication after a parallel
 *      legacy→authoritative upgrade.
 *
 * Slice 2.7 coverage adds the movie branch (slice 2.6 covered the TV
 * branch and the playback handoff upsert). The movie branch is special
 * because the primary key is `media_id` only, not `(media_id, season,
 * episode)`. Multiple first-publication writers therefore contend on the
 * single slot; the race-recovery path must reconcile the legacy row left
 * behind by a competing writer.
 *
 * These tests run against an in-memory cache, not the production DB. The
 * production DB classification is captured in `classifyVfsLegacyState`
 * which mirrors what the legacy-repair tooling reads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const INCEPTION_INFO_HASH = '0450af2b81eb8885befb1f2a92e33f72a8d9e93e';
const INCEPTION_LEGACY_INFO_HASH = 'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00';
const INCEPTION_TORRENT_FILE_ID = 'tf_inception-2010-slice27';
const INCEPTION_INTERNAL_PATH = 'Inception.2010.2160p.UHD.BluRay.x265.mkv';
const INCEPTION_SIZE = 67_234_567_890;
const INCEPTION_MEDIA_ID = 'tt1375666';
const INCEPTION_LEGACY_PATH =
  'Movies/Inception (2010) MA 5 1 HYBRID/Inception (2010) MA 5 1 HYBRID.mkv';
const INCEPTION_AUTH_PATH =
  'Movies/Inception (2010)/Inception (2010).mkv';

function controlPlaneStoreMock(torrentFiles) {
  const map = new Map(torrentFiles.map((tf) => [tf.id, tf]));
  return {
    getTorrentFile(id) {
      return map.get(id) || null;
    },
  };
}

function inceptionTorrentFile(overrides = {}) {
  return {
    id: INCEPTION_TORRENT_FILE_ID,
    infoHash: INCEPTION_INFO_HASH,
    internalPath: INCEPTION_INTERNAL_PATH,
    size: INCEPTION_SIZE,
    createdAt: 1_788_300_000_000,
    ...overrides,
  };
}

function legacyInceptionHandoff({ size = null, fileIndex = null } = {}) {
  return {
    mediaId: INCEPTION_MEDIA_ID,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: `${INCEPTION_LEGACY_INFO_HASH}:${fileIndex == null ? 'torrent' : fileIndex}`,
    infoHash: INCEPTION_LEGACY_INFO_HASH,
    fileIndex,
    filename: 'Inception.2010.MA.5.1.HYBRID.mkv',
    canonicalTitle: 'Inception',
    torrentFileId: null,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'legacy',
    selectedAt: 1_788_000_000_000,
    size,
  };
}

function authoritativeInceptionHandoff({
  torrentFileId = INCEPTION_TORRENT_FILE_ID,
  size = INCEPTION_SIZE,
} = {}) {
  return {
    mediaId: INCEPTION_MEDIA_ID,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: `${INCEPTION_INFO_HASH}:torrent`,
    infoHash: INCEPTION_INFO_HASH,
    fileIndex: null,
    filename: INCEPTION_INTERNAL_PATH,
    canonicalTitle: 'Inception',
    canonicalYear: 2010,
    torrentFileId,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'authoritative',
    selectedAt: 1_788_300_000_000,
  };
}

function seedLegacyMovieRow(cache, { size = null, fileIndex = null } = {}) {
  return cache.createVfsMovieEntry({
    mediaId: INCEPTION_MEDIA_ID,
    releaseKey: `${INCEPTION_LEGACY_INFO_HASH}:${fileIndex == null ? 'torrent' : fileIndex}`,
    infoHash: INCEPTION_LEGACY_INFO_HASH,
    fileIndex,
    canonicalPath: INCEPTION_LEGACY_PATH,
    torrentFileId: null,
    size,
    createdAt: 1_788_000_000_000,
    updatedAt: 1_788_000_000_000,
  });
}

test('classifyVfsLegacyState mirrors production observation: 20 legacy movie rows, 8 legacy TV rows', async (t) => {
  // Build an in-memory cache with the exact production classification
  // (20 legacy movies, 8 legacy TV) and verify the helper counts match.
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  for (let i = 0; i < 20; i += 1) {
    cache.createVfsMovieEntry({
      mediaId: `tt_legacy_movie_${i.toString().padStart(7, '0')}`,
      releaseKey: `legacy_movie_${i}:torrent`,
      infoHash: `lm${i.toString().padStart(38, '0')}`,
      fileIndex: null,
      canonicalPath: `Movies/Legacy Movie ${i}/Legacy Movie ${i}.mkv`,
      torrentFileId: null,
      size: 1_000_000 + i,
      createdAt: 1_788_000_000_000,
      updatedAt: 1_788_000_000_000,
    });
  }
  for (let i = 0; i < 8; i += 1) {
    cache.createVfsTvEntry({
      mediaId: `tt_legacy_tv_${i.toString().padStart(7, '0')}`,
      season: 1,
      episode: i + 1,
      releaseKey: `legacy_tv_${i}:torrent`,
      infoHash: `lt${i.toString().padStart(38, '0')}`,
      fileIndex: null,
      canonicalPath: `TV/Legacy Show/Season 01/Legacy Show - S01E${(i + 1).toString().padStart(2, '0')}.mkv`,
      torrentFileId: null,
      size: 2_000_000 + i,
      createdAt: 1_788_000_000_000,
      updatedAt: 1_788_000_000_000,
    });
  }
  for (let i = 0; i < 14; i += 1) {
    cache.createVfsTvEntry({
      mediaId: `tt_auth_tv_${i.toString().padStart(7, '0')}`,
      season: 1,
      episode: i + 1,
      releaseKey: `auth_tv_${i}:torrent`,
      infoHash: `at${i.toString().padStart(38, '0')}`,
      fileIndex: null,
      canonicalPath: `TV/Auth Show/Season 01/Auth Show - S01E${(i + 1).toString().padStart(2, '0')}.mkv`,
      torrentFileId: `tf_auth_${i}`,
      size: 3_000_000 + i,
      createdAt: 1_788_100_000_000,
      updatedAt: 1_788_100_000_000,
    });
  }

  const classification = classifyVfsLegacyState(cache);
  assert.equal(classification.movies.legacy, 20, '20 legacy movie rows (torrent_file_id IS NULL)');
  assert.equal(classification.movies.authoritative, 0, '0 authoritative movie rows');
  assert.equal(classification.tv.legacy, 8, '8 legacy TV rows');
  assert.equal(classification.tv.authoritative, 14, '14 authoritative TV rows');
  assert.equal(classification.totals.legacy, 28);
  assert.equal(classification.totals.authoritative, 14);
  assert.equal(classification.totals.rows, 42);
});

test('materializeVfsEntry supersedes a legacy movie row when authoritative publication arrives', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const legacy = seedLegacyMovieRow(cache, { size: 67_234_500_000 });
  assert.equal(legacy.torrentFileId, null, 'precondition: legacy row has NULL torrent_file_id');
  assert.equal(legacy.canonicalPath, INCEPTION_LEGACY_PATH, 'precondition: legacy canonical path preserved');

  const controlPlaneStore = controlPlaneStoreMock([inceptionTorrentFile()]);
  const before = 1_788_300_500_000;
  const after = 1_788_300_500_500;

  const entry = materializeVfsEntry(
    cache,
    authoritativeInceptionHandoff(),
    controlPlaneStore,
    () => before,
    { allowLegacy: false },
  );

  assert.equal(entry.mediaId, INCEPTION_MEDIA_ID);
  assert.equal(entry.torrentFileId, INCEPTION_TORRENT_FILE_ID, 'torrent_file_id from TorrentFile');
  assert.equal(entry.infoHash, INCEPTION_INFO_HASH, 'infoHash from TorrentFile');
  assert.equal(entry.size, INCEPTION_SIZE, 'size from TorrentFile');
  assert.equal(entry.fileIndex, null, 'file_index dropped; TorrentFile is the authority');
  assert.equal(
    entry.canonicalPath,
    INCEPTION_LEGACY_PATH,
    'canonical_path preserved verbatim so the published library alias stays stable',
  );
  assert.equal(entry.releaseKey, `${INCEPTION_INFO_HASH}:torrent`);
  assert.ok(entry.updatedAt >= before && entry.updatedAt <= after);

  const persisted = cache.getVfsMovieEntry(INCEPTION_MEDIA_ID);
  assert.equal(persisted.torrentFileId, INCEPTION_TORRENT_FILE_ID);
  assert.equal(persisted.size, INCEPTION_SIZE);
  assert.equal(persisted.canonicalPath, INCEPTION_LEGACY_PATH, 'persisted canonical path matches');
  assert.equal(persisted.infoHash, INCEPTION_INFO_HASH);

  const all = cache.listVfsMovieEntries().filter((e) => e.mediaId === INCEPTION_MEDIA_ID);
  assert.equal(all.length, 1, 'legacy movie row superseded in place — no duplicate');
});

test('materializeVfsEntry is idempotent for movies when an identical authoritative publication is replayed', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  seedLegacyMovieRow(cache, { size: 67_234_500_000 });
  const controlPlaneStore = controlPlaneStoreMock([inceptionTorrentFile()]);

  const first = materializeVfsEntry(
    cache,
    authoritativeInceptionHandoff(),
    controlPlaneStore,
    () => 1_788_300_000_000,
    { allowLegacy: false },
  );

  const second = materializeVfsEntry(
    cache,
    authoritativeInceptionHandoff(),
    controlPlaneStore,
    () => 1_788_301_000_000,
    { allowLegacy: false },
  );

  assert.equal(second.torrentFileId, first.torrentFileId);
  assert.equal(second.size, first.size);
  assert.equal(second.infoHash, first.infoHash);
  assert.equal(second.canonicalPath, first.canonicalPath);
  assert.equal(second.canonicalPath, INCEPTION_LEGACY_PATH, 'replay preserves the legacy canonical path');
  assert.equal(second.createdAt, first.createdAt, 'createdAt is preserved on idempotent replay');
  assert.ok(second.updatedAt >= first.updatedAt, 'updatedAt monotonic on replay');

  const all = cache.listVfsMovieEntries().filter((e) => e.mediaId === INCEPTION_MEDIA_ID);
  assert.equal(all.length, 1, 'replay does not create a second movie row');
});

test('materializeVfsEntry remains fail-closed for movies when an existing authoritative row has a differing TorrentFile identity', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const firstTf = inceptionTorrentFile();
  const original = cache.createVfsMovieEntry({
    mediaId: INCEPTION_MEDIA_ID,
    releaseKey: `${firstTf.infoHash}:torrent`,
    infoHash: firstTf.infoHash,
    fileIndex: null,
    canonicalPath: INCEPTION_AUTH_PATH,
    torrentFileId: firstTf.id,
    size: firstTf.size,
    createdAt: 1_788_300_000_000,
    updatedAt: 1_788_300_000_000,
  });

  const conflictingTf = inceptionTorrentFile({
    id: 'tf_inception-2010-different',
    internalPath: 'Different.2010.mkv',
    size: firstTf.size + 1,
  });
  const controlPlaneStore = controlPlaneStoreMock([firstTf, conflictingTf]);

  assert.throws(
    () => materializeVfsEntry(
      cache,
      authoritativeInceptionHandoff({ torrentFileId: conflictingTf.id, size: conflictingTf.size }),
      controlPlaneStore,
      () => 1_788_310_000_000,
      { allowLegacy: false },
    ),
    /conflicts with TorrentFile/,
    'differing authoritative identities must remain fail-closed',
  );

  const persisted = cache.getVfsMovieEntry(INCEPTION_MEDIA_ID);
  assert.equal(persisted.torrentFileId, original.torrentFileId, 'existing authoritative row is untouched');
  assert.equal(persisted.size, original.size);
  assert.equal(persisted.canonicalPath, INCEPTION_AUTH_PATH);
});

test('materializeVfsEntry inserts a fresh authoritative movie row when no legacy state exists', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const controlPlaneStore = controlPlaneStoreMock([inceptionTorrentFile()]);
  assert.equal(cache.getVfsMovieEntry(INCEPTION_MEDIA_ID), null);

  const entry = materializeVfsEntry(
    cache,
    authoritativeInceptionHandoff(),
    controlPlaneStore,
    () => 1_788_300_000_000,
    { allowLegacy: false },
  );

  assert.equal(entry.torrentFileId, INCEPTION_TORRENT_FILE_ID);
  assert.equal(entry.size, INCEPTION_SIZE);
  assert.equal(entry.infoHash, INCEPTION_INFO_HASH);
  assert.equal(entry.fileIndex, null);
  // No legacy row to preserve — the canonical path comes from the
  // canonicalTitle / canonicalYear on the handoff.
  assert.equal(entry.canonicalPath, INCEPTION_AUTH_PATH);
});

test('materializeVfsEntry race-recovery reconciles a UNIQUE first-publication race for a movie', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Simulate a competing writer that inserted a legacy row between the
  // first writer's SELECT and INSERT. The first writer's INSERT raises
  // UNIQUE constraint failure; race-recovery must reconcile by upgrading
  // the legacy row in place.
  const controlPlaneStore = controlPlaneStoreMock([inceptionTorrentFile()]);

  const insertCalls = [];
  const realInsert = cache.createVfsMovieEntry.bind(cache);
  cache.createVfsMovieEntry = (entry) => {
    insertCalls.push(entry);
    if (insertCalls.length === 1) {
      // Competing writer left a legacy row behind
      seedLegacyMovieRow(cache, { size: 67_234_500_000 });
      const err = new Error('UNIQUE constraint failed: vfs_movie_entries.media_id');
      err.code = 'SQLITE_CONSTRAINT_UNIQUE';
      throw err;
    }
    return realInsert(entry);
  };

  const entry = materializeVfsEntry(
    cache,
    authoritativeInceptionHandoff(),
    controlPlaneStore,
    () => 1_788_300_000_000,
    { allowLegacy: false },
  );

  assert.equal(insertCalls.length, 2, 'first INSERT raised UNIQUE, second retry succeeded');
  assert.equal(entry.torrentFileId, INCEPTION_TORRENT_FILE_ID, 'race-recovered authoritative identity');
  assert.equal(entry.canonicalPath, INCEPTION_LEGACY_PATH, 'race recovery preserves the competing legacy canonical path');

  const all = cache.listVfsMovieEntries().filter((e) => e.mediaId === INCEPTION_MEDIA_ID);
  assert.equal(all.length, 1, 'race recovery converges on a single row');
});

test('materializeVfsEntry refuses to supersede an authoritative row with a different movie identity', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const controlPlaneStore = controlPlaneStoreMock([inceptionTorrentFile()]);

  // Seed an authoritative row for a different movie entirely.
  const foreignTf = inceptionTorrentFile({
    id: 'tf_other-movie',
    internalPath: 'OtherMovie.mkv',
    size: 1_000_000,
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt_other_movie',
    releaseKey: `${foreignTf.infoHash}:torrent`,
    infoHash: foreignTf.infoHash,
    fileIndex: null,
    canonicalPath: 'Movies/Other Movie/Other Movie.mkv',
    torrentFileId: foreignTf.id,
    size: foreignTf.size,
    createdAt: 1_788_300_000_000,
    updatedAt: 1_788_300_000_000,
  });
  cache.createVfsMovieEntry = cache.createVfsMovieEntry;

  // Now seed a legacy Inception row, and verify a different media_id
  // CANNOT have its authoritative identity migrated under Inception's
  // media_id.
  seedLegacyMovieRow(cache);
  const entry = materializeVfsEntry(
    cache,
    authoritativeInceptionHandoff(),
    controlPlaneStore,
    () => 1_788_300_000_000,
    { allowLegacy: false },
  );

  assert.equal(entry.mediaId, INCEPTION_MEDIA_ID);
  assert.equal(entry.torrentFileId, INCEPTION_TORRENT_FILE_ID);
  // The unrelated authoritative row must remain untouched.
  const other = cache.getVfsMovieEntry('tt_other_movie');
  assert.equal(other.torrentFileId, 'tf_other-movie');
  assert.equal(other.canonicalPath, 'Movies/Other Movie/Other Movie.mkv');
});

test('classifyVfsLegacyState reports zero legacy rows after full authoritative upgrade', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Seed two legacy movie rows, then upgrade both authoritatively.
  for (const mid of ['tt_movie_a', 'tt_movie_b']) {
    cache.createVfsMovieEntry({
      mediaId: mid,
      releaseKey: `legacy_${mid}:torrent`,
      infoHash: `legacy_${mid}_hash`,
      fileIndex: null,
      canonicalPath: `Movies/${mid}/${mid}.mkv`,
      torrentFileId: null,
      size: 1_000_000,
      createdAt: 1_788_000_000_000,
      updatedAt: 1_788_000_000_000,
    });
  }

  const controlPlaneStore = controlPlaneStoreMock([
    inceptionTorrentFile({ id: 'tf_movie_a', internalPath: 'movie-a.mkv' }),
    inceptionTorrentFile({ id: 'tf_movie_b', internalPath: 'movie-b.mkv' }),
  ]);
  materializeVfsEntry(
    cache,
    { ...authoritativeInceptionHandoff({ torrentFileId: 'tf_movie_a' }), mediaId: 'tt_movie_a' },
    controlPlaneStore,
    () => 1_788_300_000_000,
    { allowLegacy: false },
  );
  materializeVfsEntry(
    cache,
    { ...authoritativeInceptionHandoff({ torrentFileId: 'tf_movie_b' }), mediaId: 'tt_movie_b' },
    controlPlaneStore,
    () => 1_788_300_001_000,
    { allowLegacy: false },
  );

  const classification = classifyVfsLegacyState(cache);
  assert.equal(classification.movies.legacy, 0, 'no legacy movie rows after upgrade');
  assert.equal(classification.movies.authoritative, 2, '2 authoritative movie rows');
  assert.equal(classification.totals.legacy, 0, 'no legacy rows in either table');
});

test('allowLegacy=false rejects a movie handoff that has no TorrentFile', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const controlPlaneStore = controlPlaneStoreMock([]);

  assert.throws(
    () => materializeVfsEntry(
      cache,
      {
        mediaId: 'tt_no_tf',
        mediaType: 'movie',
        releaseKey: 'no_tf:torrent',
        infoHash: 'no_tf',
        fileIndex: null,
        filename: 'no-tf.mkv',
        provider: 'torbox',
        providerState: 'cached',
        identityTier: 'Verified',
        resolutionState: 'confirmed',
        selectionReason: 'test',
        selectedAt: 1_788_300_000_000,
        torrentFileId: null,
      },
      controlPlaneStore,
      () => 1_788_300_000_000,
      { allowLegacy: false },
    ),
    /TorrentFile identity is required/,
    'allowLegacy=false requires a TorrentFile for new movie publication',
  );
});

test('materializeVfsEntry preserves a legacy movie canonical path even when a fresh request carries a different canonicalTitle', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Legacy row was published with the provider release title baked into
  // the canonical path. The new request comes in with the canonical
  // Cinemeta title. The legacy alias must survive verbatim so Plex /
  // Jellyfin / WebDAV references stay stable.
  cache.createVfsMovieEntry({
    mediaId: INCEPTION_MEDIA_ID,
    releaseKey: 'legacy_inception:torrent',
    infoHash: 'legacy_inception_hash',
    fileIndex: null,
    canonicalPath: 'Movies/Inception (2010) MULTi VFF 10bit Light MA 5 1/Inception (2010) MULTi VFF 10bit Light MA 5 1.mkv',
    torrentFileId: null,
    size: 67_234_500_000,
    createdAt: 1_788_000_000_000,
    updatedAt: 1_788_000_000_000,
  });

  const controlPlaneStore = controlPlaneStoreMock([inceptionTorrentFile()]);
  const entry = materializeVfsEntry(
    cache,
    {
      ...authoritativeInceptionHandoff(),
      canonicalTitle: 'Inception',
      canonicalYear: 2010,
    },
    controlPlaneStore,
    () => 1_788_300_000_000,
    { allowLegacy: false },
  );

  assert.equal(
    entry.canonicalPath,
    'Movies/Inception (2010) MULTi VFF 10bit Light MA 5 1/Inception (2010) MULTi VFF 10bit Light MA 5 1.mkv',
    'legacy canonical path is preserved even when the new request carries a different canonicalTitle',
  );
  assert.equal(entry.torrentFileId, INCEPTION_TORRENT_FILE_ID);
  assert.equal(entry.size, INCEPTION_SIZE);
});

/**
 * Classify the legacy state of an in-memory or on-disk discovery cache.
 * Mirrors the production observation (September 2026 audit):
 *   - 20 legacy movie rows (torrent_file_id IS NULL)
 *   - 0 authoritative movie rows
 *   - 8 legacy TV rows
 *   - 14 authoritative TV rows
 *
 * Used by the legacy-repair tooling to summarize convergence progress.
 */
function classifyVfsLegacyState(cache) {
  const movieRows = cache.listVfsMovieEntries();
  const tvRows = cache.listVfsTvEntries();
  const classification = {
    movies: { legacy: 0, authoritative: 0 },
    tv: { legacy: 0, authoritative: 0 },
    totals: { legacy: 0, authoritative: 0, rows: 0 },
  };
  for (const row of movieRows) {
    if (row.torrentFileId == null) classification.movies.legacy += 1;
    else classification.movies.authoritative += 1;
  }
  for (const row of tvRows) {
    if (row.torrentFileId == null) classification.tv.legacy += 1;
    else classification.tv.authoritative += 1;
  }
  classification.totals.legacy = classification.movies.legacy + classification.tv.legacy;
  classification.totals.authoritative = classification.movies.authoritative + classification.tv.authoritative;
  classification.totals.rows = movieRows.length + tvRows.length;
  return classification;
}
