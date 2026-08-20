/**
 * Discovery Candidate Cache Tests
 *
 * Proves:
 * - Identity is exactly (infoHash, fileIndex)
 * - Same hash/fileIndex updates existing candidate
 * - Same hash/different fileIndex remains separate
 * - Multiple sources merge into sources[]
 * - Provider observations expire/refresh independently
 * - Cache failure does not break discovery
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache, withCacheFailureIsolation } from '../src/lib/discovery/cache.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const THIRD_HASH = 'cccccccccccccccccccccccccccccccccccccccc';

function makeCandidate(overrides = {}) {
  return {
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    filename: 'test.mkv',
    size: 1024,
    seeders: 10,
    leechers: 2,
    publishDate: '2026-08-20T00:00:00.000Z',
    magnet: `magnet:?xt=urn:btih:${HASH}`,
    downloadUrl: null,
    metadata: { resolution: '1080p' },
    sources: [{ id: 'stremio.torbox', kind: 'stremio' }],
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    ...overrides,
  };
}

test('same hash and fileIndex updates existing candidate', () => {
  const cache = createDiscoveryCache();
  const first = makeCandidate({ title: 'Original', size: 1000 });
  cache.upsertCandidate(first);

  const second = makeCandidate({ title: 'Updated', size: 2000 });
  cache.upsertCandidate(second);

  const stored = cache.getCandidate(HASH, null);
  assert.equal(stored.title, 'Updated');
  assert.equal(stored.size, 2000);
  assert.equal(stored.infoHash, HASH);
  assert.equal(stored.fileIndex, null);
  cache.close();
});

test('same hash with different fileIndex remains separate candidate', () => {
  const cache = createDiscoveryCache();
  const file0 = makeCandidate({ fileIndex: 0, title: 'File 0' });
  const file1 = makeCandidate({ fileIndex: 1, title: 'File 1' });

  cache.upsertCandidate(file0);
  cache.upsertCandidate(file1);

  const stored0 = cache.getCandidate(HASH, 0);
  const stored1 = cache.getCandidate(HASH, 1);

  assert.equal(stored0.title, 'File 0');
  assert.equal(stored1.title, 'File 1');
  assert.notEqual(stored0.fileIndex, stored1.fileIndex);
  cache.close();
});

test('multiple sources merge into sources array without duplicates', () => {
  const cache = createDiscoveryCache();
  const first = makeCandidate({
    sources: [{ id: 'stremio.torbox', kind: 'stremio' }],
  });
  cache.upsertCandidate(first);

  const second = makeCandidate({
    sources: [{ id: 'torznab.0', kind: 'torznab' }],
  });
  cache.upsertCandidate(second);

  const third = makeCandidate({
    sources: [
      { id: 'stremio.torbox', kind: 'stremio' },
      { id: 'comet.manual', kind: 'stremio' },
    ],
  });
  cache.upsertCandidate(third);

  const stored = cache.getCandidate(HASH, null);
  assert.equal(stored.sources.length, 3);
  const ids = stored.sources.map((s) => s.id).sort();
  assert.deepEqual(ids, ['comet.manual', 'stremio.torbox', 'torznab.0']);
  cache.close();
});

test('provider observations are stored separately and refresh independently', () => {
  const cache = createDiscoveryCache();
  const candidate = makeCandidate();
  cache.upsertCandidate(candidate);

  cache.recordProviderObservation(HASH, null, 'torbox', {
    cached: true,
    evidence: { hit: true },
    checkedAt: Date.now(),
  });

  cache.recordProviderObservation(HASH, null, 'realdebrid', {
    cached: null,
    evidence: null,
    checkedAt: Date.now(),
  });

  const observations = cache.getProviderObservations(HASH, null);
  assert.equal(observations.length, 2);

  const torbox = observations.find((o) => o.provider === 'torbox');
  const rd = observations.find((o) => o.provider === 'realdebrid');
  assert.equal(torbox.cached, true);
  assert.deepEqual(torbox.evidence, { hit: true });
  assert.equal(rd.cached, null);

  // Refresh torbox observation independently
  cache.recordProviderObservation(HASH, null, 'torbox', {
    cached: false,
    evidence: { expired: true },
    checkedAt: Date.now() + 1000,
  });

  const refreshed = cache.getProviderObservations(HASH, null);
  const torboxRefreshed = refreshed.find((o) => o.provider === 'torbox');
  assert.equal(torboxRefreshed.cached, false);
  assert.deepEqual(torboxRefreshed.evidence, { expired: true });

  // Real-Debrid observation unchanged
  const rdAfter = refreshed.find((o) => o.provider === 'realdebrid');
  assert.equal(rdAfter.cached, null);
  cache.close();
});

test('ingestCandidate returns error instead of throwing on cache failure', () => {
  const cache = createDiscoveryCache();
  // Force a failure by closing the cache mid-operation
  cache.close();

  const result = cache.ingestCandidate(makeCandidate());
  assert.ok(result.error instanceof Error);
  assert.equal(result.candidate, null);
});

test('withCacheFailureIsolation swallows errors and returns safe result', async () => {
  const failingCache = {
    ingestCandidate: async () => { throw new Error('disk full'); },
    recordProviderObservation: async () => { throw new Error('disk full'); },
    upsertCandidate: async () => { throw new Error('disk full'); },
  };

  const safe = withCacheFailureIsolation(failingCache, () => {});

  const ingestResult = await safe.ingestCandidate(makeCandidate());
  assert.ok(ingestResult.error instanceof Error);
  assert.equal(ingestResult.error.message, 'disk full');

  // These should not throw
  await safe.recordProviderObservation(HASH, null, 'torbox', { cached: true });
  const upsertResult = await safe.upsertCandidate(makeCandidate());
  assert.equal(upsertResult, null);
});

test('cache failure does not break discovery integration', async () => {
  // Simulates the search.js integration: cache write fails, but discovery
  // results are still returned to the caller.
  const failingCache = {
    ingestCandidate: async () => { throw new Error('cache down'); },
    recordProviderObservation: async () => { throw new Error('cache down'); },
  };
  const safe = withCacheFailureIsolation(failingCache, () => {});

  const discoveryResults = [makeCandidate(), makeCandidate({ infoHash: OTHER_HASH })];

  // Simulate write-through loop from search.js
  for (const candidate of discoveryResults) {
    const result = await safe.ingestCandidate(candidate);
    assert.ok(result.error instanceof Error);
  }

  // Discovery results are still available even though cache failed
  assert.equal(discoveryResults.length, 2);
  assert.equal(discoveryResults[0].infoHash, HASH);
  assert.equal(discoveryResults[1].infoHash, OTHER_HASH);
});

test('firstSeen is preserved on update, lastSeen is updated', () => {
  const cache = createDiscoveryCache();
  const originalTime = Date.now() - 10000;
  const first = makeCandidate({ firstSeen: originalTime, lastSeen: originalTime });
  cache.upsertCandidate(first);

  const second = makeCandidate({ lastSeen: Date.now() });
  cache.upsertCandidate(second);

  const stored = cache.getCandidate(HASH, null);
  assert.equal(stored.firstSeen, originalTime);
  assert.ok(stored.lastSeen >= originalTime);
  cache.close();
});

test('distinct hashes remain distinct', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: OTHER_HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: THIRD_HASH }));

  assert.ok(cache.getCandidate(HASH, null));
  assert.ok(cache.getCandidate(OTHER_HASH, null));
  assert.ok(cache.getCandidate(THIRD_HASH, null));
  assert.equal(cache.getCandidate(HASH, null).infoHash, HASH);
  assert.equal(cache.getCandidate(OTHER_HASH, null).infoHash, OTHER_HASH);
  cache.close();
});

test('metadata is preserved and extended on update', () => {
  const cache = createDiscoveryCache();
  const first = makeCandidate({ metadata: { resolution: '1080p' } });
  cache.upsertCandidate(first);

  const second = makeCandidate({ metadata: { resolution: '1080p', codec: 'x265' } });
  cache.upsertCandidate(second);

  const stored = cache.getCandidate(HASH, null);
  assert.equal(stored.metadata.resolution, '1080p');
  assert.equal(stored.metadata.codec, 'x265');
  cache.close();
});

test('null fileIndex is treated as -1 for identity', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ fileIndex: null }));
  cache.upsertCandidate(makeCandidate({ fileIndex: 0 }));

  // null and 0 are different fileIndex values
  const nullCandidate = cache.getCandidate(HASH, null);
  const zeroCandidate = cache.getCandidate(HASH, 0);

  assert.ok(nullCandidate);
  assert.ok(zeroCandidate);
  assert.notEqual(nullCandidate.fileIndex, zeroCandidate.fileIndex);
  cache.close();
});
