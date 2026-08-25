/**
 * Media Intents Tests
 *
 * Tests for the media_intents persistence layer:
 * - Upsert creates and increments intents
 * - Lookup by ID, mediaId, source, and recent
 * - Status updates
 * - Statistics aggregation
 * - Backwards compatibility with media_requests
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { searchByMedia } from '../src/api/media-request.js';

// =============================================================================
// Test: upsertMediaIntent creates a new intent
// =============================================================================

test('mediaIntents: upsertMediaIntent creates a new intent', () => {
  const cache = createDiscoveryCache();

  const intentId = cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'api',
    sourceLabel: 'Family Guy S05E12',
  });

  assert.ok(intentId, 'Should return intent ID');
  assert.equal(typeof intentId, 'number', 'ID should be a number');

  const intent = cache.getMediaIntent(intentId);
  assert.ok(intent, 'Should retrieve intent');
  assert.equal(intent.mediaId, 'tt0182576', 'Media ID should match');
  assert.equal(intent.mediaType, 'series', 'Media type should match');
  assert.equal(intent.season, 5, 'Season should match');
  assert.equal(intent.episode, 12, 'Episode should match');
  assert.equal(intent.source, 'api', 'Source should match');
  assert.equal(intent.sourceLabel, 'Family Guy S05E12', 'Source label should match');
  assert.equal(intent.status, 'active', 'Status should default to active');
  assert.equal(intent.requestCount, 1, 'Request count should be 1');
  assert.ok(intent.lastRequestedAt > 0, 'Last requested at should be set');
  assert.ok(intent.createdAt > 0, 'Created at should be set');

  cache.close();
});

// =============================================================================
// Test: upsertMediaIntent increments request_count on conflict
// =============================================================================

test('mediaIntents: upsertMediaIntent increments request_count on conflict', () => {
  const cache = createDiscoveryCache();

  const id1 = cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'api',
  });

  const id2 = cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'api',
  });

  assert.equal(id1, id2, 'Should return same ID on conflict');

  const intent = cache.getMediaIntent(id1);
  assert.equal(intent.requestCount, 2, 'Request count should increment to 2');

  // Third upsert
  cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'api',
  });

  const intent3 = cache.getMediaIntent(id1);
  assert.equal(intent3.requestCount, 3, 'Request count should increment to 3');

  cache.close();
});

// =============================================================================
// Test: Different sources create separate intents
// =============================================================================

test('mediaIntents: different sources create separate intents', () => {
  const cache = createDiscoveryCache();

  const id1 = cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'api',
  });

  const id2 = cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'plex_watchlist',
  });

  const id3 = cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'overseerr',
  });

  assert.notEqual(id1, id2, 'API and Plex should be separate');
  assert.notEqual(id2, id3, 'Plex and Overseerr should be separate');

  const intents = cache.getMediaIntentsByMediaId('tt0182576');
  assert.equal(intents.length, 3, 'Should have 3 intents');

  const sources = intents.map(i => i.source).sort();
  assert.deepEqual(sources, ['api', 'overseerr', 'plex_watchlist'], 'Should have all sources');

  cache.close();
});

// =============================================================================
// Test: getMediaIntentsBySource filters by source
// =============================================================================

test('mediaIntents: getMediaIntentsBySource filters by source', () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({ mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'plex_watchlist' });
  cache.upsertMediaIntent({ mediaId: 'tt0111161', mediaType: 'movie', source: 'plex_watchlist' });
  cache.upsertMediaIntent({ mediaId: 'tt0133093', mediaType: 'movie', source: 'api' });

  const plexIntents = cache.getMediaIntentsBySource('plex_watchlist');
  assert.equal(plexIntents.length, 2, 'Should have 2 Plex intents');
  assert.ok(plexIntents.every(i => i.source === 'plex_watchlist'), 'All should be Plex');

  const apiIntents = cache.getMediaIntentsBySource('api');
  assert.equal(apiIntents.length, 1, 'Should have 1 API intent');

  cache.close();
});

// =============================================================================
// Test: getRecentMediaIntents returns intents ordered by last_requested_at
// =============================================================================

test('mediaIntents: getRecentMediaIntents returns intents ordered by recency', () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({ mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'api' });

  // Wait a tiny bit to ensure different timestamps
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }

  cache.upsertMediaIntent({ mediaId: 'tt0111161', mediaType: 'movie', source: 'api' });

  const recent = cache.getRecentMediaIntents(10);
  assert.ok(recent.length >= 2, 'Should have at least 2 intents');

  // First should be most recent
  assert.ok(recent[0].lastRequestedAt >= recent[1].lastRequestedAt, 'Should be ordered by recency');

  cache.close();
});

// =============================================================================
// Test: updateMediaIntentStatus updates status
// =============================================================================

test('mediaIntents: updateMediaIntentStatus updates status', () => {
  const cache = createDiscoveryCache();

  const id = cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'api',
  });

  let intent = cache.getMediaIntent(id);
  assert.equal(intent.status, 'active', 'Should start as active');

  cache.updateMediaIntentStatus(id, 'completed');

  intent = cache.getMediaIntent(id);
  assert.equal(intent.status, 'completed', 'Should be completed');

  cache.close();
});

// =============================================================================
// Test: getMediaIntentStats aggregates correctly
// =============================================================================

test('mediaIntents: getMediaIntentStats aggregates correctly', () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({ mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'api' });
  cache.upsertMediaIntent({ mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'api' });
  cache.upsertMediaIntent({ mediaId: 'tt0111161', mediaType: 'movie', source: 'plex_watchlist' });
  cache.upsertMediaIntent({ mediaId: 'tt0133093', mediaType: 'movie', source: 'overseerr' });

  const stats = cache.getMediaIntentStats();
  assert.equal(stats.total_intents, 3, 'Should have 3 unique intents');
  assert.equal(stats.active_intents, 3, 'All should be active');
  assert.equal(stats.total_requests, 4, 'Should have 4 total requests');
  assert.equal(stats.unique_media, 3, 'Should have 3 unique media');
  assert.equal(stats.unique_sources, 3, 'Should have 3 unique sources');

  cache.close();
});

// =============================================================================
// Test: priority is preserved and maxed on conflict
// =============================================================================

test('mediaIntents: priority is preserved and maxed on conflict', () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'api',
    priority: 1,
  });

  cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'api',
    priority: 5,
  });

  cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'api',
    priority: 3,
  });

  const intent = cache.getMediaIntentsByMediaId('tt0182576');
  assert.equal(intent[0].priority, 5, 'Priority should be max(1, 5, 3) = 5');

  cache.close();
});

// =============================================================================
// Test: source metadata is preserved on conflict
// =============================================================================

test('mediaIntents: source metadata is preserved on conflict', () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'plex_watchlist',
    sourceType: 'watchlist',
    sourceId: 'user-123',
    sourceLabel: 'John Watchlist',
  });

  // Second upsert without metadata
  cache.upsertMediaIntent({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'plex_watchlist',
  });

  const intent = cache.getMediaIntentsByMediaId('tt0182576');
  assert.equal(intent[0].sourceType, 'watchlist', 'Source type should be preserved');
  assert.equal(intent[0].sourceId, 'user-123', 'Source ID should be preserved');
  assert.equal(intent[0].sourceLabel, 'John Watchlist', 'Source label should be preserved');

  cache.close();
});

// =============================================================================
// Test: persistMediaRequest links to intent via intent_id
// =============================================================================

test('mediaIntents: persistMediaRequest links to intent when source metadata provided', async () => {
  const cache = createDiscoveryCache();

  const hash1 = 'aabbccddeeff00112233445566778899aabbccdd';
  cache.upsertCandidate({
    infoHash: hash1,
    fileIndex: null,
    filename: 'Family.Guy.S05E12.1080p.mkv',
    title: 'Family Guy',
  });

  storeReleaseAttributes(cache, {
    infoHash: hash1,
    fileIndex: null,
    filename: 'Family.Guy.S05E12.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Family Guy',
      year: 2005,
      season: 5,
      episode: 12,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hash1, null, 'tt0182576', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match', 'episode_verified'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match,episode_verified',
    resolutionState: 'confirmed',
  });

  const result = await searchByMedia(cache, {
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'plex_watchlist',
    sourceType: 'watchlist',
    sourceId: 'user-123',
    sourceLabel: 'John Watchlist',
    requestedBy: 'john@example.com',
  });

  assert.ok(result.requestId, 'Should persist request');

  const requests = cache.getMediaRequests();
  assert.ok(requests.length > 0, 'Should have persisted request');
  assert.ok(requests[0].intent_id, 'Request should have intent_id');

  const intents = cache.getMediaIntentsByMediaId('tt0182576');
  assert.equal(intents.length, 1, 'Should have 1 intent');
  assert.equal(intents[0].source, 'plex_watchlist', 'Source should be preserved');
  assert.equal(intents[0].requestCount, 1, 'Request count should be 1');

  cache.close();
});

// =============================================================================
// Test: backwards compatibility - persistMediaRequest without source metadata still works
// =============================================================================

test('mediaIntents: backwards compatible - no source metadata does not create intent', async () => {
  const cache = createDiscoveryCache();

  const hash1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  cache.upsertCandidate({
    infoHash: hash1,
    fileIndex: null,
    filename: 'The.Matrix.1999.1080p.mkv',
    title: 'The Matrix',
  });

  storeReleaseAttributes(cache, {
    infoHash: hash1,
    fileIndex: null,
    filename: 'The.Matrix.1999.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.95,
    parsed: {
      title: 'The Matrix',
      year: 1999,
      season: null,
      episode: null,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hash1, null, 'tt0133093', {
    source: 'enrichment',
    confidence: 0.95,
    evidence: ['title_exact_match', 'year_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match,year_match',
    resolutionState: 'confirmed',
  });

  const result = await searchByMedia(cache, {
    mediaId: 'tt0133093',
    mediaType: 'movie',
  });

  assert.ok(result.requestId, 'Should persist request');

  const requests = cache.getMediaRequests();
  assert.ok(requests.length > 0, 'Should have persisted request');
  assert.equal(requests[0].intent_id, null, 'Request should have null intent_id');
  assert.equal(requests[0].source, 'api', 'Source should default to api');

  const stats = cache.getMediaIntentStats();
  assert.equal(stats.total_intents, 0, 'Should have no intents');

  cache.close();
});

// =============================================================================
// Test: null episode/season in intent uses database NULL for matching
// =============================================================================

test('mediaIntents: null season/episode treated as movie intent', () => {
  const cache = createDiscoveryCache();

  const id1 = cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'api',
  });

  const id2 = cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'api',
  });

  assert.equal(id1, id2, 'Movie intents should match');

  const intent = cache.getMediaIntent(id1);
  assert.equal(intent.season, null, 'Season should be null');
  assert.equal(intent.episode, null, 'Episode should be null');
  assert.equal(intent.requestCount, 2, 'Request count should be 2');

  cache.close();
});

// =============================================================================
// Test: getMediaIntentsByMediaId returns empty array when no intents
// =============================================================================

test('mediaIntents: getMediaIntentsByMediaId returns empty when none exist', () => {
  const cache = createDiscoveryCache();

  const intents = cache.getMediaIntentsByMediaId('tt0000000');
  assert.deepEqual(intents, [], 'Should return empty array');

  cache.close();
});

// =============================================================================
// Test: updateMediaIntentStatus on non-existent ID does not throw
// =============================================================================

test('mediaIntents: updateMediaIntentStatus on non-existent ID does not throw', () => {
  const cache = createDiscoveryCache();

  assert.doesNotThrow(() => {
    cache.updateMediaIntentStatus(99999, 'completed');
  }, 'Should not throw');

  cache.close();
});
