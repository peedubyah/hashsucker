/**
 * Permanent-storage promotion tranche: state model, destination
 * contract, resolution, verification, worker, local serving.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  resolvePermanentTarget, resolveStagingTarget, isWithinRoot,
} from '../src/lib/promotion/paths.js';
import { createPromotionStore, PROMOTION_STATUS } from '../src/lib/promotion/store.js';
import { resolvePromotionTarget } from '../src/lib/promotion/resolve.js';
import { createPromotionWorker, verifyStagedFile } from '../src/lib/promotion/worker.js';
import { serveLocalFile } from '../src/lib/promotion/serve-local.js';

function memStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE torrent_files (
    id TEXT PRIMARY KEY, info_hash TEXT NOT NULL, internal_path TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size > 0), created_at INTEGER NOT NULL,
    UNIQUE (info_hash, internal_path))`);
  // Referential anchor: promotions always reference a real TorrentFile.
  db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES ('tf-1', ?, 'T.mkv', 16, 1), ('tf-2', ?, 'B.mkv', 8, 1)`)
    .run('a'.repeat(40), 'b'.repeat(40));
  return createPromotionStore({ db });
}

const BASE = {
  torrentFileId: 'tf-1', libraryItemId: 'lib-1', mediaId: 'tt0133093',
  mediaType: 'movie', size: 16, permanentPath: '/perm/Movies/T/T.mkv',
};

// ─── destination contract ───
test('promotion paths: movie/episode layout mirrors STRM tree with real extension', () => {
  const movie = resolvePermanentTarget({
    root: '/perm', mediaType: 'movie', title: 'The Matrix', year: 1999,
    internalPath: 'The.Matrix.1999.BluRay.x264.mkv',
  });
  assert.equal(movie, '/perm/Movies/The Matrix (1999)/The Matrix (1999).mkv');
  const ep = resolvePermanentTarget({
    root: '/perm', mediaType: 'episode', title: 'Show', year: 2020,
    season: 1, episode: 2, internalPath: 'Show.S01E02.1080p.mp4',
  });
  assert.equal(ep, '/perm/TV Shows/Show (2020)/Season 01/Show (2020) - S01E02.mp4');
});

test('promotion paths: staging target is namespaced and root escape is rejected', () => {
  assert.equal(resolveStagingTarget('/perm', 'tf-1'), '/perm/.staging/tf-1.partial');
  assert.ok(isWithinRoot('/perm', '/perm/Movies/X.mkv'));
  assert.ok(!isWithinRoot('/perm', '/perm/../evil.mkv'));
  assert.ok(!isWithinRoot('/perm', '/other/X.mkv'));
  assert.throws(() => resolveStagingTarget('/perm', '../evil'), /torrentFileId/);
});

// ─── state model / idempotency ───
test('promotion store: request is idempotent; permanent is a no-op', () => {
  const store = memStore();
  const first = store.request(BASE);
  assert.ok(first.created);
  assert.equal(first.promotion.status, PROMOTION_STATUS.REQUESTED);
  const second = store.request(BASE);
  assert.ok(!second.created);
  assert.equal(second.promotion.status, PROMOTION_STATUS.REQUESTED);
  store.claimMaterializing('tf-1');
  store.markVerifying('tf-1', 16);
  store.markPermanent('tf-1');
  const noop = store.request(BASE);
  assert.ok(!noop.created && !noop.reset);
  assert.equal(noop.promotion.status, PROMOTION_STATUS.PERMANENT);
  assert.equal(noop.promotion.bytesComplete, 16);
});

test('promotion store: failed resets to requested on re-ask; stale transient resets on boot', () => {
  const store = memStore();
  store.request(BASE);
  store.claimMaterializing('tf-1');
  store.markFailed('tf-1', 'boom');
  assert.equal(store.get('tf-1').status, PROMOTION_STATUS.FAILED);
  const retry = store.request(BASE);
  assert.ok(retry.reset);
  assert.equal(retry.promotion.status, PROMOTION_STATUS.REQUESTED);
  store.claimMaterializing('tf-1');
  assert.equal(store.resetStale(), 1);
  assert.equal(store.get('tf-1').status, PROMOTION_STATUS.REQUESTED);
  assert.equal(store.get('tf-1').bytesComplete, 0);
});

test('promotion store: claim is atomic; progress + media lookup work', () => {
  const store = memStore();
  store.request(BASE);
  assert.ok(store.claimMaterializing('tf-1'));
  assert.ok(!store.claimMaterializing('tf-1'));
  store.noteProgress('tf-1', 8);
  assert.equal(store.get('tf-1').bytesComplete, 8);
  const byMedia = store.getByMedia({ mediaId: 'tt0133093', mediaType: 'movie' });
  assert.equal(byMedia?.torrentFileId, 'tf-1');
});

// ─── resolution: exact TorrentFile or refusal ───
function stubControlPlane({ item = { id: 'lib-1', mediaId: 'tt1', title: 'T', year: 2000 }, binding = true, mapping = 'mapped' } = {}) {
  return {
    getLibraryItem: () => item,
    listBindings: () => (binding ? [{ status: 'active', placementId: 'pl-1', providerFileId: 'pf-1' }] : []),
    listProviderFiles: () => [{ providerFileId: 'pf-1', present: true, torrentFileId: 'tf-1', mappingState: mapping }],
    getTorrentFile: () => ({ id: 'tf-1', infoHash: 'a'.repeat(40), internalPath: 'T.mkv', size: 100 }),
  };
}

test('promotion resolve: exact TorrentFile via active binding; refusals are exact', () => {
  const ok = resolvePromotionTarget(stubControlPlane(), 'lib-1');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.torrentFile.id, 'tf-1');
  assert.equal(resolvePromotionTarget(stubControlPlane({ item: null }), 'nope').status, 'unknown-library-item');
  assert.equal(resolvePromotionTarget(stubControlPlane({ binding: false }), 'lib-1').status, 'no-active-binding');
  const unmapped = resolvePromotionTarget(stubControlPlane({ mapping: 'unmapped' }), 'lib-1');
  assert.equal(unmapped.status, 'unmapped-provider-file');
  assert.equal(unmapped.mappingState, 'unmapped');
  const absent = resolvePromotionTarget({
    getLibraryItem: () => ({ id: 'lib-1' }),
    listBindings: () => [{ status: 'active', placementId: 'pl-1', providerFileId: 'pf-9' }],
    listProviderFiles: () => [],
    getTorrentFile: () => null,
  }, 'lib-1');
  assert.equal(absent.status, 'unmapped-provider-file');
  assert.equal(absent.mappingState, 'absent');
});

// ─── verification ───
test('promotion verify: exact file passes; mismatch and sparse fail', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'promo-verify-'));
  const good = path.join(dir, 'good.bin');
  await fsp.writeFile(good, Buffer.alloc(4096, 7));
  assert.ok((await verifyStagedFile(good, 4096)).ok);
  const short = path.join(dir, 'short.bin');
  await fsp.writeFile(short, Buffer.alloc(100, 7));
  const mismatch = await verifyStagedFile(short, 4096);
  assert.ok(!mismatch.ok && mismatch.reason.startsWith('size-mismatch'));
  const sparse = path.join(dir, 'sparse.bin');
  const handle = await fsp.open(sparse, 'w');
  await handle.truncate(1024 * 1024);
  await handle.close();
  const sparseVerdict = await verifyStagedFile(sparse, 1024 * 1024);
  assert.ok(!sparseVerdict.ok && sparseVerdict.reason.startsWith('sparse-file'));
  await fsp.rm(dir, { recursive: true, force: true });
});

// ─── worker: acquisition → verify → atomic placement ───
function stubFetch(bytes) {
  return async () => ({
    ok: true,
    status: 200,
    body: (async function* stream() { yield Buffer.from(bytes); })(),
  });
}

test('promotion worker: exact bytes become permanent; short stream fails clean', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'promo-work-'));
  const finalPath = path.join(root, 'Movies', 'T', 'T.mkv');
  const store = memStore();
  store.request({ ...BASE, size: 8, permanentPath: finalPath });
  const worker = createPromotionWorker({
    promotionStore: store, dataPlaneBaseUrl: 'http://dp:3001', permanentRoot: root,
    fetchFn: stubFetch(Buffer.alloc(8, 9)),
  });
  const done = await worker.tick();
  assert.equal(done.status, 'permanent');
  assert.equal((await fsp.stat(finalPath)).size, 8);
  assert.equal((await fsp.readdir(path.join(root, '.staging'))).length, 0);

  const badPath = path.join(root, 'Movies', 'B', 'B.mkv');
  const store2 = memStore();
  store2.request({ ...BASE, torrentFileId: 'tf-2', size: 8, permanentPath: badPath });
  const worker2 = createPromotionWorker({
    promotionStore: store2, dataPlaneBaseUrl: 'http://dp:3001', permanentRoot: root,
    fetchFn: stubFetch(Buffer.alloc(3)),
  });
  const failed = await worker2.tick();
  assert.equal(failed.status, 'failed');
  assert.equal(store2.get('tf-2').status, PROMOTION_STATUS.FAILED);
  assert.ok(store2.get('tf-2').lastError.includes('incomplete stream'));
  assert.ok(!(await fsp.stat(badPath).catch(() => null)));
  await fsp.rm(root, { recursive: true, force: true });
});

// ─── local serving: 200 / 206 / 416 ───
function mockResponse() {
  const listeners = {};
  return {
    statusCode: null, headers: {}, body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body = Buffer.concat([this.body ?? Buffer.alloc(0), Buffer.from(chunk)]); return true; },
    end(chunk) { if (chunk) this.write(chunk); if (!this.body) this.body = Buffer.alloc(0); },
    on(event, fn) { (listeners[event] ??= []).push(fn); return this; },
    once(event, fn) { (listeners[event] ??= []).push(fn); return this; },
    emit(event, ...args) { for (const fn of listeners[event] ?? []) fn(...args); return true; },
  };
}

test('promotion serve-local: full, range, and unsatisfiable', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'promo-serve-'));
  const file = path.join(dir, 'T.mkv');
  await fsp.writeFile(file, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  const full = mockResponse();
  assert.ok(serveLocalFile(full, file, undefined));
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers['content-length'], 8);
  const range = mockResponse();
  let piped = Buffer.alloc(0);
  const origPipe = fs.createReadStream;
  assert.ok(serveLocalFile(range, file, 'bytes=2-5'));
  assert.equal(range.statusCode, 206);
  assert.equal(range.headers['content-range'], 'bytes 2-5/8');
  assert.equal(range.headers['x-storage'], 'permanent');
  const bad = mockResponse();
  assert.ok(serveLocalFile(bad, file, 'bytes=99-100'));
  assert.equal(bad.statusCode, 416);
  assert.ok(!serveLocalFile(mockResponse(), path.join(dir, 'missing.mkv'), undefined));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fsp.rm(dir, { recursive: true, force: true });
  assert.ok(origPipe);
});
