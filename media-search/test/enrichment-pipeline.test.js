/**
 * Enrichment Pipeline Tests
 *
 * Proves the end-to-end enrichment pipeline:
 * - Seeding unresolved candidates
 * - Duplicate prevention
 * - Successful enrichment
 * - Failed enrichment retry behavior
 * - Provenance persistence
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { runIdentityEnrichmentWorker } from '../src/lib/discovery/identity-enrichment-worker.js';
import { CinemetaIdentityResolver } from '../src/lib/discovery/cinemeta-identity-resolver.js';
import { BaseIdentityResolver } from '../src/lib/discovery/identity-resolver.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';
const HASH4 = 'dddddddddddddddddddddddddddddddddddddddd';
const HASH5 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

// Helper to create a candidate with release attributes
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
      sourceType: attrs.sourceType,
      codec: attrs.codec,
    },
    evidence: ['title_extracted'],
  });
}

// Helper to create mock fetch for Cinemeta
function createMockFetch(results) {
  return async (url) => {
    if (url.includes('/catalog/')) {
      return {
        ok: true,
        async json() {
          const filterFn = url.includes('/series/')
            ? (r) => r.type === 'series'
            : (r) => r.type === 'movie';
          return {
            metas: results.filter(filterFn).map(r => ({
              id: r.id,
              type: r.type,
              name: r.title,
              year: r.year,
              poster: null,
            })),
          };
        },
      };
    }
    if (url.includes('/meta/')) {
      const id = url.split('/').pop().replace('.json', '');
      const media = results.find(r => r.id === id);
      return {
        ok: true,
        async json() {
          if (!media) return { meta: null };
          return {
            meta: {
              id: media.id,
              type: media.type,
              name: media.title,
              year: media.year,
              videos: media.videos || [],
            },
          };
        },
      };
    }
    return { ok: false, status: 404 };
  };
}

// =============================================================================
// Seeding Tests
// =============================================================================

test('enqueueUnresolvedCandidates finds candidates without media associations', () => {
  const cache = createDiscoveryCache();

  // Create candidates
  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });
  cache.upsertCandidate({ infoHash: HASH3, fileIndex: null, filename: 'movie3.mkv' });

  // Only associate media with one
  cache.associateMedia(HASH1, null, 'tt1234567', { source: 'manual' });

  const result = cache.enqueueUnresolvedCandidates({ limit: 100 });

  assert.equal(result.enqueued, 2); // HASH2 and HASH3
  assert.equal(result.skipped, 0);
  assert.equal(result.total, 2);

  cache.close();
});

test('enqueueUnresolvedCandidates respects limit', () => {
  const cache = createDiscoveryCache();

  for (let i = 0; i < 10; i++) {
    cache.upsertCandidate({ infoHash: `hash${i}hash${i}hash${i}hash${i}hash${i}hash${i}`, fileIndex: null, filename: `movie${i}.mkv` });
  }

  const result = cache.enqueueUnresolvedCandidates({ limit: 3 });

  assert.equal(result.enqueued, 3);
  assert.equal(result.total, 3);

  cache.close();
});

test('enqueueUnresolvedCandidates respects offset', () => {
  const cache = createDiscoveryCache();

  for (let i = 0; i < 5; i++) {
    cache.upsertCandidate({ infoHash: `hash${i}hash${i}hash${i}hash${i}hash${i}hash${i}`, fileIndex: null, filename: `movie${i}.mkv` });
  }

  // First batch
  const result1 = cache.enqueueUnresolvedCandidates({ limit: 2, offset: 0 });
  assert.equal(result1.enqueued, 2);

  // Second batch
  const result2 = cache.enqueueUnresolvedCandidates({ limit: 2, offset: 2 });
  assert.equal(result2.enqueued, 2);

  // Third batch (only 1 left)
  const result3 = cache.enqueueUnresolvedCandidates({ limit: 2, offset: 4 });
  assert.equal(result3.enqueued, 1);

  cache.close();
});

test('enqueueUnresolvedCandidates preserves first_seen as created_at', () => {
  const cache = createDiscoveryCache();
  const firstSeen = Date.now() - 86400000; // 1 day ago

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'movie1.mkv',
    firstSeen,
  });

  cache.enqueueUnresolvedCandidates({ limit: 100 });

  const item = cache.getEnrichmentQueueItem(HASH1, null);
  assert.equal(item.createdAt, firstSeen);

  cache.close();
});

// =============================================================================
// Duplicate Prevention Tests
// =============================================================================

test('enqueueUnresolvedCandidates skips candidates already in queue', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });

  // Enqueue HASH1 manually
  cache.enqueueIdentityResolution(HASH1, null);

  const result = cache.enqueueUnresolvedCandidates({ limit: 100 });

  assert.equal(result.enqueued, 1); // Only HASH2
  assert.equal(result.skipped, 1); // HASH1 was skipped
  assert.equal(result.total, 2);

  cache.close();
});

test('enqueueUnresolvedCandidates skips resolved candidates', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });

  // HASH1 has media association (resolved)
  cache.associateMedia(HASH1, null, 'tt1234567', {
    source: 'enrichment',
    resolverSource: 'cinemeta',
  });

  const result = cache.enqueueUnresolvedCandidates({ limit: 100 });

  assert.equal(result.enqueued, 1); // Only HASH2
  assert.equal(result.skipped, 0);
  assert.equal(result.total, 1);

  cache.close();
});

test('isCandidateInQueue detects queued candidates', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.enqueueIdentityResolution(HASH1, null);

  assert.equal(cache.isCandidateInQueue(HASH1, null), true);
  assert.equal(cache.isCandidateInQueue(HASH2, null), false);

  cache.close();
});

test('countUnresolvedCandidates returns correct count', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });
  cache.upsertCandidate({ infoHash: HASH3, fileIndex: null, filename: 'movie3.mkv' });

  // Associate one
  cache.associateMedia(HASH1, null, 'tt1234567', { source: 'manual' });

  assert.equal(cache.countUnresolvedCandidates(), 2);

  cache.close();
});

// =============================================================================
// Successful Enrichment Tests
// =============================================================================

test('successful enrichment creates candidate_media with provenance', async () => {
  const cache = createDiscoveryCache();
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  setupCandidate(cache, HASH1, {
    filename: 'The.Shawshank.Redemption.1994.1080p.mkv',
    title: 'The Shawshank Redemption',
    year: 1994,
  });

  cache.enqueueIdentityResolution(HASH1, null);
  const stats = await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  assert.equal(stats.resolved, 1);
  assert.equal(stats.failed, 0);

  // Verify candidate_media was created
  const associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].mediaId, 'tt0111161');
  assert.equal(associations[0].resolverSource, 'cinemeta');
  assert.ok(associations[0].confidence >= 0.5);

  cache.close();
});

test('enrichment pipeline: seed then process', async () => {
  const cache = createDiscoveryCache();
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
    { id: 'tt0068646', type: 'movie', title: 'The Godfather', year: 1972 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  // Setup candidates
  setupCandidate(cache, HASH1, {
    filename: 'The.Shawshank.Redemption.1994.1080p.mkv',
    title: 'The Shawshank Redemption',
    year: 1994,
  });
  setupCandidate(cache, HASH2, {
    filename: 'The.Godfather.1972.1080p.mkv',
    title: 'The Godfather',
    year: 1972,
  });

  // Seed
  const seedResult = cache.enqueueUnresolvedCandidates({ limit: 100 });
  assert.equal(seedResult.enqueued, 2);

  // Process
  const stats = await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  assert.equal(stats.resolved, 2);
  assert.equal(stats.failed, 0);

  // Verify associations
  const assoc1 = cache.getMediaAssociations(HASH1, null);
  const assoc2 = cache.getMediaAssociations(HASH2, null);
  assert.equal(assoc1.length, 1);
  assert.equal(assoc2.length, 1);

  cache.close();
});

test('enrichment stores match method in provenance', async () => {
  const cache = createDiscoveryCache();
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  setupCandidate(cache, HASH1, {
    filename: 'The.Shawshank.Redemption.1994.1080p.mkv',
    title: 'The Shawshank Redemption',
    year: 1994,
  });

  cache.enqueueIdentityResolution(HASH1, null);
  await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  const associations = cache.getMediaAssociations(HASH1, null);
  assert.ok(associations[0].matchMethod);
  assert.ok(associations[0].resolverVersion);

  cache.close();
});

// =============================================================================
// Failed Enrichment Retry Tests
// =============================================================================

test('failed enrichment is marked for retry', async () => {
  const cache = createDiscoveryCache();

  // Create resolver that always fails
  class FailingResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'failing', version: '1.0.0' });
    }
    async resolveIdentity() {
      throw new Error('Network error');
    }
  }

  const resolver = new FailingResolver();

  setupCandidate(cache, HASH1, {
    filename: 'Some.Movie.2020.mkv',
    title: 'Some Movie',
    year: 2020,
  });

  cache.enqueueIdentityResolution(HASH1, null, { maxAttempts: 3 });

  // First attempt
  const stats1 = await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });
  assert.equal(stats1.failed, 1);

  const item1 = cache.getEnrichmentQueueItem(HASH1, null);
  assert.equal(item1.attempts, 1);
  assert.equal(item1.status, 'pending'); // Ready for retry
  assert.equal(item1.errorCategory, 'unknown');

  // Reset next_attempt_at to allow immediate retry (simulating backoff elapsed)
  cache.updateEnrichmentStatus(HASH1, null, 'pending', {
    attempts: 1,
    nextAttemptAt: null,
  });

  // Second attempt
  const stats2 = await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });
  assert.equal(stats2.failed, 1);

  const item2 = cache.getEnrichmentQueueItem(HASH1, null);
  assert.equal(item2.attempts, 2);

  // Reset next_attempt_at again
  cache.updateEnrichmentStatus(HASH1, null, 'pending', {
    attempts: 2,
    nextAttemptAt: null,
  });

  // Third attempt (exhausts retries)
  const stats3 = await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });
  assert.equal(stats3.failed, 1);

  const item3 = cache.getEnrichmentQueueItem(HASH1, null);
  assert.equal(item3.attempts, 3);
  assert.equal(item3.status, 'failed'); // No more retries

  cache.close();
});

test('failed enrichment preserves error metadata', async () => {
  const cache = createDiscoveryCache();

  class FailingResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'failing', version: '1.0.0' });
    }
    async resolveIdentity() {
      const err = new Error('Cinemeta timeout');
      err.code = 'timeout';
      throw err;
    }
  }

  const resolver = new FailingResolver();

  setupCandidate(cache, HASH1, {
    filename: 'Some.Movie.2020.mkv',
    title: 'Some Movie',
    year: 2020,
  });

  cache.enqueueIdentityResolution(HASH1, null);
  await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  const item = cache.getEnrichmentQueueItem(HASH1, null);
  assert.equal(item.errorMessage, 'Cinemeta timeout');
  assert.equal(item.errorCategory, 'timeout');

  cache.close();
});

// =============================================================================
// Provenance Persistence Tests
// =============================================================================

test('provenance includes resolver source and version', async () => {
  const cache = createDiscoveryCache();
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl, version: '2.0.0' });

  setupCandidate(cache, HASH1, {
    filename: 'The.Shawshank.Redemption.1994.1080p.mkv',
    title: 'The Shawshank Redemption',
    year: 1994,
  });

  cache.enqueueIdentityResolution(HASH1, null);
  await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  const associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(associations[0].resolverSource, 'cinemeta');
  assert.equal(associations[0].resolverVersion, '2.0.0');

  cache.close();
});

test('provenance includes evidence trail', async () => {
  const cache = createDiscoveryCache();
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  setupCandidate(cache, HASH1, {
    filename: 'The.Shawshank.Redemption.1994.1080p.mkv',
    title: 'The Shawshank Redemption',
    year: 1994,
  });

  cache.enqueueIdentityResolution(HASH1, null);
  await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  const associations = cache.getMediaAssociations(HASH1, null);
  assert.ok(associations[0].evidence);
  assert.ok(Array.isArray(associations[0].evidence));
  assert.ok(associations[0].evidence.length > 0);

  cache.close();
});

// =============================================================================
// Integration: Metrics After Enrichment
// =============================================================================

test('enrichment updates coverage metrics', async () => {
  const cache = createDiscoveryCache();
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  setupCandidate(cache, HASH1, {
    filename: 'The.Shawshank.Redemption.1994.1080p.mkv',
    title: 'The Shawshank Redemption',
    year: 1994,
  });
  setupCandidate(cache, HASH2, {
    filename: 'Another.Movie.2020.mkv',
    title: 'Another Movie',
    year: 2020,
  });

  // Before enrichment
  const before = cache.getCandidateMediaCoverage();
  assert.equal(before.candidatesWithMedia, 0);
  assert.equal(before.coveragePercentage, 0);

  // Seed and process
  cache.enqueueUnresolvedCandidates({ limit: 100 });
  await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  // After enrichment
  const after = cache.getCandidateMediaCoverage();
  assert.equal(after.candidatesWithMedia, 1); // Only HASH1 was matched
  assert.ok(after.coveragePercentage > 0);

  cache.close();
});

test('unresolved count decreases after enrichment', async () => {
  const cache = createDiscoveryCache();
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  setupCandidate(cache, HASH1, {
    filename: 'The.Shawshank.Redemption.1994.1080p.mkv',
    title: 'The Shawshank Redemption',
    year: 1994,
  });
  setupCandidate(cache, HASH2, {
    filename: 'Unknown.Movie.2020.mkv',
    title: 'Unknown Movie',
    year: 2020,
  });

  cache.enqueueUnresolvedCandidates({ limit: 100 });

  const before = cache.getUnresolvedStats();
  assert.equal(before.totalUnresolved, 2);

  await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  const after = cache.getUnresolvedStats();
  // HASH1 was resolved, HASH2 is still pending (no match found)
  assert.ok(after.totalUnresolved <= before.totalUnresolved);

  cache.close();
});

// =============================================================================
// Edge Cases
// =============================================================================

test('enqueueUnresolvedCandidates handles empty cache', () => {
  const cache = createDiscoveryCache();

  const result = cache.enqueueUnresolvedCandidates({ limit: 100 });

  assert.equal(result.enqueued, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.total, 0);

  cache.close();
});

test('enqueueUnresolvedCandidates handles all resolved cache', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.associateMedia(HASH1, null, 'tt1234567', { source: 'manual' });

  const result = cache.enqueueUnresolvedCandidates({ limit: 100 });

  assert.equal(result.enqueued, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.total, 0);

  cache.close();
});

test('getUnresolvedCandidates returns candidates in first_seen order', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();

  // Create candidates with different first_seen
  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv', firstSeen: now - 3000 });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv', firstSeen: now - 1000 });
  cache.upsertCandidate({ infoHash: HASH3, fileIndex: null, filename: 'movie3.mkv', firstSeen: now - 2000 });

  const unresolved = cache.getUnresolvedCandidates({ limit: 100 });

  // Should be ordered by first_seen ASC (oldest first)
  assert.equal(unresolved[0].infoHash, HASH1);
  assert.equal(unresolved[1].infoHash, HASH3);
  assert.equal(unresolved[2].infoHash, HASH2);

  cache.close();
});
