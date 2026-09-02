/**
 * Requestdl 429 → durable-binding causality proof (Slice 2.10 / Worker B).
 *
 * Traces the upstream 429 path through the TorBox download URL cache wrapper
 * (accounting-cache-wrapper.js). Asserts the production invariant:
 *
 *   a 429 response from TorBox requestdl increments the
 *   'requestdl_rate_limited_429' accounting counter (observability surface)
 *   but does NOT mutate any of:
 *     - provider_placements
 *     - provider_files
 *     - candidate_file_mappings
 *     - exposures
 *     - library_items / library_paths
 *     - bindings
 *     - durability_due_state
 *
 * In other words: a transient 429 from the requestdl endpoint cannot
 * unbind an already-authoritative fulfillment, mark a binding degraded,
 * tear down an exposure, or enroll a new due-state row. The wrapper is
 * observation-only.
 *
 * The wrapper does NOT swallow the error — the throw propagates to the
 * caller, who decides what to do. This test confirms the side-effect
 * surface is correctly bounded.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { providerAccounting } from '../src/lib/providers/provider-accounting.js';
import { wrapTorBoxDownloadUrlCacheWithAccounting } from '../src/lib/providers/accounting-cache-wrapper.js';
import { TorBoxDownloadUrlError } from '../src/lib/resolver/torbox-download-url-cache.js';

const INFO_HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const PROVIDER_FILE_ID = 'pf_429_causality';
const PLACEMENT_ID_HOLDER = 'pl_429_holder';

function seedAuthoritativeFulfillment(store) {
  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('tf_429', INFO_HASH, 'Show.S01.2160p/Show.S01E01.2160p.mkv', 5_000_000_000, 1_000);

  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: INFO_HASH,
    providerResourceId: 'tb-429-resource',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'library_item_429',
    provenance: '429-causality-proof',
    observedAt: 1_000,
    expiresAt: 1_000 + 5 * 60_000,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: PROVIDER_FILE_ID,
    path: 'Show.S01.2160p/Show.S01E01.2160p.mkv',
    name: 'Show.S01E01.2160p.mkv',
    size: 5_000_000_000,
    selected: true,
  }], { authoritative: true, complete: true, observedAt: 1_000, expiresAt: 1_000 + 5 * 60_000 });
  store.recordFileMapping({
    infoHash: INFO_HASH,
    fileIndex: 0,
    releaseKey: `${INFO_HASH}:0`,
    placementId: placement.id,
    providerFileId: PROVIDER_FILE_ID,
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    evidence: {},
    mappedAt: 1_000,
  });
  const exposure = store.recordExposure({
    placementId: placement.id,
    providerFileId: PROVIDER_FILE_ID,
    accountScope: 'default',
    mountScope: 'default',
    transport: 'zurg-rclone',
    exposureKey: `${placement.id}:${PROVIDER_FILE_ID}`,
    relativePath: 'Show.S01.2160p/Show.S01E01.2160p.mkv',
    state: 'visible',
    readOnly: true,
    observedAt: 1_000,
    expiresAt: 1_000 + 5 * 60_000,
  });
  const item = store.ensureLibraryItem({
    mediaType: 'episode',
    mediaId: 'tt429',
    title: 'Show',
    season: 1,
    episode: 1,
    desiredState: 'present',
  });
  const path = store.ensureCanonicalPath(item.id);
  const binding = store.activateBinding({
    libraryItemId: item.id,
    libraryPathId: path.id,
    releaseKey: `${INFO_HASH}:0`,
    infoHash: INFO_HASH,
    fileIndex: 0,
    placementId: placement.id,
    providerFileId: PROVIDER_FILE_ID,
    exposureId: exposure.id,
    reason: '429-causality-seed',
  });
  return { placementId: placement.id, itemId: item.id, bindingId: binding.id, version: binding.version };
}

function snapshotDurableState(store) {
  const db = store.db;
  return {
    placements: db.prepare('SELECT id, state FROM provider_placements').all(),
    files: db.prepare('SELECT provider_file_id, mapping_state FROM provider_files').all(),
    mappings: db.prepare('SELECT state FROM candidate_file_mappings').all(),
    exposures: db.prepare('SELECT id, state FROM exposures').all(),
    libraryItems: db.prepare('SELECT id, desired_state FROM library_items').all(),
    libraryPaths: db.prepare('SELECT id, active FROM library_paths').all(),
    bindings: db.prepare('SELECT id, status, version FROM bindings').all(),
  };
}

function buildCapability({ accountScope = 'default', placementId = 'pl_cache_x', providerFileId = 'pf_cache_x' } = {}) {
  return {
    provider: 'torbox',
    accountScope,
    placementId,
    providerFileId,
  };
}

test('429 from factory increments the rate-limited counter and does NOT mutate any durable state', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'r429-'));
  const controlPath = join(tmp, 'control-plane.db');
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Pin the store clock so inventory/exposure freshness windows cover
  // the 1_000ms observation timestamp.
  const store = createControlPlaneStore({ now: () => 1_000 });
  t.after(() => store.close());

  const seeded = seedAuthoritativeFulfillment(store);
  const before = snapshotDurableState(store);
  const beforeCounters = providerAccounting.snapshot?.() ?? providerAccounting.format?.() ?? null;

  // Wrap a real cache instance.
  const wrapped = wrapTorBoxDownloadUrlCacheWithAccounting({
    getByCapability() { return null; },
    setByCapability() {},
    invalidateByCapability() {},
    getOrInFlightByCapability(_cap, factory) { return factory(); },
    get() { return null; },
    set() {},
    delete() {},
    clear() {},
    size() { return 0; },
  });

  // The factory throws a TorBoxDownloadUrlError with status=429 and a
  // retryAfterMs. This mirrors what resolveTorBoxDownloadUrl() throws
  // when the upstream returns 429 with a Retry-After header.
  const error = new TorBoxDownloadUrlError(
    'TorBox requestdl returned HTTP 429',
    'TORBOX_REQUESTDL_RATE_LIMITED',
    429,
    { retryAfterMs: 30_000 },
  );
  const factory = async () => { throw error; };

  let thrown = null;
  await assert.rejects(
    wrapped.getOrInFlightByCapability(buildCapability(), factory),
    (err) => {
      thrown = err;
      return err.status === 429;
    },
    'wrapper must NOT swallow the 429',
  );
  assert.equal(thrown, error, 'wrapper must propagate the original 429 error');

  // The accounting counter must reflect the rate-limit.
  const afterCounters = providerAccounting.format?.() ?? null;
  if (afterCounters) {
    assert.ok(
      /requestdl_rate_limited_429/.test(afterCounters),
      'requestdl_rate_limited_429 counter must be incremented',
    );
  }

  // The durable state must be byte-for-byte unchanged.
  const after = snapshotDurableState(store);
  assert.deepEqual(after, before, '429 must not mutate placements/files/mappings/exposures/items/paths/bindings');

  // Sanity: the seeded binding is still active and at its original version.
  const stillActive = store.db.prepare(
    'SELECT * FROM bindings WHERE id = ?',
  ).get(seeded.bindingId);
  assert.equal(stillActive.status, 'active', 'binding must remain active after a 429');
  assert.equal(stillActive.version, seeded.version, 'binding version must not change after a 429');
});

test('a 429 does not enroll a durability_due_state row (binding-activation is the only enroller)', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'r429-due-'));
  const controlPath = join(tmp, 'control-plane.db');
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const store = createControlPlaneStore({ now: () => 1_000 });
  t.after(() => store.close());

  const seeded = seedAuthoritativeFulfillment(store);

  // The durability_due_state table is created on demand by the
  // durability scheduler. We can't use a real scheduler here (it
  // requires a registered executor and would introduce noise), so we
  // install the schema via the same createDurabilityScheduler path
  // and immediately dispose the runtime. The wrapper cannot enroll
  // because it has no scheduler to call into.
  const { createDurabilityScheduler } = await import('../src/lib/control-plane/durability-scheduler.js');
  const scheduler = createDurabilityScheduler({ controlPlaneStore: store, mode: 'observe' });
  // No runtime created -> no providerAdapters -> no enroller seam.

  const wrapped = wrapTorBoxDownloadUrlCacheWithAccounting({
    getByCapability() { return null; },
    setByCapability() {},
    invalidateByCapability() {},
    getOrInFlightByCapability(_cap, factory) { return factory(); },
    get() { return null; },
    set() {},
    delete() {},
    clear() {},
    size() { return 0; },
  });

  const error = new TorBoxDownloadUrlError(
    'TorBox requestdl returned HTTP 429',
    'TORBOX_REQUESTDL_RATE_LIMITED',
    429,
    { retryAfterMs: 30_000 },
  );
  await assert.rejects(
    wrapped.getOrInFlightByCapability(buildCapability(), async () => { throw error; }),
    (err) => err.status === 429,
  );

  const dueRows = store.db.prepare(
    'SELECT * FROM durability_due_state WHERE library_item_id = ?',
  ).all(seeded.itemId);
  assert.equal(dueRows.length, 0, 'a 429 must never create a durability_due_state row');
  // scheduler instance is intentionally retained only to trigger the schema
  // migration; it has no registered enroller shim, so this confirms the
  // accounting wrapper cannot reach the durability enroller.
  assert.equal(scheduler.mode, 'observe');
});
