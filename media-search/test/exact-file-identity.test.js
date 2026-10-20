/**
 * EXACT FILE IDENTITY — a provider file may carry a route to a
 * TorrentFile only when it proves it IS that file.
 *
 * The same hash means the same RELEASE. It does not mean the same file:
 * a resource holds many files, renamed paths, reordered lists, extras and
 * duplicates.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  exactFileIdentity,
  selectExactProviderFile,
  canonicalProviderPath,
  canonicalProviderFilePathCandidates,
  EXACT_FILE_REJECTIONS,
} from '../src/lib/providers/exact-file-identity.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createSecondPlacementEnsurer } from '../src/lib/control-plane/second-placement.js';

const HASH = 'a'.repeat(40);
const NOW = 1_700_000_000_000;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

const TF = { path: 'Root/Movie.mkv', size: 1000 };

// ── 1. the accepted case ──────────────────────────────────────────────────
test('same hash + exact path + exact size is accepted', () => {
  const identity = exactFileIdentity({
    provider: 'torbox', providerPath: 'Root/Movie.mkv', providerSize: 1000,
    torrentFilePath: TF.path, torrentFileSize: TF.size,
  });
  assert.equal(identity.matched, true);
});

// ── 2-5. the rejections ───────────────────────────────────────────────────
test('same hash + wrong path is rejected', () => {
  const identity = exactFileIdentity({
    provider: 'torbox', providerPath: 'Root/Other.mkv', providerSize: 1000,
    torrentFilePath: TF.path, torrentFileSize: TF.size,
  });
  assert.equal(identity.matched, false);
  assert.equal(identity.reason, EXACT_FILE_REJECTIONS.PATH_MISMATCH);
});

test('same hash + wrong size is rejected', () => {
  const identity = exactFileIdentity({
    provider: 'torbox', providerPath: 'Root/Movie.mkv', providerSize: 999,
    torrentFilePath: TF.path, torrentFileSize: TF.size,
  });
  assert.equal(identity.matched, false);
  assert.equal(identity.reason, EXACT_FILE_REJECTIONS.SIZE_MISMATCH);
});

test('same hash + same basename in a different directory is rejected', () => {
  const identity = exactFileIdentity({
    provider: 'torbox', providerPath: 'Other/Movie.mkv', providerSize: 1000,
    torrentFilePath: TF.path, torrentFileSize: TF.size,
  });
  assert.equal(identity.matched, false,
    'a basename is not an identity: the directory is part of the path');
  assert.equal(identity.reason, EXACT_FILE_REJECTIONS.PATH_MISMATCH);
});

test('same hash + same size + different path is rejected', () => {
  const identity = exactFileIdentity({
    provider: 'torbox', providerPath: 'Root/Other.mkv', providerSize: 1000,
    torrentFilePath: TF.path, torrentFileSize: TF.size,
  });
  assert.equal(identity.matched, false);
});

// ── 6. provider framings ──────────────────────────────────────────────────
test('the Real-Debrid framing (root + relative path) reconciles with the full path', () => {
  const candidates = canonicalProviderFilePathCandidates('realdebrid', 'Movie.mkv', 'Root');
  assert.deepEqual(candidates, ['Root/Movie.mkv', 'Movie.mkv']);
  const identity = exactFileIdentity({
    provider: 'realdebrid', providerPath: 'Movie.mkv', providerRoot: 'Root',
    providerSize: 1000, torrentFilePath: 'Root/Movie.mkv', torrentFileSize: 1000,
  });
  assert.equal(identity.matched, true);
});

test('the path normalization is the minimum: no case folding, no interior collapsing', () => {
  assert.equal(canonicalProviderPath('/Root/Movie.mkv'), 'Root/Movie.mkv');
  assert.equal(canonicalProviderPath('./Root/Movie.mkv'), 'Root/Movie.mkv');
  assert.equal(canonicalProviderPath('Root//Movie.mkv'), 'Root//Movie.mkv');
  assert.equal(canonicalProviderPath('Root/Movie.MKV'), 'Root/Movie.MKV',
    'the comparison is case-sensitive: the providers preserve case');
  assert.equal(canonicalProviderPath('../escape.mkv'), null);
  assert.equal(canonicalProviderPath('Root/../escape.mkv'), null);
});

// ── 7. ambiguity ──────────────────────────────────────────────────────────
test('zero exact matches → no route; one → the route; many → ambiguous', () => {
  const files = [
    { path: 'Root/A.mkv', size: 1000 },
    { path: 'Root/B.mkv', size: 1000 },
  ];
  assert.equal(selectExactProviderFile({
    provider: 'torbox', providerFiles: files, torrentFilePath: 'Root/C.mkv', torrentFileSize: 1000,
  }).reason, EXACT_FILE_REJECTIONS.NOT_FOUND);

  const one = selectExactProviderFile({
    provider: 'torbox', providerFiles: files, torrentFilePath: 'Root/A.mkv', torrentFileSize: 1000,
  });
  assert.equal(one.matches, 1);
  assert.equal(one.file.path, 'Root/A.mkv');

  const ambiguous = selectExactProviderFile({
    provider: 'torbox',
    providerFiles: [{ path: 'Root/A.mkv', size: 1000 }, { path: 'Root/A.mkv', size: 1000 }],
    torrentFilePath: 'Root/A.mkv', torrentFileSize: 1000,
  });
  assert.equal(ambiguous.matches, 2);
  assert.equal(ambiguous.file, null, 'never pick the first of several');
  assert.equal(ambiguous.reason, EXACT_FILE_REJECTIONS.AMBIGUOUS);
});

// ── 8. a reordered provider list does not remap ──────────────────────────
test('a reordered provider file list does not remap the TorrentFile', (t) => {
  const dir = tempDir(t, 'hs-exact-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });

  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH, providerResourceId: 'res-1',
    state: 'ready', ownership: 'owned', ownerKey: 'owner', provenance: 'exact-test',
    observedAt: NOW, expiresAt: NOW + 3_600_000,
  });
  const inventory = [
    { providerFileId: '1', path: 'Root/A.mkv', name: 'A.mkv', size: 1000, selected: true },
    { providerFileId: '2', path: 'Root/B.mkv', name: 'B.mkv', size: 2000, selected: true },
  ];
  store.replaceProviderFileInventory(placement.id, inventory, {
    authoritative: true, complete: true, observedAt: NOW, expiresAt: NOW + 3_600_000,
  });

  const before = store.listProviderFiles(placement.id).map((f) => ({
    providerFileId: f.providerFileId, torrentFileId: f.torrentFileId, size: f.size,
  }));
  const tfA = before.find((f) => f.size === 1000).torrentFileId;
  const tfB = before.find((f) => f.size === 2000).torrentFileId;
  assert.ok(tfA && tfB);
  assert.notEqual(tfA, tfB, 'two files are two TorrentFiles');

  // The provider reorders its listing. The identity is the path + size, so
  // the mapping must not move.
  store.replaceProviderFileInventory(placement.id, [...inventory].reverse(), {
    authoritative: true, complete: true, observedAt: NOW + 1000, expiresAt: NOW + 3_600_000,
  });
  const after = store.listProviderFiles(placement.id).map((f) => ({
    providerFileId: f.providerFileId, torrentFileId: f.torrentFileId, size: f.size,
  }));
  const aAfter = after.find((f) => f.size === 1000);
  assert.equal(aAfter.torrentFileId, tfA, 'the TorrentFile did not follow the list position');
  assert.equal(after.find((f) => f.size === 2000).torrentFileId, tfB);
});

// ── 9. the second-placement ensurer is exact-TorrentFile scoped ───────────
test('the second-placement ensurer refuses a resource that does not expose our exact file', async (t) => {
  const dir = tempDir(t, 'hs-exact-ensure-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });

  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES ('tf-ours', ?, 'Root/Movie.mkv', 1000, ?)
  `).run(HASH, NOW);

  const torbox = {
    async lookupPlacement() { return null; },
    async getFileInventory() {
      // The account holds the SAME RELEASE, but a different file.
      return { files: [{ providerFileId: '9', path: 'Root/Other.mkv', name: 'Other.mkv', size: 4242, selected: true }] };
    },
    async checkCached() { return { cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() }; },
    async createPlacement() { throw new Error('must not create'); },
  };
  const ensurer = createSecondPlacementEnsurer({ store, torbox, realdebrid: null, now: () => NOW });
  const outcome = await ensurer.ensureSecondPlacement({
    torrentFileId: 'tf-ours', infoHash: HASH, fileIndex: null,
    filename: 'Movie.mkv', releaseKey: `${HASH}:torrent`, provider: 'torbox',
    providerState: 'cached', identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: NOW, canonicalTitle: 'Movie',
  });
  assert.notEqual(outcome.status, 'created',
    'a resource that does not expose our exact file is not a route to it');
  assert.ok(['failed', 'unavailable'].includes(outcome.status));
});

// ── 10. a replacement resource needs an exact re-match ──────────────────
test('a replacement resource for the same hash is not accepted without the exact file', async (t) => {
  const dir = tempDir(t, 'hs-exact-replace-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db'), now: () => NOW });
  const cache = createDiscoveryCache();
  t.after(() => { cache.close(); store.close(); });

  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES ('tf-ours', ?, 'Root/Movie.mkv', 1000, ?)
  `).run(HASH, NOW);

  const torbox = {
    async lookupPlacement() { return { providerResourceId: 'res-new', state: 'ready' }; },
    async getFileInventory() {
      // The replacement resource holds the release, but not our file.
      return { files: [{ providerFileId: '9', path: 'Root/Other.mkv', name: 'Other.mkv', size: 4242, selected: true }] };
    },
    async checkCached() { return { cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() }; },
    async createPlacement() { throw new Error('must not create'); },
  };
  const ensurer = createSecondPlacementEnsurer({ store, torbox, realdebrid: null, now: () => NOW });
  const outcome = await ensurer.ensureSecondPlacement({
    torrentFileId: 'tf-ours', infoHash: HASH, fileIndex: null,
    filename: 'Movie.mkv', releaseKey: `${HASH}:torrent`, provider: 'torbox',
    providerState: 'cached', identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: NOW, canonicalTitle: 'Movie',
  });
  assert.notEqual(outcome.status, 'created',
    'the same hash is not the same file: the route must fail closed');
});
