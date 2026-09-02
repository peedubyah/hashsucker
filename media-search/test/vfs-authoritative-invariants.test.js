/**
 * VFS authoritative write invariants (Slice 2.9 / A2).
 *
 * Proves that the modern VFS write path — `materializeVfsEntry` called with
 * `allowLegacy: false` — refuses to write a VFS row when the new
 * authoritative handoff lacks a non-null `torrentFileId`, refuses when the
 * referenced TorrentFile does not exist in the control plane, refuses when
 * the TorrentFile's size is not a positive safe integer, and refuses when
 * the TorrentFile's infoHash disagrees with the handoff's infoHash.
 *
 * Also proves that the modern write path produces a row whose durable
 * identity (torrent_file_id, infoHash, size, canonical_path) all come from
 * the TorrentFile — not from releaseKey, fileIndex, provider filename, or
 * providerResourceId. These columns are not part of the VFS write contract
 * on the modern path; releaseKey is stored verbatim from the handoff only
 * because the handoff's own releaseKey is derived as `${infoHash}:torrent`
 * when fileIndex is null (and it equals the TorrentFile's infoHash, not
 * some other weak metadata).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const PARENT_INFO_HASH = '18f1fa740652ff438b261080073ba4b8171e9428';

function controlPlaneWith(torrentFiles) {
  const map = new Map(torrentFiles.map((tf) => [tf.id, tf]));
  return {
    getTorrentFile(id) {
      return map.get(id) || null;
    },
  };
}

function authoritativeHandoff(overrides = {}) {
  return {
    mediaId: 'tt10986410',
    mediaType: 'tv',
    season: 1,
    episode: 2,
    releaseKey: `${PARENT_INFO_HASH}:torrent`,
    infoHash: PARENT_INFO_HASH,
    fileIndex: null,
    filename: 'Ted Lasso.S01E02.WEB-DL.2160p.mkv',
    canonicalTitle: 'Ted Lasso',
    torrentFileId: 'tf_authoritative-1',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_788_270_000_000,
    ...overrides,
  };
}

function authoritativeTorrentFile(overrides = {}) {
  return {
    id: 'tf_authoritative-1',
    infoHash: PARENT_INFO_HASH,
    internalPath: 'Ted Lasso.S01.WEB-DL.2160p/Ted Lasso.S01E02.WEB-DL.2160p.mkv',
    size: 5_691_921_896,
    createdAt: 1_788_270_000_000,
    ...overrides,
  };
}

test('materializeVfsEntry refuses to write when handoff has no torrentFileId (allowLegacy=false)', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  const controlPlane = controlPlaneWith([authoritativeTorrentFile()]);

  // handoff.torrentFileId missing -> fail closed
  assert.throws(
    () => materializeVfsEntry(
      cache,
      authoritativeHandoff({ torrentFileId: null }),
      controlPlane,
      () => 1_788_270_000_000,
      { allowLegacy: false },
    ),
    /TorrentFile identity is required/,
  );

  // No VFS row must have been written.
  assert.equal(cache.getVfsTvEntry('tt10986410', 1, 2), null);
});

test('materializeVfsEntry refuses when the referenced TorrentFile does not exist', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  // Empty control plane: no TorrentFile at all.
  const controlPlane = controlPlaneWith([]);

  assert.throws(
    () => materializeVfsEntry(
      cache,
      authoritativeHandoff(),
      controlPlane,
      () => 1_788_270_000_000,
      { allowLegacy: false },
    ),
    /TorrentFile tf_authoritative-1 does not exist/,
  );
  assert.equal(cache.getVfsTvEntry('tt10986410', 1, 2), null);
});

test('materializeVfsEntry refuses when TorrentFile size is not a positive safe integer', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const cases = [
    { label: 'zero', tf: authoritativeTorrentFile({ size: 0 }) },
    { label: 'negative', tf: authoritativeTorrentFile({ size: -1 }) },
    { label: 'non-integer', tf: authoritativeTorrentFile({ size: 3.5 }) },
    { label: 'not-a-number', tf: authoritativeTorrentFile({ size: NaN }) },
  ];
  for (const { tf } of cases) {
    const controlPlane = controlPlaneWith([tf]);
    assert.throws(
      () => materializeVfsEntry(
        cache,
        authoritativeHandoff(),
        controlPlane,
        () => 1_788_270_000_000,
        { allowLegacy: false },
      ),
      /invalid physical size/,
      `case ${tf.size}`,
    );
  }
  assert.equal(cache.getVfsTvEntry('tt10986410', 1, 2), null);
});

test('materializeVfsEntry refuses when TorrentFile infoHash disagrees with the handoff', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  const tf = authoritativeTorrentFile({ infoHash: 'ffffffffffffffffffffffffffffffffffff' });
  const controlPlane = controlPlaneWith([tf]);

  assert.throws(
    () => materializeVfsEntry(
      cache,
      authoritativeHandoff(),
      controlPlane,
      () => 1_788_270_000_000,
      { allowLegacy: false },
    ),
    /infoHash does not match handoff/,
  );
  assert.equal(cache.getVfsTvEntry('tt10986410', 1, 2), null);
});

test('modern VFS write contract: torrent_file_id, infoHash, size, canonical_path come from TorrentFile', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  const tf = authoritativeTorrentFile();
  const controlPlane = controlPlaneWith([tf]);

  const entry = materializeVfsEntry(
    cache,
    authoritativeHandoff(),
    controlPlane,
    () => 1_788_270_000_000,
    { allowLegacy: false },
  );

  // Authoritative identity comes from the TorrentFile.
  assert.equal(entry.torrentFileId, tf.id);
  assert.equal(entry.infoHash, tf.infoHash);
  assert.equal(entry.size, tf.size);
  assert.equal(entry.fileIndex, null, 'file_index is not part of the modern write contract');

  // canonical_path is built from the media identity, not from the provider
  // filename or releaseKey. The extension is taken from the TF internalPath.
  assert.equal(
    entry.canonicalPath,
    'TV/Ted Lasso/Season 01/Ted Lasso - S01E02.mkv',
  );

  // The durable VFS row must not store any provider URL / capability URL /
  // requestdl URL / magnet URI / torrent URL — those are ephemeral.
  // We assert this by inspecting the table schema: no such columns exist
  // for authoritative rows. The literal columns present are
  // (media_id, season, episode, release_key, info_hash, file_index,
  // canonical_path, torrent_file_id, size, created_at, updated_at).
  const columns = new Set(cache.db.prepare('PRAGMA table_info(vfs_tv_entries)').all().map((c) => c.name));
  for (const forbidden of ['requestdl', 'download_url', 'magnet_uri', 'torrent_url', 'capability_url']) {
    assert.equal(columns.has(forbidden), false,
      `vfs_tv_entries must not persist ${forbidden} as durable physical identity`);
  }
});

test('modern write path does not require a non-null controlPlaneStore only when allowLegacy=true', (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  // Without a control plane, allowLegacy=false must throw before any row is written.
  assert.throws(
    () => materializeVfsEntry(
      cache,
      authoritativeHandoff(),
      null,
      () => 1_788_270_000_000,
      { allowLegacy: false },
    ),
    /TorrentFile validation is unavailable/,
  );
});
