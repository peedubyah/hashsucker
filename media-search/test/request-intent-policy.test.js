/**
 * Durable request-intent policy: normalization, transitions, upgrade and
 * retention interaction. Real in-memory stores, no network, no providers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  markTemporaryPublication, clearTemporaryPublication,
} from '../src/lib/library/retirement.js';
import {
  normalizeRequestIntent, intentTtlMs, upgradesAllowed, displayIntent,
  DEFAULT_TEMP_TTL_MS,
} from '../src/lib/library/intent.js';

function stores() {
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const cps = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  return { cache, cps };
}

function publish(cps, cache, { mediaId, intent = null, policy = null, mode = null } = {}) {
  const item = cps.ensureLibraryItem({
    mediaType: 'movie', mediaId, title: 'T', desiredState: 'present',
  });
  const cols = [];
  if (intent) cols.push(["intent", intent]);
  if (policy) cols.push(["upgrade_policy", policy]);
  if (mode) cols.push(["publication_mode", mode]);
  for (const [c, v] of cols) {
    cps.db.prepare(`UPDATE library_items SET ${c} = ? WHERE id = ?`).run(v, item.id);
  }
  return cps.getLibraryItem(item.id);
}

test('normalize: omitted legacy, explicit names, unknown 400, download guidance', () => {
  assert.deepEqual(normalizeRequestIntent({}), { ok: true, intent: 'library', fromLegacy: true });
  assert.deepEqual(normalizeRequestIntent({ temporary: true }).intent, 'watch');
  assert.deepEqual(normalizeRequestIntent({ intent: 'watch' }), { ok: true, intent: 'watch', fromLegacy: false });
  assert.deepEqual(normalizeRequestIntent({ intent: 'IMMEDIATE' }).intent, 'immediate');
  assert.ok(!normalizeRequestIntent({ intent: 'ultraviolet' }).ok);
  const dl = normalizeRequestIntent({ intent: 'download' });
  assert.ok(!dl.ok && /download-request/.test(dl.error));
  assert.equal(intentTtlMs({}), DEFAULT_TEMP_TTL_MS);
  assert.equal(intentTtlMs({ ttlHours: 48 }), 48 * 3600 * 1000);
  assert.equal(intentTtlMs({ ttlHours: -3 }), DEFAULT_TEMP_TTL_MS);
});

test('upgradesAllowed + displayIntent derive from durable columns', () => {
  assert.equal(upgradesAllowed({ publicationMode: 'permanent', upgradePolicy: 'auto' }), true);
  assert.equal(upgradesAllowed({ publicationMode: 'temporary' }), false);
  assert.equal(upgradesAllowed({ publicationMode: 'permanent', upgradePolicy: 'off' }), false);
  assert.equal(displayIntent({ publicationMode: 'temporary' }), 'watch');
  assert.equal(displayIntent({ publicationMode: 'permanent', upgradePolicy: 'off' }), 'immediate');
  assert.equal(displayIntent({ publicationMode: 'permanent', upgradePolicy: 'auto', intent: 'library' }), 'library');
});

test('watch -> library adopts permanent and re-enables upgrades', () => {
  const { cps } = stores();
  publish(cps, null, { mediaId: 'tt-w' });
  const marked = markTemporaryPublication(cps, { mediaType: 'movie', mediaId: 'tt-w' }, { nowMs: 1000 });
  assert.ok(marked.ok);
  let item = cps.getLibraryItem(marked.libraryItemId);
  assert.equal(item.publicationMode, 'temporary');
  assert.equal(item.intent, 'watch');
  const cleared = clearTemporaryPublication(cps,
    { mediaType: 'movie', mediaId: 'tt-w' }, { nowMs: 2000, intent: 'library' });
  assert.ok(cleared.ok && !cleared.unchanged);
  item = cps.getLibraryItem(cleared.libraryItemId);
  assert.equal(item.publicationMode, 'permanent');
  assert.equal(item.retireAt, null);
  assert.equal(item.intent, 'library');
  assert.equal(item.upgradePolicy, 'auto');
  assert.equal(upgradesAllowed(item), true);
});

test('library -> watch never destructively shortens a permanent publication', () => {
  const { cps } = stores();
  publish(cps, null, { mediaId: 'tt-p' });
  const res = clearTemporaryPublication(cps,
    { mediaType: 'movie', mediaId: 'tt-p' }, { nowMs: 1000, intent: 'watch' });
  assert.ok(res.ok && res.unchanged);
  assert.equal(res.reason, 'already-permanent');
  const item = cps.getLibraryItem(res.libraryItemId);
  assert.equal(item.publicationMode, 'permanent');
  assert.equal(item.intent, 'library');
});

test('immediate holds without chasing; library re-request re-enables', () => {
  const { cps } = stores();
  publish(cps, null, { mediaId: 'tt-i' });
  const set = clearTemporaryPublication(cps,
    { mediaType: 'movie', mediaId: 'tt-i' }, { nowMs: 1000, intent: 'immediate' });
  assert.ok(set.ok && !set.unchanged);
  let item = cps.getLibraryItem(set.libraryItemId);
  assert.equal(item.publicationMode, 'permanent');
  assert.equal(item.retireAt, null);
  assert.equal(item.intent, 'immediate');
  assert.equal(item.upgradePolicy, 'off');
  assert.equal(upgradesAllowed(item), false);
  const back = clearTemporaryPublication(cps,
    { mediaType: 'movie', mediaId: 'tt-i' }, { nowMs: 2000, intent: 'library' });
  assert.ok(back.ok && !back.unchanged);
  item = cps.getLibraryItem(back.libraryItemId);
  assert.equal(item.upgradePolicy, 'auto');
  assert.equal(upgradesAllowed(item), true);
  const again = clearTemporaryPublication(cps,
    { mediaType: 'movie', mediaId: 'tt-i' }, { nowMs: 3000, intent: 'library' });
  assert.ok(again.unchanged);
});

test('fresh rows default to library/auto; temporary backfill reads as watch', () => {
  const { cps } = stores();
  const fresh = cps.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt-new', title: 'N', desiredState: 'present' });
  assert.equal(fresh.intent, 'library');
  assert.equal(fresh.upgradePolicy, 'auto');
  assert.equal(displayIntent(fresh), 'library');
  cps.db.prepare(`UPDATE library_items SET publication_mode = 'temporary', retire_at = 9999,
    intent = 'watch' WHERE media_id = 'tt-new'`).run();
  const item = cps.getLibraryItemByIdentityKey('movie:tt-new:default');
  assert.equal(item.intent, 'watch');
  assert.equal(displayIntent(item), 'watch');
});

test('same watch intent is a no-op and keeps durable retention policy', () => {
  const { cps } = stores();
  publish(cps, null, { mediaId: 'tt-same' });
  const first = markTemporaryPublication(cps, { mediaType: 'movie', mediaId: 'tt-same' }, {
    nowMs: 1000, ttlMs: 24 * 60 * 60 * 1000,
  });
  const second = markTemporaryPublication(cps, { mediaType: 'movie', mediaId: 'tt-same' }, {
    nowMs: 2000, ttlMs: 48 * 60 * 60 * 1000,
  });
  assert.ok(first.ok && second.ok && second.unchanged);
  const item = cps.getLibraryItem(second.libraryItemId);
  assert.equal(item.intent, 'watch');
  assert.equal(item.upgradePolicy, 'off');
  assert.equal(item.retireAt, first.retireAt);
});

test('intent survives control-plane restart', () => {
  const { cps } = stores();
  publish(cps, null, { mediaId: 'tt-restart' });
  const changed = clearTemporaryPublication(cps, { mediaType: 'movie', mediaId: 'tt-restart' }, {
    nowMs: 1000, intent: 'immediate',
  });
  const id = changed.libraryItemId;
  const db = cps.db;
  const reopened = createControlPlaneStore({ database: db });
  const item = reopened.getLibraryItem(id);
  assert.equal(item.intent, 'immediate');
  assert.equal(item.upgradePolicy, 'off');
  assert.equal(item.publicationMode, 'permanent');
});

test('upgrade seed skips watch and immediate holdings', async () => {
  const { createUpgradeWatchStore, seedBelowTerminal } =
    await import('../src/lib/lifecycle/upgrade-watch.js');
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const cps = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  const watch = createUpgradeWatchStore({ db: cache.db });
  const mkRow = (mediaId, intent, policy, mode) => {
    const item = cps.ensureLibraryItem({ mediaType: 'movie', mediaId, title: 'T', desiredState: 'present' });
    cps.db.prepare(`UPDATE library_items SET intent = ?, upgrade_policy = ?, publication_mode = ?
      WHERE id = ?`).run(intent, policy, mode, item.id);
    const tf = `tf-${mediaId}`;
    cps.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
      VALUES (?, ?, ?, 100, 1)`).run(tf, 'a'.repeat(40), `${mediaId}.mkv`);
    cache.createVfsMovieEntry({
      mediaId, releaseKey: `${'a'.repeat(40)}:torrent`, infoHash: 'a'.repeat(40), fileIndex: null,
      canonicalPath: `Movies/${mediaId}/${mediaId}.mkv`, torrentFileId: tf, size: 100,
      createdAt: 1, updatedAt: 1,
    });
  };
  cache.db.prepare(`INSERT INTO release_attributes (info_hash, source, filename, source_type, resolution, parsed_at)
    VALUES (?, 'dmm', 'x.mkv', 'WEB-DL', '720p', 1)`).run('a'.repeat(40));
  mkRow('tt-lib', 'library', 'auto', 'permanent');
  mkRow('tt-watch', 'watch', 'auto', 'temporary');
  mkRow('tt-imm', 'immediate', 'off', 'permanent');
  const res = seedBelowTerminal({ cache, controlPlaneStore: cps, store: watch });
  assert.equal(res.skippedIntent, 2);
  const due = watch.due({ limit: 10 });
  assert.deepEqual(due.map((r) => r.media_id), ['tt-lib']);
});

test('upgrade evaluate parks watch/immediate rows without network', async () => {
  const { createUpgradeWatchStore, createUpgradeEvaluator } =
    await import('../src/lib/lifecycle/upgrade-watch.js');
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const cps = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  const watch = createUpgradeWatchStore({ db: cache.db });
  let fetched = 0;
  const evaluator = createUpgradeEvaluator({
    store: watch, cache, controlPlaneStore: cps,
    baseUrl: 'http://127.0.0.1:9', dataPlaneBaseUrl: 'http://127.0.0.1:9',
    fetchFn: async () => { fetched += 1; throw new Error('no network in test'); },
  });
  const mkRow = (mediaId, intent, policy, mode) => {
    const item = cps.ensureLibraryItem({ mediaType: 'movie', mediaId, title: 'T', desiredState: 'present' });
    cps.db.prepare(`UPDATE library_items SET intent = ?, upgrade_policy = ?, publication_mode = ?
      WHERE id = ?`).run(intent, policy, mode, item.id);
    const tf = `tf-${mediaId}`;
    cps.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
      VALUES (?, ?, ?, 100, 1)`).run(tf, 'b'.repeat(40), `${mediaId}.mkv`);
    cache.createVfsMovieEntry({
      mediaId, releaseKey: `${'b'.repeat(40)}:torrent`, infoHash: 'b'.repeat(40), fileIndex: null,
      canonicalPath: `Movies/${mediaId}/${mediaId}.mkv`, torrentFileId: tf, size: 100,
      createdAt: 1, updatedAt: 1,
    });
    return watch.ensure({ mediaType: 'movie', mediaId, tf, tier: 22, label: 'web-dl/720p', dueInMs: 0 }).row;
  };
  cache.db.prepare(`INSERT INTO release_attributes (info_hash, source, filename, source_type, resolution, parsed_at)
    VALUES (?, 'dmm', 'x.mkv', 'WEB-DL', '720p', 1)`).run('b'.repeat(40));
  mkRow('tt-w', 'watch', 'auto', 'temporary');
  mkRow('tt-i', 'immediate', 'off', 'permanent');
  mkRow('tt-l', 'library', 'auto', 'permanent');
  for (const row of watch.due({ limit: 10 })) {
    await evaluator.evaluate(row);
  }
  assert.equal(fetched, 1);
  const remaining = new Set(watch.due({ limit: 10 }).map((d) => d.media_id));
  assert.equal(remaining.has('tt-w'), false, 'watch row parked');
  assert.equal(remaining.has('tt-i'), false, 'immediate row parked');
});
