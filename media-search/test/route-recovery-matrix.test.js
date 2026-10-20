/**
 * Event-driven route recovery — correctness matrix.
 *
 * The durable delivery evidence is the input; recovery reacts to it; the
 * provider is consulted only for what the evidence cannot answer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import {
  findEvidenceProvenDeadPlacements,
  findEvidenceRepairDueTorrentFiles,
} from '../src/lib/control-plane/route-recovery.js';
import {
  reconcileEvidenceDueRoutes,
  retireVerifiedDeadRedundantRoutes,
} from '../src/lib/control-plane/route-reconciler.js';
import { createRepresentationPolicy, REPRESENTATION_POLICY_REASONS } from '../src/lib/vfs/representation-policy.js';

const HASH = 'a'.repeat(40);
const INTERNAL = 'Movie/movie.mkv';
const NOW = 1_000_000;
const UNTIL = 9_000_000_000;

function tempDbPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-route-matrix-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return path.join(dir, 'control-plane.db');
}

/** One bound TorrentFile with the given routes. */
function seedBound(store, { routes, infoHash = HASH, size = 4096 } = {}) {
  let tf = null;
  let firstPlacementId = null;
  routes.forEach((route, index) => {
    const placement = store.recordPlacement({
      provider: route.provider,
      accountScope: 'default',
      infoHash,
      providerResourceId: route.resourceId,
      state: route.state ?? 'ready',
      ownership: 'owned',
      ownerKey: 'owner',
      provenance: 'route-matrix-test',
      observedAt: NOW,
      expiresAt: UNTIL,
    });
    if (index === 0) firstPlacementId = placement.id;
    store.replaceProviderFileInventory(placement.id, [{
      providerFileId: String(index),
      path: INTERNAL,
      name: 'movie.mkv',
      size,
      selected: true,
    }], { authoritative: true, complete: true, observedAt: NOW, expiresAt: UNTIL });
    tf = store.findTorrentFile(infoHash, INTERNAL);
    store.db.prepare(`
      UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
      inventory_observed_at = ?, inventory_expires_at = ?
      WHERE placement_id = ? AND provider_file_id = ?
    `).run(tf.id, NOW, UNTIL, placement.id, String(index));
  });
  const item = store.ensureLibraryItem({
    identityKey: `movie:tt-matrix:${infoHash.slice(0, 6)}`,
    mediaType: 'movie',
    mediaId: `tt-matrix-${infoHash.slice(0, 6)}`,
    title: 'Matrix Movie',
    desiredState: 'present',
  });
  const canonicalPath = store.ensureCanonicalPath(item.id, {
    canonicalPath: `Movies/Matrix ${infoHash.slice(0, 4)}/Matrix.mkv`,
  });
  const exposure = store.recordExposure({
    libraryItemId: item.id,
    libraryPathId: canonicalPath.id,
    placementId: firstPlacementId,
    providerFileId: '0',
    transport: 'webdav',
    exposureKey: `exposure:${infoHash.slice(0, 8)}`,
    consumer: 'plex',
    state: 'visible',
    readOnly: true,
    observedAt: NOW,
    expiresAt: UNTIL,
  });
  store.activateBinding({
    libraryItemId: item.id,
    libraryPathId: canonicalPath.id,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    torrentFileId: tf.id,
    placementId: firstPlacementId,
    providerFileId: '0',
    exposureId: exposure.id,
    reason: 'test',
  });
  return { tf, item };
}

function recordEvidence(store, { placement, providerFileId, provider, state, infoHash = HASH, observedAt = NOW, expiresAt = UNTIL }) {
  store.recordDeliveryEvidence({
    provider,
    accountScope: 'default',
    placementId: placement.id,
    providerFileId,
    infoHash,
    fileIndexKey: -1,
    state,
    reason: 'matrix',
    failureCategory: state === 'terminal' ? 'route-terminal' : null,
    observedAt,
    expiresAt,
  });
}

// ── 1. terminal route + healthy alternate ──────────────────────────────────
test('matrix: a terminal route with a healthy alternate keeps the representation and repairs the route', async (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const { tf, item } = seedBound(store, {
    routes: [{ provider: 'torbox', resourceId: 'tb-1' }, { provider: 'realdebrid', resourceId: 'rd-1' }],
  });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  const rd = store.findPlacementByInfoHash('realdebrid', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  recordEvidence(store, { placement: rd, providerFileId: '1', provider: 'realdebrid', state: 'usable' });

  // The TorBox route is dead, but the RD route is alive: NOT a repair
  // candidate (the TorrentFile still has a live route).
  assert.deepEqual(findEvidenceRepairDueTorrentFiles(store, { now: NOW }), [],
    'a TorrentFile with a live route needs no repair');
  // The dead route may be retired (it is redundant AND proven dead).
  const retired = await retireVerifiedDeadRedundantRoutes({ store, now: NOW });
  assert.equal(retired.retired.length, 1);
  assert.equal(retired.retired[0].provider, 'torbox');
  assert.equal(store.getActiveBindingForLibraryItem(item.id).torrentFile.id, tf.id,
    'the representation is untouched');
  store.close();
});

// ── 2. terminal route + undiscovered same-hash alternate ───────────────────
test('matrix: a terminal route whose alternate is not yet known is a repair candidate', async (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const { tf } = seedBound(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });

  const due = findEvidenceRepairDueTorrentFiles(store, { now: NOW });
  assert.deepEqual(due.map((d) => d.torrentFileId), [tf.id]);

  // The repair asks the provider the ONE question the evidence cannot
  // answer: is there another resource for this exact release?
  let asked = null;
  const ensurer = {
    async ensureSecondPlacementCoalesced({ torrentFileId, discoverOnly }) {
      asked = { torrentFileId, discoverOnly };
      return { status: 'created', targetProvider: 'realdebrid', apiCalls: 2 };
    },
  };
  const result = await reconcileEvidenceDueRoutes({ store, secondPlacement: ensurer, now: NOW });
  assert.deepEqual(result, { scanned: 1, repaired: 1, unavailable: 0, failed: 0, ids: [tf.id] });
  assert.equal(asked.discoverOnly, true, 'the repair never acquires uncached content');
  store.close();
});

// ── 3. temporary throttle ──────────────────────────────────────────────────
test('matrix: a throttled route is neither a repair nor a representation change', async (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  seedBound(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'temporary' });

  assert.deepEqual(findEvidenceRepairDueTorrentFiles(store, { now: NOW }), [],
    'a throttle is not death: the next read retries the route');
  assert.deepEqual(findEvidenceProvenDeadPlacements(store, { now: NOW }), [],
    'a throttled route is never retired');

  const policy = createRepresentationPolicy({ now: () => NOW });
  const decision = policy.decide({
    mediaId: 'tt-matrix',
    routes: [{ kind: 'temporary' }],
    evidence: { recorded: 1, terminal: 0, temporary: 1 },
    discovery: { completed: true, status: 'unavailable' },
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, REPRESENTATION_POLICY_REASONS.TRANSIENT_ROUTE);
  store.close();
});

// ── 4. repeated identical terminal report is idempotent ────────────────────
test('matrix: repeated identical terminal reports are one durable fact', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  seedBound(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  for (let i = 0; i < 5; i += 1) {
    recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  }
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM provider_delivery_evidence').get();
  assert.equal(rows.n, 1, 'the same failure is one row, not five');
  assert.equal(findEvidenceRepairDueTorrentFiles(store, { now: NOW }).length, 1,
    'and it is one work item, not five');
  store.close();
});

// ── 5. temporary -> usable recovery ───────────────────────────────────────
test('matrix: a route that delivers again supersedes its negative evidence', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  seedBound(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'temporary' });
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'usable' });
  const row = store.db.prepare('SELECT state FROM provider_delivery_evidence').get();
  assert.equal(row.state, 'usable', 'a later success supersedes the negative record');
  assert.deepEqual(findEvidenceRepairDueTorrentFiles(store, { now: NOW }), []);
  store.close();
});

// ── 6. terminal route replaced by a new resource id ────────────────────────
test('matrix: a terminal route replaced by a new resource id is served through the new route', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  seedBound(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  // The provider re-added the release under a new resource id.
  const fresh = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH,
    providerResourceId: 'tb-2', state: 'ready', ownership: 'owned',
    ownerKey: 'owner', provenance: 'route-matrix-test', observedAt: NOW, expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(fresh.id, [{
    providerFileId: '0', path: INTERNAL, name: 'movie.mkv', size: 4096, selected: true,
  }], { authoritative: true, complete: true, observedAt: NOW, expiresAt: UNTIL });
  const tf = store.findTorrentFile(HASH, INTERNAL);
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped'
    WHERE placement_id = ? AND provider_file_id = '0'
  `).run(tf.id, fresh.id);
  // The new route has no evidence: it is unknown, not dead.
  assert.deepEqual(findEvidenceRepairDueTorrentFiles(store, { now: NOW }), [],
    'the new route is simply unobserved; the TF is not repair-due');
  store.close();
});

// ── 7. both providers terminal → the completeness proof is required ───────
test('matrix: with every route terminal the representation still needs a completed discovery', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  seedBound(store, {
    routes: [{ provider: 'torbox', resourceId: 'tb-1' }, { provider: 'realdebrid', resourceId: 'rd-1' }],
  });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  const rd = store.findPlacementByInfoHash('realdebrid', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  recordEvidence(store, { placement: rd, providerFileId: '1', provider: 'realdebrid', state: 'terminal' });
  assert.equal(findEvidenceRepairDueTorrentFiles(store, { now: NOW }).length, 1,
    'the route set is proven dead: a repair is due');

  const policy = createRepresentationPolicy({ now: () => NOW });
  const routes = [{ kind: 'terminal' }, { kind: 'terminal' }];
  const evidence = { recorded: 2, terminal: 2, temporary: 0 };

  // Without the discovery, "every known route is dead" is NOT "no route
  // exists": the switch is refused.
  const withoutDiscovery = policy.decide({
    mediaId: 'tt-matrix', routes, evidence, discovery: null,
  });
  assert.equal(withoutDiscovery.allow, false);
  assert.equal(withoutDiscovery.reason, REPRESENTATION_POLICY_REASONS.ROUTE_SET_NOT_PROVEN);

  // With a completed, negative discovery the switch is allowed.
  const withDiscovery = policy.decide({
    mediaId: 'tt-matrix', routes, evidence,
    discovery: { completed: true, status: 'unavailable' },
  });
  assert.equal(withDiscovery.allow, true);
  store.close();
});

// ── 8. a different TorrentFile is not a route answer ──────────────────────
test('matrix: another representation never answers the same-TorrentFile question', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const { tf } = seedBound(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  // A DIFFERENT release exists and is healthy. It is not a route for this
  // TorrentFile, so it must not make the route set look alive.
  const other = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: 'b'.repeat(40),
    providerResourceId: 'tb-other', state: 'ready', ownership: 'owned',
    ownerKey: 'owner', provenance: 'route-matrix-test', observedAt: NOW, expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(other.id, [{
    providerFileId: '0', path: 'Other/other.mkv', name: 'other.mkv', size: 4096, selected: true,
  }], { authoritative: true, complete: true, observedAt: NOW, expiresAt: UNTIL });
  recordEvidence(store, {
    placement: other, providerFileId: '0', provider: 'torbox', state: 'usable',
    infoHash: 'b'.repeat(40),
  });
  assert.equal(findEvidenceRepairDueTorrentFiles(store, { now: NOW })[0].torrentFileId, tf.id,
    'the dead TorrentFile is still repair-due: another release is not its route');
  store.close();
});

// ── 9. restart between the evidence write and the recovery ────────────────
test('matrix: a restart between the evidence write and the recovery loses nothing', async (t) => {
  const dbPath = tempDbPath(t);
  let tfId = null;
  {
    const store = createControlPlaneStore({ dbPath, now: () => NOW });
    const seeded = seedBound(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
    tfId = seeded.tf.id;
    const torbox = store.findPlacementByInfoHash('torbox', HASH);
    recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });
    store.close();
  }
  {
    // The new process sees the durable work item and repairs it.
    const store = createControlPlaneStore({ dbPath, now: () => NOW });
    const due = findEvidenceRepairDueTorrentFiles(store, { now: NOW });
    assert.deepEqual(due.map((d) => d.torrentFileId), [tfId],
      'the repair is still due after the restart: it follows the evidence, not a timer');
    let repaired = null;
    const ensurer = {
      async ensureSecondPlacementCoalesced({ torrentFileId }) {
        repaired = torrentFileId;
        return { status: 'created', targetProvider: 'realdebrid', apiCalls: 2 };
      },
    };
    const result = await reconcileEvidenceDueRoutes({ store, secondPlacement: ensurer, now: NOW });
    assert.equal(result.repaired, 1);
    assert.equal(repaired, tfId);
    store.close();
  }
});

// ── 10. a stale placement is not a usable route ───────────────────────────
test('matrix: a stale placement is not a usable route, but a proven-dead one is evidence', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  seedBound(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  // The inventory observation expired: the row still looks healthy, but the
  // route is not proven dead either.
  store.db.prepare('UPDATE provider_files SET inventory_expires_at = 1').run();
  assert.deepEqual(findEvidenceRepairDueTorrentFiles(store, { now: NOW }), [],
    'a stale observation is not a death');
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  assert.equal(findEvidenceRepairDueTorrentFiles(store, { now: NOW }).length, 1,
    'the evidence is what makes it a death');
  store.close();
});
