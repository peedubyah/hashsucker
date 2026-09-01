/**
 * Idempotency tests for slice 2.6.
 *
 * Pins the contract that a duplicate / replayed / concurrent media request
 * for the same logical media identity (movie or TV episode) converges to a
 * single durable handoff row and a single VFS row, without losing the
 * authoritative TorrentFile identity.
 *
 * Surfaces:
 *   - B3: persistPlaybackHandoff upserts on (media_type, media_id, season, episode).
 *   - B4: materializeVfsEntry recovers from a UNIQUE race on first publication.
 *   - B5: 4 concurrent identical requests converge via DB uniqueness.
 *
 * Mirrors the slice 2.6 production-style invariant: the application must
 * never silently accumulate duplicate durable state for the same media.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const FLEABAG_INFO_HASH = '58058402e64145790c43bc368b2b8e6c1dae48d5';
const FLEABAG_TORRENT_FILE_ID = 'tf_fleabag-s01e03-slice26';
const FLEABAG_INTERNAL_PATH = 'Fleabag.S01.WEB-DL.2160p/Fleabag.S01E03.WEB-DL.2160p.mkv';
const FLEABAG_SIZE = 2933186072;
const FLEABAG_MEDIA_ID = 'tt5687612';

const TED_INFO_HASH = '18f1fa740652ff438b261080073ba4b8171e9428';
const TED_TORRENT_FILE_ID = 'tf_ted-s01e02-slice26';
const TED_INTERNAL_PATH = 'Ted.Lasso.S01.WEB-DL.2160p/Ted.Lasso.S01E02.WEB-DL.2160p.mkv';
const TED_SIZE = 5_691_921_896;
const TED_MEDIA_ID = 'tt10986410';

function controlPlaneStoreMock(torrentFiles) {
  const map = new Map(torrentFiles.map((tf) => [tf.id, tf]));
  return {
    getTorrentFile(id) {
      return map.get(id) || null;
    },
  };
}

function fleabagE03Handoff({ requestId, torrentFileId = FLEABAG_TORRENT_FILE_ID } = {}) {
  return {
    requestId,
    mediaId: FLEABAG_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 3,
    releaseKey: `${FLEABAG_INFO_HASH}:torrent`,
    infoHash: FLEABAG_INFO_HASH,
    fileIndex: null,
    filename: 'Fleabag.S01E03.WEB-DL.2160p.mkv',
    canonicalTitle: 'Fleabag',
    torrentFileId,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'slice-2-6',
    selectedAt: 1_788_270_000_000,
  };
}

function tedE02Handoff({ requestId, torrentFileId = TED_TORRENT_FILE_ID } = {}) {
  return {
    requestId,
    mediaId: TED_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 2,
    releaseKey: `${TED_INFO_HASH}:torrent`,
    infoHash: TED_INFO_HASH,
    fileIndex: null,
    filename: 'Ted.Lasso.S01E02.WEB-DL.2160p.mkv',
    canonicalTitle: 'Ted Lasso',
    torrentFileId,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'slice-2-6',
    selectedAt: 1_788_270_000_000,
  };
}

function legacyFleabagHandoff({ requestId, infoHash, fileIndex }) {
  return {
    requestId,
    mediaId: FLEABAG_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 3,
    releaseKey: `${infoHash}:${fileIndex}`,
    infoHash,
    fileIndex,
    filename: 'Fleabag.S01E03.WEB-DL.mkv',
    canonicalTitle: 'Fleabag',
    torrentFileId: null,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'legacy',
    selectedAt: 1_787_000_000_000,
  };
}

function makeTmpDbPath(testName) {
  const safe = String(testName || 'idempotency')
    .replace(/[^a-z0-9-]+/gi, '-')
    .slice(0, 80);
  return path.join(os.tmpdir(), `idempotency-${safe}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

// ---------------------------------------------------------------------------
// B3 — Playback handoff idempotency
// ---------------------------------------------------------------------------

test('B3: persistPlaybackHandoff upserts on the (media_type, media_id, season, episode) slot', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const requestId = cache.persistMediaRequest({
    mediaId: FLEABAG_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 3,
    source: 'test',
  }, []);

  // First insert: no prior row, returns the new id with status='inserted'.
  const first = cache.upsertPlaybackHandoff(fleabagE03Handoff({ requestId }));
  assert.equal(first.status, 'inserted');
  assert.ok(Number.isInteger(first.id));

  // Replay: same handoff. ON CONFLICT re-applies the upsert; the existing
  // row wins and we return its id with status='noop' (no extra row).
  const second = cache.upsertPlaybackHandoff(fleabagE03Handoff({ requestId }));
  assert.equal(second.id, first.id, 'idempotent replay returns the same row id');
  assert.equal(second.status, 'noop');

  const allForEpisode = cache.db.prepare(
    "SELECT id FROM playback_handoffs WHERE media_id = ? AND media_type = 'tv' AND season = 1 AND episode = 3"
  ).all(FLEABAG_MEDIA_ID);
  assert.equal(allForEpisode.length, 1, 'duplicate insert must not create a second row');
});

test('B3: a legacy handoff is upgraded in place when an authoritative handoff arrives for the same slot', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Seed a legacy (no torrent_file_id) handoff for a different infoHash —
  // mimics a pre-Slice-1.75 production row.
  const legacyRequestId = cache.persistMediaRequest({
    mediaId: FLEABAG_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 3,
    source: 'test',
  }, []);
  const legacyHandoff = legacyFleabagHandoff({
    requestId: legacyRequestId,
    infoHash: '001c678c8c599d1daf132ee8659ff900cb1459fb',
    fileIndex: 0,
  });
  const legacyId = cache.persistPlaybackHandoff(legacyHandoff);
  assert.equal(legacyId, cache.upsertPlaybackHandoff(legacyHandoff).id);

  // New authoritative handoff for the same slot with a different release.
  const newRequestId = cache.persistMediaRequest({
    mediaId: FLEABAG_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 3,
    source: 'test',
  }, []);
  const result = cache.upsertPlaybackHandoff(fleabagE03Handoff({ requestId: newRequestId }));

  assert.equal(result.id, legacyId, 'upgrade replaces the existing row in place, preserving id');
  assert.equal(result.status, 'upgraded');

  const after = cache.getPlaybackHandoffById(legacyId);
  assert.equal(after.torrent_file_id, FLEABAG_TORRENT_FILE_ID, 'torrent_file_id now authoritative');
  assert.equal(after.info_hash, FLEABAG_INFO_HASH, 'info_hash now matches the new release');

  const count = cache.db.prepare(
    "SELECT COUNT(*) AS c FROM playback_handoffs WHERE media_id = ? AND media_type = 'tv' AND season = 1 AND episode = 3"
  ).get(FLEABAG_MEDIA_ID).c;
  assert.equal(count, 1, 'upgrade must not create a second row');
});

test('B3: an authoritative handoff is kept when a legacy handoff arrives for the same slot', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Seed the authoritative handoff first.
  const newRequestId = cache.persistMediaRequest({
    mediaId: FLEABAG_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 3,
    source: 'test',
  }, []);
  const authId = cache.persistPlaybackHandoff(fleabagE03Handoff({ requestId: newRequestId }));

  // Legacy attempt: should NOT clobber the authoritative row.
  const legacyRequestId = cache.persistMediaRequest({
    mediaId: FLEABAG_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 3,
    source: 'test',
  }, []);
  const result = cache.upsertPlaybackHandoff(legacyFleabagHandoff({
    requestId: legacyRequestId,
    infoHash: '001c678c8c599d1daf132ee8659ff900cb1459fb',
    fileIndex: 0,
  }));

  assert.equal(result.id, authId, 'authoritative row preserved');
  assert.equal(result.status, 'kept-authoritative');

  const after = cache.getPlaybackHandoffById(authId);
  assert.equal(after.torrent_file_id, FLEABAG_TORRENT_FILE_ID, 'authoritative identity intact');
  assert.equal(after.info_hash, FLEABAG_INFO_HASH);
});

test('B3: the migration installs a unique identity index and the upsert dedupes by id', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Seed three legacy rows for the same slot plus one authoritative
  // arrival. The unique index keeps the slot to a single row.
  for (let i = 0; i < 3; i += 1) {
    const requestId = cache.persistMediaRequest({
      mediaId: FLEABAG_MEDIA_ID,
      mediaType: 'tv',
      season: 1,
      episode: 3,
      source: 'test',
    }, []);
    cache.persistPlaybackHandoff(legacyFleabagHandoff({
      requestId,
      infoHash: `000000000000000000000000000000000000000${i}`,
      fileIndex: i,
    }));
  }
  const authRequest = cache.persistMediaRequest({
    mediaId: FLEABAG_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 3,
    source: 'test',
  }, []);
  const authId = cache.persistPlaybackHandoff(fleabagE03Handoff({ requestId: authRequest }));

  // Verify the unique index exists.
  const indexInfo = cache.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_playback_handoffs_identity'"
  ).get();
  assert.ok(indexInfo, 'unique identity index is installed');
  assert.match(indexInfo.sql, /UNIQUE/i, 'identity index is UNIQUE');
  assert.match(indexInfo.sql, /IFNULL\(season/i, 'identity index coerces NULL season/episode');

  // A fresh duplicate insert must NOT clobber the authoritative row.
  // The upsert path keeps the existing authoritative row and returns
  // status='kept-authoritative' (the legacy payload is dropped).
  const result = cache.upsertPlaybackHandoff(legacyFleabagHandoff({
    requestId: authRequest,
    infoHash: 'ffffffffffffffffffffffffffffffffffffffff',
    fileIndex: 99,
  }));
  assert.equal(result.id, authId, 'authoritative row id is preserved');
  assert.equal(result.status, 'kept-authoritative');

  // Existing authoritative row is still the durable identity.
  const after = cache.getPlaybackHandoffById(authId);
  assert.equal(after.torrent_file_id, FLEABAG_TORRENT_FILE_ID);

  const count = cache.db.prepare(
    "SELECT COUNT(*) AS c FROM playback_handoffs WHERE media_id = ? AND media_type = 'tv' AND season = 1 AND episode = 3"
  ).get(FLEABAG_MEDIA_ID).c;
  assert.equal(count, 1, 'unique index keeps a single row per media slot');
});

// ---------------------------------------------------------------------------
// B5 — Concurrent identical requests converge
// ---------------------------------------------------------------------------

test('B5: 4 concurrent identical persists converge to a single handoff row', async (t) => {
  // Open 4 separate cache instances sharing the same on-disk DB so each
  // write goes through an independent connection (mirrors the production
  // multi-request fanout from Seerr).
  const tmpPath = makeTmpDbPath(t.name);
  // Seed the shared DB with one media_request so the playback_handoff
  // FK is satisfied across all 4 concurrent writers.
  const seed = createDiscoveryCache({ dbPath: tmpPath });
  const requestId = seed.persistMediaRequest({
    mediaId: FLEABAG_MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: 3,
    source: 'test',
  }, []);
  seed.close();

  const caches = [];
  for (let i = 0; i < 4; i += 1) {
    caches.push(createDiscoveryCache({ dbPath: tmpPath }));
  }
  t.after(() => {
    for (const c of caches) c.close();
    try { fs.rmSync(tmpPath); } catch { /* ignore */ }
  });

  const handoff = fleabagE03Handoff({ requestId });

  const results = await Promise.all(caches.map((c) => Promise.resolve().then(() => c.upsertPlaybackHandoff(handoff))));
  const ids = new Set(results.map((r) => r.id));
  assert.equal(ids.size, 1, 'all 4 concurrent persists converge to the same handoff id');

  // Read back through a fresh cache to confirm the durable state.
  const verify = createDiscoveryCache({ dbPath: tmpPath });
  t.after(() => verify.close());
  const count = verify.db.prepare(
    "SELECT COUNT(*) AS c FROM playback_handoffs WHERE media_id = ? AND media_type = 'tv' AND season = 1 AND episode = 3"
  ).get(FLEABAG_MEDIA_ID).c;
  assert.equal(count, 1, 'only one durable handoff row survives concurrent writes');
});

// ---------------------------------------------------------------------------
// B4 — VFS idempotency under UNIQUE race
// ---------------------------------------------------------------------------

test('B4: materializeVfsEntry converges on a single row across 4 concurrent first publications', async (t) => {
  // Open 4 caches on a shared DB; each runs materializeVfsEntry for the
  // same (media_id, season, episode) on a freshly-empty slot. The
  // PRIMARY KEY (media_id, season, episode) rejects all but the first
  // write; the race-recovery branch reconciles the others.
  const tmpPath = makeTmpDbPath(t.name);
  const seed = createDiscoveryCache({ dbPath: tmpPath });
  seed.close();
  const caches = [];
  for (let i = 0; i < 4; i += 1) {
    caches.push(createDiscoveryCache({ dbPath: tmpPath }));
  }
  t.after(() => {
    for (const c of caches) c.close();
    try { fs.rmSync(tmpPath); } catch { /* ignore */ }
  });

  const controlPlane = controlPlaneStoreMock([{
    id: TED_TORRENT_FILE_ID,
    infoHash: TED_INFO_HASH,
    internalPath: TED_INTERNAL_PATH,
    size: TED_SIZE,
  }]);
  const handoff = tedE02Handoff({ requestId: 1 });
  const entries = await Promise.all(caches.map((c) => Promise.resolve().then(() => materializeVfsEntry(
    c,
    handoff,
    controlPlane,
    () => 1_788_270_000_000,
    { allowLegacy: false },
  ))));

  // All 4 returned the same canonical row, with the same id and path.
  const ids = new Set(entries.map((e) => e.mediaId + ':' + e.season + ':' + e.episode + ':' + e.canonicalPath));
  assert.equal(ids.size, 1, 'all 4 calls return a single canonical VFS row');
  for (const e of entries) {
    assert.equal(e.torrentFileId, TED_TORRENT_FILE_ID);
    assert.equal(e.size, TED_SIZE);
  }

  const verify = createDiscoveryCache({ dbPath: tmpPath });
  t.after(() => verify.close());
  const count = verify.db.prepare(
    'SELECT COUNT(*) AS c FROM vfs_tv_entries WHERE media_id = ? AND season = 1 AND episode = 2'
  ).get(TED_MEDIA_ID).c;
  assert.equal(count, 1, 'only one durable VFS row survives concurrent writes');
});

test('B4: materializeVfsEntry serial duplicate insert is a no-op (already idempotent)', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const controlPlane = controlPlaneStoreMock([{
    id: TED_TORRENT_FILE_ID,
    infoHash: TED_INFO_HASH,
    internalPath: TED_INTERNAL_PATH,
    size: TED_SIZE,
  }]);
  const handoff = tedE02Handoff({ requestId: 1 });

  const first = materializeVfsEntry(cache, handoff, controlPlane, () => 1_788_270_000_000, { allowLegacy: false });
  const second = materializeVfsEntry(cache, handoff, controlPlane, () => 1_788_270_500_000, { allowLegacy: false });

  assert.equal(second.canonicalPath, first.canonicalPath);
  assert.equal(second.torrentFileId, first.torrentFileId);
  assert.equal(second.size, first.size);
  assert.equal(second.createdAt, first.createdAt, 'createdAt preserved on idempotent replay');

  const all = cache.listVfsTvEntries().filter((e) =>
    e.mediaId === TED_MEDIA_ID && e.season === 1 && e.episode === 2,
  );
  assert.equal(all.length, 1, 'replay does not create a second VFS row');
});
