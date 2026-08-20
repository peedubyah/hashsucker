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
import { ingestCandidates } from '../src/lib/discovery/ingest.js';
import { parseDmmRecord, parseDmmPayload, extractHashFragment, decodeDmmPayload } from '../src/lib/discovery/adapters/dmm.js';
import { enrichCandidate, enrichCandidates, getUnenrichedCandidates } from '../src/lib/discovery/enrichment.js';
import { runEnrichmentWorker, createEnrichmentWorker, enrichSingleCandidate } from '../src/lib/discovery/worker.js';

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

// =============================================================================
// Media Association Model Tests (TDD — must fail before implementation)
// =============================================================================

test('candidate can be associated with a media identifier from a user search', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));

  cache.associateMedia(HASH, null, 'tt2085059:7:3', { source: 'search' });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].mediaId, 'tt2085059:7:3');
  assert.equal(associations[0].source, 'search');
  cache.close();
});

test('same candidate can be associated with multiple media identifiers', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));

  cache.associateMedia(HASH, null, 'tt2085059:7:3', { source: 'search' });
  cache.associateMedia(HASH, null, 'tt2085059:7:4', { source: 'search' });
  cache.associateMedia(HASH, null, 'tt2085059:7:5', { source: 'search' });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 3);
  const mediaIds = associations.map((a) => a.mediaId).sort();
  assert.deepEqual(mediaIds, ['tt2085059:7:3', 'tt2085059:7:4', 'tt2085059:7:5']);
  cache.close();
});

test('background ingestion source can associate candidates with media', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));

  cache.associateMedia(HASH, null, 'tt2085059', {
    source: 'dmm-ingestion',
    confidence: 0.85,
  });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].source, 'dmm-ingestion');
  assert.equal(associations[0].confidence, 0.85);
  cache.close();
});

test('duplicate media association is idempotent', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));

  cache.associateMedia(HASH, null, 'tt2085059:7:3', { source: 'search' });
  cache.associateMedia(HASH, null, 'tt2085059:7:3', { source: 'search' });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  cache.close();
});

test('queryCandidatesByMedia returns candidates for a media identifier', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, title: 'Release A' }));
  cache.upsertCandidate(makeCandidate({ infoHash: OTHER_HASH, title: 'Release B' }));

  cache.associateMedia(HASH, null, 'tt2085059:7:3', { source: 'search' });
  cache.associateMedia(OTHER_HASH, null, 'tt2085059:7:3', { source: 'search' });

  const candidates = cache.queryCandidatesByMedia('tt2085059:7:3');
  assert.equal(candidates.length, 2);
  const hashes = candidates.map((c) => c.infoHash).sort();
  assert.deepEqual(hashes, [HASH, OTHER_HASH].sort());
  cache.close();
});

test('unknown media identity remains valid — candidate with no media association', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));

  // Candidate exists but has no media association
  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 0);

  // Candidate is still retrievable by identity
  const candidate = cache.getCandidate(HASH, null);
  assert.ok(candidate);
  assert.equal(candidate.infoHash, HASH);
  cache.close();
});

test('media association preserves source and confidence metadata', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));

  cache.associateMedia(HASH, null, 'tt2085059:7:3', {
    source: 'search',
    confidence: 1.0,
  });
  cache.associateMedia(HASH, null, 'tt2085059', {
    source: 'dmm-ingestion',
    confidence: 0.75,
  });

  const associations = cache.getMediaAssociations(HASH, null);
  const searchAssoc = associations.find((a) => a.source === 'search');
  const dmmAssoc = associations.find((a) => a.source === 'dmm-ingestion');

  assert.equal(searchAssoc.confidence, 1.0);
  assert.equal(dmmAssoc.confidence, 0.75);
  assert.ok(searchAssoc.associatedAt > 0);
  cache.close();
});

test('candidate with fileIndex associates correctly with media', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, fileIndex: 0 }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, fileIndex: 1 }));

  cache.associateMedia(HASH, 0, 'tt2085059:7:3', { source: 'search' });
  cache.associateMedia(HASH, 1, 'tt2085059:7:4', { source: 'search' });

  const assocFile0 = cache.getMediaAssociations(HASH, 0);
  const assocFile1 = cache.getMediaAssociations(HASH, 1);

  assert.equal(assocFile0.length, 1);
  assert.equal(assocFile0[0].mediaId, 'tt2085059:7:3');
  assert.equal(assocFile1.length, 1);
  assert.equal(assocFile1[0].mediaId, 'tt2085059:7:4');
  cache.close();
});

// =============================================================================
// Cache Read Path Tests (TDD — must fail before implementation)
// =============================================================================

test('queryCachedCandidates returns empty array when no candidates match', () => {
  const cache = createDiscoveryCache();
  const results = cache.queryCachedCandidates({ predicate: () => true });
  assert.deepEqual(results, []);
  cache.close();
});

test('queryCachedCandidates returns all candidates when no predicate given', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: OTHER_HASH }));

  const results = cache.queryCachedCandidates();
  assert.equal(results.length, 2);
  const hashes = results.map((c) => c.infoHash).sort();
  assert.deepEqual(hashes, [HASH, OTHER_HASH].sort());
  cache.close();
});

test('queryCachedCandidates filters by predicate', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, title: 'Match Me' }));
  cache.upsertCandidate(makeCandidate({ infoHash: OTHER_HASH, title: 'No Match' }));

  const results = cache.queryCachedCandidates({
    predicate: (c) => c.title === 'Match Me',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].infoHash, HASH);
  cache.close();
});

test('queryCachedCandidates excludes stale candidates beyond maxAgeMs', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();
  const fresh = makeCandidate({ infoHash: HASH, lastSeen: now });
  const stale = makeCandidate({ infoHash: OTHER_HASH, lastSeen: now - 60000 });

  cache.upsertCandidate(fresh);
  cache.upsertCandidate(stale);

  const results = cache.queryCachedCandidates({ maxAgeMs: 30000 });
  assert.equal(results.length, 1);
  assert.equal(results[0].infoHash, HASH);
  cache.close();
});

test('queryCachedCandidates includes stale candidates when maxAgeMs is not set', () => {
  const cache = createDiscoveryCache();
  const now = Date.now();
  const fresh = makeCandidate({ infoHash: HASH, lastSeen: now });
  const stale = makeCandidate({ infoHash: OTHER_HASH, lastSeen: now - 60000 });

  cache.upsertCandidate(fresh);
  cache.upsertCandidate(stale);

  const results = cache.queryCachedCandidates();
  assert.equal(results.length, 2);
  cache.close();
});

test('queryCachedCandidates attaches provider observations when withObservations is true', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.recordProviderObservation(HASH, null, 'torbox', {
    cached: true,
    evidence: { hit: true },
    checkedAt: Date.now(),
  });
  cache.recordProviderObservation(HASH, null, 'realdebrid', {
    cached: false,
    evidence: null,
    checkedAt: Date.now(),
  });

  const results = cache.queryCachedCandidates({ withObservations: true });
  assert.equal(results.length, 1);
  assert.ok(results[0].observations);
  assert.equal(results[0].observations.length, 2);
  const torbox = results[0].observations.find((o) => o.provider === 'torbox');
  assert.equal(torbox.cached, true);
  cache.close();
});

test('queryCachedCandidates does not attach observations by default', () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.recordProviderObservation(HASH, null, 'torbox', {
    cached: true,
    checkedAt: Date.now(),
  });

  const results = cache.queryCachedCandidates();
  assert.equal(results.length, 1);
  assert.equal(results[0].observations, undefined);
  cache.close();
});

// =============================================================================
// Stale-While-Refresh Tests (TDD — must fail before implementation)
// =============================================================================

import { StaleWhileRefresher } from '../src/lib/discovery/cache.js';

test('StaleWhileRefresher returns fresh cache hit without triggering refresh', async () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, lastSeen: Date.now() }));

  let refreshCalled = false;
  const refresher = new StaleWhileRefresher({
    cache,
    maxAgeMs: 30000,
    refresh: async () => { refreshCalled = true; },
  });

  const result = await refresher.query();
  assert.equal(result.status, 'fresh');
  assert.equal(result.candidates.length, 1);
  assert.equal(refreshCalled, false);
  cache.close();
});

test('StaleWhileRefresher returns stale result and triggers background refresh', async () => {
  const cache = createDiscoveryCache();
  const now = Date.now();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, lastSeen: now - 60000 }));

  let refreshCalled = false;
  const refresher = new StaleWhileRefresher({
    cache,
    maxAgeMs: 30000,
    refresh: async () => { refreshCalled = true; },
  });

  const result = await refresher.query();
  assert.equal(result.status, 'stale');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].infoHash, HASH);
  assert.equal(refreshCalled, true);
  cache.close();
});

test('StaleWhileRefresher triggers refresh on cache miss', async () => {
  const cache = createDiscoveryCache();

  let refreshCalled = false;
  const refresher = new StaleWhileRefresher({
    cache,
    maxAgeMs: 30000,
    refresh: async () => { refreshCalled = true; },
  });

  const result = await refresher.query();
  assert.equal(result.status, 'miss');
  assert.equal(result.candidates.length, 0);
  assert.equal(refreshCalled, true);
  cache.close();
});

test('StaleWhileRefresher serves stale even when refresh throws', async () => {
  const cache = createDiscoveryCache();
  const now = Date.now();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, lastSeen: now - 60000 }));

  const refresher = new StaleWhileRefresher({
    cache,
    maxAgeMs: 30000,
    refresh: async () => { throw new Error('refresh failed'); },
  });

  const result = await refresher.query();
  assert.equal(result.status, 'stale');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].infoHash, HASH);
  cache.close();
});

test('StaleWhileRefresher uses custom predicate for cache queries', async () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, title: 'Match' }));
  cache.upsertCandidate(makeCandidate({ infoHash: OTHER_HASH, title: 'Skip' }));

  const refresher = new StaleWhileRefresher({
    cache,
    maxAgeMs: 30000,
    predicate: (c) => c.title === 'Match',
    refresh: async () => {},
  });

  const result = await refresher.query();
  assert.equal(result.status, 'fresh');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].infoHash, HASH);
  cache.close();
});

test('StaleWhileRefresher attaches observations when withObservations is true', async () => {
  const cache = createDiscoveryCache();
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, lastSeen: Date.now() }));
  cache.recordProviderObservation(HASH, null, 'torbox', {
    cached: true,
    checkedAt: Date.now(),
  });

  const refresher = new StaleWhileRefresher({
    cache,
    maxAgeMs: 30000,
    withObservations: true,
    refresh: async () => {},
  });

  const result = await refresher.query();
  assert.equal(result.status, 'fresh');
  assert.ok(result.candidates[0].observations);
  assert.equal(result.candidates[0].observations.length, 1);
  cache.close();
});

// =============================================================================
// Ingestion Boundary Tests (TDD — must fail before implementation)
// =============================================================================

test('ingestion can create a candidate from external source', () => {
  const cache = createDiscoveryCache();

  const entries = [{
    infoHash: HASH,
    fileIndex: null,
    title: 'External Release',
    filename: 'external.mkv',
    size: 2048,
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  }];

  const result = ingestCandidates(cache, { source: 'dmm-hashlist', entries });
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);

  const stored = cache.getCandidate(HASH, null);
  assert.ok(stored);
  assert.equal(stored.title, 'External Release');
  assert.equal(stored.sources.length, 1);
  assert.equal(stored.sources[0].id, 'dmm.hashlist');
  cache.close();
});

test('ingestion can attach media associations', () => {
  const cache = createDiscoveryCache();

  const entries = [{
    infoHash: HASH,
    fileIndex: null,
    title: 'Release with Media',
    mediaAssociations: [
      { mediaId: 'tt2085059:7:3', confidence: 0.85 },
      { mediaId: 'tt2085059:7:4', confidence: 0.85 },
    ],
  }];

  const result = ingestCandidates(cache, { source: 'dmm-hashlist', entries });
  assert.equal(result.inserted, 1);

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 2);
  assert.equal(associations[0].source, 'dmm-hashlist');
  cache.close();
});

test('ingestion merges with existing live discovery candidate', () => {
  const cache = createDiscoveryCache();

  // First, live discovery creates a candidate
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Live Release',
    filename: 'live.mkv',
    sources: [{ id: 'stremio.torbox', kind: 'stremio' }],
    firstSeen: Date.now() - 10000,
    lastSeen: Date.now() - 10000,
  });

  // Then ingestion adds more data for the same candidate
  const entries = [{
    infoHash: HASH,
    fileIndex: null,
    title: 'Ingested Title',
    filename: 'ingested.mkv',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
    mediaAssociations: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
  }];

  const result = ingestCandidates(cache, { source: 'dmm-hashlist', entries });
  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 1);

  // Sources should be merged (both live discovery and ingestion)
  const stored = cache.getCandidate(HASH, null);
  assert.equal(stored.sources.length, 2);

  // firstSeen preserved from original
  const assoc = cache.getMediaAssociations(HASH, null);
  assert.equal(assoc.length, 1);
  cache.close();
});

test('duplicate ingestion is idempotent', () => {
  const cache = createDiscoveryCache();

  const entries = [{
    infoHash: HASH,
    fileIndex: null,
    title: 'Release',
    mediaAssociations: [{ mediaId: 'tt2085059:7:3' }],
  }];

  const result1 = ingestCandidates(cache, { source: 'dmm-hashlist', entries });
  assert.equal(result1.inserted, 1);

  const result2 = ingestCandidates(cache, { source: 'dmm-hashlist', entries });
  assert.equal(result2.inserted, 0);
  assert.equal(result2.updated, 1);

  // Should still have only one media association
  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  cache.close();
});

test('unknown media candidates remain valid', () => {
  const cache = createDiscoveryCache();

  const entries = [{
    infoHash: HASH,
    fileIndex: null,
    title: 'Unknown Media Release',
    // No mediaAssociations — candidate exists without media identity
  }];

  const result = ingestCandidates(cache, { source: 'dmm-hashlist', entries });
  assert.equal(result.inserted, 1);

  const stored = cache.getCandidate(HASH, null);
  assert.ok(stored);
  assert.equal(stored.infoHash, HASH);

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 0);
  cache.close();
});

test('ingestion does not create provider observations unless supplied', () => {
  const cache = createDiscoveryCache();

  const entries = [{
    infoHash: HASH,
    fileIndex: null,
    title: 'Release',
  }];

  ingestCandidates(cache, { source: 'dmm-hashlist', entries });

  const observations = cache.getProviderObservations(HASH, null);
  assert.equal(observations.length, 0);
  cache.close();
});

test('ingestion preserves source provenance in sources array', () => {
  const cache = createDiscoveryCache();

  const entries = [{
    infoHash: HASH,
    fileIndex: null,
    title: 'Release',
    sources: [{ id: 'catalog.dmm', kind: 'ingestion', name: 'DMM Catalog' }],
  }];

  ingestCandidates(cache, { source: 'dmm-hashlist', entries });

  const stored = cache.getCandidate(HASH, null);
  assert.equal(stored.sources.length, 1);
  assert.equal(stored.sources[0].id, 'catalog.dmm');
  assert.equal(stored.sources[0].kind, 'ingestion');
  cache.close();
});

// =============================================================================
// DMM Hashlist Ingestion Adapter Tests (TDD — must fail before implementation)
// =============================================================================

// Real DMM format: { filename, hash, bytes } — verified from MediaFusion source

test('DMM adapter parses valid record', () => {
  const record = {
    filename: 'Black Mirror S07E03 1080p.mkv',
    hash: HASH,
    bytes: 2147483648,
  };
  const result = parseDmmRecord(record);
  assert.ok(result);
  assert.equal(result.infoHash, HASH);
  assert.equal(result.title, 'Black Mirror S07E03 1080p.mkv');
  assert.equal(result.size, 2147483648);
});

test('DMM adapter ignores malformed record', () => {
  const record = { filename: 'No hash' };
  const result = parseDmmRecord(record);
  assert.equal(result, null);
});

test('DMM adapter ignores record with missing filename', () => {
  const record = { hash: HASH };
  const result = parseDmmRecord(record);
  assert.equal(result, null);
});

test('DMM adapter preserves unknown media identity', () => {
  const record = { filename: 'Mystery Torrent', hash: HASH };
  const result = parseDmmRecord(record);
  assert.ok(result);
  assert.equal(result.mediaAssociations.length, 0);
});

test('DMM adapter handles null bytes', () => {
  const record = { filename: 'Test', hash: HASH };
  const entry = parseDmmRecord(record);
  assert.equal(entry.infoHash, HASH);
  assert.equal(entry.size, null);
});

test('DMM adapter preserves DMM source provenance', () => {
  const record = { filename: 'Test', hash: HASH };
  const entry = parseDmmRecord(record);
  assert.equal(entry.sources.length, 1);
  assert.equal(entry.sources[0].id, 'dmm.hashlist');
  assert.equal(entry.sources[0].kind, 'ingestion');
});

test('DMM adapter sets fileIndex to null', () => {
  const record = { filename: 'Test', hash: HASH };
  const entry = parseDmmRecord(record);
  assert.equal(entry.fileIndex, null);
});

test('DMM adapter parses payload with torrents array', () => {
  const payload = {
    torrents: [
      { filename: 'Release A', hash: HASH, bytes: 1000 },
      { filename: 'Release B', hash: OTHER_HASH, bytes: 2000 },
    ],
  };
  const entries = parseDmmPayload(payload);
  assert.equal(entries.length, 2);
});

test('DMM adapter parses payload as flat array', () => {
  const payload = [
    { filename: 'Release A', hash: HASH, bytes: 1000 },
    { filename: 'Release B', hash: OTHER_HASH, bytes: 2000 },
  ];
  const entries = parseDmmPayload(payload);
  assert.equal(entries.length, 2);
});

test('DMM adapter parses payload as JSON string', () => {
  const payload = JSON.stringify({
    torrents: [
      { filename: 'Release A', hash: HASH, bytes: 1000 },
    ],
  });
  const entries = parseDmmPayload(payload);
  assert.equal(entries.length, 1);
});

test('DMM adapter skips invalid records in payload', () => {
  const payload = {
    torrents: [
      { filename: 'Valid', hash: HASH, bytes: 1000 },
      { filename: 'No hash' },
      { hash: OTHER_HASH }, // No filename
    ],
  };
  const entries = parseDmmPayload(payload);
  assert.equal(entries.length, 1);
});

test('DMM adapter extracts hash fragment from HTML', () => {
  const html = '<iframe src="https://debridmediamanager.com/hashlist#ABC123"></iframe>';
  const fragment = extractHashFragment(html);
  assert.equal(fragment, 'ABC123');
});

test('DMM adapter returns null for invalid HTML', () => {
  const html = '<html><body>No iframe</body></html>';
  const fragment = extractHashFragment(html);
  assert.equal(fragment, null);
});

test('DMM adapter full flow: parse and ingest into cache', () => {
  const cache = createDiscoveryCache();

  const payload = {
    torrents: [
      {
        filename: 'Black Mirror S07E03 1080p.mkv',
        hash: HASH,
        bytes: 2147483648,
      },
      {
        filename: 'Unknown Media Release',
        hash: OTHER_HASH,
        bytes: 1073741824,
      },
    ],
  };

  const entries = parseDmmPayload(payload);
  const result = ingestCandidates(cache, { source: 'dmm-hashlist', entries });

  assert.equal(result.inserted, 2);
  assert.equal(result.associated, 0); // No media associations in real DMM

  // DMM does NOT provide media identity
  const assoc1 = cache.getMediaAssociations(HASH, null);
  assert.equal(assoc1.length, 0);

  // Both retrievable by identity
  assert.ok(cache.getCandidate(HASH, null));
  assert.ok(cache.getCandidate(OTHER_HASH, null));

  // Verify candidate fields
  const candidate = cache.getCandidate(HASH, null);
  assert.equal(candidate.filename, 'Black Mirror S07E03 1080p.mkv');
  assert.equal(candidate.size, 2147483648);
  assert.equal(candidate.fileIndex, null);
  assert.equal(candidate.sources[0].id, 'dmm.hashlist');

  cache.close();
});

test('DMM adapter decode LZString payload', () => {
  // Verify the decoder can handle a simple LZString-encoded payload
  // This is a basic smoke test — real payloads come from DMM
  const encoded = 'Bc5BAQAnDgEABgQCAwAFBAIGAwgJBwgGCQQKBQsHCgcLCQcMBw0JDQEODw0QEBESEBMVFBcWBwEA';
  const decoded = decodeDmmPayload(encoded);
  // May be null for invalid short strings, but should not throw
  assert.ok(decoded === null || typeof decoded === 'string');
});

// =============================================================================
// Metadata Enrichment Boundary Tests (TDD — must fail before implementation)
// =============================================================================

test('enrichment adds media association after ingestion', () => {
  const cache = createDiscoveryCache();

  // Ingest a DMM candidate (no media identity)
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Black Mirror S07E03 1080p.mkv',
    filename: 'Black Mirror S07E03 1080p.mkv',
    size: 2147483648,
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  // Enrich it with parsed media identity
  const result = enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'filename-parser',
    evidence: 'title-match',
  });

  assert.equal(result.associated, 1);
  assert.equal(result.skipped, 0);

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].mediaId, 'tt2085059:7:3');
  assert.equal(associations[0].confidence, 0.9);
  assert.equal(associations[0].source, 'filename-parser');

  cache.close();
});

test('enrichment preserves existing associations', () => {
  const cache = createDiscoveryCache();

  // Ingest and enrich
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.8 }],
    source: 'filename-parser',
  });

  // Enrich again with different media
  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:4', confidence: 0.7 }],
    source: 'filename-parser',
  });

  // Both associations should exist
  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 2);

  cache.close();
});

test('enrichment does not mutate candidate identity', () => {
  const cache = createDiscoveryCache();

  // Ingest
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Original Title',
    size: 1024,
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  // Enrich
  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'filename-parser',
  });

  // Candidate identity unchanged
  const candidate = cache.getCandidate(HASH, null);
  assert.equal(candidate.infoHash, HASH);
  assert.equal(candidate.fileIndex, null);
  assert.equal(candidate.title, 'Original Title');
  assert.equal(candidate.size, 1024);

  cache.close();
});

test('enrichment with empty matches does nothing', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const result = enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [],
    source: 'filename-parser',
  });

  assert.equal(result.associated, 0);
  assert.equal(result.skipped, 0);

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 0);

  cache.close();
});

test('enrichment with null matches does nothing', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const result = enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: null,
    source: 'filename-parser',
  });

  assert.equal(result.associated, 0);
  assert.equal(result.skipped, 0);

  cache.close();
});

test('enrichment with lower confidence does not override higher', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  // First enrichment with high confidence
  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'parser-a',
  });

  // Second enrichment with lower confidence
  const result = enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.5 }],
    source: 'parser-b',
  });

  assert.equal(result.associated, 0);
  assert.equal(result.skipped, 1);

  // Original high-confidence association preserved
  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].confidence, 0.9);
  assert.equal(associations[0].source, 'parser-a');

  cache.close();
});

test('enrichment with higher confidence overrides lower', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  // First enrichment with low confidence
  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.5 }],
    source: 'parser-a',
  });

  // Second enrichment with higher confidence
  const result = enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'parser-b',
  });

  assert.equal(result.associated, 1);

  // Higher confidence association wins
  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].confidence, 0.9);
  assert.equal(associations[0].source, 'parser-b');

  cache.close();
});

test('enrichment preserves source/confidence/evidence metadata', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.85 }],
    source: 'ptt-parser',
    evidence: 'title-match',
  });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations[0].source, 'ptt-parser');
  assert.equal(associations[0].confidence, 0.85);
  assert.ok(associations[0].associatedAt > 0);

  cache.close();
});

test('enrichment does not create provider observations', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'filename-parser',
  });

  // No provider observations should be created
  const observations = cache.getProviderObservations(HASH, null);
  assert.equal(observations.length, 0);

  cache.close();
});

test('getUnenrichedCandidates returns only candidates without media', () => {
  const cache = createDiscoveryCache();

  // Candidate 1: no media association
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Unknown Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  // Candidate 2: has media association
  cache.upsertCandidate({
    infoHash: OTHER_HASH,
    fileIndex: null,
    title: 'Known Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  enrichCandidate(cache, {
    infoHash: OTHER_HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'filename-parser',
  });

  const unenriched = getUnenrichedCandidates(cache);
  assert.equal(unenriched.length, 1);
  assert.equal(unenriched[0].infoHash, HASH);

  cache.close();
});

test('enrichCandidates batch processes multiple enrichments', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Release A',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  cache.upsertCandidate({
    infoHash: OTHER_HASH,
    fileIndex: null,
    title: 'Release B',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const result = enrichCandidates(cache, [
    {
      infoHash: HASH,
      fileIndex: null,
      matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
      source: 'filename-parser',
    },
    {
      infoHash: OTHER_HASH,
      fileIndex: null,
      matches: [{ mediaId: 'tt1234567:1:1', confidence: 0.85 }],
      source: 'filename-parser',
    },
  ]);

  assert.equal(result.associated, 2);
  assert.equal(result.skipped, 0);

  assert.equal(cache.getMediaAssociations(HASH, null).length, 1);
  assert.equal(cache.getMediaAssociations(OTHER_HASH, null).length, 1);

  cache.close();
});

// =============================================================================
// Enrichment Worker Tests (TDD — must fail before implementation)
// =============================================================================

test('worker processes candidates without media associations', async () => {
  const cache = createDiscoveryCache();

  // Ingest candidates without media identity
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Black Mirror S07E03 1080p.mkv',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  cache.upsertCandidate({
    infoHash: OTHER_HASH,
    fileIndex: null,
    title: 'Unknown Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  // Mock enrichment function
  const enrich = async (candidate) => {
    if (candidate.infoHash === HASH) {
      return {
        infoHash: HASH,
        fileIndex: null,
        matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
        source: 'mock-parser',
        evidence: 'title-match',
      };
    }
    return null; // No match for OTHER_HASH
  };

  const stats = await runEnrichmentWorker(cache, { enrich });

  assert.equal(stats.total, 2);
  assert.equal(stats.processed, 2);
  assert.equal(stats.associated, 1);
  assert.equal(stats.failed, 0);

  // HASH should now have media association
  const assoc1 = cache.getMediaAssociations(HASH, null);
  assert.equal(assoc1.length, 1);
  assert.equal(assoc1[0].mediaId, 'tt2085059:7:3');

  // OTHER_HASH should remain unenriched
  const assoc2 = cache.getMediaAssociations(OTHER_HASH, null);
  assert.equal(assoc2.length, 0);

  cache.close();
});

test('worker skips already enriched candidates', async () => {
  const cache = createDiscoveryCache();

  // Ingest and manually enrich one candidate
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Known Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'manual',
  });

  // Ingest another without enrichment
  cache.upsertCandidate({
    infoHash: OTHER_HASH,
    fileIndex: null,
    title: 'Unknown Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const enrich = async (candidate) => {
    return {
      infoHash: candidate.infoHash,
      fileIndex: null,
      matches: [{ mediaId: 'tt1234567:1:1', confidence: 0.8 }],
      source: 'mock-parser',
    };
  };

  const stats = await runEnrichmentWorker(cache, { enrich });

  // Only OTHER_HASH should be processed (HASH already enriched)
  assert.equal(stats.total, 1);
  assert.equal(stats.associated, 1);

  // HASH should still have original association
  const assoc1 = cache.getMediaAssociations(HASH, null);
  assert.equal(assoc1.length, 1);
  assert.equal(assoc1[0].source, 'manual');

  cache.close();
});

test('worker handles enrichment failure without losing candidates', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  cache.upsertCandidate({
    infoHash: OTHER_HASH,
    fileIndex: null,
    title: 'Another Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const enrich = async (candidate) => {
    if (candidate.infoHash === HASH) {
      throw new Error('Parser crashed');
    }
    return {
      infoHash: candidate.infoHash,
      fileIndex: null,
      matches: [{ mediaId: 'tt1234567:1:1', confidence: 0.8 }],
      source: 'mock-parser',
    };
  };

  const stats = await runEnrichmentWorker(cache, { enrich });

  assert.equal(stats.total, 2);
  assert.equal(stats.processed, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.associated, 1);
  assert.equal(stats.errors.length, 1);
  assert.equal(stats.errors[0].infoHash, HASH);

  // OTHER_HASH should still be enriched
  const assoc = cache.getMediaAssociations(OTHER_HASH, null);
  assert.equal(assoc.length, 1);

  // HASH should remain unenriched but candidate still exists
  const candidate = cache.getCandidate(HASH, null);
  assert.ok(candidate);

  cache.close();
});

test('worker preserves confidence/source/evidence metadata', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const enrich = async (candidate) => {
    return {
      infoHash: candidate.infoHash,
      fileIndex: null,
      matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.85 }],
      source: 'ptt-parser',
      evidence: 'title-match',
    };
  };

  await runEnrichmentWorker(cache, { enrich });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations[0].source, 'ptt-parser');
  assert.equal(associations[0].confidence, 0.85);

  cache.close();
});

test('worker respects limit parameter', async () => {
  const cache = createDiscoveryCache();

  // Ingest 5 candidates
  for (let i = 0; i < 5; i++) {
    cache.upsertCandidate({
      infoHash: HASH + i.toString().padStart(2, '0'),
      fileIndex: null,
      title: `Release ${i}`,
      sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
    });
  }

  const enrich = async (candidate) => ({
    infoHash: candidate.infoHash,
    fileIndex: null,
    matches: [{ mediaId: 'tt1234567:1:1', confidence: 0.8 }],
    source: 'mock-parser',
  });

  const stats = await runEnrichmentWorker(cache, { enrich, limit: 3 });

  assert.equal(stats.total, 3);
  assert.equal(stats.associated, 3);

  cache.close();
});

test('worker requires cache parameter', async () => {
  await assert.rejects(
    () => runEnrichmentWorker(null, { enrich: async () => null }),
    /requires a cache/
  );
});

test('worker requires enrich function', async () => {
  const cache = createDiscoveryCache();
  await assert.rejects(
    () => runEnrichmentWorker(cache, {}),
    /requires an enrich function/
  );
  cache.close();
});

test('createEnrichmentWorker returns reusable worker function', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const enrich = async (candidate) => ({
    infoHash: candidate.infoHash,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'mock-parser',
  });

  const worker = createEnrichmentWorker({ enrich });
  const stats = await worker(cache);

  assert.equal(stats.associated, 1);

  cache.close();
});

test('enrichSingleCandidate processes one candidate', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const enrich = async (candidate) => ({
    infoHash: candidate.infoHash,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'mock-parser',
  });

  const result = await enrichSingleCandidate(cache, cache.getCandidate(HASH, null), enrich);

  assert.ok(result);
  assert.equal(result.associated, 1);

  const assoc = cache.getMediaAssociations(HASH, null);
  assert.equal(assoc.length, 1);

  cache.close();
});

test('worker does not create provider observations', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const enrich = async (candidate) => ({
    infoHash: candidate.infoHash,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'mock-parser',
  });

  await runEnrichmentWorker(cache, { enrich });

  const observations = cache.getProviderObservations(HASH, null);
  assert.equal(observations.length, 0);

  cache.close();
});

test('worker progress callback receives updates', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const progressCalls = [];

  const enrich = async (candidate) => ({
    infoHash: candidate.infoHash,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'mock-parser',
  });

  await runEnrichmentWorker(cache, {
    enrich,
    onProgress: (candidate, result) => {
      progressCalls.push({ candidate, result });
    },
  });

  assert.equal(progressCalls.length, 1);
  assert.equal(progressCalls[0].candidate.infoHash, HASH);
  assert.ok(progressCalls[0].result);

  cache.close();
});

// =============================================================================
// Evidence Tracking Tests
// =============================================================================

test('enrichment stores evidence metadata', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Black Mirror S07E03 1080p.mkv',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.94 }],
    source: 'filename-parser',
    evidence: ['title_exact_match', 'year_match', 'movie_pattern'],
  });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.ok(Array.isArray(associations[0].evidence));
  assert.equal(associations[0].evidence.length, 3);
  assert.deepEqual(associations[0].evidence, ['title_exact_match', 'year_match', 'movie_pattern']);

  cache.close();
});

test('enrichment without evidence still works', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'filename-parser',
  });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  // Empty evidence normalized to empty array
  assert.ok(Array.isArray(associations[0].evidence));
  assert.equal(associations[0].evidence.length, 0);

  cache.close();
});

test('existing associations preserve evidence on update', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  // First enrichment with evidence
  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.8 }],
    source: 'parser-a',
    evidence: ['title_match'],
  });

  // Second enrichment with higher confidence and new evidence
  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.95 }],
    source: 'parser-b',
    evidence: ['title_exact_match', 'year_match', 'resolution_match'],
  });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].confidence, 0.95);
  assert.equal(associations[0].source, 'parser-b');
  assert.deepEqual(associations[0].evidence, ['title_exact_match', 'year_match', 'resolution_match']);

  cache.close();
});

test('worker preserves evidence through enrichment', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  const enrich = async (candidate) => ({
    infoHash: candidate.infoHash,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.94 }],
    source: 'ptt-parser',
    evidence: ['title_exact_match', 'year_match', 'movie_pattern'],
  });

  await runEnrichmentWorker(cache, { enrich });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.deepEqual(associations[0].evidence, ['title_exact_match', 'year_match', 'movie_pattern']);

  cache.close();
});

test('duplicate enrichment with equal confidence updates evidence', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  // First enrichment with evidence
  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'parser-a',
    evidence: ['title_match', 'year_match'],
  });

  // Duplicate enrichment with equal confidence - latest wins (>=)
  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'parser-b',
    evidence: ['different_evidence'],
  });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  // Equal confidence overwrites (latest wins)
  assert.deepEqual(associations[0].evidence, ['different_evidence']);
  assert.equal(associations[0].source, 'parser-b');

  cache.close();
});

test('evidence is optional and backwards compatible', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  // Old-style enrichment without evidence
  cache.associateMedia(HASH, null, 'tt2085059:7:3', {
    source: 'legacy-parser',
    confidence: 0.8,
  });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].evidence, null);
  assert.equal(associations[0].source, 'legacy-parser');

  cache.close();
});

test('evidence with single string is normalized to array', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  enrichCandidate(cache, {
    infoHash: HASH,
    fileIndex: null,
    matches: [{ mediaId: 'tt2085059:7:3', confidence: 0.9 }],
    source: 'filename-parser',
    evidence: 'title_match', // Single string, not array
  });

  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 1);
  assert.ok(Array.isArray(associations[0].evidence));
  assert.equal(associations[0].evidence.length, 1);
  assert.equal(associations[0].evidence[0], 'title_match');

  cache.close();
});
