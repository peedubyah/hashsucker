/**
 * Stale ProviderPlacement recovery — contract tests.
 *
 * Durable route inventory must reflect currently usable cached provider
 * routes. When the recorded placement is stale, the system may recover
 * ANOTHER already-cached route for the SAME exact TorrentFile — never
 * uncached content, never a different representation.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import {
  findRottedRouteTorrentFiles,
  findStaleRouteTorrentFiles,
  reconcileStaleRoutes,
  usablePlacementCount,
} from '../src/lib/control-plane/route-reconciler.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);
const INTERNAL = 'Show S01/Show - S01E01.mkv';
const UNTIL = 9_000_000_000;

function buildStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'route-recon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createControlPlaneStore({ dbPath: join(dir, 'control-plane.db'), now: () => 1_000_000 });
  t.after(() => store.close());
  return store;
}

/**
 * One library item with an active Binding over a durable TorrentFile.
 *
 * `route.drift: true` models a rotted route: the provider placement is
 * still recorded, but a later authoritative inventory found no present
 * file for it (the provider freed the cached resource) — exactly the
 * condition reconciliation exists to recover.
 */
function seedBoundTorrentFile(store, { infoHash, size, route }) {
  const placement = store.recordPlacement({
    provider: route.provider,
    accountScope: route.accountScope ?? 'default',
    infoHash,
    providerResourceId: route.resourceId,
    state: route.state ?? 'ready',
    ownership: 'owned',
    ownerKey: 'owner-key',
    provenance: 'route-reconciler-test',
    observedAt: 1_000_000,
    expiresAt: UNTIL,
  });
  const providerFileId = String(route.providerFileId ?? '0');
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId, path: INTERNAL, name: 'Show - S01E01.mkv', size, selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
  let tf = store.findTorrentFile(infoHash, INTERNAL);
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
    inventory_observed_at = ?, inventory_expires_at = ?
    WHERE placement_id = ? AND provider_file_id = ?
  `).run(tf.id, 1_000_000, UNTIL, placement.id, providerFileId);
  store.recordReadinessObservation({
    placementId: placement.id, state: 'ready', source: 'route-reconciler-test',
    observedAt: 1_000_000, expiresAt: UNTIL,
  });

  const item = store.ensureLibraryItem({
    identityKey: `movie:tt-recon:${infoHash.slice(0, 6)}`,
    mediaType: 'movie',
    mediaId: `tt-recon-${infoHash.slice(0, 6)}`,
    title: 'Recon Movie',
    desiredState: 'present',
  });
  const path = store.ensureCanonicalPath(item.id, {
    canonicalPath: `Movies/Recon ${infoHash.slice(0, 4)}/Recon.mkv`,
  });
  const exposure = store.recordExposure({
    libraryItemId: item.id,
    libraryPathId: path.id,
    placementId: placement.id,
    providerFileId,
    transport: 'webdav',
    exposureKey: `exposure:${infoHash.slice(0, 8)}:plex`,
    consumer: 'plex',
    state: 'visible',
    readOnly: true,
    observedAt: 1_000_000,
    expiresAt: UNTIL,
  });
  store.activateBinding({
    libraryItemId: item.id,
    libraryPathId: path.id,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    torrentFileId: tf.id,
    placementId: placement.id,
    providerFileId,
    exposureId: exposure.id,
    reason: 'test',
  });

  if (route.drift) {
    // A later authoritative inventory no longer contains the file, and the
    // demotion drops the route. Applied after Exposure + Binding so the
    // historical route is fully recorded first: the durable TorrentFile,
    // Binding and Exposure rows survive; only live usability rots.
    store.db.prepare(`
      UPDATE provider_files SET present = 0, mapping_state = 'unmapped',
      torrent_file_id = NULL, inventory_expires_at = ?
      WHERE placement_id = ?
    `).run(UNTIL, placement.id);
  }
  return tf;
}

test('T1 — a TorrentFile with a usable recorded route is never probed', (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 1000,
    route: { provider: 'torbox', resourceId: 'tb-1' },
  });
  assert.equal(usablePlacementCount(store, tf.id), 1, 'the recorded route is usable');
  assert.deepEqual(findStaleRouteTorrentFiles(store, { limit: 10 }), [],
    'TorrentFiles with a usable route are not reconciliation candidates');
});

test('T2 — a TorrentFile with no usable route is a candidate', (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_B, size: 2000, route: { provider: 'torbox', resourceId: 'tb-drift', drift: true },
  });
  assert.equal(usablePlacementCount(store, tf.id), 0);
  assert.deepEqual(findStaleRouteTorrentFiles(store, { limit: 10 }), [tf.id]);
});

test('T3 — a removed placement is not a usable route', (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_C, size: 3000,
    route: { provider: 'torbox', resourceId: 'tb-3' },
  });
  store.markPlacementRemoved(store.findPlacementByInfoHash('torbox', HASH_C).id, { reason: 'provider-not-found' });
  assert.equal(usablePlacementCount(store, tf.id), 0);
  assert.deepEqual(findStaleRouteTorrentFiles(store, { limit: 10 }), [tf.id]);
});

test('T4 — alternate cached route creates a placement for the SAME TorrentFile', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 4000,
    route: { provider: 'torbox', resourceId: 'tb-stale' },
  });
  store.markPlacementRemoved(store.findPlacementByInfoHash('torbox', HASH_A).id, { reason: 'provider-not-found' });

  const calls = [];
  const ensurer = {
    async ensureSecondPlacementCoalesced({ torrentFileId, discoverOnly }) {
      calls.push({ torrentFileId, discoverOnly });
      assert.equal(torrentFileId, tf.id, 'the same exact TorrentFile');
      assert.equal(discoverOnly, true, 'recovery must be discover-only (cache-only)');
      const placement = store.recordPlacement({
        provider: 'realdebrid', accountScope: 'default', infoHash: HASH_A,
        providerResourceId: 'rd-alt', state: 'ready', ownership: 'external',
        ownerKey: null, provenance: 'route-reconciler-test',
        observedAt: 1_000_000, expiresAt: UNTIL,
      });
      store.replaceProviderFileInventory(placement.id, [{
        providerFileId: '7', path: INTERNAL, name: 'Show - S01E01.mkv', size: 4000, selected: true,
      }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
      store.db.prepare(`
        UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
        inventory_observed_at = ?, inventory_expires_at = ?
        WHERE placement_id = ? AND provider_file_id = '7'
      `).run(tf.id, 1_000_000, UNTIL, placement.id);
      return { status: 'created', targetProvider: 'realdebrid', idSource: 'discovered', apiCalls: 2, placementId: placement.id };
    },
  };

  const result = await reconcileStaleRoutes({ store, secondPlacement: ensurer, limit: 10 });
  assert.deepEqual(result, { scanned: 1, repaired: 1, unavailable: 0, failed: 0, ids: [tf.id] });
  assert.equal(calls.length, 1);

  // Same TorrentFile identity, same Binding — only the route changed.
  const bindings = store.db.prepare('SELECT torrent_file_id, status FROM bindings').all();
  assert.equal(bindings.length, 1, 'no representation change');
  assert.equal(bindings[0].torrent_file_id, tf.id, 'the Binding still names the same TorrentFile');
  assert.equal(usablePlacementCount(store, tf.id), 1, 'the alternate route is now usable');
});

test('T5 — no cached alternate → no acquisition, no fake placement', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_B, size: 5000, route: { provider: 'torbox', resourceId: 'tb-drift', drift: true },
  });
  const calls = [];
  const ensurer = {
    async ensureSecondPlacementCoalesced(params) {
      calls.push(params);
      return { status: 'unavailable', targetProvider: 'realdebrid', reason: 'discover-only', apiCalls: 1 };
    },
  };
  const result = await reconcileStaleRoutes({ store, secondPlacement: ensurer, limit: 10 });
  assert.equal(result.scanned, 1);
  assert.equal(result.repaired, 0);
  assert.equal(result.unavailable, 1);
  // The historical (now rotted) placement is durable history; what matters is
  // that no NEW placement is created for the uncached representation.
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM provider_placements').get().c, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM provider_files').get().c, 1,
    'no provider-file row may be recorded for an uncached representation');
  assert.equal(store.db.prepare('SELECT state FROM provider_placements').get().state, 'ready',
    'the historical placement is not laundered into a fresh one');
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM bindings').get().c, 1);
  assert.equal(calls[0].discoverOnly, true);
  assert.deepEqual(findStaleRouteTorrentFiles(store, { limit: 10 }), [tf.id],
    'still nothing usable, so the next pass retries the same candidate');
});

test('T6 — a different representation is NOT a route recovery', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_C, size: 6000, route: { provider: 'torbox', resourceId: 'tb-drift', drift: true },
  });
  const ensurer = {
    async ensureSecondPlacementCoalesced() {
      // The provider has the release but a DIFFERENT file (size/path), so
      // there is no exact match to record.
      return { status: 'failed', targetProvider: 'torbox', reason: 'no-exact-match', apiCalls: 2 };
    },
  };
  const result = await reconcileStaleRoutes({ store, secondPlacement: ensurer, limit: 10 });
  assert.equal(result.scanned, 1);
  assert.equal(result.failed, 1, 'a representation mismatch is not a repair');
  assert.equal(result.repaired, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM provider_placements').get().c, 1,
    'same-episode-different-release must never masquerade as route recovery');
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM provider_files').get().c, 1,
    'no provider-file inventory may be recorded from a mismatched representation');
});

test('T7 — a probe error does not invalidate the durable placement', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 7000,
    route: { provider: 'torbox', resourceId: 'tb-7', drift: true },
  });
  const ensurer = {
    async ensureSecondPlacementCoalesced() { throw new Error('provider timeout'); },
  };
  const result = await reconcileStaleRoutes({ store, secondPlacement: ensurer, limit: 10 });
  assert.equal(result.failed, 1, 'a probe error is a failure, never a repair');
  assert.equal(result.unavailable, 0, 'a probe error is not the "no cached route" verdict');
  assert.equal(result.repaired, 0);
  // A transient probe failure must not remove durable history.
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM provider_placements').get().c, 1);
  assert.equal(store.db.prepare('SELECT state FROM provider_placements').get().state, 'ready',
    'a failed probe must not demote the recorded route');
  assert.equal(usablePlacementCount(store, tf.id), 0, 'nothing was invented to make it usable');
  assert.deepEqual(findStaleRouteTorrentFiles(store, { limit: 10 }), [tf.id],
    'a failed probe leaves the candidate for a later pass');
});

test('T8 — the pass is bounded by limit', (t) => {
  const store = buildStore(t);
  for (let i = 0; i < 5; i += 1) {
    seedBoundTorrentFile(store, {
      infoHash: String(i).repeat(40), size: 100 + i,
      route: { provider: 'torbox', resourceId: `tb-drift-${i}`, drift: true },
    });
  }
  const limited = findStaleRouteTorrentFiles(store, { limit: 3 });
  assert.equal(limited.length, 3, 'a pass never scans the whole library');
});

// The fixture's `activateBinding` requires present provider_files; assert it
// is present for the seeded placement (a fixture sanity check).
test('fixture sanity: the seeded placement carries a present mapped file', (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 1000,
    route: { provider: 'torbox', resourceId: 'tb-sane' },
  });
  const placement = store.findPlacementByInfoHash('torbox', HASH_A);
  const files = store.db.prepare('SELECT * FROM provider_files WHERE placement_id = ?').all(placement.id);
  assert.equal(files.length, 1);
  assert.equal(files[0].present, 1);
  assert.equal(files[0].mapping_state, 'mapped');
  assert.equal(files[0].torrent_file_id, tf.id);
  const itemId = store.db.prepare('SELECT library_item_id FROM bindings LIMIT 1').get().library_item_id;
  assert.equal(store.getActiveCanonicalPath(itemId).canonicalPath.startsWith('Movies/'), true);
  assert.equal(store.db.prepare('SELECT status FROM bindings').get().status, 'active');
});

// ---------------------------------------------------------------------------
// Live verification: durable inventory cannot see provider-side rot.
// ---------------------------------------------------------------------------

const torboxProvidersWith = (cached, { fail = false } = {}) => ({
  torbox: { checkCached: async () => { if (fail) throw new Error('provider timeout'); return cached; } },
  realdebrid: null,
});
const rdProvidersWith = (hashes) => ({
  torbox: null,
  realdebrid: { listTorrents: async () => [...hashes].map((hash) => ({ hash, status: 'downloaded' })) },
});

test('T9 — a live verified route is never a candidate, even when durability would say so', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 1000, route: { provider: 'torbox', resourceId: 'tb-1' },
  });
  const providers = torboxProvidersWith(new Set([HASH_A]));
  assert.deepEqual(await findRottedRouteTorrentFiles(store, { limit: 10, providers }), []);
  // The durable-only criterion agrees here only because nothing demoted it;
  // that is precisely the blind spot T10 exposes.
  assert.equal(usablePlacementCount(store, tf.id), 1);
});

test('T10 — provider-side rot makes a healthy-looking route a candidate', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_B, size: 2000, route: { provider: 'torbox', resourceId: 'tb-drift' },
  });
  // Durably pristine: no demotion happened. Only the provider knows.
  assert.equal(usablePlacementCount(store, tf.id), 1);
  assert.deepEqual(findStaleRouteTorrentFiles(store, { limit: 10 }), [], 'durable-only finds nothing');
  const providers = torboxProvidersWith(new Set()); // nothing cached any more
  assert.deepEqual(await findRottedRouteTorrentFiles(store, { limit: 10, providers }), [tf.id],
    'the provider, not the stale row, is the authority on rot');
});

test('T11 — an unanswerable probe defers; it never declares rot', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_C, size: 3000, route: { provider: 'torbox', resourceId: 'tb-1' },
  });
  const providers = torboxProvidersWith(new Set(), { fail: true });
  assert.deepEqual(await findRottedRouteTorrentFiles(store, { limit: 10, providers }), [],
    'a failed probe must not manufacture a candidate');
  assert.equal(usablePlacementCount(store, tf.id), 1, 'durable truth is untouched by a failed probe');
});

test('T12 — an RD route rots while TorBox still serves the same TorrentFile', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 4000,
    route: { provider: 'realdebrid', resourceId: 'rd-1', providerFileId: '1' },
  });
  const rdProviders = rdProvidersWith(new Set()); // RD no longer has it
  const rotted = await findRottedRouteTorrentFiles(store, { limit: 10, providers: rdProviders });
  assert.deepEqual(rotted, [tf.id]);
  // TorBox still has the exact bytes — the discover-only repair must find
  // the SAME TorrentFile on TorBox without acquiring anything.
  const ensurer = {
    async ensureSecondPlacementCoalesced({ torrentFileId, discoverOnly }) {
      assert.equal(torrentFileId, tf.id);
      assert.equal(discoverOnly, true);
      const placement = store.recordPlacement({
        provider: 'torbox', accountScope: 'default', infoHash: HASH_A,
        providerResourceId: 'tb-recovered', state: 'ready', ownership: 'owned',
        ownerKey: 'owner-key', provenance: 'route-reconciler-test',
        observedAt: 1_000_000, expiresAt: UNTIL,
      });
      store.replaceProviderFileInventory(placement.id, [{
        providerFileId: '0', path: INTERNAL, name: 'Show - S01E01.mkv', size: 4000, selected: true,
      }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
      store.db.prepare(`
        UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
        inventory_observed_at = ?, inventory_expires_at = ?
        WHERE placement_id = ?
      `).run(tf.id, 1_000_000, UNTIL, placement.id);
      return { status: 'created', targetProvider: 'torbox', idSource: 'recovered', apiCalls: 2, placementId: placement.id };
    },
  };
  const result = await reconcileStaleRoutes({ store, secondPlacement: ensurer, providers: rdProviders, limit: 10 });
  assert.deepEqual(result, { scanned: 1, repaired: 1, unavailable: 0, failed: 0, ids: [tf.id] });
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM torrent_files').get().c, 1,
    'the representation did not change');
});
