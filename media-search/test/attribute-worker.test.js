/**
 * Release Attribute Worker Tests
 *
 * Proves the full pipeline:
 *   DMM fragment → candidate → parser → release_attributes → FTS search result
 *
 * Tests:
 * - Attribute worker parses filenames into release_attributes
 * - FTS5 index is auto-populated via triggers
 * - Search returns ranked results from parsed attributes
 * - Failure isolation (one parse failure doesn't affect others)
 * - Idempotency (re-running doesn't duplicate attributes)
 * - Integration with DMM ingestion runner
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { runAttributeWorker, createAttributeWorker } from '../src/lib/discovery/attribute-worker.js';
import { storeReleaseAttributes, getCandidatesWithoutAttributes } from '../src/lib/discovery/release-attributes.js';
import { searchReleases, getSearchStats } from '../src/lib/discovery/search-engine.js';
import { parseFilename } from '../src/lib/discovery/parser-adapter.js';
import { ingestCandidates } from '../src/lib/discovery/ingest.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

// =============================================================================
// Attribute Worker Tests
// =============================================================================

test('runAttributeWorker parses filenames into release_attributes', async () => {
  const cache = createDiscoveryCache();

  // Ingest candidates (simulating DMM ingestion)
  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv',
  });
  cache.upsertCandidate({
    infoHash: HASH2,
    fileIndex: null,
    filename: 'Breaking.Bad.S05E14.720p.WEB-DL.x264-GROUP.mkv',
  });

  // Verify no attributes exist yet
  assert.equal(getCandidatesWithoutAttributes(cache).length, 2);

  // Run attribute worker
  const stats = await runAttributeWorker(cache);

  assert.equal(stats.total, 2);
  assert.equal(stats.processed, 2);
  assert.equal(stats.parsed, 2);
  assert.equal(stats.failed, 0);

  // Verify attributes were created
  const attrs1 = cache.getReleaseAttributes(HASH1, null);
  assert.equal(attrs1.length, 1);
  assert.equal(attrs1[0].title, 'Breaking Bad');
  assert.equal(attrs1[0].season, 5);
  assert.equal(attrs1[0].episode, 14);
  assert.equal(attrs1[0].resolution, '1080p');
  assert.equal(attrs1[0].sourceType, 'BluRay');
  assert.equal(attrs1[0].codec, 'x264');

  const attrs2 = cache.getReleaseAttributes(HASH2, null);
  assert.equal(attrs2.length, 1);
  assert.equal(attrs2[0].resolution, '720p');
  assert.equal(attrs2[0].sourceType, 'WEB-DL');

  // Verify no candidates without attributes remain
  assert.equal(getCandidatesWithoutAttributes(cache).length, 0);

  cache.close();
});

test('runAttributeWorker skips unparseable filenames', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: '', // Empty filename — parser returns null
  });

  const stats = await runAttributeWorker(cache);

  assert.equal(stats.total, 1);
  assert.equal(stats.processed, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.parsed, 0);

  cache.close();
});

test('runAttributeWorker handles parse failures with isolation', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Good.File.1080p.mkv',
  });
  cache.upsertCandidate({
    infoHash: HASH2,
    fileIndex: null,
    filename: 'Another.File.720p.mkv', // Different pattern — won't throw
  });

  // Custom parser that throws for specific input
  const failingParser = (filename) => {
    if (filename.startsWith('Good.')) {
      throw new Error('Parser crashed');
    }
    return parseFilename(filename);
  };

  const stats = await runAttributeWorker(cache, { parser: failingParser });

  assert.equal(stats.total, 2);
  assert.equal(stats.processed, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.parsed, 1); // Second file should still parse
  assert.equal(stats.errors.length, 1);

  // Verify second file was parsed
  const attrs2 = cache.getReleaseAttributes(HASH2, null);
  assert.equal(attrs2.length, 1);
  assert.equal(attrs2[0].resolution, '720p');

  cache.close();
});

test('runAttributeWorker is idempotent (no duplicate attributes)', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-TEST.mkv',
  });

  // Run twice
  await runAttributeWorker(cache);
  await runAttributeWorker(cache);

  // Should still have only one attribute entry
  const attrs = cache.getReleaseAttributes(HASH1, null);
  assert.equal(attrs.length, 1);

  cache.close();
});

test('runAttributeWorker respects limit option', async () => {
  const cache = createDiscoveryCache();

  for (let i = 0; i < 5; i++) {
    cache.upsertCandidate({
      infoHash: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${i}`, // unique hashes
      fileIndex: null,
      filename: `Movie.${i}.1080p.mkv`,
    });
  }

  const stats = await runAttributeWorker(cache, { limit: 3 });

  assert.equal(stats.total, 3);
  assert.equal(stats.processed, 3);
  assert.equal(stats.parsed, 3);

  // 2 candidates should still be without attributes
  assert.equal(getCandidatesWithoutAttributes(cache).length, 2);

  cache.close();
});

test('createAttributeWorker returns reusable worker function', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Test.Movie.1080p.mkv',
  });

  const worker = createAttributeWorker();
  const stats = await worker(cache);

  assert.equal(stats.parsed, 1);

  cache.close();
});

test('runAttributeWorker throws without cache', async () => {
  await assert.rejects(
    () => runAttributeWorker(null),
    /requires a cache/
  );
});

test('runAttributeWorker throws without parser', async () => {
  const cache = createDiscoveryCache();
  await assert.rejects(
    () => runAttributeWorker(cache, { parser: null }),
    /requires a parser/
  );
  cache.close();
});

// =============================================================================
// FTS5 Integration Tests
// =============================================================================

test('FTS5 index is auto-populated after attribute parsing', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv',
  });

  // Before parsing
  let searchStats = getSearchStats(cache);
  assert.equal(searchStats.indexed, 0);

  // Run attribute worker
  await runAttributeWorker(cache);

  // After parsing
  searchStats = getSearchStats(cache);
  assert.equal(searchStats.indexed, 1);

  cache.close();
});

test('search returns results from parsed attributes', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv',
  });
  cache.upsertCandidate({
    infoHash: HASH2,
    fileIndex: null,
    filename: 'Breaking.Bad.S05E14.720p.WEB-DL.x264-GROUP.mkv',
  });
  cache.upsertCandidate({
    infoHash: HASH3,
    fileIndex: null,
    filename: 'Breaking.Bad.S05E14.2160p.BluRay.x265-OTHER.mkv',
  });

  // Run attribute worker
  await runAttributeWorker(cache);

  // Search
  const result = searchReleases(cache, { query: 'Breaking Bad S05E14' });

  assert.equal(result.total, 3);
  assert.ok(result.results.length > 0);

  // All results should have parsed attributes
  for (const r of result.results) {
    assert.ok(r.parsed.title);
    assert.ok(r.parsed.resolution);
    assert.ok(r.score > 0);
  }

  cache.close();
});

test('search ranks higher quality releases first', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Movie.2024.480p.DVD.x264-LOW.mkv',
  });
  cache.upsertCandidate({
    infoHash: HASH2,
    fileIndex: null,
    filename: 'Movie.2024.2160p.BluRay.x265.HDR-HIGH.mkv',
  });

  await runAttributeWorker(cache);

  const result = searchReleases(cache, { query: 'Movie 2024' });

  assert.equal(result.total, 2);
  // 2160p HDR should rank higher than 480p DVD
  assert.ok(result.results[0].score > result.results[1].score);
  assert.equal(result.results[0].hash, HASH2);

  cache.close();
});

// =============================================================================
// End-to-End Pipeline Test
// =============================================================================

test('full pipeline: DMM ingestion → attribute parsing → search', async () => {
  const cache = createDiscoveryCache();

  // Simulate DMM ingestion output
  const dmmEntries = [
    { infoHash: HASH1, fileIndex: null, filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv', size: 1500000000 },
    { infoHash: HASH2, fileIndex: null, filename: 'Breaking.Bad.S05E14.720p.WEB-DL.x264-GROUP.mkv', size: 800000000 },
    { infoHash: HASH3, fileIndex: null, filename: 'Breaking.Bad.S05E14.2160p.BluRay.x265-OTHER.mkv', size: 4500000000 },
  ];

  // Step 1: Ingest through the ingestion boundary
  const ingestResult = ingestCandidates(cache, {
    source: 'dmm-hashlist',
    entries: dmmEntries,
  });

  assert.equal(ingestResult.inserted, 3);
  assert.equal(ingestResult.updated, 0);

  // Verify candidates exist but no attributes
  assert.equal(cache.queryCachedCandidates().length, 3);
  assert.equal(getCandidatesWithoutAttributes(cache).length, 3);

  // Step 2: Run attribute worker (this is the new wiring)
  const attrStats = await runAttributeWorker(cache);

  assert.equal(attrStats.parsed, 3);
  assert.equal(attrStats.failed, 0);
  assert.equal(getCandidatesWithoutAttributes(cache).length, 0);

  // Step 3: Verify FTS5 index is populated
  const searchStats = getSearchStats(cache);
  assert.equal(searchStats.indexed, 3);

  // Step 4: Search returns ranked results
  const searchResult = searchReleases(cache, { query: 'Breaking Bad S05E14 1080p' });

  assert.equal(searchResult.total, 1); // Only one 1080p match
  assert.equal(searchResult.results[0].hash, HASH1);
  assert.equal(searchResult.results[0].parsed.resolution, '1080p');
  assert.equal(searchResult.results[0].parsed.season, 5);
  assert.equal(searchResult.results[0].parsed.episode, 14);

  // Step 5: Broader search returns all
  const allResult = searchReleases(cache, { query: 'Breaking Bad' });
  assert.equal(allResult.total, 3);

  // Step 6: Verify evidence/confidence/source boundaries preserved
  const attrs = cache.getReleaseAttributes(HASH1, null);
  assert.equal(attrs[0].source, 'ptn-regex');
  assert.ok(attrs[0].confidence > 0);
  assert.ok(Array.isArray(attrs[0].evidence));
  assert.ok(attrs[0].evidence.length > 0);

  cache.close();
});

test('full pipeline: candidate identity is not mutated by attribute parsing', async () => {
  const cache = createDiscoveryCache();

  const originalFilename = 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv';

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: originalFilename,
    title: originalFilename,
    size: 1500000000,
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  });

  await runAttributeWorker(cache);

  // Verify candidate identity unchanged
  const candidate = cache.getCandidate(HASH1, null);
  assert.equal(candidate.infoHash, HASH1);
  assert.equal(candidate.fileIndex, null);
  assert.equal(candidate.filename, originalFilename);
  assert.equal(candidate.size, 1500000000);
  assert.equal(candidate.sources.length, 1);

  cache.close();
});

test('full pipeline: attribute parsing does not create media associations', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Movie.2024.1080p.mkv',
  });

  await runAttributeWorker(cache);

  // Should NOT have created candidate_media associations
  const associations = cache.getMediaAssociations(HASH1, null);
  assert.equal(associations.length, 0);

  // Should have release_attributes
  const attrs = cache.getReleaseAttributes(HASH1, null);
  assert.equal(attrs.length, 1);

  cache.close();
});

test('full pipeline: attribute parsing does not create provider observations', async () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: HASH1,
    fileIndex: null,
    filename: 'Movie.2024.1080p.mkv',
  });

  await runAttributeWorker(cache);

  // Should NOT have created provider observations
  const observations = cache.getProviderObservations(HASH1, null);
  assert.equal(observations.length, 0);

  cache.close();
});
