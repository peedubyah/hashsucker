/**
 * Durable route failure authority.
 *
 * When the authoritative byte path proves a provider route dead, that fact
 * must survive a restart, drive recovery from the failure event, and never
 * be mistaken for a reason to replace the authoritative representation
 * unless the evidence says so (and the budget allows it).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createRouteFailureRecorder } from '../src/lib/vfs/route-failure-evidence.js';
import { createRepresentationPolicy, REPRESENTATION_POLICY_REASONS } from '../src/lib/vfs/representation-policy.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

function tempDbPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-route-failure-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return path.join(dir, 'control-plane.db');
}

function seedPlacement(store, { provider = 'torbox', accountScope = 'default', providerResourceId = 'TB-1', providerFileId = 'pf-1' } = {}) {
  const placement = store.recordPlacement({
    provider, accountScope, infoHash: HASH,
    providerResourceId, state: 'ready', ownership: 'owned',
    ownerKey: 'test', provenance: 'test',
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId, path: 'Movie.mkv', name: 'Movie.mkv', size: 4096, selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9e12 });
  return placement;
}

/** A minimal evidence store over the control plane (the production shape). */
function evidenceStoreFor(store) {
  return {
    recordTerminal: (input) => store.recordDeliveryEvidence({ ...input, state: 'terminal', observedAt: input.observedAt ?? Date.now(), expiresAt: input.expiresAt ?? (input.observedAt ?? Date.now()) + 600_000 }),
    recordTemporary: (input) => store.recordDeliveryEvidence({ ...input, state: 'temporary', observedAt: input.observedAt ?? Date.now(), expiresAt: input.expiresAt ?? (input.observedAt ?? Date.now()) + 600_000 }),
    recordUsable: (input) => store.recordDeliveryEvidence({ ...input, state: 'usable', observedAt: input.observedAt ?? Date.now(), expiresAt: input.expiresAt ?? (input.observedAt ?? Date.now()) + 600_000 }),
    listForCoordinate: ({ infoHash, fileIndexKey }) => store.listDeliveryEvidenceForHash(infoHash, fileIndexKey ?? -1)
      .map((row) => ({ ...row, providerResourceId: null })),
  };
}

test('a provably dead route is recorded durably and survives a restart', (t) => {
  const dbPath = tempDbPath(t);
  {
    const store = createControlPlaneStore({ dbPath });
    const placement = seedPlacement(store, { providerResourceId: 'TB-DEAD' });
    const recorder = createRouteFailureRecorder({ controlPlaneStore: store, evidenceStore: evidenceStoreFor(store) });
    const summary = recorder.recordRouteFailures({
      routes: [{
        provider: 'torbox', accountScope: 'default',
        providerResourceId: 'TB-DEAD', providerFileId: 'pf-1',
        kind: 'terminal', detail: 'torbox requestdl status 404',
      }],
      infoHash: HASH,
    });
    assert.equal(summary.terminal, 1);
    assert.equal(summary.temporary, 0);
    const rows = store.db.prepare('SELECT state, failure_category, reason FROM provider_delivery_evidence').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'terminal', 'a 404 is death');
    assert.equal(rows[0].failure_category, 'route-terminal');
    assert.equal(placement.id, placement.id);
    store.close();
  }
  {
    // Restart: the route death must still be known.
    const store = createControlPlaneStore({ dbPath });
    const rows = store.db.prepare('SELECT state FROM provider_delivery_evidence').all();
    assert.equal(rows.length, 1, 'the route death survives the restart');
    assert.equal(rows[0].state, 'terminal');
    store.close();
  }
});

test('a throttled or timed-out route is NEVER recorded as death', (t) => {
  const dbPath = tempDbPath(t);
  const store = createControlPlaneStore({ dbPath });
  seedPlacement(store, { providerResourceId: 'TB-SLOW' });
  const recorder = createRouteFailureRecorder({ controlPlaneStore: store, evidenceStore: evidenceStoreFor(store) });
  const summary = recorder.recordRouteFailures({
    routes: [
      { provider: 'torbox', accountScope: 'default', providerResourceId: 'TB-SLOW', providerFileId: 'pf-1', kind: 'temporary', detail: 'rate-limited' },
      { provider: 'torbox', accountScope: 'default', providerResourceId: 'TB-SLOW', providerFileId: 'pf-1', kind: 'temporary', detail: 'transient: timeout' },
    ],
    infoHash: HASH,
  });
  assert.equal(summary.temporary, 2);
  assert.equal(summary.terminal, 0);
  const rows = store.db.prepare('SELECT state FROM provider_delivery_evidence').all();
  assert.ok(rows.every((row) => row.state === 'temporary'), 'throttling is never death');
  store.close();
});

test('a route that is not in the durable index records nothing', (t) => {
  const dbPath = tempDbPath(t);
  const store = createControlPlaneStore({ dbPath });
  const recorder = createRouteFailureRecorder({ controlPlaneStore: store, evidenceStore: evidenceStoreFor(store) });
  const summary = recorder.recordRouteFailures({
    routes: [{ provider: 'torbox', accountScope: 'default', providerResourceId: 'TB-UNKNOWN', providerFileId: 'pf-9', kind: 'terminal', detail: 'x' }],
    infoHash: HASH,
  });
  assert.equal(summary.recorded, 0);
  assert.equal(summary.skipped, 1);
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM provider_delivery_evidence').get();
  assert.equal(rows.n, 0, 'no capability tuple means no evidence row is invented');
  store.close();
});

test('a route that delivers again clears the negative evidence', (t) => {
  const dbPath = tempDbPath(t);
  const store = createControlPlaneStore({ dbPath });
  seedPlacement(store, { providerResourceId: 'TB-RECOVER' });
  const recorder = createRouteFailureRecorder({ controlPlaneStore: store, evidenceStore: evidenceStoreFor(store) });
  recorder.recordRouteFailures({
    routes: [{ provider: 'torbox', accountScope: 'default', providerResourceId: 'TB-RECOVER', providerFileId: 'pf-1', kind: 'terminal', detail: 'gone' }],
    infoHash: HASH,
  });
  assert.equal(store.db.prepare('SELECT state FROM provider_delivery_evidence').get().state, 'terminal');

  const cleared = recorder.clearRouteFailure({
    provider: 'torbox', accountScope: 'default',
    providerResourceId: 'TB-RECOVER', providerFileId: 'pf-1',
    infoHash: HASH,
  });
  assert.equal(cleared, true);
  assert.equal(store.db.prepare('SELECT state FROM provider_delivery_evidence').get().state, 'usable',
    'a route that works again is not a dead route');
  store.close();
});

test('the representation policy requires terminal evidence and a budget', () => {
  let clock = 1_000;
  const policy = createRepresentationPolicy({ now: () => clock, switchWindowMs: 60_000 });
  const terminalRoutes = [{ kind: 'terminal', provider: 'torbox', providerResourceId: 'TB-1' }];
  const transientRoutes = [{ kind: 'temporary', provider: 'torbox', providerResourceId: 'TB-1' }];

  // No durable evidence recorded -> no switch.
  const noEvidence = policy.decide({
    mediaId: 'tt-1', routes: terminalRoutes, evidence: { recorded: 0, terminal: 0, temporary: 0 },
  });
  assert.equal(noEvidence.allow, false);
  assert.equal(noEvidence.reason, REPRESENTATION_POLICY_REASONS.NO_DURABLE_EVIDENCE);

  // A transient route failure is not a reason to replace the representation.
  const transient = policy.decide({
    mediaId: 'tt-1', routes: transientRoutes, evidence: { recorded: 1, terminal: 0, temporary: 1 },
  });
  assert.equal(transient.allow, false);
  assert.equal(transient.reason, REPRESENTATION_POLICY_REASONS.TRANSIENT_ROUTE);

  // Durable terminal evidence for every route -> allowed.
  const allowed = policy.decide({
    mediaId: 'tt-1', routes: terminalRoutes, evidence: { recorded: 1, terminal: 1, temporary: 0 },
  });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.reason, REPRESENTATION_POLICY_REASONS.ALLOWED);

  // The budget: a flapping route cannot churn the representation.
  policy.noteSwitch({ mediaId: 'tt-1' });
  const spent = policy.decide({
    mediaId: 'tt-1', routes: terminalRoutes, evidence: { recorded: 1, terminal: 1, temporary: 0 },
  });
  assert.equal(spent.allow, false);
  assert.equal(spent.reason, REPRESENTATION_POLICY_REASONS.BUDGET_SPENT);

  // A different media intent has its own budget.
  const other = policy.decide({
    mediaId: 'tt-2', routes: terminalRoutes, evidence: { recorded: 1, terminal: 1, temporary: 0 },
  });
  assert.equal(other.allow, true);

  // After the window the budget is available again.
  clock += 60_001;
  const renewed = policy.decide({
    mediaId: 'tt-1', routes: terminalRoutes, evidence: { recorded: 1, terminal: 1, temporary: 0 },
  });
  assert.equal(renewed.allow, true);
});
