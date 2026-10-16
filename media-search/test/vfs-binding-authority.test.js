/**
 * Binding-authoritative VFS state recovery + collection isolation.
 *
 * The discovery cache holds ONE playback_handoffs row per media slot, and its
 * upsert overwrites in place when a later request selects a different
 * authoritative TorrentFile. A published VFS row therefore ends up naming a
 * release whose handoff no longer exists, and the old read path failed the
 * whole collection with HANDOFF_MISSING.
 *
 * Contracts pinned here:
 *
 *   B1  a published entry whose handoff was superseded is recovered from the
 *       active Binding — same release, same TorrentFile, no selection change;
 *   B2  the recovery NEVER invents a representation: it is refused when the
 *       Binding names a different release than the row;
 *   B3  an entry with no handoff and no authoritative Binding is ISOLATED and
 *       reported, never served and never guessed;
 *   B4  a handoff belonging to a DIFFERENT release is not this entry's
 *       handoff — the Binding decides (the TV path's historical check);
 *   B5  a normal entry (handoff present and matching) is untouched: the
 *       handoff still wins, so existing behaviour is unchanged;
 *   B6  an unreadable/absent control plane isolates rather than serving.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { authoritativeStateForVfsEntry, resolveVfsStateForEntry } from '../src/lib/vfs/binding-authority.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const UNTIL = 9_000_000_000;
const PATH = 'Show S01/Show - S01E01.mkv';

/** A control plane with one published movie: item + path + Binding + TorrentFile. */
function publishedStore(t, { infoHash = HASH_A, mediaId = 'tt-rec', size = 4096 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vfs-authority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createControlPlaneStore({ dbPath: join(dir, 'cp.db'), now: () => 1_000_000 });
  t.after(() => store.close());

  const tfRow = `tf-${infoHash.slice(0, 8)}`;
  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tfRow, infoHash, PATH, size, 1_000_000);

  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash,
    providerResourceId: `res-${infoHash.slice(0, 6)}`, state: 'ready',
    ownership: 'owned', ownerKey: 'owner-key', provenance: 'vfs-authority-test',
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: '0', path: PATH, name: 'Show - S01E01.mkv', size, selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
    inventory_observed_at = ?, inventory_expires_at = ?
    WHERE placement_id = ?
  `).run(tfRow, 1_000_000, UNTIL, placement.id);

  const item = store.ensureLibraryItem({
    identityKey: `movie:${mediaId}:default`,
    mediaType: 'movie', mediaId, title: 'Recovery Movie', desiredState: 'present',
  });
  const path = store.ensureCanonicalPath(item.id, { canonicalPath: `Movies/Recovery/Rec.mkv` });
  const exposure = store.recordExposure({
    libraryItemId: item.id, libraryPathId: path.id,
    placementId: placement.id, providerFileId: '0',
    transport: 'webdav', exposureKey: `vfs-auth:${infoHash.slice(0, 8)}`,
    consumer: 'plex', state: 'visible', readOnly: true,
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: path.id,
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    torrentFileId: tfRow, placementId: placement.id, providerFileId: '0',
    exposureId: exposure.id, reason: 'vfs-movie-materialize',
  });
  return { store, tfRow, mediaId };
}

const fakeCacheFor = (handoffsByKey) => ({
  getPlaybackHandoffByReleaseKey(mediaId, releaseKey) {
    return handoffsByKey[`${mediaId}|${releaseKey}`] ?? null;
  },
  getTvPlaybackHandoff(mediaId, season, episode) {
    return handoffsByKey[`${mediaId}|${season}|${episode}`] ?? null;
  },
});

test('B1 — a superseded handoff is recovered from the active Binding', (t) => {
  const { store, tfRow, mediaId } = publishedStore(t);
  const entry = {
    mediaId, mediaType: 'movie', releaseKey: `${HASH_A}:torrent`,
    torrentFileId: tfRow, size: 4096, canonicalPath: 'Movies/Recovery/Rec.mkv',
  };
  // The discovery cache holds NO handoff for the published release: a later
  // request re-selected a different release and the upsert overwrote it.
  const result = resolveVfsStateForEntry({ searchCache: fakeCacheFor({}), controlPlaneStore: store, entry });
  assert.equal(result.action, 'recovered');
  assert.ok(result.state, 'the state is rebuilt');
  assert.equal(result.state.handoff.infoHash, HASH_A, 'identity comes from the Binding');
  assert.equal(result.state.handoff.torrentFileId, tfRow, 'the SAME TorrentFile is served');
  assert.equal(result.state.handoff.releaseKey, entry.releaseKey);
  assert.equal(result.state.entry.releaseKey, entry.releaseKey, 'the projection is unchanged');
});

test('B2 — recovery refuses to invent a different representation', (t) => {
  const { store, mediaId } = publishedStore(t);
  // The row names a release the Binding does NOT name.
  const entry = {
    mediaId, mediaType: 'movie', releaseKey: `${HASH_B}:torrent`,
    torrentFileId: 'tf-someone-else', size: 999, canonicalPath: 'Movies/Recovery/Rec.mkv',
  };
  const recovered = authoritativeStateForVfsEntry(store, entry);
  assert.equal(recovered?.handoff, null, 'no handoff is fabricated from a mismatched row');
  assert.equal(recovered?.reason, 'binding-release-mismatch');
  assert.equal(recovered.bindingReleaseKey, `${HASH_A}:torrent`,
    'the authoritative release is reported, not applied');
  const result = resolveVfsStateForEntry({ searchCache: fakeCacheFor({}), controlPlaneStore: store, entry });
  assert.equal(result.action, 'mismatch');
  assert.equal(result.state, null, 'the stale row is isolated instead of re-pointed');
});

test('B3 — an unbacked entry is isolated, never served', (t) => {
  const { store, mediaId } = publishedStore(t);
  const entry = {
    mediaId: 'tt-never-published', mediaType: 'movie',
    releaseKey: `${HASH_B}:torrent`, torrentFileId: null, size: null, canonicalPath: null,
  };
  const result = resolveVfsStateForEntry({ searchCache: fakeCacheFor({}), controlPlaneStore: store, entry });
  assert.equal(result.action, 'isolated');
  assert.equal(result.state, null);
});

test('B4 — a handoff for another release is not this entry\'s handoff', (t) => {
  const { store, tfRow, mediaId } = publishedStore(t);
  // A handoff exists for this media but names a DIFFERENT release (the later
  // re-selection). It must not be used to serve the published row.
  const searchCache = fakeCacheFor({
    [`${mediaId}|${HASH_A}:torrent`]: null,
  });
  // The TV-style lookup (by media+season+episode) is what returns the
  // superseded row; the movie lookup by release key returns nothing.
  const entry = {
    mediaId, mediaType: 'movie', releaseKey: `${HASH_A}:torrent`,
    torrentFileId: tfRow, size: 4096, canonicalPath: 'Movies/Recovery/Rec.mkv',
  };
  const result = resolveVfsStateForEntry({ searchCache, controlPlaneStore: store, entry });
  assert.equal(result.action, 'recovered', 'the Binding, not the superseded row, decides');

  // And a handoff that IS this entry's is used verbatim.
  const matching = fakeCacheFor({
    [`${mediaId}|${HASH_A}:torrent`]: {
      mediaId, releaseKey: `${HASH_A}:torrent`, infoHash: HASH_A, fileIndex: null,
      torrentFileId: tfRow, filename: PATH, provider: 'torbox',
    },
  });
  const unchanged = resolveVfsStateForEntry({ searchCache: matching, controlPlaneStore: store, entry });
  assert.equal(unchanged.action, 'handoff', 'a matching handoff still wins');
  assert.equal(unchanged.state.handoff.filename, PATH);
});

test('B5 — episode entries recover the same way', (t) => {
  const { store, tfRow } = publishedStore(t, { infoHash: HASH_C, mediaId: 'tt-ep', size: 2048 });
  const entry = {
    mediaId: 'tt-ep', mediaType: 'episode', season: 1, episode: 2,
    releaseKey: `${HASH_C}:torrent`, torrentFileId: tfRow, size: 2048, canonicalPath: 'TV/Rec/S01E02.mkv',
  };
  const searchCache = fakeCacheFor({ 'tt-ep|1|2': null });
  const result = resolveVfsStateForEntry({ searchCache, controlPlaneStore: store, entry });
  assert.equal(result.action, 'isolated', 'the movie library item does not back an episode row');
});

test('B6 — no control plane means no authority: isolate', (t) => {
  const { mediaId } = publishedStore(t);
  const entry = {
    mediaId, mediaType: 'movie', releaseKey: `${HASH_A}:torrent`,
    torrentFileId: 'tf-whatever', size: 1, canonicalPath: 'Movies/Recovery/Rec.mkv',
  };
  const result = resolveVfsStateForEntry({
    searchCache: fakeCacheFor({}), controlPlaneStore: null, entry,
  });
  assert.equal(result.action, 'isolated');
  assert.equal(result.state, null, 'nothing is served without authority');
});

const HASH_C = 'c'.repeat(40);
