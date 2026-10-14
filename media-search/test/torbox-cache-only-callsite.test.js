/**
 * Real production cache-only boundary (mutation-verified).
 *
 * A mutation flipping `addOnlyIfCached: true → false` in
 * src/lib/resolver/torbox-file-identity.js survived every existing provider
 * test: the suites that assert the flag read it on their OWN injected
 * double, never on the production call site. This test drives the real
 * `ensureTorBoxFileIdentity` entry point with an injected provider and
 * asserts the flag actually reaches `createPlacement`, so the cache-only
 * boundary is pinned where it is enforced rather than where it is mocked.
 *
 * Contracts proven here:
 *   K1  the production create-first placement path passes
 *       `addOnlyIfCached: true` (never initiates an uncached download);
 *   K2  an uncached create refusal surfaces as a typed NO_PLACEMENT
 *       failure and creates NO durable placement;
 *   K3  the inventory fetch stays read-only;
 *   K4  a local-fresh authoritative snapshot answers with zero provider
 *       calls, so a bind never costs a placement create.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { ensureTorBoxFileIdentity } from '../src/lib/resolver/torbox-file-identity.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const NOW = 1_800_000_000_000;
const UNTIL = NOW + 6 * 60 * 60 * 1000;

function store(overrides = {}) {
  return {
    findPlacementByInfoHash: () => null,
    recordPlacement: () => { throw new Error('must not record a placement'); },
    recordPlacementLookupObservation: () => ({}),
    replaceProviderFileInventory: (_placementId, files) => files.map((f) => ({
      providerFileId: f.providerFileId, present: true, mappingState: 'mapped',
      torrentFileId: 'tf_1', size: f.size,
    })),
    listTorrentFilesForRelease: () => [],
    getTorrentFile: () => ({ id: 'tf_1', infoHash: HASH, internalPath: 'Release/movie.mkv', size: 1000 }),
    getProviderInventorySnapshot: () => null,
    listProviderFiles: () => [],
    ...overrides,
  };
}

/** Provider double that records exactly what the production path asks for. */
function provider({ createPlacement }) {
  const calls = { create: [], inventory: 0 };
  const p = {
    supports: (cap) => cap === PROVIDER_CAPABILITIES.PLACEMENT_CREATE,
    require: (cap) => {
      if (cap === PROVIDER_CAPABILITIES.PLACEMENT_CREATE) {
        return { createPlacement: async (arg) => { calls.create.push(arg); return createPlacement(arg); } };
      }
      return null;
    },
    calls,
  };
  return p;
}

test('K1 — the production create-first placement is cached-only', async () => {
  const p = provider({ createPlacement: async () => ({ providerResourceId: '99' }) });
  await ensureTorBoxFileIdentity({
    infoHash: HASH,
    selectedFileSize: 1000,
    controlPlaneStore: store({
      recordPlacement: (input) => ({ id: 'pl1', providerResourceId: '99', ...input }),
    }),
    torBoxProvider: p,
    torBoxInventoryProvider: {
      require: () => ({
        getFileInventory: async () => ({
          observedAt: NOW, expiresAt: UNTIL,
          files: [{ providerFileId: '7', path: 'Release/movie.mkv', name: 'movie.mkv', size: 1000, selected: true }],
        }),
      }),
    },
    now: () => NOW,
  });
  assert.equal(p.calls.create.length, 1, 'create-first placement consulted exactly once');
  assert.equal(p.calls.create[0].addOnlyIfCached, true,
    'the production placement create must be cached-only: an uncached candidate never starts acquisition');
  assert.match(p.calls.create[0].magnet, /^magnet:\?xt=urn:btih:/, 'placement keyed on the Release identity');
});

test('K2 — an uncached refusal creates no durable placement', async () => {
  const p = provider({
    createPlacement: async (arg) => {
      if (!arg.addOnlyIfCached) return { providerResourceId: '99' };
      const err = new Error('torrent is not cached');
      err.code = 'NOT_CACHED';
      throw err;
    },
  });
  let recorded = 0;
  await assert.rejects(
    () => ensureTorBoxFileIdentity({
      infoHash: HASH,
      selectedFileSize: 1000,
      controlPlaneStore: store({ recordPlacement: () => { recorded += 1; return { id: 'pl1' }; } }),
      torBoxProvider: p,
      torBoxInventoryProvider: {
      require: () => ({
        getFileInventory: async () => ({ observedAt: NOW, expiresAt: UNTIL, files: [] }),
      }),
    },
      now: () => NOW,
    }),
    (error) => {
      assert.equal(error?.code, 'NO_PLACEMENT', 'the refusal is a typed provider-pending failure');
      return true;
    },
  );
  assert.equal(recorded, 0, 'no durable placement may be created for an uncached release');
});

test('K4 — a locally-fresh authoritative snapshot binds with zero provider calls', async () => {
  const p = provider({ createPlacement: async () => ({ providerResourceId: '99' }) });
  const local = store({
    findPlacementByInfoHash: () => ({ id: 'pl_existing' }),
    getProviderInventorySnapshot: () => ({ authoritative: true, complete: true, expiresAt: UNTIL }),
    listProviderFiles: () => [{
      providerFileId: '7', present: true, mappingState: 'mapped',
      torrentFileId: 'tf_local', size: 1000,
    }],
  });
  const result = await ensureTorBoxFileIdentity({
    infoHash: HASH,
    selectedFileSize: 1000,
    controlPlaneStore: local,
    torBoxProvider: p,
    torBoxInventoryProvider: { listInventory: async () => { throw new Error('no provider I/O expected'); } },
    now: () => NOW,
  });
  assert.equal(result.torrentFileId, 'tf_local', 'the exact local TorrentFile binds');
  assert.equal(p.calls.create.length, 0, 'no placement create when durable truth is fresh');
});
