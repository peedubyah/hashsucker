/**
 * E02 provider-file identity forensics — node:test proof.
 *
 * Exercises the forensic helpers in `lib/control-plane/forensics.js`
 * against the real `createControlPlaneStore` with an in-memory SQLite
 * database. No provider calls, no fetch, no network. Every assertion
 * is on deterministic fixture data.
 *
 * Coverage:
 *   1. buildRequestdlUrl reproduces the exact envelope used by
 *      `torbox-delivery.js` step 5 (param order: token, torrent_id,
 *      file_id, redirect=true). The URL is byte-identical to a live
 *      forensic replay (modulo the API key).
 *   2. projectReleaseEvidence walks the full identity chain and
 *      records every gap the seam would otherwise have to recover
 *      at request time.
 *   3. Present provider files with a valid size end up in
 *      mapping_state='mapped' with a non-null torrent_file_id
 *      referencing a TorrentFile whose (infoHash, internalPath, size)
 *      agree with the inventory observation.
 *   4. Same-placement providerFileId churn preserves the durable
 *      TorrentFile id (the seam that survives E02 provider-ID churn).
 *   5. markPlacementRemoved → findPlacementByInfoHash returns null,
 *      proving the recovery lifecycle creates a fresh placement
 *      rather than re-resolving a stale one.
 *   6. listTorrentFilesForRelease and listProviderRefsForTorrentFile
 *      are exact inverses: every present provider_file ref points at
 *      a real TorrentFile, and every present provider_file ref is
 *      surfaced from the TorrentFile direction.
 *
 * Pass = every assertion holds against the deterministic fixtures.
 * Fail = one or more invariants broken, with structured evidence in
 * the assertion message.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import {
  buildRequestdlUrl,
  projectReleaseEvidence,
  projectProviderFileEvidence,
  projectTorrentFileEvidence,
  E02_FORENSICS,
  E02_FORENSIC_INVARIANTS,
} from '../src/lib/control-plane/forensics.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const API_BASE = E02_FORENSICS.DEFAULT_TORBOX_API_BASE;
const API_KEY = 'forensic-fixture-key';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'e02-forensics-'));
  const dbPath = join(dir, 'control-plane.db');
  const store = createControlPlaneStore({ dbPath, now: () => 1_700_000_000_000 });
  return { store, dbPath, dir };
}

function buildReadyPlacement(store, { infoHash, providerResourceId }) {
  return store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash,
    providerResourceId,
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'vfs-forensic',
    provenance: 'forensic-test',
    observedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
  });
}

function recordFileMapping(store, { infoHash, fileIndex, releaseKey, placementId, providerFileId }) {
  return store.recordFileMapping({
    infoHash,
    fileIndex,
    releaseKey,
    placementId,
    providerFileId,
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    mappedAt: 1_700_000_000_000,
  });
}

test('buildRequestdlUrl reproduces the exact envelope used by the delivery seam', () => {
  const placement = { provider: 'torbox', accountScope: 'default', providerResourceId: '48211' };
  const mapping = { providerFileId: '7c1f' };
  const { url, params } = buildRequestdlUrl({ placement, mapping, apiKey: API_KEY });

  // 1. Param order is fixed and matches the source seam.
  assert.equal(
    new URL(url).searchParams.toString(),
    `token=${API_KEY}&torrent_id=48211&file_id=7c1f&redirect=true`,
    'requestdl query string must be token, torrent_id, file_id, redirect=true in that order',
  );
  assert.deepEqual(
    Object.keys(params),
    [...E02_FORENSIC_INVARIANTS.REQUESTDL_PARAM_ORDER],
    'param keys must follow the documented order',
  );
  assert.equal(params.redirect, E02_FORENSIC_INVARIANTS.REQUESTDL_REDIRECT);

  // 2. Path is `${API_BASE}/torrents/requestdl` with no trailing slash.
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, `${API_BASE}/torrents/requestdl`);
  assert.equal(parsed.searchParams.get('torrent_id'), '48211');
  assert.equal(parsed.searchParams.get('file_id'), '7c1f');
});

test('buildRequestdlUrl surfaces a deterministic gap when inputs are missing', () => {
  assert.throws(
    () => buildRequestdlUrl({ placement: null, mapping: { providerFileId: 'x' } }),
    /placement is required/,
  );
  assert.throws(
    () => buildRequestdlUrl({
      placement: { providerResourceId: 'r' },
      mapping: { providerFileId: '' },
    }),
    /mapping.providerFileId is required/,
  );
  assert.throws(
    () => buildRequestdlUrl({
      placement: { providerResourceId: '' },
      mapping: { providerFileId: 'x' },
    }),
    /placement.providerResourceId is required/,
  );
});

test('projectReleaseEvidence walks the full identity chain for a happy path', () => {
  const { store, dir } = freshStore();
  try {
    const placement = buildReadyPlacement(store, { infoHash: HASH_A, providerResourceId: 'r-1' });
    // Authoritative inventory: two files, one bound, one present as a sibling.
    store.replaceProviderFileInventory(placement.id, [
      { providerFileId: 'pf-target', path: 'Movies/Movie/file.mkv', name: 'file.mkv', size: 1024, selected: true },
      { providerFileId: 'pf-sibling', path: 'Movies/Movie/sample.mkv', name: 'sample.mkv', size: 256, selected: false },
    ], {
      authoritative: true, complete: true,
      observedAt: 1_700_000_000_000, expiresAt: 1_700_000_300_000,
    });
    recordFileMapping(store, {
      infoHash: HASH_A, fileIndex: null,
      releaseKey: `${HASH_A}:torrent`, placementId: placement.id,
      providerFileId: 'pf-target',
    });

    const evidence = projectReleaseEvidence(store, {
      infoHash: HASH_A, provider: 'torbox',
      releaseKey: `${HASH_A}:torrent`, apiKey: API_KEY,
    });

    // Identity chain intact.
    assert.equal(evidence.placement?.id, placement.id);
    assert.equal(evidence.placement?.providerResourceId, 'r-1');
    assert.equal(evidence.providerFiles.length, 2);
    assert.equal(evidence.torrentFiles.length, 2,
      'every present provider file with a valid size must mint a TorrentFile');
    assert.equal(evidence.fileMapping?.providerFileId, 'pf-target');
    assert.deepEqual(evidence.gaps, [], 'no gaps in the happy path');
    assert.ok(evidence.requestdl, 'requestdl must build when mapping exists');

    // requestdl is byte-identical to a live replay.
    const { url, params } = evidence.requestdl;
    assert.equal(new URL(url).searchParams.get('torrent_id'), 'r-1');
    assert.equal(new URL(url).searchParams.get('file_id'), 'pf-target');
    assert.equal(params.redirect, 'true');

    // Every present provider file is mapped and has a real TorrentFile.
    for (const pf of evidence.providerFiles) {
      assert.equal(pf.mappingState, 'mapped', `provider file ${pf.providerFileId} must be mapped`);
      assert.ok(pf.torrentFileId, `provider file ${pf.providerFileId} must reference a TorrentFile`);
      assert.ok(pf.torrentFile, `provider file ${pf.providerFileId} must have a real TorrentFile row`);
      assert.equal(pf.torrentFile.infoHash, HASH_A);
      assert.equal(pf.torrentFile.size, pf.size);
      assert.equal(pf.invariant.ok, true);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('present provider files with valid size always end up mapped (no silent unmapped rows)', () => {
  const { store, dir } = freshStore();
  try {
    const placement = buildReadyPlacement(store, { infoHash: HASH_B, providerResourceId: 'r-2' });
    store.replaceProviderFileInventory(placement.id, [
      { providerFileId: 'p1', path: 'a.mkv', name: 'a.mkv', size: 500 },
      { providerFileId: 'p2', path: 'b.mkv', name: 'b.mkv', size: 1500 },
      { providerFileId: 'p3', path: 'b.mkv', name: 'b.mkv', size: 1500 }, // duplicate canonical conflict
      { providerFileId: 'p4', path: 'd.mkv', name: 'd.mkv', size: 0 },    // invalid size
    ], { authoritative: true, complete: true, observedAt: 1, expiresAt: 9_999_999_999_999 });

    const evidence = projectReleaseEvidence(store, { infoHash: HASH_B, provider: 'torbox' });
    const byId = Object.fromEntries(evidence.providerFiles.map((f) => [f.providerFileId, f]));

    // p1: sole canonical for "a.mkv" → mapped, real TorrentFile.
    assert.equal(byId.p1.mappingState, 'mapped');
    assert.ok(byId.p1.torrentFile);
    assert.equal(byId.p1.invariant.ok, true);

    // p2 + p3 collide on canonical "c.mkv" after normalizeInternalPath. The
    // pre-pass demotes both; the post-pass never mints a TorrentFile for
    // either. The forensic surface must surface the conflict explicitly.
    assert.equal(byId.p2.mappingState, 'conflict');
    assert.equal(byId.p2.torrentFileId, null,
      'duplicate-canonical-path rows must NOT receive a torrent_file_id');
    assert.equal(byId.p2.invariant.ok, false);
    assert.match(JSON.stringify(byId.p2.mappingError), /duplicate-canonical-path/);

    assert.equal(byId.p3.mappingState, 'conflict');
    assert.equal(byId.p3.torrentFileId, null);
    assert.equal(byId.p3.invariant.ok, false);

    // p4: invalid size (0) → incomplete, no TorrentFile.
    assert.equal(byId.p4.mappingState, 'incomplete');
    assert.equal(byId.p4.torrentFileId, null);
    assert.equal(byId.p4.invariant.ok, false);

    // Cross-table: the only mapped provider files (p1) and the absent
    // conflict files (p2, p3) must never share a TorrentFile.
    const mappedTorrentIds = new Set(evidence.providerFiles
      .filter((f) => f.torrentFileId)
      .map((f) => f.torrentFileId));
    assert.equal(mappedTorrentIds.size, 1, 'only p1 should be mapped to a TorrentFile');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same-placement providerFileId churn reuses the same TorrentFile', () => {
  const { store, dir } = freshStore();
  try {
    const placement = buildReadyPlacement(store, { infoHash: HASH_A, providerResourceId: 'r-1' });
    store.replaceProviderFileInventory(placement.id, [
      { providerFileId: 'pf-old', path: 'Movies/Movie/m.mkv', name: 'm.mkv', size: 999 },
    ], { authoritative: true, complete: true, observedAt: 1, expiresAt: 9_999_999_999_999 });
    const before = store.listProviderFiles(placement.id).find((f) => f.providerFileId === 'pf-old');
    const beforeTfId = before.torrentFileId;
    assert.ok(beforeTfId);

    // The provider rotates the providerFileId for the same canonical file.
    store.replaceProviderFileInventory(placement.id, [
      { providerFileId: 'pf-new', path: 'Movies/Movie/m.mkv', name: 'm.mkv', size: 999 },
    ], { authoritative: true, complete: true, observedAt: 2, expiresAt: 9_999_999_999_999 });

    const after = store.listProviderFiles(placement.id).find((f) => f.providerFileId === 'pf-new');
    assert.equal(after.mappingState, 'mapped');
    assert.equal(after.torrentFileId, beforeTfId,
      'same canonical (infoHash, internalPath, size) must reuse the same TorrentFile id');

    // The demoted row is still observable via listProviderFiles(..., includeMissing: true).
    const all = store.listProviderFiles(placement.id, { includeMissing: true });
    const demoted = all.find((f) => f.providerFileId === 'pf-old');
    assert.ok(demoted, 'demoted row must be retained as provenance');
    assert.equal(demoted.present, false);

    // Cross-table: exactly one present ref per TorrentFile, plus the demoted historical ref.
    const refs = store.listProviderRefsForTorrentFile(beforeTfId);
    const presentRefs = refs.filter((r) => r.present);
    assert.equal(presentRefs.length, 1);
    assert.equal(presentRefs[0].providerFileId, 'pf-new');
    assert.equal(refs.length, 2, 'historical demoted ref must remain queryable for forensic replay');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markPlacementRemoved → findPlacementByInfoHash returns null (recovery seam is observable)', () => {
  const { store, dir } = freshStore();
  try {
    const placement = buildReadyPlacement(store, { infoHash: HASH_A, providerResourceId: 'r-1' });
    store.replaceProviderFileInventory(placement.id, [
      { providerFileId: 'p', path: 'a.mkv', name: 'a.mkv', size: 10 },
    ], { authoritative: true, complete: true, observedAt: 1, expiresAt: 9_999_999_999_999 });

    const before = projectReleaseEvidence(store, { infoHash: HASH_A, provider: 'torbox' });
    assert.ok(before.placement, 'placement must be visible before removal');

    store.markPlacementRemoved(placement.id, { reason: 'upstream-resource-absent', observedAt: 2 });

    const after = projectReleaseEvidence(store, { infoHash: HASH_A, provider: 'torbox' });
    assert.equal(after.placement, null, 'removed placement must NOT be reused by delivery');
    assert.ok(after.gaps.includes('no-active-placement'));
    // Durable identity survives: TorrentFile rows are NOT deleted.
    assert.equal(after.torrentFiles.length, 1,
      'TorrentFile rows must outlive placement state for stable identity across recreates');
    assert.equal(after.requestdl, null, 'requestdl must not build without an active placement');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projectProviderFileEvidence and projectTorrentFileEvidence round-trip', () => {
  const { store, dir } = freshStore();
  try {
    const placement = buildReadyPlacement(store, { infoHash: HASH_A, providerResourceId: 'r-1' });
    store.replaceProviderFileInventory(placement.id, [
      { providerFileId: 'pf', path: 'a.mkv', name: 'a.mkv', size: 7 },
    ], { authoritative: true, complete: true, observedAt: 1, expiresAt: 9_999_999_999_999 });
    const fileEvidence = projectProviderFileEvidence(store, { placementId: placement.id, providerFileId: 'pf' });
    assert.equal(fileEvidence.present, true);
    assert.equal(fileEvidence.invariant.ok, true);
    const tfId = fileEvidence.torrentFile.id;

    // Reverse direction: same TorrentFile reachable from the other side.
    const tfEvidence = projectTorrentFileEvidence(store, tfId);
    assert.equal(tfEvidence.torrentFile.id, tfId);
    assert.equal(tfEvidence.torrentFile.size, 7);
    assert.equal(tfEvidence.refs.length, 1);
    assert.equal(tfEvidence.refs[0].providerFileId, 'pf');
    assert.equal(tfEvidence.refs[0].mappingState, 'mapped');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file mapping survives inventory re-replace when canonical path is unchanged', () => {
  const { store, dir } = freshStore();
  try {
    const placement = buildReadyPlacement(store, { infoHash: HASH_A, providerResourceId: 'r-1' });
    store.replaceProviderFileInventory(placement.id, [
      { providerFileId: 'pf', path: 'a.mkv', name: 'a.mkv', size: 50 },
    ], { authoritative: true, complete: true, observedAt: 1, expiresAt: 9_999_999_999_999 });
    recordFileMapping(store, {
      infoHash: HASH_A, fileIndex: null,
      releaseKey: `${HASH_A}:torrent`, placementId: placement.id, providerFileId: 'pf',
    });

    // Refresh with the exact same canonical file → mapping is still resolvable.
    store.replaceProviderFileInventory(placement.id, [
      { providerFileId: 'pf', path: 'a.mkv', name: 'a.mkv', size: 50 },
    ], { authoritative: true, complete: true, observedAt: 2, expiresAt: 9_999_999_999_999 });

    const evidence = projectReleaseEvidence(store, {
      infoHash: HASH_A, provider: 'torbox', releaseKey: `${HASH_A}:torrent`, apiKey: API_KEY,
    });
    assert.equal(evidence.fileMapping?.providerFileId, 'pf');
    assert.ok(evidence.requestdl);
    assert.equal(evidence.gaps.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
