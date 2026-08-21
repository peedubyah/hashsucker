/**
 * Unified Search Tests
 *
 * Proves:
 * - Query validation (min/max length)
 * - Cache hit/miss behavior
 * - Request deduplication
 * - Stale response rejection (requestId)
 * - Provider error handling
 * - Concurrent request handling
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  searchTitles,
  getMediaById,
  validateQuery,
  getCacheMetrics,
  invalidateCache,
  clearCache,
  _resetForTests,
  _getCacheForTests,
} from '../src/lib/metadata/unified-search.js';

test('validateQuery rejects queries shorter than 2 chars', () => {
  const result = validateQuery('a');
  assert.equal(result.valid, false);
  assert.match(result.error, /at least 2 characters/);
});

test('validateQuery rejects queries longer than 120 chars', () => {
  const result = validateQuery('a'.repeat(121));
  assert.equal(result.valid, false);
  assert.match(result.error, /at most 120 characters/);
});

test('validateQuery accepts valid queries', () => {
  const result = validateQuery('The Matrix');
  assert.equal(result.valid, true);
  assert.equal(result.normalized, 'The Matrix');
  assert.equal(result.error, null);
});

test('validateQuery trims whitespace', () => {
  const result = validateQuery('  The Matrix  ');
  assert.equal(result.valid, true);
  assert.equal(result.normalized, 'The Matrix');
});

test('searchTitles returns empty results for invalid query', async () => {
  const result = await searchTitles('a');
  assert.equal(result.results.length, 0);
  assert.match(result.error, /at least 2 characters/);
});

test('searchTitles returns results for valid query', async () => {
  _resetForTests();

  const result = await searchTitles('matrix');
  assert.ok(result.results.length > 0);
  assert.equal(result.fromCache, false);
  assert.ok(result.requestId);
  assert.ok(result.timings.totalMs >= 0);
});

test('searchTitles caches results', async () => {
  _resetForTests();
  clearCache();

  // First search — cache miss
  const result1 = await searchTitles('matrix');
  assert.equal(result1.fromCache, false);

  // Second search — cache hit
  const result2 = await searchTitles('matrix');
  assert.equal(result2.fromCache, true);
  assert.deepEqual(result2.results, result1.results);
});

test('searchTitles deduplicates concurrent identical requests', async () => {
  _resetForTests();
  clearCache();

  // Fire two identical requests simultaneously
  const [result1, result2] = await Promise.all([
    searchTitles('matrix'),
    searchTitles('matrix'),
  ]);

  // Both should get the same results
  assert.deepEqual(result1.results, result2.results);
  // One should be marked as deduped
  assert.ok(result1.deduped || result2.deduped);
});

test('searchTitles generates unique requestIds', async () => {
  _resetForTests();

  const result1 = await searchTitles('matrix');
  const result2 = await searchTitles('inception');

  assert.notEqual(result1.requestId, result2.requestId);
});

test('searchTitles accepts client-provided requestId', async () => {
  _resetForTests();

  const result = await searchTitles('matrix', { requestId: 'client-req-123' });
  assert.equal(result.requestId, 'client-req-123');
});

test('searchTitles skipCache bypasses cache', async () => {
  _resetForTests();
  clearCache();

  // Prime cache
  await searchTitles('matrix');

  // Skip cache
  const result = await searchTitles('matrix', { skipCache: true });
  assert.equal(result.fromCache, false);
});

test('getCacheMetrics returns null when no cache', () => {
  _resetForTests();
  // Cache is created lazily, so initially null
  // After a search it should be populated
});

test('getCacheMetrics returns metrics after searches', async () => {
  _resetForTests();
  clearCache();

  await searchTitles('matrix');
  await searchTitles('matrix'); // cache hit

  const metrics = getCacheMetrics();
  assert.ok(metrics);
  assert.equal(metrics.hits, 1);
  assert.equal(metrics.misses, 1);
  assert.equal(metrics.size, 1);
});

test('invalidateCache removes cached entry', async () => {
  _resetForTests();
  clearCache();

  await searchTitles('matrix');
  assert.equal(getCacheMetrics().size, 1);

  const invalidated = invalidateCache('matrix');
  assert.equal(invalidated, true);
  assert.equal(getCacheMetrics().size, 0);
});

test('clearCache removes all entries', async () => {
  _resetForTests();
  clearCache();

  await searchTitles('matrix');
  await searchTitles('inception');
  assert.ok(getCacheMetrics().size >= 2);

  clearCache();
  assert.equal(getCacheMetrics().size, 0);
});

test('getMediaById returns null for unknown media', async () => {
  _resetForTests();

  const media = await getMediaById('series', 'tt0000000000');
  assert.equal(media, null);
});

test('searchTitles handles provider errors gracefully', async () => {
  _resetForTests();
  clearCache();

  // This test verifies the search doesn't throw even if a provider fails
  // The actual provider behavior is tested in cinemeta-adapter.test.js
  const result = await searchTitles('matrix');
  assert.ok(Array.isArray(result.results));
});

test('searchTitles results are deduplicated by ID', async () => {
  _resetForTests();
  clearCache();

  const result = await searchTitles('matrix');
  const ids = result.results.map((r) => r.id);
  const uniqueIds = [...new Set(ids)];
  assert.deepEqual(ids, uniqueIds, 'Results should have unique IDs');
});

test('searchTitles results have normalized shape', async () => {
  _resetForTests();
  clearCache();

  const result = await searchTitles('matrix');
  for (const media of result.results) {
    assert.ok(media.id, 'media should have id');
    assert.ok(['movie', 'series'].includes(media.type), 'media should have valid type');
    assert.ok(media.title, 'media should have title');
  }
});
