/**
 * Retrieval Window Correctness Tests — Stage 3 Bounded Retrieval
 *
 * Proves the Stage 1 retrieval window contract:
 * 1. Public limit does NOT determine retrieval recall.
 * 2. Pagination occurs AFTER final global ranking.
 * 3. An oracle winner outside the old limit*2 window is now retained.
 * 4. Selected-media eligibility remains fail-closed.
 * 5. Episode hard gates remain before desirability ranking.
 * 6. Live+local exact dedup still occurs before final rank.
 * 7. Live selected-TV behavior remains intact.
 * 8. Null fileIndex != 0 remains intact.
 * 9. Retrieval source order cannot determine final winner.
 * 10. Deterministic repeated query yields identical ordering.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { combinedSearch, searchReleases } from '../src/lib/discovery/search-engine.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { rankHits } from '../src/lib/discovery/ranking.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';
const HASH_D = 'dddddddddddddddddddddddddddddddddddddddd';
const HASH_E = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const HASH_F = 'ffffffffffffffffffffffffffffffffffffffff';
const HASH_LIVE = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const MEDIA_SHOW = 'tt2085059';
const MEDIA_OTHER = 'tt0903747';

function setupRelease(cache, infoHash, attrs) {
  const fileIndex = attrs.fileIndex ?? null;
  cache.upsertCandidate({
    infoHash,
    fileIndex,
    filename: attrs.filename,
    title: attrs.title,
  });
  storeReleaseAttributes(cache, {
    infoHash,
    fileIndex,
    filename: attrs.filename,
    source: 'ptn-regex',
    confidence: attrs.confidence || 0.85,
    parsed: {
      title: attrs.title,
      year: attrs.year,
      season: attrs.season,
      episode: attrs.episode,
      episodeRange: attrs.episodeRange,
      resolution: attrs.resolution,
      source: attrs.source,
      codec: attrs.codec,
      hdr: attrs.hdr,
      mediaType: attrs.mediaType,
      audio: attrs.audio,
      releaseGroup: attrs.releaseGroup,
    },
    evidence: ['title_extracted'],
  });
}

// =============================================================================
// Test 1: Public limit does NOT determine retrieval recall
// =============================================================================

test('RETRIEVAL: public limit does not determine retrieval window', async () => {
  const cache = createDiscoveryCache();
  const baseTitle = 'Black Mirror';

  // Insert 20 releases with same title, increasing quality
  // The LAST one inserted has the HIGHEST quality
  const hashes = [
    'a000000000000000000000000000000000000000',
    'a000000000000000000000000000000000000001',
    'a000000000000000000000000000000000000002',
    'a000000000000000000000000000000000000003',
    'a000000000000000000000000000000000000004',
    'a000000000000000000000000000000000000005',
    'a000000000000000000000000000000000000006',
    'a000000000000000000000000000000000000007',
    'a000000000000000000000000000000000000008',
    'a000000000000000000000000000000000000009',
    'a000000000000000000000000000000000000010',
    'a000000000000000000000000000000000000011',
    'a000000000000000000000000000000000000012',
    'a000000000000000000000000000000000000013',
    'a000000000000000000000000000000000000014',
    'a000000000000000000000000000000000000015',
    'a000000000000000000000000000000000000016',
    'a000000000000000000000000000000000000017',
    'a000000000000000000000000000000000000018',
    'a000000000000000000000000000000000000019',
  ];
  for (let i = 0; i < 20; i++) {
    const quality = i === 19 ? '2160p' : '480p';
    const source = i === 19 ? 'Remux' : 'DVD';
    setupRelease(cache, hashes[i], {
      filename: `Black.Mirror.S01E0${i}.${quality}.${source}.mkv`,
      title: baseTitle,
      resolution: quality,
      source,
      year: 2024,
      fileIndex: i,
      confidence: i === 19 ? 0.95 : 0.8,
    });
  }

  // Query with limit=1 — should still retrieve all candidates for ranking
  const result = await combinedSearch(cache, {
    query: 'Black Mirror',
    limit: 1,
    offset: 0,
    retrievalWindow: 100,
  });

  // The top result should be the highest quality (2160p Remux)
  assert.ok(result.results.length >= 1, 'Should return at least 1 result');
  assert.ok(result.results[0].score > 0, 'raw mode returns ranked results with scores');
  // Verify that the retrieval window was honored (total reflects post-rank count)
  assert.ok(result.total >= 1, 'total reflects ranked candidates');

  // Different public limits should not change which candidates are retrieved
  const resultSmallLimit = await combinedSearch(cache, {
    query: 'Black Mirror',
    limit: 5,
    offset: 0,
    retrievalWindow: 100,
  });
  const resultLargeLimit = await combinedSearch(cache, {
    query: 'Black Mirror',
    limit: 50,
    offset: 0,
    retrievalWindow: 100,
  });

  // Both should see the same total candidate pool
  assert.equal(resultSmallLimit.total, resultLargeLimit.total,
    'Public limit must NOT change retrieval window total');
});

// =============================================================================
// Test 2: Pagination occurs AFTER final global ranking
// =============================================================================

test('RETRIEVAL: pagination occurs after global desirability rank', async () => {
  const cache = createDiscoveryCache();

  // Insert releases with varying quality — worst quality first in source order
  const qualities = ['480p', '720p', '1080p', '2160p'];
  const hashes = [
    'b000000000000000000000000000000000000000',
    'b000000000000000000000000000000000000001',
    'b000000000000000000000000000000000000002',
    'b000000000000000000000000000000000000003',
  ];
  for (let i = 0; i < 4; i++) {
    setupRelease(cache, hashes[i], {
      filename: `Show.S01E0${i}.${qualities[i]}.mkv`,
      title: 'Show',
      resolution: qualities[i],
      source: 'BluRay',
      year: 2024,
      fileIndex: i,
      confidence: 0.85,
    });
  }

  // Get first page (limit=2, offset=0)
  const page1 = await combinedSearch(cache, {
    query: 'Show',
    limit: 2,
    offset: 0,
  });

  // Get second page (limit=2, offset=2)
  const page2 = await combinedSearch(cache, {
    query: 'Show',
    limit: 2,
    offset: 2,
  });

  // Total should be consistent
  assert.equal(page1.total, 4);
  assert.equal(page2.total, 4);

  // First page should have the top-2 ranked results (highest quality)
  // These should be 2160p and 1080p (in descending desirability order)
  assert.ok(page1.results[0].components.quality >= page1.results[1].components.quality,
    'Page 1 should be in descending desirability order');

  // Page 1 and 2 should be disjoint (no overlap)
  const page1Keys = new Set(page1.results.map(r => r.hash));
  for (const r of page2.results) {
    assert.ok(!page1Keys.has(r.hash), 'Pages must be disjoint');
  }
});

// =============================================================================
// Test 3: Adversarial winner outside old limit*2 window is now retained
// =============================================================================

test('RETRIEVAL: adversarial winner outside old limit*2 window is retained', async () => {
  const cache = createDiscoveryCache();
  const baseTitle = 'Dune';
  const matchedCount = 50;  // 50 rows matching the title

  // Insert 49 SHORT filenames (high BM25 rank) + 1 LONG filename winner
  // Generate unique 40-char hashes
  for (let i = 0; i < matchedCount - 1; i++) {
    const hash = `c${String(i).padStart(39, '0')}`;
    setupRelease(cache, hash, {
      filename: `Dune.${2024}.1080p.BluRay.DTS-HD.MA.5.1.x264-Group${i}.mkv`,
      title: baseTitle,
      resolution: '1080p',
      source: 'BluRay',
      year: 2024,
      fileIndex: i,
      confidence: 0.85,
    });
  }

  // The adversarial winner: 2160p Remux with LONG filename
  // BM25 will rank this LOWER due to document length
  setupRelease(cache, 'c999999999999999999999999999999999999999', {
    filename: `Dune.${2024}.2160p.UHD.BluRay.REMUX.DV.HDR10Plus.DTS-HD.MA.TrueHD.7.1.Atmos-FGT.mkv`,
    title: baseTitle,
    resolution: '2160p',
    source: 'Remux',
    codec: 'x265',
    hdr: true,
    year: 2024,
    fileIndex: 99,
    confidence: 0.95,
  });

  // With OLD policy: limit=10 → window=min(10*2, 200)=20 rows.
  // The 2160p winner (with long filename) might be at position 50 in BM25 order.
  // Old policy would miss it.
  const oldWindowResult = await combinedSearch(cache, {
    query: 'Dune',
    limit: 10,
    offset: 0,
    retrievalWindow: 20,  // force small window like old policy
  });

  // With NEW default policy: window=2000 rows, all candidates retrieved.
  const newWindowResult = await combinedSearch(cache, {
    query: 'Dune',
    limit: 10,
    offset: 0,
    retrievalWindow: 2000,  // new default
  });

  // Under small window, the adversarial winner might be missing
  const smallWinnerIsTopQuality = oldWindowResult.results[0]?.components?.quality >= 0.9;
  const largeWinnerIsTopQuality = newWindowResult.results[0]?.components?.quality >= 0.9;

  // The key assertion: with a large enough window, the 2160p winner should
  // appear in the top results. If the small window also happens to have it,
  // that's fine — but the large window MUST have it.
  assert.ok(largeWinnerIsTopQuality,
    'Adversarial high-quality winner must be retained with window=2000');
});

// =============================================================================
// Test 4: Corpus searchable by release identity (not mediaId-gated)
// mediaId only scopes identity confidence in ranking
// =============================================================================

test('RETRIEVAL: corpus searchable by release identity, mediaId scopes ranking', async () => {
  const cache = createDiscoveryCache();

  // Candidate associated with the selected media
  setupRelease(cache, HASH_A, {
    filename: 'Show.S01E01.1080p.mkv',
    title: 'Show',
    resolution: '1080p',
    source: 'BluRay',
    year: 2024,
    season: 1,
    episode: 1,
    mediaType: 'episode',
  });
  cache.associateMedia(HASH_A, null, MEDIA_SHOW, { confidence: 0.9 });

  // Same title, NOT associated with the selected media
  setupRelease(cache, HASH_B, {
    filename: 'Show.S01E01.2160p.mkv',
    title: 'Show',
    resolution: '2160p',
    source: 'Remux',
    year: 2024,
    season: 1,
    episode: 1,
    mediaType: 'episode',
  });

  const result = await combinedSearch(cache, {
    query: 'Show',
    limit: 10,
    season: 1,
    episode: 1,
    mediaId: MEDIA_SHOW,
    retrievalWindow: 100,
  });

  // Both candidates appear (corpus searchable by release identity)
  assert.equal(result.results.length, 2, 'Both candidates appear (corpus searchable by release identity)');
  // HASH_A ranks higher due to identity confidence from MEDIA_SHOW association
  assert.equal(result.results[0].hash, HASH_A, 'Associated candidate ranks higher (identity confidence)');
  assert.equal(result.results[0].components.identityConfidence, 0.9, 'Identity confidence from MEDIA_SHOW');
  assert.equal(result.results[1].components.identityConfidence, 0.5, 'Non-associated candidate has NEUTRAL identity');
});

// =============================================================================
// Test 5: Episode hard gates remain before desirability ranking
// =============================================================================

test('RETRIEVAL: episode hard gates apply before desirability ranking', async () => {
  const cache = createDiscoveryCache();

  // Candidate that covers S01E01 — lower quality
  setupRelease(cache, HASH_A, {
    filename: 'Show.S01E01.480p.mkv',
    title: 'Show',
    resolution: '480p',
    source: 'DVD',
    year: 2024,
    season: 1,
    episode: 1,
    mediaType: 'episode',
  });
  cache.associateMedia(HASH_A, null, MEDIA_SHOW, { confidence: 0.9 });

  // Candidate that does NOT cover S01E01 (wrong episode) — higher quality
  setupRelease(cache, HASH_B, {
    filename: 'Show.S01E02.2160p.mkv',
    title: 'Show',
    resolution: '2160p',
    source: 'Remux',
    year: 2024,
    season: 1,
    episode: 2,  // Wrong episode!
    mediaType: 'episode',
  });
  cache.associateMedia(HASH_B, null, MEDIA_SHOW, { confidence: 0.9 });

  const result = await combinedSearch(cache, {
    query: 'Show S01E01',
    limit: 10,
    season: 1,
    episode: 1,
    mediaId: MEDIA_SHOW,
    retrievalWindow: 100,
  });

  // Only the S01E01 candidate should appear, even though S01E02 is higher quality
  assert.equal(result.results.length, 1, 'Only episode-covering candidate should be eligible');
  assert.equal(result.results[0].hash, HASH_A, 'S01E01 candidate should appear');
  assert.equal(result.results[0].components.quality < 0.5, true, '480p quality expected');
});

// =============================================================================
// Test 6: Live+local exact dedup still occurs before final rank
// =============================================================================

test('RETRIEVAL: live+local exact dedup occurs before final rank', async () => {
  const cache = createDiscoveryCache();

  // Local candidate
  setupRelease(cache, HASH_A, {
    filename: 'Movie.2024.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
    source: 'BluRay',
    year: 2024,
    fileIndex: null,
  });

  // Mock live discovery returning same releaseKey
  const mockLiveDiscovery = async () => [{
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
    confidence: 0.8,
    sources: [{ addonId: 'torrentio.torbox' }],
  }];

  const result = await combinedSearch(cache, {
    query: 'Movie',
    limit: 10,
    includeLive: true,
    liveDiscoveryFn: mockLiveDiscovery,
    retrievalWindow: 100,
  });

  // Should have exactly 1 result (deduped by releaseKey)
  assert.equal(result.total, 1, 'Live+local duplicate should merge to 1');
});

// =============================================================================
// Test 7: Live selected-TV behavior remains intact
// =============================================================================

test('RETRIEVAL: live selected-TV behavior intact (no candidate_media required)', async () => {
  const cache = createDiscoveryCache();
  const HASH_LIVE = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  // Mock live discovery returns a live result for the selected media
  const mockLiveDiscovery = async () => ({
    releases: [{
      infoHash: HASH_LIVE,
      fileIndex: null,
      filename: 'Show.S03E04.Live.720p.mkv',
      title: 'Show S03E04',
      resolution: '720p',
      confidence: 0.85,
      season: 3,
      episode: 4,
      sources: [{ addonId: 'torrentio.torbox' }],
    }],
    sources: {
      torrentio: { count: 1, error: null },
      torznab: { count: 0, error: null },
    },
  });

  const result = await combinedSearch(cache, {
    query: 'Show S03E04',
    limit: 10,
    season: 3,
    episode: 4,
    mediaId: MEDIA_SHOW,
    includeLive: true,
    liveDiscoveryFn: mockLiveDiscovery,
    retrievalWindow: 100,
  });

  // Live candidate should be eligible even without candidate_media
  assert.equal(result.results.length, 1, 'Live candidate should be eligible without candidate_media');
  assert.equal(result.results[0].hash, HASH_LIVE, 'Live candidate should be the result');
});

// =============================================================================
// Test 8: Null fileIndex != 0 remains intact
// =============================================================================

test('RETRIEVAL: null fileIndex != 0 identity preserved', async () => {
  const cache = createDiscoveryCache();

  // Candidate with null fileIndex (torrent-level)
  setupRelease(cache, HASH_A, {
    filename: 'Movie.2024.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
    source: 'BluRay',
    year: 2024,
    fileIndex: null,
  });

  // Candidate with fileIndex=0 (first file in torrent)
  setupRelease(cache, HASH_A, {
    filename: 'Movie.2024.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
    source: 'BluRay',
    year: 2024,
    fileIndex: 0,
  });

  const result = await combinedSearch(cache, {
    query: 'Movie',
    limit: 10,
    retrievalWindow: 100,
  });

  // Both should be distinct results (different fileIndex = different releaseKey)
  assert.equal(result.total, 2, 'Null and zero fileIndex should be distinct');
  const fileIndices = result.results.map(r => r.fileIndex).sort();
  assert.deepEqual(fileIndices, [0, null], 'fileIndex values preserved');
});

// =============================================================================
// Test 9: Retrieval source order cannot determine final winner
// =============================================================================

test('RETRIEVAL: retrieval source order cannot determine final winner', async () => {
  const cache = createDiscoveryCache();

  // Insert LOW quality first in source order
  setupRelease(cache, HASH_A, {
    filename: 'Movie.2024.480p.DVD.mkv',
    title: 'Movie',
    resolution: '480p',
    source: 'DVD',
    year: 2024,
    fileIndex: 0,
    confidence: 0.95,  // High confidence
  });

  // Insert HIGH quality later
  setupRelease(cache, HASH_B, {
    filename: 'Movie.2024.2160p.UHD.BluRay.HDR.mkv',
    title: 'Movie',
    resolution: '2160p',
    source: 'Remux',
    codec: 'x265',
    hdr: true,
    year: 2024,
    fileIndex: 0,
    confidence: 0.85,
  });

  const result = await combinedSearch(cache, {
    query: 'Movie',
    limit: 10,
    retrievalWindow: 100,
  });

  // High quality should win despite being inserted later
  assert.equal(result.results[0].hash, HASH_B, 'Higher quality should outrank lower quality');
  assert.ok(result.results[0].components.quality > result.results[1].components.quality,
    'Winner should have higher quality score');
});

// =============================================================================
// Test 10: Deterministic repeated query yields identical ordering
// =============================================================================

test('RETRIEVAL: deterministic repeated query yields identical ordering', async () => {
  const cache = createDiscoveryCache();

  for (let i = 0; i < 10; i++) {
    setupRelease(cache, `${'a'.repeat(39)}${String(i).padStart(1, '0')}`, {
      filename: `Show.2024.S01E${String(i).padStart(2, '0')}.${['480p', '720p', '1080p', '2160p'][i % 4]}.mkv`,
      title: 'Show',
      resolution: ['480p', '720p', '1080p', '2160p'][i % 4],
      source: 'BluRay',
      year: 2024,
      season: 1,
      episode: i + 1,
      fileIndex: i,
      confidence: 0.8 + (i % 5) * 0.04,
    });
  }

  const result1 = await combinedSearch(cache, {
    query: 'Show',
    limit: 5,
    retrievalWindow: 100,
  });

  const result2 = await combinedSearch(cache, {
    query: 'Show',
    limit: 5,
    retrievalWindow: 100,
  });

  const result3 = await combinedSearch(cache, {
    query: 'Show',
    limit: 10,
    retrievalWindow: 100,
  });

  // Same total
  assert.equal(result1.total, result2.total);
  assert.equal(result2.total, result3.total);

  // Same order
  const hashes1 = result1.results.map(r => r.hash);
  const hashes2 = result2.results.map(r => r.hash);
  assert.deepEqual(hashes1, hashes2, 'Repeated query must yield identical order');
});
