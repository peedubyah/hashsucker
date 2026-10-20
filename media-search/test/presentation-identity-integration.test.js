/**
 * The presentation identity, end to end.
 *
 * One media intent has one durable presentation identity. These tests
 * drive the real materializer and the real publisher and pin the
 * properties the identity exists for:
 *
 *   - the `.strm` path and the VFS path are the same name;
 *   - a replay, a restart, a metadata answer that arrives late, a route
 *     repair and a representation reselection all leave the path alone;
 *   - a duplicate request converges on one identity and one artifact;
 *   - a different media intent never reuses another one's identity.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';
import { publishSelectedHandoff } from '../src/lib/requests/publication.js';
import { vfsPartFile, isAuthoritativePartFile } from '../src/lib/plex/vfs-path.js';

const INFO_HASH = 'f'.repeat(40);
const OTHER_HASH = 'e'.repeat(40);

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function torrentFile({ id = 'tf-1', infoHash = INFO_HASH, internalPath = 'Oppenheimer.2023.mkv', size = 1000 } = {}) {
  return { id, infoHash, internalPath, size };
}

function handoff(overrides = {}) {
  return {
    mediaId: 'tt15398776',
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: `${INFO_HASH}:torrent`,
    infoHash: INFO_HASH,
    fileIndex: null,
    filename: 'Oppenheimer.2023.1080p.BluRay.x264-GRP.mkv',
    canonicalTitle: 'Oppenheimer',
    canonicalYear: 2023,
    torrentFileId: 'tf-1',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function controlPlaneWith(torrentFiles, store) {
  const map = new Map(torrentFiles.map((tf) => [tf.id, tf]));
  return {
    ...store,
    getTorrentFile(id) {
      return map.get(id) || store.getTorrentFile?.(id) || null;
    },
  };
}

async function publish({ t, cache, store, controlPlane, handoff: hd }) {
  // The durable handoff does NOT carry the canonical title (it is not a
  // persisted column), so the publication is driven with the in-memory
  // handoff — the request's explicit name — while the cache keeps the
  // durable row.
  const durable = cache.upsertPlaybackHandoff(hd);
  const result = await publishSelectedHandoff({
    cache,
    controlPlaneStore: controlPlane,
    handoff: { ...hd, id: durable.id },
    selection: null,
    mediaId: hd.mediaId,
    mediaType: hd.mediaType,
    season: hd.season,
    episode: hd.episode,
    isEpisode: hd.mediaType !== 'movie',
    hydrateVfs: null,
  });
  return result;
}

test('the VFS path and the `.strm` path are the same identity', async (t) => {
  const dir = tempDir(t, 'hs-pres-');
  const strmRoot = path.join(dir, 'strm');
  fs.mkdirSync(strmRoot, { recursive: true });
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = strmRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const cache = createDiscoveryCache();
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  t.after(() => { cache.close(); store.close(); });
  const controlPlane = controlPlaneWith([torrentFile()], store);

  const { vfsEntry, strmPath } = await publish({ t, cache, store, controlPlane, handoff: handoff() });

  const vfsName = path.basename(vfsEntry.canonicalPath, path.extname(vfsEntry.canonicalPath));
  const strmName = path.basename(strmPath, '.strm');
  assert.equal(vfsName, strmName, 'the byte path and the consumer path carry the same name');
  assert.equal(vfsName, 'Oppenheimer (2023)');

  const identity = store.listPresentationIdentities({ limit: 10 })[0];
  assert.ok(identity, 'the identity is committed');
  assert.equal(identity.title, 'Oppenheimer');
  assert.equal(identity.year, 2023);
  assert.equal(identity.canonicalPath, vfsEntry.canonicalPath);
  assert.equal(identity.strmPath, path.relative(strmRoot, strmPath));
});

test('a replay and a restart leave the path alone', async (t) => {
  const dir = tempDir(t, 'hs-pres-stable-');
  const strmRoot = path.join(dir, 'strm');
  fs.mkdirSync(strmRoot, { recursive: true });
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = strmRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const cache = createDiscoveryCache();
  const dbPath = path.join(dir, 'cp.db');
  const store = createControlPlaneStore({ dbPath });
  t.after(() => { cache.close(); store.close(); });
  const controlPlane = controlPlaneWith([torrentFile()], store);

  const first = await publish({ t, cache, store, controlPlane, handoff: handoff() });
  const committedPath = first.vfsEntry.canonicalPath;

  // A replay: the same intent, published again.
  const replay = await publish({ t, cache, store, controlPlane, handoff: handoff() });
  assert.equal(replay.vfsEntry.canonicalPath, committedPath, 'the replay kept the path');
  assert.equal(replay.strmPath, first.strmPath, 'the replay kept the artifact');

  // A restart: a fresh store and cache over the same durable truth.
  store.close();
  cache.close();
  const cache2 = createDiscoveryCache();
  const store2 = createControlPlaneStore({ dbPath });
  t.after(() => { cache2.close(); store2.close(); });
  const controlPlane2 = controlPlaneWith([torrentFile()], store2);
  const afterRestart = await publish({ t, cache: cache2, store: store2, controlPlane: controlPlane2, handoff: handoff() });
  assert.equal(afterRestart.vfsEntry.canonicalPath, committedPath, 'the restart kept the path');
  assert.equal(afterRestart.strmPath, first.strmPath, 'the restart kept the artifact');

});

test('late metadata cannot rename a published item', async (t) => {
  const dir = tempDir(t, 'hs-pres-late-');
  const strmRoot = path.join(dir, 'strm');
  fs.mkdirSync(strmRoot, { recursive: true });
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = strmRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const cache = createDiscoveryCache();
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  t.after(() => { cache.close(); store.close(); });
  const controlPlane = controlPlaneWith([torrentFile()], store);

  const first = await publish({ t, cache, store, controlPlane, handoff: handoff() });
  const committedPath = first.vfsEntry.canonicalPath;

  // The catalog now answers something else (a localized title, a corrected
  // year). A republication must not consult it: the identity is committed.
  cache.db.prepare('DELETE FROM vfs_movie_entries').run();
  const later = await publish({
    t, cache, store, controlPlane,
    handoff: handoff({
      canonicalTitle: null,
      canonicalYear: null,
      filename: 'Oppenheimer.2023.1080p.BluRay.x264-OTHERGROUP.mkv',
    }),
  });
  assert.equal(later.vfsEntry.canonicalPath, committedPath,
    'a late metadata answer did not rename the published item');
  assert.equal(later.strmPath, first.strmPath);
});

test('the Plex projection reads the committed path', async (t) => {
  const dir = tempDir(t, 'hs-pres-plex-');
  const strmRoot = path.join(dir, 'strm');
  fs.mkdirSync(strmRoot, { recursive: true });
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = strmRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const cache = createDiscoveryCache();
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  t.after(() => { cache.close(); store.close(); });
  const controlPlane = controlPlaneWith([torrentFile()], store);

  const { vfsEntry } = await publish({ t, cache, store, controlPlane, handoff: handoff() });
  const identity = store.listPresentationIdentities({ limit: 10 })[0];

  // The consumer projection is DERIVED from the committed identity: the
  // Plex part file for this item is the committed canonical path, not a
  // recomputed name.
  const partFile = vfsPartFile(identity.canonicalPath);
  assert.equal(partFile, `/mnt/hashsucker-vfs/${vfsEntry.canonicalPath}`);
  assert.equal(isAuthoritativePartFile(partFile, identity.canonicalPath), true);
});

test('a route repair (the same TorrentFile) leaves the path alone', async (t) => {
  const dir = tempDir(t, 'hs-pres-repair-');
  const strmRoot = path.join(dir, 'strm');
  fs.mkdirSync(strmRoot, { recursive: true });
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = strmRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const cache = createDiscoveryCache();
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  t.after(() => { cache.close(); store.close(); });
  const controlPlane = controlPlaneWith([torrentFile()], store);

  const first = await publish({ t, cache, store, controlPlane, handoff: handoff() });
  // A route repair re-observes the SAME TorrentFile: the identity must be
  // untouched, and the artifact must not be written a second time.
  const repaired = await publish({ t, cache, store, controlPlane, handoff: handoff() });
  assert.equal(repaired.vfsEntry.canonicalPath, first.vfsEntry.canonicalPath);
  assert.equal(repaired.strmPath, first.strmPath);

  const artifacts = [];
  const walk = (dirPath) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) walk(full);
      else artifacts.push(full);
    }
  };
  walk(strmRoot);
  assert.equal(artifacts.length, 1, 'one artifact, not two');
});

test('a different media intent never reuses another one\'s identity', async (t) => {
  const dir = tempDir(t, 'hs-pres-distinct-');
  const strmRoot = path.join(dir, 'strm');
  fs.mkdirSync(strmRoot, { recursive: true });
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = strmRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const cache = createDiscoveryCache();
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  t.after(() => { cache.close(); store.close(); });
  const controlPlane = controlPlaneWith([torrentFile()], store);

  const first = await publish({ t, cache, store, controlPlane, handoff: handoff() });
  // A DIFFERENT media intent (a different release) must get its own
  // identity and its own paths.
  const otherFile = torrentFile({
    id: 'tf-2', infoHash: OTHER_HASH, internalPath: 'Interstellar.2014.mkv', size: 2000,
  });
  const controlPlane2 = controlPlaneWith([torrentFile(), otherFile], store);
  const second = await publish({
    t, cache, store, controlPlane: controlPlane2,
    handoff: handoff({
      mediaId: 'tt0047478',
      canonicalTitle: 'Interstellar',
      canonicalYear: 2014,
      torrentFileId: 'tf-2',
      infoHash: OTHER_HASH,
      releaseKey: `${OTHER_HASH}:torrent`,
    }),
  });

  const identities = store.listPresentationIdentities({ limit: 10 });
  assert.equal(identities.length, 2);
  const titles = identities.map((identity) => identity.title).sort();
  assert.deepEqual(titles, ['Interstellar', 'Oppenheimer']);
  assert.notEqual(second.vfsEntry.canonicalPath, first.vfsEntry.canonicalPath,
    'the other intent did not reuse the first one\'s path');
  assert.equal(second.strmPath.includes('Interstellar'), true);
});

test('duplicate requests converge on one identity and one artifact', async (t) => {
  const dir = tempDir(t, 'hs-pres-dup-');
  const strmRoot = path.join(dir, 'strm');
  fs.mkdirSync(strmRoot, { recursive: true });
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = strmRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const cache = createDiscoveryCache();
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  t.after(() => { cache.close(); store.close(); });
  const controlPlane = controlPlaneWith([torrentFile()], store);

  const results = await Promise.all([
    publish({ t, cache, store, controlPlane, handoff: handoff() }),
    publish({ t, cache, store, controlPlane, handoff: handoff() }),
    publish({ t, cache, store, controlPlane, handoff: handoff() }),
  ]);

  const paths = new Set(results.map((r) => r.vfsEntry.canonicalPath));
  assert.equal(paths.size, 1, 'one path');
  const artifacts = new Set(results.map((r) => r.strmPath));
  assert.equal(artifacts.size, 1, 'one artifact path');

  const identities = store.listPresentationIdentities({ limit: 10 });
  assert.equal(identities.length, 1, 'one identity');

  const files = [];
  const walk = (dirPath) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(strmRoot);
  assert.equal(files.length, 1, 'no duplicate artifact was written');
});

test('the committed path survives a lost VFS row and a different representation', async (t) => {
  const dir = tempDir(t, 'hs-pres-restore-');
  const strmRoot = path.join(dir, 'strm');
  fs.mkdirSync(strmRoot, { recursive: true });
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = strmRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const cache = createDiscoveryCache();
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  t.after(() => { cache.close(); store.close(); });
  const controlPlane = controlPlaneWith([torrentFile()], store);

  const first = await publish({ t, cache, store, controlPlane, handoff: handoff() });
  const committedPath = first.vfsEntry.canonicalPath;

  // The VFS row is lost (an unpublish, an orphan cleanup, a fresh cache),
  // and the media is now represented by a DIFFERENT TorrentFile with a
  // different extension.
  cache.db.prepare('DELETE FROM vfs_movie_entries').run();
  const reselected = torrentFile({
    id: 'tf-2', internalPath: 'Oppenheimer.2023.2160p.mp4', size: 2000,
  });
  const controlPlane2 = controlPlaneWith([reselected], store);

  const restored = await publish({
    t, cache, store, controlPlane: controlPlane2, handoff: handoff({ torrentFileId: 'tf-2' }),
  });
  assert.equal(restored.vfsEntry.canonicalPath, committedPath,
    'the committed identity restored the path the row had lost');
  assert.ok(committedPath.endsWith('.mkv'), 'and kept the extension it was committed with');
});
