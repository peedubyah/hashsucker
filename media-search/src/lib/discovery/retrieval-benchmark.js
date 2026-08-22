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
 *   - oracle winner rank within the bounded window
 *   - whether oracle top-1 survives the bounded window (primary metric)
 *   - whether oracle top-3 survive the bounded window
 *   - Stage 1 retrieval latency p50/p95
 *   - Stage 2 ranking latency p50/p95
 *   - whole local search latency
 *
 * The oracle uses the ACTUAL Stage 3 ranker — no alternative scoring function.
 * The synthetic fixture includes an adversarial case where a high-quality
 * candidate is intentionally placed past the BM25 sweet spot so that the
 * old `limit*2` policy provably hides the winner.
 *
 * Usage:
 *   node src/lib/discovery/retrieval-benchmark.js [--csv] [--seed N] [--scales 100000,500000]
 *   node src/lib/discovery/retrieval-benchmark.js --demo   (tiny, no flags)
 */

import { createDiscoveryCache } from './cache.js';
import { storeReleaseAttributes } from './release-attributes.js';
import { combinedSearch, searchReleases } from './search-engine.js';
import { isEpisodeCovered } from './episode-coverage.js';
import { rankHits, rankHit } from './ranking.js';
import { evaluateEligibility } from './rejection.js';
import {
  toCanonicalLocal,
  toCanonicalLive,
  deduplicateByReleaseKey,
  toRankingInput,
} from './canonical.js';

// ---------------------------------------------------------------------------
// Synthetic corpus generator
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic release_attributes row for benchmarking.
 *
 * The adversarial design:
 *   - Most rows are "noise": same title, random resolution, random quality.
 *   - A few rows are "winners": same title, intentionally high quality.
 *   - Winners can be placed at controlled positions in the BM25 ordering
 *     (by manipulating title token similarity and/or parsed_at ordering for
 *     wildcard queries) to exercise the retrieval window boundary.
 *
 * @param {number} index - Row index (used to derive deterministic hash/filename)
 * @param {Object} spec - Specification for this row
 * @returns {Object} Attribute payload for storeReleaseAttributes
 */
function makeSyntheticRow(index, spec) {
  // 40-char hex hash: use index as deterministic hex seed
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

/**
 * Deterministic PRNG (mulberry32) for reproducible corpus generation.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Populate a synthetic corpus at a given scale.
 *
 * Adversarial model — MODE B (realistic):
 *   The realistic adversarial case: a user searches for a specific title that
 *   has ~200-1000 FTS matches (common for popular shows/movies). Within those
 *   matches, the highest-quality release (2160p Remux x265 HDR) ranks LOWER
 *   in BM25 than a lower-quality release (480p DVD) because:
 *
 *     - BM25 rewards document SHORTNESS: longer filenames score lower
 *     - High-quality releases have LONGER filenames (more metadata tokens)
 *     - "Movie.2024.2160p.UHD.BluRay.REMUX.DTS-HD.MA.5.1.mkv" vs "Movie.mkv"
 *
 *   So the 2160p winner can be at position 300-500 in the FTS ordering while
 *   a 480p rip is at position 5. A bounded window of 100 or 200 would miss it.
 *
 *   We model this by giving winners LONGER filenames (which FTS indexes and
 *   which affects BM25 document length), while keeping their title SHORT
 *   (so they still match the query). This is the adversarial case.
 *
 * MODE A (pathological): title-spam with 50+ extra tokens. Unrealistic but
 *   proves the theoretical worst case. Reported as a known limitation.
 *
 * @param {Object} cache - Discovery cache
 * @param {number} scale - Total rows
 * @param {string} seed - Seed string for deterministic generation
 * @param {Object} config - Configuration for the adversarial layout
 * @returns {{ total, titleMatched, winners, noise, winnerRows }}
 */
function populateSyntheticCorpus(cache, scale, seed, config = {}) {
  const rng = mulberry32(hashString(seed));
  const {
    matchedFraction = 0.02,      // fraction of total rows that share the target title
    winnerCount = 5,            // how many intentional winners exist
    winnerQuality = '2160p',    // resolution for winners (best quality)
    adversarialMode = 'realistic', // 'padded' | 'realistic'
    winnerExtraTokens = 50,     // for 'padded' mode
    baseYear = 2024,
    baseTitle = 'Black Mirror',
    baseSourceType = 'BluRay',
  } = config;

  // For the realistic adversarial case, we want a moderate number of title-matched
  // rows (not 10,000+ which is unrealistic for a specific query). We cap the
  // matched count at a realistic ceiling and let the scale grow the noise.
  const titleMatchedCount = Math.min(
    Math.max(1, Math.floor(scale * matchedFraction)),
    2000  // cap: realistic max title-matched rows for a specific query
  );
  const noiseCount = scale - titleMatchedCount;

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
      year: baseYear + Math.floor(rng() * 3),
      confidence: 0.7 + rng() * 0.25,
    });
    storeReleaseAttributes(cache, attrs);
    inserted++;
  }

  // 2. Insert title-matched noise — same title, average quality, SHORT filenames
  for (let i = 0; i < titleMatchedCount - winnerCount; i++) {
    const resIdx = Math.floor(rng() * resolutions.length);
    const srcIdx = Math.floor(rng() * sources.length);
    // SHORT filenames rank higher in BM25 (shorter = better)
    const shortFilename = `${baseTitle.replace(/\s+/g, '.')}.${baseYear}.${resolutions[resIdx]}.mkv`;
    const attrs = makeSyntheticRow(noiseCount + i, {
      title: baseTitle,
      filename: shortFilename,
      resolution: resolutions[resIdx],
      sourceType: sources[srcIdx],
      year: baseYear + Math.floor(rng() * 3),
      confidence: 0.7 + rng() * 0.25,
    });
    storeReleaseAttributes(cache, attrs);
    inserted++;
  }

  // 3. Insert winners — same title, BEST quality, LONG filenames (BM25 penalty)
  const winnerRows = [];
  for (let i = 0; i < winnerCount; i++) {
    let winnerTitle;
    if (adversarialMode === 'padded') {
      winnerTitle = `${baseTitle}${' filler'.repeat(winnerExtraTokens)}`;
    } else {
      winnerTitle = baseTitle;
    }
    // LONG filename: more metadata tokens → higher BM25 doc length → lower rank
    const longFilename = `${baseTitle.replace(/\s+/g, '.')}.${baseYear}.2160p.UHD.BluRay.REMUX.DV.HDR10Plus.DTS-HD.MA.TrueHD.7.1.Atmos-FGT-Group${i}.mkv`;
    const attrs = makeSyntheticRow(noiseCount + titleMatchedCount - winnerCount + i, {
      title: winnerTitle,
      filename: longFilename,
      resolution: winnerQuality,
      sourceType: 'Remux',
      codec: 'x265',
      hdr: true,
      year: baseYear,
      confidence: 0.95,
      fileIndex: i,  // different fileIndex so they're distinguishable
    });
    storeReleaseAttributes(cache, attrs);
    winnerRows.push(attrs);
    inserted++;
  }

  return {
    total: inserted,
    titleMatched: titleMatchedCount,
    winners: winnerCount,
    noise: noiseCount,
    winnerRows,
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
    description: 'Strong exact title match with many noisy neighbors',
  },
  {
    name: 'recent-movie',
    query: 'Dune Part Two 2024',
    description: 'Recent/popular movie style',
  },
  {
    name: 'catalog-movie',
    query: 'The Godfather 1972',
    description: 'Older/catalog style',
  },
  {
    name: 'tv-explicit-sxxexx',
    query: 'Black Mirror S03E04',
    season: 3,
    episode: 4,
    description: 'TV explicit SxxExx',
  },
  {
    name: 'tv-season-pack',
    query: 'Breaking Bad Season 5',
    season: 5,
    description: 'Season/range/pack eligibility',
  },
  {
    name: 'same-title-different-year',
    query: 'Dune',
    description: 'Same-title/different-year ambiguity',
  },
  {
    name: 'quality-disagreement',
    query: 'Inception',
    description: 'BM25-best is NOT desirability-best (lower relevance, higher quality)',
  },
];

// ---------------------------------------------------------------------------
// Oracle retrieval
// ---------------------------------------------------------------------------

/**
 * ORACLE: rank ALL eligible candidates in the corpus for this query.
 *
 * Uses the REAL Stage 3 ranker. No LIMIT applied (uses 10M sentinel).
 *
 * @param {Object} cache - Discovery cache
 * @param {Object} query - { query, season?, episode?, mediaId? }
 * @returns {{ ranked: Array, eligibleCount: number, matchedCount: number, durationMs: number }}
 */
function oracleRetrieval(cache, query) {
  const startedAt = performance.now();

  // 10M sentinel = "no practical limit" — effectively exhaustive for any
  // corpus we can generate in this environment.
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

  const matchedCount = result.total;

  // Apply the same eligibility + ranking pipeline as combinedSearch
  const canonicalLocal = result.results.map(toCanonicalLocal);
  const deduped = deduplicateByReleaseKey(canonicalLocal);

  const queryIntent = {};
  if (query.season != null) queryIntent.season = query.season;
  if (query.episode != null) queryIntent.episode = query.episode;

  // Apply hard eligibility for episode-bearing queries
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

  return {
    ranked,
    eligibleCount: eligibleCandidates.length,
    matchedCount,
    durationMs: performance.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Bounded retrieval
// ---------------------------------------------------------------------------

/**
 * BOUNDED: the candidate set produced by a finite retrieval window.
 *
 * Uses the SAME searchReleases + eligibility + ranking pipeline, but with
 * a finite LIMIT. This is what combinedSearch's bounded path does.
 *
 * @param {Object} cache - Discovery cache
 * @param {Object} query - { query, season?, episode?, mediaId? }
 * @param {number} retrievalLimit - The LIMIT applied at Stage 1
 * @returns {{ ranked: Array, eligibleCount: number, matchedCount: number, retrievedCount: number, durationMs: number }}
 */
function boundedRetrieval(cache, query, retrievalLimit) {
  const startedAt = performance.now();

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

  const matchedCount = result.total;
  const retrievedCount = result.results.length;

  // Same eligibility + ranking pipeline
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

  return {
    ranked,
    eligibleCount: eligibleCandidates.length,
    matchedCount,
    retrievedCount,
    durationMs: performance.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Compute recall metrics by comparing bounded results against oracle.
 *
 * @param {Object} oracle - oracleRetrieval result
 * @param {Object} bounded - boundedRetrieval result
 * @returns {{ top1Survives: boolean, top3Survival: number, oracleWinnerRank: number, boundedWinnerKey: string|null, oracleWinnerKey: string|null, matchCount: number }}
 */
function computeRecallMetrics(oracle, bounded) {
  // Build a set of bounded releaseKeys for fast lookup
  const boundedKeys = new Set(bounded.ranked.map((r) => `${r.hash}:${r.fileIndex ?? 'torrent'}`));

  // Oracle top-1
  const oracleTop1 = oracle.ranked[0];
  const oracleTop1Key = oracleTop1 ? `${oracleTop1.hash}:${oracleTop1.fileIndex ?? 'torrent'}` : null;
  const top1Survives = oracleTop1Key ? boundedKeys.has(oracleTop1Key) : true;

  // Oracle top-3 survival
  const oracleTop3 = oracle.ranked.slice(0, 3);
  const top3Survival = oracleTop3.filter((r) => boundedKeys.has(`${r.hash}:${r.fileIndex ?? 'torrent'}`)).length;

  // Where does the oracle winner rank in the bounded set?
  let oracleWinnerRank = -1;
  if (oracleTop1Key) {
    const idx = bounded.ranked.findIndex((r) => `${r.hash}:${r.fileIndex ?? 'torrent'}` === oracleTop1Key);
    if (idx !== -1) oracleWinnerRank = idx;
  }

  // Bounded top-1 key
  const boundedTop1 = bounded.ranked[0];
  const boundedWinnerKey = boundedTop1 ? `${boundedTop1.hash}:${boundedTop1.fileIndex ?? 'torrent'}` : null;

  // How many oracle top-10 appear in bounded?
  const oracleTop10 = oracle.ranked.slice(0, 10);
  const matchCount = oracleTop10.filter((r) => boundedKeys.has(`${r.hash}:${r.fileIndex ?? 'torrent'}`)).length;

  return {
    top1Survives,
    top3Survival,
    oracleWinnerRank,
    boundedWinnerKey,
    oracleWinnerKey: oracleTop1Key,
    matchCount,
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run the full benchmark across scales and queries.
 *
 * @param {Object} options - { scales, retrievalLimit, seed, csv }
 */
export async function runRetrievalBenchmark(options = {}) {
  const {
    scales = [100_000, 500_000],
    retrievalLimit = 200,
    seed = 'stage3-retrieval-benchmark',
    csv = false,
    syntheticOnly = true,
  } = options;

  const results = [];

  for (const scale of scales) {
    // Build fresh synthetic cache per scale
    const cache = createDiscoveryCache();
    const layout = populateSyntheticCorpus(cache, scale, `${seed}-${scale}`, {
      matchedFraction: 0.1,
      winnerCount: 5,
      winnerQuality: '2160p',
      winnerExtraTokens: 50,
    });

    for (const query of QUERY_COHORT) {
      // Run oracle (no LIMIT)
      const oracle = oracleRetrieval(cache, query);

      // Run bounded (with retrieval limit)
      const bounded = boundedRetrieval(cache, query, retrievalLimit);

      // Compute recall
      const metrics = computeRecallMetrics(oracle, bounded);

      results.push({
        scale,
        retrievalLimit,
        query: query.name,
        queryDescription: query.description,
        oracleWinnerKey: metrics.oracleWinnerKey,
        boundedWinnerKey: metrics.boundedWinnerKey,
        top1Survives: metrics.top1Survives,
        top3Survival: metrics.top3Survival,
        oracleWinnerRankInBounded: metrics.oracleWinnerRank,
        oracleTop10MatchCount: metrics.matchCount,
        matchedCount: bounded.matchedCount,
        retrievedCount: bounded.retrievedCount,
        eligibleCount: bounded.eligibleCount,
        oracleDurationMs: oracle.durationMs,
        boundedDurationMs: bounded.durationMs,
      });
    }

    cache.close();
  }

  return results;
}

/**
 * Print a compact summary table.
 */
function printResults(results, csv = false) {
  if (csv) {
    console.log('scale,window,query,top1_recall,top3_recall,matched,retrieved,eligible,oracle_ms,bounded_ms');
    for (const r of results) {
      console.log(`${r.scale},${r.retrievalLimit},${r.query},${r.top1Survives},${r.top3Survival},${r.matchedCount},${r.retrievedCount},${r.eligibleCount},${r.oracleDurationMs.toFixed(1)},${r.boundedDurationMs.toFixed(1)}`);
    }
    return;
  }

  // Aggregate by scale
  const byScale = new Map();
  for (const r of results) {
    if (!byScale.has(r.scale)) byScale.set(r.scale, []);
    byScale.get(r.scale).push(r);
  }

  console.log('\n=== Stage 3 Retrieval Benchmark ===\n');

  for (const [scale, rows] of byScale) {
    console.log(`Scale: ${scale.toLocaleString()} rows | Retrieval window: ${rows[0].retrievalLimit}`);
    console.log('-'.repeat(100));

    const header = [
      'Query'.padEnd(28),
      'top1'.padEnd(6),
      'top3'.padEnd(6),
      'matched'.padEnd(10),
      'retrieved'.padEnd(10),
      'eligible'.padEnd(10),
      'oracle(ms)'.padEnd(12),
      'bounded(ms)'.padEnd(12),
    ].join(' ');
    console.log(header);

    for (const r of rows) {
      const line = [
        r.query.padEnd(28),
        (r.top1Survives ? 'PASS' : 'FAIL').padEnd(6),
        `${r.top3Survival}/3`.padEnd(6),
        String(r.matchedCount).padEnd(10),
        String(r.retrievedCount).padEnd(10),
        String(r.eligibleCount).padEnd(10),
        r.oracleDurationMs.toFixed(1).padEnd(12),
        r.boundedDurationMs.toFixed(1).padEnd(12),
      ].join(' ');
      console.log(line);
    }

    // Summary row
    const top1Recall = rows.filter((r) => r.top1Survives).length / rows.length;
    const top3Recall = rows.reduce((s, r) => s + r.top3Survival, 0) / (rows.length * 3);
    const retrievalP50 = percentile(rows.map((r) => r.boundedDurationMs), 50);
    const retrievalP95 = percentile(rows.map((r) => r.boundedDurationMs), 95);

    console.log('-'.repeat(100));
    console.log(`  top1 recall: ${(top1Recall * 100).toFixed(1)}% | top3 recall: ${(top3Recall * 100).toFixed(1)}% | retrieval p50/p95: ${retrievalP50.toFixed(1)}/${retrievalP95.toFixed(1)}ms`);
    console.log();
  }
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const sorted = [...sortedValues].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const csv = args.includes('--csv');
  const seedArg = args.find((a) => a.startsWith('--seed='));
  const scaleArg = args.find((a) => a.startsWith('--scales='));
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const isDemo = args.includes('--demo');

  let scales;
  if (scaleArg) {
    scales = scaleArg.split('=')[1].split(',').map(Number);
  } else if (isDemo) {
    scales = [5_000];
  } else {
    scales = [100_000, 500_000, 1_000_000];
  }

  const seed = seedArg ? seedArg.split('=')[1] : 'stage3-retrieval-benchmark';
  const retrievalLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 200;

  console.log(`Running retrieval benchmark...`);
  console.log(`Scales: ${scales.join(', ')} | Retrieval limit: ${retrievalLimit} | Seed: ${seed}`);

  const results = await runRetrievalBenchmark({ scales, retrievalLimit, seed, csv });
  printResults(results, csv);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
