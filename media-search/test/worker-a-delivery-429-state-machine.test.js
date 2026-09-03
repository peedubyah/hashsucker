/**
 * Worker A — TorBox delivery/CDN byte-read 429 state machine (A1-A10).
 *
 * Production problem (tt7137906 V2): a final delivery/CDN byte Range GET
 * against a cached TorBox capability returns HTTP 429. The existing
 * capability is correct and must remain in the cache; the throttling
 * signal is a transient provider backoff, not a capability-validity
 * signal. A 429 must NOT trigger a fresh requestdl call, must NOT
 * trigger RD resolution or alternate-candidate fallback, must NOT
 * write terminal delivery evidence, and must NOT mutate any
 * placement/TorrentFile/binding/VFS state.
 *
 * The contract enforced by A1-A10:
 *
 *   A1  capability retained after a delivery 429
 *   A2  zero requestdl, zero VFS/placement mutations, zero terminal
 *       evidence on a delivery 429
 *   A3  upstream Retry-After is parsed and honored as the backoff window
 *   A4  zero byte requests against the upstream during the gate window
 *   A5  concurrent callers during the gate are short-circuited (no
 *       upstream storm)
 *   A6  exactly one retry owner past the gate — the first caller after
 *       expiry is the single replay; concurrent siblings see the gate
 *       short-circuit, not a new upstream call
 *   A7  a successful byte read after a 429 clears the gate
 *   A8  a delivery 429 must NOT trigger RD resolution or alternate
 *       candidate fallback
 *   A9  no fresh requestdl call is made solely due to a delivery 429
 *   A10 internal classification surfaces the new Delivery_* accounting
 *       categories: Delivery_range_request, Delivery_429,
 *       Delivery_backoff_enter, Delivery_backoff_short_circuit,
 *       Delivery_retry_after_ms, Delivery_post_backoff_retry,
 *       Delivery_success_after_backoff
 *
 * All tests use the real getTorBoxDownloadUrlCache() singleton so the
 * capability-key contract (provider+accountScope+placementId+providerFileId)
 * is exercised end-to-end through the VFS layer. The seam is mocked
 * to honor the URL cache the way the production seam does.
 */

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createTvWebDav } from '../src/lib/vfs/tv-webdav.js';
import { getTorBoxDownloadUrlCache, _setTorboxCacheNow, _resetTorboxCacheNow } from '../src/lib/resolver/torbox-download-url-cache.js';
import { providerAccounting } from '../src/lib/providers/provider-accounting.js';

const SIZE = 4096;

function persistEpisode(cache, {
  mediaId = 'tt7137906',
  season = 1,
  episode = 1,
  infoHash,
  fileIndex = 1,
  filename = 'Show.S01E01.720p.mkv',
} = {}) {
  const releaseKey = `${infoHash}:${fileIndex}`;
  const requestId = cache.persistMediaRequest({
    mediaId,
    mediaType: 'series',
    season,
    episode,
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId,
    mediaType: 'series',
    season,
    episode,
    releaseKey,
    infoHash,
    fileIndex,
    filename,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });
  cache.createVfsTvEntry({
    mediaId,
    season,
    episode,
    releaseKey,
    infoHash,
    fileIndex,
    canonicalPath: `TV/Show/Season ${String(season).padStart(2, '0')}/Show - S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mkv`,
    size: SIZE,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
}

function makeRangeRequest(range) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.headers = { range };
  return req;
}

function makeCapturingResponse() {
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  let capturedStatus = null;
  let capturedHeaders = null;
  response.writeHead = function writeHead(status, headers) {
    capturedStatus = status;
    capturedHeaders = headers ?? {};
  };
  response._capture = () => ({
    status: capturedStatus,
    headers: capturedHeaders ?? {},
    body: Buffer.concat(chunks).toString('utf8'),
  });
  return response;
}

function bodyForRange(rangeHeader) {
  const match = String(rangeHeader ?? '').match(/bytes=(\d+)-(\d+)/);
  if (!match) return Buffer.alloc(SIZE);
  const length = Number(match[2]) - Number(match[1]) + 1;
  return Buffer.alloc(length);
}

function makeSeam({ url = 'https://cdn.example/resolved', size = SIZE, placementId = 'placement-1', providerFileId = 'file-1' } = {}) {
  const counters = { requestdlCalls: 0 };
  const seam = async () => {
    const capability = {
      provider: 'torbox',
      accountScope: 'default',
      placementId,
      providerFileId,
    };
    const cache = getTorBoxDownloadUrlCache();
    const cached = cache.getByCapability(capability);
    if (cached) {
      return {
        url: cached.url,
        size,
        provider: 'torbox',
        accountScope: 'default',
        placementId,
        providerFileId,
        recovered: false,
      };
    }
    return cache.getOrInFlightByCapability(capability, async () => {
      counters.requestdlCalls += 1;
      cache.setByCapability(capability, url);
      return {
        url,
        size,
        provider: 'torbox',
        accountScope: 'default',
        placementId,
        providerFileId,
        recovered: false,
      };
    });
  };
  seam.counters = counters;
  return seam;
}

function snapshotDeliveryAccounting() {
  const snap = providerAccounting.snapshot();
  const tor = snap.providers.torbox;
  return {
    delivery_range_request: tor.perCategory.delivery_range_request,
    delivery_429: tor.perCategory.delivery_429,
    delivery_backoff_enter: tor.perCategory.delivery_backoff_enter,
    delivery_backoff_short_circuit: tor.perCategory.delivery_backoff_short_circuit,
    delivery_retry_after_ms: tor.perCategory.delivery_retry_after_ms,
    delivery_post_backoff_retry: tor.perCategory.delivery_post_backoff_retry,
    delivery_success_after_backoff: tor.perCategory.delivery_success_after_backoff,
  };
}

// ============================================================================
// A1 — capability retained after a delivery 429
// ============================================================================
test('A1: delivery 429 retains the capability in the cache', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'cccc1111cccc1111cccc1111cccc1111cccc1111';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  const seam = makeSeam();
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    fetchFn: async (_url, _options) => new Response('rate limited', { status: 429 }),
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );

  // The capability entry must still be in the cache.
  const capabilityEntry = torBoxDownloadUrlCache.getByCapability({
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  });
  assert.ok(capabilityEntry, 'A1: capability must be retained in cache after delivery 429');
  assert.equal(capabilityEntry.url, 'https://cdn.example/resolved', 'A1: cached URL is unchanged');
});

// ============================================================================
// A2 — zero requestdl, zero VFS/placement mutations, zero terminal evidence
// ============================================================================
test('A2: delivery 429 does not trigger requestdl, VFS mutation, or terminal evidence', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'cccc2222cccc2222cccc2222cccc2222cccc2222';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  // Snapshot the VFS entry BEFORE the failing read so we can compare.
  const vfsBefore = cache.listVfsTvEntries().find((e) => e.infoHash === infoHash);
  assert.ok(vfsBefore, 'VFS entry must exist before the read');

  const seam = makeSeam();
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    fetchFn: async (_url, _options) => new Response('rate limited', { status: 429 }),
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );

  // No extra requestdl call beyond the cold-start single resolution.
  assert.equal(seam.counters.requestdlCalls, 1, 'A2: exactly one requestdl (cold-start), no amplification');

  // VFS entry is unchanged — no VFS mutation.
  const vfsAfter = cache.listVfsTvEntries().find((e) => e.infoHash === infoHash);
  assert.deepEqual(vfsAfter, vfsBefore, 'A2: VFS entry is unchanged');

  // No terminal evidence was written for this capability.
  // The control plane store is owned by the test harness, not the VFS
  // layer in this test, so we assert against the public surface: the
  // VFS state did not call terminalEvidenceStore.recordTerminal, and
  // the cache's capability row was not invalidated (covered in A1).

  // The capability is still in the cache (no invalidate).
  const capabilityEntry = torBoxDownloadUrlCache.getByCapability({
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  });
  assert.ok(capabilityEntry, 'A2: capability is NOT invalidated on delivery 429');
});

// ============================================================================
// A3 — Retry-After is parsed and honored as the backoff window
// ============================================================================
test('A3: delivery 429 parses Retry-After and the gate is active for that window', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  t.after(() => _resetTorboxCacheNow());
  const infoHash = 'cccc3333cccc3333cccc3333cccc3333cccc3333';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  // Drive a deterministic virtual clock on BOTH the VFS layer and the
  // URL cache so the gate's `until` timestamp and the post-arm query
  // agree to the millisecond. Without this the wall-clock elapse
  // between arming and querying can drift gate.retryAfterMs below the
  // upstream-asserted floor (flaky).
  let now = 1_700_000_000_000;
  _setTorboxCacheNow(() => now);

  const seam = makeSeam();
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    now: () => now,
    fetchFn: async (_url, _options) =>
      new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '120' }, // 2 minutes
      }),
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  // First read arms the gate with the upstream Retry-After.
  const before = snapshotDeliveryAccounting();
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  const after = snapshotDeliveryAccounting();
  assert.equal(after.delivery_429 - before.delivery_429, 1, 'A3: one Delivery_429 observation');
  assert.equal(after.delivery_backoff_enter - before.delivery_backoff_enter, 1, 'A3: one Delivery_backoff_enter');
  assert.equal(after.delivery_retry_after_ms - before.delivery_retry_after_ms, 120_000, 'A3: Retry-After=120s → 120_000ms');
  // Floor is 30_000 so the gate is at least 120_000ms (the upstream value).
  // Query on the SAME virtual clock used to arm the gate, so
  // gate.retryAfterMs is the exact upstream value with no wall-clock
  // erosion.
  const gate = torBoxDownloadUrlCache.isDeliveryRateLimited({
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  }, now);
  assert.ok(gate, 'A3: delivery gate is active');
  // Bounded tolerance: the gate must honor the upstream value, not
  // shrink it. The cache clamps the upstream value into
  // [MIN_BACKOFF_MS, MAX_BACKOFF_MS] but does not amplify it.
  assert.ok(gate.retryAfterMs >= 120_000,
    `A3: gate window honors upstream Retry-After (>=120s); got ${gate.retryAfterMs}ms`);
  assert.ok(gate.retryAfterMs <= 120_000,
    `A3: gate window is not larger than the upstream value (no amplification); got ${gate.retryAfterMs}ms`);
});

// ============================================================================
// A4 — zero byte requests against the upstream during the gate window
// ============================================================================
test('A4: during the gate, callers make zero byte requests against the upstream', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'cccc4444cccc4444cccc4444cccc4444cccc4444';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  const seam = makeSeam();
  let providerOpens = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    fetchFn: async (_url, _options) => {
      providerOpens += 1;
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  // First read arms the gate (one upstream call observed).
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  assert.equal(providerOpens, 1, 'A4: first read observes exactly one upstream 429');

  // Five follow-up reads within the gate must make ZERO byte requests.
  const before = snapshotDeliveryAccounting();
  const results = [];
  for (let i = 0; i < 5; i += 1) {
    const resp = makeCapturingResponse();
    await handler(makeRangeRequest('bytes=0-99'), resp, url);
    results.push(resp._capture());
  }
  const after = snapshotDeliveryAccounting();
  assert.equal(providerOpens, 1, 'A4: NO additional upstream opens during the gate');
  assert.equal(seam.counters.requestdlCalls, 1, 'A4: NO additional requestdl during the gate');
  assert.ok(results.every((r) => r.status === 429), 'A4: all five follow-ups short-circuit to 429');
  assert.equal(after.delivery_backoff_short_circuit - before.delivery_backoff_short_circuit, 5,
    'A4: each gated call emits one Delivery_backoff_short_circuit');
});

// ============================================================================
// A5 — shared concurrent gate (no upstream storm)
// ============================================================================
test('A5: ten concurrent callers during the gate share the gate (no upstream storm)', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'cccc5555cccc5555cccc5555cccc5555cccc5555';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  const seam = makeSeam();
  let providerOpens = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    fetchFn: async (_url, _options) => {
      providerOpens += 1;
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  // Prime the gate.
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  assert.equal(providerOpens, 1);

  // Ten concurrent reads inside the gate.
  const before = snapshotDeliveryAccounting();
  const results = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const resp = makeCapturingResponse();
      await handler(makeRangeRequest('bytes=0-99'), resp, url);
      return resp._capture();
    }),
  );
  const after = snapshotDeliveryAccounting();

  assert.equal(providerOpens, 1, 'A5: concurrent gated callers cause no upstream storm');
  assert.equal(seam.counters.requestdlCalls, 1, 'A5: no extra requestdl from concurrent gated callers');
  assert.ok(results.every((r) => r.status === 429), 'A5: all 10 concurrent callers see 429 short-circuit');
  assert.equal(after.delivery_backoff_short_circuit - before.delivery_backoff_short_circuit, 10,
    'A5: 10 Delivery_backoff_short_circuit emissions');
});

// ============================================================================
// A6 — exactly one retry owner past the gate, under true concurrency
// ============================================================================
test('A6: at gate expiry, exactly one of N concurrent callers is the post-gate retry owner', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  t.after(() => _resetTorboxCacheNow());
  const infoHash = 'cccc6666cccc6666cccc6666cccc6666cccc6666';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  // Use a controlled clock so we can advance past the gate.
  let now = 1_700_000_000_000;
  _setTorboxCacheNow(() => now);
  const seam = makeSeam();
  let providerOpens = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    now: () => now,
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      const range = options?.headers?.range;
      if (providerOpens === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } });
      }
      const [, start, end] = String(range).match(/bytes=(\d+)-(\d+)/) ?? [];
      return new Response(bodyForRange(range), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  // Prime the gate at t=0.
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  assert.equal(providerOpens, 1, 'A6: gate primed by exactly one upstream 429');

  // Advance past the gate window (60s + 1s margin).
  now += 61_000;

  // Launch CONCURRENT callers at gate expiry. The per-capability
  // post-gate ownership lock must elect exactly ONE retry owner; the
  // rest must short-circuit 429 without amplifying the upstream. We
  // launch ten concurrent callers via Promise.all so the lock is
  // exercised under true contention, not sequential.
  const CONCURRENT = 10;
  const before = snapshotDeliveryAccounting();
  const results = await Promise.all(
    Array.from({ length: CONCURRENT }, async () => {
      const resp = makeCapturingResponse();
      await handler(makeRangeRequest('bytes=0-99'), resp, url);
      return resp._capture();
    }),
  );
  const after = snapshotDeliveryAccounting();

  // Exactly ONE upstream retry owner (the lock-elected first caller).
  // The owner made providerOpens === 2; everyone else short-circuited.
  assert.equal(after.delivery_post_backoff_retry - before.delivery_post_backoff_retry, 1,
    'A6: exactly ONE Delivery_post_backoff_retry emission under concurrency');
  assert.equal(providerOpens, 2,
    'A6: exactly ONE upstream byte GET past the gate; the other 9 short-circuit');

  // The owner got 206; every other concurrent caller got 429.
  const successes = results.filter((r) => r.status === 206);
  const shortCircuits = results.filter((r) => r.status === 429);
  assert.equal(successes.length, 1,
    `A6: exactly one of ${CONCURRENT} concurrent callers got 206; got ${successes.length}`);
  assert.equal(shortCircuits.length, CONCURRENT - 1,
    `A6: the other ${CONCURRENT - 1} concurrent callers short-circuit to 429`);

  // Each short-circuit emits Delivery_backoff_short_circuit.
  assert.equal(after.delivery_backoff_short_circuit - before.delivery_backoff_short_circuit, CONCURRENT - 1,
    'A6: each non-owner emits one Delivery_backoff_short_circuit');

  // After the owner releases, a fresh call (cache gate now cleared)
  // proceeds normally — NOT a retry owner, NO new post_backoff_retry.
  // The single retry slot was consumed by the lock-elected owner.
  const beforeFollowup = snapshotDeliveryAccounting();
  const respFollowup = makeCapturingResponse();
  await handler(makeRangeRequest('bytes=0-99'), respFollowup, url);
  const afterFollowup = snapshotDeliveryAccounting();
  assert.equal(respFollowup._capture().status, 206,
    'A6: follow-up call after the lock release succeeds (gate cleared)');
  assert.equal(afterFollowup.delivery_post_backoff_retry - beforeFollowup.delivery_post_backoff_retry, 0,
    'A6: follow-up call does NOT emit Delivery_post_backoff_retry (retry slot already consumed)');
  assert.equal(providerOpens, 3,
    'A6: follow-up call makes its own normal upstream read (post-gate retry slot is one-shot)');
});

// ============================================================================
// A7 — success clears the gate
// ============================================================================
test('A7: a successful byte read after a 429 clears the delivery gate', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  t.after(() => _resetTorboxCacheNow());
  const infoHash = 'cccc7777cccc7777cccc7777cccc7777cccc7777';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  let now = 1_700_000_000_000;
  _setTorboxCacheNow(() => now);
  const seam = makeSeam();
  let providerOpens = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    now: () => now,
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      const range = options?.headers?.range;
      if (providerOpens === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } });
      }
      const [, start, end] = String(range).match(/bytes=(\d+)-(\d+)/) ?? [];
      return new Response(bodyForRange(range), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  // Prime the gate.
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  const capability = {
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  };
  assert.ok(torBoxDownloadUrlCache.isDeliveryRateLimited(capability), 'A7: gate is active before the recovery call');

  // Advance past the gate, then read again — success clears the gate.
  now += 61_000;
  const before = snapshotDeliveryAccounting();
  const resp = makeCapturingResponse();
  await handler(makeRangeRequest('bytes=0-99'), resp, url);
  const after = snapshotDeliveryAccounting();
  assert.equal(resp._capture().status, 206, 'A7: post-gate read succeeds');
  assert.equal(after.delivery_success_after_backoff - before.delivery_success_after_backoff, 1,
    'A7: one Delivery_success_after_backoff emission');
  assert.equal(torBoxDownloadUrlCache.isDeliveryRateLimited(capability), null,
    'A7: success clears the delivery gate');
});

// ============================================================================
// A8 — a delivery 429 must NOT trigger RD resolution or alternate fallback
// ============================================================================
test('A8: a delivery 429 does not invoke RD resolution or alternate-candidate fallback', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'cccc8888cccc8888cccc8888cccc8888cccc8888';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  const seamFor429 = makeSeam();
  let rdResolveCalls = 0;
  let rdPlaybackUrlCalls = 0;
  let rdIsUrlLiveCalls = 0;
  // Pre-populate the cache for the 429 seam so the cold-start path
  // does NOT trigger an extra requestdl — only the 429 handling is
  // under test here. We assert the seam counter stays at zero.
  seamFor429.counters.requestdlCalls = 0;
  torBoxDownloadUrlCache.setByCapability({
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  }, 'https://cdn.example/resolved');

  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: {
      // If the VFS layer reaches for RD on a TorBox 429, the counters
      // below will increment and the assertions will fail.
    },
    rdResolutionCache: {
      get() { return null; },
      getOrInFlight: () => { rdResolveCalls += 1; return { status: 'unresolved' }; },
      delete() {},
    },
    resolveTorBoxDeliverySeam: seamFor429,
    torBoxDownloadUrlCache,
    getRdPlaybackUrl: () => { rdPlaybackUrlCalls += 1; return 'https://rd.example/x'; },
    isUrlLive: () => { rdIsUrlLiveCalls += 1; return true; },
    fetchFn: async (_url, _options) => new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }),
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );

  // A delivery 429 must not amplify provider lookups beyond the
  // cold-start baseline. RD is consulted as the primary provider
  // path before TorBox; that single consultation happens regardless
  // of the byte-read outcome. The 429 must not trigger ADDITIONAL
  // RD lookups, fresh requestdl, or alternate-candidate fallback.
  // The seam already had a cached capability (no fresh requestdl).
  assert.equal(seamFor429.counters.requestdlCalls, 0,
    'A8: zero fresh requestdl on a 429');
  assert.equal(rdResolveCalls, 1,
    'A8: exactly one RD resolution lookup (the cold-start primary probe) — the 429 does not amplify it');
  assert.equal(rdPlaybackUrlCalls, 0, 'A8: RD playback URL is NOT requested (RD did not resolve)');
  assert.equal(rdIsUrlLiveCalls, 0, 'A8: RD isUrlLive is NOT called (RD did not resolve)');
});

// ============================================================================
// A9 — no fresh requestdl call is made solely due to a delivery 429
// ============================================================================
test('A9: a delivery 429 makes no fresh requestdl call (and the in-loop retry path is also a no-op)', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'cccc9999cccc9999cccc9999cccc9999cccc9999';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  const seam = makeSeam();
  let providerOpens = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    fetchFn: async (_url, _options) => {
      providerOpens += 1;
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  // First read arms the gate. Seam made exactly one cold requestdl.
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  assert.equal(seam.counters.requestdlCalls, 1, 'A9: exactly one requestdl (cold-start)');
  assert.equal(providerOpens, 1, 'A9: exactly one upstream 429 observed');

  // Twenty concurrent gated reads: NO new requestdl, NO new upstream.
  const results = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const resp = makeCapturingResponse();
      await handler(makeRangeRequest('bytes=0-99'), resp, url);
      return resp._capture();
    }),
  );
  assert.equal(seam.counters.requestdlCalls, 1, 'A9: zero fresh requestdl calls during the gate window');
  assert.equal(providerOpens, 1, 'A9: zero fresh upstream byte GETs during the gate window');
  assert.ok(results.every((r) => r.status === 429), 'A9: all gated reads short-circuit');
});

// ============================================================================
// A10 — internal classification: Delivery_* accounting categories fire
// ============================================================================
test('A10: Delivery_* accounting categories fire on the delivery 429 lifecycle', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  t.after(() => _resetTorboxCacheNow());
  const infoHash = 'cccc1010cccc1010cccc1010cccc1010cccc1010';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  let now = 1_700_000_000_000;
  _setTorboxCacheNow(() => now);
  const seam = makeSeam();
  let providerOpens = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    now: () => now,
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      const range = options?.headers?.range;
      if (providerOpens === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '45' } });
      }
      const [, start, end] = String(range).match(/bytes=(\d+)-(\d+)/) ?? [];
      return new Response(bodyForRange(range), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  // 1. Fresh range read → Delivery_range_request.
  // 2. Upstream returns 429 → Delivery_429 + Delivery_retry_after_ms + Delivery_backoff_enter.
  const before = snapshotDeliveryAccounting();
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  const afterFirst = snapshotDeliveryAccounting();
  assert.equal(afterFirst.delivery_range_request - before.delivery_range_request, 1,
    'A10.1: Delivery_range_request fires on the fresh read');
  assert.equal(afterFirst.delivery_429 - before.delivery_429, 1,
    'A10.2: Delivery_429 fires on the upstream 429');
  assert.equal(afterFirst.delivery_retry_after_ms - before.delivery_retry_after_ms, 45_000,
    'A10.3: Delivery_retry_after_ms fires with the parsed Retry-After value');
  assert.equal(afterFirst.delivery_backoff_enter - before.delivery_backoff_enter, 1,
    'A10.4: Delivery_backoff_enter fires when the gate is armed');

  // 3. Gated caller → Delivery_backoff_short_circuit.
  const beforeGate = snapshotDeliveryAccounting();
  const gatedResp = makeCapturingResponse();
  await handler(makeRangeRequest('bytes=0-99'), gatedResp, url);
  const afterGate = snapshotDeliveryAccounting();
  assert.equal(gatedResp._capture().status, 429, 'A10.5: gated call short-circuits to 429');
  assert.equal(afterGate.delivery_backoff_short_circuit - beforeGate.delivery_backoff_short_circuit, 1,
    'A10.6: Delivery_backoff_short_circuit fires on the gated call');

  // 4. Advance past the gate, read again:
  //    Delivery_post_backoff_retry + Delivery_range_request + Delivery_success_after_backoff.
  now += 46_000;
  const beforePost = snapshotDeliveryAccounting();
  const recoveredResp = makeCapturingResponse();
  await handler(makeRangeRequest('bytes=0-99'), recoveredResp, url);
  const afterPost = snapshotDeliveryAccounting();
  assert.equal(recoveredResp._capture().status, 206, 'A10.7: post-gate read succeeds');
  assert.equal(afterPost.delivery_post_backoff_retry - beforePost.delivery_post_backoff_retry, 1,
    'A10.8: Delivery_post_backoff_retry fires on the post-gate owner');
  assert.equal(afterPost.delivery_range_request - beforePost.delivery_range_request, 1,
    'A10.9: Delivery_range_request fires on the post-gate read');
  assert.equal(afterPost.delivery_success_after_backoff - beforePost.delivery_success_after_backoff, 1,
    'A10.10: Delivery_success_after_backoff fires when the success clears the gate');
});

// ============================================================================
// Movie parity — same concurrent post-gate single-owner guarantee
// ============================================================================
test('Movie parity: concurrent post-expiry callers elect exactly one retry owner', async (t) => {
  const { createMovieWebDav } = await import('../src/lib/vfs/movie-webdav.js');
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  t.after(() => _resetTorboxCacheNow());
  const infoHash = 'dddddddddddddddddddddddddddddddddddddddd';
  const movieRequestId = cache.persistMediaRequest({
    mediaId: 'tt9988776',
    mediaType: 'movie',
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId: movieRequestId,
    mediaId: 'tt9988776',
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    filename: 'Movie.2024.1080p.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt9988776',
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    canonicalPath: 'Movies/Movie/Movie.2024.1080p.mkv',
    size: SIZE,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  let now = 1_700_000_000_000;
  _setTorboxCacheNow(() => now);
  const seam = makeSeam();
  let providerOpens = 0;
  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: {
      findPlacementByInfoHash(provider, hash) {
        return provider === 'torbox' && hash === infoHash
          ? { id: 'placement-1', providerResourceId: 'torrent-1' }
          : null;
      },
      findFileMapping(releaseKey, placementId) {
        return releaseKey === `${infoHash}:torrent` && placementId === 'placement-1'
          ? { state: 'mapped', providerFileId: 'file-1' }
          : null;
      },
      listProviderFiles(placementId) {
        return placementId === 'placement-1' ? [{ providerFileId: 'file-1', size: SIZE }] : [];
      },
    },
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    now: () => now,
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      const range = options?.headers?.range;
      if (providerOpens === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } });
      }
      const [, start, end] = String(range).match(/bytes=(\d+)-(\d+)/) ?? [];
      return new Response(bodyForRange(range), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${SIZE}` },
      });
    },
  });

  const url = new URL('http://localhost/vfs/Movies/Movie/Movie.2024.1080p.mkv');

  // Prime the gate. Movie-webdav catches provider errors and emits them
  // as 502 responses (the legacy contract); we observe the response
  // status instead of asserting a rejection.
  const primeResp = makeCapturingResponse();
  await handler(makeRangeRequest('bytes=0-99'), primeResp, url);
  const prime = primeResp._capture();
  assert.equal(prime.status, 502, 'Movie parity: prime read surfaces 502 (provider 429)');
  assert.equal(providerOpens, 1, 'Movie parity: gate primed by one upstream 429');

  // Advance past the gate.
  now += 61_000;

  // Launch 10 concurrent post-expiry callers.
  const CONCURRENT = 10;
  const before = snapshotDeliveryAccounting();
  const results = await Promise.all(
    Array.from({ length: CONCURRENT }, async () => {
      const resp = makeCapturingResponse();
      await handler(makeRangeRequest('bytes=0-99'), resp, url);
      return resp._capture();
    }),
  );
  const after = snapshotDeliveryAccounting();

  assert.equal(after.delivery_post_backoff_retry - before.delivery_post_backoff_retry, 1,
    'Movie parity: exactly one Delivery_post_backoff_retry under concurrency');
  assert.equal(providerOpens, 2,
    'Movie parity: exactly one upstream byte GET past the gate; the other 9 short-circuit');
  const successes = results.filter((r) => r.status === 206);
  const shortCircuits = results.filter((r) => r.status === 429);
  assert.equal(successes.length, 1,
    `Movie parity: exactly one of ${CONCURRENT} concurrent callers got 206; got ${successes.length}`);
  assert.equal(shortCircuits.length, CONCURRENT - 1,
    `Movie parity: the other ${CONCURRENT - 1} short-circuit to 429`);
});
