/**
 * Identity Enrichment Worker Tests
 *
 * Proves the worker pipeline:
 *   queue → worker → resolver → candidate_media → queue status
 *
 * Tests:
 * - Successful enrichment creates candidate_media association
 * - Failed enrichment updates queue with error
 * - Worker respects limit
 * - Worker creates queue entries for processing
 * - Resolver errors are isolated per-candidate
 * - Provenance is stored in candidate_media
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import {
  runIdentityEnrichmentWorker,
  createIdentityEnrichmentWorker,
} from '../src/lib/discovery/identity-enrichment-worker.js';
import {
  BaseIdentityResolver,
  NoopIdentityResolver,
} from '../src/lib/discovery/identity-resolver.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

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

// =============================================================================
// Worker Success Tests
// =============================================================================

test('successful enrichment creates candidate_media association', async () => {
  const cache = createDiscoveryCache();

  // Setup candidate with attributes
  setupCandidate(cache, HASH1, {
    filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv',
    title: 'Breaking Bad',
    year: 2013,
    season: 5,
    episode: 14,
    resolution: '1080p',
    sourceType: 'BluRay',
    codec: 'x264',
  });

  // Enqueue for enrichment
  cache.enqueueIdentityResolution(HASH1, null);

  // Create resolver that returns a match
  class TestResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'test-resolver', version: '1.0.0' });
    }
    async resolveIdentity() {
      return {
        matches: [
          {
            mediaId: 'tt0903747',
            mediaType: 'series',
            confidence: 0.95,
            evidence: ['title_exact_match', 'year_match'],
          },
        ],
      };
    }
  }

  // Run worker
  const stats = await runIdentityEnrichmentWorker(cache, {
    resolver: new TestResolver(),
    limit: 10,
  });

  // Verify stats
  assert.equal(stats.total, 1);
  assert.equal(stats.processed, 1);
  assert.equal(stats.resolved, 1);
  assert.equal(stats.failed, 0);

  // Verify candidate_media was created
  const associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].mediaId, 'tt0903747');
  assert.equal(associations[0].confidence, 0.95);

  // Verify queue status was updated to resolved
  const item = cache.getEnrichmentQueueItem(HASH1, null);
  assert.equal(item.status, 'resolved');
  assert.equal(item.attempts, 1);
  assert.equal(item.resolverSource, 'test-resolver');

  cache.close();
});

test('worker respects limit parameter', async () => {
  const cache = createDiscoveryCache();

  // Setup multiple candidates
  for (const hash of [HASH1, HASH2, HASH3]) {
    setupCandidate(cache, hash, {
      filename: `Movie.S01E01.1080p.BluRay.x264-${hash.slice(0, 4)}.mkv`,
      title: 'Test Movie',
      year: 2020,
    });
    cache.enqueueIdentityResolution(hash, null);
  }

  // Create resolver
  class TestResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'test-resolver' });
    }
    async resolveIdentity() {
      return {
        matches: [{ mediaId: 'tt1234567', mediaType: 'movie', confidence: 0.8, evidence: [] }],
      };
    }
  }

  // Run with limit of 2
  const stats = await runIdentityEnrichmentWorker(cache, {
    resolver: new TestResolver(),
    limit: 2,
  });

  assert.equal(stats.total, 2);
  assert.equal(stats.processed, 2);

  cache.close();
});

// =============================================================================
// Worker Failure Tests
// =============================================================================

test('failed enrichment updates queue with error', async () => {
  const cache = createDiscoveryCache();

  setupCandidate(cache, HASH1, {
    filename: 'Unknown.Movie.2020.1080p.BluRay.x264-TEST.mkv',
    title: 'Unknown Movie',
    year: 2020,
  });
  cache.enqueueIdentityResolution(HASH1, null);

  // Create resolver that throws
  class FailingResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'failing-resolver' });
    }
    async resolveIdentity() {
      throw new Error('API timeout');
    }
  }

  const stats = await runIdentityEnrichmentWorker(cache, {
    resolver: new FailingResolver(),
    limit: 10,
  });

  assert.equal(stats.total, 1);
  assert.equal(stats.processed, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.resolved, 0);

  // Verify queue status
  const item = cache.getEnrichmentQueueItem(HASH1, null);
  assert.equal(item.attempts, 1);
  assert.equal(item.errorMessage, 'API timeout');
  assert.equal(item.errorCategory, 'unknown');

  // Should be pending (retryable) since attempts < maxAttempts
  assert.equal(item.status, 'pending');
  assert.ok(item.nextAttemptAt > Date.now());

  cache.close();
});

test('resolver errors are isolated per-candidate', async () => {
  const cache = createDiscoveryCache();

  setupCandidate(cache, HASH1, {
    filename: 'Movie1.2020.1080p.mkv',
    title: 'Movie 1',
    year: 2020,
  });
  setupCandidate(cache, HASH2, {
    filename: 'Movie2.2020.1080p.mkv',
    title: 'Movie 2',
    year: 2020,
  });

  cache.enqueueIdentityResolution(HASH1, null);
  cache.enqueueIdentityResolution(HASH2, null);

  // Create resolver that fails for first, succeeds for second
  class SelectiveResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'selective-resolver' });
      this.callCount = 0;
    }
    async resolveIdentity({ candidate }) {
      this.callCount++;
      if (candidate.infoHash === HASH1) {
        throw new Error('Failed for HASH1');
      }
      return {
        matches: [{ mediaId: 'tt9999999', mediaType: 'movie', confidence: 0.7, evidence: [] }],
      };
    }
  }

  const resolver = new SelectiveResolver();
  const stats = await runIdentityEnrichmentWorker(cache, {
    resolver,
    limit: 10,
  });

  assert.equal(stats.processed, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.resolved, 1);

  // HASH2 should have association
  const associations = cache.getMediaAssociations(HASH2, null);
  assert.equal(associations.length, 1);

  // HASH1 should not have association
  const hash1Associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(hash1Associations.length, 0);

  cache.close();
});

// =============================================================================
// Provenance Tests
// =============================================================================

test('successful enrichment stores provenance in candidate_media', async () => {
  const cache = createDiscoveryCache();

  setupCandidate(cache, HASH1, {
    filename: 'The.Matrix.1999.1080p.BluRay.x264-TEST.mkv',
    title: 'The Matrix',
    year: 1999,
    resolution: '1080p',
    sourceType: 'BluRay',
    codec: 'x264',
  });
  cache.enqueueIdentityResolution(HASH1, null);

  class TestResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'cinemeta', version: '3.0.0' });
    }
    async resolveIdentity() {
      return {
        matches: [
          {
            mediaId: 'tt0133093',
            mediaType: 'movie',
            confidence: 0.98,
            evidence: ['title_exact_match', 'year_match'],
          },
        ],
      };
    }
  }

  await runIdentityEnrichmentWorker(cache, {
    resolver: new TestResolver(),
    limit: 10,
  });

  const associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(associations.length, 1);

  const assoc = associations[0];
  assert.equal(assoc.resolverSource, 'cinemeta');
  assert.equal(assoc.resolverVersion, '3.0.0');
  assert.equal(assoc.source, 'enrichment');

  cache.close();
});

// =============================================================================
// Noop Resolver Tests
// =============================================================================

test('noop resolver marks items as resolved with no associations', async () => {
  const cache = createDiscoveryCache();

  setupCandidate(cache, HASH1, {
    filename: 'Movie.2020.1080p.mkv',
    title: 'Movie',
    year: 2020,
  });
  cache.enqueueIdentityResolution(HASH1, null);

  const stats = await runIdentityEnrichmentWorker(cache, {
    resolver: new NoopIdentityResolver(),
    limit: 10,
  });

  assert.equal(stats.resolved, 1);

  // No associations created
  const associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(associations.length, 0);

  // But queue item is marked resolved
  const item = cache.getEnrichmentQueueItem(HASH1, null);
  assert.equal(item.status, 'resolved');

  cache.close();
});

// =============================================================================
// Factory Function Tests
// =============================================================================

test('createIdentityEnrichmentWorker returns reusable worker function', async () => {
  const cache = createDiscoveryCache();

  setupCandidate(cache, HASH1, {
    filename: 'Movie.2020.1080p.mkv',
    title: 'Movie',
    year: 2020,
  });
  cache.enqueueIdentityResolution(HASH1, null);

  class TestResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'test-resolver' });
    }
    async resolveIdentity() {
      return {
        matches: [{ mediaId: 'tt1234567', mediaType: 'movie', confidence: 0.8, evidence: [] }],
      };
    }
  }

  const worker = createIdentityEnrichmentWorker({
    resolver: new TestResolver(),
  });

  const stats = await worker(cache, 10);

  assert.equal(stats.resolved, 1);

  cache.close();
});

// =============================================================================
// Progress Callback Tests
// =============================================================================

test('worker calls onProgress callback', async () => {
  const cache = createDiscoveryCache();

  setupCandidate(cache, HASH1, {
    filename: 'Movie.2020.1080p.mkv',
    title: 'Movie',
    year: 2020,
  });
  cache.enqueueIdentityResolution(HASH1, null);

  class TestResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'test-resolver' });
    }
    async resolveIdentity() {
      return {
        matches: [{ mediaId: 'tt1234567', mediaType: 'movie', confidence: 0.8, evidence: [] }],
      };
    }
  }

  const progressCalls = [];
  await runIdentityEnrichmentWorker(cache, {
    resolver: new TestResolver(),
    limit: 10,
    onProgress: (item, result) => {
      progressCalls.push({ item, result });
    },
  });

  assert.equal(progressCalls.length, 1);
  assert.equal(progressCalls[0].item.infoHash, HASH1);
  assert.equal(progressCalls[0].result.matches.length, 1);

  cache.close();
});
