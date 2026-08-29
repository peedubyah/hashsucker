/**
 * Tests for RD resolution cache
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { getRdResolutionCache } from '../src/lib/providers/realdebrid/rd-resolution-cache.js';

test('getRdResolutionCache: returns null for missing key', () => {
  const cache = getRdResolutionCache();
  cache.clear();
  assert.equal(cache.get('abc123', null), null);
});

test('getRdResolutionCache: stores and retrieves URL', () => {
  const cache = getRdResolutionCache();
  cache.clear();

  cache.set('abc123', null, 'https://example.com/file', 'torrent1', 'file1');
  const result = cache.get('abc123', null);

  assert.ok(result);
  assert.equal(result.url, 'https://example.com/file');
  assert.equal(result.torrentId, 'torrent1');
  assert.equal(result.rdFileId, 'file1');
});

test('getRdResolutionCache: different fileIndex = different key', () => {
  const cache = getRdResolutionCache();
  cache.clear();

  cache.set('abc123', null, 'url1', 't1', 'f1');
  cache.set('abc123', 5, 'url2', 't2', 'f2');

  assert.equal(cache.get('abc123', null).url, 'url1');
  assert.equal(cache.get('abc123', 5).url, 'url2');
});

test('getRdResolutionCache: expires after TTL', async () => {
  const cache = getRdResolutionCache();
  cache.clear();

  cache.set('abc123', null, 'url1', 't1', 'f1', 1); // 1ms TTL
  await new Promise(r => setTimeout(r, 10));

  assert.equal(cache.get('abc123', null), null);
});

test('getRdResolutionCache: getOrInFlight coalesces concurrent requests', async () => {
  const cache = getRdResolutionCache();
  cache.clear();

  let callCount = 0;
  const factory = async () => {
    callCount++;
    await new Promise(r => setTimeout(r, 10));
    return 'result';
  };

  const [r1, r2, r3] = await Promise.all([
    cache.getOrInFlight('key', null, factory),
    cache.getOrInFlight('key', null, factory),
    cache.getOrInFlight('key', null, factory),
  ]);

  assert.equal(callCount, 1); // Only one actual call
  assert.equal(r1, 'result');
  assert.equal(r2, 'result');
  assert.equal(r3, 'result');
});

test('getRdResolutionCache: getOrInFlight allows sequential requests', async () => {
  const cache = getRdResolutionCache();
  cache.clear();

  let callCount = 0;
  const factory = async () => {
    callCount++;
    return 'result';
  };

  await cache.getOrInFlight('key', null, factory);
  await cache.getOrInFlight('key', null, factory);

  assert.equal(callCount, 2);
});
