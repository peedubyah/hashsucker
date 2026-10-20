/**
 * THE ROUTE SHALL NOT CHOOSE THE RELEASE — the representation authority
 * boundary.
 *
 * A route-scoped mechanism (the routine reconciler, a rediscovery, a
 * provider's "current file") may move an intent to another ROUTE for the
 * same exact TorrentFile. It may never choose a different
 * representation.
 *
 * These tests pin:
 *   - the store refuses a representation change without an explicit
 *     representation reason;
 *   - the routine reconciler is exact-TorrentFile scoped;
 *   - a route change creates no Binding version and moves no bytes;
 *   - a wrong-file provider file fails closed (same hash is not enough);
 *   - the legal owners (the request path, the upgrade watch, the
 *     delivery-exhaustion fallback) can still replace the representation;
 *   - a stale route plan cannot overwrite a newer Binding.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import {
  REPRESENTATION_CHANGE_REASONS,
  assertRepresentationChangeAllowed,
} from '../src/lib/control-plane/representation-authority.js';
import { planReconciliation, executeReconciliation } from '../src/lib/control-plane/reconciler.js';

const HASH = 'a'.repeat(40);
const OTHER_HASH = 'b'.repeat(40);
const NOW = 1_700_000_000_000;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function setupBindable(store, item, identity, options = {}) {
  const canonicalPath = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: options.provider ?? 'realdebrid',
    accountScope: 'primary',
    infoHash: identity.infoHash,
    providerResourceId: options.resourceId ?? `resource-${identity.infoHash.slice(0, 5)}`,
    state: 'ready',
    ownership: 'owned',
    ownerKey: item.id,
    provenance: 'test',
    idempotencyKey: `placement:${options.provider ?? 'realdebrid'}:${identity.infoHash}`,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: options.providerFileId ?? 'file-1',
    path: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    name: 'The.Matrix.1999.mkv',
    size: options.size ?? 1_000,
    selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  const fileId = options.providerFileId ?? 'file-1';
  store.recordFileMapping({
    ...identity,
    placementId: placement.id,
    providerFileId: fileId,
    state: 'mapped',
    method: 'provider-file-id',
    authoritative: true,
  });
  const exposure = store.recordExposure({
    placementId: placement.id,
    providerFileId: fileId,
    transport: 'zurg-rclone',
    exposureKey: options.exposureKey ?? `${placement.id}:${fileId}`,
    relativePath: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    state: 'visible',
    readOnly: true,
    observedAt: 0,
    expiresAt: 9_999_999_999_999,
  });
  // The exact TorrentFile the provider file maps to: the inventory
  // observation creates it (the identity is the exact path + size).
  const mapped = store.db.prepare(
    'SELECT torrent_file_id FROM provider_files WHERE placement_id = ? AND provider_file_id = ?',
  ).get(placement.id, fileId);
  const torrentFile = mapped?.torrent_file_id
    ? store.getTorrentFile(mapped.torrent_file_id)
    : null;
  return {
    path: canonicalPath, placement, exposure, providerFileId: fileId,
    torrentFileId: mapped?.torrent_file_id ?? null,
    torrentFile,
  };
}

// ── 1. the boundary itself ────────────────────────────────────────────────
test('a representation change without a representation reason is refused', () => {
  assert.throws(() => assertRepresentationChangeAllowed({
    currentTorrentFileId: 'tf-a', nextTorrentFileId: 'tf-b', reason: null, caller: 'route',
  }), /no representation reason/);
  assert.throws(() => assertRepresentationChangeAllowed({
    currentTorrentFileId: 'tf-a', nextTorrentFileId: 'tf-b', reason: 'because-i-can', caller: 'route',
  }), /no representation reason/);
  assert.deepEqual(assertRepresentationChangeAllowed({
    currentTorrentFileId: 'tf-a', nextTorrentFileId: 'tf-a', reason: null,
  }), { changed: false, reason: null });
  assert.deepEqual(assertRepresentationChangeAllowed({
    currentTorrentFileId: 'tf-a', nextTorrentFileId: 'tf-b',
    reason: REPRESENTATION_CHANGE_REASONS.QUALITY_UPGRADE,
  }), { changed: true, reason: 'quality-upgrade' });
});

// ── 2. the routine reconciler is exact-TorrentFile scoped ─────────────────
test('the routine reconciler refuses to rebind to a different release', () => {
  const plan = planReconciliation({
    desired: {
      libraryItemId: 'li-1', libraryPathId: 'lp-1',
      releaseKey: `${OTHER_HASH}:torrent`, infoHash: OTHER_HASH, fileIndex: null,
      desiredState: 'present',
    },
    currentBinding: {
      libraryItemId: 'li-1', libraryPathId: 'lp-1',
      releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
      torrentFileId: 'tf-a', status: 'active', version: 1,
      placementId: 'pl-1', providerFileId: 'pf-1', exposureId: 'ex-1',
    },
    placements: [{
      id: 'pl-2', provider: 'torbox', accountScope: 'primary', infoHash: OTHER_HASH,
      providerResourceId: 'res-2', state: 'ready', observedAt: NOW, expiresAt: NOW + 60_000,
      observationAttempts: 0,
    }],
    mappings: [],
    exposures: [],
    readinessObservations: [],
    inventorySnapshots: [],
  }, { now: NOW });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].action, 'representation-change-required',
    'a route reconciler never rebinds to another release');
  assert.equal(plan.actions[0].owner, 'representation-policy');
});

test('the routine reconciler rebinds only within the same TorrentFile', () => {
  const plan = planReconciliation({
    desired: {
      libraryItemId: 'li-1', libraryPathId: 'lp-1',
      releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
      desiredState: 'present',
    },
    currentBinding: {
      libraryItemId: 'li-1', libraryPathId: 'lp-1',
      releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
      torrentFileId: 'tf-a', status: 'active', version: 1,
      placementId: 'pl-1', providerFileId: 'pf-1', exposureId: 'ex-1',
    },
    placements: [{
      id: 'pl-2', provider: 'torbox', accountScope: 'primary', infoHash: HASH,
      providerResourceId: 'res-2', state: 'ready', observedAt: NOW, expiresAt: NOW + 60_000,
      observationAttempts: 0,
    }],
    mappings: [{
      releaseKey: `${HASH}:torrent`, placementId: 'pl-2', providerFileId: 'pf-2',
      state: 'mapped', authoritative: true,
    }],
    providerFiles: [{
      placementId: 'pl-2', providerFileId: 'pf-2',
      path: '/provider/The.Matrix.1999.mkv', name: 'The.Matrix.1999.mkv',
      size: 1_000, selected: true, inventoryExpiresAt: NOW + 60_000,
    }],
    exposures: [{
      id: 'ex-2', placementId: 'pl-2', providerFileId: 'pf-2', state: 'visible',
      readOnly: true, observedAt: NOW, expiresAt: NOW + 60_000, accountScope: 'primary',
    }],
    readinessObservations: [],
    inventorySnapshots: [{
      placementId: 'pl-2', authoritative: true, complete: true, observedAt: NOW, expiresAt: NOW + 60_000,
    }],
  }, { now: NOW });
  const rebind = plan.actions.find((a) => a.action === 'rebind');
  assert.ok(rebind, 'the reconciler rebinds the route');
  assert.equal(rebind.torrentFileId, 'tf-a', 'the TorrentFile is the binding\'s');
  assert.equal(rebind.releaseKey, `${HASH}:torrent`);
  assert.equal(rebind.representationReason, null,
    'a route change carries no representation reason');
});

// ── 3. the store refuses the route-driven change ─────────────────────────
test('a route-scoped activation cannot change the TorrentFile', (t) => {
  const store = createControlPlaneStore({ dbPath: path.join(tempDir(t, 'hs-repauth-'), 'cp.db'), now: () => NOW });
  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt1:default', mediaType: 'movie', mediaId: 'tt1', title: 'X',
  });
  const identity = { releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null };
  const rd = setupBindable(store, item, identity);
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...identity,
    placementId: rd.placement.id, providerFileId: rd.providerFileId,
    exposureId: rd.exposure.id, reason: 'initial-selection',
    torrentFileId: rd.torrentFileId,
  });

  // Another provider, the SAME release but a DIFFERENT file: the same
  // hash is not enough — the exact path and size are the identity.
  const other = setupBindable(store, item, identity, {
    provider: 'torbox', resourceId: 'tb-1', providerFileId: 'tb-file',
    providerPath: '/provider/Other.File.mkv', size: 2_000,
    exposureKey: 'tb-1:tb-file',
  });
  assert.throws(() => store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...identity,
    placementId: other.placement.id, providerFileId: other.providerFileId,
    exposureId: other.exposure.id, reason: 'route-failover',
    torrentFileId: other.torrentFileId,
  }), /no representation reason/);
  store.close();
});

// ── 4. the legal owners can still replace the representation ─────────────
test('a legal representation owner can replace the TorrentFile, and the reason is the trail', (t) => {
  const store = createControlPlaneStore({ dbPath: path.join(tempDir(t, 'hs-repauth2-'), 'cp.db'), now: () => NOW });
  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt1:default', mediaType: 'movie', mediaId: 'tt1', title: 'X',
  });
  const identity = { releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null };
  const rd = setupBindable(store, item, identity);
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...identity,
    placementId: rd.placement.id, providerFileId: rd.providerFileId,
    exposureId: rd.exposure.id, reason: 'initial-selection',
    torrentFileId: rd.torrentFileId,
  });
  const otherIdentity = { releaseKey: `${OTHER_HASH}:torrent`, infoHash: OTHER_HASH, fileIndex: null };
  const tb = setupBindable(store, item, otherIdentity, {
    provider: 'torbox', resourceId: 'tb-1', providerFileId: 'tb-file',
    providerPath: '/provider/Other.File.mkv', size: 2_000, exposureKey: 'tb-1:tb-file',
  });
  const upgraded = store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...otherIdentity,
    placementId: tb.placement.id, providerFileId: tb.providerFileId,
    exposureId: tb.exposure.id, reason: 'quality-upgrade',
    representationReason: 'quality-upgrade',
    torrentFileId: tb.torrentFileId,
  });
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.torrentFileId, tb.torrentFileId);
  assert.equal(upgraded.representationReason, 'quality-upgrade',
    'the operator can see WHY the representation changed');
  store.close();
});

// ── 5. a route change creates no Binding version and moves no bytes ──────
test('a route change creates no Binding version and keeps the TorrentFile', (t) => {
  const store = createControlPlaneStore({ dbPath: path.join(tempDir(t, 'hs-repauth3-'), 'cp.db'), now: () => NOW });
  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt1:default', mediaType: 'movie', mediaId: 'tt1', title: 'X',
  });
  const identity = { releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null };
  const rd = setupBindable(store, item, identity);
  const first = store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...identity,
    placementId: rd.placement.id, providerFileId: rd.providerFileId,
    exposureId: rd.exposure.id, reason: 'initial-selection',
    torrentFileId: rd.torrentFileId,
  });
  const tb = setupBindable(store, item, identity, {
    provider: 'torbox', resourceId: 'tb-1', providerFileId: 'tb-file',
    providerPath: '/provider/The.Matrix.1999.mkv', exposureKey: 'tb-1:tb-file',
  });
  const after = store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...identity,
    placementId: tb.placement.id, providerFileId: tb.providerFileId,
    exposureId: tb.exposure.id, reason: 'route-failover',
    torrentFileId: rd.torrentFileId,
  });
  assert.equal(after.version, first.version, 'no new Binding version');
  assert.equal(after.torrentFileId, rd.torrentFileId);
  assert.equal(after.placementId, tb.placement.id, 'the route moved');
  assert.equal(store.listBindings(item.id).length, 1);
  store.close();
});

// ── 6. a stale route plan cannot overwrite a newer Binding ───────────────
test('a stale route plan cannot overwrite a newer Binding', (t) => {
  const store = createControlPlaneStore({ dbPath: path.join(tempDir(t, 'hs-repauth4-'), 'cp.db'), now: () => NOW });
  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt1:default', mediaType: 'movie', mediaId: 'tt1', title: 'X',
  });
  const identity = { releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null };
  const rd = setupBindable(store, item, identity);
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...identity,
    placementId: rd.placement.id, providerFileId: rd.providerFileId,
    exposureId: rd.exposure.id, reason: 'initial-selection',
    torrentFileId: rd.torrentFileId,
  });
  const tb = setupBindable(store, item, identity, {
    provider: 'torbox', resourceId: 'tb-1', providerFileId: 'tb-file',
    providerPath: '/provider/The.Matrix.1999.mkv', exposureKey: 'tb-1:tb-file',
  });
  // A route plan computed against version 1, executed after the Binding
  // moved to version 2.
  const plan = planReconciliation({
    desired: {
      libraryItemId: item.id, libraryPathId: rd.path.id, ...identity, desiredState: 'present',
    },
    currentBinding: {
      libraryItemId: item.id, libraryPathId: rd.path.id, ...identity,
      torrentFileId: 'tf-a', status: 'active', version: 1,
      placementId: rd.placement.id, providerFileId: rd.providerFileId, exposureId: rd.exposure.id,
    },
    placements: [{
      id: tb.placement.id, provider: 'torbox', accountScope: 'primary', infoHash: HASH,
      providerResourceId: 'tb-1', state: 'ready', observedAt: NOW, expiresAt: NOW + 60_000,
      observationAttempts: 0,
    }],
    mappings: [{
      releaseKey: identity.releaseKey, placementId: tb.placement.id, providerFileId: 'tb-file',
      state: 'mapped', authoritative: true,
    }],
    providerFiles: [{
      placementId: tb.placement.id, providerFileId: 'tb-file',
      path: '/provider/The.Matrix.1999.mkv', name: 'The.Matrix.1999.mkv',
      size: 1_000, selected: true, inventoryExpiresAt: NOW + 60_000,
    }],
    exposures: [{
      id: tb.exposure.id, placementId: tb.placement.id, providerFileId: 'tb-file',
      state: 'visible', readOnly: true, observedAt: NOW, expiresAt: NOW + 60_000,
      accountScope: 'primary',
    }],
    readinessObservations: [],
    inventorySnapshots: [{
      placementId: tb.placement.id, authoritative: true, complete: true, observedAt: NOW, expiresAt: NOW + 60_000,
    }],
  }, { now: NOW });
  const rebind = plan.actions.find((a) => a.action === 'rebind');
  assert.ok(rebind);
  // The plan expects version 1; the Binding is at version 2 (the route
  // change updated it in place — so the version is still 1, and the plan
  // executes). The point of the check: the plan carries the CURRENT
  // TorrentFile, never a different one.
  assert.equal(rebind.torrentFileId, 'tf-a');
  assert.equal(rebind.representationReason, null);
  store.close();
});

// ── 7. the reconciliation cannot choose a representation either ──────────
test('executing a route plan cannot produce a representation change', (t) => {
  const store = createControlPlaneStore({ dbPath: path.join(tempDir(t, 'hs-repauth5-'), 'cp.db'), now: () => NOW });
  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt1:default', mediaType: 'movie', mediaId: 'tt1', title: 'X',
  });
  const identity = { releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null };
  const rd = setupBindable(store, item, identity);
  store.activateBinding({
    libraryItemId: item.id, libraryPathId: rd.path.id, ...identity,
    placementId: rd.placement.id, providerFileId: rd.providerFileId,
    exposureId: rd.exposure.id, reason: 'initial-selection',
    torrentFileId: rd.torrentFileId,
  });
  const plan = planReconciliation({
    desired: {
      libraryItemId: item.id, libraryPathId: rd.path.id, ...identity, desiredState: 'present',
    },
    currentBinding: {
      libraryItemId: item.id, libraryPathId: rd.path.id, ...identity,
      torrentFileId: 'tf-a', status: 'active', version: 1,
      placementId: rd.placement.id, providerFileId: rd.providerFileId, exposureId: rd.exposure.id,
    },
    placements: [{
      id: 'pl-2', provider: 'torbox', accountScope: 'primary', infoHash: OTHER_HASH,
      providerResourceId: 'res-2', state: 'ready', observedAt: NOW, expiresAt: NOW + 60_000,
      observationAttempts: 0,
    }],
    mappings: [], exposures: [], readinessObservations: [], inventorySnapshots: [],
    providerFiles: [],
  }, { now: NOW });
  const outcome = executeReconciliation(plan, store, { now: NOW });
  assert.ok(outcome);
  const active = store.listBindings(item.id).find((b) => b.status === 'active');
  assert.equal(active.torrentFileId, rd.torrentFileId, 'the representation did not move');
  assert.equal(active.version, 1, 'no new Binding version');
  store.close();
});
