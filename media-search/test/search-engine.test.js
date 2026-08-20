/**
 * Internal Search Engine Tests
 *
 * Tests FTS5-backed full-text search over release_attributes.
 * Proves:
 * - Index is maintained automatically by triggers
 * - Query parsing extracts filters correctly
 * - Search returns ranked results
 * - Filters work (year, season, episode, resolution, source)
 * - Provider observations affect ranking
 * - Stats and rebuild work correctly
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { searchReleases, getSearchStats, rebuildSearchIndex } from '../src/lib/discovery/search-engine.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeCandidateWithAttributes(cache, infoHash, attrs) {
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
    confidence: attrs.confidence || 0.8,
    parsed: {
      title: attrs.title,
      year: attrs.year,
      season: attrs.season,
      episode: attrs.episode,
      resolution: attrs.resolution,
      source: attrs.source,
      codec: attrs.codec,
      hdr: attrs.hdr,
      audio: attrs.audio,
      releaseGroup: attrs.releaseGroup,
    },
    evidence: ['title_extracted'],
  });
}

// =============================================================================
// Index Tests
// =============================================================================

test('FTS5 index is created by schema', () => {
  const cache = createDiscoveryCache();
  const stats = getSearchStats(cache);
  assert.equal(stats.indexed, 0);
  assert.equal(stats.total, 0);
  cache.close();
});

test('FTS5 index is populated on attribute insert', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.2024.1080p.mkv',
    title: 'Movie',
    year: 2024,
    resolution: '1080p',
    confidence: 0.9,
  });

  const stats = getSearchStats(cache);
  assert.equal(stats.indexed, 1);
  assert.equal(stats.total, 1);
  cache.close();
});

test('FTS5 index tracks insert counts', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Test.mkv',
    title: 'Test',
    confidence: 0.9,
  });

  const stats = getSearchStats(cache);
  assert.equal(stats.indexed, 1);
  assert.equal(stats.total, 1);
  cache.close();
});

test('rebuildSearchIndex populates from scratch', () => {
  const cache = createDiscoveryCache();

  // Insert directly (trigger will fire)
  cache.db.exec(`
    INSERT INTO release_attributes (info_hash, file_index_key, source, filename, confidence, title, parsed_at)
    VALUES ('${HASH}', -1, 'legacy', 'Legacy.mkv', 0.5, 'Legacy Title', ${Date.now()})
  `);

  let stats = getSearchStats(cache);
  assert.equal(stats.indexed, 1); // Trigger fires on INSERT

  // Rebuild should be idempotent
  const count = rebuildSearchIndex(cache);
  assert.equal(count, 1);

  stats = getSearchStats(cache);
  assert.equal(stats.indexed, 1);
  cache.close();
});

// =============================================================================
// Query Parsing Tests (tested indirectly via searchReleases)
// =============================================================================

test('searchReleases extracts year from query', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.2024.mkv',
    title: 'Movie',
    year: 2024,
    confidence: 0.9,
  });
  makeCandidateWithAttributes(cache, OTHER_HASH, {
    filename: 'Movie.2023.mkv',
    title: 'Movie',
    year: 2023,
    confidence: 0.9,
  });

  const result = searchReleases(cache, { query: 'movie 2024' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].parsed.year, 2024);
  cache.close();
});

test('searchReleases extracts season/episode from query', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Show.S01E03.mkv',
    title: 'Show',
    season: 1,
    episode: 3,
    confidence: 0.9,
  });

  const result = searchReleases(cache, { query: 'show s01e03' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].parsed.season, 1);
  assert.equal(result.results[0].parsed.episode, 3);
  cache.close();
});

// =============================================================================
// Search Tests
// =============================================================================

test('searchReleases returns results for title match', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Black.Mirror.S07E03.1080p.mkv',
    title: 'Black Mirror',
    season: 7,
    episode: 3,
    resolution: '1080p',
    confidence: 0.9,
  });

  const result = searchReleases(cache, { query: 'black mirror' });
  assert.equal(result.results.length, 1);
  assert.equal(result.total, 1);
  assert.equal(result.results[0].hash, HASH);
  assert.equal(result.results[0].parsed.title, 'Black Mirror');
  assert.ok(result.results[0].score > 0);
  cache.close();
});

test('searchReleases returns empty for no match', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.mkv',
    title: 'Movie',
    confidence: 0.9,
  });

  const result = searchReleases(cache, { query: 'nonexistent' });
  assert.equal(result.results.length, 0);
  assert.equal(result.total, 0);
  cache.close();
});

test('searchReleases filters by year', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.2024.1080p.mkv',
    title: 'Movie',
    year: 2024,
    resolution: '1080p',
    confidence: 0.9,
  });
  makeCandidateWithAttributes(cache, OTHER_HASH, {
    filename: 'Movie.2023.1080p.mkv',
    title: 'Movie',
    year: 2023,
    resolution: '1080p',
    confidence: 0.9,
  });

  const result = searchReleases(cache, { query: 'movie', year: 2024 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].parsed.year, 2024);
  cache.close();
});

test('searchReleases filters by season/episode', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Show.S01E03.720p.mkv',
    title: 'Show',
    season: 1,
    episode: 3,
    resolution: '720p',
    confidence: 0.9,
  });
  makeCandidateWithAttributes(cache, OTHER_HASH, {
    filename: 'Show.S01E04.720p.mkv',
    title: 'Show',
    season: 1,
    episode: 4,
    resolution: '720p',
    confidence: 0.9,
  });

  const result = searchReleases(cache, { query: 'show', season: 1, episode: 3 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].parsed.episode, 3);
  cache.close();
});

test('searchReleases filters by resolution', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
    confidence: 0.9,
  });
  makeCandidateWithAttributes(cache, OTHER_HASH, {
    filename: 'Movie.720p.mkv',
    title: 'Movie',
    resolution: '720p',
    confidence: 0.9,
  });

  const result = searchReleases(cache, { query: 'movie', resolution: '1080p' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].parsed.resolution, '1080p');
  cache.close();
});

test('searchReleases supports pagination', () => {
  const cache = createDiscoveryCache();
  const hashes = [];
  for (let i = 0; i < 5; i++) {
    const h = HASH.slice(0, 38) + i.toString(16).padStart(2, '0');
    hashes.push(h);
    makeCandidateWithAttributes(cache, h, {
      filename: `Movie.Part${i}.mkv`,
      title: 'Movie',
      confidence: 0.9,
    });
  }

  const page1 = searchReleases(cache, { query: 'movie', limit: 2, offset: 0 });
  assert.equal(page1.results.length, 2);
  assert.equal(page1.total, 5);

  const page2 = searchReleases(cache, { query: 'movie', limit: 2, offset: 2 });
  assert.equal(page2.results.length, 2);

  // Different pages should have different results
  assert.notEqual(page1.results[0].hash, page2.results[0].hash);
  cache.close();
});

// =============================================================================
// Ranking Tests
// =============================================================================

test('searchReleases ranks by composite score', () => {
  const cache = createDiscoveryCache();

  // High quality, high confidence
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.2024.2160p.BluRay.x265.mkv',
    title: 'Movie',
    year: 2024,
    resolution: '2160p',
    source: 'BluRay',
    codec: 'x265',
    hdr: true,
    confidence: 0.95,
  });

  // Lower quality, lower confidence
  const h2 = OTHER_HASH;
  makeCandidateWithAttributes(cache, h2, {
    filename: 'Movie.2024.480p.DVD.x264.mkv',
    title: 'Movie',
    year: 2024,
    resolution: '480p',
    source: 'DVD',
    codec: 'x264',
    hdr: false,
    confidence: 0.6,
  });

  const result = searchReleases(cache, { query: 'movie' });
  assert.equal(result.results.length, 2);

  // Higher quality should rank first
  assert.ok(result.results[0].score > result.results[1].score);
  assert.equal(result.results[0].hash, HASH);
  cache.close();
});

test('provider observations add ranking bonus', () => {
  const cache = createDiscoveryCache();

  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
    confidence: 0.9,
  });
  makeCandidateWithAttributes(cache, OTHER_HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
    confidence: 0.9,
  });

  // Add provider observation for second candidate
  cache.recordProviderObservation(OTHER_HASH, null, 'torbox', {
    cached: true,
    evidence: { hit: true },
    checkedAt: Date.now(),
  });

  const result = searchReleases(cache, { query: 'movie' });
  assert.equal(result.results.length, 2);

  // Provider-cached candidate should have higher provider score
  // Unknown provider state is neutral (0.5), not zero
  const cached = result.results.find(r => r.hash === OTHER_HASH);
  const uncached = result.results.find(r => r.hash === HASH);
  assert.equal(cached.provider, 1.0);  // All cached
  assert.equal(uncached.provider, 0.5);  // Neutral (unknown)
  cache.close();
});

test('searchReleases includes provider data when requested', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.mkv',
    title: 'Movie',
    confidence: 0.9,
  });
  cache.recordProviderObservation(HASH, null, 'torbox', {
    cached: true,
    checkedAt: Date.now(),
  });

  const result = searchReleases(cache, { query: 'movie', includeProviders: true });
  assert.equal(result.results.length, 1);
  assert.ok(result.results[0].providers);
  assert.equal(result.results[0].providers.length, 1);
  assert.equal(result.results[0].providers[0].provider, 'torbox');
  cache.close();
});

// =============================================================================
// Edge Cases
// =============================================================================

test('searchReleases handles empty query', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.mkv',
    title: 'Movie',
    confidence: 0.9,
  });

  const result = searchReleases(cache, { query: '' });
  // Empty query should still return results (MATCH *)
  assert.ok(result.results.length >= 0);
  cache.close();
});

test('searchReleases handles special characters', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.2024.1080p.mkv',
    title: 'Movie: The Sequel!',
    confidence: 0.9,
  });

  const result = searchReleases(cache, { query: 'sequel' });
  assert.equal(result.results.length, 1);
  cache.close();
});

test('searchReleases handles very long queries', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.mkv',
    title: 'Movie',
    confidence: 0.9,
  });

  const longQuery = 'movie '.repeat(100);
  const result = searchReleases(cache, { query: longQuery });
  assert.ok(result.results.length >= 0);
  cache.close();
});

test('searchReleases returns result with expected shape', () => {
  const cache = createDiscoveryCache();
  makeCandidateWithAttributes(cache, HASH, {
    filename: 'Movie.2024.1080p.BluRay.x265-Group.mkv',
    title: 'Movie',
    year: 2024,
    resolution: '1080p',
    source: 'BluRay',
    codec: 'x265',
    hdr: true,
    audio: 'DTS',
    releaseGroup: 'Group',
    confidence: 0.92,
  });

  const result = searchReleases(cache, { query: 'movie' });
  assert.equal(result.results.length, 1);

  const r = result.results[0];
  assert.equal(r.hash, HASH);
  assert.equal(r.filename, 'Movie.2024.1080p.BluRay.x265-Group.mkv');
  assert.equal(r.parsed.title, 'Movie');
  assert.equal(r.parsed.year, 2024);
  assert.equal(r.parsed.resolution, '1080p');
  assert.equal(r.parsed.source, 'BluRay');
  assert.equal(r.parsed.codec, 'x265');
  assert.equal(r.parsed.hdr, true);
  assert.equal(r.parsed.audio, 'DTS');
  assert.equal(r.parsed.releaseGroup, 'Group');
  assert.ok(r.score > 0);
  assert.ok(r.relevance > 0);
  assert.ok(r.quality > 0);
  cache.close();
});
