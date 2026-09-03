/**
 * E02 microscopic repair: same (releaseKey, placement) but different
 * candidate filename. Production shape: a multi-file torrent's
 * playback_handoffs row carries a torrent-level releaseKey
 * (infoHash:torrent), so every episode in the same torrent shares
 * the same (releaseKey, placementId) tuple. The first handoff to
 * reach the seam established the file mapping for whichever episode
 * came first (the sibling E01 file). The next episode (E02) needs
 * the seam to re-resolve against its own filename, not silently
 * reuse the E01 mapping's providerFileId.
 *
 * Pre-fix defect: the seam returned the E01 providerFileId, the VFS
 * recorded terminal evidence against that wrong providerFileId, and
 * the normal resolver ladder (which keys terminal-evidence lookup on
 * (placement, providerFile) via the placementLookup) could not
 * graduate the rank-5 alternate because the evidence was bound to
 * the wrong (placement, providerFile) tuple.
 *
 * The microscopic fix in `ensureTorBoxDelivery` checks the existing
 * mapping's evidence.candidateFilename against the handoff's
 * filename. A mismatch treats the mapping as absent and re-runs the
 * authoritative inventory + exact-provider-file matching path.
 *
 * Coverage:
 *   T1. Mismatched filename forces re-resolution; the seam returns
 *       the E02 providerFileId, not the E01 one.
 *   T2. A VFS byte failure after the re-resolved seam records
 *       terminal evidence against the E02 providerFileId.
 *   T3. The E01 mapping's evidence is unchanged (sibling file
 *       invariants preserved).
 *   T4. Single-file torrent handoff reuses the existing mapping
 *       (filename matches evidence).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createTerminalDeliveryEvidenceStore } from '../src/lib/resolver/terminal-delivery-evidence.js';
import { ensureTorBoxDelivery } from '../src/lib/resolver/torbox-delivery.js';

const E01_HASH = 'a07b84404989fccee1d55c247cb03e22c8847ecc';
const E01_FILENAME = 'When They See Us S01E01 WEB-DL 2160p.mkv';
const E02_FILENAME = 'When They See Us S01E02 WEB-DL 2160p.mkv';
const E03_FILENAME = 'When They See Us S01E03 WEB-DL 2160p.mkv';
const TORRENT_RELEASE_KEY = `${E01_HASH}:torrent`;

const E01_SIZE = 7_952_732_164;
const E02_SIZE = 8_775_633_660;
const E03_SIZE = 9_071_065_551;

function seedMultiFilePlacement(store) {
  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: E01_HASH,
    providerResourceId: 'torbox-tt7137906',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'e02-microscopic-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
  });
  store.replaceProviderFileInventory(placement.id, [
    {
      providerFileId: '0',
      path: `/${E01_FILENAME}`,
      name: E01_FILENAME,
      size: E01_SIZE,
      selected: true,
    },
    {
      providerFileId: '1',
      path: `/${E02_FILENAME}`,
      name: E02_FILENAME,
      size: E02_SIZE,
      selected: false,
    },
    {
      providerFileId: '2',
      path: `/${E03_FILENAME}`,
      name: E03_FILENAME,
      size: E03_SIZE,
      selected: false,
    },
  ], {
    authoritative: true,
    complete: true,
    observedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
  });
  // The E01 sibling mapping was established first (production defect
  // shape). The seam must NOT silently reuse it for an E02 handoff.
  store.recordFileMapping({
    infoHash: E01_HASH,
    fileIndex: null,
    releaseKey: TORRENT_RELEASE_KEY,
    placementId: placement.id,
    providerFileId: '0',
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    evidence: { candidateFilename: E01_FILENAME, providerPath: `/${E01_FILENAME}` },
    mappedAt: 1_700_000_000_000,
  });
  return placement;
}

function makeStubInventoryProvider({ files }) {
  return {
    require: (capability) => {
      if (capability === 'file-inventory') {
        return {
          async getFileInventory(placement, { signal } = {}) {
            return {
              files,
              observedAt: 1_700_000_000_000,
              expiresAt: 1_700_000_300_000,
              authoritative: true,
              complete: true,
              evidence: { source: 'test-stub' },
            };
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };
}

test('T1: mismatched filename forces seam to resolve the E02 providerFileId, not the stale E01 mapping', async () => {
  const store = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const placement = seedMultiFilePlacement(store);

  const result = await ensureTorBoxDelivery({
    infoHash: E01_HASH,
    fileIndex: null,
    releaseKey: TORRENT_RELEASE_KEY,
    filename: E02_FILENAME,
    controlPlaneStore: store,
    torBoxProvider: null,
    torBoxInventoryProvider: makeStubInventoryProvider({
      files: [
        { providerFileId: '0', path: `/${E01_FILENAME}`, name: E01_FILENAME, size: E01_SIZE },
        { providerFileId: '1', path: `/${E02_FILENAME}`, name: E02_FILENAME, size: E02_SIZE },
        { providerFileId: '2', path: `/${E03_FILENAME}`, name: E03_FILENAME, size: E03_SIZE },
      ],
    }),
    fetchFn: async () => ({ ok: true, status: 200, body: null, json: async () => null }),
  });

  assert.equal(result.providerFileId, '1', 'seam must resolve E02 backing (PF1), not the stale E01 mapping (PF0)');
  assert.equal(result.placementId, placement.id);
  assert.equal(result.size, E02_SIZE, 'seam must report the E02 file size, not the E01 size');
});

test('T2: terminal evidence after byte failure lands on E02 providerFileId (not the stale E01 mapping)', async () => {
  const store = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const placement = seedMultiFilePlacement(store);
  const evidenceStore = createTerminalDeliveryEvidenceStore({ controlPlaneStore: store });

  // First: the E02 handoff reaches the seam. The seam must re-resolve.
  const delivery = await ensureTorBoxDelivery({
    infoHash: E01_HASH,
    fileIndex: null,
    releaseKey: TORRENT_RELEASE_KEY,
    filename: E02_FILENAME,
    controlPlaneStore: store,
    torBoxProvider: null,
    torBoxInventoryProvider: makeStubInventoryProvider({
      files: [
        { providerFileId: '0', path: `/${E01_FILENAME}`, name: E01_FILENAME, size: E01_SIZE },
        { providerFileId: '1', path: `/${E02_FILENAME}`, name: E02_FILENAME, size: E02_SIZE },
        { providerFileId: '2', path: `/${E03_FILENAME}`, name: E03_FILENAME, size: E03_SIZE },
      ],
    }),
    fetchFn: async () => ({ ok: true, status: 200, body: null, json: async () => null }),
  });

  // Then: the VFS byte path proves the capability invalid and records
  // terminal evidence against the E02 backing. The bound tuple is the
  // exact (placement, providerFile) the seam returned.
  evidenceStore.recordTerminal({
    provider: 'torbox',
    accountScope: 'default',
    placementId: delivery.placementId,
    providerFileId: delivery.providerFileId,
    infoHash: E01_HASH,
    fileIndexKey: -1,
    reason: 'protocol-invalid-after-fresh-retry',
    failureCategory: 'delivery-capability-protocol-invalid',
    observedAt: 1_700_000_000_000,
  });

  // The terminal-evidence row is keyed on the E02 providerFileId.
  const e02Evidence = store.findDeliveryEvidence({
    provider: 'torbox',
    accountScope: 'default',
    placementId: placement.id,
    providerFileId: '1',
  });
  assert.ok(e02Evidence, 'T2: terminal evidence must be recorded against the E02 providerFileId');
  assert.equal(e02Evidence.state, 'terminal');

  // No terminal evidence is recorded against the E01 providerFileId.
  const e01Evidence = store.findDeliveryEvidence({
    provider: 'torbox',
    accountScope: 'default',
    placementId: placement.id,
    providerFileId: '0',
  });
  assert.equal(e01Evidence, null, 'T2: terminal evidence must NOT be recorded against the stale E01 mapping');
});

test('T3: re-resolve rewrites the mapping to the correct file (production invariant)', async () => {
  const store = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  seedMultiFilePlacement(store);

  await ensureTorBoxDelivery({
    infoHash: E01_HASH,
    fileIndex: null,
    releaseKey: TORRENT_RELEASE_KEY,
    filename: E02_FILENAME,
    controlPlaneStore: store,
    torBoxProvider: null,
    torBoxInventoryProvider: makeStubInventoryProvider({
      files: [
        { providerFileId: '0', path: `/${E01_FILENAME}`, name: E01_FILENAME, size: E01_SIZE },
        { providerFileId: '1', path: `/${E02_FILENAME}`, name: E02_FILENAME, size: E02_SIZE },
        { providerFileId: '2', path: `/${E03_FILENAME}`, name: E03_FILENAME, size: E03_SIZE },
      ],
    }),
    fetchFn: async () => ({ ok: true, status: 200, body: null, json: async () => null }),
  });

  // After the E02 re-resolve, exactly one (release_key, placement)
  // row exists, and its providerFileId/evidence target E02. The
  // torrent-level releaseKey collapses sibling episodes into one row
  // (an existing design constraint out of scope for this repair).
  const placementId = store.findPlacementByInfoHash('torbox', E01_HASH).id;
  const allMappings = store.db.prepare(
    `SELECT * FROM candidate_file_mappings WHERE placement_id = ?`,
  ).all(placementId);
  assert.equal(allMappings.length, 1, 'T3: exactly one (release_key, placement) mapping row');
  const row = allMappings[0];
  assert.equal(row.provider_file_id, '1', 'T3: row now targets the E02 providerFileId');
  const evidence = JSON.parse(row.evidence);
  assert.equal(evidence.candidateFilename, E02_FILENAME, 'T3: row evidence names the E02 file');
});

test('T4: matching filename reuses the existing mapping (no needless re-resolve)', async () => {
  const store = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const placement = seedMultiFilePlacement(store);

  let inventoryCalls = 0;
  const stub = makeStubInventoryProvider({
    files: [
      { providerFileId: '0', path: `/${E01_FILENAME}`, name: E01_FILENAME, size: E01_SIZE },
      { providerFileId: '1', path: `/${E02_FILENAME}`, name: E02_FILENAME, size: E02_SIZE },
      { providerFileId: '2', path: `/${E03_FILENAME}`, name: E03_FILENAME, size: E03_SIZE },
    ],
  });
  // Wrap the stub so we can count invocations.
  const countingStub = {
    require: (capability) => {
      if (capability === 'file-inventory') {
        const inner = stub.require(capability);
        return {
          async getFileInventory(...args) {
            inventoryCalls += 1;
            return inner.getFileInventory(...args);
          },
        };
      }
      throw new Error(`Unexpected capability: ${capability}`);
    },
  };

  const result = await ensureTorBoxDelivery({
    infoHash: E01_HASH,
    fileIndex: null,
    releaseKey: TORRENT_RELEASE_KEY,
    filename: E01_FILENAME,
    controlPlaneStore: store,
    torBoxProvider: null,
    torBoxInventoryProvider: countingStub,
    fetchFn: async () => ({ ok: true, status: 200, body: null, json: async () => null }),
  });

  assert.equal(result.providerFileId, '0', 'T4: matching filename reuses the existing mapping');
  assert.equal(inventoryCalls, 0, 'T4: inventory provider is NOT invoked when mapping is reusable');
});
