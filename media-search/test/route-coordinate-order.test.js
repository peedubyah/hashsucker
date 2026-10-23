/**
 * Route-coordinate attempt order: the byte path is offered routes with
 * FRESH USABLE evidence first.
 *
 * Context: on dual-route files the acquisition tried RealDebrid first
 * (provider-ASC order) and paid ~540 ms of dead-route tax (RD
 * /unrestrict/link 403) before TorBox succeeded — even when TorBox had
 * just delivered bytes for the same exact TorrentFile. The order ignored
 * the positive evidence the system already held.
 *
 * These tests pin that ORDER is an attempt preference driven by existing
 * evidence, not eligibility:
 *   - a route with fresh usable evidence sorts before an unobserved one;
 *   - with no usable evidence the order is exactly as before (provider ASC);
 *   - a fresh terminal route is still excluded, not merely demoted;
 *   - an expired usable verdict stops preferring (freshness bounds it);
 *   - the preference is provider-agnostic (whichever route proved itself).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

const HASH = 'd'.repeat(40);
const INTERNAL = 'Movie/movie.mkv';
const NOW = 2_000_000;
const UNTIL = 9_000_000_000;

function tempDbPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-route-order-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return path.join(dir, 'control-plane.db');
}

/** A TorrentFile with one mapped route per listed provider (RD first by ASC). */
function seedRoutes(store, { providers = ['realdebrid', 'torbox'], infoHash = HASH } = {}) {
  let tf = null;
  providers.forEach((provider, index) => {
    const placement = store.recordPlacement({
      provider,
      accountScope: 'default',
      infoHash,
      providerResourceId: `${provider}-res-1`,
      state: 'ready',
      ownership: 'owned',
      ownerKey: 'owner',
      provenance: 'route-order-test',
      observedAt: NOW,
      expiresAt: UNTIL,
    });
    store.replaceProviderFileInventory(placement.id, [{
      providerFileId: String(index),
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
    `).run(tf.id, NOW, UNTIL, placement.id, String(index));
  });
  return tf;
}

function recordEvidence(store, { provider, providerFileId, state, observedAt = NOW, expiresAt = UNTIL, infoHash = HASH }) {
  const placement = store.findPlacementByInfoHash(provider, infoHash);
  store.recordDeliveryEvidence({
    provider,
    accountScope: 'default',
    placementId: placement.id,
    providerFileId,
    infoHash,
    fileIndexKey: -1,
    state,
    reason: 'route-order-test',
    failureCategory: state === 'terminal' ? 'route-terminal' : null,
    observedAt,
    expiresAt,
  });
}

function providersOf(store, tfId) {
  return store.listDataPlaneCoordinates(tfId).map((c) => c.provider);
}

// ── H5 negative control: no evidence → order exactly as before ─────────────
test('coordinate order: with no evidence the order is unchanged (provider ASC)', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, {});
  assert.deepEqual(providersOf(store, tf.id), ['realdebrid', 'torbox'],
    'unknown routes keep the historical order; nothing is pruned or preferred');
});

// ── H1: fresh usable evidence sorts first ───────────────────────────────────
test('coordinate order: a route with fresh usable evidence is offered first', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, {});
  // TorBox is provider_file_id '1' in seed order (realdebrid='0').
  recordEvidence(store, { provider: 'torbox', providerFileId: '1', state: 'usable' });
  assert.deepEqual(providersOf(store, tf.id), ['torbox', 'realdebrid'],
    'the proven route is attempted first; the unknown route stays eligible second');
});

// ── preference is provider-agnostic ─────────────────────────────────────────
test('coordinate order: whichever route proved itself sorts first', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, {});
  recordEvidence(store, { provider: 'realdebrid', providerFileId: '0', state: 'usable' });
  assert.deepEqual(providersOf(store, tf.id), ['realdebrid', 'torbox'],
    'a proven RealDebrid route is preferred too — no global provider bias');
});

// ── freshness bounds the preference ─────────────────────────────────────────
test('coordinate order: an expired usable verdict stops preferring', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, {});
  recordEvidence(store, {
    provider: 'torbox', providerFileId: '1', state: 'usable',
    observedAt: NOW - 60_000, expiresAt: NOW - 1_000,
  });
  assert.deepEqual(providersOf(store, tf.id), ['realdebrid', 'torbox'],
    'an expired verdict is not a licence to prefer forever');
});

// ── terminal exclusion is unchanged ─────────────────────────────────────────
test('coordinate order: a fresh terminal route is excluded, not demoted', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, {});
  recordEvidence(store, { provider: 'realdebrid', providerFileId: '0', state: 'terminal' });
  assert.deepEqual(providersOf(store, tf.id), ['torbox'],
    'a proven-dead route is not offered at all');
});

// ── H8: all routes dead still fails closed at the set level ─────────────────
test('coordinate order: all routes terminal offers nothing', (t) => {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const tf = seedRoutes(store, {});
  recordEvidence(store, { provider: 'realdebrid', providerFileId: '0', state: 'terminal' });
  recordEvidence(store, { provider: 'torbox', providerFileId: '1', state: 'terminal' });
  assert.deepEqual(providersOf(store, tf.id), [],
    'an exhausted route set stays empty — the caller fails closed');
});
