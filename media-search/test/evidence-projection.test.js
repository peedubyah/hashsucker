/**
 * Evidence Projection Tests
 *
 * Proves:
 * - Append-only corpus observations are stored separately from candidates
 * - Candidate first_seen/last_seen are exposed separately from corpus observations
 * - No candidate metadata is duplicated
 * - Provider observations are not modified
 * - Temporal evidence queries work correctly
 * - Future DMM delta ingestion can be supported via append-only log
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createEvidenceProjection } from '../src/lib/discovery/evidence-projection.js';

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
// Schema and initialization
// =============================================================================

test('evidence projection initializes schema on top of existing cache', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  // Schema should exist
  const table = cache.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='corpus_observations'"
  ).get();
  assert.ok(table, 'corpus_observations table should exist');

  // Indexes should exist
  const indexes = cache.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_corpus_observations%'"
  ).all();
  assert.ok(indexes.length >= 2, 'should have at least 2 indexes');

  cache.close();
});

test('evidence projection requires a cache instance', () => {
  assert.throws(() => createEvidenceProjection(null), /requires a cache instance/);
  assert.throws(() => createEvidenceProjection(undefined), /requires a cache instance/);
});

// =============================================================================
// Append-only corpus observations
// =============================================================================

test('appendCorpusObservation records an observation with required fields', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  const result = evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: null,
    observedAt: 10_000,
    source: 'dmm-hashlist',
  });

  assert.ok(result.id, 'should return an id');
  assert.equal(result.infoHash, HASH);
  assert.equal(result.observedAt, 10_000);
  assert.equal(result.source, 'dmm-hashlist');
  assert.equal(result.fileIndexKey, -1, 'null fileIndex normalizes to -1');
  assert.ok(result.recordedAt, 'should have recordedAt timestamp');

  cache.close();
});

test('appendCorpusObservation normalizes fileIndex to fileIndexKey', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  const r1 = evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: 0,
    observedAt: 10_000,
    source: 'dmm-hashlist',
  });
  assert.equal(r1.fileIndexKey, 0);

  const r2 = evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: 5,
    observedAt: 11_000,
    source: 'dmm-hashlist',
  });
  assert.equal(r2.fileIndexKey, 5);

  const r3 = evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: null,
    observedAt: 12_000,
    source: 'dmm-hashlist',
  });
  assert.equal(r3.fileIndexKey, -1);

  cache.close();
});

test('appendCorpusObservation stores optional ingestion_id and fragment_id', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  const result = evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: null,
    observedAt: 10_000,
    source: 'dmm-hashlist',
    ingestionId: 'run-2026-08-23',
    fragmentId: 'fragment-042.html',
  });

  assert.equal(result.ingestionId, 'run-2026-08-23');
  assert.equal(result.fragmentId, 'fragment-042.html');

  // Verify persisted
  const history = evidence.getCorpusObservationHistory(HASH, null);
  assert.equal(history[0].ingestionId, 'run-2026-08-23');
  assert.equal(history[0].fragmentId, 'fragment-042.html');

  cache.close();
});

test('appendCorpusObservation stores JSON evidence blob', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  const result = evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: null,
    observedAt: 10_000,
    source: 'dmm-hashlist',
    evidence: { recordsSeen: 1500, recordsMatched: 42 },
  });

  assert.deepEqual(result.evidence, { recordsSeen: 1500, recordsMatched: 42 });

  const history = evidence.getCorpusObservationHistory(HASH, null);
  assert.deepEqual(history[0].evidence, { recordsSeen: 1500, recordsMatched: 42 });

  cache.close();
});

test('appendCorpusObservation requires infoHash', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  assert.throws(
    () => evidence.appendCorpusObservation({
      observedAt: 10_000,
      source: 'dmm-hashlist',
    }),
    /requires infoHash/
  );

  cache.close();
});

test('appendCorpusObservation requires observedAt', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  assert.throws(
    () => evidence.appendCorpusObservation({
      infoHash: HASH,
      source: 'dmm-hashlist',
    }),
    /requires observedAt/
  );

  cache.close();
});

test('appendCorpusObservation requires source', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  assert.throws(
    () => evidence.appendCorpusObservation({
      infoHash: HASH,
      observedAt: 10_000,
    }),
    /requires source/
  );

  cache.close();
});

test('corpus observations are append-only — multiple observations accumulate', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 12_000, source: 'dmm-hashlist' });

  const count = evidence.countCorpusObservations(HASH, null);
  assert.equal(count, 3);

  const history = evidence.getCorpusObservationHistory(HASH, null);
  assert.equal(history.length, 3);
  // Newest first
  assert.equal(history[0].observedAt, 12_000);
  assert.equal(history[1].observedAt, 11_000);
  assert.equal(history[2].observedAt, 10_000);

  cache.close();
});

// =============================================================================
// Separate from candidate metadata
// =============================================================================

test('corpus observations do not duplicate candidate metadata', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({
    title: 'Test Movie',
    filename: 'test.mkv',
    size: 2048,
  }));

  evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: null,
    observedAt: 10_000,
    source: 'dmm-hashlist',
  });

  // Corpus observation should only have observation fields, not candidate metadata
  const history = evidence.getCorpusObservationHistory(HASH, null);
  const obs = history[0];

  assert.equal(obs.infoHash, HASH);
  assert.equal(obs.observedAt, 10_000);
  assert.equal(obs.source, 'dmm-hashlist');
  // These should NOT exist on corpus observations
  assert.equal(obs.title, undefined, 'should not duplicate title');
  assert.equal(obs.filename, undefined, 'should not duplicate filename');
  assert.equal(obs.size, undefined, 'should not duplicate size');
  assert.equal(obs.metadata, undefined, 'should not duplicate metadata');

  cache.close();
});

test('corpus observations exist independently of candidate', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  // Add observation without candidate existing
  evidence.appendCorpusObservation({
    infoHash: HASH,
    fileIndex: null,
    observedAt: 10_000,
    source: 'dmm-hashlist',
  });

  const count = evidence.countCorpusObservations(HASH, null);
  assert.equal(count, 1);

  // Candidate doesn't exist yet
  const candidate = cache.getCandidate(HASH, null);
  assert.equal(candidate, null);

  cache.close();
});

// =============================================================================
// first_seen / last_seen exposed separately
// =============================================================================

test('getCandidateTimeline exposes first_seen and last_seen from candidate', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  const now = Date.now();
  cache.upsertCandidate(makeCandidate({
    firstSeen: 10_000,
    lastSeen: 50_000,
  }));

  const timeline = evidence.getCandidateTimeline(HASH, null);
  assert.ok(timeline);
  assert.equal(timeline.firstSeen, 10_000);
  assert.equal(timeline.lastSeen, 50_000);

  cache.close();
});

test('getCandidateTimeline returns null for non-existent candidate', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  const timeline = evidence.getCandidateTimeline('nonexistent', null);
  assert.equal(timeline, null);

  cache.close();
});

test('getCandidateTimeline separates corpus observations from candidate timeline', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({
    firstSeen: 10_000,
    lastSeen: 50_000,
  }));

  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 15_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 25_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 35_000, source: 'dmm-hashlist' });

  const timeline = evidence.getCandidateTimeline(HASH, null);

  // Candidate temporal fields
  assert.equal(timeline.firstSeen, 10_000);
  assert.equal(timeline.lastSeen, 50_000);

  // Corpus observation fields
  assert.equal(timeline.corpusObservationCount, 3);
  assert.equal(timeline.corpusObservationRange.earliest, 15_000);
  assert.equal(timeline.corpusObservationRange.latest, 35_000);

  cache.close();
});

// =============================================================================
// Provider observations not modified
// =============================================================================

test('evidence projection does not modify provider observations', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate());
  cache.recordProviderObservation(HASH, null, 'torbox', {
    cached: true,
    evidence: { hit: true },
    checkedAt: Date.now(),
  });

  // Add corpus observation
  evidence.appendCorpusObservation({
    infoHash: HASH,
    observedAt: 10_000,
    source: 'dmm-hashlist',
  });

  // Provider observations unchanged
  const providerObs = cache.getProviderObservations(HASH, null);
  assert.equal(providerObs.length, 1);
  assert.equal(providerObs[0].provider, 'torbox');
  assert.equal(providerObs[0].cached, true);

  // Timeline shows both counts
  const timeline = evidence.getCandidateTimeline(HASH, null);
  assert.equal(timeline.providerObservationCount, 1);
  assert.equal(timeline.corpusObservationCount, 1);

  cache.close();
});

test('corpus observations and provider observations are independent counts', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate());

  // Add 2 corpus observations
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });

  // Add 3 provider observations
  cache.recordProviderObservation(HASH, null, 'torbox', { cached: true, checkedAt: 10_000 });
  cache.recordProviderObservation(HASH, null, 'realdebrid', { cached: false, checkedAt: 10_000 });
  cache.recordProviderObservation(HASH, null, 'alldebrid', { cached: null, checkedAt: 10_000 });

  const timeline = evidence.getCandidateTimeline(HASH, null);
  assert.equal(timeline.corpusObservationCount, 2);
  assert.equal(timeline.providerObservationCount, 3);

  cache.close();
});

// =============================================================================
// Query interface
// =============================================================================

test('getCorpusObservationHistory returns newest first with limit', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  for (let i = 0; i < 10; i++) {
    evidence.appendCorpusObservation({
      infoHash: HASH,
      observedAt: 10_000 + i * 1000,
      source: 'dmm-hashlist',
    });
  }

  const history = evidence.getCorpusObservationHistory(HASH, null, { limit: 5 });
  assert.equal(history.length, 5);
  assert.equal(history[0].observedAt, 19_000);
  assert.equal(history[4].observedAt, 15_000);

  cache.close();
});

test('getCorpusObservationHistory filters by source', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'scraper' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 12_000, source: 'dmm-hashlist' });

  const dmmHistory = evidence.getCorpusObservationHistory(HASH, null, { source: 'dmm-hashlist' });
  assert.equal(dmmHistory.length, 2);
  assert.ok(dmmHistory.every((o) => o.source === 'dmm-hashlist'));

  const scraperHistory = evidence.getCorpusObservationHistory(HASH, null, { source: 'scraper' });
  assert.equal(scraperHistory.length, 1);
  assert.equal(scraperHistory[0].source, 'scraper');

  cache.close();
});

test('getCorpusObservationHistory enforces limit bounds', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  assert.throws(
    () => evidence.getCorpusObservationHistory(HASH, null, { limit: 0 }),
    /limit must be between 1 and 1000/
  );
  assert.throws(
    () => evidence.getCorpusObservationHistory(HASH, null, { limit: 1001 }),
    /limit must be between 1 and 1000/
  );
  assert.throws(
    () => evidence.getCorpusObservationHistory(HASH, null, { limit: -1 }),
    /limit must be between 1 and 1000/
  );

  cache.close();
});

test('countCorpusObservationsBySource groups counts correctly', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 12_000, source: 'scraper' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 13_000, source: 'catalog' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 14_000, source: 'dmm-hashlist' });

  const bySource = evidence.countCorpusObservationsBySource(HASH, null);
  const dmm = bySource.find((s) => s.source === 'dmm-hashlist');
  const scraper = bySource.find((s) => s.source === 'scraper');
  const catalog = bySource.find((s) => s.source === 'catalog');

  assert.equal(dmm.count, 3);
  assert.equal(scraper.count, 1);
  assert.equal(catalog.count, 1);

  cache.close();
});

test('listCorpusSources returns distinct sources in order', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'scraper' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 12_000, source: 'scraper' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 13_000, source: 'catalog' });

  const sources = evidence.listCorpusSources(HASH, null);
  assert.deepEqual(sources, ['catalog', 'dmm-hashlist', 'scraper']);

  cache.close();
});

test('getCorpusObservationRange returns earliest and latest', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 15_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 20_000, source: 'dmm-hashlist' });

  const range = evidence.getCorpusObservationRange(HASH, null);
  assert.equal(range.earliest, 10_000);
  assert.equal(range.latest, 20_000);

  cache.close();
});

test('getCorpusObservationRange returns nulls when no observations', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  const range = evidence.getCorpusObservationRange(HASH, null);
  assert.equal(range.earliest, null);
  assert.equal(range.latest, null);

  cache.close();
});

// =============================================================================
// queryEvidence filters
// =============================================================================

test('queryEvidence filters by minCorpusObservations', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH3 }));

  // HASH: 3 observations
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 12_000, source: 'dmm-hashlist' });

  // HASH2: 1 observation
  evidence.appendCorpusObservation({ infoHash: HASH2, observedAt: 10_000, source: 'dmm-hashlist' });

  // HASH3: 0 observations

  const result = evidence.queryEvidence({ minCorpusObservations: 2 });
  assert.equal(result.length, 1);
  assert.equal(result[0].infoHash, HASH);

  const result2 = evidence.queryEvidence({ minCorpusObservations: 1 });
  assert.equal(result2.length, 2);

  cache.close();
});

test('queryEvidence filters by maxCorpusObservations', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));

  // HASH: 3 observations
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 12_000, source: 'dmm-hashlist' });

  // HASH2: 1 observation
  evidence.appendCorpusObservation({ infoHash: HASH2, observedAt: 10_000, source: 'dmm-hashlist' });

  const result = evidence.queryEvidence({ maxCorpusObservations: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].infoHash, HASH2);

  cache.close();
});

test('queryEvidence filters by hasSource', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));

  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH2, observedAt: 10_000, source: 'scraper' });

  const result = evidence.queryEvidence({ hasSource: 'dmm-hashlist' });
  assert.equal(result.length, 1);
  assert.equal(result[0].infoHash, HASH);

  const result2 = evidence.queryEvidence({ corpusSource: 'scraper' });
  assert.equal(result2.length, 1);
  assert.equal(result2[0].infoHash, HASH2);

  cache.close();
});

test('queryEvidence filters by olderThan', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));

  // HASH: latest observation at 10_000
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });

  // HASH2: latest observation at 20_000
  evidence.appendCorpusObservation({ infoHash: HASH2, observedAt: 20_000, source: 'dmm-hashlist' });

  const result = evidence.queryEvidence({ olderThan: 15_000 });
  assert.equal(result.length, 1);
  assert.equal(result[0].infoHash, HASH);

  cache.close();
});

test('queryEvidence filters by newerThan', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));

  // HASH: earliest observation at 10_000
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });

  // HASH2: earliest observation at 20_000
  evidence.appendCorpusObservation({ infoHash: HASH2, observedAt: 20_000, source: 'dmm-hashlist' });

  const result = evidence.queryEvidence({ newerThan: 15_000 });
  assert.equal(result.length, 1);
  assert.equal(result[0].infoHash, HASH2);

  cache.close();
});

test('queryEvidence filters by maxProviderObservations', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));

  // HASH: 2 provider observations
  cache.recordProviderObservation(HASH, null, 'torbox', { cached: true, checkedAt: 10_000 });
  cache.recordProviderObservation(HASH, null, 'realdebrid', { cached: false, checkedAt: 10_000 });

  // HASH2: 1 provider observation
  cache.recordProviderObservation(HASH2, null, 'torbox', { cached: true, checkedAt: 10_000 });

  const result = evidence.queryEvidence({ maxProviderObservations: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].infoHash, HASH2);

  cache.close();
});

test('queryEvidence combines multiple filters', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH2 }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH3 }));

  // HASH: 3 dmm observations, 1 provider obs
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 11_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, observedAt: 12_000, source: 'dmm-hashlist' });
  cache.recordProviderObservation(HASH, null, 'torbox', { cached: true, checkedAt: 10_000 });

  // HASH2: 2 dmm observations, 3 provider obs
  evidence.appendCorpusObservation({ infoHash: HASH2, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH2, observedAt: 11_000, source: 'dmm-hashlist' });
  cache.recordProviderObservation(HASH2, null, 'torbox', { cached: true, checkedAt: 10_000 });
  cache.recordProviderObservation(HASH2, null, 'realdebrid', { cached: false, checkedAt: 10_000 });
  cache.recordProviderObservation(HASH2, null, 'alldebrid', { cached: null, checkedAt: 10_000 });

  // HASH3: 1 scraper observation, 0 provider obs
  evidence.appendCorpusObservation({ infoHash: HASH3, observedAt: 10_000, source: 'scraper' });

  // Filter: at least 2 corpus obs, from dmm-hashlist, at most 1 provider obs
  const result = evidence.queryEvidence({
    minCorpusObservations: 2,
    hasSource: 'dmm-hashlist',
    maxProviderObservations: 1,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].infoHash, HASH);

  cache.close();
});

// =============================================================================
// Identity separation (same hash, different fileIndex)
// =============================================================================

test('corpus observations respect identity separation by fileIndex', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  cache.upsertCandidate(makeCandidate({ infoHash: HASH, fileIndex: 0 }));
  cache.upsertCandidate(makeCandidate({ infoHash: HASH, fileIndex: 1 }));

  evidence.appendCorpusObservation({ infoHash: HASH, fileIndex: 0, observedAt: 10_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, fileIndex: 0, observedAt: 11_000, source: 'dmm-hashlist' });
  evidence.appendCorpusObservation({ infoHash: HASH, fileIndex: 1, observedAt: 10_000, source: 'dmm-hashlist' });

  assert.equal(evidence.countCorpusObservations(HASH, 0), 2);
  assert.equal(evidence.countCorpusObservations(HASH, 1), 1);
  assert.equal(evidence.countCorpusObservations(HASH, null), 0);

  cache.close();
});

// =============================================================================
// Future DMM delta ingestion support
// =============================================================================

test('appendCorpusObservation supports ingestion_id for batch tracking', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  // Simulate a batch ingestion run
  evidence.appendCorpusObservation({
    infoHash: HASH,
    observedAt: 10_000,
    source: 'dmm-hashlist',
    ingestionId: 'dmm-run-2026-08-23',
    fragmentId: 'fragment-001.html',
  });
  evidence.appendCorpusObservation({
    infoHash: HASH2,
    observedAt: 10_000,
    source: 'dmm-hashlist',
    ingestionId: 'dmm-run-2026-08-23',
    fragmentId: 'fragment-001.html',
  });
  evidence.appendCorpusObservation({
    infoHash: HASH,
    observedAt: 11_000,
    source: 'dmm-hashlist',
    ingestionId: 'dmm-run-2026-08-23',
    fragmentId: 'fragment-002.html',
  });

  // Query by ingestion run
  const allHistory = evidence.getCorpusObservationHistory(HASH, null);
  assert.equal(allHistory.length, 2);

  // All observations have the ingestionId
  assert.ok(allHistory.every((o) => o.ingestionId === 'dmm-run-2026-08-23'));

  cache.close();
});

test('corpus observations can be used to detect delta (new/removed hashes)', () => {
  const cache = createDiscoveryCache();
  const evidence = createEvidenceProjection(cache);

  // First ingestion run
  evidence.appendCorpusObservation({
    infoHash: HASH,
    observedAt: 10_000,
    source: 'dmm-hashlist',
    ingestionId: 'run-1',
  });
  evidence.appendCorpusObservation({
    infoHash: HASH2,
    observedAt: 10_000,
    source: 'dmm-hashlist',
    ingestionId: 'run-1',
  });

  // Second ingestion run
  evidence.appendCorpusObservation({
    infoHash: HASH,
    observedAt: 20_000,
    source: 'dmm-hashlist',
    ingestionId: 'run-2',
  });
  evidence.appendCorpusObservation({
    infoHash: HASH3,
    observedAt: 20_000,
    source: 'dmm-hashlist',
    ingestionId: 'run-2',
  });

  // HASH: observed in both runs (persistent)
  const hashRange = evidence.getCorpusObservationRange(HASH, null);
  assert.equal(hashRange.earliest, 10_000);
  assert.equal(hashRange.latest, 20_000);
  assert.equal(evidence.countCorpusObservations(HASH, null), 2);

  // HASH2: only in run-1 (potentially removed in run-2)
  const hash2Range = evidence.getCorpusObservationRange(HASH2, null);
  assert.equal(hash2Range.earliest, 10_000);
  assert.equal(hash2Range.latest, 10_000);

  // HASH3: only in run-2 (new in run-2)
  const hash3Range = evidence.getCorpusObservationRange(HASH3, null);
  assert.equal(hash3Range.earliest, 20_000);
  assert.equal(hash3Range.latest, 20_000);

  cache.close();
});

// =============================================================================
// Persistence
// =============================================================================

test('corpus observations persist across cache reopen', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hashsucker-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'cache.db');

  const cache1 = createDiscoveryCache({ dbPath });
  const evidence1 = createEvidenceProjection(cache1);

  evidence1.appendCorpusObservation({
    infoHash: HASH,
    observedAt: 10_000,
    source: 'dmm-hashlist',
    ingestionId: 'run-1',
  });

  cache1.close();

  const cache2 = createDiscoveryCache({ dbPath });
  const evidence2 = createEvidenceProjection(cache2);

  const count = evidence2.countCorpusObservations(HASH, null);
  assert.equal(count, 1);

  const history = evidence2.getCorpusObservationHistory(HASH, null);
  assert.equal(history[0].observedAt, 10_000);
  assert.equal(history[0].ingestionId, 'run-1');

  cache2.close();
});
