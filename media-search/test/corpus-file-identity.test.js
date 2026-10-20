/**
 * THE CORPUS KNOWS THE FILE — the per-file identity chain.
 *
 * The corpus's rows are release-level (the audit: 1 593 141 rows, none
 * with a file-level path). These tests pin the chain that carries a
 * per-file path when a source CAN supply one, and the discipline that a
 * pathless row never masquerades as an exact file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  classifyCandidateIdentity,
  identityLabelFor,
  CANDIDATE_IDENTITY,
} from '../src/lib/discovery/candidate-identity.js';
import { ensureTorBoxFileIdentity } from '../src/lib/resolver/torbox-file-identity.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

const HASH = 'd'.repeat(40);

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// ── 1. the identity strength is explicit ───────────────────────────────────
test('a candidate states how strongly it identifies a file', () => {
  assert.deepEqual(
    classifyCandidateIdentity({ infoHash: HASH, internalPath: 'Root/Movie.mkv', exactFileSize: 1000 }),
    { strength: CANDIDATE_IDENTITY.EXACT_FILE, exact: true, reason: null },
  );
  assert.deepEqual(
    classifyCandidateIdentity({ infoHash: HASH, internalPath: null, exactFileSize: 1000 }),
    { strength: CANDIDATE_IDENTITY.SIZE_CORROBORATED, exact: false, reason: 'no-file-path' },
  );
  assert.deepEqual(
    classifyCandidateIdentity({ infoHash: HASH, internalPath: 'Root/Movie.mkv', exactFileSize: null }),
    { strength: CANDIDATE_IDENTITY.SIZE_CORROBORATED, exact: false, reason: 'no-exact-size' },
  );
  assert.deepEqual(
    classifyCandidateIdentity({ infoHash: HASH }),
    { strength: CANDIDATE_IDENTITY.RELEASE_ONLY, exact: false, reason: 'no-per-file-fact' },
  );
  assert.equal(identityLabelFor({ identityStrength: 'exact-file' }), 'exact-file');
});

// ── 2. the corpus's per-file record can carry the path, and keeps it ─────
test('a per-file path survives ingest, read and restart', async (t) => {
  const dbPath = path.join(tempDir(t, 'hs-corpus-'), 'discovery.db');
  const cache = createDiscoveryCache({ dbPath });
  t.after(() => cache.close());

  storeReleaseAttributes(cache, {
    infoHash: HASH,
    fileIndex: 3,
    source: 'test-source',
    filename: 'Movie.mkv',
    confidence: 0.9,
    filePath: 'Root/Season 1/Movie.mkv',
    fileSize: 1000,
  });
  const stored = cache.getReleaseAttributes(HASH, 3, 'test-source')[0];
  assert.equal(stored.filePath, 'Root/Season 1/Movie.mkv', 'the nested path is preserved');
  assert.equal(stored.fileSize, 1000);
  cache.close();

  // Restart: the path is still there.
  const cache2 = createDiscoveryCache({ dbPath });
  t.after(() => cache2.close());
  const afterRestart = cache2.getReleaseAttributes(HASH, 3, 'test-source')[0];
  assert.equal(afterRestart.filePath, 'Root/Season 1/Movie.mkv');
  assert.equal(afterRestart.fileSize, 1000);
});

// ── 3. an old pathless row stays backwards compatible ─────────────────────
test('a pathless row is still a valid release-level row', async (t) => {
  const cache = createDiscoveryCache({ dbPath: path.join(tempDir(t, 'hs-corpus-old-'), 'discovery.db') });
  t.after(() => cache.close());
  storeReleaseAttributes(cache, {
    infoHash: HASH,
    fileIndex: null,
    source: 'legacy-source',
    filename: 'Some.Release.2023.1080p-GRP.torrent',
    confidence: 0.8,
  });
  const stored = cache.getReleaseAttributes(HASH, null, 'legacy-source')[0];
  assert.equal(stored.filePath, null, 'no path is not a failure');
  assert.equal(stored.fileSize, null);
  assert.equal(stored.filename, 'Some.Release.2023.1080p-GRP.torrent',
    'the release-level name is kept as it is');
});

// ── 4. the same basename in different directories stays distinct ───────────
test('the same basename in two directories is two files', (t) => {
  const cache = createDiscoveryCache({ dbPath: path.join(tempDir(t, 'hs-corpus-dup-'), 'discovery.db') });
  t.after(() => cache.close());
  for (const [index, filePath] of ['Root/A/Movie.mkv', 'Root/B/Movie.mkv'].entries()) {
    storeReleaseAttributes(cache, {
      infoHash: HASH,
      fileIndex: index,
      source: 'test-source',
      filename: 'Movie.mkv',
      confidence: 0.9,
      filePath,
      fileSize: 1000,
    });
  }
  const rows = [
    ...cache.getReleaseAttributes(HASH, 0, 'test-source'),
    ...cache.getReleaseAttributes(HASH, 1, 'test-source'),
  ];
  const paths = rows.map((r) => r.filePath).sort();
  assert.deepEqual(paths, ['Root/A/Movie.mkv', 'Root/B/Movie.mkv'],
    'the directory is part of the identity');
});

// ── 5. the TorBox helper uses the exact path when the candidate has one ──
async function torboxFixture(t, files) {
  const dir = tempDir(t, 'hs-tb-exact-');
  const store = createControlPlaneStore({ dbPath: path.join(dir, 'cp.db') });
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH, providerResourceId: 'res-1',
    state: 'ready', ownership: 'owned', ownerKey: 'owner', provenance: 'test',
    observedAt: 1_700_000_000_000, expiresAt: 1_700_000_000_000 + 3_600_000,
  });
  store.replaceProviderFileInventory(placement.id, files, {
    authoritative: true, complete: true,
    observedAt: 1_700_000_000_000, expiresAt: 1_700_000_000_000 + 3_600_000,
  });
  const inventoryProvider = {
    capabilities: {
      'file-inventory': {
        async getFileInventory() {
          return {
            files: store.listProviderFiles(placement.id).map((f) => ({
              providerFileId: f.providerFileId,
              path: f.path,
              name: f.name,
              size: f.size,
              selected: true,
              torrentFileId: f.torrentFileId,
              mappingState: f.mappingState,
            })),
          };
        },
      },
    },
    require(name) { return this.capabilities[name]; },
  };
  return { store, placement, inventoryProvider };
}

test('an exact corpus path selects that provider file, not another of the same size', async (t) => {
  const { store, inventoryProvider } = await torboxFixture(t, [
    { providerFileId: '1', path: 'Root/A/Movie.mkv', name: 'Movie.mkv', size: 1000, selected: true },
    { providerFileId: '2', path: 'Root/B/Movie.mkv', name: 'Movie.mkv', size: 1000, selected: true },
  ]);
  t.after(() => store.close());

  const bound = await ensureTorBoxFileIdentity({
    infoHash: HASH,
    selectedFileSize: 1000,
    internalPath: 'Root/B/Movie.mkv',
    controlPlaneStore: store,
    torBoxInventoryProvider: inventoryProvider,
  });
  assert.equal(bound.providerFileId, '2', 'the exact path chose its own file');
  assert.equal(bound.identityStrength, 'exact-file');
});

test('without a path, two files of the same size fail closed', async (t) => {
  const { store, inventoryProvider } = await torboxFixture(t, [
    { providerFileId: '1', path: 'Root/A/Movie.mkv', name: 'Movie.mkv', size: 1000, selected: true },
    { providerFileId: '2', path: 'Root/B/Movie.mkv', name: 'Movie.mkv', size: 1000, selected: true },
  ]);
  t.after(() => store.close());

  await assert.rejects(() => ensureTorBoxFileIdentity({
    infoHash: HASH,
    selectedFileSize: 1000,
    internalPath: null,
    controlPlaneStore: store,
    torBoxInventoryProvider: inventoryProvider,
  }), /AMBIGUOUS|ambiguous|size/i);
});
