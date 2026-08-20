/**
 * Combined Search + Live Bridge Tests
 *
 * Proves:
 * - combinedSearch() merges DMM corpus + live discovery
 * - Live discovery failure doesn't break corpus results
 * - UI-compatible output shape
 * 
 * Note: /api/search/releases endpoint was removed. The combinedSearch()
 * function is still tested directly here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { combinedSearch, searchReleases } from '../src/lib/discovery/search-engine.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

function setupCandidate(cache, infoHash, attrs) {
  cache.upsertCandidate({
    infoHash,
    fileIndex: null,
    filename: attrs.filename,
    title: attrs.title,
  });
  storeReleaseAttributes(cache, {
    infoHash,
    fileIndex: null,
    filename: attrs.filename,
    source: 'ptn-regex',
    confidence: attrs.confidence || 0.85,
    parsed: {
      title: attrs.title,
      year: attrs.year,
      season: attrs.season,
      episode: attrs.episode,
      resolution: attrs.resolution,
      sourceType: attrs.source,
      codec: attrs.codec,
      hdr: attrs.hdr,
      audio: attrs.audio,
      releaseGroup: attrs.releaseGroup,
    },
    evidence: ['title_extracted'],
  });
}

// =============================================================================
// combinedSearch Tests
// =============================================================================

test('combinedSearch: returns DMM corpus results when no live discovery', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Breaking.Bad.S05E14.1080p.mkv',
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    resolution: '1080p',
    confidence: 0.9,
  });

  const result = await combinedSearch(cache, {
    query: 'Breaking Bad S05E14',
    mode: 'ui',
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].infoHash, HASH1);
  assert.equal(result.results[0].resolution, '1080p');
  assert.ok(result.total >= 1);
  cache.close();
});

test('combinedSearch: merges live discovery results with corpus', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Breaking.Bad.S05E14.1080p.mkv',
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    resolution: '1080p',
  });

  // Mock live discovery that returns an additional result
  const mockLiveDiscovery = async () => [
    {
      infoHash: HASH2,
      filename: 'Breaking.Bad.S05E14.720p.mkv',
      title: 'Breaking Bad S05E14',
      season: 5,
      episode: 14,
      resolution: '720p',
      confidence: 0.8,
    },
  ];

  const result = await combinedSearch(cache, {
    query: 'Breaking Bad S05E14',
    includeLive: true,
    liveDiscoveryFn: mockLiveDiscovery,
    mode: 'ui',
  });

  // Should have both corpus + live results
  assert.equal(result.results.length, 2);
  const hashes = result.results.map(r => r.infoHash).sort();
  assert.deepEqual(hashes, [HASH1, HASH2].sort());
  cache.close();
});

test('combinedSearch: deduplicates by infoHash (corpus wins)', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Breaking.Bad.S05E14.1080p.mkv',
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    resolution: '1080p',
  });

  // Mock live discovery returns SAME hash as corpus
  const mockLiveDiscovery = async () => [
    {
      infoHash: HASH1,
      filename: 'Different.Filename.mkv',
      title: 'Different',
      resolution: '480p',
    },
  ];

  const result = await combinedSearch(cache, {
    query: 'Breaking Bad S05E14',
    includeLive: true,
    liveDiscoveryFn: mockLiveDiscovery,
    mode: 'ui',
  });

  // Should have only 1 result (deduplicated)
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].infoHash, HASH1);
  assert.equal(result.results[0].resolution, '1080p');  // Corpus version wins
  cache.close();
});

test('combinedSearch: live discovery failure does not break corpus', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Breaking.Bad.S05E14.1080p.mkv',
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    resolution: '1080p',
  });

  // Mock live discovery that throws
  const mockLiveDiscovery = async () => {
    throw new Error('Torrentio API unavailable');
  };

  const result = await combinedSearch(cache, {
    query: 'Breaking Bad S05E14',
    includeLive: true,
    liveDiscoveryFn: mockLiveDiscovery,
    mode: 'ui',
  });

  // Corpus results should still be returned
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].infoHash, HASH1);
  cache.close();
});

test('combinedSearch: UI mode maps results to UI-compatible shape', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Breaking.Bad.S05E14.1080p.mkv',
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    resolution: '1080p',
    codec: 'x264',
  });

  const result = await combinedSearch(cache, {
    query: 'Breaking Bad S05E14',
    mode: 'ui',
  });

  assert.equal(result.results.length, 1);
  const r = result.results[0];
  // UI shape fields
  assert.ok(r.infoHash);
  assert.ok(r.filename);
  assert.ok(r.resolution);
  assert.ok(r.score >= 0);
  cache.close();
});

test('combinedSearch: applies pagination', async () => {
  const cache = createDiscoveryCache();
  for (let i = 0; i < 10; i++) {
    setupCandidate(cache, `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${i}`, {
      filename: `Movie.Episode.${i}.1080p.mkv`,
      title: `Movie Episode ${i}`,
      resolution: '1080p',
    });
  }

  const result = await combinedSearch(cache, {
    query: 'Movie Episode',
    limit: 5,
    offset: 0,
    mode: 'ui',
  });

  assert.equal(result.results.length, 5);
  assert.ok(result.total >= 10);
  cache.close();
});

// =============================================================================
// searchReleases (backward compatibility) Tests
// =============================================================================

test('searchReleases: still works as before', async () => {
  const cache = createDiscoveryCache();
  setupCandidate(cache, HASH1, {
    filename: 'Breaking.Bad.S05E14.1080p.mkv',
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    resolution: '1080p',
  });

  const result = await searchReleases(cache, {
    query: 'Breaking Bad S05E14',
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].hash, HASH1);
  assert.ok(result.results[0].score >= 0);
  cache.close();
});
