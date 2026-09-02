/**
 * VFS TorBox per-file capability-churn regression tests (B1-B10).
 *
 * Production problem (tt7137906 V2): warm Plex/VFS range reads against a
 * single TorBox per-file capability were amplifying into repeated
 * requestdl calls because the VFS byte-read loop invalidated the cached
 * CDN URL on every non-429 outcome, including transient 5xx, local
 * range-mismatch rejections against a 206 response, network transport
 * blips, and client aborts. With 27 requestdl calls and 26 invalidations
 * across 4 files (cache_hit=25, 429=13, retries=0), every Plex range
 * probe effectively churned the URL cache.
 *
 * These tests assert the precise capability-churn contract:
 *
 *   B1  warm sequential range reads reuse the cached capability
 *   B2  warm concurrent range reads reuse the cached capability
 *   B3  cold same-file five-way single-flight yields exactly one
 *       requestdl (in-flight dedup)
 *   B4  four cold siblings (distinct providerFileIds) each get exactly
 *       one resolution — no cross-file sharing
 *   B5  client abort retains the capability
 *   B6  network/transport throw retains the capability
 *   B7  upstream 5xx retains the capability
 *   B8  upstream 429 retains the capability AND back-pressures the
 *       state so subsequent reads short-circuit (no retry storm)
 *   B9  definitive upstream capability failure (401/403/404/410)
 *       performs exact-key replacement — the next read re-resolves once
 *   B10 local 416 (impossible byte range) does zero provider work — the
 *       capability is untouched
 *
 * All tests use the real getTorBoxDownloadUrlCache() singleton so the
 * capability-key contract (provider+accountScope+placementId+providerFileId)
 * is exercised end-to-end through the VFS layer. The seam is mocked to
 * honor the URL cache the way the production seam does: a cache hit
 * returns the cached URL with no new requestdl call; a cache miss
 * triggers exactly one requestdl that stores the result. The
 * `requestdlCalls` counter therefore tracks the cache miss path —
 * which is the real "churn" metric the production system exposes.
 */

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createTvWebDav } from '../src/lib/vfs/tv-webdav.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';
import { getTorBoxDownloadUrlCache } from '../src/lib/resolver/torbox-download-url-cache.js';

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

function persistMovie(cache, {
  mediaId,
  infoHash,
  filename = 'Movie.2024.1080p.mkv',
  fileIndex = null,
} = {}) {
  const releaseKey = `${infoHash}:torrent`;
  const requestId = cache.persistMediaRequest({
    mediaId,
    mediaType: 'movie',
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
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
  cache.createVfsMovieEntry({
    mediaId,
    releaseKey,
    infoHash,
    fileIndex,
    canonicalPath: 'Movies/Movie (2024)/Movie (2024).mkv',
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

/**
 * Build a body of exactly the byte length that the requested Range
 * advertises (end - start + 1). The body validator enforces this
 * strictly, so test mocks must not invent shorter / longer payloads
 * just to be readable — they have to match the requested Range or
 * the response is correctly rejected as protocol-invalid. For a
 * full-file (no Range) request we return the full SIZE.
 */
function bodyForRange(rangeHeader) {
  const match = String(rangeHeader ?? '').match(/bytes=(\d+)-(\d+)/);
  if (!match) return Buffer.alloc(SIZE);
  const length = Number(match[2]) - Number(match[1]) + 1;
  return Buffer.alloc(length);
}

/**
 * Build a seam that mirrors the real one: it consults
 * torBoxDownloadUrlCache first, then on a miss it performs a single
 * requestdl (counted by `requestdlCalls`) and stores the result. This
 * is the *real* churn metric: each `requestdlCalls` represents a
 * network call to the provider's requestdl endpoint.
 */
function makeSeam({ url = 'https://cdn.example/resolved', size = SIZE } = {}) {
  const counters = { requestdlCalls: 0 };
  const seam = async () => {
    const capability = {
      provider: 'torbox',
      accountScope: 'default',
      placementId: 'placement-1',
      providerFileId: 'file-1',
    };
    const cache = getTorBoxDownloadUrlCache();
    const cached = cache.getByCapability(capability);
    if (cached) {
      return {
        url: cached.url,
        size,
        provider: 'torbox',
        accountScope: 'default',
        placementId: 'placement-1',
        providerFileId: 'file-1',
        recovered: false,
      };
    }
    // Cache miss: use getOrInFlightByCapability so concurrent
    // resolvers dedup on the same in-flight promise.
    return cache.getOrInFlightByCapability(capability, async () => {
      counters.requestdlCalls += 1;
      cache.setByCapability(capability, url);
      return {
        url,
        size,
        provider: 'torbox',
        accountScope: 'default',
        placementId: 'placement-1',
        providerFileId: 'file-1',
        recovered: false,
      };
    });
  };
  seam.counters = counters;
  return seam;
}

/**
 * Build a per-sibling seam that respects a per-sibling capability key.
 */
function makeSiblingSeam() {
  const counters = { requestdlCalls: 0 };
  const seam = async (request) => {
    const capability = {
      provider: 'torbox',
      accountScope: 'default',
      placementId: 'placement-1',
      providerFileId: 'file-1',
      ...(request?.capability ?? {}),
    };
    const cache = getTorBoxDownloadUrlCache();
    const cached = cache.getByCapability(capability);
    if (cached) {
      return {
        url: cached.url,
        size: SIZE,
        provider: 'torbox',
        accountScope: 'default',
        placementId: capability.placementId,
        providerFileId: capability.providerFileId,
        recovered: false,
      };
    }
    return cache.getOrInFlightByCapability(capability, async () => {
      counters.requestdlCalls += 1;
      const url = `https://cdn.example/sibling-${capability.providerFileId}`;
      cache.setByCapability(capability, url);
      return {
        url,
        size: SIZE,
        provider: 'torbox',
        accountScope: 'default',
        placementId: capability.placementId,
        providerFileId: capability.providerFileId,
        recovered: false,
      };
    });
  };
  seam.counters = counters;
  return seam;
}

// ---------------------------------------------------------------------------
// B1 — warm sequential ranges reuse the cached capability.
// ---------------------------------------------------------------------------
test('B1: warm sequential range reads reuse the cached capability — no extra requestdl', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111';
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
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      return new Response(bodyForRange(options.headers.range), {
        status: 206,
        headers: { 'content-range': `bytes ${options.headers.range.split('=')[1]}/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  const responses = [];
  for (const range of ['bytes=0-99', 'bytes=100-199', 'bytes=200-299', 'bytes=300-399', 'bytes=400-499']) {
    const resp = makeCapturingResponse();
    await handler(makeRangeRequest(range), resp, url);
    responses.push(resp._capture());
  }

  assert.equal(responses.length, 5);
  assert.ok(responses.every((r) => r.status === 206), 'all five reads must succeed');
  assert.equal(seam.counters.requestdlCalls, 1, 'warm reads must not re-invoke requestdl');
  assert.equal(providerOpens, 5, 'each read still opens the upstream byte range');
  assert.equal(torBoxDownloadUrlCache.size(), 1, 'exactly one capability entry retained');
});

// ---------------------------------------------------------------------------
// B2 — warm concurrent ranges reuse the cached capability.
// ---------------------------------------------------------------------------
test('B2: warm concurrent range reads reuse the cached capability — one requestdl total', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
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
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      return new Response(bodyForRange(options.headers.range), {
        status: 206,
        headers: { 'content-range': `bytes ${options.headers.range.split('=')[1]}/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  // Prime the cache.
  await handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url);
  assert.equal(seam.counters.requestdlCalls, 1);
  // Ten concurrent reads.
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, i) => {
      const resp = makeCapturingResponse();
      return handler(makeRangeRequest(`bytes=${i * 100}-${i * 100 + 99}`), resp, url)
        .then(() => resp._capture());
    }),
  );
  assert.ok(responses.every((r) => r.status === 206));
  assert.equal(seam.counters.requestdlCalls, 1, 'concurrent warm reads must not amplify requestdl');
  assert.equal(providerOpens, 11, 'each concurrent read still hits the upstream');
});

// ---------------------------------------------------------------------------
// B3 — cold same-file five-way single-flight yields exactly one requestdl.
// ---------------------------------------------------------------------------
test('B3: cold same-file five-way single-flight yields exactly one requestdl', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'bbbb3333bbbb3333bbbb3333bbbb3333bbbb3333';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  // Slow seam so all five requests pile up on the in-flight single-flight.
  let releaseSeam;
  const seamGate = new Promise((resolve) => { releaseSeam = resolve; });
  const requestdlCalls = { count: 0 };
  const seam = async () => {
    const capability = {
      provider: 'torbox',
      accountScope: 'default',
      placementId: 'placement-1',
      providerFileId: 'file-1',
    };
    const cache = getTorBoxDownloadUrlCache();
    return cache.getOrInFlightByCapability(capability, async () => {
      requestdlCalls.count += 1;
      await seamGate;
      const url = 'https://cdn.example/cold-five';
      cache.setByCapability(capability, url);
      return {
        url,
        size: SIZE,
        provider: 'torbox',
        accountScope: 'default',
        placementId: 'placement-1',
        providerFileId: 'file-1',
        recovered: false,
      };
    });
  };

  let providerOpens = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      return new Response(bodyForRange(options.headers.range), {
        status: 206,
        headers: { 'content-range': `bytes ${options.headers.range.split('=')[1]}/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  const inFlight = Array.from({ length: 5 }, (_, i) => {
    const resp = makeCapturingResponse();
    return handler(makeRangeRequest(`bytes=${i * 100}-${i * 100 + 99}`), resp, url)
      .then(() => resp._capture());
  });
  // Yield twice so all five enter openValidatedProviderRead before we release.
  await Promise.resolve();
  await Promise.resolve();
  releaseSeam();

  const responses = await Promise.all(inFlight);
  assert.ok(responses.every((r) => r.status === 206));
  assert.equal(requestdlCalls.count, 1, 'five cold reads must dedup to one requestdl');
  assert.equal(providerOpens, 5, 'each read still opens its own byte range');
});

// ---------------------------------------------------------------------------
// B4 — four cold siblings each get exactly one resolution.
// ---------------------------------------------------------------------------
test('B4: four cold siblings (distinct providerFileIds) — one resolution each, no cross-file sharing', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  // Four distinct TV episodes sharing the same infoHash but each
  // with its own fileIndex and providerFileId. The capability key
  // is per-file, so each gets its own URL resolution. Movies share a
  // single releaseKey so the four-sibling property is exercised via
  // TV file identity.
  const infoHash = 'bbbb4444bbbb4444bbbb4444bbbb4444bbbb4444';
  for (const idx of [0, 1, 2, 3]) {
    persistEpisode(cache, {
      mediaId: `tt7137906-episode-${idx}`,
      season: 1,
      episode: idx + 1,
      infoHash,
      fileIndex: idx,
      filename: `Show.S01E${String(idx + 1).padStart(2, '0')}.mkv`,
    });
  }

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  const seam = makeSiblingSeam();
  const seenFileIds = new Set();

  function makeHandler(mediaId, fileIndex) {
    return createTvWebDav({
      searchCache: cache,
      rdClient: null,
      rdResolutionCache: { delete() {}, get() { return null; }, async getOrInFlight() { throw new Error('unused'); } },
      resolveTorBoxDeliverySeam: async (request) => {
        const capability = {
          provider: 'torbox',
          accountScope: 'default',
          placementId: 'placement-1',
          providerFileId: `file-${fileIndex + 1}`,
        };
        const result = await seam({ ...request, capability });
        seenFileIds.add(capability.providerFileId);
        return result;
      },
      torBoxDownloadUrlCache,
      fetchFn: async (_url, options) => new Response(bodyForRange(options.headers.range), {
        status: 206,
        headers: { 'content-range': `bytes ${options.headers.range.split('=')[1]}/${SIZE}` },
      }),
    });
  }

  for (const idx of [0, 1, 2, 3]) {
    const mediaId = `tt7137906-episode-${idx}`;
    const handler = makeHandler(mediaId, idx);
    // The VFS URL pattern is /vfs/TV/{Show}/Season 01/{file}.mkv —
    // each episode's filename encodes its episode number.
    const path = `TV/Show/Season%2001/Show%20-%20S01E${String(idx + 1).padStart(2, '0')}.mkv`;
    const url = new URL(`http://localhost/vfs/${path}`);
    const resp = makeCapturingResponse();
    await handler(makeRangeRequest('bytes=0-99'), resp, url);
    assert.equal(resp._capture().status, 206, `sibling ${idx} must read 206`);
  }

  assert.equal(seam.counters.requestdlCalls, 4, 'four siblings must each trigger exactly one requestdl');
  assert.deepEqual([...seenFileIds].sort(), ['file-1', 'file-2', 'file-3', 'file-4']);
  assert.equal(torBoxDownloadUrlCache.size(), 4, 'four distinct capability entries');
});

// ---------------------------------------------------------------------------
// B5 — client abort retains the capability.
// ---------------------------------------------------------------------------
test('B5: client abort retains the capability', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'bbbb5555bbbb5555bbbb5555bbbb5555bbbb5555';
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
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      if (providerOpens === 1) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return new Response(bodyForRange(options.headers.range), {
        status: 206,
        headers: { 'content-range': `bytes 0-99/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);
  await handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url);
  assert.equal(providerOpens, 2, 'one abort + one retry succeeds');
  assert.equal(seam.counters.requestdlCalls, 1, 'abort did NOT amplify into a second requestdl');

  const capabilityEntry = torBoxDownloadUrlCache.getByCapability({
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  });
  assert.ok(capabilityEntry, 'capability must be retained on transport abort');
});

// ---------------------------------------------------------------------------
// B6 — network/transport throw retains the capability.
// ---------------------------------------------------------------------------
test('B6: transport throw (network reset / DNS) retains the capability', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'bbbb6666bbbb6666bbbb6666bbbb6666bbbb6666';
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
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      if (providerOpens === 1) {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      return new Response(bodyForRange(options.headers.range), {
        status: 206,
        headers: { 'content-range': `bytes 0-99/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);
  await handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url);
  assert.equal(providerOpens, 2, 'one network throw + one retry');
  assert.equal(seam.counters.requestdlCalls, 1, 'network throw did NOT amplify into a second requestdl');

  const capabilityEntry = torBoxDownloadUrlCache.getByCapability({
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  });
  assert.ok(capabilityEntry, 'capability must be retained on transport reset');
});

// ---------------------------------------------------------------------------
// B7 — upstream 5xx retains the capability.
// ---------------------------------------------------------------------------
test('B7: upstream 5xx retains the capability', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'bbbb7777bbbb7777bbbb7777bbbb7777bbbb7777';
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
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      if (providerOpens === 1) {
        return new Response('bad gateway', { status: 502 });
      }
      return new Response(bodyForRange(options.headers.range), {
        status: 206,
        headers: { 'content-range': `bytes 0-99/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);
  await handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url);
  assert.equal(providerOpens, 2, 'one 5xx + one retry');
  assert.equal(seam.counters.requestdlCalls, 1, '5xx did NOT amplify into a second requestdl');

  const capabilityEntry = torBoxDownloadUrlCache.getByCapability({
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  });
  assert.ok(capabilityEntry, 'capability must be retained on 5xx');
});

// ---------------------------------------------------------------------------
// B8 — upstream 429 retains AND back-pressures (no retry storm).
// ---------------------------------------------------------------------------
test('B8: upstream 429 retains the capability AND back-pressures without storming', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'bbbb8888bbbb8888bbbb8888bbbb8888bbbb8888';
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
      return new Response('rate limited', { status: 429 });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);

  // First read primes the gate.
  await assert.rejects(
    handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );
  assert.equal(providerOpens, 1);
  assert.equal(seam.counters.requestdlCalls, 1);

  // Five subsequent reads within the backoff window must short-circuit.
  const secondaries = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const resp = makeCapturingResponse();
      await handler(makeRangeRequest('bytes=0-99'), resp, url);
      return resp._capture();
    }),
  );
  assert.ok(secondaries.every((r) => r.status === 429), 'all five subsequent reads short-circuit to 429');
  assert.equal(seam.counters.requestdlCalls, 1, '429 backoff: NO extra requestdl');
  assert.equal(providerOpens, 1, '429 backoff: NO extra upstream open');

  const capabilityEntry = torBoxDownloadUrlCache.getByCapability({
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  });
  assert.ok(capabilityEntry, 'capability MUST remain valid through the backoff window');
});

// ---------------------------------------------------------------------------
// B9 — definitive upstream capability failure (401/403/404/410) → exact-key
//      replacement; the next read re-resolves once.
// ---------------------------------------------------------------------------
test('B9: definitive upstream 404 invalidates exact key and the next read re-resolves once', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'bbbb9999bbbb9999bbbb9999bbbb9999bbbb9999';
  persistEpisode(cache, { infoHash, fileIndex: 1 });

  const torBoxDownloadUrlCache = getTorBoxDownloadUrlCache();
  torBoxDownloadUrlCache.clear();

  // Pre-populate the cache with a "stale" URL so we can verify exact
  // key replacement after the definitive 404.
  const capabilityKey = {
    provider: 'torbox',
    accountScope: 'default',
    placementId: 'placement-1',
    providerFileId: 'file-1',
  };
  torBoxDownloadUrlCache.setByCapability(capabilityKey, 'https://cdn.example/STALE');

  const seam = makeSeam();
  let providerOpens = 0;
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: seam,
    torBoxDownloadUrlCache,
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      if (providerOpens === 1) {
        return new Response('gone', { status: 404 });
      }
      // Extract start/end from the requested range so the response is
      // consistent across both the retry and the follow-up read.
      const [, start, end] = (options.headers.range ?? 'bytes=0-0').match(/bytes=(\d+)-(\d+)/) ?? [];
      return new Response(bodyForRange(options.headers.range), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${SIZE}` },
      });
    },
  });

  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);
  await handler(makeRangeRequest('bytes=0-99'), makeCapturingResponse(), url);
  assert.equal(providerOpens, 2);

  // After a definitive 404, the capability was evicted and the retry
  // re-resolved. A NEW URL is in the cache.
  const after = torBoxDownloadUrlCache.getByCapability(capabilityKey);
  assert.ok(after, 'a fresh capability must be present after definitive invalidation');
  assert.equal(after.url, 'https://cdn.example/resolved', 'cache holds the post-invalidation URL');
  assert.notEqual(after.url, 'https://cdn.example/STALE', 'exact-key replacement must evict the stale entry');

  // A second read after the retry must reuse the cached URL — only ONE
  // re-resolution happens per definitive invalidation event.
  seam.counters.requestdlCalls = 0;
  await handler(makeRangeRequest('bytes=100-199'), makeCapturingResponse(), url);
  assert.equal(seam.counters.requestdlCalls, 0, 'no extra requestdl after definitive replacement');
  assert.equal(providerOpens, 3, 'the second read opens its own byte range');
});

// ---------------------------------------------------------------------------
// B10 — local 416 (impossible byte range) does zero provider work.
// ---------------------------------------------------------------------------
test('B10: local 416 does zero provider work — capability untouched', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  const infoHash = 'bbbb1010bbbb1010bbbb1010bbbb1010bbbb1010';
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
      return new Response('never', { status: 200 });
    },
  });

  // Range past EOF: bytes=99999-100000 against a 4096-byte file.
  const url = new URL(`http://localhost/vfs/TV/Show/Season%2001/Show%20-%20S01E01.mkv`);
  const resp = makeCapturingResponse();
  await handler(makeRangeRequest('bytes=99999-100000'), resp, url);
  const captured = resp._capture();
  assert.equal(captured.status, 416, 'locally-rejected range must surface 416');
  assert.equal(providerOpens, 0, 'NO provider work for locally-rejected range');
  assert.equal(seam.counters.requestdlCalls, 0, 'NO requestdl for locally-rejected range');
  assert.equal(torBoxDownloadUrlCache.size(), 0, 'no capability entry created for local 416');
});