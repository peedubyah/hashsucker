/**
 * The playback object — HashSucker's own, stable playback URL.
 *
 * `/play/:token` is the resolver-first surface: one HashSucker-owned URL
 * bound to one authoritative TorrentFile, proxying bytes through the
 * existing authoritative byte path (Node owns identity, Rust owns bytes).
 *
 * These tests pin the contract the product claim depends on:
 *
 *   - the URL resolves the authoritative TorrentFile and names nothing else;
 *   - the URL is provider-independent (no provider, no placement, no route,
 *     no consumer item, no credential);
 *   - Range/seek semantics are the byte path's, unchanged;
 *   - a client disconnect tears the upstream down;
 *   - a same-TorrentFile route change leaves the URL and the TorrentFile
 *     untouched (the provider choice lives inside Rust);
 *   - a different TorrentFile can never silently satisfy the URL.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  mintPlaybackToken,
  verifyPlaybackToken,
  playbackObjectPath,
  readPlaybackSecret,
  readPlaybackTtlSeconds,
  PlaybackObjectError,
  DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS,
} from '../src/lib/resolver/playback-object.js';
import { servePlaybackObject } from '../src/server/playback-route.js';

const SECRET = 'playback-secret-for-tests-0123456789';

/** A byte-range aware fake of the Rust data plane's /files/:tfId. */
function fakeDataPlane({ size, requests, providerByTfId = {} }) {
  const seen = [];
  const fetchFn = async (url, options = {}) => {
    const range = options.headers?.range ?? null;
    const tfId = decodeURIComponent(url.split('/files/')[1] ?? '');
    seen.push({ url, method: options.method ?? 'GET', range, tfId });
    requests?.push({ range, tfId, url });
    const provider = providerByTfId[tfId] ?? null;
    const providerHeaders = provider
      ? {
        'x-hashsucker-serving-provider': provider,
        'x-hashsucker-serving-resource-id': `res-${provider}`,
        'x-hashsucker-serving-file-id': `file-${provider}`,
        'x-hashsucker-serving-cap-id': `cap-${provider}`,
      }
      : {};
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
        ...providerHeaders,
      }, body);
    }
    return build(200, {
      'content-length': String(size),
      'accept-ranges': 'bytes',
      'content-type': 'video/x-matroska',
      ...providerHeaders,
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

test('P1 — a minted token resolves the authoritative TorrentFile it names', () => {
  const { token } = mintPlaybackToken({ torrentFileId: 'tf-authoritative-1', secret: SECRET, now: 1_000 });
  const verified = verifyPlaybackToken({ token, secret: SECRET, now: 1_000 });
  assert.equal(verified.torrentFileId, 'tf-authoritative-1');
  assert.equal(playbackObjectPath(token), `/play/${encodeURIComponent(token)}`);
});

test('P2 — the playback URL is provider-independent: it names no provider, placement or route', () => {
  const { token } = mintPlaybackToken({ torrentFileId: 'tf-authoritative-1', secret: SECRET, now: 1_000 });
  const decoded = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
  const payload = JSON.parse(decoded);
  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'tf', 'v']);
  assert.equal(payload.tf, 'tf-authoritative-1');
  for (const forbidden of ['provider', 'realdebrid', 'torbox', 'placement', 'route', 'url', 'consumer']) {
    assert.ok(!decoded.toLowerCase().includes(forbidden),
      `the token must not mention ${forbidden}`);
  }
});

test('P3 — a tampered token is rejected, and a token for another file cannot be swapped in', () => {
  const a = mintPlaybackToken({ torrentFileId: 'tf-a', secret: SECRET, now: 1_000 }).token;
  const b = mintPlaybackToken({ torrentFileId: 'tf-b', secret: SECRET, now: 1_000 }).token;
  // Swap the payload of b into a's signature: the signature no longer matches.
  const forged = `${b.split('.')[0]}.${a.split('.')[1]}`;
  assert.throws(
    () => verifyPlaybackToken({ token: forged, secret: SECRET, now: 1_000 }),
    (error) => error instanceof PlaybackObjectError && error.status === 403
      && error.code === 'PLAYBACK_TOKEN_INVALID',
  );
  // A token signed with another secret is equally invalid.
  const other = mintPlaybackToken({
    torrentFileId: 'tf-a', secret: `${SECRET}-different`, now: 1_000,
  }).token;
  assert.throws(
    () => verifyPlaybackToken({ token: other, secret: SECRET, now: 1_000 }),
    (error) => error instanceof PlaybackObjectError && error.status === 403,
  );
});

test('P4 — expiry is explicit: a token past its expiry is a distinct, typed failure', () => {
  const { token, expiresAt } = mintPlaybackToken({
    torrentFileId: 'tf-a', secret: SECRET, ttlSeconds: 60, now: 1_000_000,
  });
  assert.equal(expiresAt, Math.floor(1_000_000 / 1000) + 60);
  assert.doesNotThrow(() => verifyPlaybackToken({ token, secret: SECRET, now: 1_000_000 }));
  assert.throws(
    () => verifyPlaybackToken({ token, secret: SECRET, now: (expiresAt + 1) * 1000 }),
    (error) => error instanceof PlaybackObjectError && error.status === 410
      && error.code === 'PLAYBACK_TOKEN_EXPIRED',
  );
});

test('P5 — a missing or short secret is a typed unavailability, never a silent pass', () => {
  assert.equal(readPlaybackSecret({}), null);
  assert.equal(readPlaybackSecret({ PLAYBACK_TOKEN_SECRET: 'short' }), null);
  assert.equal(readPlaybackSecret({ PLAYBACK_TOKEN_SECRET: `  ${SECRET}  ` }), SECRET);
  assert.throws(
    () => mintPlaybackToken({ torrentFileId: 'tf-a', secret: 'short', now: 1_000 }),
    (error) => error instanceof PlaybackObjectError && error.status === 503
      && error.code === 'PLAYBACK_OBJECT_UNAVAILABLE',
  );
  assert.equal(readPlaybackTtlSeconds({}), DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS);
  assert.equal(readPlaybackTtlSeconds({ PLAYBACK_TOKEN_TTL_SECONDS: '0' }), 0, '0 means no expiry');
  assert.equal(readPlaybackTtlSeconds({ PLAYBACK_TOKEN_TTL_SECONDS: 'nonsense' }),
    DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS);
});

test('P6 — the route serves the authoritative TorrentFile with correct Range semantics', async () => {
  const { fetchFn, seen } = fakeDataPlane({ size: 10_000 });
  const { token } = mintPlaybackToken({ torrentFileId: 'tf-authoritative-1', secret: SECRET, now: 1_000 });
  const res = makeResponse();
  await servePlaybackObject({
    request: { method: 'GET', headers: { range: 'bytes=100-' }, once() {}, removeListener() {} },
    response: res,
    token,
    secret: SECRET,
    dataPlaneBaseUrl: 'http://dp.test',
    fetchFn,
    now: 1_000,
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.sentHeaders['content-range'], 'bytes 100-9999/10000');
  assert.equal(res.sentHeaders['accept-ranges'], 'bytes');
  assert.equal(res.body().length, 9_900);
  assert.equal(seen[0].url, 'http://dp.test/files/tf-authoritative-1',
    'the token resolves to exactly the TorrentFile it names');
});

test('P7 — a seek is an ordinary Range; the URL and the TorrentFile never change', async () => {
  const { fetchFn, seen } = fakeDataPlane({ size: 4_000_000 });
  const { token } = mintPlaybackToken({ torrentFileId: 'tf-seek-1', secret: SECRET, now: 1_000 });
  const url = playbackObjectPath(token);
  for (const range of ['bytes=0-', 'bytes=2000000-2000999', 'bytes=3999000-']) {
    const res = makeResponse();
    await servePlaybackObject({
      request: { method: 'GET', headers: { range }, once() {}, removeListener() {} },
      response: res,
      token,
      secret: SECRET,
      dataPlaneBaseUrl: 'http://dp.test',
      fetchFn,
      now: 1_000,
    });
    assert.equal(res.statusCode, 206, `range ${range} is served`);
    assert.equal(seen.at(-1).tfId, 'tf-seek-1', 'every seek names the same TorrentFile');
  }
  assert.equal(playbackObjectPath(token), url, 'the playback URL is unchanged across seeks');
  assert.equal(new Set(seen.map((s) => s.tfId)).size, 1, 'exactly one TorrentFile was ever served');
});

test('P8 — a client disconnect tears the upstream down (no hang, no partial write)', async () => {
  let upstreamAborted = false;
  const fetchFn = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        setTimeout(() => { try { controller.close(); } catch {} }, 5_000);
      },
      cancel() { upstreamAborted = true; },
    }),
    { status: 206, headers: { 'content-length': '100', 'accept-ranges': 'bytes' } },
  );
  const { token } = mintPlaybackToken({ torrentFileId: 'tf-abort', secret: SECRET, now: 1_000 });
  const server = http.createServer((req, res) => {
    servePlaybackObject({
      request: req, response: res, token, secret: SECRET, dataPlaneBaseUrl: 'http://dp.test', fetchFn, now: 1_000,
    }).catch(() => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const controller = new AbortController();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/play/${token}`, { signal: controller.signal });
    const reader = resp.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(upstreamAborted, true, 'the upstream stream is destroyed on client abort');
  } finally {
    server.close();
  }
});

test('P9 — a same-TorrentFile route change is invisible: the upstream request never changes', async () => {
  // The data plane owns the route choice. Whatever route serves the bytes,
  // Node asks for the SAME TorrentFile at the SAME upstream path, so the
  // client's URL and its bytes stay identical across a route change.
  const requests = [];
  const { fetchFn, seen } = fakeDataPlane({
    size: 5_000,
    requests,
    providerByTfId: { 'tf-dual-route': 'realdebrid' },
  });
  const { token } = mintPlaybackToken({ torrentFileId: 'tf-dual-route', secret: SECRET, now: 1_000 });
  const upstreamPaths = new Set();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = makeResponse();
    await servePlaybackObject({
      request: { method: 'GET', headers: { range: 'bytes=0-999' }, once() {}, removeListener() {} },
      response: res,
      token,
      secret: SECRET,
      dataPlaneBaseUrl: 'http://dp.test',
      fetchFn,
      now: 1_000,
    });
    assert.equal(res.statusCode, 206);
    assert.equal(res.body().length, 1_000, 'the client gets the same bytes');
    upstreamPaths.add(seen.at(-1).url);
  }
  assert.equal(upstreamPaths.size, 1, 'both attempts asked the data plane for the same TorrentFile');
});

test('P10 — a different TorrentFile can never silently satisfy the URL', async () => {
  const { fetchFn, seen } = fakeDataPlane({ size: 1_000 });
  const a = mintPlaybackToken({ torrentFileId: 'tf-a', secret: SECRET, now: 1_000 }).token;
  const b = mintPlaybackToken({ torrentFileId: 'tf-b', secret: SECRET, now: 1_000 }).token;
  for (const [token, expected] of [[a, 'tf-a'], [b, 'tf-b']]) {
    const res = makeResponse();
    await servePlaybackObject({
      request: { method: 'GET', headers: {}, once() {}, removeListener() {} },
      response: res,
      token,
      secret: SECRET,
      dataPlaneBaseUrl: 'http://dp.test',
      fetchFn,
      now: 1_000,
    });
    assert.equal(seen.at(-1).tfId, expected, 'each URL serves exactly its own TorrentFile');
  }
});

test('P11 — no provider secret or provider URL ever reaches the client', async () => {
  const { fetchFn } = fakeDataPlane({
    size: 2_000,
    providerByTfId: { 'tf-secret': 'realdebrid' },
  });
  const { token } = mintPlaybackToken({ torrentFileId: 'tf-secret', secret: SECRET, now: 1_000 });
  const res = makeResponse();
  await servePlaybackObject({
    request: { method: 'GET', headers: { range: 'bytes=0-99' }, once() {}, removeListener() {} },
    response: res,
    token,
    secret: SECRET,
    dataPlaneBaseUrl: 'http://dp.test',
    fetchFn,
    now: 1_000,
  });
  const headerNames = Object.keys(res.sentHeaders).map((h) => h.toLowerCase());
  for (const forbidden of [
    'x-hashsucker-serving-provider',
    'x-hashsucker-serving-resource-id',
    'x-hashsucker-serving-file-id',
    'x-hashsucker-serving-cap-id',
    'location',
    'x-torrent-id',
    'x-file-id',
  ]) {
    assert.ok(!headerNames.includes(forbidden), `${forbidden} must not reach the client`);
  }
  const headerBlob = JSON.stringify(res.sentHeaders).toLowerCase();
  assert.ok(!headerBlob.includes('realdebrid'), 'no provider name in the response headers');
  assert.ok(!headerBlob.includes('http'), 'no upstream URL in the response headers');
});

test('P12 — the resolver mints a playback object and never a provider redirect', async () => {
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
      getActiveBindingForLibraryItem: () => ({ torrentFile: { id: 'tf-binding-77' } }),
      recordDeliveryEvidence: () => ({}),
      findDeliveryEvidence: () => null,
      listDeliveryEvidenceForHash: () => [],
    },
    env: {
      STREAM_BYTE_ROUTE: 'playback',
      PLAYBACK_TOKEN_SECRET: SECRET,
      DATA_PLANE_URL: 'http://data-plane:3001',
    },
    clock: () => 1_000_000,
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/stream/movie/tt0000001`, { redirect: 'manual' });
    assert.equal(resp.status, 307);
    const location = resp.headers.get('location');
    assert.ok(location.startsWith('/play/'), 'the resolver hands out a playback object, not a provider URL');
    assert.equal(resp.headers.get('x-hashsucker-byte-route'), 'playback-object');
    const blob = JSON.stringify([...resp.headers]);
    assert.ok(!/https?:\/\//.test(blob), 'no absolute (provider) URL is exposed');
    // The minted object resolves the authoritative TorrentFile.
    const token = decodeURIComponent(location.slice('/play/'.length));
    const verified = verifyPlaybackToken({ token, secret: SECRET, now: 1_000_000 });
    assert.equal(verified.torrentFileId, 'tf-binding-77');
  } finally {
    server.close();
  }
});

test('P13 — without an authoritative Binding the playback policy fails loudly', async () => {
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
      getLibraryItemByIdentityKey: () => null,
      getActiveBindingForLibraryItem: () => null,
      recordDeliveryEvidence: () => ({}),
      findDeliveryEvidence: () => null,
      listDeliveryEvidenceForHash: () => [],
    },
    env: {
      STREAM_BYTE_ROUTE: 'playback',
      PLAYBACK_TOKEN_SECRET: SECRET,
      DATA_PLANE_URL: 'http://data-plane:3001',
    },
    clock: () => 1_000_000,
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/stream/movie/tt0000001`, { redirect: 'manual' });
    assert.equal(resp.status, 409);
    const body = await resp.json();
    assert.equal(body.code, 'NO_AUTHORITATIVE_BINDING');
    assert.equal(resp.headers.get('location'), null, 'no redirect at all — never a provider URL');
  } finally {
    server.close();
  }
});

test('P14 — the provider policy is untouched: /stream still behaves exactly as before', async () => {
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
    assert.notEqual(resp.headers.get('x-hashsucker-byte-route'), 'playback-object');
    assert.notEqual(resp.headers.get('x-hashsucker-byte-route'), 'data-plane');
    assert.ok(resp.headers.get('location') === null || !resp.headers.get('location').startsWith('/play/'),
      'the default policy must not mint a playback object');
  } finally {
    server.close();
  }
});

test('P15 — an invalid token is refused before the byte path is touched', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return new Response(''); };
  await assert.rejects(
    () => servePlaybackObject({
      request: { method: 'GET', headers: {}, once() {}, removeListener() {} },
      response: makeResponse(),
      token: 'not-a-token',
      secret: SECRET,
      dataPlaneBaseUrl: 'http://dp.test',
      fetchFn,
      now: 1_000,
    }),
    (error) => error instanceof PlaybackObjectError && error.status === 403,
  );
  assert.equal(called, false, 'no byte-path contact for an invalid token');
});
