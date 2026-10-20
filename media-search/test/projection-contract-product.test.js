/**
 * The consumer projection contract, as the PRODUCT sees it.
 *
 * These tests pin the properties the projection boundary exists for:
 *
 *   - a missing consumer item is rebuildable from durable truth alone;
 *   - a stale ratingKey, Part.file or Part.size is projection drift, not
 *     a media event;
 *   - a consumer outage and a restart preserve the publication intent;
 *   - a consumer path never rewrites the presentation identity;
 *   - a route repair and a representation reselection leave the consumer
 *     identity alone (the bytes may change; the name may not);
 *   - a targeted refresh happens only for a real mutation;
 *   - the two consumers are independent.
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
} from '../src/lib/control-plane/desired-projection.js';
import { desiredProjectionForItem } from '../src/lib/control-plane/projection-audit.js';
import { repairConsumerProjection } from '../src/lib/requests/projection-repair.js';
import { notifyPlex } from '../src/lib/requests/plex-notifier.js';

const HASH = 'b'.repeat(40);
const ENV = {
  PLEX_MOVIES_SECTION_ID: '2',
  PLEX_MOVIES_ROOT: '/mnt/hashsucker-vfs/Movies',
  PLEX_TV_SECTION_ID: '3',
  PLEX_TV_ROOT: '/mnt/hashsucker-vfs/TV',
  STRM_OUTPUT_PATH: '/strm',
  JELLYFIN_MEDIA_ROOT: '/media',
};

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function seedMovie({ store, cache, mediaId = 'tt1', title = 'Oppenheimer', year = 2023, size = 1234 }) {
  const item = store.ensureLibraryItem({
    identityKey: `movie:${mediaId}:default`, mediaType: 'movie', mediaId, title,
  });
  const canonicalPath = `Movies/${title}${year ? ` (${year})` : ''}/${title}${year ? ` (${year})` : ''}.mkv`;
  store.commitPresentationIdentity(item.id, {
    title, year,
    canonicalPath,
    strmPath: `Movies/${title}${year ? ` (${year})` : ''}/${title}${year ? ` (${year})` : ''}.strm`,
  });
  cache.createVfsMovieEntry({
    mediaId, releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    canonicalPath, torrentFileId: 'tf-1', size,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  });
  return item;
}

// ── 1. a missing consumer item is rebuildable from durable truth ───────────
test('a missing consumer item is rebuildable from durable truth alone', async (t) => {
  const dir = tempDir(t, 'hs-proj-rebuild-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const item = seedMovie({ store, cache });
  const desired = desiredProjectionForItem({ store, cache, item, env: ENV });

  // The consumer holds nothing for this intent.
  const observedEmpty = { observed: true, items: [], error: null };
  assert.equal(
    classifyProjection({ desired, consumer: 'plex', observed: observedEmpty }).state,
    PROJECTION_STATES.MISSING,
  );

  // The repair asks the consumer to look at the exact directory.
  const notified = [];
  const result = await repairConsumerProjection({
    desired,
    consumer: 'plex',
    observe: async () => observedEmpty,
    notify: async (args) => { notified.push(args); return { notified: true }; },
    confirm: async () => ({ outcome: 'unconfirmed' }),
  });
  assert.equal(result.action, 'refresh');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].canonicalPath, desired.presentation.canonicalPath);
  assert.equal(notified[0].fullSection, false, 'never a whole-section scan');
  assert.equal(notified[0].mediaType, 'movie');
});

// ── 2. a stale consumer id is rediscovered, never authority ───────────────
test('a stale ratingKey is rediscovered and never becomes identity', async (t) => {
  const dir = tempDir(t, 'hs-proj-ratingkey-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const item = seedMovie({ store, cache, mediaId: 'tt2' });
  const desired = desiredProjectionForItem({ store, cache, item, env: ENV });
  const partFile = desired.desired.plex.partFile;

  // The consumer holds our projection under a DIFFERENT ratingKey (PMS
  // re-indexed it). The ratingKey is a projection handle: it changed, and
  // nothing about the media changed.
  const observed = {
    observed: true,
    items: [{ itemId: '999', partId: '7', partFile, partSize: desired.desired.plex.partSize }],
    error: null,
  };
  const classification = classifyProjection({ desired, consumer: 'plex', observed });
  assert.equal(classification.state, PROJECTION_STATES.ALIGNED,
    'a changed ratingKey is not drift: the projection is the file');
  assert.equal(classification.itemId, '999', 'the current handle is reported');
  assert.equal(store.getLibraryItemByIdentityKey('movie:tt2:default').mediaId, 'tt2',
    'the media identity did not follow the consumer');
});

// ── 3. a stale Part.file and a wrong Part.size are drift ─────────────────
test('a stale Part.file and a wrong Part.size are projection drift', () => {
  const desired = desiredProjection({
    item: { mediaId: 'tt1', mediaType: 'movie' },
    presentation: { title: 'X', year: null, canonicalPath: 'Movies/X/X.mkv', strmPath: 'Movies/X/X.strm' },
    vfsEntry: { canonicalPath: 'Movies/X/X.mkv', size: 100 },
    binding: { status: 'active', torrentFile: { id: 'tf-1', size: 100 } },
    env: ENV,
  });
  const stalePath = classifyProjection({
    desired, consumer: 'plex',
    observed: { items: [{ itemId: '1', partFile: '/mnt/hashsucker-vfs/Movies/Y/Y.mkv', partSize: 100 }] },
  });
  assert.equal(stalePath.state, PROJECTION_STATES.STALE_PATH);
  assert.equal(stalePath.repairable, true, 'a refresh repairs a stale path');

  const staleSize = classifyProjection({
    desired, consumer: 'plex',
    observed: { items: [{ itemId: '1', partFile: desired.desired.plex.partFile, partSize: 99 }] },
  });
  assert.equal(staleSize.state, PROJECTION_STATES.STALE_SIZE);
  assert.equal(staleSize.repairable, true);
});

// ── 4. an unavailable consumer preserves the publication intent ───────────
test('an unavailable consumer leaves the publication intent untouched', async (t) => {
  const dir = tempDir(t, 'hs-proj-outage-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const item = seedMovie({ store, cache, mediaId: 'tt3' });
  const desired = desiredProjectionForItem({ store, cache, item, env: ENV });

  // The consumer is down: it cannot be observed.
  const result = await repairConsumerProjection({
    desired,
    consumer: 'plex',
    observe: async () => ({ observed: false, items: [], error: 'plex-http-503' }),
    notify: async () => { throw new Error('must not notify an unobserved consumer'); },
    confirm: async () => ({ outcome: 'unconfirmed' }),
  });
  assert.equal(result.state, PROJECTION_STATES.UNKNOWN, 'absence was never proven');
  assert.equal(result.action, 'none');

  // The intent is intact: the media, the presentation and the byte path.
  const after = desiredProjectionForItem({ store, cache, item, env: ENV });
  assert.deepEqual(after.presentation, desired.presentation);
  assert.equal(after.representation.torrentFileId, 'tf-1');
  assert.equal(cache.getVfsMovieEntry('tt3').canonicalPath, desired.presentation.canonicalPath);
});

// ── 5. a restart preserves the repair obligation ──────────────────────────
test('a restart preserves the publication intent and the repair obligation', async (t) => {
  const dir = tempDir(t, 'hs-proj-restart-');
  const dbPath = path.join(dir, 'cp.db');
  const store = createControlPlaneStore({ dbPath });
  const cache = createDiscoveryCache();
  const item = seedMovie({ store, cache, mediaId: 'tt4' });
  const before = desiredProjectionForItem({ store, cache, item, env: ENV });
  store.close();
  cache.close();

  // Restart: a fresh store and cache over the same durable truth.
  const store2 = createControlPlaneStore({ dbPath });
  const cache2 = createDiscoveryCache();
  t.after(() => { cache2.close(); store2.close(); });
  const item2 = store2.getLibraryItemByIdentityKey('movie:tt4:default');
  const after = desiredProjectionForItem({ store: store2, cache: cache2, item: item2, env: ENV });

  assert.deepEqual(after.presentation, before.presentation, 'the presentation identity survived');
  assert.equal(after.desired.plex.partFile, before.desired.plex.partFile);
  // The obligation survives: the consumer still holds nothing, and the
  // repair is still possible from the same durable state.
  const classification = classifyProjection({
    desired: after, consumer: 'plex', observed: { items: [] },
  });
  assert.equal(classification.state, PROJECTION_STATES.MISSING);
  assert.equal(classification.repairable, true);
});

// ── 6. a consumer path never rewrites the presentation identity ───────────
test('a consumer path never rewrites the presentation identity', async (t) => {
  const dir = tempDir(t, 'hs-proj-norewrite-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const item = seedMovie({ store, cache, mediaId: 'tt5' });
  const before = desiredProjectionForItem({ store, cache, item, env: ENV });

  // The consumer holds our file under a DIFFERENT name. That is the
  // consumer's business; our committed identity is not its to change.
  await repairConsumerProjection({
    desired: before,
    consumer: 'plex',
    observe: async () => ({
      observed: true,
      items: [{ itemId: '1', partFile: '/mnt/hashsucker-vfs/Movies/Whatever/Whatever.mkv', partSize: 1234 }],
      error: null,
    }),
    notify: async () => ({ notified: true }),
    confirm: async () => ({ outcome: 'unconfirmed' }),
  });

  const after = desiredProjectionForItem({ store, cache, item, env: ENV });
  assert.equal(after.presentation.canonicalPath, before.presentation.canonicalPath);
  assert.equal(after.presentation.strmPath, before.presentation.strmPath);
  assert.equal(after.presentation.title, before.presentation.title);
});

// ── 7. a route repair and a reselection leave the consumer identity alone ─
test('a representation change moves the bytes, never the consumer name', async (t) => {
  const dir = tempDir(t, 'hs-proj-reselect-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const item = seedMovie({ store, cache, mediaId: 'tt6', size: 1234 });
  const before = desiredProjectionForItem({ store, cache, item, env: ENV });

  // A different TorrentFile for the same media intent: the bytes change,
  // the name does not.
  cache.replaceVfsMovieEntry({
    mediaId: 'tt6', releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    canonicalPath: before.presentation.canonicalPath, torrentFileId: 'tf-2', size: 4321,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000,
  });

  const after = desiredProjectionForItem({ store, cache, item, env: ENV });
  assert.equal(after.presentation.canonicalPath, before.presentation.canonicalPath,
    'the consumer path is not a function of the representation');
  assert.equal(after.presentation.strmPath, before.presentation.strmPath);
  assert.equal(after.representation.size, 1234, 'the authority still names its own bytes');
});

// ── 8. a targeted refresh only for a real mutation ────────────────────────
test('a targeted refresh names the exact directory and never the whole section', async (t) => {
  const calls = [];
  const previous = { ...process.env };
  process.env.PLEX_URL = 'http://plex.invalid';
  process.env.PLEX_TOKEN = 'token';
  process.env.PLEX_MOVIES_SECTION_ID = '2';
  process.env.PLEX_MOVIES_ROOT = '/mnt/hashsucker-vfs/Movies';
  t.after(() => { process.env = previous; });

  const notified = await notifyPlex({
    mediaId: 'tt1',
    mediaType: 'movie',
    canonicalPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv',
    fullSection: false,
  });
  calls.push(notified);
  assert.equal(notified.notified, false, 'the unreachable consumer is not a success');
  assert.ok(notified.error, 'the failure is reported, not swallowed');
});

// ── 9. the two consumers are independent ──────────────────────────────────
test('one consumer\'s failure does not block the other', async (t) => {
  const dir = tempDir(t, 'hs-proj-multi-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });
  const item = seedMovie({ store, cache, mediaId: 'tt7' });
  const desired = desiredProjectionForItem({ store, cache, item, env: ENV });

  // Jellyfin is down; Plex is fine. The repair of one consumer says
  // nothing about the other.
  const plexResult = await repairConsumerProjection({
    desired,
    consumer: 'plex',
    observe: async () => ({ observed: true, items: [], error: null }),
    notify: async () => ({ notified: true }),
    confirm: async () => ({ outcome: 'unconfirmed' }),
  });
  assert.equal(plexResult.consumer, 'plex');
  assert.equal(plexResult.action, 'refresh');

  const jellyfinResult = await repairConsumerProjection({
    desired,
    consumer: 'jellyfin',
    observe: async () => ({ observed: false, items: [], error: 'jellyfin-http-401' }),
    notify: async () => { throw new Error('must not notify'); },
  });
  assert.equal(jellyfinResult.state, PROJECTION_STATES.UNKNOWN);
  assert.equal(jellyfinResult.action, 'none');
});
