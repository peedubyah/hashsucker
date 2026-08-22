/**
 * Media-Scoped Retrieval Tests
 *
 * Proves Stage 2 invariants for selected-media local corpus eligibility:
 * 1. Exact candidate identity remains (infoHash, fileIndex)
 * 2. Public identity remains releaseKey = lower(infoHash) + ":" + (fileIndex ?? "torrent")
 * 3. Local eligibility requires candidate_media association to selected mediaId
 * 4. Association to OTHER mediaId never makes candidate eligible
 * 5. Identity confidence comes only from selected-media association
 * 6. FTS/text matching is retrieval evidence, not identity authority
 * 7. Hard eligibility rejection happens before preference scoring
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { searchReleases, combinedSearch } from '../src/lib/discovery/search-engine.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { identityConfidenceForMedia, rankHit } from '../src/lib/discovery/ranking.js';

// Test fixtures
const HASH_H = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';
const MEDIA_A = 'tt12345'; // Some media ID
const MEDIA_B = 'tt67890'; // Another media ID

/**
 * Helper: create a candidate with release attributes and media association
 */
function setupCandidateWithMedia(cache, infoHash, fileIndex, mediaId, options = {}) {
  const filename = options.filename || `Release.${infoHash.slice(0, 8)}.mkv`;
  const title = options.title || `Title ${infoHash.slice(0, 8)}`;

  // Store release attributes (populates FTS)
  storeReleaseAttributes(cache, {
    infoHash,
    fileIndex,
    filename,
    source: 'ptn-regex',
    confidence: options.confidence || 0.9,
    parsed: {
      title,
      year: options.year || 2024,
      season: options.season,
      episode: options.episode,
      resolution: options.resolution || '1080p',
    },
    evidence: ['title_extracted'],
  });

  // Associate with media
  cache.associateMedia(infoHash, fileIndex, mediaId, {
    confidence: options.mediaConfidence != null ? options.mediaConfidence : 0.9,
    source: options.mediaSource || 'search',
  });
}

// =============================================================================
// Test 1: Cross-title leakage
// Candidate X associated only with media A
// Search selected media B
// Expected: candidate X absent
// =============================================================================
test('cross-title leakage: candidate associated only with media A is absent when searching media B', () => {
  const cache = createDiscoveryCache();

  setupCandidateWithMedia(cache, HASH_H, null, MEDIA_A, {
    filename: 'Movie.A.2024.mkv',
    title: 'Movie A',
  });

  // Search for media B with empty query (would previously return arbitrary rows)
  const result = searchReleases(cache, {
    query: 'Movie',
    mediaId: MEDIA_B,
  });

  assert.equal(result.results.length, 0, 'Candidate associated only with media A must not appear for media B');
  assert.equal(result.total, 0);
  cache.close();
});

// =============================================================================
// Test 2: Exact association
// Candidate X associated with media B
// Search media B
// Expected: candidate X eligible
// =============================================================================
test('exact association: candidate associated with media B is eligible when searching media B', () => {
  const cache = createDiscoveryCache();

  setupCandidateWithMedia(cache, HASH_H, null, MEDIA_B, {
    filename: 'Movie.B.2024.mkv',
    title: 'Movie B',
  });

  const result = searchReleases(cache, {
    query: 'Movie',
    mediaId: MEDIA_B,
  });

  assert.equal(result.results.length, 1, 'Candidate associated with media B must be eligible');
  assert.equal(result.results[0].hash.toLowerCase(), HASH_H.toLowerCase());
  assert.equal(result.results[0].fileIndex, null);
  cache.close();
});

// =============================================================================
// Test 3: Multi-association
// Candidate X has media A confidence 0.95 and media B confidence 0.40
// Search media B
// Expected: eligible, identity confidence = 0.40
// =============================================================================
test('multi-association: identity confidence scoped to selected media (0.40, not 0.95)', () => {
  const cache = createDiscoveryCache();

  // Create candidate with attributes
  storeReleaseAttributes(cache, {
    infoHash: HASH_H,
    fileIndex: null,
    filename: 'Multi.Assoc.2024.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Multi Association',
      year: 2024,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  // Associate with media A (high confidence)
  cache.associateMedia(HASH_H, null, MEDIA_A, {
    confidence: 0.95,
    source: 'enrichment',
  });

  // Associate with media B (lower confidence)
  cache.associateMedia(HASH_H, null, MEDIA_B, {
    confidence: 0.40,
    source: 'search',
  });

  // Search for media B
  const result = searchReleases(cache, {
    query: 'Multi',
    mediaId: MEDIA_B,
  });

  assert.equal(result.results.length, 1, 'Candidate must be eligible for media B');

  // Identity confidence must be 0.40 (from media B association), NOT 0.95 (from media A)
  assert.equal(result.results[0].identityConfidence, 0.4,
    'Identity confidence must come from selected media B (0.40), not media A (0.95)');
  cache.close();
});

// =============================================================================
// Test 4: Same hash / different file
// hash H fileIndex 0 -> media A
// hash H fileIndex 1 -> media B
// Search media B
// Expected: only H:1 eligible
// =============================================================================
test('same hash different file: only H:1 eligible when searching media B', () => {
  const cache = createDiscoveryCache();

  // fileIndex 0 associated with media A
  storeReleaseAttributes(cache, {
    infoHash: HASH_H,
    fileIndex: 0,
    filename: 'Same.Hash.File0.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Same Hash',
      resolution: '1080p',
    },
  });
  cache.associateMedia(HASH_H, 0, MEDIA_A, { confidence: 0.9 });

  // fileIndex 1 associated with media B
  storeReleaseAttributes(cache, {
    infoHash: HASH_H,
    fileIndex: 1,
    filename: 'Same.Hash.File1.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Same Hash',
      resolution: '1080p',
    },
  });
  cache.associateMedia(HASH_H, 1, MEDIA_B, { confidence: 0.9 });

  const result = searchReleases(cache, {
    query: 'Same Hash',
    mediaId: MEDIA_B,
  });

  assert.equal(result.results.length, 1, 'Only fileIndex 1 should be eligible');
  assert.equal(result.results[0].fileIndex, 1, 'Result must be fileIndex 1 (associated with media B)');
  cache.close();
});

// =============================================================================
// Test 5: Null index vs zero
// H:torrent (fileIndex=null, key=-1) -> media A
// H:0 (fileIndex=0, key=0) -> media B
// Search media B
// Expected: H:0 eligible, H:torrent absent
// =============================================================================
test('null index vs zero: H:0 eligible, H:torrent absent when searching media B', () => {
  const cache = createDiscoveryCache();

  // fileIndex null (key=-1) associated with media A
  storeReleaseAttributes(cache, {
    infoHash: HASH_H,
    fileIndex: null,
    filename: 'Null.Index.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Null Index',
      resolution: '1080p',
    },
  });
  cache.associateMedia(HASH_H, null, MEDIA_A, { confidence: 0.9 });

  // fileIndex 0 (key=0) associated with media B
  storeReleaseAttributes(cache, {
    infoHash: HASH_H,
    fileIndex: 0,
    filename: 'Zero.Index.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Zero Index',
      resolution: '1080p',
    },
  });
  cache.associateMedia(HASH_H, 0, MEDIA_B, { confidence: 0.9 });

  const result = searchReleases(cache, {
    query: 'Index',
    mediaId: MEDIA_B,
  });

  assert.equal(result.results.length, 1, 'Only fileIndex 0 should be eligible');
  assert.equal(result.results[0].fileIndex, 0, 'Result must be fileIndex 0 (not null/torrent)');
  assert.equal(result.results[0].releaseKey, `${HASH_H.toLowerCase()}:0`);
  cache.close();
});

// =============================================================================
// Test 6: Empty textual query
// Selected media B with q=""
// Expected: only candidates explicitly associated with B, never arbitrary newest rows
// =============================================================================
test('empty textual query: only candidates explicitly associated with media B', () => {
  const cache = createDiscoveryCache();

  // Candidate associated with media A (should NOT appear)
  setupCandidateWithMedia(cache, HASH_B, null, MEDIA_A, {
    filename: 'Unrelated.Movie.mkv',
    title: 'Unrelated Movie',
  });

  // Candidate associated with media B (SHOULD appear)
  setupCandidateWithMedia(cache, HASH_C, null, MEDIA_B, {
    filename: 'Target.Movie.mkv',
    title: 'Target Movie',
  });

  // Empty query would previously return arbitrary newest rows
  const result = searchReleases(cache, {
    query: '',
    mediaId: MEDIA_B,
  });

  assert.equal(result.results.length, 1, 'Only candidates associated with media B should appear');
  assert.equal(result.results[0].hash.toLowerCase(), HASH_C.toLowerCase());
  cache.close();
});

// =============================================================================
// Test 7: Live discovery regression
// A valid live candidate for selected media B must still survive combined search
// even if it has no persisted candidate_media row yet.
// =============================================================================
test('live discovery regression: live candidate without candidate_media survives combined search', async () => {
  const cache = createDiscoveryCache();

  // Only add a candidate associated with media B to corpus
  setupCandidateWithMedia(cache, HASH_H, null, MEDIA_B, {
    filename: 'Corpus.Candidate.mkv',
    title: 'Corpus Candidate',
  });

  // Simulate a live discovery function that returns a candidate not yet in corpus
  const mockLiveDiscovery = async () => [
    {
      infoHash: HASH_B,
      fileIndex: 0,
      filename: 'Live.Candidate.mkv',
      title: 'Live Candidate',
      resolution: '1080p',
    },
  ];

  const result = await combinedSearch(cache, {
    query: 'Candidate',
    mediaId: MEDIA_B,
    includeLive: true,
    liveDiscoveryFn: mockLiveDiscovery,
    mode: 'raw',
  });

  // Both corpus (HASH_H) and live (HASH_B) candidates should appear
  const hashes = result.results.map(r => r.hash.toLowerCase());
  assert.ok(hashes.includes(HASH_H.toLowerCase()), 'Corpus candidate must be present');
  assert.ok(hashes.includes(HASH_B.toLowerCase()), 'Live candidate must be present (no corpus association required)');
  cache.close();
});

// =============================================================================
// Test: identityConfidenceForMedia unit tests
// =============================================================================
test('identityConfidenceForMedia: returns NEUTRAL when mediaId is null', () => {
  const associations = [
    { mediaId: 'tt1', confidence: 0.9 },
  ];
  const score = identityConfidenceForMedia(associations, null);
  assert.equal(score, 0.5);
});

test('identityConfidenceForMedia: returns NEUTRAL when no associations', () => {
  const score = identityConfidenceForMedia([], 'tt1');
  assert.equal(score, 0.5);
});

test('identityConfidenceForMedia: returns NEUTRAL when no association to mediaId', () => {
  const associations = [
    { mediaId: 'tt1', confidence: 0.9 },
    { mediaId: 'tt2', confidence: 0.8 },
  ];
  const score = identityConfidenceForMedia(associations, 'tt999');
  assert.equal(score, 0.5);
});

test('identityConfidenceForMedia: returns max confidence for matching mediaId', () => {
  const associations = [
    { mediaId: 'tt1', confidence: 0.9 },
    { mediaId: 'tt2', confidence: 0.4 },
    { mediaId: 'tt2', confidence: 0.6 }, // Multiple associations to same media
  ];
  const score = identityConfidenceForMedia(associations, 'tt2');
  assert.equal(score, 0.6);
});

// =============================================================================
// Test: rankHit with mediaId scoping
// =============================================================================
test('rankHit with mediaId: uses identityConfidenceForMedia', () => {
  const hit = {
    hash: HASH_H,
    fileIndex: null,
    filename: 'Test.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p' },
    parserConfidence: 0.9,
    mediaAssociations: [
      { mediaId: MEDIA_A, confidence: 0.95 },
      { mediaId: MEDIA_B, confidence: 0.40 },
    ],
    providerObservations: [],
  };

  // Without mediaId, uses max confidence (0.95)
  const rankedNoMedia = rankHit(hit, {});
  assert.equal(rankedNoMedia.components.identityConfidence, 0.95);

  // With mediaId=MEDIA_B, uses 0.40
  const rankedMediaB = rankHit(hit, {}, MEDIA_B);
  assert.equal(rankedMediaB.components.identityConfidence, 0.40);

  // With mediaId=MEDIA_A, uses 0.95
  const rankedMediaA = rankHit(hit, {}, MEDIA_A);
  assert.equal(rankedMediaA.components.identityConfidence, 0.95);
});

// =============================================================================
// Test: searchReleases without mediaId behaves as before (backward compat)
// =============================================================================
test('backward compat: searchReleases without mediaId returns all matches', () => {
  const cache = createDiscoveryCache();

  setupCandidateWithMedia(cache, HASH_H, null, MEDIA_A, {
    filename: 'Movie.A.2024.mkv',
    title: 'Movie A',
  });
  setupCandidateWithMedia(cache, HASH_B, null, MEDIA_B, {
    filename: 'Movie.B.2024.mkv',
    title: 'Movie B',
  });

  // Without mediaId, both candidates should appear (no eligibility filtering)
  const result = searchReleases(cache, {
    query: 'Movie',
  });

  assert.ok(result.results.length >= 2, 'Without mediaId, all matches should be returned');
  cache.close();
});
