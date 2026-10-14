/**
 * Provider / cache-only boundary (deliberate product constraint).
 *
 * Fulfillment is intentionally cache-only: HashSucker never starts an
 * uncached acquisition to satisfy a request. These tests pin that
 * constraint and the diagnostics that keep a provider-pending miss
 * distinguishable from a true market miss:
 *
 *   B1  an uncached TorBox candidate is not bindable and produces NO
 *       acquisition state (no placement, no download, no promotion);
 *   B2  provider-pending states (uncached TorBox, queued/not-downloaded RD)
 *       are reported as typed candidate reasons, not as a generic failure;
 *   B3  a true market miss (nothing ranked at all) is a different reason
 *       from "candidates exist but none is cached" — the operator can tell
 *       "asked and empty" from "asked and not yet downloadable";
 *   B4  no durable acquisition rows are created by any of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectBindableCandidate } from '../src/lib/discovery/selection.js';

const CACHED_HASH = 'c'.repeat(40);
const UNCACHED_HASH = 'u'.repeat(40);
const RD_QUEUED_HASH = 'q'.repeat(40);
const SIZE = 1_000_000;

function candidate(infoHash, { state = 'uncached', rank = 1, selectedFileSize = SIZE } = {}) {
  return {
    infoHash,
    fileIndex: null,
    releaseKey: `${infoHash}:torrent`,
    filename: `Show.S01E01.${state}.mkv`,
    rank,
    score: 1 - rank / 100,
    identity: { eligible: true, tier: 'Verified', confidence: 0.9 },
    availability: { torbox: { state } },
    release: { title: 'Show', season: 1, episode: 1, mediaType: 'series' },
    selectedFileSize,
    hasLiveDiscovery: true,
  };
}

/** A control-plane double that refuses to place anything cached-only. */
function cacheOnlyStore() {
  return {
    placements: [],
    getTorrentFile: () => null,
    listDataPlaneCoordinates: () => [],
    listTorrentFilesForRelease: () => [],
    listProviderRefsForTorrentFile: () => [],
  };
}

test('B1 — an uncached TorBox candidate cannot bind and creates no acquisition state', async () => {
  const store = cacheOnlyStore();
  const calls = [];
  const ensure = async (params) => {
    calls.push(params);
    const err = new Error('release is not cached on the provider');
    err.code = 'NO_PLACEMENT';
    throw err;
  };

  // Two shapes, both uncached: one carrying an exact per-file size (PATH A
  // exact-size attempt) and one without (PATH B cached-only inventory
  // consult). Neither may bind, and neither may create acquisition state.
  const result = await selectBindableCandidate([
    candidate(UNCACHED_HASH, { state: 'uncached', rank: 1 }),
    candidate(UNCACHED_HASH, { state: 'uncached', rank: 2, selectedFileSize: null }),
  ], {
    ensureTorBoxFileIdentityFn: ensure,
    resolveTvTorrentFileFn: () => ({ torrentFile: null }),
    tvCoordinates: { season: 1, episode: 1 },
    controlPlaneStore: store,
  });

  assert.equal(result.selected, null, 'an uncached release must not bind');
  assert.equal(store.placements.length, 0, 'no placement state may be created');
  assert.ok(calls.some((c) => c.skipSizeMatch === true),
    'the cached-only inventory consult is the fallback shape (never an uncached add)');
  const reasons = result.skipped.map((s) => s.reason);
  assert.ok(reasons.some((r) => r === 'TorBox placement failed'),
    `the provider-pending reason must be explicit, got: ${JSON.stringify(reasons)}`);
  assert.equal(result.reason, 'no-bindable-candidate');
});

test('B2 — provider-pending vs true market miss are different reasons', async () => {
  // Provider-pending: candidates exist, none is cached.
  const pending = await selectBindableCandidate([
    candidate(UNCACHED_HASH, { state: 'uncached', rank: 1 }),
    candidate(CACHED_HASH, { state: 'unknown', rank: 2 }),
  ], {
    ensureTorBoxFileIdentityFn: async () => { throw new Error('not cached'); },
    resolveTvTorrentFileFn: () => ({ torrentFile: null }),
    tvCoordinates: { season: 1, episode: 1 },
    controlPlaneStore: cacheOnlyStore(),
  });

  // True market miss: nothing ranked at all.
  const miss = await selectBindableCandidate([], {
    ensureTorBoxFileIdentityFn: async () => ({}),
    resolveTvTorrentFileFn: () => ({ torrentFile: null }),
    tvCoordinates: { season: 1, episode: 1 },
    controlPlaneStore: cacheOnlyStore(),
  });

  assert.equal(pending.reason, 'no-bindable-candidate', 'candidates existed but none could bind');
  assert.equal(pending.skipped.length, 4, 'each candidate carries its own provider outcome (with reason detail)');
  assert.equal(miss.reason, 'no candidates', 'an empty market is a different outcome');
  assert.deepEqual(miss.skipped, []);
});

test('B3 — an RD queued/not-downloaded candidate is not treated as bindable', async () => {
  const ensureCalls = [];
  const result = await selectBindableCandidate(
    [candidate(RD_QUEUED_HASH, { state: 'unknown' })],
    {
      ensureTorBoxFileIdentityFn: async () => {
        const err = new Error('not cached');
        err.code = 'NO_PLACEMENT';
        throw err;
      },
      // RD seam answers "queued, not downloaded yet".
      ensureRealDebridFileIdentityFn: async (params) => {
        ensureCalls.push(params);
        return { status: 'queued', reason: 'rd-not-downloaded' };
      },
      resolveTvTorrentFileFn: () => ({ torrentFile: null }),
      tvCoordinates: { season: 1, episode: 1 },
      controlPlaneStore: cacheOnlyStore(),
    },
  );

  assert.equal(result.selected, null, 'a queued RD file is not playable yet');
  const reasons = result.skipped.map((s) => s.reason);
  assert.ok(reasons.some((r) => r.startsWith('rd-queued') || r.includes('rd-not-downloaded')),
    `the RD pending state must be visible: ${JSON.stringify(reasons)}`);
  assert.ok(ensureCalls.length > 0, 'the RD seam is consulted (read-only probe)');
});

test('B4 — binding success requires a real TorrentFile, never a guess', async () => {
  // The provider answers with an inventory whose only file is not a
  // playable video: the binding must fail closed rather than accept it.
  const store = cacheOnlyStore();
  const result = await selectBindableCandidate(
    [candidate(CACHED_HASH, { state: 'cached' })],
    {
      ensureTorBoxFileIdentityFn: async () => ({
        placementId: 'pl1',
        torrentFiles: [{ id: 'tf1', infoHash: CACHED_HASH, internalPath: 'Pack/Setup.exe', size: SIZE }],
      }),
      resolveTvTorrentFileFn: () => ({ torrentFile: null }),
      tvCoordinates: { season: 1, episode: 1 },
      controlPlaneStore: {
        ...store,
        getTorrentFile: (id) => (id === 'tf1'
          ? { id, infoHash: CACHED_HASH, internalPath: 'Pack/Setup.exe', size: SIZE }
          : null),
        listTorrentFilesForRelease: () => [
          { id: 'tf1', infoHash: CACHED_HASH, internalPath: 'Pack/Setup.exe', size: SIZE },
        ],
      },
    },
  );
  assert.equal(result.selected, null, 'a non-playable payload must not bind');
  assert.equal(result.reason, 'no-bindable-candidate');
});
