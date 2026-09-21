/**
 * Appliance operator API: failure headlines + activity/downloads/quality/
 * profile endpoints against real in-memory stores over HTTP.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createDownloadStore } from '../src/lib/download/store.js';
import { createRequestHandler } from '../src/server/app.js';
import { humanizeFailure, humanizeRequest } from '../src/lib/operator/failure-text.js';

test('failure text: provider/machine states map to household headlines', () => {
  assert.match(humanizeFailure({ category: 'transient', error: 'TorBox 429 too many' }).headline, /rate-limited/i);
  assert.match(humanizeFailure({ category: 'no-candidate', error: 'unresolvable' }).headline, /No healthy copy/i);
  assert.match(humanizeFailure({ category: 'resolve-transient', error: 'fetch failed' }).headline, /retry scheduled/i);
  assert.match(humanizeFailure({ category: 'deterministic-mismatch', error: 'size mismatch' }).headline, /needs attention/i);
  assert.match(humanizeFailure({ category: null, error: null, retryPending: false }).headline, /No failure/i);
  assert.equal(humanizeRequest({ status: 'failed', candidateCount: 0 }).headline, 'No healthy copy found yet');
  assert.equal(humanizeRequest({ status: 'done' }).headline, 'Fulfilled');
});

function stores() {
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const cps = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  cps.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt-op', title: 'Op', desiredState: 'present' });
  cps.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES ('tf-op', ?, 'Op.mkv', 10, 1)`).run('e'.repeat(40));
  cache.db.prepare(`INSERT INTO release_attributes (info_hash, source, filename, source_type, resolution, parsed_at)
    VALUES (?, 'dmm', 'Op.2024.BluRay.1080p.mkv', 'BluRay', '1080p', 1)`).run('e'.repeat(40));
  const dl = createDownloadStore({ db: cps.db });
  const { download } = dl.request({ mediaId: 'tt-dl', mediaType: 'movie' });
  dl.claimResolving(download.downloadRequestId);
  dl.markFailed(download.downloadRequestId, 'TorBox 429 too many requests', { category: 'transient' });
  return { cache, cps, dl };
}

function serve(cache, cps) {
  return http.createServer(createRequestHandler({
    controlPlaneStore: cps,
    discoveryCache: cache,
    searchCache: cache,
    env: {},
    clock: () => Date.now(),
  }));
}

function get(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ port, path, host: '127.0.0.1' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    }).on('error', reject);
  });
}

function post(server, path, payload) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = JSON.stringify(payload);
    const req = http.request({ port, path, host: '127.0.0.1', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('operator downloads: failed row carries headline + retry state', async () => {
  const { cache, cps } = stores();
  const server = serve(cache, cps);
  await new Promise((r) => server.listen(0, r));
  try {
    const { status, json } = await get(server, '/api/operator/downloads?limit=10');
    assert.equal(status, 200);
    assert.equal(json.items.length, 1);
    const [row] = json.items;
    assert.equal(row.mediaId, 'tt-dl');
    assert.equal(row.state, 'failed');
    assert.match(row.headline, /rate-limited/i);
    assert.equal(row.qualityProfile, 'balanced');
  } finally {
    server.close();
  }
});

test('operator media requests: projects durable lifecycle and human metadata once per request', async () => {
  const { cache, cps } = stores();
  const now = Date.now();
  cache.db.prepare(`INSERT INTO media_requests
    (media_id, media_type, request_intent, quality_profile, media_title, media_year, poster_url, status, candidate_count, created_at)
    VALUES (?, 'movie', 'library', 'hd', 'Dune: Part Two', 2024, 'https://img.test/dune.jpg', 'completed', 0, ?),
           (?, 'movie', 'watch', 'balanced', 'Heat', 1995, 'https://img.test/heat.jpg', 'completed', 1, ?),
           (?, 'movie', 'immediate', 'max', 'Alien', 1979, NULL, 'completed', 1, ?),
           (?, 'movie', 'library', 'balanced', 'Retry me', 2020, NULL, 'failed', 1, ?),
           (?, 'movie', 'library', 'balanced', NULL, NULL, NULL, 'failed', 0, ?)`)
    .run('tt-accepted', now - 5000, 'tt-preparing', now - 4000, 'tt-ready', now - 3000, 'tt-retry', now - 2000, 'tt-terminal', now - 1000);
  const requestId = cache.db.prepare('SELECT id FROM media_requests WHERE media_id = ?').get('tt-ready').id;
  cache.db.prepare(`INSERT INTO playback_handoffs
    (request_id, media_id, media_type, release_key, info_hash, filename, selected_at, created_at)
    VALUES (?, 'tt-ready', 'movie', 'a:torrent', ?, 'ready.mkv', ?, ?)`)
    .run(requestId, 'a'.repeat(40), now, now);
  // An internal retry row for the same human request is not added to the
  // projection: the durable media_requests row is the human unit.
  const server = serve(cache, cps);
  await new Promise((r) => server.listen(0, r));
  try {
    const { status, json } = await get(server, '/api/operator/media-requests?limit=20');
    assert.equal(status, 200);
    assert.equal(json.items.length, 5);
    const byId = Object.fromEntries(json.items.map((i) => [i.mediaId, i]));
    assert.deepEqual(byId['tt-accepted'], { ...byId['tt-accepted'], stage: 'discovering', message: 'Finding a viable release…' });
    assert.equal(byId['tt-preparing'].stage, 'preparing');
    assert.equal(byId['tt-ready'].stage, 'ready');
    assert.equal(byId['tt-ready'].title, 'Alien');
    assert.equal(byId['tt-retry'].stage, 'failed');
    assert.equal(byId['tt-retry'].message, 'Could not find a viable release');
    assert.equal(byId['tt-terminal'].stage, 'failed');
    assert.equal(byId['tt-terminal'].title, 'tt-terminal');
    assert.equal(byId['tt-ready'].intentLabel, 'Best available now');
    assert.equal(byId['tt-ready'].qualityProfile, 'max');
    assert.equal(byId['tt-accepted'].posterUrl, 'https://img.test/dune.jpg');
    assert.match(byId['tt-retry'].message, /viable release/i);
  } finally {
    server.close();
  }
});

test('operator activity: merges requests and downloads newest-first', async () => {
  const { cache, cps } = stores();
  const server = serve(cache, cps);
  await new Promise((r) => server.listen(0, r));
  try {
    const { status, json } = await get(server, '/api/operator/activity?limit=10');
    assert.equal(status, 200);
    assert.ok(json.items.length >= 1);
    assert.ok(json.items.some((i) => i.kind === 'download' && i.mediaId === 'tt-dl'));
    for (let i = 1; i < json.items.length; i++) {
      assert.ok((json.items[i - 1].at ?? 0) >= (json.items[i].at ?? 0));
    }
  } finally {
    server.close();
  }
});

test('operator quality: TorrentFile resolution/source/tier', async () => {
  const { cache, cps } = stores();
  const server = serve(cache, cps);
  await new Promise((r) => server.listen(0, r));
  try {
    const { status, json } = await get(server, '/api/operator/quality?tfs=tf-op,tf-missing');
    assert.equal(status, 200);
    const hit = json.items.find((i) => i.torrentFileId === 'tf-op');
    assert.equal(hit.found, true);
    assert.equal(hit.resolution, '1080p');
    assert.equal(hit.source, 'BluRay');
    assert.ok(Number.isFinite(hit.tier));
    assert.equal(json.items.find((i) => i.torrentFileId === 'tf-missing').found, false);
    const bad = await get(server, '/api/operator/quality');
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('library profile: exact hit, invalid 400, unknown 404', async () => {
  const { cache, cps } = stores();
  const server = serve(cache, cps);
  await new Promise((r) => server.listen(0, r));
  try {
    const ok = await post(server, '/api/library/profile',
      { mediaId: 'tt-op', mediaType: 'movie', qualityProfile: 'hd' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.qualityProfile, 'hd');
    assert.equal(cps.getLibraryItemByIdentityKey('movie:tt-op:default').profile, 'hd');
    const bad = await post(server, '/api/library/profile',
      { mediaId: 'tt-op', mediaType: 'movie', qualityProfile: 'ultra' });
    assert.equal(bad.status, 400);
    const missing = await post(server, '/api/library/profile',
      { mediaId: 'tt-nope', mediaType: 'movie', qualityProfile: 'hd' });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('diagnostics: repeated loads share one probe set (no UI-driven provider traffic)', async () => {
  const { cache, cps } = stores();
  const server = serve(cache, cps);
  await new Promise((r) => server.listen(0, r));
  try {
    const first = await get(server, '/api/diagnostics');
    assert.equal(first.status, 200);
    const second = await get(server, '/api/diagnostics');
    assert.equal(second.status, 200);
    const strip = (j) => JSON.stringify({ ...j, generatedAt: 0 });
    assert.equal(strip(second.json), strip(first.json));
  } finally {
    server.close();
  }
});

test('operator downloads: staged file presence reflects the filesystem', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'op-dl-'));
  try {
    const { cache, cps } = stores();
    cps.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
      VALUES ('tf-1', ?, 'x.mkv', 16, 1)`).run('f'.repeat(40));
    const { createDownloadStore } = await import('../src/lib/download/store.js');
    const dl = createDownloadStore({ db: cps.db });
    const file = path.join(dir, 'x.mkv');
    await fs.promises.writeFile(file, Buffer.alloc(16));
    const { download } = dl.request({ mediaId: 'tt-present', mediaType: 'movie' });
    dl.claimResolving(download.downloadRequestId);
    dl.markMaterializing(download.downloadRequestId, { torrentFileId: 'tf-1', expectedSize: 16, stagedPath: file });
    dl.markStaged(download.downloadRequestId);
    const server = serve(cache, cps);
    await new Promise((r) => server.listen(0, r));
    try {
      const { json } = await get(server, '/api/operator/downloads?limit=10');
      const row = json.items.find((i) => i.mediaId === 'tt-present');
      assert.equal(row.filePresent, true);
      await fs.promises.rm(file);
      const { json: json2 } = await get(server, '/api/operator/downloads?limit=10');
      assert.equal(json2.items.find((i) => i.mediaId === 'tt-present').filePresent, false);
    } finally {
      server.close();
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('media-request intent: unknown 400, download guidance 400', async () => {
  const { cache, cps } = stores();
  const server = serve(cache, cps);
  await new Promise((r) => server.listen(0, r));
  try {
    const bad = await post(server, '/api/media-request',
      { mediaId: 'tt-intent', mediaType: 'movie', intent: 'ultraviolet', source: 'operator' });
    assert.equal(bad.status, 400);
    const dl = await post(server, '/api/media-request',
      { mediaId: 'tt-intent', mediaType: 'movie', intent: 'download', source: 'operator' });
    assert.equal(dl.status, 400);
    assert.match(dl.json.error, /download-request/);
  } finally {
    server.close();
  }
});

test('operator media requests: historical rows use compatibility defaults', async () => {
  const { cache, cps } = stores();
  cache.db.prepare(`INSERT INTO media_requests (media_id, media_type, status, candidate_count, created_at)
    VALUES ('tt-old', 'movie', 'completed', 0, ?)`)
    .run(Date.now());
  const server = serve(cache, cps);
  await new Promise((r) => server.listen(0, r));
  try {
    const { status, json } = await get(server, '/api/operator/media-requests');
    assert.equal(status, 200);
    const row = json.items.find((i) => i.mediaId === 'tt-old');
    assert.equal(row.intentLabel, 'Add to library');
    assert.equal(row.qualityProfile, 'balanced');
    assert.equal(row.title, 'tt-old');
  } finally {
    server.close();
  }
});

test('download-request: library intent rejected with guidance', async () => {
  const { cache, cps } = stores();
  const server = serve(cache, cps);
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await post(server, '/api/download-request',
      { mediaId: 'tt-intent', mediaType: 'movie', intent: 'library' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /media-request/);
  } finally {
    server.close();
  }
});
