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
  retireVerifiedDeadRedundantRoutes,
  findStaleRouteTorrentFiles,
  reconcileEvidenceDueRoutes,
  reconcileStaleRoutes,
  usablePlacementCount,
} from '../src/lib/control-plane/route-reconciler.js';
import {
  findEvidenceProvenDeadPlacements,
  findEvidenceRepairDueTorrentFiles,
} from '../src/lib/control-plane/route-recovery.js';

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

/**
 * Record the durable delivery evidence for one route: 'terminal' (the
 * provider answered "gone"), 'usable' (it delivered bytes) or 'temporary'
 * (the provider said wait).
 */
function recordRouteEvidence(store, { placement, providerFileId, provider, accountScope = 'default', state = 'terminal', observedAt = 1_000_000, expiresAt = UNTIL }) {
  const tfId = store.db.prepare(
    'SELECT torrent_file_id FROM provider_files WHERE placement_id = ? AND provider_file_id = ?',
  ).get(placement.id, providerFileId)?.torrent_file_id ?? null;
  const infoHash = tfId ? store.getTorrentFile(tfId)?.infoHash ?? null : null;
  store.recordDeliveryEvidence({
    provider,
    accountScope,
    placementId: placement.id,
    providerFileId,
    infoHash,
    fileIndexKey: -1,
    state,
    reason: 'test',
    failureCategory: state === 'terminal' ? 'route-terminal' : null,
    observedAt,
    expiresAt,
  });
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
// Evidence-first recovery: the durable evidence is the input, and a
// terminal fact is never re-proved by asking the provider again.
// ---------------------------------------------------------------------------

test('T9 — a route proven alive is never a recovery candidate', (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 1000, route: { provider: 'torbox', resourceId: 'tb-1', providerFileId: '0' },
  });
  const placement = store.findPlacementByInfoHash('torbox', HASH_A);
  recordRouteEvidence(store, { placement, providerFileId: '0', provider: 'torbox', state: 'usable' });
  assert.deepEqual(findEvidenceRepairDueTorrentFiles(store, { limit: 10, now: 1_000_000 }), [],
    'a route that delivered bytes needs no repair');
});

test('T10 — a route proven dead makes the TorrentFile a recovery candidate, with no provider call', (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_B, size: 2000, route: { provider: 'torbox', resourceId: 'tb-dead', providerFileId: '0' },
  });
  const placement = store.findPlacementByInfoHash('torbox', HASH_B);
  recordRouteEvidence(store, { placement, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  const due = findEvidenceRepairDueTorrentFiles(store, { limit: 10, now: 1_000_000 });
  assert.deepEqual(due.map((r) => r.torrentFileId), [tf.id],
    'the durable evidence IS the work item');
  assert.equal(due[0].deadRoutes, 1);
  // The durable-only criterion still sees a usable row: the evidence is the
  // authority on DEATH, not on inventory.
  assert.deepEqual(findStaleRouteTorrentFiles(store, { limit: 10 }), [],
    'inventory was never demoted; only the delivery evidence says the route died');
});

test('T11 — a route nobody observed is never a candidate', (t) => {
  const store = buildStore(t);
  seedBoundTorrentFile(store, {
    infoHash: HASH_C, size: 3000, route: { provider: 'torbox', resourceId: 'tb-1', providerFileId: '0' },
  });
  assert.deepEqual(findEvidenceRepairDueTorrentFiles(store, { limit: 10, now: 1_000_000 }), [],
    'no observation is not a failure');
});

test('T12 — a throttled route is not a recovery candidate (throttling is not death)', (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 4000, route: { provider: 'torbox', resourceId: 'tb-throttled', providerFileId: '0' },
  });
  const placement = store.findPlacementByInfoHash('torbox', HASH_A);
  recordRouteEvidence(store, { placement, providerFileId: '0', provider: 'torbox', state: 'temporary' });
  assert.deepEqual(findEvidenceRepairDueTorrentFiles(store, { limit: 10, now: 1_000_000 }), [],
    'a temporary failure is retried by the next read, not repaired');
});

test('T12b — the recovery pass makes NO provider call when nothing is due', async (t) => {
  const store = buildStore(t);
  seedBoundTorrentFile(store, {
    infoHash: HASH_B, size: 2000, route: { provider: 'torbox', resourceId: 'tb-ok', providerFileId: '0' },
  });
  let providerCalls = 0;
  const ensurer = {
    async ensureSecondPlacementCoalesced() { providerCalls += 1; return { status: 'unavailable' }; },
  };
  const result = await reconcileEvidenceDueRoutes({ store, secondPlacement: ensurer, limit: 10, now: 1_000_000 });
  assert.equal(result.scanned, 0);
  assert.equal(providerCalls, 0, 'an idle evidence pass must not touch a provider');
});

test('T12c — the recovery pass repairs a TorrentFile whose routes are proven dead', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_C, size: 5000, route: { provider: 'torbox', resourceId: 'tb-dead', providerFileId: '0' },
  });
  const placement = store.findPlacementByInfoHash('torbox', HASH_C);
  recordRouteEvidence(store, { placement, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  const ensurer = {
    async ensureSecondPlacementCoalesced({ torrentFileId, discoverOnly }) {
      assert.equal(torrentFileId, tf.id);
      assert.equal(discoverOnly, true, 'the repair never acquires uncached content');
      return { status: 'unavailable', reason: 'no-cached-route', apiCalls: 2 };
    },
  };
  const result = await reconcileEvidenceDueRoutes({ store, secondPlacement: ensurer, limit: 10, now: 1_000_000 });
  assert.deepEqual(result, { scanned: 1, repaired: 0, unavailable: 1, failed: 0, ids: [] });
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM torrent_files').get().c, 1,
    'the representation did not change');
});

// ---------------------------------------------------------------------------
// Retirement: proven route death only, and never a title's last route
// ---------------------------------------------------------------------------

test('T13 — a dead placement with a live sibling route is retired', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 1000, route: { provider: 'torbox', resourceId: 'tb-1', providerFileId: '0' },
  });
  // The same exact TorrentFile is also cached on RD.
  const alternate = store.recordPlacement({
    provider: 'realdebrid', accountScope: 'default', infoHash: HASH_A,
    providerResourceId: 'rd-alt', state: 'ready', ownership: 'external',
    ownerKey: null, provenance: 'route-reconciler-test',
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(alternate.id, [{
    providerFileId: '9', path: INTERNAL, name: 'Show - S01E01.mkv', size: 1000, selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped'
    WHERE placement_id = ? AND provider_file_id = '9'
  `).run(tf.id, alternate.id);
  assert.equal(usablePlacementCount(store, tf.id), 2, 'both routes recorded');

  // The TorBox route is proven dead (terminal evidence) and the RD route
  // delivered bytes (usable evidence): a redundant dead route.
  const dead = store.findPlacementByInfoHash('torbox', HASH_A);
  const alive = store.findPlacementByInfoHash('realdebrid', HASH_A);
  recordRouteEvidence(store, { placement: dead, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  recordRouteEvidence(store, { placement: alive, providerFileId: '9', provider: 'realdebrid', state: 'usable' });
  // The proof is available BEFORE any retirement, and it costs no provider
  // call: the evidence already said the route is dead and the sibling
  // delivered bytes.
  assert.deepEqual(
    findEvidenceProvenDeadPlacements(store, { now: 1_000_000 }).map((r) => r.placementId),
    [dead.id],
    'the evidence alone identifies the retirable route',
  );
  const outcome = await retireVerifiedDeadRedundantRoutes({ store, limit: 10, now: 1_000_000 });
  assert.equal(outcome.retired.length, 1, 'the dead redundant placement is retired');
  assert.equal(outcome.retired[0].provider, 'torbox');
  assert.equal(outcome.deferred, 0, 'nothing was unanswerable');
  assert.equal(store.findPlacementByInfoHash('torbox', HASH_A), null,
    'a removed placement is not reused by delivery');
  assert.equal(usablePlacementCount(store, tf.id), 1, 'the live route keeps the title servable');
  // After the retirement the route is gone from the projection, so the
  // proven-dead set is empty again: the pass is idempotent.
  assert.deepEqual(findEvidenceProvenDeadPlacements(store, { now: 1_000_000 }), []);
});

test('T14 — a title\'s LAST route is never retired', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_B, size: 2000, route: { provider: 'torbox', resourceId: 'tb-solo', providerFileId: '0' },
  });
  const only = store.findPlacementByInfoHash('torbox', HASH_B);
  recordRouteEvidence(store, { placement: only, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  const outcome = await retireVerifiedDeadRedundantRoutes({ store, limit: 10, now: 1_000_000 });
  assert.equal(outcome.retired.length, 0,
    'retiring the only route would un-serve the title until discovery replaces it');
  assert.equal(store.findPlacementByInfoHash('torbox', HASH_B)?.state, 'ready',
    'the last route stays recorded: recovery, not teardown, owns this case');
  assert.equal(usablePlacementCount(store, tf.id), 1);
});

test('T15 — an unanswerable probe never retires anything', async (t) => {
  const store = buildStore(t);
  seedBoundTorrentFile(store, {
    infoHash: HASH_C, size: 3000, route: { provider: 'torbox', resourceId: 'tb-1', providerFileId: '0' },
  });
  const alternate = store.recordPlacement({
    provider: 'realdebrid', accountScope: 'default', infoHash: HASH_C,
    providerResourceId: 'rd-alt', state: 'ready', ownership: 'external',
    ownerKey: null, provenance: 'route-reconciler-test',
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(alternate.id, [{
    providerFileId: '9', path: INTERNAL, name: 'Show - S01E01.mkv', size: 3000, selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = (SELECT id FROM torrent_files WHERE info_hash = ?),
    mapping_state = 'mapped' WHERE placement_id = ? AND provider_file_id = '9'
  `).run(HASH_C, alternate.id);
  // The TorBox route was never observed as dead: a temporary record is not
  // death, so nothing is retired.
  const dead = store.findPlacementByInfoHash('torbox', HASH_C);
  const alive = store.findPlacementByInfoHash('realdebrid', HASH_C);
  recordRouteEvidence(store, { placement: dead, providerFileId: '0', provider: 'torbox', state: 'temporary' });
  recordRouteEvidence(store, { placement: alive, providerFileId: '9', provider: 'realdebrid', state: 'usable' });
  const outcome = await retireVerifiedDeadRedundantRoutes({ store, limit: 10, now: 1_000_000 });
  assert.equal(outcome.retired.length, 0, 'a throttled route must not retire durable inventory');
  assert.equal(store.findPlacementByInfoHash('torbox', HASH_C)?.state, 'ready');
});

test('T16 — retirement is idempotent across passes', async (t) => {
  const store = buildStore(t);
  const tf = seedBoundTorrentFile(store, {
    infoHash: HASH_A, size: 4000, route: { provider: 'torbox', resourceId: 'tb-1', providerFileId: '0' },
  });
  const alternate = store.recordPlacement({
    provider: 'realdebrid', accountScope: 'default', infoHash: HASH_A,
    providerResourceId: 'rd-alt', state: 'ready', ownership: 'external',
    ownerKey: null, provenance: 'route-reconciler-test',
    observedAt: 1_000_000, expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(alternate.id, [{
    providerFileId: '9', path: INTERNAL, name: 'Show - S01E01.mkv', size: 4000, selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000_000, expiresAt: UNTIL });
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped'
    WHERE placement_id = ? AND provider_file_id = '9'
  `).run(tf.id, alternate.id);
  const dead = store.findPlacementByInfoHash('torbox', HASH_A);
  const alive = store.findPlacementByInfoHash('realdebrid', HASH_A);
  recordRouteEvidence(store, { placement: dead, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  recordRouteEvidence(store, { placement: alive, providerFileId: '9', provider: 'realdebrid', state: 'usable' });
  const first = await retireVerifiedDeadRedundantRoutes({ store, limit: 10, now: 1_000_000 });
  const second = await retireVerifiedDeadRedundantRoutes({ store, limit: 10, now: 1_000_000 });
  assert.equal(first.retired.length, 1);
  assert.equal(second.retired.length, 0, 'a second pass finds nothing left to retire');
  assert.equal(store.db.prepare(`SELECT COUNT(*) c FROM provider_placements WHERE state='removed'`).get().c, 1);
});
