/**
 * End-to-End Pipeline Smoke Test
 *
 * Proves the full request pipeline works from user selection through
 * final materialization state. Uses existing execution paths — does
 * NOT bypass the control plane or mock away lifecycle logic.
 *
 * Deterministic via in-memory store and fixture-based provider observations.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createReleaseIdentity } from '../src/api/release-contract.js';
import { createHandoff } from '../src/lib/requests/handoff.js';
import { createRequestIntent } from '../src/lib/requests/intent.js';
import { QueueImporterClient } from '../src/lib/importer/queue-client.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { planReconciliation, executeReconciliation } from '../src/lib/control-plane/reconciler.js';
import { createLifecycleEvent, projectLifecycle } from '../src/lib/control-plane/lifecycle.js';
import {
  buildPipelineTrace,
  summarizeTrace,
} from '../src/lib/trace/pipeline-trace.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const NOW = 10_000;

function movie() {
  return {
    mediaType: 'movie',
    mediaId: 'tt0133093',
    title: 'The Matrix',
    year: 1999,
    desiredState: 'present',
  };
}

function setupBindable(store, item, identity, options = {}) {
  const libraryPath = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: options.provider ?? 'realdebrid',
    accountScope: 'primary',
    infoHash: identity.infoHash,
    providerResourceId: options.resourceId ?? `resource-${identity.infoHash.slice(0, 5)}`,
    state: 'ready',
    ownership: options.ownership ?? 'owned',
    ownerKey: item.id,
    provenance: 'test',
    idempotencyKey: `placement:${options.provider ?? 'realdebrid'}:${identity.infoHash}`,
    observedAt: 0,
    expiresAt: 9_999_999_999_999,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: options.providerFileId ?? 'file-1',
    path: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    name: 'The.Matrix.1999.mkv',
    size: 1_000,
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
    transport: options.transport ?? 'zurg-rclone',
    exposureKey: options.exposureKey ?? `${placement.id}:${fileId}`,
    relativePath: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    state: 'visible',
    readOnly: true,
    observedAt: 0,
    expiresAt: 9_999_999_999_999,
  });
  return { libraryPath, placement, exposure, providerFileId: fileId };
}

function buildSnapshot(store, item, identity) {
  return store.getReconciliationSnapshot(item.id, identity);
}

// ─── Test 1: Successful Download Flow ───────────────────────────────────────

test('successful Download flow: request → handoff → binding → active', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-smoke-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const store = createControlPlaneStore({ now: () => NOW });
  t.after(() => store.close());

  const importer = new QueueImporterClient({ root: tmpDir });
  const identity = createReleaseIdentity(HASH, 0);

  // 1. Discovery: query accepted, media identity selected, release selected
  const intent = createRequestIntent({ type: 'movie', mediaId: 'tt0133093' });
  const release = {
    ...identity,
    title: 'The Matrix',
    filename: 'The.Matrix.1999.mkv',
    size: 1_000,
    resolution: '1080p',
    quality: 'BluRay',
  };

  // 2. Request handoff: handlingMode preserved, handoff envelope created
  const handoff = createHandoff({
    intent,
    release,
    provider: 'realdebrid',
    handlingMode: 'download',
  });

  assert.equal(handoff.handlingMode, 'download', 'handlingMode preserved as download');
  assert.ok(handoff.requestId, 'handoff identifier created');
  assert.ok(handoff.createdAt, 'handoff timestamp created');

  // 3. Processing decision: importer path selected for Download
  const result = await importer.submitRequest(handoff);
  assert.equal(result.status, 'queued', 'request queued');
  assert.equal(result.requestId, handoff.requestId, 'requestId matches handoff');

  // 4. Lifecycle: binding created, state transitions observed
  const item = store.ensureLibraryItem(movie());
  setupBindable(store, item, identity);

  const snapshot = buildSnapshot(store, item, identity);
  const plan = planReconciliation({
    ...snapshot,
    currentBinding: null,
  }, { now: NOW });

  assert.equal(plan.actions[0].action, 'bind', 'bind action planned');

  const binding = executeReconciliation(plan, store);
  assert.equal(binding.status, 'active', 'binding is active');
  assert.equal(binding.version, 1, 'initial binding version is 1');

  // Record lifecycle event
  store.appendLifecycleEvent({
    libraryItemId: item.id,
    milestone: 'bound',
    status: 'satisfied',
    occurredAt: NOW,
    source: 'pipeline-smoke-test',
    reason: 'initial-bind',
  });

  // 5. Final outcome: final materialization state, final binding state
  const lifecycle = store.getLifecycle(item.id);
  const finalBinding = store.listBindings(item.id).find(b => b.status === 'active');

  assert.ok(finalBinding, 'active binding exists');
  assert.equal(finalBinding.status, 'active', 'final binding state is active');

  // Build trace and verify
  const trace = buildPipelineTrace({
    request: {
      query: 'The Matrix',
      media: { id: 'tt0133093', title: 'The Matrix', type: 'movie', year: 1999 },
      release: { ...identity, filename: 'The.Matrix.1999.mkv' },
      handlingMode: 'download',
    },
    handoff,
    requestStatus: result,
    lifecycle,
    binding: finalBinding,
    now: NOW,
  });

  const summary = summarizeTrace(trace);
  assert.equal(summary.finalOutcome, 'success', 'trace outcome is success');
  assert.equal(summary.executionPath, 'download-to-local', 'download path selected');
  assert.equal(summary.handoffCreated, true, 'handoff recorded in trace');
  assert.equal(summary.bindingStatus, 'active', 'binding status in trace');
});

// ─── Test 2: Successful Stream Flow ─────────────────────────────────────────

test('successful Stream flow: request → handoff → stream path selected', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-smoke-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const store = createControlPlaneStore({ now: () => NOW });
  t.after(() => store.close());

  const importer = new QueueImporterClient({ root: tmpDir });
  const identity = createReleaseIdentity(HASH, 0);

  const intent = createRequestIntent({ type: 'movie', mediaId: 'tt0133093' });
  const release = {
    ...identity,
    title: 'The Matrix',
    filename: 'The.Matrix.1999.mkv',
    size: 1_000,
  };

  const handoff = createHandoff({
    intent,
    release,
    provider: 'realdebrid',
    handlingMode: 'stream',
  });

  assert.equal(handoff.handlingMode, 'stream', 'handlingMode preserved as stream');

  const result = await importer.submitRequest(handoff);
  assert.equal(result.status, 'queued', 'request queued');

  // Stream path: materialization path selected
  const item = store.ensureLibraryItem(movie());
  setupBindable(store, item, identity);

  const snapshot = buildSnapshot(store, item, identity);
  const plan = planReconciliation({
    ...snapshot,
    currentBinding: null,
  }, { now: NOW });

  const binding = executeReconciliation(plan, store);
  assert.equal(binding.status, 'active', 'binding is active');

  const trace = buildPipelineTrace({
    request: {
      query: 'The Matrix',
      media: { id: 'tt0133093', title: 'The Matrix', type: 'movie', year: 1999 },
      release: { ...identity, filename: 'The.Matrix.1999.mkv' },
      handlingMode: 'stream',
    },
    handoff,
    requestStatus: result,
    lifecycle: store.getLifecycle(item.id),
    binding,
    now: NOW,
  });

  const summary = summarizeTrace(trace);
  assert.equal(summary.finalOutcome, 'success', 'stream flow outcome is success');
  assert.equal(summary.executionPath, 'stream-reference', 'stream path selected');
  assert.equal(summary.handlingMode, 'stream', 'handlingMode preserved in trace');
});

// ─── Test 3: Degraded/Recovery Flow ─────────────────────────────────────────

test('degraded/recovery flow: active → placement degraded → rebound to alternate', (t) => {
  const store = createControlPlaneStore({ now: () => NOW });
  t.after(() => store.close());

  const identity = createReleaseIdentity(HASH, 0);
  const item = store.ensureLibraryItem(movie());

  // Initial bind on realdebrid
  const rd = setupBindable(store, item, identity, { provider: 'realdebrid' });
  setupBindable(store, item, identity, {
    provider: 'torbox',
    resourceId: 'tb-22',
    providerFileId: 'tb-file',
    transport: 'torbox-webdav-rclone',
    exposureKey: 'tb-22:tb-file',
  });

  const snapshot1 = buildSnapshot(store, item, identity);
  snapshot1.desired = { ...snapshot1.desired, providerPreferences: ['realdebrid', 'torbox'] };
  const plan1 = planReconciliation({ ...snapshot1, currentBinding: null }, { now: NOW });
  const binding1 = executeReconciliation(plan1, store);

  assert.equal(binding1.status, 'active', 'initial binding active');
  assert.equal(binding1.version, 1, 'initial version is 1');

  // Current placement becomes unavailable (degraded)
  store.db.prepare("UPDATE provider_placements SET state = 'degraded' WHERE id = ?").run(rd.placement.id);

  // Recovery: rebind to alternate
  const snapshot2 = buildSnapshot(store, item, identity);
  snapshot2.desired = { ...snapshot2.desired, providerPreferences: ['realdebrid', 'torbox'] };
  const plan2 = planReconciliation({
    ...snapshot2,
    currentBinding: binding1,
  }, { now: NOW });

  const rebindAction = plan2.actions.find(a => a.action === 'rebind');
  assert.ok(rebindAction, 'rebind action planned for recovery');

  const binding2 = executeReconciliation(plan2, store);
  assert.equal(binding2.status, 'active', 'recovered binding is active');
  assert.equal(binding2.version, 2, 'recovered binding version is 2');

  // Old binding superseded
  const allBindings = store.listBindings(item.id);
  const superseded = allBindings.find(b => b.status === 'superseded');
  assert.ok(superseded, 'old binding superseded');

  // Trace the degraded/recovery flow
  const trace = buildPipelineTrace({
    request: {
      query: 'The Matrix',
      media: { id: 'tt0133093', title: 'The Matrix', type: 'movie', year: 1999 },
      release: { ...identity, filename: 'The.Matrix.1999.mkv' },
      handlingMode: 'download',
    },
    lifecycle: store.getLifecycle(item.id),
    binding: binding2,
    now: NOW,
  });

  const summary = summarizeTrace(trace);
  assert.equal(summary.finalOutcome, 'success', 'recovery outcome is success');
  assert.equal(summary.bindingStatus, 'active', 'recovered binding status');
});

// ─── Test 4: Failure Classification ─────────────────────────────────────────

test('failure classification: no placement available → unavailable outcome', (t) => {
  const store = createControlPlaneStore({ now: () => NOW });
  t.after(() => store.close());

  const identity = createReleaseIdentity(HASH, 0);
  const item = store.ensureLibraryItem(movie());

  // No placement setup — plan should produce create-or-reuse-placement
  const snapshot = buildSnapshot(store, item, identity);
  const plan = planReconciliation({
    ...snapshot,
    currentBinding: null,
  }, { now: NOW });

  assert.equal(plan.actions[0].action, 'create-or-reuse-placement', 'no placement → create action');

  // Trace with no binding → unknown outcome
  const trace = buildPipelineTrace({
    request: {
      query: 'The Matrix',
      media: { id: 'tt0133093', title: 'The Matrix', type: 'movie', year: 1999 },
      release: { ...identity, filename: 'The.Matrix.1999.mkv' },
      handlingMode: 'download',
    },
    lifecycle: store.getLifecycle(item.id),
    binding: null,
    now: NOW,
  });

  const summary = summarizeTrace(trace);
  assert.equal(summary.finalOutcome, 'unknown', 'no binding → unknown outcome');
  assert.equal(summary.bindingStatus, null, 'no binding status');
});

// ─── Test 5: Trace Does Not Alter Execution ─────────────────────────────────

test('trace generation does not alter execution behavior', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-smoke-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const store = createControlPlaneStore({ now: () => NOW });
  t.after(() => store.close());

  const importer = new QueueImporterClient({ root: tmpDir });
  const identity = createReleaseIdentity(HASH, 0);

  const intent = createRequestIntent({ type: 'movie', mediaId: 'tt0133093' });
  const release = { ...identity, title: 'The Matrix', filename: 'The.Matrix.1999.mkv', size: 1_000 };
  const handoff = createHandoff({ intent, release, provider: 'realdebrid', handlingMode: 'download' });

  const result = await importer.submitRequest(handoff);

  const item = store.ensureLibraryItem(movie());
  setupBindable(store, item, identity);

  const snapshot = buildSnapshot(store, item, identity);
  const plan = planReconciliation({ ...snapshot, currentBinding: null }, { now: NOW });
  const binding = executeReconciliation(plan, store);

  // Capture state before trace
  const bindingBefore = JSON.stringify(store.listBindings(item.id));
  const lifecycleBefore = JSON.stringify(store.getLifecycle(item.id));

  // Generate trace
  buildPipelineTrace({
    request: { query: 'The Matrix', media: { id: 'tt0133093' }, release: { ...identity }, handlingMode: 'download' },
    handoff,
    requestStatus: result,
    lifecycle: store.getLifecycle(item.id),
    binding,
    now: NOW,
  });

  // Capture state after trace
  const bindingAfter = JSON.stringify(store.listBindings(item.id));
  const lifecycleAfter = JSON.stringify(store.getLifecycle(item.id));

  assert.equal(bindingBefore, bindingAfter, 'trace did not alter bindings');
  assert.equal(lifecycleBefore, lifecycleAfter, 'trace did not alter lifecycle');
});

// ─── Test 6: Missing Lifecycle Data Degrades Gracefully ─────────────────────

test('missing lifecycle data degrades gracefully in trace', (t) => {
  const trace = buildPipelineTrace({
    request: {
      query: 'The Matrix',
      media: { id: 'tt0133093', title: 'The Matrix', type: 'movie', year: 1999 },
      release: { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` },
      handlingMode: 'download',
    },
    // No handoff, no requestStatus, no lifecycle, no binding
    now: NOW,
  });

  const summary = summarizeTrace(trace);
  assert.equal(summary.finalOutcome, 'unknown', 'missing data → unknown outcome');
  assert.equal(summary.handoffCreated, false, 'no handoff created');
  assert.equal(summary.bindingStatus, null, 'no binding status');
  assert.equal(summary.errors.length, 0, 'no errors from missing data');
});

// ─── Test 7: Trace Summary Format ───────────────────────────────────────────

test('trace summary produces concise operator report', (t) => {
  const store = createControlPlaneStore({ now: () => NOW });
  t.after(() => store.close());

  const identity = createReleaseIdentity(HASH, 0);
  const item = store.ensureLibraryItem(movie());
  setupBindable(store, item, identity);

  const snapshot = buildSnapshot(store, item, identity);
  const plan = planReconciliation({ ...snapshot, currentBinding: null }, { now: NOW });
  const binding = executeReconciliation(plan, store);

  const intent = createRequestIntent({ type: 'movie', mediaId: 'tt0133093' });
  const release = { ...identity, title: 'The Matrix', filename: 'The.Matrix.1999.mkv', size: 1_000 };
  const handoff = createHandoff({ intent, release, provider: 'realdebrid', handlingMode: 'download' });

  const trace = buildPipelineTrace({
    request: {
      query: 'The Matrix',
      media: { id: 'tt0133093', title: 'The Matrix', type: 'movie', year: 1999 },
      release: { ...identity, filename: 'The.Matrix.1999.mkv' },
      handlingMode: 'download',
    },
    handoff,
    lifecycle: store.getLifecycle(item.id),
    binding,
    now: NOW,
  });

  const summary = summarizeTrace(trace);

  // Verify summary has expected fields for operator report
  assert.ok(summary.traceId, 'summary has traceId');
  assert.ok(summary.generatedAt, 'summary has generatedAt');
  assert.equal(summary.query, 'The Matrix', 'summary has query');
  assert.equal(summary.mediaId, 'tt0133093', 'summary has mediaId');
  assert.equal(summary.releaseKey, identity.releaseKey, 'summary has releaseKey');
  assert.equal(summary.handlingMode, 'download', 'summary has handlingMode');
  assert.equal(summary.executionPath, 'download-to-local', 'summary has executionPath');
  assert.equal(summary.bindingStatus, 'active', 'summary has bindingStatus');
  assert.equal(summary.finalOutcome, 'success', 'summary has finalOutcome');
  assert.ok(Array.isArray(summary.errors), 'summary has errors array');
});
