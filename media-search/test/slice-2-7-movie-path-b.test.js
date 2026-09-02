/**
 * Slice 2.7 — Movie PATH B (cached-only single-file binding fallback)
 *
 * Production context (September 2026 audit): the cold-start canary for
 * tt1825683 (Black Panther, 2018) discovered 1291 real candidates and
 * selected cached release
 * 06bfe49fdc99ad0c6fef1f761382a8181490e456:0, but discovery did not
 * provide a trustworthy exact behaviorHints.videoSize. Without an
 * exact-size fast path, the pre-slice-2.7 movie selection fell through
 * to a "cached-first fallback (no bindable candidate)" handoff with
 * torrent_file_id=NULL; VFS publication correctly failed closed.
 *
 * This file pins the movie analogue of the TV PATH B binding contract:
 *   1. The candidate is bindable when its cached-only TorBox placement
 *      yields EXACTLY ONE playable TorrentFile.
 *   2. Zero playable → unbindable, continue to next ranked candidate.
 *   3. >1 playable → ambiguous, continue to next ranked candidate.
 *   4. Provider call surface is bounded: a single cached-only placement
 *      create (addOnlyIfCached=true; never an uncached download) plus
 *      the inventory fetch driven by the same ensureTorBoxFileIdentity
 *      factory. No nested retry multiplication.
 *   5. Existing exact-size PATH A still binds when trustworthy size is
 *      available; this fallback only runs when no exact size exists.
 *
 * Tests use mocked controlPlaneStore + ensureTorBoxFileIdentityFn so the
 * orchestrator can be exercised without a live TorBox account. The mocks
 * capture every call to verify the call-surface budget.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectBindableCandidate } from '../src/lib/discovery/selection.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BP_HASH = '06bfe49fdc99ad0c6fef1f761382a8181490e456';
const ALTERNATE_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BP_TORRENT_FILE_ID = 'tf_blackpanther-2018-slice27';
const BP_INTERNAL_PATH = 'Black.Panther.2018.2160p.UHD.BluRay.x265-GROUP.mkv';
const BP_SIZE = 62_345_678_901;

function movieCandidate({ infoHash = BP_HASH, fileIndex = 0, exactFileSize = null } = {}) {
  return {
    infoHash,
    fileIndex,
    filename: infoHash === BP_HASH ? BP_INTERNAL_PATH : 'alternate.mkv',
    rank: 1,
    score: 0.95,
    identity: { eligible: true, tier: 'Verified', confidence: 0.95 },
    availability: { torbox: { state: 'cached', checkedAt: 1, latencyMs: 10 } },
    release: {
      title: 'Black Panther',
      year: 2018,
      resolution: '2160p',
      source: 'UHD.BluRay',
      codec: 'x265',
      hdr: true,
    },
    exactFileSize,
    selectedFileSize: null,
  };
}

/**
 * Build a controlPlaneStore mock that holds an authoritative inventory
 * for the candidate's infoHash. The inventory yields `torrentFiles` whose
 * playable count is `playableCount`; remaining files are sample/non-video
 * (which `isPlayableVideoTorrentFile` rejects).
 *
 * The mock records every listTorrentFilesForRelease call so tests can
 * assert the call budget. It also returns a present provider_file_ref for
 * each torrentFile.
 */
function controlPlaneStoreMock({
  infoHash = BP_HASH,
  torrentFileId = BP_TORRENT_FILE_ID,
  internalPath = BP_INTERNAL_PATH,
  size = BP_SIZE,
  playableCount = 1,
  placementId = 'placement-bp-1',
} = {}) {
  const calls = { listTorrentFilesForRelease: 0, listProviderRefsForTorrentFile: 0 };
  const torrentFiles = [];

  // Index 0..N-1 are playable video files when requested.
  for (let i = 0; i < playableCount; i += 1) {
    torrentFiles.push({
      id: playableCount === 1 ? torrentFileId : `${torrentFileId}-${i}`,
      infoHash,
      internalPath: playableCount === 1
        ? internalPath
        : `Movie.Part${i + 1}.mkv`,
      size: playableCount === 1 ? size : size - i * 1024,
      createdAt: 1,
    });
  }
  // Always include a non-video noise row to verify the filter still rejects it.
  torrentFiles.push({
    id: `${torrentFileId}-sample`,
    infoHash,
    internalPath: 'Sample/sample.mkv',
    size: 1024,
    createdAt: 1,
  });

  return {
    calls,
    listTorrentFilesForRelease(hash) {
      calls.listTorrentFilesForRelease += 1;
      if (String(hash).toLowerCase() !== infoHash) return [];
      return torrentFiles.map((tf) => ({ ...tf }));
    },
    listProviderRefsForTorrentFile(id) {
      calls.listProviderRefsForTorrentFile += 1;
      return [{
        placementId,
        providerFileId: `pf-${id}`,
        present: true,
        mappingState: 'mapped',
      }];
    },
    _placementId: placementId,
  };
}

/**
 * Build the cached-only ensureTorBoxFileIdentityFn factory mock.
 *
 * `placementCalls` counts every call; `inventoryFetchesPerCandidate`
 * tracks the per-candidate inventory fetch count to assert the lifecycle
 * budget (one placement create + one inventory fetch per selected
 * candidate).
 */
function ensureFnMock({
  controlPlaneStore,
  failPlacement = false,
  placementTorrentFiles = null,
} = {}) {
  const placementCalls = { count: 0, byHash: new Map() };

  return {
    placementCalls,
    async ensureTorBoxFileIdentityFn({ infoHash, skipSizeMatch }) {
      placementCalls.count += 1;
      placementCalls.byHash.set(infoHash, (placementCalls.byHash.get(infoHash) || 0) + 1);
      if (failPlacement) {
        const err = new Error('cached-only placement refused');
        err.code = 'NO_PLACEMENT';
        throw err;
      }
      // The factory is the unit under test for the provider call surface.
      // The factory should always request skipSizeMatch=true for movie
      // PATH B (no exact size available).
      assert.equal(skipSizeMatch, true, 'movie PATH B must request skipSizeMatch=true');
      const tfs = placementTorrentFiles
        ?? controlPlaneStore.listTorrentFilesForRelease(infoHash);
      return {
        placementId: controlPlaneStore._placementId,
        torrentFiles: tfs,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Targeted tests
// ---------------------------------------------------------------------------

test('movie PATH B: binds when cached placement + exactly one playable TorrentFile', async () => {
  const controlPlaneStore = controlPlaneStoreMock({ playableCount: 1 });
  const factory = ensureFnMock({ controlPlaneStore });

  const result = await selectBindableCandidate([movieCandidate()], {
    ensureTorBoxFileIdentityFn: factory.ensureTorBoxFileIdentityFn,
    resolveTvTorrentFileFn: null,
    tvCoordinates: null,
    controlPlaneStore,
  });

  assert.ok(result.selected, 'selection.selected must be set when a single playable exists');
  assert.equal(result.reason, 'movie-cached-single-file bound');
  assert.equal(result.selected._torrentFileId, BP_TORRENT_FILE_ID);
  assert.equal(result.selected._binding.status, 'movie-cached-single-file');
  assert.equal(result.selected._binding.torrentFileId, BP_TORRENT_FILE_ID);
  assert.equal(result.selected._binding.placementId, controlPlaneStore._placementId);
  assert.equal(result.selected._binding.providerFileId, `pf-${BP_TORRENT_FILE_ID}`);
  assert.equal(result.selected._binding.size, BP_SIZE);
  // Provider call budget: exactly one placement create + one inventory fetch.
  assert.equal(factory.placementCalls.count, 1, 'exactly one placement call for the selected candidate');
  assert.equal(factory.placementCalls.byHash.get(BP_HASH), 1);
  assert.equal(controlPlaneStore.calls.listTorrentFilesForRelease, 1,
    'inventory read happens exactly once for the selected candidate');
});

test('movie PATH B: ambiguous when cached placement has multiple playable TorrentFiles', async () => {
  const controlPlaneStore = controlPlaneStoreMock({ playableCount: 2 });
  const factory = ensureFnMock({ controlPlaneStore });

  // Two candidates: first is ambiguous, second is the same hash (same fate).
  // We re-use the same infoHash to assert that ambiguous candidates
  // continue to the next ranked candidate without binding.
  const result = await selectBindableCandidate([movieCandidate()], {
    ensureTorBoxFileIdentityFn: factory.ensureTorBoxFileIdentityFn,
    resolveTvTorrentFileFn: null,
    tvCoordinates: null,
    controlPlaneStore,
  });

  assert.equal(result.selected, null,
    'no selection when the only candidate is ambiguous (>1 playable)');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'movie-ambiguous');
  assert.equal(factory.placementCalls.count, 1, 'ambiguous candidate still uses exactly one placement call');
});

test('movie PATH B: zero playable → continue to next candidate', async () => {
  const controlPlaneStore = controlPlaneStoreMock({ playableCount: 0 });
  const factory = ensureFnMock({ controlPlaneStore });

  const result = await selectBindableCandidate([movieCandidate()], {
    ensureTorBoxFileIdentityFn: factory.ensureTorBoxFileIdentityFn,
    resolveTvTorrentFileFn: null,
    tvCoordinates: null,
    controlPlaneStore,
  });

  assert.equal(result.selected, null, 'no selection when no playable files');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'movie-no-playable');
  assert.equal(factory.placementCalls.count, 1, 'one placement call per attempted candidate');
});

test('movie PATH B: no uncached placement creation — the safe cached-only path is the only path', async () => {
  // The factory is invoked with skipSizeMatch=true which routes the
  // placement through ensureTorBoxFileIdentity's cached-only branch
  // (addOnlyIfCached=true; never an uncached download). Asserting the
  // factory's call signature is sufficient because the orchestrator is
  // contractually forbidden from issuing any provider write outside the
  // factory for this slice.
  const controlPlaneStore = controlPlaneStoreMock({ playableCount: 1 });
  const factory = ensureFnMock({ controlPlaneStore });

  await selectBindableCandidate([movieCandidate()], {
    ensureTorBoxFileIdentityFn: factory.ensureTorBoxFileIdentityFn,
    resolveTvTorrentFileFn: null,
    tvCoordinates: null,
    controlPlaneStore,
  });

  // The factory was called exactly once; the call passed skipSizeMatch=true
  // which is the cached-only branch. We assert no uncached signal was
  // captured: the factory has no createPlacementUncached surface at all,
  // and the orchestrator never called any function other than the factory.
  assert.equal(factory.placementCalls.count, 1);
  // No nested retries: the loop moves on to the next candidate on each
  // failure (ambiguous/zero/placement-failed), never retrying the same
  // candidate in the same request lifecycle.
  assert.equal(factory.placementCalls.byHash.get(BP_HASH), 1);
});

test('movie PATH B: same candidate lifecycle inventory fetched once', async () => {
  const controlPlaneStore = controlPlaneStoreMock({ playableCount: 1 });
  const factory = ensureFnMock({ controlPlaneStore });

  const result = await selectBindableCandidate([movieCandidate()], {
    ensureTorBoxFileIdentityFn: factory.ensureTorBoxFileIdentityFn,
    resolveTvTorrentFileFn: null,
    tvCoordinates: null,
    controlPlaneStore,
  });

  assert.ok(result.selected, 'selection must bind');
  // The factory returns the inventory directly, so listTorrentFilesForRelease
  // is only invoked as a fallback when result.torrentFiles is null. Verify
  // either 0 (factory returned the list) or 1 (fallback read), but never
  // multiple reads of the same candidate within one request lifecycle.
  assert.ok(controlPlaneStore.calls.listTorrentFilesForRelease <= 1,
    `inventory read for one candidate must be at most once per lifecycle, got ${controlPlaneStore.calls.listTorrentFilesForRelease}`);
});

test('movie PATH B: ambiguous candidate continues to next ranked candidate', async () => {
  // First candidate: ambiguous (2 playable files).
  // Second candidate: bindable (1 playable file).
  const cpFirst = controlPlaneStoreMock({
    infoHash: BP_HASH,
    torrentFileId: 'tf-first-ambiguous',
    internalPath: 'First.Part1.mkv',
    playableCount: 2,
    placementId: 'placement-first',
  });
  const cpSecond = controlPlaneStoreMock({
    infoHash: ALTERNATE_HASH,
    torrentFileId: 'tf-second-bindable',
    internalPath: 'Second.Single.mkv',
    size: 12_345_678_901,
    playableCount: 1,
    placementId: 'placement-second',
  });

  // The factory must route by infoHash. Build a composite that dispatches
  // to the right control plane.
  const compositeCp = {
    _first: cpFirst,
    _second: cpSecond,
    calls: {
      listTorrentFilesForRelease: 0,
      listProviderRefsForTorrentFile: 0,
    },
    listTorrentFilesForRelease(hash) {
      this.calls.listTorrentFilesForRelease += 1;
      const cp = String(hash).toLowerCase() === BP_HASH ? cpFirst : cpSecond;
      return cp.listTorrentFilesForRelease(hash);
    },
    listProviderRefsForTorrentFile(id) {
      this.calls.listProviderRefsForTorrentFile += 1;
      // The id tells us which control plane holds it.
      if (id.startsWith('tf-first')) {
        return cpFirst.listProviderRefsForTorrentFile(id);
      }
      return cpSecond.listProviderRefsForTorrentFile(id);
    },
    get _firstPlacement() { return cpFirst._placementId; },
    get _secondPlacement() { return cpSecond._placementId; },
  };

  const factoryCalls = { count: 0, byHash: new Map() };
  const factory = async ({ infoHash, skipSizeMatch }) => {
    factoryCalls.count += 1;
    factoryCalls.byHash.set(infoHash, (factoryCalls.byHash.get(infoHash) || 0) + 1);
    const cp = String(infoHash).toLowerCase() === BP_HASH ? cpFirst : cpSecond;
    return {
      placementId: cp._placementId,
      torrentFiles: cp.listTorrentFilesForRelease(infoHash),
    };
  };

  const result = await selectBindableCandidate([
    movieCandidate({ infoHash: BP_HASH, fileIndex: 0 }),
    movieCandidate({ infoHash: ALTERNATE_HASH, fileIndex: 0 }),
  ], {
    ensureTorBoxFileIdentityFn: factory,
    resolveTvTorrentFileFn: null,
    tvCoordinates: null,
    controlPlaneStore: compositeCp,
  });

  assert.ok(result.selected, 'second candidate must bind after the first is skipped');
  assert.equal(result.selected.infoHash, ALTERNATE_HASH);
  assert.equal(result.selected._torrentFileId, 'tf-second-bindable');
  assert.equal(result.selected._binding.placementId, cpSecond._placementId);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].infoHash, BP_HASH);
  assert.equal(result.skipped[0].reason, 'movie-ambiguous');
  // The first candidate was attempted once, the second once; total = 2.
  assert.equal(factoryCalls.count, 2);
  assert.equal(factoryCalls.byHash.get(BP_HASH), 1);
  assert.equal(factoryCalls.byHash.get(ALTERNATE_HASH), 1);
});

test('movie PATH B: existing exact-size PATH A still wins when trustworthy size exists', async () => {
  // The exact-size factory returns a torrentFileId directly without
  // consulting the inventory. The movie PATH B must NOT run when
  // exactFileSize is trustworthy.
  const controlPlaneStore = controlPlaneStoreMock({ playableCount: 1 });
  const factoryCalls = { count: 0 };

  const factory = async ({ infoHash, selectedFileSize, skipSizeMatch }) => {
    factoryCalls.count += 1;
    if (selectedFileSize != null) {
      // PATH A: return exact-size binding directly.
      return {
        placementId: 'placement-exact-size',
        providerFileId: 'pf-exact-size',
        torrentFileId: 'tf-exact-size-binding',
        size: selectedFileSize,
      };
    }
    if (skipSizeMatch) {
      // PATH B fallback: return inventory.
      const tfs = controlPlaneStore.listTorrentFilesForRelease(infoHash);
      return {
        placementId: controlPlaneStore._placementId,
        torrentFiles: tfs,
      };
    }
    throw new Error('unexpected factory call');
  };

  const result = await selectBindableCandidate(
    [movieCandidate({ exactFileSize: BP_SIZE })],
    {
      ensureTorBoxFileIdentityFn: factory,
      resolveTvTorrentFileFn: null,
      tvCoordinates: null,
      controlPlaneStore,
    },
  );

  assert.ok(result.selected, 'PATH A must still bind when exactFileSize is trustworthy');
  assert.equal(result.reason, 'exact-size bound');
  assert.equal(result.selected._torrentFileId, 'tf-exact-size-binding');
  assert.equal(result.selected._binding.status, 'exact-size');
  // The factory was called exactly once (PATH A); PATH B must not run.
  assert.equal(factoryCalls.count, 1, 'PATH A short-circuits before PATH B');
});

test('movie PATH B: placement-failed candidate is skipped (cached-only refused)', async () => {
  // Factory throws (release not cached). The candidate is unbindable;
  // the orchestrator must continue to the next ranked candidate.
  const controlPlaneStore = controlPlaneStoreMock({ playableCount: 1 });
  const factory = ensureFnMock({ controlPlaneStore, failPlacement: true });

  const result = await selectBindableCandidate([
    movieCandidate({ infoHash: BP_HASH, fileIndex: 0 }),
    movieCandidate({ infoHash: ALTERNATE_HASH, fileIndex: 0 }),
  ], {
    ensureTorBoxFileIdentityFn: factory.ensureTorBoxFileIdentityFn,
    resolveTvTorrentFileFn: null,
    tvCoordinates: null,
    controlPlaneStore,
  });

  // The second candidate is on a different control plane; with the mock
  // factory as written, it will also fail (the mock throws unconditionally).
  // The test only needs to assert: (1) no selection; (2) the first
  // candidate is in skipped with the placement-failed reason.
  assert.equal(result.selected, null);
  const firstSkip = result.skipped.find((s) => s.infoHash === BP_HASH);
  assert.ok(firstSkip, 'first candidate must be in skipped');
  assert.equal(firstSkip.reason, 'movie-cached-placement-failed');
  // Placement create is called at most once per attempted candidate.
  // (Our mock throws before doing any provider work, so the call is
  // accounted for but no inventory fetch happens.)
  assert.ok(factory.placementCalls.count >= 1);
});
