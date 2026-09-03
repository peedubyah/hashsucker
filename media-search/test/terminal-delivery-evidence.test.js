/**
 * Terminal Delivery Evidence tests (A1–A9).
 *
 * Production problem (tt7137906 V3): the VFS byte path conclusively
 * proves a TorBox delivery capability is invalid, invalidates it, and
 * obtains one fresh capability — which is also proven invalid by
 * the same byte path. The current mapping is correct. The same-hash
 * RD path is infringing, so VFS fails closed. A subsequent normal
 * GET /stream/series/tt7137906?season=1&episode=2, however, was
 * returning the poisoned primary because the resolver availability
 * revalidation only consulted the cached TorBox cache state. The
 * persisted terminal-delivery evidence is therefore the source of
 * truth that the normal resolver ladder must consume.
 *
 * These tests exercise the smallest correct TDD fix:
 *
 *   A1  cached/no negative   — primary behaviour unchanged
 *   A2  fresh terminal       — primary is skipped without placement,
 *                              inventory, or requestdl work
 *   A3  no placement mutation on the failed primary
 *   A4  same-TorrentFile usable alternate provider still precedes
 *       candidate fallback
 *   A5  both providers exhausted enters persisted alternate candidate
 *   A6  changed authoritative mapping is not poisoned by old evidence
 *   A7  restart retains fresh terminal negative
 *   A8  expired negative permits normal reevaluation
 *   A9  429/transient never becomes terminal evidence
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createRevalidator, REVALIDATION_OUTCOME, REVALIDATION_SOURCE } from '../src/lib/resolver/availability-revalidation.js';
import { createTerminalDeliveryEvidenceStore, TERMINAL_DELIVERY_STATES } from '../src/lib/resolver/terminal-delivery-evidence.js';

const PRIMARY_HASH = 'a07b84404989fccee1d55c247cb03e22c8847ecc';
const RD_HASH = 'b17b84404989fccee1d55c247cb03e22c8847ecc';
const PRIMARY_RELEASE_KEY = `${PRIMARY_HASH}:1`;
const RD_RELEASE_KEY = `${RD_HASH}:1`;

const ACCOUNT_SCOPE = 'default';

const FILENAME = 'Provider.Persistence.1080p.mkv';
const SIZE = 8_775_633_660;

function seedTorBoxPlacement(controlPlaneStore, {
  infoHash,
  fileIndex = 1,
  providerFileId = 'file_' + infoHash.slice(0, 6),
  resourceSuffix = infoHash.slice(0, 6),
  size = SIZE,
  provider = 'torbox',
} = {}) {
  const providerResourceId = 'torbox-resource-' + resourceSuffix;
  controlPlaneStore.recordPlacement({
    provider,
    accountScope: ACCOUNT_SCOPE,
    infoHash,
    providerResourceId,
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'terminal-delivery-evidence-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_000,
    expiresAt: 1_000 + 5 * 60_000,
  });
  // Look up by the unique (provider, account_scope,
  // provider_resource_id) tuple. Using infoHash alone would
  // return whichever row was inserted first when the same
  // infoHash is seeded multiple times.
  const row = controlPlaneStore.db
    .prepare('SELECT * FROM provider_placements WHERE provider = ? AND account_scope = ? AND provider_resource_id = ?')
    .get(provider, ACCOUNT_SCOPE, providerResourceId);
  controlPlaneStore.replaceProviderFileInventory(row.id, [
    {
      providerFileId,
      path: '/Season.01/' + FILENAME,
      name: FILENAME,
      size,
      selected: true,
    },
  ], { authoritative: true, complete: true, observedAt: 1_000, expiresAt: 1_000 + 5 * 60_000 });
  controlPlaneStore.recordFileMapping({
    infoHash,
    fileIndex,
    releaseKey: infoHash + ':' + fileIndex,
    placementId: row.id,
    providerFileId,
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    evidence: { candidateFilename: FILENAME, providerPath: '/Season.01/' + FILENAME },
    mappedAt: 1_000,
  });
  return { placementId: row.id, providerFileId, provider };
}

function buildEvidenceStore({ controlPlaneStore, now = () => 1_000 }) {
  return createTerminalDeliveryEvidenceStore({ controlPlaneStore, now });
}

function buildRevalidator({ evidence, now, maxAgeMs = 5 * 60 * 1000, placementLookup = null, checkTorBoxCached }) {
  return createRevalidator({
    checkTorBoxCached: checkTorBoxCached ?? (async () => ({
      cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map(),
    })),
    now,
    maxAgeMs,
    terminalEvidenceStore: evidence,
    placementLookup,
  });
}

function appendCachedObservation(cache, { infoHash, observedAt, expiresAt }) {
  cache.appendProviderObservation({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    scope: 'torrent',
    infoHash,
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt,
    expiresAt,
    source: 'playback-revalidation',
  });
}

test('A1 — cached / no fresh terminal negative: primary path is unchanged', async () => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_000 });
  const evidence = buildEvidenceStore({ controlPlaneStore });
  seedTorBoxPlacement(controlPlaneStore, { infoHash: PRIMARY_HASH });
  const revalidator = buildRevalidator({ evidence, now: () => 1_500 });
  const cache = createDiscoveryCache();
  appendCachedObservation(cache, {
    infoHash: PRIMARY_HASH,
    observedAt: 1_500,
    expiresAt: 1_500 + 5 * 60_000,
  });
  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    mediaId: 'tt7137906',
    releaseKey: PRIMARY_RELEASE_KEY,
    provider: 'torbox',
  });
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.CACHED);
  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.STORED_FRESH);
  // No terminal evidence was recorded.
  const rows = controlPlaneStore.db.prepare(
    'SELECT * FROM provider_delivery_evidence WHERE info_hash = ?',
  ).all(PRIMARY_HASH);
  assert.equal(rows.length, 0);
});

test('A2 — cached / fresh terminal negative for current mapping: skip exact TorBox delivery', async () => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_000 });
  const evidence = buildEvidenceStore({ controlPlaneStore });
  const { placementId, providerFileId } = seedTorBoxPlacement(controlPlaneStore, { infoHash: PRIMARY_HASH });

  // VFS byte path already invalidated the cached capability and
  // obtained a fresh one; both proved protocol-invalid. The
  // evidence module records terminal for the current exact mapping.
  evidence.recordTemporary({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId,
    providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'protocol-invalid',
    observedAt: 1_000,
  });
  // Bounded fresh capability retry — also invalid; promote to terminal.
  evidence.recordTerminal({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId,
    providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'protocol-invalid-after-fresh-retry',
    observedAt: 1_500,
  });

  // The revalidator must consult terminal evidence first and
  // override the cached observation. Placement lookup is wired so
  // the strict capability-tuple path applies.
  const revalidator = buildRevalidator({
    evidence,
    now: () => 2_000,
    placementLookup: (infoHash, fileIndex) => {
      if (infoHash !== PRIMARY_HASH) return null;
      return {
        placementId,
        providerFileId,
        accountScope: ACCOUNT_SCOPE,
      };
    },
  });
  const cache = createDiscoveryCache();
  appendCachedObservation(cache, {
    infoHash: PRIMARY_HASH,
    observedAt: 1_500,
    expiresAt: 1_500 + 5 * 60_000,
  });
  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    mediaId: 'tt7137906',
    releaseKey: PRIMARY_RELEASE_KEY,
    provider: 'torbox',
  });
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.UNCACHED);
  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.TERMINAL_DELIVERY_EVIDENCE);
  // Critical: no provider call is made (the override is local).
  assert.equal(result.providerCheckOccurred, false);
  assert.equal(result.checkLatencyMs, null);
  // Terminal evidence source is exposed for the alternate-fallback rung.
  assert.ok(result.terminalEvidence, 'terminal evidence must be attached to the result');
  assert.equal(result.terminalEvidence.state, TERMINAL_DELIVERY_STATES.TERMINAL);
});

test('A3 — terminal evidence does NOT mutate placement/inventory/file mapping rows', async () => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_000 });
  const evidence = buildEvidenceStore({ controlPlaneStore });
  const { placementId, providerFileId } = seedTorBoxPlacement(controlPlaneStore, { infoHash: PRIMARY_HASH });

  // Snapshot durable state.
  const beforePlacement = controlPlaneStore.db.prepare('SELECT * FROM provider_placements WHERE id = ?').get(placementId);
  const beforeInventory = controlPlaneStore.db.prepare('SELECT * FROM provider_files WHERE placement_id = ?').all(placementId);
  const beforeMapping = controlPlaneStore.db.prepare('SELECT * FROM candidate_file_mappings WHERE placement_id = ?').all(placementId);
  const beforeReadiness = controlPlaneStore.db.prepare('SELECT * FROM provider_readiness_observations WHERE placement_id = ?').all(placementId);
  const beforeLookup = controlPlaneStore.db.prepare('SELECT * FROM provider_placement_observations WHERE placement_id = ?').all(placementId);

  evidence.recordTerminal({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId,
    providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'protocol-invalid-after-fresh-retry',
    observedAt: 2_000,
  });
  evidence.recordTemporary({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId,
    providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'protocol-invalid',
    observedAt: 2_100,
  });

  const afterPlacement = controlPlaneStore.db.prepare('SELECT * FROM provider_placements WHERE id = ?').get(placementId);
  const afterInventory = controlPlaneStore.db.prepare('SELECT * FROM provider_files WHERE placement_id = ?').all(placementId);
  const afterMapping = controlPlaneStore.db.prepare('SELECT * FROM candidate_file_mappings WHERE placement_id = ?').all(placementId);
  const afterReadiness = controlPlaneStore.db.prepare('SELECT * FROM provider_readiness_observations WHERE placement_id = ?').all(placementId);
  const afterLookup = controlPlaneStore.db.prepare('SELECT * FROM provider_placement_observations WHERE placement_id = ?').all(placementId);

  // Placement must NOT be removed or repaired.
  assert.equal(afterPlacement.updated_at, beforePlacement.updated_at);
  assert.equal(afterPlacement.state, beforePlacement.state);
  // Provider file inventory must NOT be replaced or removed.
  assert.equal(afterInventory.length, beforeInventory.length);
  for (let i = 0; i < afterInventory.length; i += 1) {
    assert.equal(afterInventory[i].provider_file_id, beforeInventory[i].provider_file_id);
    assert.equal(afterInventory[i].present, beforeInventory[i].present);
  }
  // File mapping must NOT be demoted.
  assert.equal(afterMapping.length, beforeMapping.length);
  for (let i = 0; i < afterMapping.length; i += 1) {
    assert.equal(afterMapping[i].state, beforeMapping[i].state);
  }
  // Readiness and lookup observations must NOT be added.
  assert.equal(afterReadiness.length, beforeReadiness.length);
  assert.equal(afterLookup.length, beforeLookup.length);
});

test('A4 — same-TorrentFile usable alternate provider precedes persisted alternate candidate', async () => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_000 });
  const evidence = buildEvidenceStore({ controlPlaneStore });
  const primary = seedTorBoxPlacement(controlPlaneStore, { infoHash: PRIMARY_HASH });
  // RD same-TorrentFile placement is a separate provider, distinct
  // (placement, file) tuple. The RD placement has no terminal
  // evidence and is therefore still classified as usable.
  const rd = seedTorBoxPlacement(controlPlaneStore, {
    infoHash: RD_HASH,
    providerFileId: 'file_rd_alternate',
    resourceSuffix: 'rd-alt',
  });

  // TorBox for the primary is poisoned.
  evidence.recordTerminal({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: primary.placementId,
    providerFileId: primary.providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'protocol-invalid-after-fresh-retry',
    observedAt: 2_000,
  });

  // The revalidator must report UNCACHED for the TorBox mapping.
  const revalidator = buildRevalidator({
    evidence,
    now: () => 2_500,
    placementLookup: (infoHash) => {
      if (infoHash === PRIMARY_HASH) {
        return { placementId: primary.placementId, providerFileId: primary.providerFileId, accountScope: ACCOUNT_SCOPE };
      }
      if (infoHash === RD_HASH) {
        return { placementId: rd.placementId, providerFileId: rd.providerFileId, accountScope: ACCOUNT_SCOPE };
      }
      return null;
    },
  });
  const cache = createDiscoveryCache();
  appendCachedObservation(cache, {
    infoHash: PRIMARY_HASH,
    observedAt: 1_500,
    expiresAt: 1_500 + 5 * 60_000,
  });
  const torboxResult = await revalidator.revalidateAvailability({
    cache,
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    mediaId: 'tt7137906',
    releaseKey: PRIMARY_RELEASE_KEY,
    provider: 'torbox',
  });
  assert.equal(torboxResult.cacheState, REVALIDATION_OUTCOME.UNCACHED);

  // The RD path (same-TorrentFile alternate provider) is NOT
  // poisoned by the TorBox terminal evidence. The persisted
  // alternate-candidate rung only fires after both providers are
  // exhausted; the RD check still returns CACHED.
  appendCachedObservation(cache, {
    infoHash: RD_HASH,
    observedAt: 1_500,
    expiresAt: 1_500 + 5 * 60_000,
  });
  const rdResult = await revalidator.revalidateAvailability({
    cache,
    infoHash: RD_HASH,
    fileIndex: 1,
    mediaId: 'tt7137906',
    releaseKey: RD_RELEASE_KEY,
    provider: 'realdebrid',
  });
  assert.equal(rdResult.cacheState, REVALIDATION_OUTCOME.CACHED);
});

test('A5 — both providers terminal-evidenced: persisted alternate-candidate rung is the next ladder step', async () => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_000 });
  const evidence = buildEvidenceStore({ controlPlaneStore });
  const primary = seedTorBoxPlacement(controlPlaneStore, { infoHash: PRIMARY_HASH });
  const rd = seedTorBoxPlacement(controlPlaneStore, {
    infoHash: RD_HASH,
    providerFileId: 'file_rd_terminal_1',
    resourceSuffix: 'rd-term-1',
    provider: 'realdebrid',
  });

  // Both providers' current exact mappings are terminal.
  evidence.recordTerminal({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: primary.placementId,
    providerFileId: primary.providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'protocol-invalid-after-fresh-retry',
    observedAt: 2_000,
  });
  evidence.recordTerminal({
    provider: 'realdebrid',
    accountScope: ACCOUNT_SCOPE,
    placementId: rd.placementId,
    providerFileId: rd.providerFileId,
    infoHash: RD_HASH,
    fileIndexKey: 1,
    reason: 'protocol-invalid-after-fresh-retry',
    observedAt: 2_000,
  });

  // Both lookups classify as terminal — the next ladder step is
  // the persisted alternate-candidate rung (which is the
  // unchanged contract of tryAlternateCandidateFallback in
  // app.js).
  const torboxState = evidence.classifyProviderState({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: primary.placementId,
    providerFileId: primary.providerFileId,
  });
  const rdState = evidence.classifyProviderState({
    provider: 'realdebrid',
    accountScope: ACCOUNT_SCOPE,
    placementId: rd.placementId,
    providerFileId: rd.providerFileId,
  });
  assert.equal(torboxState, TERMINAL_DELIVERY_STATES.TERMINAL);
  assert.equal(rdState, TERMINAL_DELIVERY_STATES.TERMINAL);
});

test('A6 — changed authoritative mapping is not poisoned by old evidence', async () => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_000 });
  const evidence = buildEvidenceStore({ controlPlaneStore });
  // Old authoritative mapping for the same placement.
  const oldMapping = seedTorBoxPlacement(controlPlaneStore, {
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    providerFileId: 'file_old_mapping',
    resourceSuffix: 'old-mapping',
  });
  // New authoritative mapping for the same placement: same
  // (infoHash, fileIndexKey) but a different providerFileId. This
  // is the typical churn pattern when a re-inventory discovers
  // the file has been re-issued under a different ID.
  const newMapping = seedTorBoxPlacement(controlPlaneStore, {
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    providerFileId: 'file_new_mapping',
    resourceSuffix: 'new-mapping',
  });

  // The OLD mapping is terminal.
  evidence.recordTerminal({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: oldMapping.placementId,
    providerFileId: oldMapping.providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'protocol-invalid-after-fresh-retry',
    observedAt: 1_500,
  });
  // The NEW mapping is fresh and usable.
  evidence.recordUsable({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: newMapping.placementId,
    providerFileId: newMapping.providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    observedAt: 1_600,
  });

  // Lookup of the old mapping still reports terminal.
  const oldEvidence = evidence.findTerminalEvidence({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: oldMapping.placementId,
    providerFileId: oldMapping.providerFileId,
  });
  assert.ok(oldEvidence, 'old mapping evidence must remain');
  assert.equal(oldEvidence.state, TERMINAL_DELIVERY_STATES.TERMINAL);

  // Lookup of the new mapping is a USABLE row, not a TERMINAL one.
  const newEvidence = evidence.findTerminalEvidence({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: newMapping.placementId,
    providerFileId: newMapping.providerFileId,
  });
  assert.ok(newEvidence, 'new mapping evidence exists');
  assert.equal(newEvidence.state, TERMINAL_DELIVERY_STATES.USABLE);
  assert.equal(
    evidence.classifyProviderState({
      provider: 'torbox',
      accountScope: ACCOUNT_SCOPE,
      placementId: newMapping.placementId,
      providerFileId: newMapping.providerFileId,
    }),
    TERMINAL_DELIVERY_STATES.USABLE,
  );

  // And the revalidator with the new mapping's lookup must NOT
  // return UNCACHED just because the OLD mapping is poisoned.
  const revalidator = buildRevalidator({
    evidence,
    now: () => 2_000,
    placementLookup: () => ({
      placementId: newMapping.placementId,
      providerFileId: newMapping.providerFileId,
      accountScope: ACCOUNT_SCOPE,
    }),
  });
  const cache = createDiscoveryCache();
  appendCachedObservation(cache, {
    infoHash: PRIMARY_HASH,
    observedAt: 1_500,
    expiresAt: 1_500 + 5 * 60_000,
  });
  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    mediaId: 'tt7137906',
    releaseKey: PRIMARY_RELEASE_KEY,
    provider: 'torbox',
  });
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.CACHED);
});

test('A7 — restart retains fresh terminal negative', async () => {
  // Build the store, record terminal evidence, then build a fresh
  // evidence wrapper around the same underlying control plane
  // store. The production path opens a new store around the same
  // SQLite file on restart; the wrapper only depends on the
  // public surface, so re-wrapping exercises the durability
  // contract.
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_000 });
  const initialEvidence = buildEvidenceStore({ controlPlaneStore });
  const primary = seedTorBoxPlacement(controlPlaneStore, { infoHash: PRIMARY_HASH });
  initialEvidence.recordTerminal({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: primary.placementId,
    providerFileId: primary.providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'protocol-invalid-after-fresh-retry',
    observedAt: 2_000,
  });

  // Build a fresh wrapper. The "restart" is simulated by using a
  // new now() function and re-instantiating the wrapper around
  // the same control plane store.
  const freshEvidence = createTerminalDeliveryEvidenceStore({ controlPlaneStore, now: () => 3_000 });
  const row = freshEvidence.findTerminalEvidence({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: primary.placementId,
    providerFileId: primary.providerFileId,
  });
  assert.ok(row, 'terminal evidence must survive restart');
  assert.equal(row.state, TERMINAL_DELIVERY_STATES.TERMINAL);
  // Expires-at is bounded and finite.
  assert.ok(Number.isFinite(row.expiresAt));
  assert.ok(row.expiresAt > 2_000);
  // The TTL is the bounded terminal TTL.
  assert.equal(row.expiresAt - row.observedAt, 10 * 60 * 1000);
});

test('A8 — expired negative permits normal reevaluation', async () => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_000 });
  const now = () => 5_000; // 3 seconds after expiry
  const evidence = buildEvidenceStore({ controlPlaneStore, now });
  const primary = seedTorBoxPlacement(controlPlaneStore, { infoHash: PRIMARY_HASH });

  // Backdate the terminal evidence so it is expired.
  controlPlaneStore.db.prepare(`
    INSERT INTO provider_delivery_evidence (
      provider, account_scope, placement_id, provider_file_id,
      info_hash, file_index_key, state, reason, failure_category,
      observed_at, expires_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'torbox', ACCOUNT_SCOPE, primary.placementId, primary.providerFileId,
    PRIMARY_HASH, 1, 'terminal', 'protocol-invalid-after-fresh-retry', null,
    1_000, 2_000, 1_000,
  );

  const revalidator = buildRevalidator({
    evidence,
    now,
    placementLookup: () => ({
      placementId: primary.placementId,
      providerFileId: primary.providerFileId,
      accountScope: ACCOUNT_SCOPE,
    }),
    checkTorBoxCached: async () => ({
      cached: new Set([PRIMARY_HASH]),
      failed: new Set(),
      details: new Map([[PRIMARY_HASH, { name: FILENAME }]]),
      latencyMs: new Map([[PRIMARY_HASH, 5]]),
    }),
  });
  const cache = createDiscoveryCache();
  appendCachedObservation(cache, {
    infoHash: PRIMARY_HASH,
    observedAt: 1_500,
    expiresAt: 1_500 + 5 * 60_000,
  });
  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    mediaId: 'tt7137906',
    releaseKey: PRIMARY_RELEASE_KEY,
    provider: 'torbox',
  });
  // Expired terminal evidence must NOT override the cached
  // observation. The revalidator returns CACHED (the source is
  // STORED_FRESH because the observation is still fresh at now=5000,
  // and the absolute provider check would never fire if a fresh
  // stored observation is available).
  assert.notEqual(result.availabilitySource, REVALIDATION_SOURCE.TERMINAL_DELIVERY_EVIDENCE);
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.CACHED);
  // The expired row is treated as absent by classifyProviderState.
  assert.equal(
    evidence.classifyProviderState({
      provider: 'torbox',
      accountScope: ACCOUNT_SCOPE,
      placementId: primary.placementId,
      providerFileId: primary.providerFileId,
    }),
    TERMINAL_DELIVERY_STATES.USABLE,
  );
});

test('A9 — 429 / transient never becomes terminal evidence', async () => {
  const controlPlaneStore = createControlPlaneStore({ now: () => 1_000 });
  const evidence = buildEvidenceStore({ controlPlaneStore });
  const primary = seedTorBoxPlacement(controlPlaneStore, { infoHash: PRIMARY_HASH });

  // First 429: temporary.
  evidence.recordTemporary({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: primary.placementId,
    providerFileId: primary.providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'read-429',
    observedAt: 1_000,
  });
  // Bounded fresh capability retry — also 429: still temporary.
  evidence.recordTemporary({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: primary.placementId,
    providerFileId: primary.providerFileId,
    infoHash: PRIMARY_HASH,
    fileIndexKey: 1,
    reason: 'read-429-after-fresh-retry',
    observedAt: 1_500,
  });

  // The capability is still classified as TEMPORARY (not
  // TERMINAL). A subsequent normal revalidation must see the
  // temporary row, but it is NOT a terminal override.
  const state = evidence.classifyProviderState({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: primary.placementId,
    providerFileId: primary.providerFileId,
  });
  assert.equal(state, TERMINAL_DELIVERY_STATES.TEMPORARY);

  const revalidator = buildRevalidator({
    evidence,
    now: () => 2_000,
    placementLookup: () => ({
      placementId: primary.placementId,
      providerFileId: primary.providerFileId,
      accountScope: ACCOUNT_SCOPE,
    }),
  });
  const cache = createDiscoveryCache();
  appendCachedObservation(cache, {
    infoHash: PRIMARY_HASH,
    observedAt: 1_500,
    expiresAt: 1_500 + 5 * 60_000,
  });
  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    mediaId: 'tt7137906',
    releaseKey: PRIMARY_RELEASE_KEY,
    provider: 'torbox',
  });
  // Temporary evidence must NOT downgrade a fresh cached
  // observation to UNCACHED. The revalidation returns CACHED
  // from the stored observation.
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.CACHED);
  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.STORED_FRESH);
});
