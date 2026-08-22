/**
 * Retrieval Benchmark Harness — Stage 3 Recall Measurement
 *
 * Compares two retrieval policies for the DMM corpus search:
 *
 *   A. ORACLE: exhaustive eligible candidate set ranked by the real
 *      Stage 3 ranker (rankHits over ALL rows in release_attributes
 *      matching the FTS query). This represents the ideal winner set.
 *
 *   B. BOUNDED: the candidate set produced by a Stage 1 retrieval window
 *      (the current `searchReleases LIMIT` policy), fed through the same
 *      eligibility + ranker pipeline.
 *
 * Measurement:
 *   - retrieval window size (rows fetched before ranking)
 *   - candidates matched before the LIMIT
 *   - eligible candidates after hard gates
 *   - oracle winner rank in Stage-1 RETRIEVAL ORDER (before global ranking)
 *   - whether oracle top-1 survives the bounded window (primary metric)
 *   - whether oracle top-3 survive the bounded window
 *   - Stage 1 retrieval latency p50/p95 (SQL/FTS only)
 *   - Stage 2 ranking latency p50/p95 (canonicalize + eligibility + dedup + rank)
 *   - whole local search latency
 *
 * Critical validity rules:
 *   - Queries with ZERO oracle results are classified N/A, NOT PASS
 *   - The synthetic corpus must have meaningful matched-set sizes both BELOW
 *     and ABOVE candidate windows (to avoid circularity with the 2000 cap)
 *   - Each cohort query must have a deterministic generated fixture with
 *     non-empty oracle, or be reported as N/A
 *
 * BM25 adversarial case:
 *   FTS5's BM25 ranks documents with MORE matching tokens higher.
 *   The adversarial case is: winner has SHORT filename (BM25-penalized),
 *   noise has LONG filenames (BM25-favored). A small retrieval window
 *   misses the winner because it sits at a lower Stage-1 position.
 */

import { performance } from 'node:perf_hooks';

import { createDiscoveryCache } from './cache.js';
import { storeReleaseAttributes } from './release-attributes.js';
import { searchReleases } from './search-engine.js';
import { toCanonicalLocal, deduplicateByReleaseKey, toRankingInput } from './canonical.js';
import { rankHits } from './ranking.js';
import { evaluateEligibility } from './rejection.js';

// ---------------------------------------------------------------------------
// Synthetic row generation
// ---------------------------------------------------------------------------

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

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Query cohort
// ---------------------------------------------------------------------------

const QUERY_COHORT = [
  {
    name: 'exact-title-popular',
    query: 'Black Mirror',
    description: 'Strong exact title match',
    title: 'Black Mirror',
    year: 2024,
  },
  {
    name: 'recent-movie',
    query: 'Dune Part Two',
    description: 'Recent/popular movie style',
    title: 'Dune Part Two',
    year: 2024,
  },
  {
    name: 'catalog-movie',
    query: 'The Godfather',
    description: 'Classic catalog movie',
    title: 'The Godfather',
    year: 1972,
  },
  {
    name: 'same-title-different-year',
    query: 'Dune',
    description: 'Same-title/different-year ambiguity',
    title: 'Dune',
    year: 2021,
  },
  {
    name: 'quality-disagreement',
    query: 'Inception',
    description: 'BM25-best is NOT desirability-best',
    title: 'Inception',
    year: 2010,
  },
];

// ---------------------------------------------------------------------------
// Corpus generation
// ---------------------------------------------------------------------------

/**
 * Populate a synthetic corpus with controlled match cardinality.
 *
 * IMPORTANT: No cap on matchedCount. The caller specifies the exact
 * number of title-matched rows per query.
 *
 * BM25 adversarial design:
 *   - Winners have SHORT filenames (BM25-penalized, rank LOWER in Stage-1)
 *   - Noise has LONG filenames (BM25-favored, rank HIGHER in Stage-1)
 *   This creates a case where a small retrieval window misses the winner.
 */
function populateSyntheticCorpus(cache, totalRows, seed, config = {}) {
  const rng = mulberry32(hashString(seed));
  const {
    matchedCount = 1000,
    winnerCount = 5,
    winnerQuality = '2160p',
  } = config;

  const cohortSize = QUERY_COHORT.length;
  const matchedPerQuery = Math.max(1, Math.floor(matchedCount / cohortSize));
  const totalMatched = matchedPerQuery * cohortSize;
  const noiseCount = totalRows - totalMatched;

  let inserted = 0;

  // 1. Insert noise rows (random titles, random qualities)
  const noiseTitles = ['Stranger Things', 'The Witcher', 'Breaking Bad', 'Dark', 'Narcos', 'Peaky Blinders', 'Mindhunter', 'Ozark', 'The Crown', 'Severance'];
  const resolutions = ['480p', '720p', '1080p'];
  const sources = ['DVD', 'WEBRip', 'WEB-DL', 'BluRay'];

  for (let i = 0; i < noiseCount; i++) {
    const titleIdx = Math.floor(rng() * noiseTitles.length);
    const resIdx = Math.floor(rng() * resolutions.length);
    const srcIdx = Math.floor(rng() * sources.length);
    const attrs = makeSyntheticRow(i, {
      title: noiseTitles[titleIdx],
      resolution: resolutions[resIdx],
      sourceType: sources[srcIdx],
      year: 2024 + Math.floor(rng() * 3),
      confidence: 0.7 + rng() * 0.25,
    });
    storeReleaseAttributes(cache, attrs);
    inserted++;
  }

  // 2. For each cohort query, insert title-matched rows
  let currentOffset = noiseCount;
  const allWinnerRows = [];

  for (const queryDef of QUERY_COHORT) {
    const baseTitle = queryDef.title;
    const baseYear = queryDef.year;

    // Insert title-matched noise with LONG filenames (BM25-favored)
    // These rank HIGHER in Stage-1 due to more tokens
    for (let i = 0; i < matchedPerQuery - winnerCount; i++) {
      const resIdx = Math.floor(rng() * resolutions.length);
      const srcIdx = Math.floor(rng() * sources.length);
      // LONG filename: more metadata tokens → BM25-favored → HIGHER rank
      const longFilename = `${baseTitle.replace(/\s+/g, '.')}.${baseYear}.${resolutions[resIdx]}.${sources[srcIdx]}.x264.DTS-HD.MA.5.1-FGT-Group${i}.mkv`;
      const attrs = makeSyntheticRow(currentOffset + i, {
        title: baseTitle,
        filename: longFilename,
        resolution: resolutions[resIdx],
        sourceType: sources[srcIdx],
        year: baseYear + Math.floor(rng() * 3),
        confidence: 0.7 + rng() * 0.25,
      });
      storeReleaseAttributes(cache, attrs);
      inserted++;
    }

    // Insert winners with SHORT filenames (BM25-penalized)
    // These rank LOWER in Stage-1 due to fewer tokens
    for (let i = 0; i < winnerCount; i++) {
      // SHORT filename: fewer tokens → BM25-penalized → LOWER rank
      const shortFilename = `${baseTitle.replace(/\s+/g, '.')}.${baseYear}.2160p.mkv`;
      const attrs = makeSyntheticRow(currentOffset + matchedPerQuery - winnerCount + i, {
        title: baseTitle,
        filename: shortFilename,
        resolution: winnerQuality,
        sourceType: 'Remux',
        codec: 'x265',
        hdr: true,
        year: baseYear,
        confidence: 0.95,
        fileIndex: i,
      });
      storeReleaseAttributes(cache, attrs);
      allWinnerRows.push(attrs);
      inserted++;
    }

    currentOffset += matchedPerQuery;
  }

  return {
    total: inserted,
    titleMatched: totalMatched,
    winners: winnerCount * cohortSize,
    noise: noiseCount,
    winnerRows: allWinnerRows,
  };
}

// ---------------------------------------------------------------------------
// Oracle retrieval
// ---------------------------------------------------------------------------

function oracleRetrieval(cache, query) {
  const t0 = performance.now();

  const ALL_LIMIT = 10_000_000;

  const result = searchReleases(cache, {
    query: query.query,
    season: query.season,
    episode: query.episode,
    limit: ALL_LIMIT,
    offset: 0,
    includeProviders: true,
    includeMedia: true,
    mediaId: query.mediaId || null,
  });

  const t1 = performance.now();

  const matchedCount = result.total;

  const canonicalLocal = result.results.map(toCanonicalLocal);
  const deduped = deduplicateByReleaseKey(canonicalLocal);

  const queryIntent = {};
  if (query.season != null) queryIntent.season = query.season;
  if (query.episode != null) queryIntent.episode = query.episode;

  const eligibleCandidates = deduped.filter((candidate) => {
    if (candidate.sources.some((s) => s.origin === 'corpus')) {
      if (queryIntent.season != null && queryIntent.episode != null) {
        const evaluation = evaluateEligibility(candidate, queryIntent.season, queryIntent.episode);
        return evaluation.eligible;
      }
    }
    return true;
  });

  const rankingInputs = eligibleCandidates.map(toRankingInput);
  const ranked = rankHits(rankingInputs, queryIntent, query.mediaId || null);

  const t2 = performance.now();

  return {
    ranked,
    eligibleCount: eligibleCandidates.length,
    matchedCount,
    stage1Ms: t1 - t0,
    stage2Ms: t2 - t1,
    wholeMs: t2 - t0,
  };
}

// ---------------------------------------------------------------------------
// Bounded retrieval
// ---------------------------------------------------------------------------

function boundedRetrieval(cache, query, retrievalLimit) {
  const t0 = performance.now();

  const result = searchReleases(cache, {
    query: query.query,
    season: query.season,
    episode: query.episode,
    limit: retrievalLimit,
    offset: 0,
    includeProviders: true,
    includeMedia: true,
    mediaId: query.mediaId || null,
  });

  const t1 = performance.now();

  const matchedCount = result.total;
  const retrievedCount = result.results.length;

  const canonicalLocal = result.results.map(toCanonicalLocal);
  const deduped = deduplicateByReleaseKey(canonicalLocal);

  const queryIntent = {};
  if (query.season != null) queryIntent.season = query.season;
  if (query.episode != null) queryIntent.episode = query.episode;

  const eligibleCandidates = deduped.filter((candidate) => {
    if (candidate.sources.some((s) => s.origin === 'corpus')) {
      if (queryIntent.season != null && queryIntent.episode != null) {
        const evaluation = evaluateEligibility(candidate, queryIntent.season, queryIntent.episode);
        return evaluation.eligible;
      }
    }
    return true;
  });

  const rankingInputs = eligibleCandidates.map(toRankingInput);
  const ranked = rankHits(rankingInputs, queryIntent, query.mediaId || null);

  const t2 = performance.now();

  return {
    ranked,
    eligibleCount: eligibleCandidates.length,
    matchedCount,
    retrievedCount,
    stage1Ms: t1 - t0,
    stage2Ms: t2 - t1,
    wholeMs: t2 - t0,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function computeRecallMetrics(oracle, bounded, oracleStage1Order) {
  if (!oracle.ranked || oracle.ranked.length === 0) {
    return { valid: false, reason: 'zero-oracle' };
  }

  const boundedKeys = new Set(bounded.ranked.map((r) => `${r.hash}:${r.fileIndex ?? 'torrent'}`));

  const oracleTop1 = oracle.ranked[0];
  const oracleTop1Key = oracleTop1 ? `${oracleTop1.hash}:${oracleTop1.fileIndex ?? 'torrent'}` : null;
  const top1Survives = oracleTop1Key ? boundedKeys.has(oracleTop1Key) : false;

  const top3Denominator = Math.min(3, oracle.ranked.length);
  const oracleTop3 = oracle.ranked.slice(0, top3Denominator);
  const top3Survival = oracleTop3.filter((r) => boundedKeys.has(`${r.hash}:${r.fileIndex ?? 'torrent'}`)).length;

  let oracleWinnerRank = -1;
  if (oracleTop1Key) {
    const idx = bounded.ranked.findIndex((r) => `${r.hash}:${r.fileIndex ?? 'torrent'}` === oracleTop1Key);
    if (idx !== -1) oracleWinnerRank = idx;
  }

  let oracleWinnerStage1Rank = -1;
  if (oracleTop1Key && oracleStage1Order) {
    const idx = oracleStage1Order.indexOf(oracleTop1Key);
    if (idx !== -1) oracleWinnerStage1Rank = idx;
  }

  const boundedTop1 = bounded.ranked[0];
  const boundedWinnerKey = boundedTop1 ? `${boundedTop1.hash}:${boundedTop1.fileIndex ?? 'torrent'}` : null;

  const oracleTop10 = oracle.ranked.slice(0, 10);
  const matchCount = oracleTop10.filter((r) => boundedKeys.has(`${r.hash}:${r.fileIndex ?? 'torrent'}`)).length;

  return {
    valid: true,
    top1Survives,
    top3Survival,
    top3Denominator,
    oracleWinnerRank,
    oracleWinnerStage1Rank,
    boundedWinnerKey,
    oracleWinnerKey: oracleTop1Key,
    matchCount,
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runRetrievalBenchmark(options = {}) {
  const {
    scales = [100_000],
    matchCardinalities = [100, 500, 2000, 5000, 10000],
    windows = [100, 200, 500, 1000, 2000, 5000],
    seed = 'stage3-retrieval-benchmark',
    csv = false,
  } = options;

  const results = [];

  for (const scale of scales) {
    for (const matchedCount of matchCardinalities) {
      if (matchedCount >= scale) continue;

      const cache = createDiscoveryCache();
      const layout = populateSyntheticCorpus(cache, scale, `${seed}-${scale}-${matchedCount}`, {
        matchedCount,
        winnerCount: 5,
        winnerQuality: '2160p',
      });

      for (const query of QUERY_COHORT) {
        const oracle = oracleRetrieval(cache, query);

        const ALL_LIMIT = 10_000_000;
        const oracleRawResult = searchReleases(cache, {
          query: query.query,
          season: query.season,
          episode: query.episode,
          limit: ALL_LIMIT,
          offset: 0,
          includeProviders: true,
          includeMedia: true,
          mediaId: query.mediaId || null,
        });
        const oracleStage1Order = oracleRawResult.results.map(
          (r) => `${r.hash}:${r.fileIndex ?? 'torrent'}`
        );

        for (const retrievalLimit of windows) {
          const bounded = boundedRetrieval(cache, query, retrievalLimit);

          const metrics = computeRecallMetrics(oracle, bounded, oracleStage1Order);

          results.push({
            scale,
            matchedCount,
            retrievalLimit,
            query: query.name,
            queryDescription: query.description,
            valid: metrics.valid,
            invalidReason: metrics.reason || null,
            oracleWinnerKey: metrics.oracleWinnerKey,
            boundedWinnerKey: metrics.boundedWinnerKey,
            top1Survives: metrics.top1Survives ?? null,
            top3Survival: metrics.top3Survival ?? null,
            top3Denominator: metrics.top3Denominator ?? null,
            oracleWinnerRank: metrics.oracleWinnerRank,
            oracleWinnerStage1Rank: metrics.oracleWinnerStage1Rank,
            oracleTop10MatchCount: metrics.matchCount,
            matchedCountOracle: oracle.matchedCount,
            matchedCountBounded: bounded.matchedCount,
            retrievedCount: bounded.retrievedCount,
            eligibleCount: bounded.eligibleCount,
            oracleStage1Ms: oracle.stage1Ms,
            oracleStage2Ms: oracle.stage2Ms,
            oracleWholeMs: oracle.wholeMs,
            boundedStage1Ms: bounded.stage1Ms,
            boundedStage2Ms: bounded.stage2Ms,
            boundedWholeMs: bounded.wholeMs,
          });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const sorted = [...sortedValues].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function printResults(results, csv = false) {
  if (csv) {
    console.log([
      'scale', 'matchedCount', 'retrievalLimit', 'query', 'valid', 'invalidReason',
      'top1Survives', 'top3Survival', 'top3Denominator', 'oracleWinnerStage1Rank',
      'matchedCountOracle', 'retrievedCount', 'eligibleCount',
      'boundedStage1Ms', 'boundedStage2Ms', 'boundedWholeMs',
    ].join(','));
    for (const r of results) {
      console.log([
        r.scale, r.matchedCount, r.retrievalLimit, r.query, r.valid, r.invalidReason || '',
        r.top1Survives ?? '', r.top3Survival ?? '', r.top3Denominator ?? '',
        r.oracleWinnerStage1Rank, r.matchedCountOracle, r.retrievedCount, r.eligibleCount,
        r.boundedStage1Ms.toFixed(2), r.boundedStage2Ms.toFixed(2), r.boundedWholeMs.toFixed(2),
      ].join(','));
    }
    return;
  }

  const byScaleAndCardinality = new Map();
  for (const r of results) {
    const key = `${r.scale}-${r.matchedCount}`;
    if (!byScaleAndCardinality.has(key)) byScaleAndCardinality.set(key, []);
    byScaleAndCardinality.get(key).push(r);
  }

  console.log('\n=== Stage 3 Retrieval Benchmark (Corrected) ===\n');

  const validResults = results.filter((r) => r.valid);
  const invalidResults = results.filter((r) => !r.valid);
  console.log(`Total trials: ${results.length}`);
  console.log(`Valid (non-empty oracle): ${validResults.length}`);
  console.log(`Invalid (zero-oracle, excluded): ${invalidResults.length}`);
  if (invalidResults.length > 0) {
    const invalidByQuery = new Map();
    for (const r of invalidResults) {
      invalidByQuery.set(r.query, (invalidByQuery.get(r.query) || 0) + 1);
    }
    console.log('Invalid breakdown:');
    for (const [q, count] of invalidByQuery) {
      console.log(`  ${q}: ${count} trials`);
    }
  }
  console.log();

  for (const [key, rows] of byScaleAndCardinality) {
    const [scale, matchedCount] = key.split('-');
    console.log(`Scale: ${Number(scale).toLocaleString()} rows | Matched: ${Number(matchedCount).toLocaleString()} title-matched rows`);
    console.log('='.repeat(140));

    const header = [
      'Window'.padEnd(8), 'Query'.padEnd(24), 'valid'.padEnd(6), 'top1'.padEnd(6),
      'top3'.padEnd(8), 'winnerStage1'.padEnd(14), 'matched'.padEnd(10),
      'retrieved'.padEnd(10), 'eligible'.padEnd(10), 'St1(ms)'.padEnd(10),
      'St2(ms)'.padEnd(10), 'Whole(ms)'.padEnd(10),
    ].join(' ');
    console.log(header);

    for (const r of rows) {
      const line = [
        String(r.retrievalLimit).padEnd(8), r.query.padEnd(24),
        (r.valid ? 'Y' : 'N').padEnd(6),
        (r.top1Survives == null ? 'N/A' : (r.top1Survives ? 'PASS' : 'FAIL')).padEnd(6),
        (r.top3Survival == null ? 'N/A' : `${r.top3Survival}/${r.top3Denominator}`).padEnd(8),
        String(r.oracleWinnerStage1Rank).padEnd(14),
        String(r.matchedCountOracle).padEnd(10), String(r.retrievedCount).padEnd(10),
        String(r.eligibleCount).padEnd(10), r.boundedStage1Ms.toFixed(1).padEnd(10),
        r.boundedStage2Ms.toFixed(1).padEnd(10), r.boundedWholeMs.toFixed(1).padEnd(10),
      ].join(' ');
      console.log(line);
    }

    const validRows = rows.filter((r) => r.valid);
    if (validRows.length > 0) {
      const top1Recall = validRows.filter((r) => r.top1Survives).length / validRows.length;
      const top3Recall = validRows.reduce((s, r) => s + (r.top3Survival || 0), 0) /
                         validRows.reduce((s, r) => s + (r.top3Denominator || 0), 0);
      const stage1P50 = percentile(validRows.map((r) => r.boundedStage1Ms), 50);
      const stage1P95 = percentile(validRows.map((r) => r.boundedStage1Ms), 95);
      const stage2P50 = percentile(validRows.map((r) => r.boundedStage2Ms), 50);
      const stage2P95 = percentile(validRows.map((r) => r.boundedStage2Ms), 95);
      const wholeP50 = percentile(validRows.map((r) => r.boundedWholeMs), 50);
      const wholeP95 = percentile(validRows.map((r) => r.boundedWholeMs), 95);

      console.log('-'.repeat(140));
      console.log(`  top1 recall: ${(top1Recall * 100).toFixed(1)}% | top3 recall: ${(top3Recall * 100).toFixed(1)}% | valid trials: ${validRows.length}/${rows.length}`);
      console.log(`  Stage1 p50/p95: ${stage1P50.toFixed(1)}/${stage1P95.toFixed(1)}ms | Stage2 p50/p95: ${stage2P50.toFixed(1)}/${stage2P95.toFixed(1)}ms | Whole p50/p95: ${wholeP50.toFixed(1)}/${wholeP95.toFixed(1)}ms`);
    } else {
      console.log('-'.repeat(140));
      console.log(`  NO VALID TRIALS`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const csv = args.includes('--csv');
  const seedArg = args.find((a) => a.startsWith('--seed='));
  const scaleArg = args.find((a) => a.startsWith('--scales='));
  const matchedArg = args.find((a) => a.startsWith('--matched='));
  const windowArg = args.find((a) => a.startsWith('--windows='));
  const isDemo = args.includes('--demo');

  let scales;
  if (scaleArg) {
    scales = scaleArg.split('=')[1].split(',').map(Number);
  } else if (isDemo) {
    scales = [10_000];
  } else {
    scales = [100_000];
  }

  let matchCardinalities;
  if (matchedArg) {
    matchCardinalities = matchedArg.split('=')[1].split(',').map(Number);
  } else if (isDemo) {
    matchCardinalities = [100, 500];
  } else {
    matchCardinalities = [100, 500, 2000, 5000, 10000];
  }

  let windows;
  if (windowArg) {
    windows = windowArg.split('=')[1].split(',').map(Number);
  } else if (isDemo) {
    windows = [100, 500];
  } else {
    windows = [100, 200, 500, 1000, 2000, 5000];
  }

  const seed = seedArg ? seedArg.split('=')[1] : 'stage3-retrieval-benchmark';

  console.log(`Running corrected retrieval benchmark...`);
  console.log(`Scales: ${scales.join(', ')} | Matched: ${matchCardinalities.join(', ')} | Windows: ${windows.join(', ')} | Seed: ${seed}`);

  const results = await runRetrievalBenchmark({ scales, matchCardinalities, windows, seed, csv });
  printResults(results, csv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
