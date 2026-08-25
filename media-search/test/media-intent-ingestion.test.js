/**
 * Media Intent Ingestion Service Tests
 *
 * Tests for the ingestion layer between providers and the media_intents database.
 * Validates, deduplicates, upserts, and reports created/updated/skipped intents.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  MediaIntentProvider,
  MediaIntentIngestionService,
  formatIngestionSummary,
} from '../src/lib/intents/index.js';

// =============================================================================
// Test: IngestionService requires cache instance
// =============================================================================

test('ingestion: requires cache instance', () => {
  assert.throws(
    () => new MediaIntentIngestionService(),
    /Cache instance is required/
  );
});

test('ingestion: accepts cache instance', () => {
  const cache = createDiscoveryCache();
  const service = new MediaIntentIngestionService(cache);
  assert.ok(service);
  cache.close();
});

test('ingestion: rejects invalid provider', () => {
  const cache = createDiscoveryCache();
  assert.throws(
    () => new MediaIntentIngestionService(cache, {}),
    /Provider must be an instance of MediaIntentProvider/
  );
  cache.close();
});

test('ingestion: accepts valid provider', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);
  assert.equal(service.provider, provider);
  cache.close();
});

// =============================================================================
// Test: ingest creates new intents
// =============================================================================

test('ingestion: ingest creates new intents', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const result = service.ingest([
    { mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' },
    { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'cli' },
  ]);

  assert.equal(result.created, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.total, 2);
  assert.equal(result.details.length, 2);

  // Verify intents were persisted
  const stats = cache.getMediaIntentStats();
  assert.equal(stats.total_intents, 2);
  assert.equal(stats.unique_media, 2);

  cache.close();
});

// =============================================================================
// Test: ingest increments existing intents
// =============================================================================

test('ingestion: ingest increments existing intents', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  // First ingestion
  const result1 = service.ingest([
    { mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' },
  ]);
  assert.equal(result1.created, 1);
  assert.equal(result1.updated, 0);

  // Second ingestion of same intent
  const result2 = service.ingest([
    { mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' },
  ]);
  assert.equal(result2.created, 0);
  assert.equal(result2.updated, 1);

  // Verify request count
  const stats = cache.getMediaIntentStats();
  assert.equal(stats.total_intents, 1);
  assert.equal(stats.total_requests, 2);

  cache.close();
});

// =============================================================================
// Test: ingest skips invalid intents
// =============================================================================

test('ingestion: ingest skips invalid intents', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const result = service.ingest([
    { mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' },
    { mediaType: 'movie', source: 'cli' }, // missing mediaId
    { mediaId: 'tt123', mediaType: 'invalid', source: 'cli' }, // invalid mediaType
  ]);

  assert.equal(result.created, 1);
  assert.equal(result.skipped, 2);

  // Verify only valid intent was persisted
  const stats = cache.getMediaIntentStats();
  assert.equal(stats.total_intents, 1);

  cache.close();
});

// =============================================================================
// Test: ingest handles movie with season as invalid
// =============================================================================

test('ingestion: ingest rejects movie with season', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const result = service.ingest([
    { mediaId: 'tt0133093', mediaType: 'movie', season: 1, source: 'cli' },
  ]);

  assert.equal(result.skipped, 1);
  assert.match(result.details[0].reason, /Movie intents must not have season/);

  cache.close();
});

// =============================================================================
// Test: ingest handles series episode without season as invalid
// =============================================================================

test('ingestion: ingest rejects series episode without season', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const result = service.ingest([
    { mediaId: 'tt0182576', mediaType: 'series', episode: 5, source: 'cli' },
  ]);

  assert.equal(result.skipped, 1);
  assert.match(result.details[0].reason, /episode/);

  cache.close();
});

// =============================================================================
// Test: ingest with skipValidation
// =============================================================================

test('ingestion: ingest with skipValidation bypasses validation', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  // With skipValidation, even invalid intents are persisted
  const result = service.ingest(
    [{ mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' }],
    { skipValidation: true }
  );

  assert.equal(result.created, 1);
  assert.equal(result.skipped, 0);

  cache.close();
});

// =============================================================================
// Test: ingest with dryRun
// =============================================================================

test('ingestion: ingest with dryRun does not persist', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const result = service.ingest(
    [{ mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' }],
    { dryRun: true }
  );

  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);

  // Verify nothing was persisted
  const stats = cache.getMediaIntentStats();
  assert.equal(stats.total_intents, 0);

  cache.close();
});

// =============================================================================
// Test: ingest dryRun detects existing intents
// =============================================================================

test('ingestion: dryRun detects existing intents', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  // First, persist an intent
  service.ingest([{ mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' }]);

  // Now dry-run the same intent
  const result = service.ingest(
    [{ mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' }],
    { dryRun: true }
  );

  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);

  cache.close();
});

// =============================================================================
// Test: ingest with logging
// =============================================================================

test('ingestion: ingest with logging calls log function', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const logs = [];
  const result = service.ingest(
    [
      { mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' },
      { mediaType: 'movie', source: 'cli' }, // invalid
    ],
    { log: (msg) => logs.push(msg) }
  );

  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.ok(logs.length >= 2, 'Should have at least 2 log messages');

  cache.close();
});

// =============================================================================
// Test: ingestFromProvider fetches and ingests
// =============================================================================

test('ingestion: ingestFromProvider fetches and ingests', async () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  // Mock fetchIntents
  provider.fetchIntents = async () => [
    { mediaId: 'tt0133093', mediaType: 'movie', source: 'test' },
    { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'test' },
  ];

  const result = await service.ingestFromProvider(provider);

  assert.equal(result.fetch.intentCount, 2);
  assert.equal(result.ingestion.created, 2);
  assert.equal(result.ingestion.skipped, 0);

  cache.close();
});

// =============================================================================
// Test: ingestFromProvider handles fetch errors
// =============================================================================

test('ingestion: ingestFromProvider handles fetch errors', async () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  // Mock fetchIntents to throw
  provider.fetchIntents = async () => {
    throw new Error('Provider unavailable');
  };

  await assert.rejects(
    () => service.ingestFromProvider(provider),
    /Provider unavailable/
  );

  cache.close();
});

// =============================================================================
// Test: ingestFromProviders handles multiple providers
// =============================================================================

test('ingestion: ingestFromProviders handles multiple providers', async () => {
  const cache = createDiscoveryCache();
  const service = new MediaIntentIngestionService(cache);

  const provider1 = new MediaIntentProvider('test1', 'manual');
  provider1.fetchIntents = async () => [
    { mediaId: 'tt0133093', mediaType: 'movie', source: 'test1' },
  ];

  const provider2 = new MediaIntentProvider('test2', 'manual');
  provider2.fetchIntents = async () => [
    { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'test2' },
  ];

  const results = await service.ingestFromProviders([provider1, provider2]);

  assert.equal(results.length, 2);
  assert.equal(results[0].ingestion.created, 1);
  assert.equal(results[1].ingestion.created, 1);

  cache.close();
});

// =============================================================================
// Test: ingestFromProviders skips disabled providers
// =============================================================================

test('ingestion: ingestFromProviders skips disabled providers', async () => {
  const cache = createDiscoveryCache();
  const service = new MediaIntentIngestionService(cache);

  const provider1 = new MediaIntentProvider('test1', 'manual', { enabled: false });
  provider1.fetchIntents = async () => {
    throw new Error('Should not be called');
  };

  const provider2 = new MediaIntentProvider('test2', 'manual');
  provider2.fetchIntents = async () => [
    { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'test2' },
  ];

  const results = await service.ingestFromProviders([provider1, provider2]);

  assert.equal(results.length, 1);
  assert.equal(results[0].provider, 'test2');

  cache.close();
});

// =============================================================================
// Test: ingestFromProviders handles provider errors gracefully
// =============================================================================

test('ingestion: ingestFromProviders handles provider errors gracefully', async () => {
  const cache = createDiscoveryCache();
  const service = new MediaIntentIngestionService(cache);

  const provider1 = new MediaIntentProvider('test1', 'manual');
  provider1.fetchIntents = async () => {
    throw new Error('Provider error');
  };

  const provider2 = new MediaIntentProvider('test2', 'manual');
  provider2.fetchIntents = async () => [
    { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'test2' },
  ];

  const results = await service.ingestFromProviders([provider1, provider2]);

  assert.equal(results.length, 2);
  assert.ok(results[0].fetch.error);
  assert.equal(results[1].ingestion.created, 1);

  cache.close();
});

// =============================================================================
// Test: formatIngestionSummary formats correctly
// =============================================================================

test('ingestion: formatIngestionSummary formats correctly', () => {
  const result = {
    created: 5,
    updated: 3,
    skipped: 2,
    total: 10,
    elapsedMs: 42,
    details: [],
  };

  const summary = formatIngestionSummary(result);
  assert.match(summary, /5 created/);
  assert.match(summary, /3 updated/);
  assert.match(summary, /2 skipped/);
  assert.match(summary, /10 total/);
  assert.match(summary, /42ms/);
});

// =============================================================================
// Test: formatIngestionSummary includes skipped reasons
// =============================================================================

test('ingestion: formatIngestionSummary includes skipped reasons', () => {
  const result = {
    created: 1,
    updated: 0,
    skipped: 2,
    total: 3,
    elapsedMs: 10,
    details: [
      { intent: { mediaId: 'bad1' }, status: 'skipped', reason: 'Missing mediaId' },
      { intent: { mediaId: 'bad2' }, status: 'skipped', reason: 'Invalid mediaType' },
    ],
  };

  const summary = formatIngestionSummary(result);
  assert.match(summary, /bad1/);
  assert.match(summary, /Missing mediaId/);
  assert.match(summary, /bad2/);
  assert.match(summary, /Invalid mediaType/);
});

// =============================================================================
// Test: ingest handles empty array
// =============================================================================

test('ingestion: ingest handles empty array', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const result = service.ingest([]);

  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.total, 0);

  cache.close();
});

// =============================================================================
// Test: ingest handles NULL season/episode deduplication
// =============================================================================

test('ingestion: ingest handles NULL season/episode deduplication', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  // Ingest series intent without season/episode (full series request)
  const result1 = service.ingest([
    { mediaId: 'tt0182576', mediaType: 'series', source: 'cli' },
  ]);
  assert.equal(result1.created, 1);

  // Ingest same series with specific season - should be separate intent
  const result2 = service.ingest([
    { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'cli' },
  ]);
  assert.equal(result2.created, 1);

  // Re-ingest full series - should increment
  const result3 = service.ingest([
    { mediaId: 'tt0182576', mediaType: 'series', source: 'cli' },
  ]);
  assert.equal(result3.updated, 1);

  // Verify we have 2 intents (full series + specific episode)
  const stats = cache.getMediaIntentStats();
  assert.equal(stats.total_intents, 2);

  cache.close();
});

// =============================================================================
// Test: ingest preserves source metadata
// =============================================================================

test('ingestion: ingest preserves source metadata', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const result = service.ingest([
    {
      mediaId: 'tt0133093',
      mediaType: 'movie',
      source: 'cli',
      sourceType: 'manual',
      sourceId: 'req-123',
      sourceLabel: 'The Matrix',
      priority: 10,
      requestedBy: 'user@example.com',
    },
  ]);

  assert.equal(result.created, 1);

  const detail = result.details[0];
  const stored = cache.getMediaIntent(detail.intentId);

  assert.equal(stored.source, 'cli');
  assert.equal(stored.sourceType, 'manual');
  assert.equal(stored.sourceId, 'req-123');
  assert.equal(stored.sourceLabel, 'The Matrix');
  assert.equal(stored.priority, 10);
  assert.equal(stored.requestedBy, 'user@example.com');

  cache.close();
});

// =============================================================================
// Test: ingest result details contain intentId
// =============================================================================

test('ingestion: ingest result details contain intentId', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const result = service.ingest([
    { mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' },
  ]);

  assert.ok(result.details[0].intentId, 'Should have intentId');
  assert.equal(typeof result.details[0].intentId, 'number');

  cache.close();
});

// =============================================================================
// Test: ingest result details contain status
// =============================================================================

test('ingestion: ingest result details contain status', () => {
  const cache = createDiscoveryCache();
  const provider = new MediaIntentProvider('test', 'manual');
  const service = new MediaIntentIngestionService(cache, provider);

  const result = service.ingest([
    { mediaId: 'tt0133093', mediaType: 'movie', source: 'cli' },
    { mediaType: 'movie', source: 'cli' }, // invalid
  ]);

  assert.equal(result.details[0].status, 'created');
  assert.equal(result.details[1].status, 'skipped');

  cache.close();
});
