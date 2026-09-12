/**
 * PATH A short-circuit tests.
 *
 * When PATH A exact-size binding fails deterministically (NO_PLACEMENT or
 * INVENTORY_UNAVAILABLE), the PATH B ensure for the same candidate would
 * fail identically (same placement/create preconditions), so it is skipped
 * and records what PATH B would have recorded. Any other PATH A failure
 * still runs PATH B (e.g. size mismatch can bind via episode rules).
 * Rank order and winner semantics are unchanged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectBindableCandidate } from '../src/lib/discovery/selection.js';
import { resolveTvTorrentFile } from '../src/lib/resolver/tv-episode-resolver.js';

const HASH_BAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_GOOD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function candidate({ infoHash, rank, size }) {
  return {
    infoHash,
    fileIndex: 0,
    filename: `${infoHash.slice(0, 8)}.mkv`,
    rank,
    score: 1 - rank / 100,
    identity: { eligible: true, tier: 'Verified', confidence: 0.9 },
    availability: {},
    release: { title: 'T' },
    exactFileSize: null,
    selectedFileSize: size,
  };
}

function storeStub() {
  return {
    listTorrentFilesForRelease: () => [],
    listProviderRefsForTorrentFile: () => [],
  };
}

test('NO_PLACEMENT in PATH A skips the identical PATH B ensure', async () => {
  const calls = [];
  const ensure = async ({ infoHash, skipSizeMatch }) => {
    calls.push({ infoHash, skipSizeMatch: !!skipSizeMatch });
    if (infoHash === HASH_BAD) {
      const err = new Error('No TorBox placement');
      err.code = 'NO_PLACEMENT';
      throw err;
    }
    if (!skipSizeMatch) {
      return { torrentFileId: 'tf-good', placementId: 'pl-1', providerFileId: 'pf-1', size: 100 };
    }
    return {
      placementId: 'pl-1',
      torrentFiles: [{
        id: 'tf-good', infoHash: HASH_GOOD,
        internalPath: 'Show.S01E01.mkv', size: 100,
      }],
    };
  };
  const result = await selectBindableCandidate(
    [candidate({ infoHash: HASH_BAD, rank: 1, size: 100 }),
     candidate({ infoHash: HASH_GOOD, rank: 2, size: 100 })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: { season: 1, episode: 1 },
      controlPlaneStore: storeStub(),
    },
  );
  assert.equal(result.reason, 'exact-size bound');
  assert.equal(result.selected.infoHash, HASH_GOOD);
  // Failed hash paid exactly one provider sequence (PATH A only).
  assert.deepEqual(
    calls.filter((c) => c.infoHash === HASH_BAD),
    [{ infoHash: HASH_BAD, skipSizeMatch: false }],
  );
  // Winner bound via PATH A (has size) with a single call.
  assert.deepEqual(
    calls.filter((c) => c.infoHash === HASH_GOOD),
    [{ infoHash: HASH_GOOD, skipSizeMatch: false }],
  );
  const badSkips = result.skipped.filter((s) => s.infoHash === HASH_BAD);
  assert.equal(badSkips.length, 1);
  assert.equal(badSkips[0].reason, 'TorBox placement failed');
});

test('size mismatch still runs PATH B (may bind via episode rules)', async () => {
  const calls = [];
  const ensure = async ({ infoHash, skipSizeMatch }) => {
    calls.push({ infoHash, skipSizeMatch: !!skipSizeMatch });
    if (!skipSizeMatch) {
      const err = new Error('size mismatch');
      err.code = 'NO_FILE_SIZE_MATCH';
      throw err;
    }
    return {
      placementId: 'pl-1',
      torrentFiles: [{
        id: 'tf-good', infoHash: HASH_GOOD,
        internalPath: 'Show.S01E01.mkv', size: 999,
      }],
    };
  };
  const result = await selectBindableCandidate(
    [candidate({ infoHash: HASH_GOOD, rank: 1, size: 100 })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: { season: 1, episode: 1 },
      controlPlaneStore: storeStub(),
    },
  );
  assert.equal(result.reason, 'tv-episode bound S1E1');
  assert.equal(calls.length, 2, 'PATH A attempt + PATH B attempt both run');
  assert.equal(calls[1].skipSizeMatch, true);
});

test('exhausted candidates carry reasons instead of blank entries', async () => {
  const ensure = async () => {
    const err = new Error('No TorBox placement');
    err.code = 'NO_PLACEMENT';
    throw err;
  };
  const result = await selectBindableCandidate(
    [candidate({ infoHash: HASH_BAD, rank: 1, size: 100 })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: null,
      controlPlaneStore: storeStub(),
    },
  );
  assert.equal(result.selected, null);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'movie-cached-placement-failed');
});
