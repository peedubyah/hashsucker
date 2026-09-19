/**
 * Storm-escalation tests: eligibility, backoff, outcome recording.
 * Live provider behavior (discover miss, passive recovery) is proven
 * on live infrastructure; here the decision matrix with stub ensurers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import {
  findEscalationCandidate,
  runCoverageEscalation,
} from '../src/lib/lifecycle/coverage-escalation.js';

const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

function rig() {
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const controlPlaneStore = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  const tf = (id, hash, path = 'M.mkv', size = 100) => controlPlaneStore.db.prepare(
    `INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
     VALUES (?, ?, ?, ?, 1)`).run(id, hash, path, size);
  const lib = (id, mediaId) => controlPlaneStore.db.prepare(
    `INSERT INTO library_items
     (id, identity_key, media_type, media_id, edition_key, title, desired_state, created_at, updated_at)
     VALUES (?, ?, 'movie', ?, 'default', 'T', 'present', 1, 1)`).run(id, `movie:${mediaId}:default`, mediaId);
  const vfs = (mediaId, hash, tfId) => cache.createVfsMovieEntry({
    mediaId, releaseKey: `${hash}:torrent`, infoHash: hash, fileIndex: null,
    canonicalPath: `Movies/${mediaId}/${mediaId}.mkv`, torrentFileId: tfId, size: 100,
    createdAt: 1, updatedAt: 1,
  });
  const place = (provider, state, hash = H, rid = `${provider}-r1`) => controlPlaneStore.recordPlacement({
    provider, accountScope: 'default', infoHash: hash, providerResourceId: rid,
    state, ownership: 'owned', ownerKey: null, provenance: 'test-seed',
    observedAt: 1000, expiresAt: 2000,
  });
  const evidence = (placementId, hash, state, observedAt, ttl = 300000) =>
    controlPlaneStore.recordDeliveryEvidence({
      provider: 'torbox', accountScope: 'default', placementId, providerFileId: 'f',
      infoHash: hash, fileIndexKey: -1, state,
      reason: 'test', failureCategory: 'test', observedAt, expiresAt: observedAt + ttl,
    });
  tf('tf-1', H);
  lib('li-1', 'tt1');
  vfs('tt1', H, 'tf-1');
  const tb = place('torbox', 'ready');
  return { cache, controlPlaneStore, tf, lib, vfs, place, evidence, tbId: tb.id };
}

test('no candidate without fresh pain; dual and unpublished excluded', () => {
  const { cache, controlPlaneStore } = rig();
  assert.equal(findEscalationCandidate({ cache, controlPlaneStore, nowMs: 5000 }), null);
  // Dual-provider: excluded even with pain.
  controlPlaneStore.recordPlacement({
    provider: 'realdebrid', accountScope: 'default', infoHash: H, providerResourceId: 'rd-r1',
    state: 'ready', ownership: 'owned', ownerKey: null, provenance: 'test-seed',
    observedAt: 1000, expiresAt: 2000,
  });
  const tbPid = controlPlaneStore.findPlacementByInfoHash('torbox', H).id;
  controlPlaneStore.recordDeliveryEvidence({
    provider: 'torbox', accountScope: 'default', placementId: tbPid, providerFileId: 'f',
    infoHash: H, fileIndexKey: -1, state: 'temporary',
    reason: 'x', failureCategory: 'y', observedAt: 4000, expiresAt: 4000 + 300000,
  });
  assert.equal(findEscalationCandidate({ cache, controlPlaneStore, nowMs: 5000 }), null);
});

test('fresh pain qualifies; backoff observation blocks re-escalation', async () => {
  const { cache, controlPlaneStore, evidence, tbId } = rig();
  evidence(tbId, H, 'temporary', 4000);
  const c = findEscalationCandidate({ cache, controlPlaneStore, nowMs: 5000 });
  assert.ok(c);
  assert.equal(c.torrentFileId, 'tf-1');
  assert.equal(c.evidenceState, 'temporary');
  let calls = 0;
  const ensurer = {
    ensureSecondPlacement: async () => {
      calls++;
      return { status: 'unavailable', reason: 'not-cached', targetProvider: 'realdebrid' };
    },
  };
  const r = await runCoverageEscalation({ cache, controlPlaneStore, ensurer, nowMs: 5000 });
  assert.ok(r.acted);
  assert.equal(r.status, 'unavailable');
  assert.equal(calls, 1);
  // Backoff recorded: same tick would skip now.
  assert.equal(findEscalationCandidate({ cache, controlPlaneStore, nowMs: 5000 }), null);
});

test('terminal evidence outranks temporary', () => {
  const { cache, controlPlaneStore, tf, lib, vfs, place, evidence, tbId } = rig();
  evidence(tbId, H, 'temporary', 4000);
  tf('tf-2', H2, 'N.mkv', 50);
  lib('li-2', 'tt2');
  vfs('tt2', H2, 'tf-2');
  const p2 = place('torbox', 'ready', H2, 'tb-r2');
  controlPlaneStore.recordDeliveryEvidence({
    provider: 'torbox', accountScope: 'default', placementId: p2.id, providerFileId: 'g',
    infoHash: H2, fileIndexKey: -1, state: 'terminal',
    reason: 'x', failureCategory: 'y', observedAt: 3000, expiresAt: 3000 + 600000,
  });
  const c = findEscalationCandidate({ cache, controlPlaneStore, nowMs: 5000 });
  assert.ok(c);
  assert.equal(c.evidenceState, 'terminal');
});
