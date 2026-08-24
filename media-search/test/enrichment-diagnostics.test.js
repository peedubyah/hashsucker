/**
 * Enrichment Diagnostics Tests
 *
 * Proves the corpus observability metrics:
 *   candidate_media coverage, resolver success rates, confidence distribution,
 *   unresolved counts, match method distribution.
 *
 * Tests:
 * - Empty cache returns zeroed metrics
 * - Coverage metrics reflect candidate_media associations
 * - Resolver success rates grouped by source
 * - Confidence distribution buckets are correct
 * - Unresolved counts exclude completed items
 * - Match method distribution reflects provenance
 * - Diagnostics snapshot aggregates all metrics
 * - Text formatter produces readable output
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import {
  getEnrichmentDiagnostics,
  formatEnrichmentDiagnostics,
} from '../src/lib/discovery/enrichment-diagnostics.js';
import {
  BaseIdentityResolver,
} from '../src/lib/discovery/identity-resolver.js';
import {
  runIdentityEnrichmentWorker,
} from '../src/lib/discovery/identity-enrichment-worker.js';

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

// =============================================================================
// Empty Cache Tests
// =============================================================================

test('empty cache returns zeroed metrics', () => {
  const cache = createDiscoveryCache();

  const diagnostics = getEnrichmentDiagnostics(cache);

  assert.equal(diagnostics.queue.total, 0);
  assert.equal(diagnostics.queue.pending, 0);
  assert.equal(diagnostics.queue.resolved, 0);
  assert.equal(diagnostics.queue.failed, 0);
  assert.equal(diagnostics.coverage.totalCandidates, 0);
  assert.equal(diagnostics.coverage.candidatesWithMedia, 0);
  assert.equal(diagnostics.coverage.coveragePercentage, 0);
  assert.equal(diagnostics.resolverPerformance.overallSuccessRate, 0);
  assert.equal(diagnostics.confidence.average, 0);
  assert.deepEqual(diagnostics.confidence.distribution, {
    very_high: 0,
    high: 0,
    medium: 0,
    low: 0,
    very_low: 0,
  });

  cache.close();
});

// =============================================================================
// Coverage Metrics Tests
// =============================================================================

test('coverage metrics reflect candidate_media associations', () => {
  const cache = createDiscoveryCache();

  // Create 3 candidates
  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });
  cache.upsertCandidate({ infoHash: HASH3, fileIndex: null, filename: 'movie3.mkv' });

  // Associate media with 2 of them
  cache.associateMedia(HASH1, null, 'tt1234567', {
    source: 'enrichment',
    confidence: 0.95,
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
  });
  cache.associateMedia(HASH2, null, 'tt2345678', {
    source: 'enrichment',
    confidence: 0.75,
    resolverSource: 'cinemeta',
    matchMethod: 'title_year_match',
  });

  const coverage = cache.getCandidateMediaCoverage();
  assert.equal(coverage.totalCandidates, 3);
  assert.equal(coverage.candidatesWithMedia, 2);
  assert.equal(coverage.candidatesWithResolvedMedia, 2);
  assert.ok(Math.abs(coverage.coveragePercentage - 2 / 3) < 0.001);
  assert.ok(Math.abs(coverage.resolvedPercentage - 2 / 3) < 0.001);

  cache.close();
});

test('coverage counts candidates with non-resolved media separately', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });

  // One with resolver_source (resolved), one without (manual/search)
  cache.associateMedia(HASH1, null, 'tt1234567', {
    source: 'enrichment',
    confidence: 0.95,
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
  });
  cache.associateMedia(HASH2, null, 'tt2345678', {
    source: 'search',
    confidence: 1.0,
    // No resolver_source — not from enrichment
  });

  const coverage = cache.getCandidateMediaCoverage();
  assert.equal(coverage.totalCandidates, 2);
  assert.equal(coverage.candidatesWithMedia, 2);
  assert.equal(coverage.candidatesWithResolvedMedia, 1);
  assert.ok(Math.abs(coverage.coveragePercentage - 1.0) < 0.001);
  assert.ok(Math.abs(coverage.resolvedPercentage - 0.5) < 0.001);

  cache.close();
});

// =============================================================================
// Resolver Success Rate Tests
// =============================================================================

test('resolver success rates grouped by source', () => {
  const cache = createDiscoveryCache();

  // Create candidates and enqueue them
  setupCandidate(cache, HASH1, { filename: 'movie1.mkv', title: 'Movie 1' });
  setupCandidate(cache, HASH2, { filename: 'movie2.mkv', title: 'Movie 2' });
  setupCandidate(cache, HASH3, { filename: 'movie3.mkv', title: 'Movie 3' });

  cache.enqueueIdentityResolution(HASH1, null, { resolverSource: 'cinemeta' });
  cache.enqueueIdentityResolution(HASH2, null, { resolverSource: 'cinemeta' });
  cache.enqueueIdentityResolution(HASH3, null, { resolverSource: 'tmdb' });

  // Resolve two (one cinemeta, one tmdb), fail one (cinemeta)
  cache.updateEnrichmentStatus(HASH1, null, 'resolved', { resolverSource: 'cinemeta' });
  cache.updateEnrichmentStatus(HASH2, null, 'failed', { resolverSource: 'cinemeta' });
  cache.updateEnrichmentStatus(HASH3, null, 'resolved', { resolverSource: 'tmdb' });

  const rates = cache.getResolverSuccessRates();
  const cinemeta = rates.find(r => r.resolverSource === 'cinemeta');
  const tmdb = rates.find(r => r.resolverSource === 'tmdb');

  assert.equal(cinemeta.totalAttempts, 2);
  assert.equal(cinemeta.resolved, 1);
  assert.equal(cinemeta.failed, 1);
  assert.ok(Math.abs(cinemeta.successRate - 0.5) < 0.001);

  assert.equal(tmdb.totalAttempts, 1);
  assert.equal(tmdb.resolved, 1);
  assert.equal(tmdb.failed, 0);
  assert.ok(Math.abs(tmdb.successRate - 1.0) < 0.001);

  cache.close();
});

// =============================================================================
// Confidence Distribution Tests
// =============================================================================

test('confidence distribution buckets are correct', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });
  cache.upsertCandidate({ infoHash: HASH3, fileIndex: null, filename: 'movie3.mkv' });
  cache.upsertCandidate({ infoHash: HASH4, fileIndex: null, filename: 'movie4.mkv' });
  cache.upsertCandidate({ infoHash: HASH5, fileIndex: null, filename: 'movie5.mkv' });

  // Create associations with different confidence levels
  cache.associateMedia(HASH1, null, 'tt1111111', { source: 'enrichment', confidence: 0.95, resolverSource: 'cinemeta' }); // very_high
  cache.associateMedia(HASH2, null, 'tt2222222', { source: 'enrichment', confidence: 0.85, resolverSource: 'cinemeta' }); // high
  cache.associateMedia(HASH3, null, 'tt3333333', { source: 'enrichment', confidence: 0.6, resolverSource: 'cinemeta' }); // medium
  cache.associateMedia(HASH4, null, 'tt4444444', { source: 'enrichment', confidence: 0.4, resolverSource: 'cinemeta' }); // low
  cache.associateMedia(HASH5, null, 'tt5555555', { source: 'enrichment', confidence: 0.2, resolverSource: 'cinemeta' }); // very_low

  const dist = cache.getConfidenceDistribution();
  assert.equal(dist.very_high, 1);
  assert.equal(dist.high, 1);
  assert.equal(dist.medium, 1);
  assert.equal(dist.low, 1);
  assert.equal(dist.very_low, 1);

  cache.close();
});

test('confidence distribution only counts resolved media', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });

  // One with resolver_source (counts), one without (doesn't count)
  cache.associateMedia(HASH1, null, 'tt1111111', { source: 'enrichment', confidence: 0.95, resolverSource: 'cinemeta' });
  cache.associateMedia(HASH2, null, 'tt2222222', { source: 'search', confidence: 0.5 }); // No resolver_source

  const dist = cache.getConfidenceDistribution();
  assert.equal(dist.very_high, 1);
  assert.equal(dist.high, 0);
  assert.equal(dist.medium, 0);
  assert.equal(dist.low, 0);
  assert.equal(dist.very_low, 0);

  cache.close();
});

// =============================================================================
// Unresolved Stats Tests
// =============================================================================

test('unresolved counts exclude completed items', () => {
  const cache = createDiscoveryCache();

  setupCandidate(cache, HASH1, { filename: 'movie1.mkv', title: 'Movie 1' });
  setupCandidate(cache, HASH2, { filename: 'movie2.mkv', title: 'Movie 2' });
  setupCandidate(cache, HASH3, { filename: 'movie3.mkv', title: 'Movie 3' });

  cache.enqueueIdentityResolution(HASH1, null);
  cache.enqueueIdentityResolution(HASH2, null);
  cache.enqueueIdentityResolution(HASH3, null);

  // Resolve one, fail one (exhausting retries), leave one pending
  cache.updateEnrichmentStatus(HASH1, null, 'resolved');
  cache.updateEnrichmentStatus(HASH2, null, 'failed', { attempts: 3 }); // Exhausted
  // HASH3 stays pending

  const unresolved = cache.getUnresolvedStats();
  assert.equal(unresolved.totalUnresolved, 1); // Only HASH3 (pending, not exhausted)

  cache.close();
});

// =============================================================================
// Match Method Distribution Tests
// =============================================================================

test('match method distribution reflects provenance', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });
  cache.upsertCandidate({ infoHash: HASH3, fileIndex: null, filename: 'movie3.mkv' });

  cache.associateMedia(HASH1, null, 'tt1111111', {
    source: 'enrichment',
    confidence: 0.95,
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
  });
  cache.associateMedia(HASH2, null, 'tt2222222', {
    source: 'enrichment',
    confidence: 0.85,
    resolverSource: 'cinemeta',
    matchMethod: 'title_year_match',
  });
  cache.associateMedia(HASH3, null, 'tt3333333', {
    source: 'enrichment',
    confidence: 0.75,
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
  });

  const methods = cache.getMatchMethodDistribution();
  const exactMatch = methods.find(m => m.matchMethod === 'title_exact_match');
  const yearMatch = methods.find(m => m.matchMethod === 'title_year_match');

  assert.equal(exactMatch.count, 2);
  assert.equal(yearMatch.count, 1);

  cache.close();
});

// =============================================================================
// Diagnostics Snapshot Tests
// =============================================================================

test('diagnostics snapshot aggregates all metrics', () => {
  const cache = createDiscoveryCache();

  setupCandidate(cache, HASH1, { filename: 'movie1.mkv', title: 'Movie 1' });
  setupCandidate(cache, HASH2, { filename: 'movie2.mkv', title: 'Movie 2' });

  cache.enqueueIdentityResolution(HASH1, null, { resolverSource: 'cinemeta' });
  cache.enqueueIdentityResolution(HASH2, null, { resolverSource: 'cinemeta' });

  cache.updateEnrichmentStatus(HASH1, null, 'resolved', { resolverSource: 'cinemeta' });
  cache.updateEnrichmentStatus(HASH2, null, 'failed', { resolverSource: 'cinemeta' });

  cache.associateMedia(HASH1, null, 'tt1111111', {
    source: 'enrichment',
    confidence: 0.95,
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
  });

  const diagnostics = getEnrichmentDiagnostics(cache);

  // Verify structure
  assert.ok(diagnostics.timestamp);
  assert.ok(diagnostics.queue);
  assert.ok(diagnostics.coverage);
  assert.ok(diagnostics.resolverPerformance);
  assert.ok(diagnostics.confidence);
  assert.ok(diagnostics.matchMethods);

  // Verify queue stats
  assert.equal(diagnostics.queue.total, 2);
  assert.equal(diagnostics.queue.resolved, 1);
  assert.equal(diagnostics.queue.failed, 1);

  // Verify coverage
  assert.equal(diagnostics.coverage.totalCandidates, 2);
  assert.equal(diagnostics.coverage.candidatesWithMedia, 1);

  // Verify resolver performance
  assert.ok(Math.abs(diagnostics.resolverPerformance.overallSuccessRate - 0.5) < 0.001);

  // Verify confidence
  assert.equal(diagnostics.confidence.distribution.very_high, 1);
  assert.ok(diagnostics.confidence.average > 0);

  cache.close();
});

// =============================================================================
// Text Formatter Tests
// =============================================================================

test('text formatter produces readable output', () => {
  const cache = createDiscoveryCache();

  setupCandidate(cache, HASH1, { filename: 'movie1.mkv', title: 'Movie 1' });
  cache.enqueueIdentityResolution(HASH1, null, { resolverSource: 'cinemeta' });
  cache.updateEnrichmentStatus(HASH1, null, 'resolved', { resolverSource: 'cinemeta' });
  cache.associateMedia(HASH1, null, 'tt1111111', {
    source: 'enrichment',
    confidence: 0.95,
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
  });

  const diagnostics = getEnrichmentDiagnostics(cache);
  const text = formatEnrichmentDiagnostics(diagnostics);

  assert.ok(text.includes('Identity Enrichment Diagnostics'));
  assert.ok(text.includes('Queue Summary'));
  assert.ok(text.includes('Candidate Coverage'));
  assert.ok(text.includes('Resolver Performance'));
  assert.ok(text.includes('Confidence Distribution'));
  assert.ok(text.includes('Match Methods'));
  assert.ok(text.includes('cinemeta'));

  cache.close();
});

test('text formatter handles empty cache', () => {
  const cache = createDiscoveryCache();

  const diagnostics = getEnrichmentDiagnostics(cache);
  const text = formatEnrichmentDiagnostics(diagnostics);

  assert.ok(text.includes('Identity Enrichment Diagnostics'));
  assert.ok(text.includes('Total:      0'));
  assert.ok(text.includes('(none)')); // Match methods

  cache.close();
});

// =============================================================================
// Integration: Worker + Diagnostics
// =============================================================================

test('diagnostics reflect worker processing results', async () => {
  const cache = createDiscoveryCache();

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
  setupCandidate(cache, HASH2, {
    filename: 'Some.Other.Show.S01E01.720p.WEB-DL.mkv',
    title: 'Some Other Show',
    year: 2020,
    season: 1,
    episode: 1,
    resolution: '720p',
    sourceType: 'WEB-DL',
    codec: 'x264',
  });

  cache.enqueueIdentityResolution(HASH1, null);
  cache.enqueueIdentityResolution(HASH2, null);

  // Create resolver that only resolves one
  class TestResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'test-resolver', version: '1.0.0' });
    }
    async resolveIdentity({ candidate }) {
      if (candidate.filename.includes('Breaking')) {
        return {
          matches: [{
            mediaId: 'tt0903747',
            mediaType: 'series',
            confidence: 0.95,
            evidence: ['title_exact_match'],
          }],
        };
      }
      return { matches: [] };
    }
  }

  const resolver = new TestResolver();
  const stats = await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  assert.equal(stats.resolved, 2); // Both resolved (one with match, one without)

  const diagnostics = getEnrichmentDiagnostics(cache);
  assert.equal(diagnostics.queue.resolved, 2);
  assert.equal(diagnostics.coverage.candidatesWithMedia, 1); // Only HASH1 has media
  assert.equal(diagnostics.confidence.distribution.very_high, 1);

  cache.close();
});

// =============================================================================
// Error Handling Tests
// =============================================================================

test('getEnrichmentDiagnostics throws without cache', () => {
  assert.throws(() => getEnrichmentDiagnostics(null), {
    message: /requires a cache/,
  });
});

test('average confidence is weighted correctly', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({ infoHash: HASH1, fileIndex: null, filename: 'movie1.mkv' });
  cache.upsertCandidate({ infoHash: HASH2, fileIndex: null, filename: 'movie2.mkv' });

  // One very_high (0.95), one low (0.4)
  cache.associateMedia(HASH1, null, 'tt1111111', { source: 'enrichment', confidence: 0.95, resolverSource: 'cinemeta' });
  cache.associateMedia(HASH2, null, 'tt2222222', { source: 'enrichment', confidence: 0.4, resolverSource: 'cinemeta' });

  const diagnostics = getEnrichmentDiagnostics(cache);
  // Average should be (0.95 + 0.4) / 2 = 0.675
  assert.ok(Math.abs(diagnostics.confidence.average - 0.675) < 0.01);

  cache.close();
});
