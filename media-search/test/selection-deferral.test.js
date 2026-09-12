/**
 * Uncached-deferral traversal tests.
 *
 * Candidates the fresh availability batch proved uncached are deferred to a
 * fallback pass: under static provider truth the winner is identical
 * (every deferred candidate would have failed its ensure), while provider
 * calls drop to the candidates actually attempted. Unknown/missing states
 * always attempt normally. Rank order is preserved within each phase.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectBindableCandidate } from '../src/lib/discovery/selection.js';
import { resolveTvTorrentFile } from '../src/lib/resolver/tv-episode-resolver.js';

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';

function candidate({ infoHash, rank, torboxState, size = 100 }) {
  return {
    infoHash,
    fileIndex: 0,
    filename: `${infoHash.slice(0, 8)}.mkv`,
    rank,
    score: 0.645,
    identity: { eligible: true, tier: 'Verified', confidence: 0.9 },
    availability: torboxState ? { torbox: { state: torboxState } } : {},
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

test('deferral: uncached ranks are not attempted when a cached candidate binds', async () => {
  const calls = [];
  const ensure = async ({ infoHash }) => {
    calls.push(infoHash);
    if (infoHash === H3) {
      return { torrentFileId: 'tf-3', placementId: 'pl-3', providerFileId: 'pf-3', size: 100 };
    }
    const err = new Error('No TorBox placement');
    err.code = 'NO_PLACEMENT';
    throw err;
  };
  const result = await selectBindableCandidate(
    [candidate({ infoHash: H1, rank: 1, torboxState: 'uncached' }),
     candidate({ infoHash: H2, rank: 2, torboxState: 'uncached' }),
     candidate({ infoHash: H3, rank: 3, torboxState: 'cached' })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: null,
      controlPlaneStore: storeStub(),
    },
  );
  assert.equal(result.reason, 'exact-size bound');
  assert.equal(result.selected.infoHash, H3);
  // Only the cached winner paid a provider sequence.
  assert.deepEqual(calls, [H3]);
  const unattempted = result.skipped.filter((s) => s.reason === 'deferred-uncached-unattempted');
  assert.equal(unattempted.length, 2, 'deferred ranks recorded honestly');
  assert.ok(!result.skipped.some((s) => !s.reason), 'every skipped entry has a reason');
});

test('deferral: fallback attempts deferred ranks in order when nothing else binds', async () => {
  const calls = [];
  const ensure = async ({ infoHash }) => {
    calls.push(infoHash);
    if (infoHash === H2) {
      return { torrentFileId: 'tf-2', placementId: 'pl-2', providerFileId: 'pf-2', size: 100 };
    }
    const err = new Error('No TorBox placement');
    err.code = 'NO_PLACEMENT';
    throw err;
  };
  const result = await selectBindableCandidate(
    [candidate({ infoHash: H1, rank: 1, torboxState: 'cached' }),
     candidate({ infoHash: H2, rank: 2, torboxState: 'uncached' })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: null,
      controlPlaneStore: storeStub(),
    },
  );
  assert.equal(result.selected.infoHash, H2);
  // Phase 1 tried the cached rank (failed), phase 2 tried the deferred rank.
  assert.deepEqual(calls, [H1, H2]);
  assert.ok(result.skipped.some((s) => s.infoHash === H1 && s.reason !== 'deferred-uncached-unattempted'));
});

test('deferral: unknown and missing states always attempt normally', async () => {
  const calls = [];
  const ensure = async ({ infoHash }) => {
    calls.push(infoHash);
    return { torrentFileId: `tf-${infoHash.slice(0, 2)}`, placementId: 'pl', providerFileId: 'pf', size: 100 };
  };
  const result = await selectBindableCandidate(
    [candidate({ infoHash: H1, rank: 1, torboxState: 'unknown' }),
     { ...candidate({ infoHash: H2, rank: 2, torboxState: 'cached' }), availability: {} }],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: null,
      controlPlaneStore: storeStub(),
    },
  );
  assert.equal(result.selected.infoHash, H1);
  assert.deepEqual(calls, [H1], 'first candidate binds immediately');
  assert.equal(result.skipped.length, 0);
});

test('deferral: TV episode scope defers identically without touching S/E rules', async () => {
  const calls = [];
  const ensure = async ({ infoHash, skipSizeMatch }) => {
    calls.push({ infoHash, skipSizeMatch: !!skipSizeMatch });
    if (infoHash === H1) {
      const err = new Error('No TorBox placement');
      err.code = 'NO_PLACEMENT';
      throw err;
    }
    if (!skipSizeMatch) {
      return { torrentFileId: 'tf-2', placementId: 'pl-2', providerFileId: 'pf-2', size: 100 };
    }
    throw new Error('should not reach PATH B TV ensure');
  };
  const result = await selectBindableCandidate(
    [candidate({ infoHash: H1, rank: 1, torboxState: 'uncached' }),
     candidate({ infoHash: H2, rank: 2, torboxState: 'cached' })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: { season: 1, episode: 1 },
      controlPlaneStore: storeStub(),
    },
  );
  assert.equal(result.reason, 'exact-size bound');
  assert.equal(result.selected.infoHash, H2);
  assert.equal(calls.length, 1, 'deferred uncached TV candidate costs zero provider calls');
  assert.equal(calls[0].infoHash, H2);
});
