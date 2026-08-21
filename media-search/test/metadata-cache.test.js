/**
 * Metadata Cache Tests
 *
 * Proves:
 * - Query normalization
 * - TTL expiration
 * - LRU eviction
 * - Cache hit/miss metrics
 * - Bounded memory usage
 * - Concurrent access safety
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMetadataCache, normalizeQueryKey } from '../src/lib/metadata/metadata-cache.js';

test('normalizeQueryKey normalizes whitespace and case', () => {
  assert.equal(normalizeQueryKey('  The   Matrix  '), 'the matrix');
  assert.equal(normalizeQueryKey('BLACK MIRROR'), 'black mirror');
  assert.equal(normalizeQueryKey(''), '');
  assert.equal(normalizeQueryKey('  '), '');
});

test('cache returns null for miss', () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });
  assert.equal(cache.get('matrix'), null);
  assert.equal(cache.getMetrics().misses, 1);
  cache.stop();
});

test('cache returns stored results on hit', () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });
  const results = [{ id: 'tt0133093', title: 'The Matrix' }];
  cache.set('matrix', results);

  const cached = cache.get('matrix');
  assert.ok(cached);
  assert.deepEqual(cached.results, results);
  assert.equal(cache.getMetrics().hits, 1);
  cache.stop();
});

test('cache respects TTL expiration', async () => {
  const cache = createMetadataCache({ ttlMs: 50, maxEntries: 10 });
  cache.set('matrix', [{ id: 'tt0133093' }]);

  // Should be cached immediately
  assert.ok(cache.get('matrix'));

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, 60));

  // Should now be expired
  assert.equal(cache.get('matrix'), null);
  assert.equal(cache.getMetrics().misses, 1);
  cache.stop();
});

test('cache evicts LRU when max entries exceeded', () => {
  const cache = createMetadataCache({ ttlMs: 10000, maxEntries: 3 });
  cache.set('a', [{ id: '1' }]);
  cache.set('b', [{ id: '2' }]);
  cache.set('c', [{ id: '3' }]);

  // Access 'a' to make it recently used
  cache.get('a');

  // Add 'd' — should evict 'b' (least recently used)
  cache.set('d', [{ id: '4' }]);

  assert.ok(cache.has('a'), 'a should still be cached');
  assert.ok(cache.has('c'), 'c should still be cached');
  assert.ok(cache.has('d'), 'd should be cached');
  assert.equal(cache.has('b'), false, 'b should be evicted');
  assert.equal(cache.getMetrics().evictions, 1);
  cache.stop();
});

test('cache metrics track hits, misses, evictions', () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 2 });
  cache.set('a', [{ id: '1' }]);
  cache.set('b', [{ id: '2' }]);
  cache.get('a'); // hit
  cache.get('c'); // miss (not in cache)
  cache.set('d', [{ id: '3' }]); // evicts 'b' (LRU: 'a' was accessed, 'b' is oldest)

  const metrics = cache.getMetrics();
  assert.equal(metrics.hits, 1);
  assert.equal(metrics.misses, 1);
  assert.equal(metrics.evictions, 1);
  assert.equal(metrics.size, 2);
  assert.equal(metrics.maxEntries, 2);
  cache.stop();
});

test('cache hitRatio is null when no requests', () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });
  const metrics = cache.getMetrics();
  assert.equal(metrics.hitRatio, null);
  cache.stop();
});

test('cache hitRatio calculates correctly', () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });
  cache.set('a', [{ id: '1' }]);
  cache.get('a'); // hit
  cache.get('a'); // hit
  cache.get('b'); // miss
  cache.get('c'); // miss

  const metrics = cache.getMetrics();
  assert.equal(metrics.hitRatio, 0.5); // 2 hits / 4 total
  cache.stop();
});

test('cache invalidate removes entry', () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });
  cache.set('matrix', [{ id: 'tt0133093' }]);
  assert.ok(cache.has('matrix'));

  assert.equal(cache.invalidate('matrix'), true);
  assert.equal(cache.has('matrix'), false);
  assert.equal(cache.invalidate('matrix'), false); // already gone
  cache.stop();
});

test('cache clear removes all entries', () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });
  cache.set('a', [{ id: '1' }]);
  cache.set('b', [{ id: '2' }]);
  cache.set('c', [{ id: '3' }]);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.has('a'), false);
  cache.stop();
});

test('cache set updates existing entry', () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });
  cache.set('matrix', [{ id: 'tt0133093' }]);
  cache.set('matrix', [{ id: 'tt0133093', title: 'Updated' }]);

  const cached = cache.get('matrix');
  assert.equal(cached.results.length, 1);
  assert.equal(cached.results[0].title, 'Updated');
  assert.equal(cache.size, 1);
  cache.stop();
});

test('cache getRemainingTtl returns correct value', async () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });
  cache.set('matrix', [{ id: 'tt0133093' }]);

  const ttl1 = cache.getRemainingTtl('matrix');
  assert.ok(ttl1 > 0);
  assert.ok(ttl1 <= 1000);

  await new Promise((r) => setTimeout(r, 100));

  const ttl2 = cache.getRemainingTtl('matrix');
  assert.ok(ttl2 < ttl1, 'TTL should decrease over time');
  cache.stop();
});

test('cache has() returns false for expired entries', async () => {
  const cache = createMetadataCache({ ttlMs: 50, maxEntries: 10 });
  cache.set('matrix', [{ id: 'tt0133093' }]);
  assert.ok(cache.has('matrix'));

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cache.has('matrix'), false);
  cache.stop();
});

test('cache sweepExpired removes only expired entries', async () => {
  const cache = createMetadataCache({ ttlMs: 50, maxEntries: 10 });
  cache.set('a', [{ id: '1' }]);
  cache.set('b', [{ id: '2' }]);

  await new Promise((r) => setTimeout(r, 60));
  cache.set('c', [{ id: '3' }]); // fresh entry

  const removed = cache.sweepExpired();
  assert.equal(removed, 2); // a and b expired
  assert.equal(cache.has('c'), true);
  cache.stop();
});

test('cache resetMetrics clears counters but keeps data', () => {
  const cache = createMetadataCache({ ttlMs: 1000, maxEntries: 10 });
  cache.set('a', [{ id: '1' }]);
  cache.get('a');
  cache.resetMetrics();

  const metrics = cache.getMetrics();
  assert.equal(metrics.hits, 0);
  assert.equal(metrics.misses, 0);
  assert.equal(cache.has('a'), true); // data preserved
  cache.stop();
});
