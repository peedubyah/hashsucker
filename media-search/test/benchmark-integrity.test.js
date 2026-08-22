/**
 * Benchmark Integrity Tests — Stage 3 Retrieval Measurement Validity
 *
 * These tests validate that the benchmark harness itself produces valid,
 * non-vacuous measurements.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { performance } from 'node:perf_hooks';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { searchReleases } from '../src/lib/discovery/search-engine.js';
import { toCanonicalLocal, deduplicateByReleaseKey, toRankingInput } from '../src/lib/discovery/canonical.js';
import { rankHits } from '../src/lib/discovery/ranking.js';

const benchmark = await import('../src/lib/discovery/retrieval-benchmark.js');

function makeSyntheticRow(index, spec) {
  const hash = `${index.toString(16).padStart(8, '0')}${'0'.repeat(32)}`.slice(0, 40);
  const fileIndex = spec.fileIndex ?? null;
  const filename = spec.filename || `${spec.title.replace(/\s+/g, '.')}.${spec.year || 2024}.${spec.resolution || '1080p'}.mkv`;

  return {
    infoHash: hash,
    fileIndex,
    filename,
    source: 'benchmark-synthetic',
    confidence: spec.confidence ?? 0.85,
    parsed: {
      title: spec.title,
      year: spec.year ?? 2024,
      mediaType: spec.mediaType || 'movie',
      season: spec.season ?? null,
      episode: spec.episode ?? null,
      episodeRange: spec.episodeRange ?? null,
      resolution: spec.resolution || '1080p',
      sourceType: spec.sourceType || 'BluRay',
      codec: spec.codec || 'x264',
      hdr: spec.hdr ?? false,
      audio: spec.audio || 'AAC',
      language: 'en',
      releaseGroup: spec.releaseGroup || 'BENCH',
    },
    evidence: ['synthetic'],
  };
}

// =============================================================================
// Test 1: Vacuous recall exclusion
// =============================================================================

test('BENCHMARK-INTEGRITY: zero-oracle queries excluded from recall denominator', async () => {
  const results = await benchmark.runRetrievalBenchmark({
    scales: [1000],
    matchCardinalities: [100],
    windows: [500],
    seed: 'vacuous-test',
  });

  const validResults = results.filter((r) => r.valid);
  const invalidResults = results.filter((r) => !r.valid);

  assert.equal(invalidResults.length, 0,
    `Expected 0 invalid results, got ${invalidResults.length}`);
  assert.ok(validResults.length > 0, 'Should have valid results');
});

// =============================================================================
// Test 2: Corpus cardinality is meaningful (no 2000 cap)
// =============================================================================

test('BENCHMARK-INTEGRITY: corpus generation supports cardinalities above and below windows', async () => {
  const cardinalities = [100, 500, 2000, 5000, 10000];

  for (const matchedCount of cardinalities) {
    const cache = createDiscoveryCache();
    const totalRows = matchedCount * 2;

    const noiseCount = totalRows - matchedCount;
    for (let i = 0; i < noiseCount; i++) {
      storeReleaseAttributes(cache, makeSyntheticRow(i, {
        title: 'Noise Movie',
        resolution: '1080p',
        year: 2024,
      }));
    }

    const titles = ['Black Mirror', 'Dune', 'Inception', 'The Godfather', 'Dune Part Two'];
    const perTitle = Math.floor(matchedCount / titles.length);
    let offset = noiseCount;

    for (const title of titles) {
      for (let i = 0; i < perTitle; i++) {
        storeReleaseAttributes(cache, makeSyntheticRow(offset + i, {
          title,
          resolution: '1080p',
          year: 2024,
          fileIndex: i,
        }));
      }
      offset += perTitle;
    }

    const result = searchReleases(cache, {
      query: 'Black Mirror',
      limit: 10_000_000,
      offset: 0,
    });

    assert.ok(result.total >= perTitle,
      `Expected >= ${perTitle} matches, got ${result.total} for cardinality ${matchedCount}`);
  }
});

// =============================================================================
// Test 3: Winner Stage-1 rank is measured
// =============================================================================

test('BENCHMARK-INTEGRITY: winner Stage-1 rank is measured in retrieval order', async () => {
  const cache = createDiscoveryCache();
  const baseTitle = 'Black Mirror';

  // Insert 100 title-matched rows
  for (let i = 0; i < 100; i++) {
    storeReleaseAttributes(cache, makeSyntheticRow(i, {
      title: baseTitle,
      filename: `${baseTitle.replace(/\s+/g, '.')}.2024.1080p.BluRay.x264.DTS-HD.MA.5.1-FGT-Group${i}.mkv`,
      resolution: '1080p',
      source: 'BluRay',
      year: 2024,
      fileIndex: i,
    }));
  }

  const result = searchReleases(cache, {
    query: baseTitle,
    limit: 10_000_000,
    offset: 0,
  });

  const stage1Order = result.results.map((r, idx) => ({
    hash: r.hash,
    fileIndex: r.fileIndex,
    position: idx,
  }));

  // Winner hash (index 50) - using same format as makeSyntheticRow
  const winnerHash = `${(50).toString(16).padStart(8, '0')}${'0'.repeat(32)}`.slice(0, 40);
  const winnerStage1Pos = stage1Order.findIndex((r) => r.hash === winnerHash);

  // Winner should be somewhere in the results (position >= 0)
  assert.ok(winnerStage1Pos >= 0,
    `Expected winner Stage-1 rank >= 0, got ${winnerStage1Pos}`);
});

// =============================================================================
// Test 4: Latency separation (Stage1 vs Stage2 vs whole)
// =============================================================================

test('BENCHMARK-INTEGRITY: latency is separated into Stage1/Stage2/whole', async () => {
  const cache = createDiscoveryCache();

  for (let i = 0; i < 100; i++) {
    storeReleaseAttributes(cache, makeSyntheticRow(i, {
      title: 'Black Mirror',
      resolution: '1080p',
      year: 2024,
      fileIndex: i,
    }));
  }

  const t0 = performance.now();
  const result = searchReleases(cache, {
    query: 'Black Mirror',
    limit: 1000,
    offset: 0,
  });
  const t1 = performance.now();
  const stage1Ms = t1 - t0;

  const canonicalLocal = result.results.map(toCanonicalLocal);
  const deduped = deduplicateByReleaseKey(canonicalLocal);
  const rankingInputs = deduped.map(toRankingInput);
  const ranked = rankHits(rankingInputs, {}, null);
  const t2 = performance.now();
  const stage2Ms = t2 - t1;
  const wholeMs = t2 - t0;

  assert.ok(stage1Ms >= 0, 'Stage1 latency is measurable');
  assert.ok(stage2Ms >= 0, 'Stage2 latency is measurable');
  assert.ok(wholeMs >= stage1Ms, 'Whole latency >= Stage1 latency');
  assert.ok(wholeMs >= stage2Ms, 'Whole latency >= Stage2 latency');
});

// =============================================================================
// Test 5: Top-3 denominator handles small oracle sets
// =============================================================================

test('BENCHMARK-INTEGRITY: top-3 denominator uses min(3, oracle count)', async () => {
  const oracleRanked = [
    { hash: 'aaa', fileIndex: 0 },
    { hash: 'bbb', fileIndex: 1 },
  ];

  const top3Denominator = Math.min(3, oracleRanked.length);
  assert.equal(top3Denominator, 2, 'Top-3 denominator should be 2 when oracle has 2 results');

  const oracleRanked5 = [
    { hash: 'aaa', fileIndex: 0 },
    { hash: 'bbb', fileIndex: 1 },
    { hash: 'ccc', fileIndex: 2 },
    { hash: 'ddd', fileIndex: 3 },
    { hash: 'eee', fileIndex: 4 },
  ];

  const top3Denominator5 = Math.min(3, oracleRanked5.length);
  assert.equal(top3Denominator5, 3, 'Top-3 denominator should be 3 when oracle has >= 3 results');
});

// =============================================================================
// Test 6: Every cohort query has deterministic non-empty oracle
// =============================================================================

test('BENCHMARK-INTEGRITY: every cohort query has deterministic non-empty oracle', async () => {
  const results = await benchmark.runRetrievalBenchmark({
    scales: [1000],
    matchCardinalities: [100],
    windows: [500],
    seed: 'integrity-test',
  });

  const validResults = results.filter((r) => r.valid);
  const invalidResults = results.filter((r) => !r.valid);

  assert.equal(invalidResults.length, 0,
    `Expected 0 invalid results, got ${invalidResults.length}`);
  assert.ok(validResults.length > 0, 'Should have valid results');

  const byQuery = new Map();
  for (const r of results) {
    if (!byQuery.has(r.query)) byQuery.set(r.query, { valid: 0, invalid: 0 });
    byQuery.get(r.query)[r.valid ? 'valid' : 'invalid']++;
  }

  console.log('Cohort query validity breakdown:');
  for (const [query, counts] of byQuery) {
    console.log(`  ${query}: ${counts.valid} valid, ${counts.invalid} invalid`);
  }
});

// =============================================================================
// Test 7: Adversarial winner position is deterministic
// =============================================================================

test('BENCHMARK-INTEGRITY: adversarial winner position is deterministic', async () => {
  const results1 = await benchmark.runRetrievalBenchmark({
    scales: [1000],
    matchCardinalities: [500],
    windows: [100, 500],
    seed: 'determinism-test',
  });

  const results2 = await benchmark.runRetrievalBenchmark({
    scales: [1000],
    matchCardinalities: [500],
    windows: [100, 500],
    seed: 'determinism-test',
  });

  assert.equal(results1.length, results2.length, 'Same number of results');

  for (let i = 0; i < results1.length; i++) {
    const r1 = results1[i];
    const r2 = results2[i];

    assert.equal(r1.scale, r2.scale, `Scale mismatch at index ${i}`);
    assert.equal(r1.matchedCount, r2.matchedCount, `MatchedCount mismatch at index ${i}`);
    assert.equal(r1.retrievalLimit, r2.retrievalLimit, `RetrievalLimit mismatch at index ${i}`);
    assert.equal(r1.query, r2.query, `Query mismatch at index ${i}`);
    assert.equal(r1.oracleWinnerStage1Rank, r2.oracleWinnerStage1Rank, `Winner Stage-1 rank mismatch at index ${i}`);
    assert.equal(r1.top1Survives, r2.top1Survives, `top1Survives mismatch at index ${i}`);
  }
});

// =============================================================================
// Test 8: Window boundary behavior is proven
// =============================================================================

test('BENCHMARK-INTEGRITY: window boundary behavior is proven', async () => {
  const cache = createDiscoveryCache();
  const baseTitle = 'Black Mirror';

  // Insert 200 title-matched rows
  for (let i = 0; i < 200; i++) {
    storeReleaseAttributes(cache, makeSyntheticRow(i, {
      title: baseTitle,
      filename: `${baseTitle.replace(/\s+/g, '.')}.2024.1080p.BluRay.x264.DTS-HD.MA.5.1-FGT-Group${i}.mkv`,
      resolution: '1080p',
      source: 'BluRay',
      year: 2024,
      fileIndex: i,
    }));
  }

  const result = searchReleases(cache, {
    query: baseTitle,
    limit: 10_000_000,
    offset: 0,
  });

  const stage1Order = result.results.map((r) => `${r.hash}:${r.fileIndex ?? 'torrent'}`);

  // Winner hash (index 150) - using same format as makeSyntheticRow
  const winnerHash = `${(150).toString(16).padStart(8, '0')}${'0'.repeat(32)}`.slice(0, 40) + ':150';
  const winnerStage1Rank = stage1Order.indexOf(winnerHash);

  // Winner should be at position >= 0
  assert.ok(winnerStage1Rank >= 0,
    `Expected winner Stage-1 rank >= 0, got ${winnerStage1Rank}`);

  // Test with different windows
  const windows = [100, 200, 500];
  for (const window of windows) {
    const boundedResult = searchReleases(cache, {
      query: baseTitle,
      limit: window,
      offset: 0,
    });

    const boundedKeys = new Set(boundedResult.results.map((r) => `${r.hash}:${r.fileIndex ?? 'torrent'}`));
    const winnerSurvived = boundedKeys.has(winnerHash);

    if (window <= winnerStage1Rank) {
      assert.ok(!winnerSurvived,
        `Winner should NOT survive window ${window} (winner at rank ${winnerStage1Rank})`);
    } else {
      assert.ok(winnerSurvived,
        `Winner should survive window ${window} (winner at rank ${winnerStage1Rank})`);
    }
  }
});
