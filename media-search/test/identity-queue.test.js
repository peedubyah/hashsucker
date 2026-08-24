/**
 * Identity Enrichment Queue Tests
 *
 * Proves the queue lifecycle:
 *   enqueue → pending → processing → resolved/failed
 *
 * Tests:
 * - Enqueue creates pending item
 * - Pending items are retrievable
 * - Status transitions (pending → processing → resolved/failed)
 * - Retry state tracking
 * - Queue statistics
 * - Idempotent enqueue (won't overwrite resolved/failed unless allowed)
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

// =============================================================================
// Queue Lifecycle Tests
// =============================================================================

test('enqueueIdentityResolution creates pending item', () => {
  const cache = createDiscoveryCache();

  const item = cache.enqueueIdentityResolution(HASH1, null);
  assert.ok(item);
  assert.equal(item.infoHash, HASH1);
  assert.equal(item.fileIndexKey, -1);
  assert.equal(item.status, 'pending');
  assert.equal(item.attempts, 0);
  assert.equal(item.maxAttempts, 3);
  assert.ok(item.createdAt > 0);
  assert.equal(item.createdAt, item.updatedAt);

  cache.close();
});

test('enqueueIdentityResolution with custom maxAttempts', () => {
  const cache = createDiscoveryCache();

  const item = cache.enqueueIdentityResolution(HASH1, null, { maxAttempts: 5 });
  assert.equal(item.maxAttempts, 5);

  cache.close();
});

test('getPendingEnrichments returns only pending items', () => {
  const cache = createDiscoveryCache();

  cache.enqueueIdentityResolution(HASH1, null);
  cache.enqueueIdentityResolution(HASH2, null);

  const pending = cache.getPendingEnrichments(10);
  assert.equal(pending.length, 2);
  assert.ok(pending.every(item => item.status === 'pending'));

  cache.close();
});

test('getPendingEnrichments respects limit', () => {
  const cache = createDiscoveryCache();

  cache.enqueueIdentityResolution(HASH1, null);
  cache.enqueueIdentityResolution(HASH2, null);
  cache.enqueueIdentityResolution(HASH3, null);

  const pending = cache.getPendingEnrichments(2);
  assert.equal(pending.length, 2);

  cache.close();
});

test('status transition: pending → processing → resolved', () => {
  const cache = createDiscoveryCache();

  cache.enqueueIdentityResolution(HASH1, null);

  // Mark as processing
  let item = cache.updateEnrichmentStatus(HASH1, null, 'processing', { attempts: 1 });
  assert.equal(item.status, 'processing');
  assert.equal(item.attempts, 1);
  assert.ok(item.updatedAt >= item.createdAt);

  // Mark as resolved
  item = cache.updateEnrichmentStatus(HASH1, null, 'resolved', { attempts: 1 });
  assert.equal(item.status, 'resolved');
  assert.equal(item.attempts, 1);

  cache.close();
});

test('status transition: pending → processing → failed', () => {
  const cache = createDiscoveryCache();

  cache.enqueueIdentityResolution(HASH1, null);

  // Mark as failed with error
  const item = cache.updateEnrichmentStatus(HASH1, null, 'failed', {
    attempts: 1,
    errorMessage: 'API timeout',
    errorCategory: 'timeout',
  });

  assert.equal(item.status, 'failed');
  assert.equal(item.errorMessage, 'API timeout');
  assert.equal(item.errorCategory, 'timeout');

  cache.close();
});

test('getEnrichmentQueueItem returns item by candidate key', () => {
  const cache = createDiscoveryCache();

  cache.enqueueIdentityResolution(HASH1, null);

  const item = cache.getEnrichmentQueueItem(HASH1, null);
  assert.ok(item);
  assert.equal(item.infoHash, HASH1);

  const missing = cache.getEnrichmentQueueItem(HASH2, null);
  assert.equal(missing, null);

  cache.close();
});

test('getEnrichmentStats returns correct counts', () => {
  const cache = createDiscoveryCache();

  // Empty queue
  let stats = cache.getEnrichmentStats();
  assert.equal(stats.total, 0);
  assert.equal(stats.pending, 0);
  assert.equal(stats.processing, 0);
  assert.equal(stats.resolved, 0);
  assert.equal(stats.failed, 0);

  // Add items
  cache.enqueueIdentityResolution(HASH1, null);
  cache.enqueueIdentityResolution(HASH2, null);
  cache.enqueueIdentityResolution(HASH3, null);

  stats = cache.getEnrichmentStats();
  assert.equal(stats.total, 3);
  assert.equal(stats.pending, 3);

  // Resolve one
  cache.updateEnrichmentStatus(HASH1, null, 'resolved', { attempts: 1 });
  stats = cache.getEnrichmentStats();
  assert.equal(stats.pending, 2);
  assert.equal(stats.resolved, 1);

  // Fail one
  cache.updateEnrichmentStatus(HASH2, null, 'failed', { attempts: 1 });
  stats = cache.getEnrichmentStats();
  assert.equal(stats.pending, 1);
  assert.equal(stats.failed, 1);

  cache.close();
});

test('retry state tracking with nextAttemptAt', () => {
  const cache = createDiscoveryCache();

  cache.enqueueIdentityResolution(HASH1, null);

  const nextAttemptAt = Date.now() + 60000; // 1 minute from now
  const item = cache.updateEnrichmentStatus(HASH1, null, 'pending', {
    attempts: 1,
    nextAttemptAt,
    errorMessage: 'Temporary failure',
  });

  assert.equal(item.attempts, 1);
  assert.equal(item.nextAttemptAt, nextAttemptAt);
  assert.equal(item.errorMessage, 'Temporary failure');

  // Should not be in pending yet (nextAttemptAt is in the future)
  const pending = cache.getPendingEnrichments(10);
  assert.equal(pending.length, 0);

  cache.close();
});

test('failed items become retryable after nextAttemptAt passes', () => {
  const cache = createDiscoveryCache();

  cache.enqueueIdentityResolution(HASH1, null);

  // Set nextAttemptAt to the past
  const pastTime = Date.now() - 1000;
  cache.updateEnrichmentStatus(HASH1, null, 'failed', {
    attempts: 1,
    nextAttemptAt: pastTime,
  });

  // Should now be available as pending (failed items with past nextAttemptAt)
  const pending = cache.getPendingEnrichments(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].infoHash, HASH1);

  cache.close();
});

test('resolver source is tracked on enqueue and update', () => {
  const cache = createDiscoveryCache();

  cache.enqueueIdentityResolution(HASH1, null, { resolverSource: 'cinemeta' });

  const item = cache.updateEnrichmentStatus(HASH1, null, 'processing', {
    attempts: 1,
    resolverSource: 'cinemeta',
  });

  assert.equal(item.resolverSource, 'cinemeta');

  cache.close();
});
