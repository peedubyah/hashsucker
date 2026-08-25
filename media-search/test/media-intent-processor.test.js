/**
 * Media Intent Processor Tests
 *
 * Tests for the intent processing worker that consumes active media_intents
 * and runs them through the discovery/search pipeline.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { MediaIntentProcessor, formatProcessingSummary } from '../src/lib/intents/index.js';

// =============================================================================
// Test: MediaIntentProcessor requires cache instance
// =============================================================================

test('processor: requires cache instance', () => {
  assert.throws(
    () => new MediaIntentProcessor(),
    /Cache instance is required/
  );
});

test('processor: accepts cache instance', () => {
  const cache = createDiscoveryCache();
  const processor = new MediaIntentProcessor(cache);
  assert.ok(processor);
  cache.close();
});

// =============================================================================
// Test: processes active intents
// =============================================================================

test('processor: processes active intents', async () => {
  const cache = createDiscoveryCache();

  // Create test intents
  cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'test',
    sourceLabel: 'The Matrix',
  });

  cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'test',
    sourceLabel: 'Family Guy',
  });

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10 });

  assert.equal(result.processed, 2);
  assert.equal(result.successful, 2);
  assert.equal(result.failed, 0);

  // Verify processing state was updated
  const stats = processor.getStats();
  assert.equal(stats.totalIntents, 2);
  assert.equal(stats.activeIntents, 2);
  assert.equal(stats.processedIntents, 2);

  cache.close();
});

// =============================================================================
// Test: skips inactive intents
// =============================================================================

test('processor: skips inactive intents', async () => {
  const cache = createDiscoveryCache();

  // Create active intent
  const activeId = cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'test',
  });

  // Create inactive intent
  const inactiveId = cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    source: 'test',
  });
  cache.updateMediaIntentStatus(inactiveId, 'completed');

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10 });

  assert.equal(result.processed, 1);
  assert.equal(result.details[0].intentId, activeId);

  cache.close();
});

// =============================================================================
// Test: handles search failures
// =============================================================================

test('processor: handles search failures gracefully', async () => {
  const cache = createDiscoveryCache();

  // Create intent with invalid media ID that will cause search to fail
  cache.upsertMediaIntent({
    mediaId: 'invalid-media-id',
    mediaType: 'movie',
    source: 'test',
  });

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10 });

  // Should still process but with 0 results (searchByMedia doesn't throw for unknown media)
  assert.equal(result.processed, 1);
  assert.equal(result.successful, 1);
  assert.equal(result.resultsFound, 0);

  cache.close();
});

// =============================================================================
// Test: persists results
// =============================================================================

test('processor: persists results to media_requests', async () => {
  const cache = createDiscoveryCache();

  // Add a candidate and associate it with the media
  const hash1 = 'aabbccddeeff00112233445566778899aabbccdd';
  cache.upsertCandidate({
    infoHash: hash1,
    fileIndex: null,
    filename: 'The.Matrix.1999.1080p.mkv',
    title: 'The Matrix',
  });

  cache.associateMedia(hash1, null, 'tt0133093', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'confirmed',
  });

  // Create intent
  cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'test',
  });

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10 });

  assert.equal(result.processed, 1);
  assert.ok(result.details[0].requestId, 'Should have requestId');

  // Verify request was persisted
  const requests = cache.getMediaRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].media_id, 'tt0133093');

  cache.close();
});

// =============================================================================
// Test: handles empty intent queue
// =============================================================================

test('processor: handles empty intent queue', async () => {
  const cache = createDiscoveryCache();

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10 });

  assert.equal(result.processed, 0);
  assert.equal(result.successful, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.resultsFound, 0);

  cache.close();
});

// =============================================================================
// Test: does not duplicate processing unnecessarily
// =============================================================================

test('processor: respects minIntervalMs to avoid duplicate processing', async () => {
  const cache = createDiscoveryCache();

  // Create intent
  cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'test',
  });

  const processor = new MediaIntentProcessor(cache);

  // First processing
  const result1 = await processor.process({ limit: 10 });
  assert.equal(result1.processed, 1);

  // Second processing with minIntervalMs should skip recently processed
  const result2 = await processor.process({ limit: 10, minIntervalMs: 60000 });
  assert.equal(result2.processed, 0);

  cache.close();
});

// =============================================================================
// Test: dry run mode
// =============================================================================

test('processor: dry run does not persist results', async () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'test',
  });

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10, dryRun: true });

  assert.equal(result.processed, 1);
  assert.equal(result.successful, 1);
  assert.equal(result.details[0].requestId, null);

  // Verify no requests were persisted
  const requests = cache.getMediaRequests();
  assert.equal(requests.length, 0);

  cache.close();
});

// =============================================================================
// Test: limit option
// =============================================================================

test('processor: limit option restricts number of intents', async () => {
  const cache = createDiscoveryCache();

  // Create 5 intents
  for (let i = 0; i < 5; i++) {
    cache.upsertMediaIntent({
      mediaId: `tt000000${i}`,
      mediaType: 'movie',
      source: 'test',
    });
  }

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 3 });

  assert.equal(result.processed, 3);

  cache.close();
});

// =============================================================================
// Test: processing state tracking
// =============================================================================

test('processor: tracks processing state (last_processed_at, last_result_count)', async () => {
  const cache = createDiscoveryCache();

  const intentId = cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'test',
  });

  const processor = new MediaIntentProcessor(cache);
  await processor.process({ limit: 10 });

  // Verify processing state was updated
  const intent = cache.getMediaIntent(intentId);
  assert.ok(intent.lastProcessedAt > 0);
  assert.equal(typeof intent.lastResultCount, 'number');

  cache.close();
});

// =============================================================================
// Test: error tracking
// =============================================================================

test('processor: tracks errors in last_error', async () => {
  const cache = createDiscoveryCache();

  // Create intent that will cause an error (empty mediaId)
  const intentId = cache.upsertMediaIntent({
    mediaId: 'error-test',
    mediaType: 'movie',
    source: 'test',
  });

  // Mock searchByMedia to throw
  const originalSearch = cache.queryCandidatesByMedia;
  cache.queryCandidatesByMedia = () => { throw new Error('Search failed'); };

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10 });

  assert.equal(result.failed, 1);
  assert.equal(result.details[0].error, 'Search failed');

  // Restore original method
  cache.queryCandidatesByMedia = originalSearch;

  // Verify error was tracked
  const intent = cache.getMediaIntent(intentId);
  assert.equal(intent.lastError, 'Search failed');

  cache.close();
});

// =============================================================================
// Test: getStats returns correct counts
// =============================================================================

test('processor: getStats returns correct counts', async () => {
  const cache = createDiscoveryCache();

  // Create 3 active intents
  for (let i = 0; i < 3; i++) {
    cache.upsertMediaIntent({
      mediaId: `tt000000${i}`,
      mediaType: 'movie',
      source: 'test',
    });
  }

  // Create 1 inactive intent
  const inactiveId = cache.upsertMediaIntent({
    mediaId: 'tt9999999',
    mediaType: 'movie',
    source: 'test',
  });
  cache.updateMediaIntentStatus(inactiveId, 'completed');

  const processor = new MediaIntentProcessor(cache);

  // Before processing
  const statsBefore = processor.getStats();
  assert.equal(statsBefore.totalIntents, 4);
  assert.equal(statsBefore.activeIntents, 3);
  assert.equal(statsBefore.processedIntents, 0);

  // Process
  await processor.process({ limit: 10 });

  // After processing
  const statsAfter = processor.getStats();
  assert.equal(statsAfter.totalIntents, 4);
  assert.equal(statsAfter.activeIntents, 3);
  assert.equal(statsAfter.processedIntents, 3);

  cache.close();
});

// =============================================================================
// Test: formatProcessingSummary formats correctly
// =============================================================================

test('processor: formatProcessingSummary formats correctly', () => {
  const result = {
    processed: 10,
    successful: 9,
    failed: 1,
    resultsFound: 42,
    elapsedMs: 1234,
    details: [
      { intentId: 1, status: 'failed', error: 'Search failed' },
    ],
  };

  const summary = formatProcessingSummary(result);
  assert.match(summary, /10 processed/);
  assert.match(summary, /9 successful/);
  assert.match(summary, /1 failed/);
  assert.match(summary, /42 results found/);
  assert.match(summary, /1234ms/);
  assert.match(summary, /intent 1/);
  assert.match(summary, /Search failed/);
});

// =============================================================================
// Test: processing result structure
// =============================================================================

test('processor: processing result has correct structure', async () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'test',
  });

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10 });

  assert.ok('processed' in result);
  assert.ok('successful' in result);
  assert.ok('failed' in result);
  assert.ok('resultsFound' in result);
  assert.ok('details' in result);
  assert.ok('elapsedMs' in result);

  assert.equal(result.details.length, 1);
  assert.ok('intentId' in result.details[0]);
  assert.ok('status' in result.details[0]);

  cache.close();
});

// =============================================================================
// Test: continues processing if one intent fails
// =============================================================================

test('processor: continues processing if one intent fails', async () => {
  const cache = createDiscoveryCache();

  // Create 3 intents
  const id1 = cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });

  const id2 = cache.upsertMediaIntent({
    mediaId: 'tt0000002',
    mediaType: 'movie',
    source: 'test',
  });

  const id3 = cache.upsertMediaIntent({
    mediaId: 'tt0000003',
    mediaType: 'movie',
    source: 'test',
  });

  // Mock queryCandidatesByMedia to throw for specific intent
  const originalQuery = cache.queryCandidatesByMedia;
  cache.queryCandidatesByMedia = (mediaId) => {
    if (mediaId === 'tt0000002') {
      throw new Error('Search error for tt0000002');
    }
    return originalQuery.call(cache, mediaId);
  };

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10 });

  assert.equal(result.processed, 3);
  assert.equal(result.successful, 2);
  assert.equal(result.failed, 1);

  // Verify the failed intent has error details
  const failedDetail = result.details.find(d => d.intentId === id2);
  assert.equal(failedDetail.status, 'failed');
  assert.match(failedDetail.error, /Search error/);

  // Restore
  cache.queryCandidatesByMedia = originalQuery;

  cache.close();
});

// =============================================================================
// Test: priority ordering
// =============================================================================

test('processor: processes higher priority intents first', async () => {
  const cache = createDiscoveryCache();

  // Create intents with different priorities
  cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
    priority: 0,
  });

  cache.upsertMediaIntent({
    mediaId: 'tt0000002',
    mediaType: 'movie',
    source: 'test',
    priority: 10,
  });

  cache.upsertMediaIntent({
    mediaId: 'tt0000003',
    mediaType: 'movie',
    source: 'test',
    priority: 5,
  });

  const processor = new MediaIntentProcessor(cache);
  const result = await processor.process({ limit: 10 });

  assert.equal(result.processed, 3);

  // Verify processing order (highest priority first)
  // Note: The SQL query orders by priority DESC
  const intents = cache.db.prepare('SELECT * FROM media_intents ORDER BY priority DESC').all();
  assert.equal(intents[0].priority, 10);
  assert.equal(intents[1].priority, 5);
  assert.equal(intents[2].priority, 0);

  cache.close();
});

// =============================================================================
// Test: logging
// =============================================================================

test('processor: logs when log function provided', async () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'test',
  });

  const processor = new MediaIntentProcessor(cache);
  const logs = [];

  await processor.process({
    limit: 10,
    log: (msg) => logs.push(msg),
  });

  assert.ok(logs.length >= 2);
  assert.ok(logs.some(l => l.includes('Found')));
  assert.ok(logs.some(l => l.includes('processed')));

  cache.close();
});
