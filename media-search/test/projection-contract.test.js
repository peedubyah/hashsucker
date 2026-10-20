/**
 * THE CONSUMER PROJECTION CONTRACT.
 *
 * A consumer library is a projection of HashSucker's durable truth. These
 * tests pin:
 *
 *   - the desired projection is DERIVED (one derivation, from the durable
 *     state alone);
 *   - a missing / stale consumer projection is distinguishable from a
 *     missing media item;
 *   - the repair is bounded: a refresh of the exact directory, no media
 *     reselection, no provider work, no rename, no Binding mutation;
 *   - consumer state is never an identity authority (no consumer title
 *     matching, no consumer-chosen Part, no "null" Part id).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import {
  desiredProjection,
  classifyProjection,
  PROJECTION_STATES,
  desiredPartFile,
  desiredScanPath,
  desiredJellyfinPath,
} from '../src/lib/control-plane/desired-projection.js';
import { desiredProjectionForItem } from '../src/lib/control-plane/projection-audit.js';
import { repairConsumerProjection } from '../src/lib/requests/projection-repair.js';
import { classifyResultingItem } from '../src/lib/requests/plex-ingest.js';

const HASH = 'a'.repeat(40);

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

const ENV = {
  PLEX_MOVIES_SECTION_ID: '2',
  PLEX_MOVIES_ROOT: '/mnt/hashsucker-vfs/Movies',
  PLEX_TV_SECTION_ID: '3',
  PLEX_TV_ROOT: '/mnt/hashsucker-vfs/TV',
  STRM_OUTPUT_PATH: '/strm',
  JELLYFIN_MEDIA_ROOT: '/media',
};

// ── 1. the desired projection is derived from durable truth ────────────────
test('the desired projection is derived from the durable truth alone', () => {
  const desired = desiredProjection({
    item: { mediaId: 'tt1234567', mediaType: 'movie', season: null, episode: null },
    presentation: {
      title: 'Oppenheimer', year: 2023,
      canonicalPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv',
      strmPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).strm',
    },
    vfsEntry: { canonicalPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv', size: 1234 },
    binding: { status: 'active', torrentFile: { id: 'tf-1', infoHash: HASH, size: 1234 } },
    torrentFile: { id: 'tf-1', infoHash: HASH, size: 1234 },
    env: ENV,
  });

  assert.equal(desired.desired.plex.partFile,
    '/mnt/hashsucker-vfs/Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv',
    'the expected Part file is the durable canonical path under the section root');
  assert.equal(desired.desired.plex.partSize, 1234, 'the expected Part size is the exact size');
  assert.equal(desired.desired.plex.scanPath,
    '/mnt/hashsucker-vfs/Movies/Oppenheimer (2023)',
    'the scan path is the exact directory that holds the artifact');
  assert.equal(desired.desired.plex.sectionId, '2');
  assert.equal(desired.desired.plex.providerId, 'tt1234567');
  assert.equal(desired.desired.jellyfin.path, '/media/Movies/Oppenheimer (2023)/Oppenheimer (2023).strm');
  assert.equal(desired.representation.torrentFileId, 'tf-1');
  assert.equal(desired.complete, true);
});

test('the desired projection is incomplete when the durable truth is', () => {
  const desired = desiredProjection({
    item: { mediaId: 'tt1234567', mediaType: 'movie' },
    presentation: { title: 'X', year: null, canonicalPath: 'Movies/X/X.mkv', strmPath: 'Movies/X/X.strm' },
    vfsEntry: { canonicalPath: 'Movies/X/X.mkv', size: null },
    env: ENV,
  });
  assert.equal(desired.complete, false, 'no exact size means the projection cannot be stated');
});

test('the scan path and the Part file are one derivation', () => {
  assert.equal(desiredPartFile('Movies/T/T.mkv', ENV.PLEX_MOVIES_ROOT), '/mnt/hashsucker-vfs/Movies/T/T.mkv');
  assert.equal(desiredScanPath('Movies/T/T.mkv', ENV.PLEX_MOVIES_ROOT), '/mnt/hashsucker-vfs/Movies/T');
  assert.equal(desiredPartFile('TV/S/Season 01/S - S01E01.mkv', ENV.PLEX_TV_ROOT),
    '/mnt/hashsucker-vfs/TV/S/Season 01/S - S01E01.mkv');
  assert.equal(desiredJellyfinPath('Movies/T/T.strm', ENV), '/media/Movies/T/T.strm');
});

// ── 2. the classification distinguishes the projection states ──────────────
test('the projection states are distinguished, and absence is never assumed', () => {
  const desired = desiredProjection({
    item: { mediaId: 'tt1', mediaType: 'movie' },
    presentation: { title: 'X', year: null, canonicalPath: 'Movies/X/X.mkv', strmPath: 'Movies/X/X.strm' },
    vfsEntry: { canonicalPath: 'Movies/X/X.mkv', size: 10 },
    binding: { status: 'active', torrentFile: { id: 'tf-1', size: 10 } },
    env: ENV,
  });
  const partFile = desired.desired.plex.partFile;

  assert.equal(classifyProjection({ desired, consumer: 'plex', observed: { items: [{ itemId: '1', partFile, partSize: 10 }] } }).state,
    PROJECTION_STATES.ALIGNED);
  assert.equal(classifyProjection({ desired, consumer: 'plex', observed: { items: [] } }).state,
    PROJECTION_STATES.MISSING);
  assert.equal(classifyProjection({ desired, consumer: 'plex', observed: { items: [{ itemId: '1', partFile: '/other/X.mkv', partSize: 10 }] } }).state,
    PROJECTION_STATES.STALE_PATH);
  assert.equal(classifyProjection({ desired, consumer: 'plex', observed: { items: [{ itemId: '1', partFile, partSize: 11 }] } }).state,
    PROJECTION_STATES.STALE_SIZE);
  assert.equal(classifyProjection({ desired, consumer: 'plex', observed: { items: [{ itemId: '1' }, { itemId: '2' }] } }).state,
    PROJECTION_STATES.CONFLICTED);
  assert.equal(classifyProjection({ desired, consumer: 'plex', observed: null }).state,
    PROJECTION_STATES.UNKNOWN, 'an unobserved consumer is never an absence');
  assert.equal(classifyProjection({ desired, consumer: 'plex', observed: null }).repairable, false);
  assert.equal(classifyProjection({ desired, consumer: 'plex', observed: { items: [] } }).repairable, true);
});

// ── 3. the repair is bounded ─────────────────────────────────────────────
test('the repair asks the consumer to look at the exact directory, and changes nothing else', async (t) => {
  const dir = tempDir(t, 'hs-projection-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });

  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt1:default', mediaType: 'movie', mediaId: 'tt1', title: 'X',
  });
  store.commitPresentationIdentity(item.id, {
    title: 'X', year: null,
    canonicalPath: 'Movies/X/X.mkv',
    strmPath: 'Movies/X/X.strm',
  });
  const desired = desiredProjectionForItem({ store, cache, item, env: ENV });

  const notified = [];
  let scanned = [];
  const result = await repairConsumerProjection({
    desired,
    consumer: 'plex',
    observe: async () => ({ observed: true, items: [], error: null }),
    notify: async (args) => { notified.push(args); return { notified: true, method: 'partial-refresh' }; },
    confirm: async (args) => { scanned.push(args); return { outcome: 'verified' }; },
  });

  assert.equal(result.action, 'refresh');
  assert.equal(result.refreshed, true);
  assert.equal(notified.length, 1, 'exactly one refresh');
  assert.equal(notified[0].fullSection, false, 'never a whole-section scan');
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].expectedPartFile, desired.desired.plex.partFile,
    'the confirm asks about OUR projection');
  assert.equal(scanned[0].expectedSize, desired.desired.plex.partSize);
  // Nothing about the media changed: no reselection, no rename, no Binding.
  const after = desiredProjectionForItem({ store, cache, item, env: ENV });
  assert.deepEqual(after.presentation, desired.presentation);
  assert.equal(store.getActiveBindingForLibraryItem(item.id), null, 'no Binding was invented');
});

test('a conflicted projection is not repaired here', async (t) => {
  const dir = tempDir(t, 'hs-projection-conflict-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  t.after(() => store.close());
  const desired = desiredProjection({
    item: { mediaId: 'tt1', mediaType: 'movie' },
    presentation: { title: 'X', year: null, canonicalPath: 'Movies/X/X.mkv', strmPath: 'Movies/X/X.strm' },
    vfsEntry: { canonicalPath: 'Movies/X/X.mkv', size: 10 },
    binding: { status: 'active', torrentFile: { id: 'tf-1', size: 10 } },
    env: ENV,
  });
  let notified = 0;
  const result = await repairConsumerProjection({
    desired,
    consumer: 'plex',
    observe: async () => ({ observed: true, items: [{ itemId: '1' }, { itemId: '2' }], error: null }),
    notify: async () => { notified += 1; return { notified: true }; },
    confirm: async () => ({ outcome: 'verified' }),
  });
  assert.equal(result.action, 'operator-decision');
  assert.equal(notified, 0, 'no refresh is sent while the conflict is unresolved');
});

// ── 4. consumer state is never an identity authority ──────────────────────
test('a Part without an expected file cannot be verified', () => {
  const result = classifyResultingItem(
    { partId: '1', file: '/whatever.mkv', size: 10 },
    { mediaId: 'tt1', expectedPartFile: null, expectedSize: null },
  );
  assert.ok(result != null, 'without an expected Part file there is nothing to verify');
  assert.equal(result.code, 'INGEST_NOT_PLAYBACK_READY');
});

test('a wrong Part path or size is projection drift, not a media failure', () => {
  const wrongPath = classifyResultingItem(
    { partId: '1', file: '/other.mkv', size: 10 },
    { mediaId: 'tt1', expectedPartFile: '/right.mkv', expectedSize: 10 },
  );
  assert.equal(wrongPath.code, 'INGEST_WRONG_PART_PATH');
  const wrongSize = classifyResultingItem(
    { partId: '1', file: '/right.mkv', size: 11 },
    { mediaId: 'tt1', expectedPartFile: '/right.mkv', expectedSize: 10 },
  );
  assert.equal(wrongSize.code, 'INGEST_WRONG_PART_SIZE');
});

// ── 5. the operator surface distinguishes media state from projection state ─
test('the library listing reports the consumer projection separately from the media state', async (t) => {
  const dir = tempDir(t, 'hs-projection-listing-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });

  const { listLibrary } = await import('../src/lib/library/listing.js');
  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt1:default', mediaType: 'movie', mediaId: 'tt1', title: 'X',
  });
  store.commitPresentationIdentity(item.id, {
    title: 'X', year: null, canonicalPath: 'Movies/X/X.mkv', strmPath: 'Movies/X/X.strm',
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt1', releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    canonicalPath: 'Movies/X/X.mkv', torrentFileId: 'tf-1', size: 10,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  });
  store.recordConsumerObservation({
    consumer: 'plex', mediaType: 'movie', mediaId: 'tt1', season: null, episode: null,
    present: 0, source: 'test',
  });

  const listing = listLibrary({ cache, controlPlaneStore: store });
  const row = listing.items.find((entry) => entry.mediaId === 'tt1');
  assert.ok(row, 'the item is listed');
  assert.equal(row.state, 'published', 'the MEDIA state is published');
  assert.equal(row.projection.presentationCommitted, true);
  assert.equal(row.projection.plex, 'absent',
    'the CONSUMER state is absent — a different fact from the media state');
  assert.equal(row.projection.jellyfin, 'not-observed');
});
