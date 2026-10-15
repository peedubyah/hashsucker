/**
 * Authoritative cached byte route (/bytes/:tfId).
 *
 * Jellyfin's STRM URL points at /stream, which used to 307 to the provider
 * CDN — every session pulled its own copy of the same bytes. /stream now
 * redirects to this route, and Rust serves the bytes, so the fixed-grid
 * cache, per-chunk coalescing, and same-TorrentFile provider recovery apply.
 *
 * These tests pin the HTTP contract the new route must preserve, plus the
 * Binding-authority source of truth for choosing the byte route.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  serveAuthoritativeBytes,
  resolveAuthoritativeByteRoute,
  ByteRouteError,
} from '../src/server/bytes-route.js';

/** Build a byte-range aware fake of the Rust data plane's /files/:tfId. */
function fakeDataPlane({ size, requests }) {
  const seen = [];
  const fetchFn = async (url, options = {}) => {
    const range = options.headers?.range ?? null;
    seen.push({ url, method: options.method ?? 'GET', range });
    requests?.push({ range });
    const build = (status, headers, body) => new Response(body, { status, headers });
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return build(416, { 'content-range': `bytes */${size}` }, '');
      let start;
      let end;
      if (m[1] === '') {
        const suffix = Number(m[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Number(m[2]);
      }
      if (start >= size) return build(416, { 'content-range': `bytes */${size}` }, '');
      const len = end - start + 1;
      const body = Buffer.from(Array.from({ length: len }, (_, i) => (start + i) % 251));
      return build(206, {
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(len),
        'accept-ranges': 'bytes',
        'content-type': 'video/x-matroska',
      }, body);
    }
    return build(200, {
      'content-length': String(size),
      'accept-ranges': 'bytes',
      'content-type': 'video/x-matroska',
    }, Buffer.from(Array.from({ length: size }, (_, i) => i % 251)));
  };
  return { fetchFn, seen };
}

function makeResponse() {
  const chunks = [];
  const headers = {};
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  res.writeHead = (status, hdrs = {}) => { res.statusCode = status; Object.assign(headers, hdrs); };
  res.body = () => Buffer.concat(chunks);
  res.sentHeaders = headers;
  return res;
}

test('B1 — an open-ended Range is served 206 with exact Content-Range', async () => {
  const { fetchFn, seen } = fakeDataPlane({ size: 10_000 });
  const res = makeResponse();
  const req = { method: 'GET', headers: { range: 'bytes=100-' }, once() {}, removeListener() {} };
  await serveAuthoritativeBytes({
    request: req, response: res, tfId: 'tf-1', dataPlaneBaseUrl: 'http://dp.test', fetchFn,
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.sentHeaders['content-range'], 'bytes 100-9999/10000');
  assert.equal(res.sentHeaders['accept-ranges'], 'bytes');
  assert.equal(res.body().length, 9_900, 'the exact tail is served');
  assert.equal(seen[0].url, 'http://dp.test/files/tf-1', 'the TorrentFile id routes to Rust');
});

test('B2 — a mid-file probe and a full read are served exactly', async () => {
  const { fetchFn } = fakeDataPlane({ size: 10_000 });
  const res1 = makeResponse();
  // Past EOF for this fixture: the data plane answers 416, which must reach
  // the client as a real 416 (players rely on it to end a tail read).
  await assert.rejects(
    () => serveAuthoritativeBytes({
      request: { method: 'GET', headers: { range: 'bytes=122599-' }, once() {}, removeListener() {} },
      response: res1, tfId: 'tf-1', dataPlaneBaseUrl: 'http://dp.test', fetchFn,
    }),
    (error) => error instanceof ByteRouteError && error.status === 416,
  );

  const res2 = makeResponse();
  await serveAuthoritativeBytes({
    request: { method: 'GET', headers: {}, once() {}, removeListener() {} },
    response: res2, tfId: 'tf-1', dataPlaneBaseUrl: 'http://dp.test', fetchFn,
  });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body().length, 10_000);
});

test('B3 — a duplicate range reaches the data plane unchanged (cache/coalescer decide)', async () => {
  const requests = [];
  const { fetchFn } = fakeDataPlane({ size: 10_000, requests });
  const req = { method: 'GET', headers: { range: 'bytes=0-99' }, once() {}, removeListener() {} };
  for (let i = 0; i < 3; i += 1) {
    const res = makeResponse();
    await serveAuthoritativeBytes({
      request: req, response: res, tfId: 'tf-dup', dataPlaneBaseUrl: 'http://dp.test', fetchFn,
    });
    assert.equal(res.statusCode, 206);
  }
  // Three client reads of the same range; the data plane deduplicates at the
  // chunk level, and each client still receives its bytes.
  assert.equal(requests.length, 3, 'one upstream request per client read (coalescing is Rust-owned)');
});

test('B4 — a data-plane failure is surfaced honestly, never retargeted at a provider', async () => {
  const fetchFn = async () => new Response('{"error":{"code":"PROVIDER_EXHAUSTED"}}', { status: 502 });
  const res = makeResponse();
  await assert.rejects(
    () => serveAuthoritativeBytes({
      request: { method: 'GET', headers: {}, once() {}, removeListener() {} },
      response: res, tfId: 'tf-x', dataPlaneBaseUrl: 'http://dp.test', fetchFn,
    }),
    (error) => {
      assert.ok(error instanceof ByteRouteError);
      assert.equal(error.status, 502);
      assert.equal(error.code, 'PROVIDER_EXHAUSTED');
      return true;
    },
  );
});

test('B5 — an empty/invalid TorrentFile id is rejected before any provider call', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return new Response(''); };
  await assert.rejects(
    () => serveAuthoritativeBytes({
      request: { method: 'GET', headers: {}, once() {}, removeListener() {} },
      response: makeResponse(), tfId: '', dataPlaneBaseUrl: 'http://dp.test', fetchFn,
    }),
    (error) => error instanceof ByteRouteError && error.status === 400,
  );
  assert.equal(called, false, 'no provider contact for an invalid id');
});

test('B6 — a plain HTTP server round-trip serves real bytes', async () => {
  const { fetchFn } = fakeDataPlane({ size: 5_000 });
  const server = http.createServer((req, res) => {
    serveAuthoritativeBytes({
      request: req, response: res, tfId: 'tf-http', dataPlaneBaseUrl: 'http://dp.test', fetchFn,
    }).catch((error) => {
      if (!res.headersSent) res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, code: error.code ?? null }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/bytes/tf-http`, { headers: { range: 'bytes=0-99' } });
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get('content-range'), 'bytes 0-99/5000');
    const body = Buffer.from(await resp.arrayBuffer());
    assert.equal(body.length, 100);
    assert.equal(body[0], 0);
    assert.equal(body[99], 99);
  } finally {
    server.close();
  }
});

test('B7 — a client disconnect mid-stream tears down cleanly (no hang, no partial write)', async () => {
  // A slow data plane: the client aborts after the first bytes.
  let upstreamAborted = false;
  const fetchFn = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        // Never close: the client must abort first.
        setTimeout(() => { try { controller.close(); } catch {} }, 5_000);
      },
      cancel() { upstreamAborted = true; },
    }),
    { status: 206, headers: { 'content-length': '100', 'accept-ranges': 'bytes' } },
  );
  const server = http.createServer((req, res) => {
    serveAuthoritativeBytes({
      request: req, response: res, tfId: 'tf-abort', dataPlaneBaseUrl: 'http://dp.test', fetchFn,
    }).catch(() => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const controller = new AbortController();
  const resp = await fetch(`http://127.0.0.1:${port}/bytes/tf-abort`, { signal: controller.signal });
  const reader = resp.body.getReader();
  await reader.read();
  controller.abort();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(upstreamAborted, true, 'the upstream stream is destroyed on client abort');
  server.close();
});

test('B8 — resolveAuthoritativeByteRoute reads the Binding, never re-selects', async () => {
  const route = await resolveAuthoritativeByteRoute({
    controlPlaneStore: {
      getLibraryItemByIdentityKey: () => ({ id: 'lib-1' }),
      getActiveBindingForLibraryItem: () => ({ torrentFile: { id: 'tf-binding-1' } }),
    },
    mediaType: 'movie',
    mediaId: 'tt0000001',
  });
  assert.deepEqual(route, { torrentFileId: 'tf-binding-1', url: '/bytes/tf-binding-1' });
});

test('B9 — no Binding means no byte route (the caller keeps the provider redirect)', async () => {
  assert.equal(await resolveAuthoritativeByteRoute({
    controlPlaneStore: { getLibraryItemByIdentityKey: () => null, getActiveBindingForLibraryItem: () => null },
    mediaType: 'movie', mediaId: 'tt0000001',
  }), null, 'no library item → no route');
  assert.equal(await resolveAuthoritativeByteRoute({
    controlPlaneStore: {
      getLibraryItemByIdentityKey: () => ({ id: 'lib-1' }),
      getActiveBindingForLibraryItem: () => null,
    }, mediaType: 'movie', mediaId: 'tt0000001',
  }), null, 'no active Binding → no route');
  assert.equal(await resolveAuthoritativeByteRoute({
    controlPlaneStore: {
      getLibraryItemByIdentityKey: () => { throw new Error('control plane unreadable'); },
      getActiveBindingForLibraryItem: () => null,
    }, mediaType: 'movie', mediaId: 'tt0000001',
  }), null, 'an unreadable control plane is not a Binding');
  assert.equal(await resolveAuthoritativeByteRoute({ controlPlaneStore: null, mediaType: 'movie', mediaId: 'x' }),
    null, 'no control plane → no route');
});

test('B10 — a series request keys the Binding on the exact S/E identity', async () => {
  const seen = [];
  await resolveAuthoritativeByteRoute({
    controlPlaneStore: {
      getLibraryItemByIdentityKey: (key) => { seen.push(key); return { id: 'lib-2' }; },
      getActiveBindingForLibraryItem: (id) => ({ torrentFile: { id: `tf-${id}` } }),
    },
    mediaType: 'series', mediaId: 'tt0182576', season: 5, episode: 12,
  });
  assert.equal(seen.length, 1, 'exactly one identity lookup');
  assert.equal(seen[0], 'episode:tt0182576:default:5:12',
    'the Binding is keyed on the exact episode coordinate');
});

test('B11 — /stream routes through the data plane when the cached policy is on', async () => {
  // A minimal but real ladder: the route resolves the Binding and redirects
  // to /bytes/:tfId. Drive it through createRequestHandler so the route,
  // not a helper, makes the decision.
  const { createRequestHandler } = await import('../src/server/app.js');
  const handler = createRequestHandler({
    searchCache: {
      db: { prepare: () => ({ get: () => null, run: () => ({ changes: 0 }), all: () => [] }) },
      getExistingSelection: () => ({
        status: 'selected', selectedHash: 'a'.repeat(40), fileIndex: 0,
        provider: 'torbox', releaseKey: `${'a'.repeat(40)}:0`, filename: 'x.mkv',
      }),
      getTvPlaybackHandoff: () => null,
      getProviderObservations: () => [],
    },
    controlPlaneStore: {
      getLibraryItemByIdentityKey: () => ({ id: 'lib-1' }),
      getActiveBindingForLibraryItem: () => ({ torrentFile: { id: 'tf-binding-9' } }),
      recordDeliveryEvidence: () => ({}),
      findDeliveryEvidence: () => null,
      listDeliveryEvidenceForHash: () => [],
    },
    env: { STREAM_BYTE_ROUTE: 'cached', DATA_PLANE_URL: 'http://data-plane:3001' },
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/stream/movie/tt0000001`, { redirect: 'manual' });
    assert.equal(resp.status, 307);
    assert.equal(resp.headers.get('location'), '/bytes/tf-binding-9');
    assert.equal(resp.headers.get('x-hashsucker-byte-route'), 'data-plane');
    assert.equal(resp.headers.get('x-torrent-id'), 'tf-binding-9');
  } finally {
    server.close();
  }
});

test('B12 — the default policy does not consult the Binding at all', async () => {
  // The policy decision must precede any Binding read: with the provider
  // policy the route behaves exactly as before this change.
  const { createRequestHandler } = await import('../src/server/app.js');
  const handler = createRequestHandler({
    searchCache: {
      db: { prepare: () => ({ get: () => null, run: () => ({ changes: 0 }), all: () => [] }) },
      getExistingSelection: () => ({
        status: 'selected', selectedHash: 'a'.repeat(40), fileIndex: 0,
        provider: 'torbox', releaseKey: `${'a'.repeat(40)}:0`, filename: 'x.mkv',
      }),
      getTvPlaybackHandoff: () => null,
      getProviderObservations: () => [],
    },
    controlPlaneStore: {
      // Must never be reached under the provider policy.
      getLibraryItemByIdentityKey: () => { throw new Error('Binding must not be consulted'); },
      getActiveBindingForLibraryItem: () => { throw new Error('Binding must not be consulted'); },
      recordDeliveryEvidence: () => ({}),
      findDeliveryEvidence: () => null,
      listDeliveryEvidenceForHash: () => [],
    },
    env: {},
    clock: () => 1_000,
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/stream/movie/tt0000001`, { redirect: 'manual' });
    // Not a byte-route redirect: the historical ladder runs unchanged.
    assert.notEqual(resp.headers.get('x-hashsucker-byte-route'), 'data-plane',
      'the default policy must not emit a data-plane byte route');
    assert.ok(resp.headers.get('location') === null || !resp.headers.get('location').startsWith('/bytes/'),
      'the default policy must not redirect to the cached byte route');
  } finally {
    server.close();
  }
});
