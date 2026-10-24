import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { createRequestHandler } from '../src/server/app.js';
import { createPreparationStore } from '../src/lib/prepare/store.js';

const SECRET_ENV = {
  PLAYBACK_TOKEN_SECRET: 'test-secret-that-is-long-enough-0123456789',
  PLAYBACK_TOKEN_TTL_SECONDS: '86400',
};

function fakeStore() {
  const items = {
    'movie:tt0000001:default': { id: 'lib-movie-1' },
  };
  const bindings = {
    'lib-movie-1': { torrentFile: { id: 'tf-movie-1' } },
  };
  return {
    // Real in-memory DB so the prepare store shares durable truth.
    db: new DatabaseSync(':memory:'),
    getLibraryItemByIdentityKey: (key) => items[key] ?? null,
    getActiveBindingForLibraryItem: (id) => bindings[id] ?? null,
    // Constructor-time wiring checks (unused by these paths).
    recordDeliveryEvidence: () => ({}),
    findDeliveryEvidence: () => null,
    getTorrentFile: () => null,
    findPlacementByInfoHash: () => null,
    recordPlacement: () => { throw new Error('no placements in this harness'); },
    replaceProviderFileInventory: () => {},
  };
}

function post(server, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(deps, fn) {
  const server = http.createServer(createRequestHandler(deps));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(server);
  } finally {
    server.close();
  }
}

test('POST /api/playback-object warm READY keeps exact shape plus outcome', async () => {
  await withServer({ controlPlaneStore: fakeStore(), env: { ...SECRET_ENV } }, async (server) => {
    const res = await post(server, '/api/playback-object', { mediaId: 'tt0000001', mediaType: 'movie' });
    assert.equal(res.status, 200);
    assert.equal(res.json.outcome, 'ready');
    assert.equal(res.json.torrentFileId, 'tf-movie-1');
    assert.ok(String(res.json.playbackUrl).startsWith('/play/'));
    assert.equal(res.json.representationReason, 'preferred');
    assert.equal(res.json.warm, true);
  });
});

test('GET /api/playback-preparations/:id unknown → 404', async () => {
  await withServer({
    controlPlaneStore: fakeStore(),
    env: { ...SECRET_ENV, PREPARE_ENABLED: '1', TORBOX_API_KEY: 'test' },
  }, async (server) => {
    const res = await get(server, '/api/playback-preparations/999');
    assert.equal(res.status, 404);
  });
});

test('GET status with flag off → 503, never leaks internals', async () => {
  await withServer({
    controlPlaneStore: fakeStore(),
    env: { ...SECRET_ENV },
  }, async (server) => {
    const res = await get(server, '/api/playback-preparations/1');
    assert.equal(res.status, 503);
    assert.equal(res.json.code, 'PREPARATION_UNAVAILABLE');
  });
});

test('GET status reports queued state with media identity only', async () => {
  const store = fakeStore();
  const prepareStore = createPreparationStore({ db: store.db });
  const { preparation } = prepareStore.startOrJoin({
    infoHash: 'ee'.repeat(20), provider: 'torbox',
    mediaType: 'movie', mediaId: 'tt0133093', title: 'M',
    candidate: { filename: 'M.mkv', size: 100 }, source: 'play',
  });
  await withServer({
    controlPlaneStore: store,
    env: { ...SECRET_ENV, PREPARE_ENABLED: '1', TORBOX_API_KEY: 'test' },
  }, async (server) => {
    const res = await get(server, `/api/playback-preparations/${preparation.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.state, 'queued');
    assert.equal(res.json.media.mediaId, 'tt0133093');
    assert.equal(res.json.ready, false);
    const blob = JSON.stringify(res.json);
    assert.ok(!/btih|magnet|placement|resource|torrent_id|credential|api[_-]?key/i.test(blob),
      'no hashes, resources, or credentials leak');
  });
});
