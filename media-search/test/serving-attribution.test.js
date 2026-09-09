import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import {
  streamFromDataPlane,
  extractServingAttribution,
  SERVING_ATTRIBUTION_HEADERS,
} from '../src/lib/vfs/data-plane-forward.js';

// ---------------------------------------------------------------------------
// T8 — serving-attribution capture in streamFromDataPlane (deterministic,
// fake upstream; zero live HTTP).
// ---------------------------------------------------------------------------

function headersOf(obj) {
  return { get: (name) => obj[String(name).toLowerCase()] ?? null };
}

function fakeReqRes() {
  const listeners = {};
  const request = {
    method: 'GET',
    headers: { range: 'bytes=0-1023' },
    once: (ev, fn) => { listeners[ev] = fn; },
    removeListener: () => {},
  };
  const written = {};
  const response = {
    writeHead: (status, headers) => { written.status = status; written.headers = headers; },
    end: () => { written.ended = true; },
    destroy: () => {},
    once: () => {},
    removeListener: () => {},
    headersSent: true,
  };
  return { request, response, written };
}

function webBody(chunks, delayMs = 0) {
  const nodeStream = new Readable({
    read() {
      if (chunks.length === 0) {
        this.push(null);
        return;
      }
      const chunk = chunks.shift();
      if (delayMs > 0) setTimeout(() => this.push(chunk), delayMs);
      else this.push(chunk);
    },
  });
  return Readable.toWeb(nodeStream);
}

test('extractServingAttribution maps exact headers, rejects malformed/absence', () => {
  const ok = extractServingAttribution(headersOf({
    'x-hashsucker-serving-provider': 'TorBox',
    'x-hashsucker-serving-resource-id': '88408468',
    'x-hashsucker-serving-file-id': '1',
    'x-hashsucker-serving-cap-id': 'torbox-1-0',
  }));
  assert.deepEqual(ok, { provider: 'torbox', providerResourceId: '88408468', providerFileId: '1', capId: 'torbox-1-0' });
  // Absence (pure cache hit) => null, never a guess.
  assert.equal(extractServingAttribution(headersOf({})), null);
  assert.equal(extractServingAttribution(headersOf({ 'x-hashsucker-serving-provider': 'torbox' })), null);
  // Unknown provider names map through untouched here; provider-gating
  // lives in a later controller, not in header parsing.
  assert.deepEqual(
    extractServingAttribution(headersOf({
      'x-hashsucker-serving-provider': 'nonsense',
      'x-hashsucker-serving-resource-id': 'x',
    }))?.provider,
    'nonsense',
  );
  assert.equal(extractServingAttribution(headersOf({
    'x-hashsucker-serving-provider': '',
    'x-hashsucker-serving-resource-id': '88408468',
  })), null);
  assert.equal(extractServingAttribution(null), null);
  console.log('T1 ok: mapping exact, absence and malformed are null');
});

test('streamFromDataPlane strips attribution from player, reports at header time', async () => {
  const { request, response, written } = fakeReqRes();
  const calls = [];
  const fetchFn = async () => ({
    status: 206,
    headers: headersOf({
      'content-range': 'bytes 0-1023/9999',
      'content-length': '1024',
      'accept-ranges': 'bytes',
      'x-hashsucker-serving-provider': 'realdebrid',
      'x-hashsucker-serving-resource-id': '5VFSK7HKPITZW',
      'x-hashsucker-serving-file-id': '7',
      'x-hashsucker-serving-cap-id': 'realdebrid-7-0',
    }),
    body: webBody([Buffer.from('x'.repeat(1024))], 30),
  });
  const flight = streamFromDataPlane({
    fetchFn,
    baseUrl: 'http://dp:3001',
    tfId: 'tf_test',
    request,
    response,
    onServingAttribution: (a) => { calls.push(a); },
  });
  // Body takes ~30ms; the callback must already have fired (header time).
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1, 'callback fires at header time, not body end');
  assert.deepEqual(calls[0], {
    provider: 'realdebrid', providerResourceId: '5VFSK7HKPITZW', providerFileId: '7', capId: 'realdebrid-7-0',
  });
  const result = await flight;
  assert.deepEqual(result.attribution, calls[0], 'return value matches the callback');
  // Player response: byte headers intact, attribution stripped.
  assert.equal(written.status, 206);
  assert.equal(written.headers['content-range'], 'bytes 0-1023/9999');
  for (const name of Object.values(SERVING_ATTRIBUTION_HEADERS)) {
    assert.ok(!(name in written.headers), `player must not see ${name}`);
  }
  console.log('T2 ok: captured internally, stripped from player, header-time callback');
});

test('per-request independence: two responses attribute independently', async () => {
  const mk = (provider, rid) => {
    const { request, response } = fakeReqRes();
    const seen = [];
    const fetchFn = async () => ({
      status: 206,
      headers: headersOf({
        'content-range': 'bytes 0-1023/9999',
        'x-hashsucker-serving-provider': provider,
        'x-hashsucker-serving-resource-id': rid,
      }),
      body: webBody([Buffer.from('y')]),
    });
    return streamFromDataPlane({
      fetchFn, baseUrl: 'http://dp:3001', tfId: `tf_${provider}`, request, response,
      onServingAttribution: (a) => { seen.push(a); },
    }).then((r) => ({ seen, returned: r.attribution }));
  };
  const [a, b] = await Promise.all([mk('torbox', 'TB1'), mk('realdebrid', 'RD1')]);
  assert.equal(a.seen[0].provider, 'torbox');
  assert.equal(a.returned.providerResourceId, 'TB1');
  assert.equal(b.seen[0].provider, 'realdebrid');
  assert.equal(b.returned.providerResourceId, 'RD1');
  console.log('T3 ok: no bleed across concurrent responses');
});

test('cache-hit upstream (no attribution) reports null, bytes intact, errors never attribute', async () => {
  // Upstream 206 with no serving headers: pure cache hit upstream.
  const { request, response, written } = fakeReqRes();
  const seen = [];
  const fetchFn = async () => ({
    status: 206,
    headers: headersOf({ 'content-range': 'bytes 0-1023/9999' }),
    body: webBody([Buffer.from('z'.repeat(1024))]),
  });
  const result = await streamFromDataPlane({
    fetchFn, baseUrl: 'http://dp:3001', tfId: 'tf_x', request, response,
    onServingAttribution: (a) => { seen.push(a); },
  });
  assert.deepEqual(seen, [null], 'cache hit reports null attribution, never a guess');
  assert.equal(result.attribution, null);
  assert.equal(written.status, 206);
  // Non-2xx never reports attribution and still classifies.
  const bad = fakeReqRes();
  let calls = 0;
  const badFetch = async () => ({
    status: 502,
    headers: headersOf({ 'x-hashsucker-serving-provider': 'torbox' }),
    text: async () => JSON.stringify({ error: { code: 'PROVIDER_EXHAUSTED' } }),
  });
  await assert.rejects(
    () => streamFromDataPlane({
      fetchFn: badFetch, baseUrl: 'http://dp:3001', tfId: 'tf_x',
      request: bad.request, response: bad.response,
      onServingAttribution: () => { calls += 1; },
    }),
    (e) => e?.class === 'D',
  );
  assert.equal(calls, 0, 'failures never report attribution');
  console.log('T4 ok: null on cache hit, bytes intact, errors silent');
});
