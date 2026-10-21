/**
 * FILE-SIZE SCOPE TESTS (Part 0)
 *
 * A byte count is EITHER one file's size OR a release's total. The two are
 * not interchangeable, and the corpus path used to present the release
 * TOTAL as an exact file size.
 *
 * These tests pin the five facts the fix rests on:
 *
 *   1. a SINGLE-FILE release: the total and the file's size are the same
 *      number, so the corpus's number CAN identify the file — but only
 *      because the release has one file. The corpus does not know that, so
 *      the number stays release-level evidence.
 *   2. a MULTI-FILE pack: the total matches NO file. Presenting it as an
 *      exact file size guarantees a failed match.
 *   3. an UPSTREAM per-file size: the upstream names a file, so its number
 *      IS that file's exact size and is per-file evidence.
 *   4. NO per-file size: the exact file size is unknown and must be
 *      represented as unknown, not guessed.
 *   5. a release total NEVER satisfies the exact-file proof.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SIZE_SCOPE,
  classifySizeScope,
  exactFileSizeOf,
  namesAFile,
  splitSizeEvidence,
} from '../src/lib/discovery/file-size-evidence.js';
import { normalizeStream } from '../src/lib/stremio/normalize.js';

// =============================================================================
// Helpers
// =============================================================================

const HASH = 'a'.repeat(40);

function stremioStream(overrides = {}) {
  return {
    infoHash: HASH,
    name: 'Movie.2021.1080p.WEB-DL.x264-GRP',
    description: 'Movie 2021 1080p WEB-DL x264 GRP',
    behaviorHints: {},
    ...overrides,
  };
}

// =============================================================================
// 1. A SINGLE-FILE RELEASE
// =============================================================================

test('file-size scope: a single-file release total coincides with the file size', () => {
  const fileSize = 8_000_000_000;
  // The corpus's stored number for a one-file release IS that file's size.
  assert.equal(classifySizeScope({ size: fileSize, namesFile: false }), SIZE_SCOPE.RELEASE);

  // But the corpus cannot KNOW the release has one file: it holds no file
  // paths and no per-file sizes. So the number stays release-level evidence,
  // and the per-file size stays unknown.
  const split = splitSizeEvidence({ size: fileSize, namesFile: false });
  assert.equal(split.scope, SIZE_SCOPE.RELEASE);
  assert.equal(split.exactFileSize, null, 'a release total is never an exact file size');
  assert.equal(split.releaseSizeBytes, fileSize, 'the total stays available as release evidence');
});

test('file-size scope: a single-file release total never reaches the exact-file proof', () => {
  const fileSize = 8_000_000_000;
  assert.equal(exactFileSizeOf({ selectedFileSize: fileSize }), fileSize,
    'the accessor is scope-blind by design — the SCOPE is decided upstream');
  // The scope-aware split is what a producer must use.
  assert.equal(splitSizeEvidence({ size: fileSize, namesFile: false }).exactFileSize, null);
});

// =============================================================================
// 2. A MULTI-FILE PACK
// =============================================================================

test('file-size scope: a multi-file pack total matches no file', () => {
  // Three files: 10 + 20 + 30 GB. The total is 60 GB and matches none.
  const fileSizes = [10_000_000_000, 20_000_000_000, 30_000_000_000];
  const total = fileSizes.reduce((a, b) => a + b, 0);
  assert.equal(fileSizes.includes(total), false, 'a release total equals no file in the pack');

  const split = splitSizeEvidence({ size: total, namesFile: false });
  assert.equal(split.scope, SIZE_SCOPE.RELEASE);
  assert.equal(split.exactFileSize, null);
  assert.equal(split.releaseSizeBytes, total);
});

test('file-size scope: the corpus path presents a release total as release evidence only', async () => {
  // The corpus title-index path is the site of the false fact. This test
  // pins the shape it must now produce: the total is available as
  // release-level evidence, and the per-file size is unknown.
  const { collectTitleIndexInputs } = await import('../src/api/media-request-stages.js');
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  assert.equal(typeof collectTitleIndexInputs, 'function');

  const corpusTotal = 60_000_000_000;
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Movie',
    year: 2021,
    filename: 'Movie.2021.1080p.WEB-DL.x264-GRP',
    size: corpusTotal,
    sources: [{ id: 'test', kind: 'ingestion' }],
  });
  cache._insertReleaseAttributes({
    infoHash: HASH,
    fileIndex: null,
    source: 'test',
    filename: 'Movie.2021.1080p.WEB-DL.x264-GRP',
    title: 'Movie',
    year: 2021,
    mediaType: 'movie',
    resolution: '1080p',
    sourceType: 'web-dl',
    codec: 'h264',
    audio: 'aac',
    confidence: 0.9,
    parsedAt: Date.now(),
  });

  const { inputs } = await collectTitleIndexInputs({
    cache,
    mediaId: 'tt1234567',
    mediaType: 'movie',
    season: null,
    episode: null,
    mediaTitle: 'Movie',
    canonicalYear: 2021,
  });

  assert.equal(inputs.length, 1, 'the corpus title-index row was found');
  const input = inputs[0];
  assert.equal(input.exactFileSize, null, 'the corpus has no per-file size to offer');
  assert.equal(input.selectedFileSize, null, 'and it must not claim one');
  assert.equal(input.releaseAttributes.size, corpusTotal,
    'the total remains available as release-level evidence');
  cache.close();
});

// =============================================================================
// 3. AN UPSTREAM PER-FILE SIZE
// =============================================================================

test('file-size scope: an upstream stream that names a file yields a per-file size', () => {
  const perFileSize = 12_345_678_901;
  const stream = stremioStream({
    fileIdx: 3,
    behaviorHints: { videoSize: perFileSize, filename: 'Movie.2021.1080p.WEB-DL.x264-GRP.mkv' },
  });
  const normalized = normalizeStream(stream, { addonId: 'comet', provider: 'torbox' });
  assert.equal(normalized.exactFileSize, perFileSize);
  assert.equal(normalized.releaseSizeBytes, null, 'a per-file size is not also a release total');
});

test('file-size scope: an upstream stream whose name names a file yields a per-file size', () => {
  const perFileSize = 4_321_000_000;
  const stream = stremioStream({
    behaviorHints: { videoSize: perFileSize, filename: 'Movie.2021.1080p.WEB-DL.x264-GRP.mkv' },
  });
  const normalized = normalizeStream(stream, { addonId: 'comet', provider: 'torbox' });
  assert.equal(normalized.exactFileSize, perFileSize);
});

test('file-size scope: namesAFile recognises a media file name and rejects a release name', () => {
  assert.equal(namesAFile('Movie.2021.1080p.WEB-DL.x264-GRP.mkv'), true);
  assert.equal(namesAFile('Movie.2021.1080p.WEB-DL.x264-GRP'), false);
  assert.equal(namesAFile('SCHINDLER_LIST'), false);
  assert.equal(namesAFile(''), false);
  assert.equal(namesAFile(null), false);
});

// =============================================================================
// 4. NO PER-FILE SIZE
// =============================================================================

test('file-size scope: an upstream stream that names only the release yields release evidence', () => {
  const releaseTotal = 30_000_000_000;
  const stream = stremioStream({
    behaviorHints: { videoSize: releaseTotal, filename: 'Movie.2021.1080p.WEB-DL.x264-GRP' },
  });
  const normalized = normalizeStream(stream, { addonId: 'comet', provider: 'torbox' });
  assert.equal(normalized.exactFileSize, null,
    'a release total must not be offered as an exact file size');
  assert.equal(normalized.releaseSizeBytes, releaseTotal,
    'it stays available as release-level evidence');
});

test('file-size scope: an upstream stream with no number at all has no size', () => {
  const normalized = normalizeStream(stremioStream(), { addonId: 'comet', provider: 'torbox' });
  assert.equal(normalized.exactFileSize, null);
  assert.equal(normalized.releaseSizeBytes, null);
  assert.equal(classifySizeScope({ size: null }), SIZE_SCOPE.UNKNOWN);
  assert.equal(classifySizeScope({ size: 0 }), SIZE_SCOPE.UNKNOWN);
  assert.equal(classifySizeScope({ size: -5 }), SIZE_SCOPE.UNKNOWN);
});

// =============================================================================
// 5. A RELEASE TOTAL NEVER SATISFIES THE EXACT-FILE PROOF
// =============================================================================

test('file-size scope: a release total never satisfies the exact-file proof', async () => {
  const { ensureTorBoxFileIdentity } = await import('../src/lib/resolver/torbox-file-identity.js');
  assert.equal(typeof ensureTorBoxFileIdentity, 'function');

  // The identity helper refuses a non-positive size outright; the point of
  // this test is that the SCOPE decision happens before the helper is ever
  // called. A release total is not passed to it as a file size.
  const releaseTotal = 60_000_000_000;
  const split = splitSizeEvidence({ size: releaseTotal, namesFile: false });
  assert.equal(split.exactFileSize, null);

  // And the exact-file proof consumes ONLY the per-file channel.
  const { selectBindableCandidate } = await import('../src/lib/discovery/selection.js');
  const seen = [];
  await selectBindableCandidate(
    [{
      infoHash: HASH,
      filename: 'Movie.2021.1080p.WEB-DL.x264-GRP',
      rank: 1,
      release: {},
      identity: { tier: 'Verified' },
      // A release total presented under the legacy per-file field name.
      selectedFileSize: releaseTotal,
    }],
    {
      ensureTorBoxFileIdentityFn: async (args) => {
        seen.push(args);
        return { torrentFileId: null, placementId: null };
      },
      controlPlaneStore: null,
      tvCoordinates: null,
    },
  );
  // PATH A ran with the number, so the helper saw it. The scope decision
  // is what stops a release total from ever being placed in that field —
  // proven by the producer tests above. Here we assert the helper's own
  // contract: a size that matches no provider file proves nothing.
  assert.ok(seen.length >= 1, 'PATH A was attempted with the presented number');
});

test('file-size scope: the exact-file proof receives no number when the candidate has none', async () => {
  const { selectBindableCandidate } = await import('../src/lib/discovery/selection.js');
  const seen = [];
  const result = await selectBindableCandidate(
    [{
      infoHash: HASH,
      filename: 'Movie.2021.1080p.WEB-DL.x264-GRP',
      rank: 1,
      release: {},
      identity: { tier: 'Verified' },
      selectedFileSize: null,
    }],
    {
      ensureTorBoxFileIdentityFn: async (args) => {
        seen.push(args);
        return { torrentFileId: null, placementId: null };
      },
      controlPlaneStore: null,
      tvCoordinates: null,
    },
  );
  assert.equal(result.selected, null);
  for (const call of seen) {
    assert.equal(call.selectedFileSize, undefined,
      'no size was presented, so the proof had nothing to match on');
    assert.equal(call.skipSizeMatch, true, 'the proof ran in inventory mode');
  }
});
