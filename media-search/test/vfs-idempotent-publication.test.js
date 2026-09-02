/**
 * VFS idempotent publication (Slice 2.9 / A4).
 *
 * Proves four idempotency contracts for the modern VFS write path:
 *
 *   1. Same logical alias (media_id+season+episode) + same TorrentFile
 *      -> exactly one durable VFS row, no duplicates.
 *
 *   2. Same alias + a different authoritative TorrentFile (same infoHash,
 *      different internal_path/size, different torrent_file_id) -> the
 *      existing authoritative row is preserved (assertExistingIdentity
 *      throws). The new TF is NOT silently written over the old one.
 *
 *   3. Concurrent identical first-publication race -> the race-recovery
 *      path reconciles to a single logical row. We simulate the race by
 *      triggering the unique-constraint branch on the underlying INSERT
 *      via direct cache calls.
 *
 *   4. Missing episode (no VFS row, no legacy row) -> insert only. No
 *      supersede branch is taken, no duplicate row is created.
 *
 * Also asserts that the UNIQUE constraints on vfs_movie_entries
 * (PRIMARY KEY media_id) and vfs_tv_entries (PRIMARY KEY media_id, season,
 * episode) plus UNIQUE canonical_path enforce single-row-per-slot.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const INFO_HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INFO_HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function controlPlaneWith(torrentFiles) {
  const map = new Map(torrentFiles.map((tf) => [tf.id, tf]));
  return {
    getTorrentFile(id) {
      return map.get(id) || null;
    },
  };
}

function authoritativeHandoff({ torrentFileId, infoHash = INFO_HASH_A, season = 1, episode = 1, mediaId = 'tt0000099' } = {}) {
  return {
    mediaId,
    mediaType: 'tv',
    season,
    episode,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    filename: `Show.S0${season}E0${episode}.2160p.mkv`,
    canonicalTitle: 'Show',
    torrentFileId,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_788_000_000_000,
  };
}

function torrentFile({ id, infoHash = INFO_HASH_A, internalPath, size = 5_000_000_000 }) {
  return {
    id,
    infoHash,
    internalPath: internalPath || `Show.S01.2160p/Show.S01.01.2160p.${id}.mkv`,
    size,
    createdAt: 1_788_000_000_000,
  };
}

test('same logical alias + same TorrentFile -> exactly one durable VFS row (idempotent)', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  const tf = torrentFile({ id: 'tf_same' });
  const controlPlane = controlPlaneWith([tf]);

  const handoff = authoritativeHandoff({ torrentFileId: 'tf_same' });
  const a = materializeVfsEntry(cache, handoff, controlPlane, () => 1_788_000_000_000, { allowLegacy: false });
  const b = materializeVfsEntry(cache, handoff, controlPlane, () => 1_788_000_500_000, { allowLegacy: false });

  // Idempotency: identity preserved across replays.
  assert.equal(b.torrentFileId, a.torrentFileId);
  assert.equal(b.size, a.size);
  assert.equal(b.canonicalPath, a.canonicalPath);
  assert.equal(b.createdAt, a.createdAt, 'createdAt preserved on replay');

  // No duplicate row in the table.
  const all = cache.listVfsTvEntries().filter((e) =>
    e.mediaId === 'tt0000099' && e.season === 1 && e.episode === 1);
  assert.equal(all.length, 1);

  // The UNIQUE canonical_path constraint must reject a second insert.
  assert.throws(
    () => cache.createVfsTvEntry({
      mediaId: 'tt0000099', season: 1, episode: 1,
      releaseKey: `${INFO_HASH_A}:torrent`, infoHash: INFO_HASH_A,
      fileIndex: null, canonicalPath: a.canonicalPath,
      torrentFileId: 'tf_same', size: a.size,
      createdAt: 1_788_001_000_000, updatedAt: 1_788_001_000_000,
    }),
    /UNIQUE|PRIMARY KEY/,
    'vfs_tv_entries.canonical_path UNIQUE / (media_id, season, episode) PK',
  );
});

test('same alias + different authoritative TorrentFile -> fail-closed (no silent overwrite)', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const tfOriginal = torrentFile({ id: 'tf_original', size: 5_000_000_000 });
  const tfReplacement = torrentFile({
    id: 'tf_replacement',
    infoHash: INFO_HASH_A, // same infoHash, different file
    size: 5_000_000_001,
  });
  const controlPlane = controlPlaneWith([tfOriginal, tfReplacement]);

  // First publication: original TF.
  const a = materializeVfsEntry(
    cache,
    authoritativeHandoff({ torrentFileId: 'tf_original' }),
    controlPlane,
    () => 1_788_000_000_000,
    { allowLegacy: false },
  );
  assert.equal(a.torrentFileId, 'tf_original');
  assert.equal(a.size, 5_000_000_000);

  // Second publication: a DIFFERENT TF for the same slot -> must fail closed.
  assert.throws(
    () => materializeVfsEntry(
      cache,
      authoritativeHandoff({ torrentFileId: 'tf_replacement' }),
      controlPlane,
      () => 1_788_000_500_000,
      { allowLegacy: false },
    ),
    /conflicts with TorrentFile/,
  );

  // Original row is preserved.
  const persisted = cache.getVfsTvEntry('tt0000099', 1, 1);
  assert.equal(persisted.torrentFileId, 'tf_original');
  assert.equal(persisted.size, 5_000_000_000);

  // And no duplicate was created.
  const all = cache.listVfsTvEntries().filter((e) =>
    e.mediaId === 'tt0000099' && e.season === 1 && e.episode === 1);
  assert.equal(all.length, 1);
});

test('concurrent identical first-publication race -> exactly one logical row (race recovery)', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  const tf = torrentFile({ id: 'tf_race' });
  const controlPlane = controlPlaneWith([tf]);
  const handoff = authoritativeHandoff({ torrentFileId: 'tf_race' });

  // Simulate the race: pre-seed a winner's row, then issue an authoritative
  // materialize that hits the same PRIMARY KEY. The materialize path's
  // isUniqueConstraintError branch must reconcile against the winner.
  cache.createVfsTvEntry({
    mediaId: 'tt0000099',
    season: 1,
    episode: 1,
    releaseKey: `${INFO_HASH_A}:torrent`,
    infoHash: INFO_HASH_A,
    fileIndex: null,
    canonicalPath: 'TV/Show/Season 01/tt0000099 - S01E01.mkv',
    torrentFileId: 'tf_race',
    size: 5_000_000_000,
    createdAt: 1_788_000_000_000,
    updatedAt: 1_788_000_000_000,
  });

  // The new authoritative materialize must observe the existing identical
  // row and return it (idempotent) without throwing.
  const entry = materializeVfsEntry(
    cache, handoff, controlPlane, () => 1_788_000_500_000, { allowLegacy: false },
  );
  assert.equal(entry.torrentFileId, 'tf_race');
  assert.equal(entry.size, 5_000_000_000);

  // And no duplicate.
  const all = cache.listVfsTvEntries().filter((e) =>
    e.mediaId === 'tt0000099' && e.season === 1 && e.episode === 1);
  assert.equal(all.length, 1);
});

test('missing episode -> insert only, no supersede, no duplicate', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  const tf = torrentFile({ id: 'tf_fresh' });
  const controlPlane = controlPlaneWith([tf]);

  // Pre-condition: no VFS row for this slot.
  assert.equal(cache.getVfsTvEntry('tt0000099', 1, 7), null);

  const entry = materializeVfsEntry(
    cache,
    authoritativeHandoff({ torrentFileId: 'tf_fresh', season: 1, episode: 7 }),
    controlPlane,
    () => 1_788_000_000_000,
    { allowLegacy: false },
  );

  // Insert succeeded.
  assert.equal(entry.torrentFileId, 'tf_fresh');
  assert.equal(entry.size, 5_000_000_000);
  assert.match(entry.canonicalPath, /S01E07\.mkv$/);

  // Single row for the slot.
  const all = cache.listVfsTvEntries().filter((e) =>
    e.mediaId === 'tt0000099' && e.season === 1 && e.episode === 7);
  assert.equal(all.length, 1);

  // And a second missing-episode slot is unaffected.
  assert.equal(cache.getVfsTvEntry('tt0000099', 1, 8), null);
});

test('vfs_tv_entries / vfs_movie_entries schema enforces single-row-per-slot', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // vfs_tv_entries: PRIMARY KEY (media_id, season, episode) AND UNIQUE
  // canonical_path both contribute to the single-row-per-slot invariant.
  const tvIndex = cache.db.prepare('PRAGMA index_list(vfs_tv_entries)').all();
  const tvIndexNames = new Set(tvIndex.map((i) => i.name));
  // Indexes that cover the slot PK or the canonical path may be unnamed in
  // some SQLite versions; we instead assert the column-level invariants
  // directly via the table_info / unique constraints.
  const tvSql = cache.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='vfs_tv_entries'",
  ).get().sql;
  assert.match(tvSql, /PRIMARY KEY \(media_id, season, episode\)/);
  assert.match(tvSql, /canonical_path TEXT NOT NULL UNIQUE/);

  // vfs_movie_entries: PRIMARY KEY media_id, UNIQUE canonical_path.
  const movieSql = cache.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='vfs_movie_entries'",
  ).get().sql;
  assert.match(movieSql, /media_id TEXT PRIMARY KEY/);
  assert.match(movieSql, /canonical_path TEXT NOT NULL UNIQUE/);
});
