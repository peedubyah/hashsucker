/**
 * Playback-path route evidence: a direct `/play/<token>` delivery feeds the
 * same usable-evidence hygiene as the VFS/WebDAV path.
 *
 * Context: the byte path prefers routes with fresh usable evidence, but only
 * the VFS/WebDAV serving path recorded it. Direct plays (the resolver-first
 * path) delivered bytes without leaving the positive evidence behind, so a
 * proven route stayed "unknown" and the next cold acquisition re-paid a
 * failed first attempt. This test boots the real request handler with a
 * real control-plane store and a fake data plane: after one `/play/`
 * delivery, the serving route must classify serviceable.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { classifyRoutesForTorrentFile } from '../src/lib/control-plane/route-classification.js';
import { mintPlaybackToken } from '../src/lib/resolver/playback-object.js';
import { createRequestHandler } from '../src/server/app.js';

const HASH = 'e'.repeat(40);
const INTERNAL = 'Movie/movie.mkv';
const NOW = 3_000_000;
const UNTIL = 9_000_000_000;
const SECRET = 'playback-evidence-test-secret-0123456789';

function tempDbPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-playback-evidence-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return path.join(dir, 'control-plane.db');
}

/** One TorBox route to one TorrentFile; returns { store, tf, resourceId }. */
function seedTorBoxRoute(t) {
  const store = createControlPlaneStore({ dbPath: tempDbPath(t), now: () => NOW });
  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: HASH,
    providerResourceId: 'tb-res-1',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'owner',
    provenance: 'playback-evidence-test',
    observedAt: NOW,
    expiresAt: UNTIL,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: '0',
    path: INTERNAL,
    name: 'movie.mkv',
    size: 4096,
    selected: true,
  }], { authoritative: true, complete: true, observedAt: NOW, expiresAt: UNTIL });
  const tf = store.findTorrentFile(HASH, INTERNAL);
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
    inventory_observed_at = ?, inventory_expires_at = ?
    WHERE placement_id = ? AND provider_file_id = ?
  `).run(tf.id, NOW, UNTIL, placement.id, '0');
  return { store, tf };
}

/** Fake data plane: 206 + serving attribution for the seeded TorBox route. */
function fakeDataPlane() {
  const fetchFn = async (url, options = {}) => {
    const range = options.headers?.range ?? 'bytes=0-4095';
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = Number(m[1]);
    const end = Number(m[2]);
    const len = end - start + 1;
    return new Response(Buffer.alloc(len, 0x41), {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${end}/4096`,
        'content-length': String(len),
        'accept-ranges': 'bytes',
        'x-hashsucker-serving-provider': 'torbox',
        'x-hashsucker-serving-resource-id': 'tb-res-1',
        'x-hashsucker-serving-file-id': '0',
        'x-hashsucker-serving-cap-id': 'torbox-0-0',
      },
    });
  };
  return fetchFn;
}

function get(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('playback path: a direct /play/ delivery records usable evidence for the serving route', async (t) => {
  const { store, tf } = seedTorBoxRoute(t);
  const before = classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW });
  assert.equal(before.byProvider.torbox.state, 'retryable', 'unobserved before the play');

  const handler = createRequestHandler({
    controlPlaneStore: store,
    fetchFn: fakeDataPlane(),
    env: { PLAYBACK_TOKEN_SECRET: SECRET, DATA_PLANE_URL: 'http://dp.test' },
    now: () => NOW,
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { token } = mintPlaybackToken({ torrentFileId: tf.id, secret: SECRET, now: NOW });
    const res = await get(server, `/play/${encodeURIComponent(token)}`, { range: 'bytes=0-4095' });
    assert.equal(res.status, 206, 'the play is served');
    assert.equal(res.body.length, 4096, 'the full range is delivered');

    const after = classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW });
    assert.equal(after.byProvider.torbox.state, 'serviceable',
      'the route that delivered is no longer unknown');
  } finally {
    server.close();
  }
});

test('playback path: a pure cache hit (no attribution) records nothing', async (t) => {
  const { store, tf } = seedTorBoxRoute(t);
  const noAttributionFetch = async () => new Response(Buffer.alloc(4096, 0x41), {
    status: 206,
    headers: {
      'content-range': 'bytes 0-4095/4096',
      'content-length': '4096',
      'accept-ranges': 'bytes',
    },
  });
  const handler = createRequestHandler({
    controlPlaneStore: store,
    fetchFn: noAttributionFetch,
    env: { PLAYBACK_TOKEN_SECRET: SECRET, DATA_PLANE_URL: 'http://dp.test' },
    now: () => NOW,
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { token } = mintPlaybackToken({ torrentFileId: tf.id, secret: SECRET, now: NOW });
    const res = await get(server, `/play/${encodeURIComponent(token)}`, { range: 'bytes=0-4095' });
    assert.equal(res.status, 206);
    const after = classifyRoutesForTorrentFile(store, { torrentFileId: tf.id, now: NOW });
    assert.equal(after.byProvider.torbox.state, 'retryable',
      'absence of attribution invents no evidence');
  } finally {
    server.close();
  }
});
