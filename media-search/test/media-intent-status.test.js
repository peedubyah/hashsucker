/**
 * Media Intent Status Tests
 *
 * Tests for the intent lifecycle observability functions.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  getIntentStatus,
  getRecentProcessedIntents,
  getReprocessingNeeded,
  formatIntentStatus,
  formatRelativeTime,
} from '../src/lib/intents/status.js';

// =============================================================================
// Test: getIntentStatus with empty database
// =============================================================================

test('status: getIntentStatus with empty database', () => {
  const cache = createDiscoveryCache();
  const status = getIntentStatus(cache);

  assert.equal(status.total, 0);
  assert.equal(status.active, 0);
  assert.equal(status.processed, 0);
  assert.equal(status.unprocessed, 0);
  assert.equal(status.failed, 0);
  assert.equal(status.withResults, 0);
  assert.equal(status.withoutResults, 0);

  cache.close();
});

// =============================================================================
// Test: getIntentStatus with mixed intents
// =============================================================================

test('status: getIntentStatus with mixed intents', () => {
  const cache = createDiscoveryCache();

  // Create active, unprocessed intent
  cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });

  // Create active, processed intent with results
  const id2 = cache.upsertMediaIntent({
    mediaId: 'tt0000002',
    mediaType: 'movie',
    source: 'test',
  });
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ?, last_result_count = 5 WHERE id = ?
  `).run(Date.now(), id2);

  // Create active, processed intent without results
  const id3 = cache.upsertMediaIntent({
    mediaId: 'tt0000003',
    mediaType: 'movie',
    source: 'test',
  });
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ?, last_result_count = 0 WHERE id = ?
  `).run(Date.now(), id3);

  // Create failed intent
  const id4 = cache.upsertMediaIntent({
    mediaId: 'tt0000004',
    mediaType: 'movie',
    source: 'test',
  });
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ?, last_result_count = 0, last_error = 'Search failed' WHERE id = ?
  `).run(Date.now(), id4);

  // Create inactive intent
  const id5 = cache.upsertMediaIntent({
    mediaId: 'tt0000005',
    mediaType: 'movie',
    source: 'test',
  });
  cache.updateMediaIntentStatus(id5, 'completed');

  const status = getIntentStatus(cache);

  assert.equal(status.total, 5);
  assert.equal(status.active, 4); // 4 active (1 completed)
  assert.equal(status.processed, 3); // 3 processed
  assert.equal(status.unprocessed, 1); // 1 active never processed
  assert.equal(status.failed, 1); // 1 with error
  assert.equal(status.withResults, 1); // 1 with results > 0
  assert.equal(status.withoutResults, 2); // 2 processed with 0 results

  cache.close();
});

// =============================================================================
// Test: getIntentStatus with source filter
// =============================================================================

test('status: getIntentStatus filters by source', () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'cli',
  });

  cache.upsertMediaIntent({
    mediaId: 'tt0000002',
    mediaType: 'movie',
    source: 'plex',
  });

  const cliStatus = getIntentStatus(cache, { source: 'cli' });
  assert.equal(cliStatus.total, 1);

  const plexStatus = getIntentStatus(cache, { source: 'plex' });
  assert.equal(plexStatus.total, 1);

  cache.close();
});

// =============================================================================
// Test: getIntentStatus with status filter
// =============================================================================

test('status: getIntentStatus filters by status', () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });

  const id2 = cache.upsertMediaIntent({
    mediaId: 'tt0000002',
    mediaType: 'movie',
    source: 'test',
  });
  cache.updateMediaIntentStatus(id2, 'completed');

  const activeStatus = getIntentStatus(cache, { status: 'active' });
  assert.equal(activeStatus.total, 1);

  const completedStatus = getIntentStatus(cache, { status: 'completed' });
  assert.equal(completedStatus.total, 1);

  cache.close();
});

// =============================================================================
// Test: getRecentProcessedIntents
// =============================================================================

test('status: getRecentProcessedIntents returns empty when none processed', () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });

  const recent = getRecentProcessedIntents(cache, 10);
  assert.equal(recent.length, 0);

  cache.close();
});

test('status: getRecentProcessedIntents returns processed intents', () => {
  const cache = createDiscoveryCache();

  // Create processed intent
  const id = cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'plex',
    sourceLabel: 'The Matrix',
  });
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ?, last_result_count = 12 WHERE id = ?
  `).run(Date.now(), id);

  const recent = getRecentProcessedIntents(cache, 10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].mediaId, 'tt0133093');
  assert.equal(recent[0].label, 'The Matrix');
  assert.equal(recent[0].source, 'plex');
  assert.equal(recent[0].lastResultCount, 12);
  assert.ok(recent[0].lastProcessedAt > 0);

  cache.close();
});

test('status: getRecentProcessedIntents respects limit', () => {
  const cache = createDiscoveryCache();

  // Create 5 processed intents
  for (let i = 0; i < 5; i++) {
    const id = cache.upsertMediaIntent({
      mediaId: `tt000000${i}`,
      mediaType: 'movie',
      source: 'test',
    });
    cache.db.prepare(`
      UPDATE media_intents SET last_processed_at = ?, last_result_count = 1 WHERE id = ?
    `).run(Date.now() - i * 1000, id);
  }

  const recent = getRecentProcessedIntents(cache, 3);
  assert.equal(recent.length, 3);

  cache.close();
});

test('status: getRecentProcessedIntents orders by most recent first', () => {
  const cache = createDiscoveryCache();

  // Create 3 processed intents with different timestamps
  const id1 = cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ? WHERE id = ?
  `).run(Date.now() - 3000, id1);

  const id2 = cache.upsertMediaIntent({
    mediaId: 'tt0000002',
    mediaType: 'movie',
    source: 'test',
  });
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ? WHERE id = ?
  `).run(Date.now() - 1000, id2);

  const id3 = cache.upsertMediaIntent({
    mediaId: 'tt0000003',
    mediaType: 'movie',
    source: 'test',
  });
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ? WHERE id = ?
  `).run(Date.now() - 2000, id3);

  const recent = getRecentProcessedIntents(cache, 10);
  assert.equal(recent[0].mediaId, 'tt0000002'); // Most recent
  assert.equal(recent[1].mediaId, 'tt0000003');
  assert.equal(recent[2].mediaId, 'tt0000001'); // Oldest

  cache.close();
});

// =============================================================================
// Test: getReprocessingNeeded
// =============================================================================

test('status: getReprocessingNeeded returns never-processed intents', () => {
  const cache = createDiscoveryCache();

  cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });

  const reprocess = getReprocessingNeeded(cache, { limit: 10 });
  assert.equal(reprocess.length, 1);
  assert.equal(reprocess[0].mediaId, 'tt0000001');

  cache.close();
});

test('status: getReprocessingNeeded returns stale intents', () => {
  const cache = createDiscoveryCache();

  const id = cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });
  // Set last processed to 2 hours ago
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ? WHERE id = ?
  `).run(Date.now() - 7200000, id);

  const reprocess = getReprocessingNeeded(cache, { minIntervalMs: 3600000, limit: 10 });
  assert.equal(reprocess.length, 1);

  cache.close();
});

test('status: getReprocessingNeeded returns failed intents', () => {
  const cache = createDiscoveryCache();

  const id = cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ?, last_error = 'Search failed' WHERE id = ?
  `).run(Date.now(), id);

  const reprocess = getReprocessingNeeded(cache, { limit: 10 });
  assert.equal(reprocess.length, 1);
  assert.equal(reprocess[0].lastError, 'Search failed');

  cache.close();
});

test('status: getReprocessingNeeded skips recently processed', () => {
  const cache = createDiscoveryCache();

  const id = cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });
  // Set last processed to 1 minute ago
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ? WHERE id = ?
  `).run(Date.now() - 60000, id);

  const reprocess = getReprocessingNeeded(cache, { minIntervalMs: 3600000, limit: 10 });
  assert.equal(reprocess.length, 0);

  cache.close();
});

test('status: getReprocessingNeeded skips inactive intents', () => {
  const cache = createDiscoveryCache();

  const id = cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });
  cache.updateMediaIntentStatus(id, 'completed');

  const reprocess = getReprocessingNeeded(cache, { limit: 10 });
  assert.equal(reprocess.length, 0);

  cache.close();
});

test('status: getReprocessingNeeded prioritizes failed intents', () => {
  const cache = createDiscoveryCache();

  // Create never-processed intent
  cache.upsertMediaIntent({
    mediaId: 'tt0000001',
    mediaType: 'movie',
    source: 'test',
  });

  // Create failed intent
  const id2 = cache.upsertMediaIntent({
    mediaId: 'tt0000002',
    mediaType: 'movie',
    source: 'test',
  });
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ?, last_error = 'Error' WHERE id = ?
  `).run(Date.now(), id2);

  const reprocess = getReprocessingNeeded(cache, { limit: 10 });
  assert.equal(reprocess.length, 2);
  // Failed intent should come first
  assert.equal(reprocess[0].mediaId, 'tt0000002');

  cache.close();
});

// =============================================================================
// Test: formatRelativeTime
// =============================================================================

test('status: formatRelativeTime formats correctly', () => {
  const now = Date.now();

  assert.equal(formatRelativeTime(null), 'never');
  assert.equal(formatRelativeTime(now), 'just now');
  assert.equal(formatRelativeTime(now - 30000), 'just now'); // 30 seconds
  assert.equal(formatRelativeTime(now - 120000), '2m ago'); // 2 minutes
  assert.equal(formatRelativeTime(now - 3600000), '1h ago'); // 1 hour
  assert.equal(formatRelativeTime(now - 86400000), '1d ago'); // 1 day
  assert.equal(formatRelativeTime(now - 172800000), '2d ago'); // 2 days
});

// =============================================================================
// Test: formatIntentStatus
// =============================================================================

test('status: formatIntentStatus formats correctly', () => {
  const status = {
    total: 143,
    active: 138,
    processed: 120,
    unprocessed: 23,
    failed: 2,
    withResults: 95,
    withoutResults: 25,
  };

  const recent = [
    {
      id: 1,
      mediaId: 'tt0133093',
      label: 'The Matrix',
      source: 'plex',
      lastProcessedAt: Date.now() - 120000,
      lastResultCount: 12,
      lastError: null,
    },
  ];

  const output = formatIntentStatus(status, recent);

  assert.match(output, /Media Intent Status/);
  assert.match(output, /Total: 143/);
  assert.match(output, /Active: 138/);
  assert.match(output, /Processed: 120/);
  assert.match(output, /Pending: 23/);
  assert.match(output, /Failed: 2/);
  assert.match(output, /The Matrix/);
  assert.match(output, /plex/);
  assert.match(output, /12 results/);
});

test('status: formatIntentStatus with empty recent', () => {
  const status = {
    total: 10,
    active: 10,
    processed: 0,
    unprocessed: 10,
    failed: 0,
    withResults: 0,
    withoutResults: 0,
  };

  const output = formatIntentStatus(status, []);

  assert.match(output, /Total: 10/);
  assert.match(output, /Pending: 10/);
  assert.doesNotMatch(output, /Recent:/);
});

test('status: formatIntentStatus shows error indicator', () => {
  const status = {
    total: 1,
    active: 1,
    processed: 1,
    unprocessed: 0,
    failed: 1,
    withResults: 0,
    withoutResults: 1,
  };

  const recent = [
    {
      id: 1,
      mediaId: 'tt0000001',
      label: 'Failed Movie',
      source: 'test',
      lastProcessedAt: Date.now(),
      lastResultCount: 0,
      lastError: 'Search failed',
    },
  ];

  const output = formatIntentStatus(status, recent);
  assert.match(output, /ERROR/);
});

// =============================================================================
// Test: integration with processor
// =============================================================================

test('status: tracks processing via processor', async () => {
  const cache = createDiscoveryCache();

  // Create intent
  const id = cache.upsertMediaIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'test',
  });

  // Check initial status
  const initialStatus = getIntentStatus(cache);
  assert.equal(initialStatus.total, 1);
  assert.equal(initialStatus.active, 1);
  assert.equal(initialStatus.processed, 0);
  assert.equal(initialStatus.unprocessed, 1);

  // Simulate processing
  cache.db.prepare(`
    UPDATE media_intents SET last_processed_at = ?, last_result_count = 5 WHERE id = ?
  `).run(Date.now(), id);

  // Check updated status
  const updatedStatus = getIntentStatus(cache);
  assert.equal(updatedStatus.processed, 1);
  assert.equal(updatedStatus.unprocessed, 0);
  assert.equal(updatedStatus.withResults, 1);

  // Check recent processed
  const recent = getRecentProcessedIntents(cache, 10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].mediaId, 'tt0133093');
  assert.equal(recent[0].lastResultCount, 5);

  cache.close();
});
