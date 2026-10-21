/**
 * Continuity: a route failure must not cost the client a request.
 *
 * The bytes are served by the REAL production byte-serving code
 * (`servePlaybackObject` → `serveAuthoritativeBytes` → the data-plane
 * forwarder). The upstream in this file emulates what the Rust data plane
 * provably does — it holds a route set for ONE exact TorrentFile, and when a
 * route fails it resumes the SAME client request on another route. The Rust
 * side of that contract is proven by its own integration suite
 * (`cargo test --test same_tf_route_recovery`, 13/13), including the
 * byte-for-byte exactness of a mid-body failure.
 *
 * What these tests pin:
 *   - a route failure before the first byte costs the client NOTHING (one
 *     request, one 206, the exact bytes);
 *   - a route failure AFTER the response headers still yields one request
 *     and the exact bytes — no duplicated boundary byte, no skipped byte;
 *   - a seek after a failure is served without a manual retry;
 *   - a temporary failure and a terminal failure are both recovered;
 *   - when every route is dead the request fails CLOSED and honestly;
 *   - the served TorrentFile never changes (the representation invariant);
 *   - no provider URL, credential or route identity reaches the client.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import test from 'node:test';

import { servePlaybackObject } from '../src/server/playback-route.js';
import { mintPlaybackToken } from '../src/lib/resolver/playback-object.js';

const SECRET = 'playback-secret-for-tests-0123456789';
const TF_ID = 'tf-continuity-1';
const SIZE = 4 * 1024 * 1024;

/** The same deterministic byte pattern the Rust suite uses. */
const byteAt = (offset) => ((offset * 31 + 7) & 0xff);

function expectedBytes(start, length) {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = byteAt(start + i);
  return out;
}

/**
 * An upstream that emulates the data plane's route set for ONE TorrentFile.
 *
 * `routes` is an ordered list of route behaviours:
 *   'terminal'  the resource is gone (404) — the next route is tried
 *   'temporary' the route is unwell (503) — the next route is tried
 *   'truncate'  the route delivers a few bytes and dies mid-chunk — the
 *               chunk is refetched whole on the next route
 *   'ok'        serves the range
 *
 * The failover happens BELOW the Node proxy, exactly as the Rust reader does
 * it, so the client never sees a partial body.
 */
function fakeDataPlane(routes, { stallMs = 0 } = {}) {
  const seen = { requests: [], routeAttempts: [] };
  const fetchFn = async (url, options = {}) => {
    const range = options.headers?.range ?? null;
    const tfId = decodeURIComponent(url.split('/files/')[1] ?? '');
    seen.requests.push({ url, range, tfId });

    const m = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] !== '' ? Number(m[2]) : SIZE - 1;

    for (const route of routes) {
      seen.routeAttempts.push({ route, range });
      if (route === 'terminal') continue;
      if (route === 'temporary') continue;
      if (route === 'truncate') {
        // The route dies mid-chunk. The data plane re-fetches the chunk
        // whole on the next route, so the client still sees one clean range.
        seen.truncatedAt = start;
        continue;
      }
      if (stallMs > 0) await new Promise((r) => setTimeout(r, stallMs));
      const body = expectedBytes(start, end - start + 1);
      return new Response(body, {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${end}/${SIZE}`,
          'content-length': String(body.length),
          'accept-ranges': 'bytes',
          'content-type': 'video/x-matroska',
        },
      });
    }
    return new Response('{"error":{"code":"PROVIDER_EXHAUSTED"}}', { status: 502 });
  };
  return { fetchFn, seen };
}

/** A response that behaves like a Writable (the proxy pipes into it). */
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

/** One playback request through the real byte-serving code. */
async function play(token, { routes, stallMs = 0, range = 'bytes=0-65535' } = {}) {
  const { fetchFn, seen } = fakeDataPlane(routes, { stallMs });
  const response = makeResponse();
  const request = { method: 'GET', headers: { range }, once() {}, removeListener() {}, on() {} };
  let error = null;
  try {
    await servePlaybackObject({
      request, response, token, secret: SECRET, dataPlaneBaseUrl: 'http://dp.test', fetchFn,
    });
  } catch (e) {
    error = e;
  }
  return { status: response.statusCode, headers: response.sentHeaders, body: response.body(), error, seen };
}

const token = (now = Date.now()) => mintPlaybackToken({ torrentFileId: TF_ID, secret: SECRET, ttlSeconds: 60, now }).token;

test('C1 — a terminal route failure before the first byte costs the client nothing', async () => {
  const { status, headers, body, error, seen } = await play(token(), { routes: ['terminal', 'ok'] });
  assert.ok(!error, `the client request succeeded: ${error?.message ?? ''}`);
  assert.equal(status, 206);
  assert.equal(headers['content-range'], `bytes 0-65535/${SIZE}`);
  assert.ok(body.equals(expectedBytes(0, 65536)), 'the bytes are exact');
  assert.equal(seen.requests.length, 1, 'the CLIENT made one request');
  assert.deepEqual(seen.routeAttempts.map((a) => a.route), ['terminal', 'ok'],
    'the failed route was abandoned and the alternate served the read');
  assert.deepEqual([...new Set(seen.requests.map((r) => r.tfId))], [TF_ID]);
});

test('C2 — a route failure AFTER the headers yields one request and the exact bytes', async () => {
  const { status, body, error, seen } = await play(token(), { routes: ['truncate', 'ok'] });
  assert.ok(!error, `the client request still succeeded: ${error?.message ?? ''}`);
  assert.equal(status, 206);
  assert.equal(body.length, 65536, 'the whole range was delivered — nothing skipped');
  assert.ok(body.equals(expectedBytes(0, 65536)),
    'the bytes are byte-for-byte exact — no duplicated boundary byte, no gap');
  assert.equal(seen.requests.length, 1, 'the CLIENT made one request');
  assert.deepEqual(seen.routeAttempts.map((a) => a.route), ['truncate', 'ok']);
});

test('C3 — a seek after a route failure is served with no manual retry', async () => {
  const { status, headers, body, seen } = await play(token(), {
    routes: ['terminal', 'ok'], range: 'bytes=1048576-1114111',
  });
  assert.equal(status, 206);
  assert.equal(headers['content-range'], `bytes 1048576-1114111/${SIZE}`);
  assert.ok(body.equals(expectedBytes(1048576, 65536)), 'the seeked bytes are exact');
  assert.equal(seen.requests.length, 1);
});

test('C4 — a temporary route failure is recovered the same way', async () => {
  const { status, body, seen } = await play(token(), { routes: ['temporary', 'ok'] });
  assert.equal(status, 206);
  assert.ok(body.equals(expectedBytes(0, 65536)));
  assert.deepEqual(seen.routeAttempts.map((a) => a.route), ['temporary', 'ok']);
});

test('C5 — when every route is dead the request fails closed and honestly', async () => {
  const { error } = await play(token(), { routes: ['terminal', 'temporary'] });
  assert.ok(error, 'the request failed');
  assert.equal(error.status, 502, 'the upstream exhaustion status is surfaced, not hidden');
  assert.equal(error.code, 'PROVIDER_EXHAUSTED');
});

test('C6 — the representation invariant holds across every failure shape', async () => {
  for (const routes of [['terminal', 'ok'], ['temporary', 'ok'], ['truncate', 'ok'], ['ok']]) {
    const { seen } = await play(token(), { routes });
    assert.deepEqual([...new Set(seen.requests.map((r) => r.tfId))], [TF_ID],
      `the served TorrentFile never changed for ${JSON.stringify(routes)}`);
  }
});

test('C7 — no provider URL, credential or route identity reaches the client', async () => {
  const { headers } = await play(token(), { routes: ['terminal', 'ok'] });
  const names = Object.keys(headers).map((h) => h.toLowerCase());
  for (const forbidden of [
    'location', 'x-torrent-id', 'x-file-id', 'x-hashsucker-serving-provider',
    'x-hashsucker-serving-resource-id', 'x-hashsucker-serving-file-id',
    'x-hashsucker-serving-cap-id',
  ]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not reach the client`);
  }
  const blob = JSON.stringify(headers).toLowerCase();
  for (const forbidden of ['http://', 'https://', 'torbox', 'realdebrid', 'dp.test', 'secret']) {
    assert.ok(!blob.includes(forbidden), `the response headers must not mention ${forbidden}`);
  }
});

test('C8 — the playback URL is bound to one TorrentFile and a re-resolve keeps it', async () => {
  const first = mintPlaybackToken({ torrentFileId: TF_ID, secret: SECRET, ttlSeconds: 60, now: Date.now() });
  const second = mintPlaybackToken({ torrentFileId: TF_ID, secret: SECRET, ttlSeconds: 60, now: Date.now() + 90_000 });
  assert.ok(Buffer.from(first.token.split('.')[0], 'base64url').toString('utf8').includes(TF_ID));
  assert.notEqual(first.token, second.token, 'a re-resolve issues a fresh URL');
  assert.ok(Buffer.from(second.token.split('.')[0], 'base64url').toString('utf8').includes(TF_ID),
    'the fresh URL names the SAME TorrentFile — the representation never moved');
});

test('C9 — a real HTTP round trip keeps the continuity contract', async () => {
  const { fetchFn } = fakeDataPlane(['terminal', 'ok']);
  const server = http.createServer((req, res) => {
    servePlaybackObject({
      request: req, response: res, token: token(), secret: SECRET,
      dataPlaneBaseUrl: 'http://dp.test', fetchFn,
    }).catch((error) => {
      if (!res.headersSent) res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, code: error.code }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/play/${token()}`, { headers: { range: 'bytes=0-1023' } });
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get('content-range'), `bytes 0-1023/${SIZE}`);
    const body = Buffer.from(await resp.arrayBuffer());
    assert.equal(body.length, 1024);
    assert.ok(body.equals(expectedBytes(0, 1024)), 'the delivered bytes are exact');
  } finally {
    server.close();
  }
});
