/**
 * Route resurrection for an authoritative TorrentFile.
 *
 * A Binding names the authoritative REPRESENTATION. A provider placement is
 * a ROUTE to those bytes. When every route is exhausted, the representation
 * has not failed — only its delivery has — so the first recovery step must
 * be "find another route to the SAME TorrentFile", not "choose a different
 * representation".
 *
 * These tests pin:
 *   - the seam's contract (bounded, cache-only, cooldown, fail-soft);
 *   - that a class-D byte failure with a SAME-TorrentFile route available
 *     keeps the Binding, the TorrentFile and the consumer projection
 *     identical, and re-forwards the SAME TorrentFile;
 *   - that when no route can be found the request fails closed with the
 *     typed provider failure and NOTHING about the representation changes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';
import { createRouteResurrector } from '../src/lib/vfs/route-resurrection.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = '1234567890abcdef1234567890abcdef12345678';
const SIZE = 4096;

function headers(map) {
  return new Headers(map);
}

function providerResponse(status, { body = '', contentRange = null, extra = {} } = {}) {
  const h = { 'content-type': 'application/octet-stream', ...extra };
  if (contentRange) h['content-range'] = contentRange;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(h),
    async text() { return body; },
    async json() { try { return JSON.parse(body); } catch { return null; } },
    body: (() => {
      const buf = Buffer.from(body);
      return {
        getReader() {
          let sent = false;
          return {
            read: async () => (sent ? { done: true } : (sent = true, { done: false, value: buf })),
            cancel: async () => {},
          };
        },
      };
    })(),
  };
}

function collectingResponse() {
  const chunks = [];
  const written = { status: 0, headers: {} };
  return {
    written,
    chunks,
    get status() { return written.status; },
    get headers() { return written.headers; },
    get headersSent() { return written.status !== 0; },
    writeHead(status, headers) { written.status = status; written.headers = headers ?? {}; return this; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return this; },
    destroy() { written.destroyed = true; },
    once() { return this; },
    on() { return this; },
    removeListener() { return this; },
    emit() { return false; },
    body() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

function request(method, headers_ = {}) {
  const req = {
    method,
    headers: { range: 'bytes=0-99', ...headers_ },
    once() { return req; },
    removeListener() { return req; },
    on() { return req; },
  };
  return req;
}

/** Seed a durable handoff + VFS row + active Binding for one release. */
function seedBoundMovie(cache, store, { mediaId, infoHash, providerFileId = 'pf-1' }) {
  const item = store.ensureLibraryItem({
    mediaType: 'movie', mediaId, title: 'Movie', year: 2024, desiredState: 'present',
  });
  const libraryPath = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash,
    providerResourceId: 'res-1', state: 'ready', ownership: 'owned',
    ownerKey: item.id, provenance: 'test',
  });
  // The inventory observation is what creates the durable TorrentFile row
  // (infoHash + canonical internal path + exact size) and maps the provider
  // file onto it.
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId, path: 'Movie.mkv', name: 'Movie.mkv', size: SIZE, selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9e12 });
  const torrentFile = store.findTorrentFile(infoHash, 'Movie.mkv');
  assert.ok(torrentFile, 'the inventory must create the durable TorrentFile');
  const torrentFileId = torrentFile.id;
  store.recordFileMapping({
    ...createReleaseIdentity(infoHash, null), placementId: placement.id, providerFileId,
    state: 'mapped', method: 'test', authoritative: true,
  });
  const exposure = store.recordExposure({
    placementId: placement.id, providerFileId, transport: 'test', exposureKey: 'exp-1',
    relativePath: 'Movie.mkv', state: 'visible', readOnly: true,
    observedAt: 0, expiresAt: 9e12,
  });
  const binding = store.activateBinding({
    libraryItemId: item.id, libraryPathId: libraryPath.id,
    ...createReleaseIdentity(infoHash, null),
    placementId: placement.id, providerFileId, exposureId: exposure.id, reason: 'test',
  });
  const requestId = cache.persistMediaRequest({ mediaId, mediaType: 'movie', source: 'test' }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId, mediaType: 'movie',
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    filename: 'Movie.mkv',
    provider: 'torbox', providerState: 'cached',
    identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'exact-size bound', selectedAt: 1_700_000_000_000,
    torrentFileId,
  });
  cache.createVfsMovieEntry({
    mediaId, releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    canonicalPath: 'Movies/Movie (2024)/Movie (2024).mkv',
    torrentFileId, size: SIZE, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  });
  return { item, binding, libraryPath, placementId: placement.id, torrentFileId };
}

// ─────────────────────────────────────────────────────────────────────────────
// The seam
// ─────────────────────────────────────────────────────────────────────────────

test('route resurrection asks for a route to the SAME TorrentFile and reports it', async () => {
  const calls = [];
  const resurrector = createRouteResurrector({
    ensureSecondPlacementFn: async (params) => {
      calls.push(params.torrentFileId);
      return { status: 'created', placementId: 'pl-new', providerFileId: 'pf-new' };
    },
    now: () => 1_000,
  });
  const result = await resurrector.resurrect({ torrentFileId: 'tf-1' });
  assert.equal(result.recovered, true);
  assert.equal(result.status, 'created');
  assert.deepEqual(calls, ['tf-1']);
});

test('route resurrection is bounded per TorrentFile (a retry storm cannot storm the provider)', async () => {
  let calls = 0;
  let clock = 1_000;
  const resurrector = createRouteResurrector({
    ensureSecondPlacementFn: async () => { calls += 1; return { status: 'unavailable' }; },
    now: () => clock,
    cooldownMs: 60_000,
  });
  await resurrector.resurrect({ torrentFileId: 'tf-1' });
  await resurrector.resurrect({ torrentFileId: 'tf-1' });
  await resurrector.resurrect({ torrentFileId: 'tf-1' });
  assert.equal(calls, 1, 'one attempt per TorrentFile per cooldown');
  clock += 60_001;
  await resurrector.resurrect({ torrentFileId: 'tf-1' });
  assert.equal(calls, 2, 'the attempt resumes after the cooldown');
});

test('route resurrection never throws and never invents a route', async () => {
  const failing = createRouteResurrector({
    ensureSecondPlacementFn: async () => { throw new Error('provider down'); },
    now: () => 1_000,
  });
  const errored = await failing.resurrect({ torrentFileId: 'tf-1' });
  assert.equal(errored.recovered, false);
  assert.equal(errored.status, 'error');

  const unwired = createRouteResurrector({ now: () => 1_000 });
  const none = await unwired.resurrect({ torrentFileId: 'tf-1' });
  assert.equal(none.recovered, false);
  assert.equal(none.status, 'unavailable');
});

// ─────────────────────────────────────────────────────────────────────────────
// The byte path
// ─────────────────────────────────────────────────────────────────────────────

test('a dead ROUTE does not re-decide the REPRESENTATION when another route to the SAME TorrentFile exists', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createControlPlaneStore();
  t.after(() => { cache.close(); store.close(); });
  const mediaId = 'tt9000001';
  const seeded = seedBoundMovie(cache, store, { mediaId, infoHash: HASH });
  const tfId = seeded.torrentFileId;

  // The data plane first reports class-D exhaustion, then serves the SAME
  // TorrentFile through the resurrected route.
  const forwarded = [];
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    forwarded.push(String(url));
    if (calls === 1) {
      return providerResponse(502, {
        body: JSON.stringify({ error: { code: 'PROVIDER_EXHAUSTED' } }),
        extra: { 'content-type': 'application/json' },
      });
    }
    return providerResponse(206, {
      body: 'x'.repeat(100),
      contentRange: `bytes 0-99/${SIZE}`,
    });
  };

  const resurrector = createRouteResurrector({
    ensureSecondPlacementFn: async (params) => {
      assert.equal(params.torrentFileId, tfId, 'the resurrector must ask for the SAME TorrentFile');
      return { status: 'created', placementId: 'pl-new', providerFileId: 'pf-new' };
    },
    now: () => 1_000,
  });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: store,
    rdClient: null,
    rdResolutionCache: { get: () => null, getOrInFlight: () => { throw new Error('unused'); }, clear() {}, size: () => 0 },
    resolveTorBoxDeliverySeam: async () => { throw new Error('no legacy delivery seam expected'); },
    torBoxDownloadUrlCache: { delete() {}, get() { return null; }, getOrInFlight() { throw new Error('unused'); } },
    routeResurrection: resurrector,
    fetchFn,
  });

  const response = collectingResponse();
  await handler(
    request('GET'),
    response,
    { pathname: '/vfs/Movies/Movie (2024)/Movie (2024).mkv' },
  );

  if (response.status !== 206) console.log('DEBUG body:', response.body().slice(0, 400));
  assert.equal(response.status, 206, 'the resurrected route serves the request');
  assert.equal(forwarded.length, 2, 'exactly one re-forward after the resurrection');
  assert.ok(forwarded.every((u) => u.includes(tfId)),
    `the SAME TorrentFile must be re-forwarded, got ${forwarded.join(',')}`);

  // The representation is untouched: the same Binding, the same TorrentFile.
  const item = store.getLibraryItemByIdentityKey('movie:tt9000001:default');
  const active = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(active.torrentFile.id, tfId, 'the active Binding still names the same TorrentFile');
  assert.equal(active.binding.status, 'active');
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE library_item_id = ?').get(item.id);
  assert.equal(rows.n, 1, 'no new Binding version: a route failure is not a representation change');
});

test('the representation-changing fallback is not reached when the same TorrentFile got a new route', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createControlPlaneStore();
  t.after(() => { cache.close(); store.close(); });
  const mediaId = 'tt9000003';
  const seeded = seedBoundMovie(cache, store, { mediaId, infoHash: HASH });
  const tfId = seeded.torrentFileId;

  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) {
      return providerResponse(502, {
        body: JSON.stringify({ error: { code: 'PROVIDER_EXHAUSTED' } }),
        extra: { 'content-type': 'application/json' },
      });
    }
    return providerResponse(206, { body: 'y'.repeat(100), contentRange: `bytes 0-99/${SIZE}` });
  };

  let alternateLookups = 0;
  const alternateFallback = {
    findUsableAlternate: async () => { alternateLookups += 1; return null; },
    promoteAlternate: async () => { throw new Error('the representation must not be replaced'); },
    buildFallbackTelemetry: () => ({}),
  };

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: store,
    rdClient: null,
    rdResolutionCache: { get: () => null, getOrInFlight: () => { throw new Error('unused'); }, clear() {}, size: () => 0 },
    resolveTorBoxDeliverySeam: async () => { throw new Error('no legacy delivery seam expected'); },
    torBoxDownloadUrlCache: { delete() {}, get() { return null; }, getOrInFlight() { throw new Error('unused'); } },
    alternateFallback,
    routeResurrection: createRouteResurrector({
      ensureSecondPlacementFn: async () => ({ status: 'created', placementId: 'pl-new' }),
      now: () => 1_000,
    }),
    fetchFn,
  });

  const response = collectingResponse();
  await handler(request('GET'), response, { pathname: '/vfs/Movies/Movie (2024)/Movie (2024).mkv' });

  assert.equal(response.status, 206);
  assert.equal(alternateLookups, 0,
    'a route that was repaired for the SAME TorrentFile must not reach the representation-changing fallback');
});

test('the class-D failure records durable route evidence and a transient route never switches the representation', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createControlPlaneStore();
  t.after(() => { cache.close(); store.close(); });
  const mediaId = 'tt9000004';
  const seeded = seedBoundMovie(cache, store, { mediaId, infoHash: HASH });
  const tfId = seeded.torrentFileId;

  const recorded = [];
  const routeFailureRecorder = {
    recordRouteFailures: ({ routes, infoHash }) => {
      recorded.push({ routes, infoHash });
      return { recorded: routes.length, terminal: 0, temporary: routes.length, skipped: 0 };
    },
    clearRouteFailure: () => false,
  };
  const representationPolicy = {
    decide: () => ({ allow: false, reason: 'transient-route' }),
    noteSwitch: () => {},
  };
  let alternateLookups = 0;

  const fetchFn = async () => providerResponse(502, {
    body: JSON.stringify({
      error: {
        code: 'PROVIDER_EXHAUSTED',
        torrent_file_id: tfId,
        routes: [{
          provider: 'torbox', accountScope: 'default',
          providerResourceId: 'TB-1', providerFileId: 'pf-1',
          kind: 'temporary', detail: 'rate-limited',
        }],
      },
    }),
    extra: { 'content-type': 'application/json' },
  });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: store,
    rdClient: null,
    rdResolutionCache: { get: () => null, getOrInFlight: () => { throw new Error('unused'); }, clear() {}, size: () => 0 },
    resolveTorBoxDeliverySeam: async () => { throw new Error('no legacy delivery seam expected'); },
    torBoxDownloadUrlCache: { delete() {}, get() { return null; }, getOrInFlight() { throw new Error('unused'); } },
    alternateFallback: {
      findUsableAlternate: async () => { alternateLookups += 1; return null; },
      promoteAlternate: async () => { throw new Error('the representation must not be replaced'); },
      buildFallbackTelemetry: () => ({}),
    },
    routeFailureRecorder,
    representationPolicy,
    routeResurrection: createRouteResurrector({
      ensureSecondPlacementFn: async () => ({ status: 'unavailable' }),
      now: () => 1_000,
    }),
    fetchFn,
  });

  const response = collectingResponse();
  await handler(request('GET'), response, { pathname: '/vfs/Movies/Movie (2024)/Movie (2024).mkv' });

  assert.equal(recorded.length, 1, 'the failed routes are recorded durably');
  assert.equal(recorded[0].routes.length, 1);
  assert.equal(recorded[0].routes[0].kind, 'temporary');
  assert.equal(recorded[0].infoHash, HASH);
  assert.equal(alternateLookups, 0,
    'a transient route failure must not reach the representation-changing fallback');
  const item = store.getLibraryItemByIdentityKey('movie:tt9000004:default');
  const active = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(active.torrentFile.id, tfId, 'the representation is unchanged');
  assert.equal(active.binding.status, 'active');
});

test('when no route can be found the request fails closed and the representation is untouched', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createControlPlaneStore();
  t.after(() => { cache.close(); store.close(); });
  const mediaId = 'tt9000002';
  const seeded = seedBoundMovie(cache, store, { mediaId, infoHash: OTHER_HASH });
  const tfId = seeded.torrentFileId;

  const fetchFn = async () => providerResponse(502, {
    body: JSON.stringify({ error: { code: 'PROVIDER_EXHAUSTED' } }),
    extra: { 'content-type': 'application/json' },
  });
  const resurrector = createRouteResurrector({
    ensureSecondPlacementFn: async () => ({ status: 'unavailable', reason: 'no-cached-route' }),
    now: () => 1_000,
  });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: store,
    rdClient: null,
    rdResolutionCache: { get: () => null, getOrInFlight: () => { throw new Error('unused'); }, clear() {}, size: () => 0 },
    resolveTorBoxDeliverySeam: async () => { throw new Error('no legacy delivery seam expected'); },
    torBoxDownloadUrlCache: { delete() {}, get() { return null; }, getOrInFlight() { throw new Error('unused'); } },
    routeResurrection: resurrector,
    fetchFn,
  });

  const response = collectingResponse();
  await handler(
    request('GET'),
    response,
    { pathname: '/vfs/Movies/Movie (2024)/Movie (2024).mkv' },
  );

  if (response.status !== 502) console.log('DEBUG body:', response.body().slice(0, 400));
  assert.equal(response.status, 502, 'the typed provider failure is surfaced, never a silent substitute');
  const item = store.getLibraryItemByIdentityKey('movie:tt9000002:default');
  const active = store.getActiveBindingForLibraryItem(item.id);
  assert.equal(active.torrentFile.id, tfId, 'the authoritative TorrentFile is unchanged');
  assert.equal(active.binding.status, 'active', 'the Binding stays authoritative: delivery is degraded, not the representation');
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE library_item_id = ?').get(item.id);
  assert.equal(rows.n, 1, 'no Binding churn on a delivery failure');
});
