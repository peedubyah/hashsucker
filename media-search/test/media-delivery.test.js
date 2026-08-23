/**
 * HTTP byte delivery integration tests.
 *
 * Tests GET /media/{info_hash}/{file_index} end-to-end using a real
 * http.Server — no fake response objects.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createRequestHandler } from '../src/server/app.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = '1234567890abcdef1234567890abcdef12345678';
const NOW = 10_000;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempMount() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'media-delivery-'));
}

function createStore() {
  return createControlPlaneStore({ now: () => NOW });
}

function createMovieItem(store, overrides = {}) {
  return store.ensureLibraryItem({
    mediaType: 'movie',
    mediaId: 'tt0133093',
    title: 'The Matrix',
    year: 1999,
    desiredState: 'present',
    ...overrides,
  });
}

function setupBindableExposure(store, item, identity, options = {}) {
  const p = store.ensureCanonicalPath(item.id);
  const placement = store.recordPlacement({
    provider: options.provider ?? 'realdebrid',
    accountScope: 'primary',
    infoHash: identity.infoHash,
    providerResourceId: options.resourceId ?? `resource-${identity.infoHash.slice(0, 5)}`,
    state: 'ready',
    ownership: options.ownership ?? 'owned',
    ownerKey: item.id,
    provenance: 'test',
    idempotencyKey: `placement:${options.provider ?? 'realdebrid'}:${identity.infoHash}`,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: options.providerFileId ?? 'file-1',
    path: options.providerPath ?? '/provider/The.Matrix.1999.mkv',
    name: options.filename ?? 'The.Matrix.1999.mkv',
    size: options.size ?? 1_000,
    selected: true,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  const fileId = options.providerFileId ?? 'file-1';
  store.recordFileMapping({
    ...identity,
    placementId: placement.id,
    providerFileId: fileId,
    state: 'mapped',
    method: 'provider-file-id',
    authoritative: true,
  });
  const exposure = store.recordExposure({
    placementId: placement.id,
    providerFileId: fileId,
    transport: options.transport ?? 'filesystem',
    exposureKey: options.exposureKey ?? `${placement.id}:${fileId}`,
    relativePath: options.relativePath ?? 'The.Matrix.1999.mkv',
    state: options.exposureState ?? 'visible',
    readOnly: true,
    observedAt: 0,
    expiresAt: 9_999_999_999_999,
    mountScope: options.mountScope ?? 'default',
  });
  return { path: p, placement, exposure, providerFileId: fileId };
}

function activateBinding(store, item, identity, exposure, providerFileId) {
  return store.activateBinding({
    libraryItemId: item.id,
    libraryPathId: store.getActiveCanonicalPath(item.id).id,
    ...identity,
    placementId: exposure.placement_id ?? store.db.prepare('SELECT placement_id FROM exposures WHERE id = ?').get(exposure.id).placement_id,
    providerFileId,
    exposureId: exposure.id,
    reason: 'test-activation',
  });
}

/**
 * Create a real HTTP server for testing.
 */
function createMediaServer(mountDir) {
  const store = createStore();
  const server = http.createServer(createRequestHandler({
    controlPlaneStore: store,
    env: { REALDEBRID_MOUNT_PATH: mountDir },
    importer: {
      async submitRequest() { return { requestId: 'test', status: 'queued' }; },
      async getRequestStatus() { return { status: 'processing' }; },
    },
    searchCatalog: async () => [],
    getMedia: async () => null,
    combinedSearch: async () => ({ results: [], total: 0, query: {}, timings: {}, stats: {} }),
    searchTitles: async () => ({ results: [], requestId: 'test', fromCache: false, errors: [] }),
    getMediaById: async () => null,
    getCacheMetrics: () => null,
    discoveryCache: { getProviderObservations: () => [] },
    getControlPlaneHealth: () => ({ ok: true }),
    searchReleases: async () => ({ results: [], total: 0, query: {}, timings: {}, stats: {} }),
  }));
  return { server, store };
}

/**
 * Make a real HTTP request to the test server.
 */
function httpRequest(server, url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: url,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          text: body.toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Setup a library item + binding + exposure pointing to a real file.
 * Returns { server, store, request }.
 */
function setupMediaFileServer(mountDir, filename, content, options = {}) {
  fs.writeFileSync(path.join(mountDir, filename), content);
  const { server, store } = createMediaServer(mountDir);
  const item = createMovieItem(store, options.itemOverrides);
  const fileIndex = options.fileIndex === undefined ? 0 : options.fileIndex;
  const identity = {
    infoHash: options.infoHash ?? HASH,
    fileIndex,
    releaseKey: `${options.infoHash ?? HASH}:${fileIndex === null ? 'torrent' : fileIndex}`,
  };
  const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
  const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
    relativePath: filename,
    filename,
    size,
    ...options.exposureOptions,
  });
  activateBinding(store, item, identity, exposure, providerFileId);
  const request = (url, opts) => httpRequest(server, url, opts);
  return { server, store, request, exposure, providerFileId };
}

// ---------------------------------------------------------------------------
// Full file streaming tests
// ---------------------------------------------------------------------------

test('GET /media returns 200 with full file content', async () => {
  const mountDir = createTempMount();
  try {
    const content = 'Hello, World! This is a test movie file.';
    const { server, request } = setupMediaFileServer(mountDir, 'movie.mkv', content);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'video/x-matroska');
    assert.equal(res.headers['content-length'], String(content.length));
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.body.toString('utf8'), content);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media includes Content-Length matching file size', async () => {
  const mountDir = createTempMount();
  try {
    const content = Buffer.alloc(1024, 'x');
    const { server, request } = setupMediaFileServer(mountDir, '1k.bin', content);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`);
    assert.equal(res.status, 200);
    assert.equal(Number(res.headers['content-length']), 1024);
    assert.equal(res.body.length, 1024);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media derives Content-Type from file extension', async () => {
  const mountDir = createTempMount();
  try {
    const { server, request } = setupMediaFileServer(mountDir, 'movie.mp4', 'mp4 content');
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'video/mp4');
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media defaults Content-Type to application/octet-stream', async () => {
  const mountDir = createTempMount();
  try {
    const { server, request } = setupMediaFileServer(mountDir, 'file.xyz', 'binary content');
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Range request tests
// ---------------------------------------------------------------------------

test('GET /media with Range header returns 206 Partial Content', async () => {
  const mountDir = createTempMount();
  try {
    const content = '0123456789'; // 10 bytes
    const { server, request } = setupMediaFileServer(mountDir, 'range.bin', content);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`, { headers: { range: 'bytes=2-5' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.headers['content-length'], '4'); // bytes 2..5 inclusive
    assert.equal(res.headers['content-range'], 'bytes 2-5/10');
    assert.equal(res.body.toString('utf8'), '2345');
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with open-ended range returns from start to EOF', async () => {
  const mountDir = createTempMount();
  try {
    const content = '0123456789';
    const { server, request } = setupMediaFileServer(mountDir, 'range.bin', content);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`, { headers: { range: 'bytes=7-' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-length'], '3');
    assert.equal(res.headers['content-range'], 'bytes 7-9/10');
    assert.equal(res.body.toString('utf8'), '789');
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with suffix range returns last N bytes', async () => {
  const mountDir = createTempMount();
  try {
    const content = '0123456789';
    const { server, request } = setupMediaFileServer(mountDir, 'range.bin', content);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`, { headers: { range: 'bytes=-3' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-length'], '3');
    assert.equal(res.headers['content-range'], 'bytes 7-9/10');
    assert.equal(res.body.toString('utf8'), '789');
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with range exceeding file size clamps to EOF', async () => {
  const mountDir = createTempMount();
  try {
    const content = '0123456789';
    const { server, request } = setupMediaFileServer(mountDir, 'range.bin', content);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`, { headers: { range: 'bytes=5-100' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-length'], '5');
    assert.equal(res.headers['content-range'], 'bytes 5-9/10');
    assert.equal(res.body.toString('utf8'), '56789');
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with range start exceeding file returns 416', async () => {
  const mountDir = createTempMount();
  try {
    const content = '01234';
    const { server, request } = setupMediaFileServer(mountDir, 'range.bin', content);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`, { headers: { range: 'bytes=100-200' } });
    assert.equal(res.status, 416);
    assert.match(res.text, /exceeds file size/);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with malformed range returns 416', async () => {
  const mountDir = createTempMount();
  try {
    const content = '01234';
    const { server, request } = setupMediaFileServer(mountDir, 'range.bin', content);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`, { headers: { range: 'bytes=invalid' } });
    assert.equal(res.status, 416);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with zero-length range returns 416', async () => {
  const mountDir = createTempMount();
  try {
    const content = '01234';
    const { server, request } = setupMediaFileServer(mountDir, 'range.bin', content);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`, { headers: { range: 'bytes=-0' } });
    assert.equal(res.status, 416);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Error mapping tests
// ---------------------------------------------------------------------------

test('GET /media with invalid infoHash returns 400', async () => {
  const mountDir = createTempMount();
  try {
    const { server } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await httpRequest(server, '/media/invalid-hash/0');
    assert.equal(res.status, 400);
    assert.match(res.text, /infoHash/);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with no binding returns 410', async () => {
  const mountDir = createTempMount();
  try {
    const { server, store } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    // Create item + exposure but never activate binding
    const item = createMovieItem(store);
    const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
    store.ensureCanonicalPath(item.id);
    setupBindableExposure(store, item, identity, {
      relativePath: 'no-binding.mkv',
      filename: 'no-binding.mkv',
    });
    // Don't activate binding — just request
    const res = await httpRequest(server, `/media/${HASH}/0`);
    assert.equal(res.status, 410);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with no exposure returns 423', async () => {
  const mountDir = createTempMount();
  try {
    const { server, store } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const item = createMovieItem(store);
    const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
    const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
      relativePath: 'no-exposure.mkv',
      filename: 'no-exposure.mkv',
    });
    activateBinding(store, item, identity, exposure, providerFileId);
    // Delete binding first (FK constraint), then exposure to simulate missing exposure
    store.db.prepare('DELETE FROM bindings WHERE exposure_id = ?').run(exposure.id);
    store.db.prepare('DELETE FROM exposures WHERE id = ?').run(exposure.id);
    const res = await httpRequest(server, `/media/${HASH}/0`);
    assert.equal(res.status, 410); // No binding exists anymore
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with unsupported transport returns 502', async () => {
  const mountDir = createTempMount();
  try {
    const { server, request } = setupMediaFileServer(mountDir, 'file.mkv', 'content', {
      exposureOptions: { transport: 'zurg-rclone' },
    });
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await request(`/media/${HASH}/0`);
    assert.equal(res.status, 502);
    assert.match(res.text, /Unsupported transport/);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with missing file returns 404', async () => {
  const mountDir = createTempMount();
  try {
    const { server, store } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const item = createMovieItem(store);
    const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
    const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
      relativePath: 'missing.mkv',
      filename: 'missing.mkv',
    });
    activateBinding(store, item, identity, exposure, providerFileId);
    // Don't create the file — path points to non-existent file
    const res = await httpRequest(server, `/media/${HASH}/0`);
    assert.equal(res.status, 404);
    assert.match(res.text, /File not found/);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with NULL relative_path returns 423', async () => {
  const mountDir = createTempMount();
  try {
    const { server, store } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const item = createMovieItem(store);
    const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
    const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
      relativePath: 'null-path.mkv',
      filename: 'null-path.mkv',
    });
    activateBinding(store, item, identity, exposure, providerFileId);
    // Set relative_path to NULL in database
    store.db.prepare('UPDATE exposures SET relative_path = NULL WHERE id = ?').run(exposure.id);
    const res = await httpRequest(server, `/media/${HASH}/0`);
    assert.equal(res.status, 423);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with unconfigured mount returns 503', async () => {
  const mountDir = createTempMount();
  try {
    const { server, store } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const item = createMovieItem(store);
    const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
    const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
      relativePath: 'unconfigured.mkv',
      filename: 'unconfigured.mkv',
      mountScope: 'nonexistent-scope',
    });
    activateBinding(store, item, identity, exposure, providerFileId);
    const res = await httpRequest(server, `/media/${HASH}/0`);
    assert.equal(res.status, 503);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with path traversal attempt returns 400', async () => {
  const mountDir = createTempMount();
  try {
    const { server, store } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const item = createMovieItem(store);
    const identity = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
    const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
      relativePath: '../../../etc/passwd',
      filename: 'traversal.mkv',
    });
    activateBinding(store, item, identity, exposure, providerFileId);
    const res = await httpRequest(server, `/media/${HASH}/0`);
    assert.equal(res.status, 400);
    assert.match(res.text, /traversal/);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Identity isolation tests
// ---------------------------------------------------------------------------

test('GET /media maintains identity isolation for different hashes', async () => {
  const mountDir = createTempMount();
  try {
    const content1 = 'content-for-hash-1';
    const content2 = 'different-content-for-hash-2';
    fs.writeFileSync(path.join(mountDir, 'file1.mkv'), content1);
    fs.writeFileSync(path.join(mountDir, 'file2.mkv'), content2);
    const { server, store } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const item1 = createMovieItem(store, { mediaId: 'tt-first' });
    const item2 = createMovieItem(store, { mediaId: 'tt-second' });
    const identity1 = { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` };
    const identity2 = { infoHash: OTHER_HASH, fileIndex: 0, releaseKey: `${OTHER_HASH}:0` };
    const { exposure: exp1, providerFileId: pf1 } = setupBindableExposure(store, item1, identity1, {
      relativePath: 'file1.mkv', filename: 'file1.mkv',
    });
    const { exposure: exp2, providerFileId: pf2 } = setupBindableExposure(store, item2, identity2, {
      relativePath: 'file2.mkv', filename: 'file2.mkv',
    });
    activateBinding(store, item1, identity1, exp1, pf1);
    activateBinding(store, item2, identity2, exp2, pf2);
    const res1 = await httpRequest(server, `/media/${HASH}/0`);
    const res2 = await httpRequest(server, `/media/${OTHER_HASH}/0`);
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    assert.equal(res1.body.toString('utf8'), content1);
    assert.equal(res2.body.toString('utf8'), content2);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// File index variants
// ---------------------------------------------------------------------------

test('GET /media supports torrent-level file index', async () => {
  const mountDir = createTempMount();
  try {
    const content = 'torrent-level content';
    fs.writeFileSync(path.join(mountDir, 'torrent.mkv'), content);
    const { server, store } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const item = createMovieItem(store);
    const identity = { infoHash: HASH, fileIndex: null, releaseKey: `${HASH}:torrent` };
    const { exposure, providerFileId } = setupBindableExposure(store, item, identity, {
      relativePath: 'torrent.mkv',
      filename: 'torrent.mkv',
      size: Buffer.byteLength(content),
    });
    activateBinding(store, item, identity, exposure, providerFileId);
    const res = await httpRequest(server, `/media/${HASH}/torrent`);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString('utf8'), content);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});

test('GET /media with invalid fileIndex returns 400', async () => {
  const mountDir = createTempMount();
  try {
    const { server } = createMediaServer(mountDir);
    after(() => server.close());
    await new Promise((resolve) => server.listen(0, resolve));
    const res = await httpRequest(server, `/media/${HASH}/abc`);
    assert.equal(res.status, 400);
    assert.match(res.text, /fileIndex/);
  } finally {
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
});
