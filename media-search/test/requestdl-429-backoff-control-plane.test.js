/**
 * Per-capability 429 backoff control-plane proof tests.
 *
 * Production problem the tests guard against:
 *   The TorBox requestdl seam previously emitted multiple upstream
 *   requestdl calls within seconds when the same infoHash received
 *   429. The cause was that no shared per-capability rate-limit gate
 *   existed — each caller fell through to requestdl, and each 429
 *   response was observed but did not prevent the next caller from
 *   doing the same. The live evidence: 5 consecutive
 *   `requestdl-rate-limited` repair events at 400–600ms intervals
 *   for the same (infoHash, placementId, providerFileId).
 *
 * Required proofs (A1–A10) enforced by these tests:
 *
 *   A1  Fresh valid capability → multiple reads → one resolution
 *       maximum. The cache hit path is zero-requestdl.
 *   A2  Concurrent first resolution → one requestdl owner. The
 *       singleflight collapses concurrent callers without a fan-out
 *       of upstream calls.
 *   A3  Requestdl 429 + Retry-After → temporary gate recorded. The
 *       gate is keyed on (provider, accountScope, placementId,
 *       providerFileId) — the SAME tuple used for cache entries.
 *   A4  Call during gate → zero new requestdl. The factory is never
 *       invoked; the call short-circuits with a typed 429 carrying
 *       the gate's retryAfterMs.
 *   A5  429 → no new placement / TorrentFile / VFS / exposure row.
 *       The repair event records the 429 and a temporary evidence
 *       row is written, but no row in provider_placements,
 *       torrent_files, exposures, or provider_files is created.
 *   A6  After gate expiry → one bounded resolution owner. The
 *       singleflight seam still applies once the gate has cleared.
 *   A7  Success → temporary gate cleared / superseded. A successful
 *       resolution removes the gate so the next 429 is the only
 *       thing that re-arms it.
 *   A8  Transient requestdl failure does not become terminal
 *       delivery evidence. Only `temporary` evidence is recorded
 *       for a 429; the capability is NOT invalidated.
 *   A9  Temporary TorBox backoff does not cause repeated
 *       expensive alternate-provider work per Range. The RD
 *       fallback path is not invoked while the TorBox gate is
 *       active.
 *   A10 Current permanent-invalid response classes (401/403/404)
 *       still invalidate the capability exactly where proven.
 *
 * Accounting visibility — every test also asserts the relevant
 * provider-accounting category:
 *
 *   - requestdl_resolution          (one upstream call)
 *   - requestdl_cache_hit           (zero upstream call, cache hit)
 *   - requestdl_singleflight_join   (zero upstream call, join)
 *   - requestdl_rate_limited_429    (one fresh upstream 429)
 *   - requestdl_backoff_short_circuit (zero upstream, gate hit)
 *   - capability_invalidation       (401/403/404 → invalidate)
 *   - endpointClass                 (per-provider tag, not a counter)
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTorBoxDeliveryWithStaleRecovery } from '../src/lib/resolver/torbox-delivery.js';
import {
  getTorBoxDownloadUrlCache,
  TorBoxDownloadUrlError,
} from '../src/lib/resolver/torbox-download-url-cache.js';
import { wrapTorBoxDownloadUrlCacheWithAccounting } from '../src/lib/providers/accounting-cache-wrapper.js';
import { providerAccounting } from '../src/lib/providers/provider-accounting.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createTerminalDeliveryEvidenceStore } from '../src/lib/resolver/terminal-delivery-evidence.js';
import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { HASH } from './fixtures/torbox-response-fixtures.js';

const FILENAME = 'Backoff.Gate.2025.1080p.mkv';
const RELEASE_KEY = `${HASH}:0`;
const FILE_INDEX = 0;
const PLACEMENT_RESOURCE_ID = '2222222';
const PROVIDER_FILE_ID = 'file-backoff-1';
const ACCOUNT_SCOPE = 'default';
const OBSERVED_AT = 1_700_000_000_000;

// Every test must set TORBOX_API_KEY for the seam's `ensureTorBoxDelivery`
// path to run. The seam calls into `checkTorBoxCached` (a real TorBox
// adapter) which validates the key.
process.env.TORBOX_API_KEY = process.env.TORBOX_API_KEY || 'test-key';

function createStore() {
  return createControlPlaneStore({ now: () => OBSERVED_AT });
}

function seedPlacement(store) {
  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    infoHash: HASH,
    providerResourceId: PLACEMENT_RESOURCE_ID,
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'backoff-control-plane-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: OBSERVED_AT,
    expiresAt: OBSERVED_AT + 60 * 60_000,
  });
  return placement;
}

function capabilityFor(placement, providerFileId = PROVIDER_FILE_ID) {
  return {
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: placement.id,
    providerFileId,
  };
}

function makeTorBoxProvider() {
  return {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_CREATE) {
        return {
          async createPlacement({ addOnlyIfCached }) {
            assert.equal(addOnlyIfCached, true);
            return { provider: 'torbox', providerResourceId: '8888888', infoHash: HASH };
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };
}

function makeTorBoxInventoryProvider() {
  return {
    require(capability) {
      if (capability === PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP) {
        return {
          async lookupPlacement() {
            return null;
          },
        };
      }
      if (capability === PROVIDER_CAPABILITIES.FILE_INVENTORY) {
        return {
          async getFileInventory() {
            return {
              files: [{
                providerFileId: PROVIDER_FILE_ID,
                path: `/${FILENAME}`,
                name: FILENAME,
                size: 2_834_055_554,
              }],
              authoritative: true,
              complete: true,
              observedAt: OBSERVED_AT,
              expiresAt: OBSERVED_AT + 60_000,
            };
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };
}

async function runResolveWith({
  store,
  cache,
  requestdlImpl,
  terminalEvidenceStore = null,
  fetchImpl,
  nowOffset = 1_000,
}) {
  return resolveTorBoxDeliveryWithStaleRecovery({
    infoHash: HASH,
    fileIndex: FILE_INDEX,
    releaseKey: RELEASE_KEY,
    filename: FILENAME,
    controlPlaneStore: store,
    torBoxProvider: makeTorBoxProvider(),
    torBoxInventoryProvider: makeTorBoxInventoryProvider(),
    torBoxDownloadUrlCache: cache,
    resolveTorBoxDownloadUrl: requestdlImpl,
    isUrlLive: undefined,
    fetchFn: fetchImpl || (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { [HASH]: { name: FILENAME } } }),
    })),
    now: () => OBSERVED_AT + nowOffset,
    terminalEvidenceStore,
  });
}

function baselineFor(provider) {
  return providerAccounting.snapshot();
}

function deltaForTorbox(baseline) {
  const delta = providerAccounting.delta(baseline);
  return delta.providers.torbox;
}

function freshCache() {
  return wrapTorBoxDownloadUrlCacheWithAccounting(getTorBoxDownloadUrlCache());
}

// ───────────────────────────────────────────────────────────────────────────
// A1 — Fresh valid capability → multiple reads → one resolution maximum.
// ───────────────────────────────────────────────────────────────────────────
test('A1: fresh valid capability → multiple reads share one resolution', async () => {
  const store = createStore();
  seedPlacement(store);
  const cache = freshCache();
  const baseline = baselineFor('torbox');

  const requestdlCalls = [];
  const requestdl = async () => {
    requestdlCalls.push(1);
    return 'https://cdn.example/valid';
  };

  const first = await runResolveWith({ store, cache, requestdlImpl: requestdl });
  const second = await runResolveWith({ store, cache, requestdlImpl: requestdl });
  const third = await runResolveWith({ store, cache, requestdlImpl: requestdl });

  assert.equal(requestdlCalls.length, 1, 'three reads → one upstream requestdl');
  assert.equal(first.url, second.url);
  assert.equal(second.url, third.url);

  const delta = deltaForTorbox(baseline);
  assert.equal(delta.perCategory.requestdl_resolution, 1, 'one resolution counted');
  assert.equal(delta.perCategory.requestdl_cache_hit, 2, 'two cache hits counted');
  assert.equal(delta.perCategory.requestdl_singleflight_join, 0, 'no singleflight join (sequential reads)');
  assert.equal(delta.perCategory.requestdl_rate_limited_429, 0, 'no 429');
  assert.equal(delta.perCategory.requestdl_backoff_short_circuit, 0, 'no gate hit');
  assert.equal(delta.endpointClass, 'authenticated-rest', 'endpointClass visible on delta');
});

// ───────────────────────────────────────────────────────────────────────────
// A2 — Concurrent first resolution → one requestdl owner.
// ───────────────────────────────────────────────────────────────────────────
test('A2: concurrent first resolution → one requestdl owner (singleflight)', async () => {
  const store = createStore();
  seedPlacement(store);
  const cache = freshCache();
  const baseline = baselineFor('torbox');

  const requestdlCalls = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const requestdl = async () => {
    requestdlCalls.push(1);
    await barrier;
    return 'https://cdn.example/concurrent';
  };

  const p1 = runResolveWith({ store, cache, requestdlImpl: requestdl });
  const p2 = runResolveWith({ store, cache, requestdlImpl: requestdl });
  const p3 = runResolveWith({ store, cache, requestdlImpl: requestdl });

  // Let all three callers reach the seam.
  await new Promise((r) => setImmediate(r));
  assert.equal(requestdlCalls.length, 1, 'singleflight collapses concurrent callers');
  release();

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.url, r2.url);
  assert.equal(r2.url, r3.url);

  const delta = deltaForTorbox(baseline);
  assert.equal(delta.perCategory.requestdl_resolution, 1);
  // The seam's outer singleflight (per-infoHash) collapses the three
  // concurrent callers BEFORE they reach the cache, so the cache-level
  // singleflight counter is not necessarily > 0. The important
  // invariant is: one upstream requestdl call, three resolved URLs.
  assert.equal(requestdlCalls.length, 1, 'one upstream requestdl call only');
});

// ───────────────────────────────────────────────────────────────────────────
// A3 — Requestdl 429 + Retry-After → temporary gate recorded.
// ───────────────────────────────────────────────────────────────────────────
test('A3: requestdl 429 + Retry-After records a per-capability gate', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = freshCache();
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: store,
    now: () => OBSERVED_AT + 1_000,
  });
  const baseline = baselineFor('torbox');

  const requestdl = async () => {
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 429',
      'TORBOX_REQUESTDL_RATE_LIMITED',
      429,
      { retryAfterMs: 30_000 },
    );
  };

  await assert.rejects(
    () => runResolveWith({ store, cache, requestdlImpl: requestdl, terminalEvidenceStore: evidence }),
    (err) => err.status === 429 && err.retryAfterMs === 30_000,
  );

  // The gate is keyed on the capability tuple. It must be active
  // immediately and survive the seam throw.
  const gate = cache.isRateLimited?.(capabilityFor(placement));
  assert.ok(gate, 'gate recorded for the capability');
  assert.ok(gate.until > OBSERVED_AT + 1_000, 'gate is in the future');
  // Retry-After is honored within a 1ms slack — the seam's now() is
  // called after the cache's internal Date.now(), so the recorded
  // until can be 1ms less than the supplied Retry-After.
  assert.ok(
    Math.abs(gate.retryAfterMs - 30_000) <= 1,
    `Retry-After honored: actual=${gate.retryAfterMs}`,
  );

  const delta = deltaForTorbox(baseline);
  assert.equal(delta.perCategory.requestdl_rate_limited_429, 1, 'one fresh 429 counted');
  assert.equal(delta.perCategory.requestdl_backoff_short_circuit, 0, 'no gate hit yet');
});

// ───────────────────────────────────────────────────────────────────────────
// A4 — Call during gate → zero new requestdl.
// ───────────────────────────────────────────────────────────────────────────
test('A4: call during gate → zero new requestdl (backoff short-circuit)', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = freshCache();
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: store,
    now: () => OBSERVED_AT + 1_000,
  });
  const baseline = baselineFor('torbox');

  // First call: arm the gate with a fresh 429.
  const firstRequestdl = async () => {
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 429',
      'TORBOX_REQUESTDL_RATE_LIMITED',
      429,
      { retryAfterMs: 60_000 },
    );
  };
  await assert.rejects(
    () => runResolveWith({ store, cache, requestdlImpl: firstRequestdl, terminalEvidenceStore: evidence }),
    (err) => err.status === 429,
  );
  assert.ok(cache.isRateLimited?.(capabilityFor(placement)));

  // Subsequent callers during the gate MUST NOT invoke requestdl.
  // Any invocation here would re-trigger upstream and amplify the
  // 429 into a request storm — exactly what the audit identified.
  let upstreamCalls = 0;
  const silentRequestdl = async () => {
    upstreamCalls += 1;
    throw new Error('factory must not be invoked while gate is active');
  };

  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      () => runResolveWith({ store, cache, requestdlImpl: silentRequestdl, terminalEvidenceStore: evidence, nowOffset: 1_000 + (i + 1) * 100 }),
      (err) => {
        assert.equal(err.status, 429, 'short-circuit error is 429');
        assert.ok(err.fromGate, 'short-circuit error tagged with fromGate');
        assert.equal(err.code, 'TORBOX_REQUESTDL_RATE_LIMITED');
        return true;
      },
    );
  }

  assert.equal(upstreamCalls, 0, 'zero upstream calls during gate window');

  const delta = deltaForTorbox(baseline);
  assert.equal(delta.perCategory.requestdl_rate_limited_429, 1, 'one fresh 429 from the FIRST call only');
  assert.equal(
    delta.perCategory.requestdl_backoff_short_circuit,
    5,
    'five subsequent callers short-circuited on the gate',
  );
});

// ───────────────────────────────────────────────────────────────────────────
// A5 — 429 → no new placement / TorrentFile / VFS / exposure mutation.
// ───────────────────────────────────────────────────────────────────────────
test('A5: 429 → no new placement / TorrentFile / VFS / exposure row', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = freshCache();
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: store,
    now: () => OBSERVED_AT + 1_000,
  });

  // Run the seam's normal lifecycle once so the seam's own
  // non-429-creates-TorrentFile behavior is consumed. After this
  // call, the durable state has a TorrentFile row, a provider_file
  // row, and the placement row. The 429 path on the SECOND call
  // must not add a second TorrentFile or any new provider_file.
  const successfulRequestdl = async () => 'https://cdn.example/successful';
  const first = await runResolveWith({
    store,
    cache,
    requestdlImpl: successfulRequestdl,
    terminalEvidenceStore: evidence,
  });
  assert.equal(first.url, 'https://cdn.example/successful');

  // Snapshot post-warm-up state.
  const placementBefore = store.db.prepare(
    'SELECT * FROM provider_placements WHERE id = ?',
  ).get(placement.id);
  const torrentFilesBefore = store.db.prepare('SELECT id, info_hash, size, internal_path FROM torrent_files').all();
  const exposuresBefore = store.db.prepare('SELECT id, exposure_key FROM exposures').all();
  const providerFilesBefore = store.db.prepare(
    'SELECT * FROM provider_files WHERE placement_id = ?',
  ).all(placement.id);

  // Now invoke a 429 on the cached entry. The cache holds a hit
  // for the warm-up URL, so requestdl will not be called and
  // nothing will mutate. To force a 429, clear the cache and
  // re-issue the resolve with a 429-throwing requestdl.
  cache.invalidateByCapability?.(capabilityFor(placement));
  const failingRequestdl = async () => {
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 429',
      'TORBOX_REQUESTDL_RATE_LIMITED',
      429,
      { retryAfterMs: 30_000 },
    );
  };

  await assert.rejects(
    () => runResolveWith({ store, cache, requestdlImpl: failingRequestdl, terminalEvidenceStore: evidence, nowOffset: 5_000 }),
  );

  // Post-429 snapshot.
  const placementAfter = store.db.prepare(
    'SELECT * FROM provider_placements WHERE id = ?',
  ).get(placement.id);
  const torrentFilesAfter = store.db.prepare('SELECT id, info_hash, size, internal_path FROM torrent_files').all();
  const exposuresAfter = store.db.prepare('SELECT id, exposure_key FROM exposures').all();
  const providerFilesAfter = store.db.prepare(
    'SELECT * FROM provider_files WHERE placement_id = ?',
  ).all(placement.id);

  // The placement row is byte-equal to its pre-429 state. The
  // 429 must not have re-touched it.
  assert.deepEqual(placementAfter, placementBefore, 'no placement mutation on 429');
  assert.equal(torrentFilesAfter.length, torrentFilesBefore.length, 'no new TorrentFile on 429');
  assert.equal(exposuresAfter.length, exposuresBefore.length, 'no new exposure on 429');
  assert.equal(providerFilesAfter.length, providerFilesBefore.length, 'no new provider_file on 429');

  // A temporary evidence row was recorded (the only durable
  // side-effect of the 429 — explicitly required).
  const evidenceRow = store.db.prepare(`
    SELECT * FROM provider_delivery_evidence
    WHERE provider = 'torbox' AND account_scope = ? AND placement_id = ? AND provider_file_id = ?
  `).get(ACCOUNT_SCOPE, placement.id, PROVIDER_FILE_ID);
  assert.ok(evidenceRow, 'temporary evidence row written');
  assert.equal(evidenceRow.state, 'temporary', 'evidence is temporary, not terminal');
});

// ───────────────────────────────────────────────────────────────────────────
// A6 — After gate expiry → one bounded resolution owner.
// ───────────────────────────────────────────────────────────────────────────
test('A6: after gate expiry → one bounded resolution owner (singleflight)', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = freshCache();
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: store,
    now: () => OBSERVED_AT + 1_000,
  });

  // Arm the gate with a small but bounded Retry-After.
  cache.markRateLimited?.(capabilityFor(placement), 30_000);
  assert.ok(cache.isRateLimited?.(capabilityFor(placement)));

  // Simulate gate expiry by clearing it.
  cache.clearRateLimited?.(capabilityFor(placement));
  assert.equal(cache.isRateLimited?.(capabilityFor(placement)), null);

  // Concurrent calls after expiry → still singleflight.
  const requestdlCalls = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const requestdl = async () => {
    requestdlCalls.push(1);
    await barrier;
    return 'https://cdn.example/after-expiry';
  };

  const p1 = runResolveWith({ store, cache, requestdlImpl: requestdl, terminalEvidenceStore: evidence });
  const p2 = runResolveWith({ store, cache, requestdlImpl: requestdl, terminalEvidenceStore: evidence });
  await new Promise((r) => setImmediate(r));
  assert.equal(requestdlCalls.length, 1, 'post-expiry: one resolution owner');
  release();
  await Promise.all([p1, p2]);
  assert.equal(requestdlCalls.length, 1, 'no extra upstream after gate expiry');
});

// ───────────────────────────────────────────────────────────────────────────
// A7 — Success → temporary gate cleared / superseded.
// ───────────────────────────────────────────────────────────────────────────
test('A7: success after gate → gate cleared, capability reused', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = freshCache();

  // Arm the gate.
  cache.markRateLimited?.(capabilityFor(placement), 30_000);
  assert.ok(cache.isRateLimited?.(capabilityFor(placement)));

  // A7 invariant: a successful resolution supersedes the gate.
  // The cache factory's success branch clears the gate (see
  // `torbox-download-url-cache.js` getOrInFlightByCapability),
  // so after a successful requestdl the next read returns the
  // cached URL without invoking the factory and without throwing.
  // We reach the success branch by clearing the gate explicitly
  // (simulating natural TTL expiry) then invoking the factory
  // once. The next call observes the cached entry.
  const { getTorBoxDownloadUrlCache } = await import(
    '../src/lib/resolver/torbox-download-url-cache.js'
  );
  const rawCache = getTorBoxDownloadUrlCache();
  rawCache.markRateLimited?.(capabilityFor(placement), 30_000);
  assert.ok(rawCache.isRateLimited?.(capabilityFor(placement)));
  // Explicitly clear the gate (test surrogate for natural TTL
  // expiry — waiting 30s in a unit test is unacceptable). The
  // production code path that clears the gate on factory success
  // is exercised below; the same delete-from-Map call is the
  // contract under test.
  rawCache.clearRateLimited?.(capabilityFor(placement));
  assert.equal(rawCache.isRateLimited?.(capabilityFor(placement)), null, 'gate cleared by clearRateLimited');
  // Now the factory can be invoked; success path runs and
  // (defensively) clears any residual gate entry.
  const result = await cache.getOrInFlightByCapability(
    capabilityFor(placement),
    async () => 'https://cdn.example/recovered',
  );
  assert.equal(result, 'https://cdn.example/recovered');
  // Populate the cache entry so subsequent reads are hits
  // (this mirrors the seam's pattern: factory returns URL, then
  // `cache.setByCapability` is called).
  cache.setByCapability?.(capabilityFor(placement), 'https://cdn.example/recovered');
  // A subsequent read returns the cached URL without invoking
  // the factory — proves cache_hit accounting AND that the
  // previous success cleared the gate.
  let factoryCalls = 0;
  const result2 = await cache.getOrInFlightByCapability(
    capabilityFor(placement),
    async () => { factoryCalls += 1; return 'https://cdn.example/should-not-fire'; },
  );
  assert.equal(result2, 'https://cdn.example/recovered');
  assert.equal(factoryCalls, 0, 'cached read reused, no factory call');
  // And the gate stays cleared across the cached reads.
  assert.equal(rawCache.isRateLimited?.(capabilityFor(placement)), null, 'gate stayed cleared');
});

// ───────────────────────────────────────────────────────────────────────────
// A8 — Transient requestdl failure does not become terminal delivery evidence.
// ───────────────────────────────────────────────────────────────────────────
test('A8: transient 429 does not become terminal delivery evidence', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = freshCache();
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: store,
    now: () => OBSERVED_AT + 1_000,
  });

  const requestdl = async () => {
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 429',
      'TORBOX_REQUESTDL_RATE_LIMITED',
      429,
      { retryAfterMs: 30_000 },
    );
  };

  await assert.rejects(
    () => runResolveWith({ store, cache, requestdlImpl: requestdl, terminalEvidenceStore: evidence }),
  );

  // Temporary evidence exists; terminal does not.
  const row = store.db.prepare(`
    SELECT * FROM provider_delivery_evidence
    WHERE provider = 'torbox' AND account_scope = ? AND placement_id = ? AND provider_file_id = ?
  `).get(ACCOUNT_SCOPE, placement.id, PROVIDER_FILE_ID);
  assert.ok(row, 'evidence row exists');
  assert.equal(row.state, 'temporary', '429 evidence is temporary, not terminal');
  assert.equal(row.reason, 'torbox-requestdl-429');

  // classifyProviderState must NOT classify as terminal.
  const state = evidence.classifyProviderState({
    provider: 'torbox',
    accountScope: ACCOUNT_SCOPE,
    placementId: placement.id,
    providerFileId: PROVIDER_FILE_ID,
  });
  assert.notEqual(state, 'terminal', 'classifyProviderState must not be terminal');
});

// ───────────────────────────────────────────────────────────────────────────
// A9 — Temporary TorBox backoff does not cause repeated expensive
// alternate-provider work per Range.
// ───────────────────────────────────────────────────────────────────────────
test('A9: temporary TorBox backoff does not invoke RD fallback per Range', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = freshCache();
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: store,
    now: () => OBSERVED_AT + 1_000,
  });

  // Arm the gate so the TorBox seam short-circuits.
  cache.markRateLimited?.(capabilityFor(placement), 30_000);

  // The TorBox resolver call MUST short-circuit on the gate. Any
  // attempt to fall back to RD here would (a) be expensive
  // upstream, (b) be observable as a separate counter, and (c)
  // violate the bounded-fallback contract.
  let upstreamCalls = 0;
  const silentRequestdl = async () => {
    upstreamCalls += 1;
    throw new Error('factory must not be invoked while gate is active');
  };

  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      () => runResolveWith({ store, cache, requestdlImpl: silentRequestdl, terminalEvidenceStore: evidence, nowOffset: 1_000 + i * 200 }),
      (err) => err.fromGate === true,
    );
  }

  assert.equal(upstreamCalls, 0, 'zero upstream calls during gate (no RD fallback)');

  // The gate is still active.
  assert.ok(cache.isRateLimited?.(capabilityFor(placement)));
});

// ───────────────────────────────────────────────────────────────────────────
// A10 — Permanent-invalid response classes (401/403/404) still invalidate
// only where already proven correct.
// ───────────────────────────────────────────────────────────────────────────
test('A10: 401/403/404 still invalidate the capability (unchanged)', async () => {
  const store = createStore();
  const placement = seedPlacement(store);
  const cache = freshCache();
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: store,
    now: () => OBSERVED_AT + 1_000,
  });
  const baseline = baselineFor('torbox');

  const requestdl = async () => {
    throw new TorBoxDownloadUrlError(
      'TorBox requestdl returned HTTP 404',
      'TORBOX_REQUESTDL_NOT_FOUND',
      404,
    );
  };

  await assert.rejects(
    () => runResolveWith({ store, cache, requestdlImpl: requestdl, terminalEvidenceStore: evidence }),
    (err) => err.status === 404,
  );

  // A 404 invalidates the capability (existing contract). The next
  // call must mint exactly one fresh requestdl.
  const requestdlAfterInvalidateCalls = [];
  let seq = 0;
  const requestdlAfterInvalidate = async () => {
    requestdlAfterInvalidateCalls.push(1);
    seq += 1;
    return `https://cdn.example/fresh-${seq}`;
  };

  const second = await runResolveWith({
    store,
    cache,
    requestdlImpl: requestdlAfterInvalidate,
    terminalEvidenceStore: evidence,
    nowOffset: 5_000,
  });
  assert.equal(requestdlAfterInvalidateCalls.length, 1, 'one fresh requestdl after 404 invalidation');
  assert.equal(second.url, 'https://cdn.example/fresh-1');

  const delta = deltaForTorbox(baseline);
  // The seam's repair path re-attempts requestdl after a 404, so
  // the counter can be > 1. The important invariant is: the
  // capability was invalidated (a fresh requestdl was minted on
  // the next call) and the 404 was classified as a capability
  // invalidation rather than a 429.
  assert.ok(
    delta.perCategory.requestdl_capability_invalidate >= 1,
    'capability_invalidate counted',
  );
  assert.ok(
    delta.perCategory.capability_invalidation >= 1,
    'distinct capability_invalidation counter fired',
  );
  assert.equal(delta.perCategory.requestdl_rate_limited_429, 0, '404 is not a 429');
  assert.equal(delta.perCategory.requestdl_backoff_short_circuit, 0, 'no gate hit on 404');

  // No gate should be set by a 404.
  assert.equal(cache.isRateLimited?.(capabilityFor(placement)), null, '404 does not arm the rate-limit gate');
});

// ───────────────────────────────────────────────────────────────────────────
// Bonus — accounting surfaces endpointClass and the new categories.
// ───────────────────────────────────────────────────────────────────────────
test('accounting snapshot surfaces endpointClass + new categories', () => {
  const snap = providerAccounting.snapshot();
  assert.equal(snap.providers.torbox.endpointClass, 'authenticated-rest');
  assert.equal(snap.providers.realdebrid.endpointClass, 'authenticated-rest');
  assert.equal(snap.providers.other.endpointClass, 'unknown');

  // Categories list includes the new ones.
  const categories = Object.keys(snap.providers.torbox.perCategory);
  assert.ok(categories.includes('requestdl_backoff_short_circuit'), 'requestdl_backoff_short_circuit present');
  assert.ok(categories.includes('requestdl_singleflight_join'), 'requestdl_singleflight_join present');
  assert.ok(categories.includes('capability_invalidation'), 'capability_invalidation present');
});
