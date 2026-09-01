import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

const HASH = '33c59643327641d632ca814532f8aa0b746bdb43';
const OTHER_HASH = '95056ef42612f64bd0f8934dc0821c4e6cf568a2';

function setupPlacement(store, infoHash, providerResourceId) {
  return store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash,
    providerResourceId,
    state: 'ready',
    ownership: 'external',
    provenance: 'torbox-inventory',
    idempotencyKey: `torbox:${providerResourceId}`,
    observedAt: 0,
  });
}

function mappedFile(pf) {
  assert.equal(pf.mappingState, 'mapped');
  assert.equal(pf.mappingError, null);
  assert.ok(pf.torrentFileId);
}

test('valid-size inventory mints a TorrentFile and exposes it on the provider file', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const placement = setupPlacement(store, HASH, 'torrent-basic');
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: '0', path: 'Biscuits.mkv', name: 'Biscuits.mkv', size: 1_000 },
    { providerFileId: '1', path: 'sub/E02.mkv', name: 'E02.mkv', size: 2_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  const tfs = store.listTorrentFilesForRelease(HASH);
  assert.equal(tfs.length, 2);
  const e02 = tfs.find((tf) => tf.internalPath === 'sub/E02.mkv');
  assert.ok(e02);
  assert.equal(e02.size, 2_000);
  const files = store.listProviderFiles(placement.id);
  const e02File = files.find((f) => f.providerFileId === '1');
  mappedFile(e02File);
  assert.equal(e02File.torrentFileId, e02.id);
  // Re-inventory with the same content must not create new TorrentFiles and
  // must not update torrent_files.size.
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: '0', path: 'Biscuits.mkv', name: 'Biscuits.mkv', size: 1_000 },
    { providerFileId: '1', path: 'sub/E02.mkv', name: 'E02.mkv', size: 2_000 },
  ], { authoritative: true, complete: true, observedAt: 100, expiresAt: 9_999_999_999_999 });
  assert.equal(store.listTorrentFilesForRelease(HASH).length, 2);
  const sameE02 = store.findTorrentFile(HASH, 'sub/E02.mkv');
  assert.equal(sameE02.size, 2_000);
  store.close();
});

test('invalid size (null/0/negative) leaves the provider file unmapped as incomplete', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const placement = setupPlacement(store, HASH, 'torrent-invalidsize');
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: '0', path: 'a.mkv', name: 'a.mkv', size: null },
    { providerFileId: '1', path: 'b.mkv', name: 'b.mkv', size: 0 },
    { providerFileId: '2', path: 'c.mkv', name: 'c.mkv', size: -1 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  assert.equal(store.listTorrentFilesForRelease(HASH).length, 0);
  const files = store.listProviderFiles(placement.id);
  assert.equal(files.length, 3);
  for (const file of files) {
    assert.equal(file.mappingState, 'incomplete');
    assert.equal(file.torrentFileId, null);
    assert.ok(file.mappingError, 'mapping_error must explain the incomplete state');
  }
  store.close();
});

test('same-placement providerFileId churn reuses the same TorrentFile by re-pointing provider_files', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  // Initial observation: providerFileId 7.
  const p1 = setupPlacement(store, HASH, 'torrent-churn-a');
  store.replaceProviderFileInventory(p1.id, [
    { providerFileId: '7', path: 'Ted.Lasso.mkv', name: 'Ted.Lasso.mkv', size: 7_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  const [torrentFileBefore] = store.listTorrentFilesForRelease(HASH);
  const torrentFileId = torrentFileBefore.id;
  const p1Files = store.listProviderFiles(p1.id);
  assert.equal(p1Files.length, 1);
  assert.equal(p1Files[0].providerFileId, '7');
  mappedFile(p1Files[0]);
  // Re-observe under a new providerFileId in the SAME placement. The old row
  // becomes present=0; the new row maps to the same TorrentFile.
  store.replaceProviderFileInventory(p1.id, [
    { providerFileId: '12', path: 'Ted.Lasso.mkv', name: 'Ted.Lasso.mkv', size: 7_000 },
  ], { authoritative: true, complete: true, observedAt: 100, expiresAt: 9_999_999_999_999 });
  const allP1Files = store.listProviderFiles(p1.id, { includeMissing: true });
  const presentP1 = allP1Files.filter((f) => f.present);
  assert.equal(presentP1.length, 1);
  assert.equal(presentP1[0].providerFileId, '12');
  assert.equal(presentP1[0].torrentFileId, torrentFileId);
  mappedFile(presentP1[0]);
  // Old providerFileId 7 row is retained for provenance but no longer
  // present; it must still point at the same TorrentFile.
  const oldRow = allP1Files.find((f) => f.providerFileId === '7');
  assert.equal(oldRow.present, false);
  assert.equal(oldRow.torrentFileId, torrentFileId);
  // Still one TorrentFile.
  const after = store.listTorrentFilesForRelease(HASH);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, torrentFileId);
  // The refs (provider_files with torrent_file_id set) include the historical
  // 7 row and the new 12 row.
  const refs = store.listProviderRefsForTorrentFile(torrentFileId);
  const refIds = new Set(refs.map((r) => r.providerFileId));
  assert.ok(refIds.has('7') && refIds.has('12'));
  store.close();
});

test('new placement reuses the same TorrentFile for the same canonical (infoHash, internalPath) and size', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const p1 = setupPlacement(store, HASH, 'torrent-reuse-a');
  store.replaceProviderFileInventory(p1.id, [
    { providerFileId: '5', path: 'Ted.Lasso.mkv', name: 'Ted.Lasso.mkv', size: 7_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  const [first] = store.listTorrentFilesForRelease(HASH);
  const p2 = setupPlacement(store, HASH, 'torrent-reuse-b');
  store.replaceProviderFileInventory(p2.id, [
    { providerFileId: '5', path: 'Ted.Lasso.mkv', name: 'Ted.Lasso.mkv', size: 7_000 },
  ], { authoritative: true, complete: true, observedAt: 100, expiresAt: 9_999_999_999_999 });
  const after = store.listTorrentFilesForRelease(HASH);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, first.id);
  // Both placements now point at the same TorrentFile.
  const refs = store.listProviderRefsForTorrentFile(first.id);
  const placementIds = new Set(refs.map((r) => r.placementId));
  assert.ok(placementIds.has(p1.id) && placementIds.has(p2.id));
  store.close();
});

test('duplicate canonical path with the same size is still a mapping conflict', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const placement = setupPlacement(store, HASH, 'torrent-dup-same');
  // Two distinct providerFileIds in the same placement canonicalize to the
  // same internal path. Equal size does NOT permit merging; neither row may
  // become the authoritative mapped provider ref.
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: '1', path: 'movie.mkv', name: 'movie.mkv', size: 5_000 },
    { providerFileId: '2', path: './movie.mkv', name: 'movie.mkv', size: 5_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  // No TorrentFile is minted because the canonical path is ambiguous within
  // this placement; the conflict is durable on the provider_files rows.
  const tfs = store.listTorrentFilesForRelease(HASH);
  assert.equal(tfs.length, 0);
  const files = store.listProviderFiles(placement.id);
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.equal(file.mappingState, 'conflict');
    assert.equal(file.torrentFileId, null,
      'no provider file becomes an authoritative mapper for the duplicate path');
    assert.equal(file.mappingError.reason, 'duplicate-canonical-path');
  }
  store.close();
});

test('duplicate canonical path with different size is a mapping conflict; no TorrentFile is minted', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const placement = setupPlacement(store, HASH, 'torrent-dup-diff');
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: '1', path: 'movie.mkv', name: 'movie.mkv', size: 5_000 },
    { providerFileId: '2', path: './movie.mkv', name: 'movie.mkv', size: 9_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  // No TorrentFile is minted when the canonical path is ambiguous within
  // this placement; both provider_files observations stay in conflict.
  const tfs = store.listTorrentFilesForRelease(HASH);
  assert.equal(tfs.length, 0);
  const files = store.listProviderFiles(placement.id);
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.equal(file.mappingState, 'conflict');
    assert.equal(file.torrentFileId, null);
    assert.equal(file.mappingError.reason, 'duplicate-canonical-path');
  }
  store.close();
});

test('cross-placement same (infoHash, internalPath) with different size keeps the original TorrentFile immutable', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const p1 = setupPlacement(store, HASH, 'torrent-cross-1');
  const p2 = setupPlacement(store, HASH, 'torrent-cross-2');
  store.replaceProviderFileInventory(p1.id, [
    { providerFileId: '0', path: 'movie.mkv', name: 'movie.mkv', size: 5_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  store.replaceProviderFileInventory(p2.id, [
    { providerFileId: '0', path: './movie.mkv', name: 'movie.mkv', size: 9_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  // Only one TorrentFile exists with the FIRST observed size.
  const tfs = store.listTorrentFilesForRelease(HASH);
  assert.equal(tfs.length, 1);
  assert.equal(tfs[0].size, 5_000);
  // The conflicting provider_files row is durable, present, and in 'conflict'.
  const p2Files = store.listProviderFiles(p2.id);
  assert.equal(p2Files.length, 1);
  assert.equal(p2Files[0].mappingState, 'conflict');
  assert.equal(p2Files[0].torrentFileId, null,
    'size-conflict row must NOT carry a torrent_file_id (would pollute listProviderRefsForTorrentFile)');
  assert.equal(p2Files[0].mappingError.reason, 'size-conflict');
  assert.equal(p2Files[0].mappingError.existingTorrentFileId, tfs[0].id,
    'mapping_error must reference the existing TorrentFile for context');
  store.close();
});

test('same-placement INTER-CALL size conflict preserves historical mapping and surfaces new row as conflict', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const placement = setupPlacement(store, HASH, 'torrent-intercall');
  // First inventory: providerFileId A is mapped to the (only) TorrentFile.
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: 'A', path: 'x.mkv', name: 'x.mkv', size: 5 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  const [torrentFile] = store.listTorrentFilesForRelease(HASH);
  assert.equal(torrentFile.size, 5);
  const firstRow = store.listProviderFiles(placement.id)[0];
  assert.equal(firstRow.providerFileId, 'A');
  assert.equal(firstRow.mappingState, 'mapped');
  assert.equal(firstRow.torrentFileId, torrentFile.id);
  // Second inventory under a NEW providerFileId but the same canonical path
  // and a different positive size. The prior present row is the valid
  // historical mapping for the only TorrentFile. Assigning a torrent_file_id
  // to the new row would violate the partial unique index and roll back.
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: 'B', path: 'x.mkv', name: 'x.mkv', size: 9 },
  ], { authoritative: true, complete: true, observedAt: 100, expiresAt: 9_999_999_999_999 });
  // Still exactly one TorrentFile; its size is the first observed value and
  // is never updated.
  const tfsAfter = store.listTorrentFilesForRelease(HASH);
  assert.equal(tfsAfter.length, 1);
  assert.equal(tfsAfter[0].id, torrentFile.id);
  assert.equal(tfsAfter[0].size, 5);
  // The new providerFileId B is present=1, in 'conflict', with NO
  // torrent_file_id; its mapping_error points at the existing TorrentFile.
  const bRow = store.listProviderFiles(placement.id).find((f) => f.providerFileId === 'B');
  assert.ok(bRow);
  assert.equal(bRow.present, true);
  assert.equal(bRow.mappingState, 'conflict');
  assert.equal(bRow.torrentFileId, null,
    'size-conflict row must NOT be assigned a torrent_file_id');
  assert.equal(bRow.mappingError.reason, 'size-conflict');
  assert.equal(bRow.mappingError.existingTorrentFileId, torrentFile.id);
  assert.equal(bRow.mappingError.observedSize, 9);
  // The historical provider_files row for A becomes present=0 (disappeared
  // from this inventory) but RETAINS its torrent_file_id linkage, so
  // listProviderRefsForTorrentFile still surfaces the historical ref.
  const allRows = store.listProviderFiles(placement.id, { includeMissing: true });
  const aRow = allRows.find((f) => f.providerFileId === 'A');
  assert.ok(aRow);
  assert.equal(aRow.present, false);
  assert.equal(aRow.torrentFileId, torrentFile.id,
    'historical mapping for A is preserved across the inter-call conflict');
  const refs = store.listProviderRefsForTorrentFile(torrentFile.id);
  const refIds = new Set(refs.map((r) => r.providerFileId));
  assert.ok(refIds.has('A'),
    'historical providerFileId A still appears in listProviderRefsForTorrentFile');
  store.close();
});

test('different infoHash keeps TorrentFiles partitioned even when the path collides', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const p1 = setupPlacement(store, HASH, 'torrent-part-a');
  const p2 = setupPlacement(store, OTHER_HASH, 'torrent-part-b');
  store.replaceProviderFileInventory(p1.id, [
    { providerFileId: '0', path: 'x.mkv', name: 'x.mkv', size: 1_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  store.replaceProviderFileInventory(p2.id, [
    { providerFileId: '0', path: 'x.mkv', name: 'x.mkv', size: 2_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  assert.equal(store.listTorrentFilesForRelease(HASH).length, 1);
  assert.equal(store.listTorrentFilesForRelease(OTHER_HASH).length, 1);
  assert.notEqual(
    store.listTorrentFilesForRelease(HASH)[0].id,
    store.listTorrentFilesForRelease(OTHER_HASH)[0].id,
  );
  store.close();
});

test('parent-traversal provider path is rejected and never produces a TorrentFile', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const placement = setupPlacement(store, HASH, 'torrent-bad');
  assert.throws(() => {
    store.replaceProviderFileInventory(placement.id, [
      { providerFileId: '0', path: '../escape.mkv', name: 'escape.mkv', size: 1_000 },
    ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  }, /above the torrent root/);
  assert.equal(store.listTorrentFilesForRelease(HASH).length, 0);
  store.close();
});

test('canonicalization strips a single leading / and a single leading ./; preserves case and Unicode', () => {
  const store = createControlPlaneStore({ now: () => 1_000 });
  const placement = setupPlacement(store, HASH, 'torrent-canon');
  // Real-Debrid framing with a single leading slash and a ./ segment,
  // interleaved with case-sensitive CJK characters.
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: '0', path: '/./电影/絕命毒師.S01E01.mkv', name: '絕命毒師.S01E01.mkv', size: 4_000 },
  ], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  const all = store.listTorrentFilesForRelease(HASH);
  assert.equal(all.length, 1);
  assert.equal(all[0].internalPath, '电影/絕命毒師.S01E01.mkv');
  assert.equal(all[0].size, 4_000);
  store.close();
});
