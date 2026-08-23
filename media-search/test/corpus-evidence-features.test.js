/**
 * Corpus Evidence Feature Projection Tests
 *
 * Produces a normalized evidence object for a candidate containing:
 * - temporal persistence, freshness, firstObserved, lastObserved
 * - volume: observation count, version count, source count
 * - topology hooks (bySource, byIngestion, coObserved)
 * - provider observation isolation
 *
 * Proves:
 * - Features are derived, not stored
 * - Missing evidence yields safe defaults
 * - Identity is preserved (same hash, different fileIndex = different evidence)
 * - Temporal calculations are correct
 * - Topology hooks are lazy and don't throw when no topology provider
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createCorpusEvidenceFeatures } from '../src/lib/discovery/corpus-evidence-features.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

function makeCandidate(overrides = {}) {
  const now = Date.now();
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
    sources: [{ id: 'torrentio.torbox', kind: 'torrentio' }],
    firstSeen: now,
    lastSeen: now,
    ...overrides,
  };
}

// =============================================================================
// Identity
// =============================================================================

test('evidence features respect candidate identity (same hash, different fileIndex)', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH, fileIndex: 0 }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, fileIndex: 1 }));

  // Add observations for fileIndex 0 only
  features.evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: 0,
    observedAt: 10_000,
    source: 'dmm-hashlist',
  });
  features.evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: 0,
    observedAt: 11_000,
    source: 'dmm-hashlist',
  });

  const ev0 = features.getEvidence(HASH, 0);
  const ev1 = features.getEvidence(HASH, 1);

  assert.equal(ev0.volume.observationCount, 2, 'fileIndex 0 has 2 observations');
  assert.equal(ev1.volume.observationCount, 0, 'fileIndex 1 has 0 observations');
  assert.notDeepEqual(ev0, ev1, 'different fileIndex = different evidence');

  cache.close();
});

test('getEvidence returns null-ish defaults for non-existent candidate', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  const ev = features.getEvidence('nonexistent-hash', null);

  assert.equal(ev.hasEvidence(), false);
  assert.equal(ev.temporal.firstObserved, null);
  assert.equal(ev.temporal.lastObserved, null);
  assert.equal(ev.temporal.persistenceMs, 0);
  assert.equal(ev.temporal.freshnessMs, null);
  assert.equal(ev.volume.observationCount, 0);
  assert.equal(ev.volume.versionCount, 0);
  assert.equal(ev.volume.sourceCount, 0);
  assert.deepEqual(ev.sources.list, []);

  cache.close();
});

// =============================================================================
// Temporal features
// =============================================================================

test('temporal.persistenceMs = lastObserved - firstObserved', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 15_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 25_000, source: 'dmm-hashlist' });

  const ev = features.getEvidence(HASH, null);

  assert.equal(ev.temporal.firstObserved, 10_000);
  assert.equal(ev.temporal.lastObserved, 25_000);
  assert.equal(ev.temporal.persistenceMs, 15_000);

  cache.close();
});

test('temporal.freshnessMs = now - lastObserved', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 20_000, source: 'dmm-hashlist' });

  const now = 50_000;
  const ev = features.getEvidence(HASH, null, { now });

  assert.equal(ev.temporal.freshnessMs, 30_000, 'freshness = now - lastObserved');

  cache.close();
});

test('persistenceMs is 0 when only one observation', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });

  const ev = features.getEvidence(HASH, null);

  assert.equal(ev.temporal.firstObserved, 10_000);
  assert.equal(ev.temporal.lastObserved, 10_000);
  assert.equal(ev.temporal.persistenceMs, 0, 'single observation = zero persistence');

  cache.close();
});

test('freshnessMs is null when no observations', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  const ev = features.getEvidence(HASH, null);

  assert.equal(ev.temporal.freshnessMs, null, 'no observations = null freshness');
  assert.equal(ev.temporal.persistenceMs, 0, 'no observations = zero persistence');

  cache.close();
});

// =============================================================================
// Volume features
// =============================================================================

test('volume.observationCount counts all observations', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  for (let i = 0; i < 5; i++) {
    features.evidence.appendCorpusObservation({
      infoHash: HASH,
      observedAt: 10_000 + i * 1000,
      source: 'dmm-hashlist',
    });
  }

  const ev = features.getEvidence(HASH, null);
  assert.equal(ev.volume.observationCount, 5);

  cache.close();
});

test('volume.versionCount counts distinct ingestion_ids', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist', ingestionId: 'run-1',
  });
  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist', ingestionId: 'run-1',
  });
  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 12_000, source: 'dmm-hashlist', ingestionId: 'run-2',
  });
  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 13_000, source: 'dmm-hashlist', ingestionId: 'run-3',
  });
  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 14_000, source: 'dmm-hashlist', // no ingestionId
  });

  const ev = features.getEvidence(HASH, null);
  assert.equal(ev.volume.observationCount, 5);
  assert.equal(ev.volume.versionCount, 3, '3 distinct ingestion_ids');

  cache.close();
});

test('volume.sourceCount counts distinct sources', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 12_000, source: 'scraper' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 13_000, source: 'catalog' });

  const ev = features.getEvidence(HASH, null);
  assert.equal(ev.volume.sourceCount, 3);
  assert.deepEqual(ev.sources.list, ['catalog', 'dmm-hashlist', 'scraper']);

  cache.close();
});

test('sources.counts provides per-source breakdown', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 12_000, source: 'scraper' });

  const ev = features.getEvidence(HASH, null);
  const dmmCount = ev.sources.counts.find((s) => s.source === 'dmm-hashlist');
  const scraperCount = ev.sources.counts.find((s) => s.source === 'scraper');

  assert.equal(dmmCount.count, 2);
  assert.equal(scraperCount.count, 1);

  cache.close();
});

// =============================================================================
// Topology hooks
// =============================================================================

test('topology hooks return empty arrays when no topology provider', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist', ingestionId: 'run-1',
  });

  const ev = features.getEvidence(HASH, null);

  assert.deepEqual(ev.topology.bySource('dmm-hashlist'), []);
  assert.deepEqual(ev.topology.byIngestion('run-1'), []);
  assert.deepEqual(ev.topology.coObserved('fragment-001'), []);

  cache.close();
});

test('topology hooks delegate to topology provider when present', () => {
  const cache = createDiscoveryCache();

  const mockTopology = {
    bySource: (source) => [`${source}-related-hash`],
    byIngestion: (id) => [`${id}-batch-hash`],
    coObserved: (frag) => [`${frag}-coobserved`],
  };

  const features = createCorpusEvidenceFeatures(cache, {
    topologyProvider: () => mockTopology,
  });

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist', ingestionId: 'run-1',
  });

  const ev = features.getEvidence(HASH, null);

  assert.deepEqual(ev.topology.bySource('dmm-hashlist'), ['dmm-hashlist-related-hash']);
  assert.deepEqual(ev.topology.byIngestion('run-1'), ['run-1-batch-hash']);
  assert.deepEqual(ev.topology.coObserved('fragment-001'), ['fragment-001-coobserved']);

  cache.close();
});

test('topology hooks are lazy — topology provider called per-hook invocation', () => {
  const cache = createDiscoveryCache();

  let callCount = 0;
  const mockTopology = {
    bySource: () => [],
    byIngestion: () => [],
    coObserved: () => [],
  };

  const features = createCorpusEvidenceFeatures(cache, {
    topologyProvider: () => {
      callCount++;
      return mockTopology;
    },
  });

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist',
  });

  const ev = features.getEvidence(HASH, null);

  assert.equal(callCount, 0, 'topology provider not called until hooks invoked');

  ev.topology.bySource('dmm-hashlist');
  assert.equal(callCount, 1);

  ev.topology.byIngestion('run-1');
  assert.equal(callCount, 2);

  cache.close();
});

// =============================================================================
// Provider observation isolation
// =============================================================================

test('feature projection does not access provider observations', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());
  cache.recordProviderObservation(HASH, null, 'torbox', {
    cached: true,
    checkedAt: 10_000,
  });

  // Add corpus observation
  features.evidence.appendCorpusObservation({
    infoHash: HASH,
    observedAt: 10_000,
    source: 'dmm-hashlist',
  });

  const ev = features.getEvidence(HASH, null);

  // Provider observations should not appear in features
  assert.equal(ev.volume.observationCount, 1, 'only corpus observation counted');
  assert.ok(!ev.providerObservations, 'provider observations not exposed');
  assert.ok(!ev.cached, 'provider cache state not exposed');

  // Provider observations remain unchanged
  const providerObs = cache.getProviderObservations(HASH, null);
  assert.equal(providerObs.length, 1);
  assert.equal(providerObs[0].provider, 'torbox');

  cache.close();
});

// =============================================================================
// Batch and comparison
// =============================================================================

test('getEvidenceBatch processes multiple candidates', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH3 }));

  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH2, observedAt: 10_000, source: 'dmm-hashlist' });

  const results = features.getEvidenceBatch([
    { infoHash: HASH, fileIndex: null },
    { infoHash: HASH2, fileIndex: null },
    { infoHash: HASH3, fileIndex: null },
  ]);

  assert.equal(results.length, 3);
  assert.equal(results[0].volume.observationCount, 2);
  assert.equal(results[1].volume.observationCount, 1);
  assert.equal(results[2].volume.observationCount, 0);

  cache.close();
});

test('compareEvidence returns relative differences without scoring', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));

  // HASH: 3 observations, first at 10_000, last at 30_000
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 20_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 30_000, source: 'dmm-hashlist' });

  // HASH2: 1 observation at 15_000
  features.evidence.appendCorpusObservation({ infoHash: HASH2, observedAt: 15_000, source: 'dmm-hashlist' });

  const now = 50_000;
  const comparison = features.compareEvidence(HASH, null, HASH2, null, { now });

  assert.equal(comparison.a.volume.observationCount, 3);
  assert.equal(comparison.b.volume.observationCount, 1);

  // persistenceDiff = (30_000 - 10_000) - (15_000 - 15_000) = 20_000 - 0 = 20_000
  assert.equal(comparison.persistenceDiffMs, 20_000);

  // freshnessDiff = (50_000 - 30_000) - (50_000 - 15_000) = 20_000 - 35_000 = -15_000
  assert.equal(comparison.freshnessDiffMs, -15_000);

  // observationCountDiff = 3 - 1 = 2
  assert.equal(comparison.observationCountDiff, 2);

  // shared sources
  assert.deepEqual(comparison.sharedSources, ['dmm-hashlist']);

  cache.close();
});

test('compareEvidence handles missing evidence gracefully', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));

  // HASH: has observations
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });

  // HASH2: no observations

  const comparison = features.compareEvidence(HASH, null, HASH2, null);

  assert.equal(comparison.a.hasEvidence(), true);
  assert.equal(comparison.b.hasEvidence(), false);
  assert.equal(comparison.observationCountDiff, 1);
  assert.equal(comparison.persistenceDiffMs, 0, 'HASH2 has zero persistence');

  cache.close();
});

// =============================================================================
// hasEvidence and rawHistory
// =============================================================================

test('hasEvidence() is true when observations exist, false otherwise', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  const evBefore = features.getEvidence(HASH, null);
  assert.equal(evBefore.hasEvidence(), false);

  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });

  const evAfter = features.getEvidence(HASH, null);
  assert.equal(evAfter.hasEvidence(), true);

  cache.close();
});

test('rawHistory() returns the underlying observation history', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'scraper' });

  const ev = features.getEvidence(HASH, null);
  const history = ev.rawHistory();

  assert.equal(history.length, 2);
  assert.equal(history[0].observedAt, 11_000); // newest first
  assert.equal(history[1].observedAt, 10_000);

  cache.close();
});

// =============================================================================
// Derived features (not stored)
// =============================================================================

test('features are derived on each call — new observations appear', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });

  const ev1 = features.getEvidence(HASH, null);
  assert.equal(ev1.volume.observationCount, 1);
  assert.equal(ev1.temporal.persistenceMs, 0);

  // Add more observations
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 20_000, source: 'dmm-hashlist' });
  features.evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 30_000, source: 'dmm-hashlist' });

  const ev2 = features.getEvidence(HASH, null);
  assert.equal(ev2.volume.observationCount, 3);
  assert.equal(ev2.temporal.persistenceMs, 20_000);
  assert.equal(ev2.temporal.firstObserved, 10_000);
  assert.equal(ev2.temporal.lastObserved, 30_000);

  // ev1 snapshot is unchanged (derived at call time)
  assert.equal(ev1.volume.observationCount, 1);

  cache.close();
});

test('versionCount updates as new ingestion_ids are added', () => {
  const cache = createDiscoveryCache();
  const features = createCorpusEvidenceFeatures(cache);

  cache.upsertCandidate(makeCandidate());

  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist', ingestionId: 'run-1',
  });

  const ev1 = features.getEvidence(HASH, null);
  assert.equal(ev1.volume.versionCount, 1);

  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist', ingestionId: 'run-2',
  });

  const ev2 = features.getEvidence(HASH, null);
  assert.equal(ev2.volume.versionCount, 2);

  // Same ingestion_id doesn't increase count
  features.evidence.appendCorpusObservation({
    infoHash: HASH, observedAt: 12_000, source: 'dmm-hashlist', ingestionId: 'run-1',
  });

  const ev3 = features.getEvidence(HASH, null);
  assert.equal(ev3.volume.versionCount, 2, 'duplicate ingestion_id not counted');

  cache.close();
});
