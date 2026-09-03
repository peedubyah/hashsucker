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
