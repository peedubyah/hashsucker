/**
 * ONE view of routes: the classification every route decision must use.
 *
 * These tests pin the semantics that the old code got wrong:
 *   - a TERMINALLY DEAD route is not redundancy (it is a dead route);
 *   - the provider that lost its route is the one that needs a new one;
 *   - "unknown" is not "dead" and "temporarily unavailable" is not "dead";
 *   - a fresh provider inventory supersedes a terminal delivery verdict;
 *   - a negative discovery is complete only when EVERY candidate account
 *     was searched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import {
  classifyRoutesForTorrentFile,
  providersNeedingRoute,
  ROUTE_STATES,
} from '../src/lib/control-plane/route-classification.js';
import { createSecondPlacementEnsurer } from '../src/lib/control-plane/second-placement.js';
import { createRepresentationPolicy, REPRESENTATION_POLICY_REASONS } from '../src/lib/vfs/representation-policy.js';

const HASH = 'b'.repeat(40);
const OTHER_HASH = 'c'.repeat(40);
const INTERNAL = 'Movie/movie.mkv';
const NOW = 1_000_000;
const UNTIL = 9_000_000_000;

function tempDbPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-route-class-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return path.join(dir, 'control-plane.db');
}

/** A TorrentFile with one mapped route per provider. */
function seedRoutes(store, { routes, infoHash = HASH } = {}) {
  let tf = null;
  routes.forEach((route, index) => {
    const placement = store.recordPlacement({
      provider: route.provider,
      accountScope: 'default',
      infoHash,
      providerResourceId: route.resourceId,
      state: route.state ?? 'ready',
      ownership: 'owned',
      ownerKey: 'owner',
      provenance: 'route-classification-test',
      observedAt: NOW,
      expiresAt: UNTIL,
    });
    store.replaceProviderFileInventory(placement.id, [{
      providerFileId: route.providerFileId ?? String(index),
      path: INTERNAL,
      name: 'movie.mkv',
      size: 4096,
      selected: true,
    }], { authoritative: true, complete: true, observedAt: NOW, expiresAt: UNTIL });
    tf = store.findTorrentFile(infoHash, INTERNAL);
    store.db.prepare(`
      UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
      inventory_observed_at = ?, inventory_expires_at = ?
      WHERE placement_id = ? AND provider_file_id = ?
    `).run(tf.id, NOW, UNTIL, placement.id, route.providerFileId ?? String(index));
  });
  return tf;
}

function recordEvidence(store, { placement, providerFileId, provider, state, observedAt = NOW, expiresAt = UNTIL, infoHash = HASH }) {
  store.recordDeliveryEvidence({
    provider,
    accountScope: 'default',
    placementId: placement.id,
    providerFileId,
    infoHash,
    fileIndexKey: -1,
    state,
    reason: 'classification-test',
    failureCategory: state === 'terminal' ? 'route-terminal' : null,
    observedAt,
    expiresAt,
  });
}

// ── 1. a dead route is dead, an unobserved route is not ─────────────────────
test('classification: a terminal route is dead; an unobserved route is not', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, {
    routes: [{ provider: 'torbox', resourceId: 'tb-1' }, { provider: 'realdebrid', resourceId: 'rd-1' }],
  });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });

  const view = classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW });
  assert.equal(view.byProvider.torbox.state, ROUTE_STATES.DEAD, 'the terminal route is dead');
  assert.equal(view.byProvider.realdebrid.state, ROUTE_STATES.RETRYABLE,
    'an unobserved route is not dead: it may still work');
  assert.equal(view.dead.length, 1);
  assert.equal(view.allRoutesDead, false, 'a live route remains');
  assert.deepEqual(providersNeedingRoute(view), ['torbox'],
    'the provider that LOST its route needs a new one');
});

// ── 2. an expired terminal verdict stops being a verdict ───────────────────
test('classification: an expired terminal verdict is not a dead route', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, {
    placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal',
    observedAt: NOW - 10_000, expiresAt: NOW - 1,
  });
  const view = classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW });
  assert.equal(view.byProvider.torbox.state, ROUTE_STATES.RETRYABLE,
    'the verdict expired: the route is unknown again, not dead');
  assert.ok(!providersNeedingRoute(view).includes('torbox'),
    'the expired verdict is not a lost route: nothing to repair');
});

// ── 3. a temporary verdict is not a death ──────────────────────────────────
test('classification: a temporary verdict is retryable, not dead', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'temporary' });
  const view = classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW });
  assert.equal(view.byProvider.torbox.state, ROUTE_STATES.RETRYABLE);
  assert.ok(!providersNeedingRoute(view).includes('torbox'), 'a throttle is not a lost route');
});

// ── 4. the ensurer targets the provider that LOST its route ────────────────
test('ensurer: a dead route makes its own provider the repair target', async (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, {
    routes: [{ provider: 'torbox', resourceId: 'tb-1' }, { provider: 'realdebrid', resourceId: 'rd-1' }],
  });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });

  const calls = { tbInventory: 0, tbLookup: 0, tbCheck: 0, tbCreate: 0, rdList: 0, rdInfo: 0, rdAdd: 0 };
  const tb = {
    // The dead route is re-observed: the provider says the resource is
    // gone.
    async getFileInventory() {
      calls.tbInventory += 1;
      const error = new Error('TorBox resource 1 is absent');
      error.category = 'not-found';
      throw error;
    },
    async lookupPlacement() { calls.tbLookup += 1; return null; },
    async checkCached() { calls.tbCheck += 1; return { cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() }; },
    async createPlacement() { calls.tbCreate += 1; return { providerResourceId: 'TB-NEW' }; },
  };
  const rd = {
    async listTorrents() { calls.rdList += 1; return []; },
    async getTorrentInfo() { calls.rdInfo += 1; return { id: 'RD0', status: 'waiting_files_selection', files: [] }; },
    async addMagnet() { calls.rdAdd += 1; return { id: 'RD9' }; },
  };
  const ensurer = createSecondPlacementEnsurer({ store, torbox: tb, realdebrid: rd, now: () => NOW });
  const outcome = await ensurer.ensureSecondPlacement({ torrentFileId: tf.id, discoverOnly: true });

  assert.equal(calls.tbInventory, 1, 'the DEAD provider is the one that is asked about its route');
  assert.equal(calls.tbCheck, 1, 'and whether it has the release cached at all');
  assert.equal(calls.rdList, 0, 'the healthy provider is not disturbed');
  assert.equal(calls.rdAdd, 0, 'never manufacture an uncached download');
  assert.equal(outcome.targetProvider, 'torbox');
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.negativeComplete, true,
    'the negative covers every candidate account (only one was needed)');
});

// ── 5. a negative is complete only when EVERY candidate was searched ───────
test('ensurer: a negative that skipped an account is not a complete negative', async (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });

  const tb = {
    async getFileInventory() {
      const error = new Error('TorBox resource 1 is absent');
      error.category = 'not-found';
      throw error;
    },
    async lookupPlacement() { return null; },
    async checkCached() { return { cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() }; },
    async createPlacement() { return { providerResourceId: 'TB-NEW' }; },
  };
  // No Real-Debrid client: the RD account was never searched.
  const ensurer = createSecondPlacementEnsurer({ store, torbox: tb, realdebrid: null, now: () => NOW });
  const outcome = await ensurer.ensureSecondPlacement({ torrentFileId: tf.id, discoverOnly: true });
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.negativeComplete, false,
    'one account was never searched: the negative is not complete');
});

// ── 6. the byte path is not offered a proven-dead route ─────────────────────
test('the byte path is not offered a route with a fresh terminal verdict', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, {
    routes: [{ provider: 'torbox', resourceId: 'tb-1' }, { provider: 'realdebrid', resourceId: 'rd-1' }],
  });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });

  const offered = store.listDataPlaneCoordinates(tf.id);
  assert.deepEqual(offered.map((c) => c.provider), ['realdebrid'],
    'the dead route is not offered to the byte path');
  assert.ok(store.findPlacementByInfoHash('torbox', HASH),
    'the placement row is kept: the record is history, not a licence to serve');
});

// ── 7. a fresh inventory supersedes a terminal verdict ─────────────────────
test('a fresh provider inventory supersedes the terminal verdict of that route', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });
  assert.equal(
    classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW }).byProvider.torbox.state,
    ROUTE_STATES.DEAD,
  );

  // The provider is asked again and still lists the file: the newer
  // observation supersedes the older "gone".
  store.replaceProviderFileInventory(torbox.id, [{
    providerFileId: '0', path: INTERNAL, name: 'movie.mkv', size: 4096, selected: true,
  }], { authoritative: true, complete: true, observedAt: NOW + 1000, expiresAt: UNTIL });

  const view = classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW + 1000 });
  assert.equal(view.byProvider.torbox.state, ROUTE_STATES.SERVICEABLE,
    'the newer observation wins');
  assert.ok(!providersNeedingRoute(view).includes('torbox'), 'nothing to repair');
});

// ── 8. a replaced resource id is a NEW route; the dead one stays dead ─────
test('a replaced resource id is a new route and the dead route stays dead', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, { routes: [{ provider: 'torbox', resourceId: 'tb-old' }] });
  const old = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: old, providerFileId: '0', provider: 'torbox', state: 'terminal' });

  // The provider re-created the release under a new resource id.
  const fresh = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH,
    providerResourceId: 'tb-new', state: 'ready', ownership: 'owned', ownerKey: 'owner',
    provenance: 'route-classification-test', observedAt: NOW + 1000, expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(fresh.id, [{
    providerFileId: '9', path: INTERNAL, name: 'movie.mkv', size: 4096, selected: true,
  }], { authoritative: true, complete: true, observedAt: NOW + 1000, expiresAt: UNTIL });
  const tf2 = store.findTorrentFile(HASH, INTERNAL);
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped'
    WHERE placement_id = ? AND provider_file_id = '9'
  `).run(tf2.id, fresh.id);

  const view = classifyRoutesForTorrentFile(store, { torrentFileId: tf2.id, now: NOW + 1000 });
  assert.equal(view.routes.length, 2, 'the dead route and its replacement are two routes');
  const deadRoute = view.routes.find((r) => r.providerResourceId === 'tb-old');
  const newRoute = view.routes.find((r) => r.providerResourceId === 'tb-new');
  assert.equal(deadRoute.state, ROUTE_STATES.DEAD, 'the dead route stays dead: it is history');
  assert.notEqual(newRoute.state, ROUTE_STATES.DEAD, 'the replacement is a fresh route');
  assert.equal(view.byProvider.torbox.state, ROUTE_STATES.RETRYABLE,
    'the provider view is the BEST of its routes');
});

// ── 9. a dead route that is still listed is re-observed and restored ──────
test('a dead route that is still listed is re-observed, not replaced', async (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, { routes: [{ provider: 'torbox', resourceId: 'tb-1' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });

  // The provider still lists the resource: the route is alive and the
  // terminal verdict was wrong (or the resource came back).
  const tb = {
    async getFileInventory() {
      return { files: [{ providerFileId: '0', path: INTERNAL, name: 'movie.mkv', size: 4096, selected: true }] };
    },
    async lookupPlacement() { throw new Error('the account must not be read for a live route'); },
    async checkCached() { throw new Error('the account must not be read for a live route'); },
    async createPlacement() { throw new Error('nothing may be created'); },
  };
  const ensurer = createSecondPlacementEnsurer({ store, torbox: tb, realdebrid: null, now: () => NOW });
  const outcome = await ensurer.ensureSecondPlacement({ torrentFileId: tf.id, discoverOnly: true });
  assert.equal(outcome.status, 'created');
  assert.equal(outcome.idSource, 're-observed');
  const view = classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW + 1 });
  assert.equal(view.byProvider.torbox.state, ROUTE_STATES.SERVICEABLE,
    'the fresh observation superseded the terminal verdict');
});

// ── 10. a replacement resource id is a new route ──────────────────────────
test('a replacement resource id becomes a new route', async (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, { routes: [{ provider: 'torbox', resourceId: 'tb-dead' }] });
  const torbox = store.findPlacementByInfoHash('torbox', HASH);
  recordEvidence(store, { placement: torbox, providerFileId: '0', provider: 'torbox', state: 'terminal' });

  const tb = {
    async getFileInventory({ providerResourceId }) {
      if (providerResourceId === 'tb-dead') {
        const error = new Error('TorBox resource tb-dead is absent');
        error.category = 'not-found';
        throw error;
      }
      return { files: [{ providerFileId: '9', path: INTERNAL, name: 'movie.mkv', size: 4096, selected: true }] };
    },
    async listPlacements() { return [{ providerResourceId: 'tb-new', state: 'cached' }]; },
    async checkCached() { return { cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() }; },
    async createPlacement() { throw new Error('nothing may be created'); },
  };
  const ensurer = createSecondPlacementEnsurer({ store, torbox: tb, realdebrid: null, now: () => NOW });
  const outcome = await ensurer.ensureSecondPlacement({ torrentFileId: tf.id, discoverOnly: true });
  assert.equal(outcome.status, 'created');
  assert.equal(outcome.idSource, 'recovered');
  assert.equal(outcome.placementId != torbox.id, true, 'the replacement is a NEW route');

  const view = classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW + 1 });
  const dead = view.routes.find((r) => r.providerResourceId === 'tb-dead');
  const fresh = view.routes.find((r) => r.providerResourceId === 'tb-new');
  assert.equal(dead.state, ROUTE_STATES.DEAD, 'the dead route is history');
  assert.notEqual(fresh.state, ROUTE_STATES.DEAD, 'the replacement is live');
});

// ── 11. the policy needs a complete negative, not a partial one ─────────────
test('representation policy: a partial negative cannot authorize a switch', () => {
  const policy = createRepresentationPolicy({ now: () => NOW });
  const routes = [{ kind: 'terminal' }];
  const evidence = { recorded: 1, terminal: 1, temporary: 0, skipped: 0 };
  assert.equal(policy.decide({
    mediaId: 'm1', routes, evidence,
    discovery: { completed: true, status: 'unavailable' },
  }).allow, true, 'a complete negative may authorize the switch');

  assert.equal(policy.decide({
    mediaId: 'm2', routes, evidence,
    discovery: { completed: false, status: 'unavailable' },
  }).reason, REPRESENTATION_POLICY_REASONS.ROUTE_SET_NOT_PROVEN,
  'an incomplete negative may not authorize the switch');
});
