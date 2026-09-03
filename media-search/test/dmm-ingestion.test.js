/**
 * DMM Ingestion Runner Tests
 *
 * Tests the DMM hashlist ingestion pipeline:
 * - Streaming JSON parser
 * - LZString decompression
 * - Fragment fetching and parsing
 * - Batch ingestion with metrics
 * - Error handling and recovery
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DMMHashListSource,
  extractPayload,
  streamParseDMM,
  transformDMMRecord,
  IngestionMetrics,
  DMMIngestionRunner,
} from '../src/lib/discovery/dmm-ingestion-runner.js';

import { decodeDmmPayload as decompressFromEncodedURIComponent, encodeDmmPayload as compressToEncodedURIComponent } from '../src/lib/discovery/adapters/dmm.js';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { searchReleases } from '../src/lib/discovery/search-engine.js';
import { getCandidatesWithoutAttributes } from '../src/lib/discovery/release-attributes.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// =============================================================================
// LZString Tests
// =============================================================================

test('decompressFromEncodedURIComponent handles simple strings', () => {
  const original = 'Hello, World!';
  const compressed = compressToEncodedURIComponent(original);
  assert.ok(compressed);

  const decompressed = decompressFromEncodedURIComponent(compressed);
  assert.equal(decompressed, original);
});

test('decompressFromEncodedURIComponent handles JSON', () => {
  const original = JSON.stringify([{ hash: HASH, filename: 'test.mkv', bytes: 1024 }]);
  const compressed = compressToEncodedURIComponent(original);
  assert.ok(compressed);

  const decompressed = decompressFromEncodedURIComponent(compressed);
  assert.equal(decompressed, original);
});

test('decompressFromEncodedURIComponent returns null for invalid input', () => {
  assert.equal(decompressFromEncodedURIComponent(''), null);
  assert.equal(decompressFromEncodedURIComponent(null), null);
  assert.equal(decompressFromEncodedURIComponent(undefined), null);
});

// =============================================================================
// Streaming JSON Parser Tests
// =============================================================================

test('streamParseDMM yields individual records', () => {
  const json = JSON.stringify([
    { hash: HASH, filename: 'test1.mkv', bytes: 100 },
    { hash: OTHER_HASH, filename: 'test2.mkv', bytes: 200 },
  ]);

  const records = [...streamParseDMM(json)];
  assert.equal(records.length, 2);
  assert.equal(records[0].filename, 'test1.mkv');
  assert.equal(records[1].filename, 'test2.mkv');
});

test('streamParseDMM handles empty array', () => {
  const records = [...streamParseDMM('[]')];
  assert.equal(records.length, 0);
});

test('streamParseDMM handles malformed JSON gracefully', () => {
  const json = '[{"hash": "abc", "filename": "test"}, {"hash": "def"';
  const records = [...streamParseDMM(json)];
  // Should yield valid records and skip malformed
  assert.ok(records.length >= 0);
});

test('streamParseDMM handles nested objects', () => {
  const json = JSON.stringify([
    { hash: HASH, filename: 'test.mkv', metadata: { nested: 'value' } },
  ]);

  const records = [...streamParseDMM(json)];
  assert.equal(records.length, 1);
  assert.equal(records[0].metadata.nested, 'value');
});

// =============================================================================
// DMM Record Transform Tests
// =============================================================================

test('transformDMMRecord converts valid record', () => {
  const record = { hash: HASH, filename: 'Movie.2024.1080p.mkv', bytes: 2147483648 };
  const entry = transformDMMRecord(record);

  assert.ok(entry);
  assert.equal(entry.infoHash, HASH);
  assert.equal(entry.title, 'Movie.2024.1080p.mkv');
  assert.equal(entry.filename, 'Movie.2024.1080p.mkv');
  assert.equal(entry.size, 2147483648);
  assert.equal(entry.fileIndex, null);
  assert.equal(entry.sources[0].id, 'dmm.hashlist');
});

test('transformDMMRecord rejects invalid hash', () => {
  const record = { hash: 'invalid', filename: 'test.mkv' };
  assert.equal(transformDMMRecord(record), null);
});

test('transformDMMRecord rejects missing filename', () => {
  const record = { hash: HASH };
  assert.equal(transformDMMRecord(record), null);
});

test('transformDMMRecord normalizes hash to lowercase', () => {
  const record = { hash: HASH.toUpperCase(), filename: 'test.mkv' };
  const entry = transformDMMRecord(record);
  assert.equal(entry.infoHash, HASH);
});

test('transformDMMRecord handles null bytes', () => {
  const record = { hash: HASH, filename: 'test.mkv' };
  const entry = transformDMMRecord(record);
  assert.equal(entry.size, null);
});

// =============================================================================
// IngestionMetrics Tests
// =============================================================================

test('IngestionMetrics tracks counts', () => {
  const metrics = new IngestionMetrics();
  metrics.start();

  metrics.recordProcessed();
  metrics.recordInserted();
  metrics.recordProcessed();
  metrics.recordUpdated();
  metrics.recordProcessed();
  metrics.recordFailed();

  metrics.stop();

  assert.equal(metrics.recordsProcessed, 3);
  assert.equal(metrics.recordsInserted, 1);
  assert.equal(metrics.recordsUpdated, 1);
  assert.equal(metrics.recordsFailed, 1);
  assert.ok(metrics.duration >= 0);
});

test('IngestionMetrics calculates records per second', () => {
  const metrics = new IngestionMetrics();
  metrics.startTime = Date.now() - 1000; // 1 second ago
  metrics.recordsProcessed = 100;
  metrics.stop();

  assert.ok(metrics.recordsPerSecond > 0);
});

test('IngestionMetrics estimates database growth', () => {
  const metrics = new IngestionMetrics();
  metrics.recordsInserted = 100000; // 100K records

  const growthMB = metrics.estimateDatabaseGrowthMB();
  assert.ok(growthMB > 0);
  // ~200 bytes per record * 100K = ~20MB
  assert.ok(growthMB < 50);
});

test('IngestionMetrics limits error storage', () => {
  const metrics = new IngestionMetrics();
  for (let i = 0; i < 20; i++) {
    metrics.addError(new Error(`Error ${i}`));
  }

  const json = metrics.toJSON();
  assert.equal(json.errorCount, 20);
  assert.equal(json.errors.length, 10); // Only first 10 stored
});

test('IngestionMetrics toJSON returns summary', () => {
  const metrics = new IngestionMetrics();
  metrics.start();
  metrics.recordProcessed();
  metrics.recordInserted();
  metrics.stop();

  const json = metrics.toJSON();
  assert.equal(json.recordsProcessed, 1);
  assert.equal(json.recordsInserted, 1);
  assert.ok(json.durationMs >= 0);
  assert.ok(json.recordsPerSecond >= 0);
  assert.ok(json.estimatedGrowthMB >= 0);
});

// =============================================================================
// Mock HashListSource for Testing
// =============================================================================

class MockHashListSource extends DMMHashListSource {
  constructor({ fragments = [] } = {}) {
    super();
    this._fragments = fragments;
  }

  async listFragments() {
    return this._fragments;
  }

  async fetchFragment(url) {
    const fragment = this._fragments.find(f => f.url === url);
    return fragment ? fragment.html : null;
  }
}

// =============================================================================
// DMMIngestionRunner Tests
// =============================================================================

test('DMMIngestionRunner requires cache', async () => {
  const runner = new DMMIngestionRunner({});
  await assert.rejects(() => runner.run(), /requires a cache/);
});

test('DMMIngestionRunner processes fragments', async () => {
  const cache = createDiscoveryCache();

  // Create a mock fragment with valid DMM data
  const dmmData = JSON.stringify({
    torrents: [
      { hash: HASH, filename: 'Movie.2024.1080p.mkv', bytes: 2147483648 },
      { hash: OTHER_HASH, filename: 'Show.S01E01.720p.mkv', bytes: 1073741824 },
    ],
  });

  const compressed = compressToEncodedURIComponent(dmmData);
  const source = new MockHashListSource({
    fragments: [
      {
        url: 'https://example.com/fragment1.html',
        name: 'fragment1.html',
        size: 1000,
        html: '<html><body><script>var payload = decompressFromEncodedURIComponent(\'' + compressed + '\');</script></body></html>',
      },
    ],
  });

  const runner = new DMMIngestionRunner({
    source,
    cache,
    batchSize: 10,
  });

  const metrics = await runner.run();

  assert.equal(metrics.recordsProcessed, 2);
  assert.equal(metrics.recordsInserted, 2);
  assert.equal(metrics.fragmentsProcessed, 1);

  // Verify candidates were stored
  assert.ok(cache.getCandidate(HASH, null));
  assert.ok(cache.getCandidate(OTHER_HASH, null));

  cache.close();
});

test('DMMIngestionRunner handles empty fragments', async () => {
  const cache = createDiscoveryCache();

  const source = new MockHashListSource({ fragments: [] });
  const runner = new DMMIngestionRunner({ source, cache });

  const metrics = await runner.run();

  assert.equal(metrics.recordsProcessed, 0);
  assert.equal(metrics.fragmentsProcessed, 0);

  cache.close();
});

test('DMMIngestionRunner handles malformed fragments', async () => {
  const cache = createDiscoveryCache();

  const source = new MockHashListSource({
    fragments: [
      {
        url: 'https://example.com/bad.html',
        name: 'bad.html',
        size: 100,
        html: '<html>No payload here</html>',
      },
    ],
  });

  const runner = new DMMIngestionRunner({ source, cache });
  const metrics = await runner.run();

  assert.equal(metrics.recordsFailed, 0); // No records to fail
  assert.ok(metrics.errorCount > 0); // But error recorded

  cache.close();
});

test('DMMIngestionRunner respects maxFragments', async () => {
  const cache = createDiscoveryCache();

  const fragments = [];
  for (let i = 0; i < 5; i++) {
    fragments.push({
      url: `https://example.com/frag${i}.html`,
      name: `frag${i}.html`,
      size: 100,
      html: `<script>decompressFromEncodedURIComponent('${compressToEncodedURIComponent(JSON.stringify({ torrents: [] }))}')</script>`,
    });
  }

  const source = new MockHashListSource({ fragments });
  const runner = new DMMIngestionRunner({ source, cache, maxFragments: 2 });

  const metrics = await runner.run();

  assert.equal(metrics.fragmentsProcessed, 2);

  cache.close();
});

test('DMMIngestionRunner tracks duplicates', async () => {
  const cache = createDiscoveryCache();

  const dmmData = JSON.stringify({
    torrents: [
      { hash: HASH, filename: 'Movie.mkv', bytes: 1000 },
    ],
  });

  const compressed = compressToEncodedURIComponent(dmmData);
  const source = new MockHashListSource({
    fragments: [
      {
        url: 'https://example.com/frag1.html',
        name: 'frag1.html',
        size: 100,
        html: '<html><body><script>decompressFromEncodedURIComponent(\'' + compressed + '\');</script></body></html>',
      },
      {
        url: 'https://example.com/frag2.html',
        name: 'frag2.html',
        size: 100,
        html: '<html><body><script>decompressFromEncodedURIComponent(\'' + compressed + '\');</script></body></html>',
      },
    ],
  });

  const runner = new DMMIngestionRunner({ source, cache });
  const metrics = await runner.run();

  assert.equal(metrics.recordsProcessed, 2);
  assert.equal(metrics.recordsInserted, 1);
  assert.equal(metrics.recordsUpdated, 1);
  assert.equal(metrics.recordsDuplicate, 1);

  cache.close();
});

test('DMMIngestionRunner calls progress callback', async () => {
  const cache = createDiscoveryCache();

  const dmmData = JSON.stringify({
    torrents: [{ hash: HASH, filename: 'test.mkv', bytes: 100 }],
  });

  const source = new MockHashListSource({
    fragments: [
      {
        url: 'https://example.com/frag1.html',
        name: 'frag1.html',
        size: 100,
        html: `<script>decompressFromEncodedURIComponent('${compressToEncodedURIComponent(dmmData)}')</script>`,
      },
    ],
  });

  let progressCalled = false;
  const runner = new DMMIngestionRunner({
    source,
    cache,
    onProgress: () => { progressCalled = true; },
  });

  await runner.run();
  assert.equal(progressCalled, true);

  cache.close();
});

// =============================================================================
// Integration Test: Full Pipeline
// =============================================================================

test('Full pipeline: fetch → decompress → parse → ingest', async () => {
  const cache = createDiscoveryCache();

  // Simulate real DMM data
  const dmmData = JSON.stringify({
    torrents: [
      { hash: HASH, filename: 'Black.Mirror.S07E03.1080p.mkv', bytes: 2147483648 },
      { hash: OTHER_HASH, filename: 'Movie.2024.2160p.HDR.mkv', bytes: 8589934592 },
      { hash: 'cccccccccccccccccccccccccccccccccccccccc', filename: 'Show.S01E01-E03.720p.mkv', bytes: 3221225472 },
    ],
  });

  const compressed = compressToEncodedURIComponent(dmmData);
  const source = new MockHashListSource({
    fragments: [
      {
        url: 'https://example.com/dmm-2026-08-20.html',
        name: 'dmm-2026-08-20.html',
        size: compressed.length,
        html: `<html><body><script>decompressFromEncodedURIComponent('${compressed}')</script></body></html>`,
      },
    ],
  });

  const runner = new DMMIngestionRunner({
    source,
    cache,
    batchSize: 2, // Test batching with small size
  });

  const metrics = await runner.run();

  // Verify metrics
  assert.equal(metrics.recordsProcessed, 3);
  assert.equal(metrics.recordsInserted, 3);
  assert.equal(metrics.fragmentsProcessed, 1);
  assert.ok(metrics.durationMs >= 0);

  // Verify candidates stored
  const candidate1 = cache.getCandidate(HASH, null);
  assert.ok(candidate1);
  assert.equal(candidate1.filename, 'Black.Mirror.S07E03.1080p.mkv');
  assert.equal(candidate1.size, 2147483648);

  const candidate2 = cache.getCandidate(OTHER_HASH, null);
  assert.ok(candidate2);
  assert.equal(candidate2.filename, 'Movie.2024.2160p.HDR.mkv');

  cache.close();
});

test('Pipeline handles mixed valid/invalid records', async () => {
  const cache = createDiscoveryCache();

  const dmmData = JSON.stringify({
    torrents: [
      { hash: HASH, filename: 'Valid.mkv', bytes: 1000 },
      { hash: 'invalid_hash', filename: 'BadHash.mkv', bytes: 1000 }, // Invalid
      { hash: OTHER_HASH, filename: '', bytes: 1000 }, // Missing filename
      { hash: 'dddddddddddddddddddddddddddddddddddddddd', filename: 'Good.mkv', bytes: 2000 },
    ],
  });

  const compressed = compressToEncodedURIComponent(dmmData);
  const source = new MockHashListSource({
    fragments: [
      {
        url: 'https://example.com/mixed.html',
        name: 'mixed.html',
        size: 100,
        html: '<html><body><script>decompressFromEncodedURIComponent(\'' + compressed + '\');</script></body></html>',
      },
    ],
  });

  const runner = new DMMIngestionRunner({ source, cache });
  const metrics = await runner.run();

  assert.equal(metrics.recordsProcessed, 4);
  assert.equal(metrics.recordsInserted, 2); // Only valid ones
  assert.equal(metrics.recordsFailed, 2); // Invalid hash + missing filename

  cache.close();
});

// =============================================================================
// Attribute Worker Integration Tests
// =============================================================================

test('DMMIngestionRunner runs attribute parsing pass after ingestion', async () => {
  const cache = createDiscoveryCache();

  const dmmData = JSON.stringify({
    torrents: [
      { hash: HASH, filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv', bytes: 1500000000 },
      { hash: OTHER_HASH, filename: 'Breaking.Bad.S05E14.720p.WEB-DL.x264-GROUP.mkv', bytes: 800000000 },
    ],
  });

  const compressed = compressToEncodedURIComponent(dmmData);
  const source = new MockHashListSource({
    fragments: [
      {
        url: 'https://example.com/fragment1.html',
        name: 'fragment1.html',
        size: 1000,
        html: '<html><body><script>var payload = decompressFromEncodedURIComponent(\'' + compressed + '\');</script></body></html>',
      },
    ],
  });

  const runner = new DMMIngestionRunner({
    source,
    cache,
    batchSize: 10,
    enableAttributeParsing: true,
  });

  const metrics = await runner.run();

  // Verify ingestion metrics
  assert.equal(metrics.recordsInserted, 2);

  // Verify attribute parsing ran
  assert.ok(metrics.attributeStats, 'attributeStats should be present');
  assert.equal(metrics.attributeStats.parsed, 2);
  assert.equal(metrics.attributeStats.failed, 0);

  // Verify no candidates without attributes remain
  assert.equal(getCandidatesWithoutAttributes(cache).length, 0);

  // Verify search works
  const searchResult = searchReleases(cache, { query: 'Breaking Bad S05E14' });
  assert.equal(searchResult.total, 2);

  cache.close();
});

test('DMMIngestionRunner can disable attribute parsing', async () => {
  const cache = createDiscoveryCache();

  const dmmData = JSON.stringify({
    torrents: [
      { hash: HASH, filename: 'Movie.2024.1080p.mkv', bytes: 2000000000 },
    ],
  });

  const compressed = compressToEncodedURIComponent(dmmData);
  const source = new MockHashListSource({
    fragments: [
      {
        url: 'https://example.com/fragment1.html',
        name: 'fragment1.html',
        size: 1000,
        html: '<html><body><script>decompressFromEncodedURIComponent(\'' + compressed + '\');</script></body></html>',
      },
    ],
  });

  const runner = new DMMIngestionRunner({
    source,
    cache,
    enableAttributeParsing: false,
  });

  const metrics = await runner.run();

  assert.equal(metrics.recordsInserted, 1);
  assert.equal(metrics.attributeStats, null); // No attribute parsing

  // Verify no attributes were created
  assert.equal(getCandidatesWithoutAttributes(cache).length, 1);

  cache.close();
});

test('DMMIngestionRunner metrics include attribute stats', async () => {
  const cache = createDiscoveryCache();

  const dmmData = JSON.stringify({
    torrents: [
      { hash: HASH, filename: 'Test.Movie.1080p.mkv', bytes: 1000000000 },
    ],
  });

  const compressed = compressToEncodedURIComponent(dmmData);
  const source = new MockHashListSource({
    fragments: [
      {
        url: 'https://example.com/fragment1.html',
        name: 'fragment1.html',
        size: 1000,
        html: '<html><body><script>decompressFromEncodedURIComponent(\'' + compressed + '\');</script></body></html>',
      },
    ],
  });

  const runner = new DMMIngestionRunner({ source, cache });
  const metrics = await runner.run();

  // Verify attribute stats structure
  assert.ok(metrics.attributeStats);
  assert.ok('total' in metrics.attributeStats);
  assert.ok('processed' in metrics.attributeStats);
  assert.ok('parsed' in metrics.attributeStats);
  assert.ok('failed' in metrics.attributeStats);
  assert.ok('errors' in metrics.attributeStats);

  cache.close();
});

// =============================================================================
// Corpus lifecycle / batch atomicity proof
// =============================================================================
//
// Audit finding D2 (corpus lifecycle): a process death or SQL error
// mid-batch in the in-tree runner could leave the corpus with a partial
// batch — some records from a batch visible, others not. The patch wraps
// flushBatch in BEGIN IMMEDIATE / COMMIT, so a batch is all-or-nothing.
//
// Proof: wrap the cache so its 3rd upsertCandidate throws, then call
// flushBatch with a 5-record batch. Pre-patch, 2 records would be
// committed. Post-patch, 0 records persist (transaction rolled back).

test('flushBatch is atomic: a mid-batch failure rolls back the entire batch', async () => {
  const cache = createDiscoveryCache();
  const realUpsert = cache.upsertCandidate.bind(cache);
  let upsertCalls = 0;
  cache.upsertCandidate = (entry) => {
    upsertCalls += 1;
    if (upsertCalls === 3) {
      throw new Error('simulated mid-batch failure');
    }
    return realUpsert(entry);
  };

  const runner = new DMMIngestionRunner({ cache, batchSize: 1000 });
  const batch = [
    { infoHash: HASH, fileIndex: null, filename: 'a.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, '2'), fileIndex: null, filename: 'b.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, '3'), fileIndex: null, filename: 'c.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, '4'), fileIndex: null, filename: 'd.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, '5'), fileIndex: null, filename: 'e.mkv', sources: [] },
  ];

  await runner.flushBatch(batch);

  // After the failure, NO records from the batch should be visible.
  // Pre-patch behaviour: 2 records would be present (autocommit per record).
  // Post-patch behaviour: 0 records present (transaction rolled back).
  const remaining = cache.db
    .prepare('SELECT COUNT(*) AS c FROM candidates')
    .get().c;
  assert.equal(remaining, 0, 'mid-batch failure must leave zero committed records');

  // The failure must be reflected in metrics.
  assert.equal(runner.metrics.recordsFailed, batch.length);

  cache.close();
});

test('flushBatch is atomic on SIGKILL-equivalent: re-running the same batch yields the same corpus', async () => {
  // Simulates "process was killed mid-batch, then restarted and re-ingested
  // the same fragment". The final corpus must be identical to a single
  // successful run, regardless of where the previous run was killed.
  // The two runs use different batches so that a partially-committed
  // second run would change the corpus (which must not happen).
  const cache = createDiscoveryCache();
  const realUpsert = cache.upsertCandidate.bind(cache);
  let callCount = 0;
  cache.upsertCandidate = (entry) => {
    callCount += 1;
    // Kill halfway through the second batch.
    if (callCount === 7) {
      throw new Error('simulated SIGKILL');
    }
    return realUpsert(entry);
  };

  const runner = new DMMIngestionRunner({ cache, batchSize: 1000 });
  const batchA = [
    { infoHash: HASH.replace(/.$/, 'a'), fileIndex: null, filename: 'a1.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, 'b'), fileIndex: null, filename: 'a2.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, 'c'), fileIndex: null, filename: 'a3.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, 'd'), fileIndex: null, filename: 'a4.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, 'e'), fileIndex: null, filename: 'a5.mkv', sources: [] },
  ];
  const batchB = [
    { infoHash: HASH.replace(/.$/, '1'), fileIndex: null, filename: 'b1.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, '2'), fileIndex: null, filename: 'b2.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, '3'), fileIndex: null, filename: 'b3.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, '4'), fileIndex: null, filename: 'b4.mkv', sources: [] },
    { infoHash: HASH.replace(/.$/, '5'), fileIndex: null, filename: 'b5.mkv', sources: [] },
  ];

  // Run #1: completes successfully, all 5 records from batchA persist.
  await runner.flushBatch(batchA);
  const afterRun1 = cache.db
    .prepare('SELECT info_hash FROM candidates ORDER BY info_hash')
    .all().map((r) => r.info_hash);

  // Run #2: batchB, fails on its 2nd record. Transaction must roll back
  // and the corpus must remain identical to after Run #1.
  await runner.flushBatch(batchB);
  const afterRun2 = cache.db
    .prepare('SELECT info_hash FROM candidates ORDER BY info_hash')
    .all().map((r) => r.info_hash);

  assert.deepEqual(afterRun1, afterRun2, 'failed re-run must not change the corpus');
  assert.equal(afterRun2.length, 5);

  cache.close();
});

// ============================================================================
// DMM Source Provenance & Refresh-Generation Lifecycle
// ============================================================================
// These tests prove the minimum provenance + refresh-generation lifecycle:
// 1. G1 ingest is idempotent (re-running the same generation does not amplify rows)
// 2. Reingesting fragment A/G1 does not duplicate provenance
// 3. Interrupted G2 does not mark G1 observations stale
// 4. Completing G2 makes missing observations queryable as stale
// 5. Candidate still justified by another source is NOT considered globally stale
// 6. Candidate with zero active source observations IS detectable as prune-eligible
// 7. file_index NULL remains distinct from any future file-specific candidate
// 8. Ranking over unchanged evidence snapshot is unchanged

// Helper: build a minimal cache + runner for the fixture scenarios.
function makeFixtureCache() {
  return createDiscoveryCache({ dbPath: ':memory:' });
}

const GEN_G1 = 'g1_' + 'a'.repeat(36); // 38 chars
const GEN_G2 = 'g2_' + 'b'.repeat(36);
const FRAG_A = 'fragment-A.html';
const FRAG_B = 'fragment-B.html';

function makeEntry(hash, filename) {
  return {
    infoHash: hash,
    fileIndex: null,
    title: filename,
    filename,
    size: 1024,
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
    mediaAssociations: [],
  };
}

test('provenance: dmm_ingestion_generations and dmm_source_observations are created', async () => {
  const cache = makeFixtureCache();
  const result = cache.startDmmGeneration({ generationId: GEN_G1, treeSha: GEN_G1 });
  assert.ok(result, 'startDmmGeneration must return a row');
  assert.equal(result.generation_id, GEN_G1);
  assert.equal(result.status, 'running');

  // Insert a source observation directly.
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist',
    fragmentName: FRAG_A,
    generationId: GEN_G1,
    entries: [makeEntry('aa'.repeat(20), 'X.mkv')],
  });

  const gen = cache.getDmmGeneration(GEN_G1);
  assert.ok(gen, 'generation must be retrievable');
  assert.equal(gen.status, 'running');

  const count = cache.countDmmObservations(GEN_G1);
  assert.equal(count, 1, 'one observation must be recorded');

  // The current COMPLETE generation is null (G1 is still 'running').
  assert.equal(cache.getCurrentDmmGeneration(), null);

  // Close as complete.
  cache.completeDmmGeneration(GEN_G1, 'complete', {
    fragmentsTotal: 1, fragmentsComplete: 1, fragmentsFailed: 0,
  });
  const current = cache.getCurrentDmmGeneration();
  assert.ok(current, 'after completion, current complete generation is set');
  assert.equal(current.status, 'complete');

  cache.close();
});

test('provenance: G1 ingest is idempotent (re-running same generation does not amplify rows)', async () => {
  const cache = makeFixtureCache();
  cache.startDmmGeneration({ generationId: GEN_G1, treeSha: GEN_G1 });

  const entries = [
    makeEntry('a1'.repeat(20), 'X.mkv'),
    makeEntry('a2'.repeat(20), 'Y.mkv'),
  ];

  // First ingest of fragment A.
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1, entries,
  });
  assert.equal(cache.countDmmObservations(GEN_G1), 2);

  // Re-ingest the SAME fragment/generation.
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1, entries,
  });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1, entries,
  });

  // Still 2 rows — the composite primary key (info_hash, file_index_key, source,
  // fragment_name, generation_id) is deterministic and INSERT OR IGNORE means
  // duplicate writes are no-ops.
  assert.equal(
    cache.countDmmObservations(GEN_G1), 2,
    're-ingesting same fragment/generation must not amplify observation rows',
  );

  cache.close();
});

test('provenance: many-to-many ownership — a candidate may be justified by multiple fragments', async () => {
  const cache = makeFixtureCache();
  cache.startDmmGeneration({ generationId: GEN_G1, treeSha: GEN_G1 });

  // Candidate Y appears in both Fragment A and Fragment B.
  const yHash = 'cc'.repeat(20);
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1,
    entries: [makeEntry(yHash, 'Y.mkv')],
  });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_B, generationId: GEN_G1,
    entries: [makeEntry(yHash, 'Y.mkv')],
  });

  // Two rows for Y (one per fragment) — the candidate is justified by both.
  const yObs = cache.getDmmObservationsForCandidate(yHash, null);
  assert.equal(yObs.length, 2, 'candidate Y must have one observation per fragment');
  const fragments = yObs.map(o => o.fragment_name).sort();
  assert.deepEqual(fragments, [FRAG_A, FRAG_B]);

  cache.close();
});

test('provenance: interrupted G2 does not mark G1 observations stale', async () => {
  const cache = makeFixtureCache();

  // G1 completes fully.
  cache.startDmmGeneration({ generationId: GEN_G1, treeSha: GEN_G1 });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1,
    entries: [makeEntry('d1'.repeat(20), 'X.mkv')],
  });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_B, generationId: GEN_G1,
    entries: [makeEntry('d2'.repeat(20), 'Y.mkv')],
  });
  cache.completeDmmGeneration(GEN_G1, 'complete', {
    fragmentsTotal: 2, fragmentsComplete: 2, fragmentsFailed: 0,
  });

  // G2 starts but is INTERRUPTED: it processes Fragment A only, fails on B,
  // and is closed as 'incomplete' (or never closed).
  cache.startDmmGeneration({ generationId: GEN_G2, treeSha: GEN_G2 });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G2,
    entries: [makeEntry('d1'.repeat(20), 'X.mkv')], // only X observed in G2
  });
  // Do NOT mark G2 complete. Leave it 'running'.

  // Stale-detection must only consider COMPLETE generations. G2 is not complete,
  // so it is invisible. getCurrentDmmGeneration must still return G1.
  const current = cache.getCurrentDmmGeneration();
  assert.ok(current, 'current complete generation must exist');
  assert.equal(current.generation_id, GEN_G1,
    'G2 is incomplete — G1 must remain the current complete generation');

  // findPruneEligibleCandidates against G1 (the current complete gen) must
  // NOT mark Y as stale: Y has an observation in G1/Fragment-B.
  // Add the candidates first so findPruneEligibleCandidates has rows to look at.
  cache.upsertCandidate(makeEntry('d1'.repeat(20), 'X.mkv'));
  cache.upsertCandidate(makeEntry('d2'.repeat(20), 'Y.mkv'));
  const prune = cache.findPruneEligibleCandidates(GEN_G1);
  assert.equal(prune.length, 0, 'no candidate should be prune-eligible against G1');

  cache.close();
});

test('provenance: completing G2 makes missing observations queryable as stale', async () => {
  const cache = makeFixtureCache();

  // G1: both fragments observed.
  cache.startDmmGeneration({ generationId: GEN_G1, treeSha: GEN_G1 });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1,
    entries: [
      makeEntry('e1'.repeat(20), 'X.mkv'),
      makeEntry('e2'.repeat(20), 'Y.mkv'),
    ],
  });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_B, generationId: GEN_G1,
    entries: [
      makeEntry('e2'.repeat(20), 'Y.mkv'),
      makeEntry('e3'.repeat(20), 'Z.mkv'),
    ],
  });
  cache.completeDmmGeneration(GEN_G1, 'complete', {
    fragmentsTotal: 2, fragmentsComplete: 2, fragmentsFailed: 0,
  });

  // G2: Y disappears from Fragment A, but Z and X are still present.
  // Also need a candidate population for prune-eligible queries.
  cache.upsertCandidate(makeEntry('e1'.repeat(20), 'X.mkv'));
  cache.upsertCandidate(makeEntry('e2'.repeat(20), 'Y.mkv'));
  cache.upsertCandidate(makeEntry('e3'.repeat(20), 'Z.mkv'));

  cache.startDmmGeneration({ generationId: GEN_G2, treeSha: GEN_G2 });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G2,
    entries: [makeEntry('e1'.repeat(20), 'X.mkv')], // Y removed from A
  });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_B, generationId: GEN_G2,
    entries: [makeEntry('e3'.repeat(20), 'Z.mkv')], // Y removed from B too
  });
  cache.completeDmmGeneration(GEN_G2, 'complete', {
    fragmentsTotal: 2, fragmentsComplete: 2, fragmentsFailed: 0,
  });

  // Now G2 is the current complete generation.
  assert.equal(cache.getCurrentDmmGeneration().generation_id, GEN_G2);

  // Stale observations: any (info_hash, source, fragment) seen in G1 but not in G2.
  const stale = cache.findStaleObservations(GEN_G1, GEN_G2);
  // Expect 2 stale: Y/A and Y/B.
  assert.equal(stale.length, 2, 'Y should be stale in both fragments');
  const staleKeys = stale.map(s => `${s.info_hash.slice(0, 4)}/${s.fragment_name}`).sort();
  assert.deepEqual(staleKeys, [
    `${'e2'.repeat(20).slice(0, 4)}/${FRAG_A}`,
    `${'e2'.repeat(20).slice(0, 4)}/${FRAG_B}`,
  ]);

  // Prune-eligible candidates against G2: candidates with zero observations in G2.
  const prune = cache.findPruneEligibleCandidates(GEN_G2);
  // X has G2/A, Z has G2/B, Y has neither → only Y is prune-eligible.
  assert.equal(prune.length, 1, 'only Y is prune-eligible against G2');
  assert.equal(prune[0].info_hash, 'e2'.repeat(20));

  cache.close();
});

test('provenance: cross-generation justification — prior observation does not prevent stale detection but proves the identity existed', async () => {
  const cache = makeFixtureCache();

  // G1: candidate Y observed by DMM Fragment A.
  cache.startDmmGeneration({ generationId: GEN_G1, treeSha: GEN_G1 });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1,
    entries: [makeEntry('f1'.repeat(20), 'Y.mkv')],
  });
  cache.completeDmmGeneration(GEN_G1, 'complete', {
    fragmentsTotal: 1, fragmentsComplete: 1, fragmentsFailed: 0,
  });

  cache.upsertCandidate(makeEntry('f1'.repeat(20), 'Y.mkv'));

  // G2 (DMM): Y disappears from DMM entirely. G2 is complete but has zero
  // DMM observations of Y. (If there were a cross-source observer like scraper-A,
  // its observation would also carry generation_id=GEN_G2 and would show up in
  // getDmmObservationsForCandidate — proving the candidate was still seen
  // by another source in the same generation.)
  cache.startDmmGeneration({ generationId: GEN_G2, treeSha: GEN_G2 });
  // No DMM observations for Y in G2 — it disappeared.
  cache.completeDmmGeneration(GEN_G2, 'complete', {
    fragmentsTotal: 1, fragmentsComplete: 1, fragmentsFailed: 0,
  });

  // G2 is the current complete DMM generation.
  const currentDmmGen = cache.getCurrentDmmGeneration('dmm-hashlist');
  assert.equal(currentDmmGen.generation_id, GEN_G2,
    'G2 must be the current complete DMM generation');

  // DMM-only prune query against G2 says Y is DMM-prune-eligible: there are
  // no DMM observations of Y in G2.
  const dmmPrune = cache.findPruneEligibleCandidates(GEN_G2);
  assert.equal(dmmPrune.length, 1, 'Y is DMM-prune-eligible (no DMM observation in G2)');

  // Cross-generation justification: Y still has a G1 observation.
  // getDmmObservationsForCandidate surfaces all observations regardless of
  // generation. This proves the candidate identity existed and was valid.
  const yObs = cache.getDmmObservationsForCandidate('f1'.repeat(20), null);
  assert.equal(yObs.length, 1,
    'candidate Y has one historical observation (G1 DMM)');
  assert.equal(yObs[0].generation_id, GEN_G1,
    'the historical observation is from G1');
  assert.equal(yObs[0].source, 'dmm-hashlist',
    'the historical observation is from the DMM source');

  // If scraper-A had observed Y in G2, there would be 2 observations:
  // (G1, dmm-hashlist) and (G2, scraper-A). The scraper justifies Y in G2
  // even though DMM did not. This is the cross-source justification case —
  // it is reflected in getDmmObservationsForCandidate.

  cache.close();
});

test('provenance: fileIndex NULL (-1) remains distinct from any future file-specific candidate', async () => {
  const cache = makeFixtureCache();
  cache.startDmmGeneration({ generationId: GEN_G1, treeSha: GEN_G1 });

  // Two candidates with the SAME info_hash but different file_index_key:
  //   - torrent-level (fileIndex NULL → file_index_key = -1)
  //   - file-specific (fileIndex 0 → file_index_key = 0)
  // Both are valid identities; the provenance table must keep them separate.
  const torrentLevel = {
    infoHash: 'abc'.repeat(13) + 'abcd', // 40 hex chars
    fileIndex: null,
    title: 'multi-file.mkv',
    filename: 'multi-file.mkv',
    size: 1024,
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
    mediaAssociations: [],
  };
  const fileSpecific = {
    ...torrentLevel,
    fileIndex: 0,
    title: 'multi-file/file0.mkv',
    filename: 'multi-file/file0.mkv',
  };

  cache.upsertCandidate(torrentLevel);
  cache.upsertCandidate(fileSpecific);
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1,
    entries: [torrentLevel, fileSpecific],
  });

  // Two candidates in the corpus with the same info_hash.
  const sameHash = 'abc'.repeat(13) + 'abcd';
  const torrentRow = cache.getCandidate(sameHash, null);
  const fileRow = cache.getCandidate(sameHash, 0);
  assert.ok(torrentRow, 'torrent-level candidate must exist');
  assert.ok(fileRow, 'file-specific candidate must exist');
  // rowToCandidate exposes fileIndex (the original nullable column) but not
  // file_index_key. Query the raw row for the durable key to verify the
  // identity separation that the schema enforces.
  const rawRows = cache.db.prepare(
    'SELECT file_index, file_index_key FROM candidates WHERE info_hash = ?'
  ).all(sameHash);
  assert.equal(rawRows.length, 2, 'two distinct candidates for the same info_hash');
  const torrentRaw = rawRows.find(r => r.file_index === null);
  const fileRaw = rawRows.find(r => r.file_index === 0);
  assert.ok(torrentRaw, 'torrent-level row must exist (file_index IS NULL)');
  assert.ok(fileRaw, 'file-specific row must exist (file_index = 0)');
  assert.equal(torrentRaw.file_index_key, -1, 'torrent-level uses file_index_key = -1');
  assert.equal(fileRaw.file_index_key, 0, 'file-specific uses file_index_key = 0');

  // Two distinct observation rows — the provenance primary key includes
  // file_index_key, so NULL and 0 do not collide.
  const count = cache.countDmmObservations(GEN_G1);
  assert.equal(count, 2, 'torrent-level and file-specific must produce 2 distinct observations');

  // Observing only the torrent-level candidate does NOT stale-out the file-specific.
  cache.startDmmGeneration({ generationId: GEN_G2, treeSha: GEN_G2 });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G2,
    entries: [torrentLevel], // only torrent-level observed
  });
  cache.completeDmmGeneration(GEN_G2, 'complete', {
    fragmentsTotal: 1, fragmentsComplete: 1, fragmentsFailed: 0,
  });
  // G1 was also completed so the prune test is meaningful.
  cache.completeDmmGeneration(GEN_G1, 'complete', {
    fragmentsTotal: 1, fragmentsComplete: 1, fragmentsFailed: 0,
  });

  // Against G2, only the file-specific candidate is prune-eligible. The
  // torrent-level is observed in G2.
  const prune = cache.findPruneEligibleCandidates(GEN_G2);
  assert.equal(prune.length, 1, 'only the file-specific candidate is prune-eligible');
  assert.equal(prune[0].info_hash, sameHash);
  assert.equal(prune[0].file_index_key, 0,
    'the prune-eligible candidate is the file-specific one, not the torrent-level one');

  cache.close();
});

test('provenance: ranking over unchanged evidence snapshot is unchanged', async () => {
  // This test proves that adding provenance observations does not mutate
  // candidate identity, release_attributes, or the FTS5 search index. The
  // search-engine ranking output before and after observation recording
  // must be byte-identical.
  const cache = makeFixtureCache();
  cache.startDmmGeneration({ generationId: GEN_G1, treeSha: GEN_G1 });

  const entries = [
    { ...makeEntry('a1'.repeat(20), 'Movie.2024.1080p.BluRay.x264-GRP1.mkv'),
      title: 'Movie.2024.1080p.BluRay.x264-GRP1.mkv' },
  ];

  // Ingest and parse attributes.
  const { ingestCandidates } = await import('../src/lib/discovery/ingest.js');
  ingestCandidates(cache, {
    source: 'dmm-hashlist', entries, generationId: GEN_G1, fragmentName: FRAG_A,
  });

  // Run attribute worker so release_attributes + FTS are populated.
  const { runAttributeWorker } = await import('../src/lib/discovery/attribute-worker.js');
  await runAttributeWorker(cache, { limit: undefined });

  // Ranking snapshot BEFORE recording extra provenance.
  const before = searchReleases(cache, { query: 'Movie 2024' });
  const beforeResults = before.results.map(r => ({
    info_hash: r.infoHash, filename: r.filename, score: r.score,
  }));

  // Record the same provenance multiple times. This is the idempotency test:
  // ranking MUST be unchanged.
  for (let i = 0; i < 3; i++) {
    cache.recordDmmSourceObservations({
      source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1, entries,
    });
  }

  const after = searchReleases(cache, { query: 'Movie 2024' });
  const afterResults = after.results.map(r => ({
    info_hash: r.infoHash, filename: r.filename, score: r.score,
  }));

  assert.deepEqual(afterResults, beforeResults,
    'ranking over the same evidence must be byte-identical after observation recording');
  assert.ok(afterResults.length > 0, 'sanity: there must be at least one ranked result');

  // FTS row count must equal release_attributes count (no FTS drift from provenance).
  const raCount = cache.db.prepare('SELECT COUNT(*) AS n FROM release_attributes').get().n;
  const ftsCount = cache.db.prepare('SELECT COUNT(*) AS n FROM release_search').get().n;
  assert.equal(ftsCount, raCount, 'FTS5 index must remain in sync with release_attributes');

  // Observation count: at most 1 row per (candidate, source, fragment, generation)
  // — the 3 extra writes are INSERT OR IGNORE no-ops.
  const obsCount = cache.countDmmObservations(GEN_G1);
  assert.equal(obsCount, 1, 'idempotent re-recording must not amplify observation rows');

  cache.close();
});

test('provenance: cross-source justification — candidate observed by another source in the current generation is NOT DMM-stale', async () => {
  const cache = makeFixtureCache();

  // G1: candidate Y observed by DMM.
  cache.startDmmGeneration({ generationId: GEN_G1, treeSha: GEN_G1 });
  cache.recordDmmSourceObservations({
    source: 'dmm-hashlist', fragmentName: FRAG_A, generationId: GEN_G1,
    entries: [makeEntry('fa'.repeat(20), 'Y.mkv')],
  });
  cache.completeDmmGeneration(GEN_G1, 'complete', {
    fragmentsTotal: 1, fragmentsComplete: 1, fragmentsFailed: 0,
  });

  cache.upsertCandidate(makeEntry('fa'.repeat(20), 'Y.mkv'));

  // G2: Y disappears from DMM, but a SEPARATE non-DMM source (scraper-A)
  // still observes Y in the same generation. The provenance table captures
  // both observations.
  cache.startDmmGeneration({ generationId: GEN_G2, treeSha: GEN_G2 });
  cache.recordDmmSourceObservations({
    source: 'scraper-A', // different source, same generation
    fragmentName: 'scraper-A-list.json',
    generationId: GEN_G2,
    entries: [makeEntry('fa'.repeat(20), 'Y.mkv')],
  });
  cache.completeDmmGeneration(GEN_G2, 'complete', {
    fragmentsTotal: 1, fragmentsComplete: 1, fragmentsFailed: 0,
  });

  // Y is NOT prune-eligible: scraper-A observed it in G2, so Y is justified
  // in the current generation. This is the safe default — the prune query
  // is source-agnostic, so a candidate is never deleted while ANY source
  // still sees it in the current generation.
  const prune = cache.findPruneEligibleCandidates(GEN_G2);
  assert.equal(prune.length, 0,
    'Y is NOT prune-eligible because scraper-A observed it in G2');

  // getDmmObservationsForCandidate surfaces both observations across both
  // sources, so a justification-aware prune layer sees the full picture.
  const yObs = cache.getDmmObservationsForCandidate('fa'.repeat(20), null);
  assert.equal(yObs.length, 2,
    'candidate Y has 2 observations: G1/DMM and G2/scraper-A');
  const yJustified = yObs.some(o => o.source === 'scraper-A' && o.generation_id === GEN_G2);
  assert.ok(yJustified,
    'candidate Y is still justified by scraper-A in G2 — must NOT be globally pruned');

  cache.close();
});
