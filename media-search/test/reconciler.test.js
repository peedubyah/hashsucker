import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseIdentity } from '../src/api/release-contract.js';
import { chooseExactProviderFile, planReconciliation } from '../src/lib/control-plane/reconciler.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const identity = createReleaseIdentity(HASH, 0);
const NOW = 10_000;

function desired(overrides = {}) {
  return {
    libraryItemId: 'li_1',
    libraryPathId: 'lp_1',
    desiredState: 'present',
    providerPreferences: ['realdebrid', 'torbox'],
    ...identity,
    ...overrides,
  };
}
function placement(overrides = {}) {
  return {
    id: 'pl_rd', provider: 'realdebrid', accountScope: 'primary',
    infoHash: HASH, providerResourceId: 'rd-1', state: 'ready',
    ownership: 'owned', ownerKey: 'li_1', observedAt: 9_000, expiresAt: 20_000,
    dependentBindingCount: 0,
    ...overrides,
  };
}
function file(overrides = {}) {
  return {
    placementId: 'pl_rd', providerFileId: 'file-900', path: '/Release/movie.mkv',
    name: 'movie.mkv', size: 100, corpusFileIndex: 0,
    inventoryObservedAt: 9_000, inventoryExpiresAt: 20_000,
    ...overrides,
  };
}
function mapping(overrides = {}) {
  return {
    releaseKey: identity.releaseKey, placementId: 'pl_rd', providerFileId: 'file-900',
    state: 'mapped', authoritative: true, ...overrides,
  };
}
function exposure(overrides = {}) {
  return {
    id: 'ex_1', placementId: 'pl_rd', providerFileId: 'file-900',
    state: 'visible', readOnly: true, observedAt: 9_000, expiresAt: 20_000,
    ...overrides,
  };
}

test('no placement produces one deterministic idempotent create-or-reuse action', () => {
  const input = { desired: desired(), placements: [], providerFiles: [], mappings: [], exposures: [] };
  const first = planReconciliation(input, { now: NOW });
  const repeated = planReconciliation(input, { now: NOW });
  assert.deepEqual(repeated, first);
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].action, 'create-or-reuse-placement');
  assert.equal(first.actions[0].idempotencyKey, `virtual:li_1:${HASH}`);
});

test('temporary stale placement yields bounded re-observation, never duplicate placement', () => {
  const input = {
    desired: desired(),
    placements: [placement({ expiresAt: 9_000, observationAttempts: 1 })],
    providerFiles: [], mappings: [], exposures: [],
  };
  const plan = planReconciliation(input, { now: NOW, maxObservationAttempts: 3, reobserveAfterMs: 100 });
  assert.deepEqual(plan.actions.map((action) => action.action), ['observe-again']);
  assert.equal(plan.actions[0].target, 'placement');
  assert.equal(plan.actions[0].attempt, 2);
  assert.equal(plan.actions.some((action) => action.action === 'create-or-reuse-placement'), false);
  assert.equal(plan.destructiveActionCount, 0);
});

test('pending placement waits for provider readiness without claiming exposure', () => {
  const plan = planReconciliation({
    desired: desired(), placements: [placement({ state: 'pending' })],
    providerFiles: [], mappings: [], exposures: [],
  }, { now: NOW });
  assert.equal(plan.actions[0].action, 'wait-provider-readiness');
  assert.equal(plan.actions.some((action) => action.action === 'bind'), false);
});

test('fresh provider inventory maps exact provider-confirmed file index', () => {
  const plan = planReconciliation({
    desired: desired(), placements: [placement()], providerFiles: [file()],
    mappings: [], exposures: [],
  }, { now: NOW });
  assert.equal(plan.actions[0].action, 'map-exact-file');
  assert.equal(plan.actions[0].providerFileId, 'file-900');
});

test('duplicate basename inventory fails closed when exact mapping is unavailable', () => {
  const inventory = [
    file({ providerFileId: 'a', path: '/One/movie.mkv', corpusFileIndex: null }),
    file({ providerFileId: 'b', path: '/Two/movie.mkv', corpusFileIndex: null }),
  ];
  const result = chooseExactProviderFile(desired(), inventory);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCategory, 'provider-file-ambiguous');

  const plan = planReconciliation({
    desired: desired(), placements: [placement()], providerFiles: inventory,
    mappings: [], exposures: [],
  }, { now: NOW });
  assert.equal(plan.actions[0].action, 'mark-degraded');
  assert.equal(plan.failures[0].category, 'provider-file-ambiguous');
  assert.equal(plan.actions.some((action) => action.action === 'bind'), false);
});

test('mapped provider file missing from refreshed inventory is degraded, not guessed by basename', () => {
  const plan = planReconciliation({
    desired: desired(), placements: [placement()],
    providerFiles: [file({ providerFileId: 'different' })],
    mappings: [mapping()], exposures: [exposure()],
  }, { now: NOW });
  assert.equal(plan.failures[0].category, 'mapped-provider-file-missing');
  assert.equal(plan.actions[0].action, 'mark-degraded');
});

test('stale or absent exposure requests observation and does not bind', () => {
  const stale = planReconciliation({
    desired: desired(), placements: [placement()], providerFiles: [file()],
    mappings: [mapping()], exposures: [exposure({ expiresAt: 9_000 })],
  }, { now: NOW });
  assert.equal(stale.actions[0].action, 'observe-exposure');
  assert.equal(stale.actions.some((action) => action.action === 'bind'), false);

  const absent = planReconciliation({
    desired: desired(), placements: [placement()], providerFiles: [file()],
    mappings: [mapping()], exposures: [],
  }, { now: NOW });
  assert.equal(absent.actions[0].reason, 'exposure-not-observed');
});

test('writable exposure fails closed', () => {
  const plan = planReconciliation({
    desired: desired(), placements: [placement()], providerFiles: [file()],
    mappings: [mapping()], exposures: [exposure({ readOnly: false })],
  }, { now: NOW });
  assert.equal(plan.failures[0].category, 'exposure-not-read-only');
  assert.equal(plan.actions[0].action, 'mark-degraded');
});

test('usable exact mapping binds once; repeated plan remains deterministic', () => {
  const input = {
    desired: desired(), placements: [placement()], providerFiles: [file()],
    mappings: [mapping()], exposures: [exposure()],
  };
  const first = planReconciliation(input, { now: NOW });
  const repeated = planReconciliation(input, { now: NOW });
  assert.deepEqual(repeated, first);
  assert.equal(first.actions[0].action, 'bind');
  assert.equal(first.actions[0].providerFileId, 'file-900');
});

test('healthy current binding is a no-op and binding never implies catalog/playback state', () => {
  const currentBinding = {
    id: 'bd_1', status: 'active', libraryItemId: 'li_1', libraryPathId: 'lp_1',
    releaseKey: identity.releaseKey, placementId: 'pl_rd', exposureId: 'ex_1', version: 1,
  };
  const plan = planReconciliation({
    desired: desired(), currentBinding, placements: [placement()],
    providerFiles: [file()], mappings: [mapping()], exposures: [exposure()],
  }, { now: NOW });
  assert.equal(plan.actions[0].action, 'no-op');
  assert.equal(Object.hasOwn(plan, 'cataloged'), false);
  assert.equal(Object.hasOwn(plan, 'playable'), false);
});

test('provider failover chooses preferred usable placement without canonical path churn', () => {
  const tbPlacement = placement({
    id: 'pl_tb', provider: 'torbox', providerResourceId: 'tb-1',
  });
  const rdPlacement = placement({ state: 'degraded' });
  const tbFile = file({ placementId: 'pl_tb', providerFileId: 'tb-file' });
  const tbMapping = mapping({ placementId: 'pl_tb', providerFileId: 'tb-file' });
  const tbExposure = exposure({ id: 'ex_tb', placementId: 'pl_tb', providerFileId: 'tb-file' });
  const currentBinding = {
    id: 'bd_rd', status: 'active', libraryItemId: 'li_1', libraryPathId: 'lp_1',
    releaseKey: identity.releaseKey, placementId: 'pl_rd', exposureId: 'ex_rd', version: 2,
  };

  const plan = planReconciliation({
    desired: desired(), currentBinding, placements: [tbPlacement, rdPlacement],
    providerFiles: [tbFile], mappings: [tbMapping], exposures: [tbExposure],
  }, { now: NOW });
  const rebind = plan.actions.find((action) => action.action === 'rebind');
  assert.ok(rebind);
  assert.equal(rebind.libraryPathId, 'lp_1');
  assert.equal(rebind.placementId, 'pl_tb');
  assert.equal(rebind.expectedBindingVersion, 2);
});

test('destructive cleanup is disabled by default and requires proven fresh ownership with no dependents', () => {
  const absent = desired({ desiredState: 'absent' });
  const baseInput = {
    desired: absent,
    placements: [placement()], providerFiles: [], mappings: [], exposures: [],
  };
  const shadow = planReconciliation(baseInput, { now: NOW });
  assert.equal(shadow.destructiveActionCount, 0);
  assert.equal(shadow.failures[0].category, 'destructive-actions-disabled');

  const unsafe = planReconciliation({
    ...baseInput,
    placements: [placement({ ownership: 'reused', ownerKey: null })],
  }, { now: NOW, destructive: true });
  assert.equal(unsafe.destructiveActionCount, 0);
  assert.equal(unsafe.failures[0].category, 'resource-removal-not-proven-safe');

  const safe = planReconciliation(baseInput, { now: NOW, destructive: true });
  assert.equal(safe.actions[0].action, 'remove-stale-owned-resource');
  assert.equal(safe.destructiveActionCount, 1);
  assert.deepEqual(safe.actions[0].safety, {
    ownershipProven: true, freshObservation: true, noDependents: true,
  });
});
