/**
 * Generic download-intent tranche: intent state, staging contract,
 * resolution (fast reuse vs fresh prepare), worker over the shared
 * byte primitive, no auto-recreation of moved staged files.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { materializeTorrentFile } from '../src/lib/materialize/materialize.js';
import { createDownloadStore, DOWNLOAD_STATUS } from '../src/lib/download/store.js';
import { resolveStagedTarget, isWithinRoot } from '../src/lib/download/paths.js';
import { createDownloadResolver } from '../src/lib/download/resolve.js';
import { createDownloadWorker } from '../src/lib/download/worker.js';

function memStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE torrent_files (
    id TEXT PRIMARY KEY, info_hash TEXT NOT NULL, internal_path TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size > 0), created_at INTEGER NOT NULL,
    UNIQUE (info_hash, internal_path))`);
  db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES ('tf-1', ?, 'Dune (2021).mkv', 32, 1)`).run('a'.repeat(40));
  return createDownloadStore({ db });
}

function stubFetch(bytes) {
  return async () => ({
    ok: true,
    status: 200,
    body: (async function* stream() { yield Buffer.from(bytes); })(),
  });
}

// ─── staging contract ───
test('download paths: movies/ + tv/ namespaces with real extension', () => {
  const movie = resolveStagedTarget({
    root: '/dl', mediaType: 'movie', title: 'Dune', year: 2021,
    internalPath: 'Dune.2021.BluRay.x264.mkv',
  });
  assert.equal(movie, '/dl/movies/Dune (2021)/Dune (2021).mkv');
  const ep = resolveStagedTarget({
    root: '/dl', mediaType: 'episode', title: 'Dune', year: 2024,
    season: 1, episode: 2, internalPath: 'dune.s01e02.1080p.mp4',
  });
  assert.equal(ep, '/dl/tv/Dune (2024)/Season 01/Dune (2024) - S01E02.mp4');
  assert.ok(!isWithinRoot('/dl', '/dl/../evil.mkv'));
  assert.ok(isWithinRoot('/dl', '/dl/movies/X.mkv'));
});

// ─── intent state / idempotency ───
test('download store: active intent returned; staged kept; failed resets', () => {
  const store = memStore();
  const first = store.request({ mediaId: 'tt1', mediaType: 'movie', title: 'T', year: 2000 });
  assert.ok(first.created);
  assert.equal(first.download.status, DOWNLOAD_STATUS.REQUESTED);
  const again = store.request({ mediaId: 'tt1', mediaType: 'movie' });
  assert.ok(!again.created);
  assert.equal(again.download.downloadRequestId, first.download.downloadRequestId);
  // Same media + different episode = different intent.
  const ep = store.request({ mediaId: 'tt1', mediaType: 'episode', season: 1, episode: 2 });
  assert.ok(ep.created);
  store.claimResolving(first.download.downloadRequestId);
  store.markMaterializing(first.download.downloadRequestId, {
    torrentFileId: 'tf-1', expectedSize: 32, stagedPath: '/dl/movies/T/T.mkv',
  });
  store.markStaged(first.download.downloadRequestId);
  const staged = store.request({ mediaId: 'tt1', mediaType: 'movie' });
  assert.ok(!staged.created && !staged.reset);
  assert.equal(staged.download.status, DOWNLOAD_STATUS.STAGED);
  store.claimResolving(ep.download.downloadRequestId);
  store.markFailed(ep.download.downloadRequestId, 'boom');
  const retry = store.request({ mediaId: 'tt1', mediaType: 'episode', season: 1, episode: 2 });
  assert.ok(retry.reset);
  assert.equal(retry.download.status, DOWNLOAD_STATUS.REQUESTED);
});

test('download store: boot recovery resets transient only', () => {
  const store = memStore();
  const a = store.request({ mediaId: 'tt1', mediaType: 'movie' });
  const b = store.request({ mediaId: 'tt2', mediaType: 'movie' });
  store.claimResolving(a.download.downloadRequestId);
  store.claimResolving(b.download.downloadRequestId);
  store.markMaterializing(b.download.downloadRequestId, {
    torrentFileId: 'tf-1', expectedSize: 32, stagedPath: '/dl/x.mkv',
  });
  assert.equal(store.resetStale(), 2);
  assert.equal(store.get(a.download.downloadRequestId).status, DOWNLOAD_STATUS.REQUESTED);
  assert.equal(store.get(b.download.downloadRequestId).status, DOWNLOAD_STATUS.REQUESTED);
});

// ─── resolution: fast reuse vs fresh prepare ───
const TF = { id: 'tf-1', infoHash: 'a'.repeat(40), internalPath: 'Dune (2021).mkv', size: 32 };
const STORED_HANDOFF = {
  requestId: 'r1', mediaId: 'tt1', mediaType: 'movie', season: null, episode: null,
  releaseKey: 'aaa:1', infoHash: 'a'.repeat(40), fileIndex: 1, filename: 'Dune (2021).mkv',
  provider: 'torbox', torrentFileId: 'tf-1',
};

function stubCache(handoffByMedia = { tt1: STORED_HANDOFF }) {
  return {
    getPlaybackHandoffByMediaId: (mediaId) => handoffByMedia[mediaId] ?? null,
    getTvPlaybackHandoff: () => null,
  };
}

function stubControlPlane() {
  return {
    getTorrentFile: () => ({ ...TF }),
    listDataPlaneCoordinates: () => [{ provider: 'torbox' }],
  };
}

test('download resolve: fast path reuses durable TorrentFile with zero discovery', async () => {
  let discovered = false;
  const resolver = createDownloadResolver({
    searchCache: stubCache(),
    controlPlaneStore: stubControlPlane(),
    searchByMediaFn: async () => { discovered = true; return {}; },
  });
  const hit = await resolver.resolve({ mediaId: 'tt1', mediaType: 'movie' });
  assert.equal(hit.status, 'ok');
  assert.ok(hit.reused);
  assert.equal(hit.torrentFileId, 'tf-1');
  assert.ok(!discovered);
});

test('download resolve: fresh path prepares then resolves; miss stays unresolvable', async () => {
  const cacheData = {};
  let preparedAs = null;
  const resolver = createDownloadResolver({
    searchCache: stubCache(cacheData),
    controlPlaneStore: stubControlPlane(),
    searchByMediaFn: async (cache, req) => {
      preparedAs = req.mediaType;
      cacheData.tt9 = { ...STORED_HANDOFF, mediaId: 'tt9' };
      return { prepared: true };
    },
  });
  const fresh = await resolver.resolve({ mediaId: 'tt9', mediaType: 'movie' });
  assert.equal(fresh.status, 'ok');
  assert.ok(!fresh.reused);
  assert.equal(fresh.torrentFileId, 'tf-1');
  const miss = await resolver.resolve({ mediaId: 'tt-missing', mediaType: 'movie' });
  assert.equal(miss.status, 'unresolvable');
});

test('download resolve: episode input prepares as series (pipeline native type)', async () => {
  const cacheData = {};
  let preparedAs = null;
  const resolver = createDownloadResolver({
    searchCache: { getPlaybackHandoffByMediaId: () => null, getTvPlaybackHandoff: () => cacheData.ep ?? null },
    controlPlaneStore: stubControlPlane(),
    searchByMediaFn: async (cache, req) => {
      preparedAs = req.mediaType;
      cacheData.ep = { ...STORED_HANDOFF, mediaType: 'episode', season: 1, episode: 2 };
      return { prepared: true };
    },
  });
  const fresh = await resolver.resolve({ mediaId: 'tt9', mediaType: 'episode', season: 1, episode: 2 });
  assert.equal(preparedAs, 'series');
  assert.equal(fresh.status, 'ok');
});

// ─── worker over the shared primitive ───
test('download worker: resolve → materialize → staged; staged never re-touched', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dl-work-'));
  const store = memStore();
  const { download } = store.request({ mediaId: 'tt1', mediaType: 'movie', title: 'Dune', year: 2021 });
  const worker = createDownloadWorker({
    downloadStore: store,
    resolveFn: async () => ({ status: 'ok', reused: true, torrentFile: { ...TF }, torrentFileId: 'tf-1', handoff: null }),
    stagingRoot: root,
    dataPlaneBaseUrl: 'http://dp:3001',
    fetchFn: stubFetch(Buffer.alloc(32, 9)),
  });
  const done = await worker.tick();
  assert.equal(done.status, 'staged');
  assert.ok(done.reused);
  const stagedPath = path.join(root, 'movies', 'Dune (2021)', 'Dune (2021).mkv');
  assert.equal((await fsp.stat(stagedPath)).size, 32);
  assert.equal(store.get(download.downloadRequestId).status, DOWNLOAD_STATUS.STAGED);
  // External importer moves the file: tolerated, never recreated.
  await fsp.unlink(stagedPath);
  const idle = await worker.tick();
  assert.equal(idle.status, 'idle');
  assert.equal(store.get(download.downloadRequestId).status, DOWNLOAD_STATUS.STAGED);
  await fsp.rm(root, { recursive: true, force: true });
});

test('download worker: unresolvable intent fails retryably', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dl-fail-'));
  const store = memStore();
  const { download } = store.request({ mediaId: 'tt-nope', mediaType: 'movie' });
  const worker = createDownloadWorker({
    downloadStore: store,
    resolveFn: async () => ({ status: 'unresolvable', reason: 'nothing found' }),
    stagingRoot: root,
    dataPlaneBaseUrl: 'http://dp:3001',
    fetchFn: stubFetch(Buffer.alloc(0)),
  });
  const failed = await worker.tick();
  assert.equal(failed.status, 'failed');
  assert.equal(store.get(download.downloadRequestId).lastError, 'nothing found');
  await fsp.rm(root, { recursive: true, force: true });
});

// ─── primitive: staging names isolate concurrent same-file runs ───
test('materialize primitive: stagingName isolates concurrent same-TorrentFile runs', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mat-'));
  const staging = path.join(dir, '.staging');
  const payload = Buffer.alloc(16, 3);
  const [a, b] = await Promise.all([
    materializeTorrentFile({
      torrentFileId: 'tf-x', size: 16, finalPath: path.join(dir, 'a.bin'),
      stagingDir: staging, stagingName: 'one.partial',
      dataPlaneBaseUrl: 'http://dp:3001', fetchFn: stubFetch(payload),
    }),
    materializeTorrentFile({
      torrentFileId: 'tf-x', size: 16, finalPath: path.join(dir, 'b.bin'),
      stagingDir: staging, stagingName: 'two.partial',
      dataPlaneBaseUrl: 'http://dp:3001', fetchFn: stubFetch(payload),
    }),
  ]);
  assert.ok(a.ok && b.ok);
  assert.equal((await fsp.stat(path.join(dir, 'a.bin'))).size, 16);
  assert.equal((await fsp.stat(path.join(dir, 'b.bin'))).size, 16);
  await fsp.rm(dir, { recursive: true, force: true });
});

function rangedFetch(payload, calls, { status = 206, start = 0, total = payload.length } = {}) {
  return async (_url, options) => {
    calls.push(options);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-range': `bytes ${start}-${start + payload.length - 1}/${total}` }),
      body: (async function* stream() { yield Buffer.from(payload); })(),
    };
  };
}

async function writePartial(dir, name, bytes) {
  const staging = path.join(dir, '.staging');
  await fsp.mkdir(staging, { recursive: true });
  await fsp.writeFile(path.join(staging, name), bytes);
  return staging;
}

test('materialize primitive: no partial uses normal full-body acquisition', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mat-resume-'));
  const calls = [];
  const result = await materializeTorrentFile({
    torrentFileId: 'tf-new', size: 4, finalPath: path.join(dir, 'out'), stagingDir: path.join(dir, '.staging'),
    dataPlaneBaseUrl: 'http://dp:3001', fetchFn: rangedFetch(Buffer.from('abcd'), calls, { status: 200, start: 0 }),
  });
  assert.ok(result.ok);
  assert.equal(calls[0].headers.range, undefined);
  assert.equal(await fsp.readFile(path.join(dir, 'out'), 'utf8'), 'abcd');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('materialize primitive: valid partial sends exact Range and appends', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mat-resume-'));
  const calls = [];
  await writePartial(dir, 'tf-resume.partial', Buffer.from('abc'));
  const result = await materializeTorrentFile({
    torrentFileId: 'tf-resume', size: 6, finalPath: path.join(dir, 'out'), stagingDir: path.join(dir, '.staging'),
    dataPlaneBaseUrl: 'http://dp:3001', fetchFn: rangedFetch(Buffer.from('def'), calls, { start: 3, total: 6 }),
  });
  assert.ok(result.ok);
  assert.equal(calls[0].headers.range, 'bytes=3-');
  assert.equal(await fsp.readFile(path.join(dir, 'out'), 'utf8'), 'abcdef');
  await fsp.rm(dir, { recursive: true, force: true });
});

for (const [name, response] of [
  ['mismatched start', { start: 2, total: 6 }],
  ['mismatched total', { start: 3, total: 7 }],
  ['200 on nonzero resume', { status: 200, start: 0, total: 6 }],
]) {
  test(`materialize primitive: rejects ${name} without appending`, async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mat-resume-'));
    await writePartial(dir, 'tf-invalid.partial', Buffer.from('abc'));
    const result = await materializeTorrentFile({
      torrentFileId: 'tf-invalid', size: 6, finalPath: path.join(dir, 'out'), stagingDir: path.join(dir, '.staging'),
      dataPlaneBaseUrl: 'http://dp:3001', fetchFn: rangedFetch(Buffer.from('def'), [], response),
    });
    assert.equal(result.ok, false);
    assert.equal(await fsp.readFile(path.join(dir, '.staging/tf-invalid.partial'), 'utf8'), 'abc');
    await fsp.rm(dir, { recursive: true, force: true });
  });
}

test('materialize primitive: interrupted stream preserves bytes and next attempt resumes new length', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mat-resume-'));
  const calls = [];
  let first = true;
  const fetchFn = async (_url, options) => {
    calls.push(options);
    if (!first) return rangedFetch(Buffer.from('f'), calls, { start: 5, total: 6 })();
    first = false;
    return { ok: true, status: 206, headers: new Headers({ 'content-range': 'bytes 3-5/6' }), body: (async function* () { yield Buffer.from('de'); throw new Error('connection reset'); })() };
  };
  await writePartial(dir, 'tf-drop.partial', Buffer.from('abc'));
  const firstResult = await materializeTorrentFile({ torrentFileId: 'tf-drop', size: 6, finalPath: path.join(dir, 'out'), stagingDir: path.join(dir, '.staging'), dataPlaneBaseUrl: 'http://dp:3001', fetchFn });
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.bytesComplete, 5);
  assert.equal((await fsp.stat(path.join(dir, '.staging/tf-drop.partial'))).size, 5);
  const secondResult = await materializeTorrentFile({ torrentFileId: 'tf-drop', size: 6, finalPath: path.join(dir, 'out'), stagingDir: path.join(dir, '.staging'), dataPlaneBaseUrl: 'http://dp:3001', fetchFn });
  assert.ok(secondResult.ok);
  assert.equal(calls[1].headers.range, 'bytes=5-');
  assert.equal(await fsp.readFile(path.join(dir, 'out'), 'utf8'), 'abcdef');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('materialize primitive: exact-size partial verifies and finalizes without fetch', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mat-resume-'));
  await writePartial(dir, 'tf-complete.partial', Buffer.from('abcdef'));
  let called = false;
  const result = await materializeTorrentFile({ torrentFileId: 'tf-complete', size: 6, finalPath: path.join(dir, 'out'), stagingDir: path.join(dir, '.staging'), dataPlaneBaseUrl: 'http://dp:3001', fetchFn: async () => { called = true; } });
  assert.ok(result.ok);
  assert.equal(called, false);
  assert.equal(await fsp.readFile(path.join(dir, 'out'), 'utf8'), 'abcdef');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('materialize primitive: oversized partial resets safely', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mat-resume-'));
  const calls = [];
  await writePartial(dir, 'tf-over.partial', Buffer.from('toolong'));
  const result = await materializeTorrentFile({ torrentFileId: 'tf-over', size: 3, finalPath: path.join(dir, 'out'), stagingDir: path.join(dir, '.staging'), dataPlaneBaseUrl: 'http://dp:3001', fetchFn: rangedFetch(Buffer.from('xyz'), calls, { status: 200, start: 0, total: 3 }) });
  assert.ok(result.ok);
  assert.equal(calls[0].headers.range, undefined);
  assert.equal(await fsp.readFile(path.join(dir, 'out'), 'utf8'), 'xyz');
  await fsp.rm(dir, { recursive: true, force: true });
});
