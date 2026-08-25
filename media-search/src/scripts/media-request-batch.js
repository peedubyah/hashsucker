#!/usr/bin/env node
/**
 * Media Request Batch Validation Harness
 *
 * Executes a batch of media requests from a JSON file and produces structured
 * output with per-request results and aggregate summary metrics.
 *
 * Usage:
 *   node src/scripts/media-request-batch.js <input.json> [--output results.json] [--db path] [--verbose]
 *
 * Input JSON format:
 *   {
 *     "requests": [
 *       { "mediaId": "tt0182576", "mediaType": "series", "season": 5, "episode": 12, "label": "optional" },
 *       { "mediaId": "tt0111161", "mediaType": "movie" }
 *     ],
 *     "options": { "limit": 50, "persist": false }
 *   }
 *
 * Output JSON format:
 *   {
 *     "summary": { "totalRequests": 2, "requestsWithResults": 2, ... },
 *     "results": [ { "request": {...}, "totalCandidates": 10, ... } ]
 *   }
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { searchByMedia } from '../api/media-request.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    dbPath: process.env.DISCOVERY_DB || ':memory:',
    verbose: false,
    pretty: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output' && argv[i + 1]) { args.output = argv[++i]; }
    else if (a === '--db' && argv[i + 1]) { args.dbPath = argv[++i]; }
    else if (a === '--verbose' || a === '-v') { args.verbose = true; }
    else if (a === '--pretty') { args.pretty = true; }
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else if (!a.startsWith('--')) { positional.push(a); }
  }

  if (positional.length >= 1) args.input = positional[0];

  return args;
}

function printUsage() {
  console.log(`
Media Request Batch Validation Harness

Usage:
  node src/scripts/media-request-batch.js <input.json> [options]

Arguments:
  input.json    Path to JSON file with requests array (required)

Options:
  --output PATH    Write results to JSON file
  --db PATH        Database path (default: :memory: or $DISCOVERY_DB)
  --verbose, -v    Print per-request details to stdout
  --pretty         Pretty-print JSON output
  --help, -h       Show this help

Input JSON format:
  {
    "requests": [
      { "mediaId": "tt0182576", "mediaType": "series", "season": 5, "episode": 12, "label": "optional" },
      { "mediaId": "tt0111161", "mediaType": "movie" }
    ],
    "options": { "limit": 50, "persist": false }
  }

Output JSON format:
  {
    "summary": {
      "totalRequests": 2,
      "requestsWithResults": 2,
      "requestsWithNoResults": 0,
      "averageCandidatesPerRequest": 5.5,
      "averageEligiblePerRequest": 3.2,
      "averageIneligiblePerRequest": 2.3,
      "tierDistribution": { "Verified": 5, "Ineligible": 3 },
      "eligibilityCodeDistribution": { "season_mismatch": 2, "episode_mismatch": 1 },
      "averageTopScore": 0.85,
      "requestsWithExactEpisodeMatch": 1,
      "requestsWithSeasonPack": 1
    },
    "results": [
      {
        "request": { "mediaId": "tt0182576", ... },
        "requestId": null,
        "totalCandidates": 10,
        "eligibleCount": 7,
        "ineligibleCount": 3,
        "topResult": { "infoHash": "...", "score": 0.95, "identity": {...} },
        "topTier": "Verified",
        "topConfidence": 0.95,
        "identitySummary": {...},
        "ranking": {...},
        "elapsedMs": 12
      }
    ]
  }
`);
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

function loadInput(filePath) {
  const resolved = resolve(filePath);
  let raw;
  try {
    raw = readFileSync(resolved, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read input file: ${resolved} (${err.message})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in input file: ${resolved} (${err.message})`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Input must be a JSON object');
  }

  if (!Array.isArray(parsed.requests)) {
    throw new Error('Input must have a "requests" array');
  }

  // Validate each request
  for (let i = 0; i < parsed.requests.length; i++) {
    const req = parsed.requests[i];
    if (!req || typeof req !== 'object') {
      throw new Error(`Request at index ${i} must be an object`);
    }
    if (!req.mediaId) {
      throw new Error(`Request at index ${i} missing required "mediaId"`);
    }
    if (req.mediaType && !['movie', 'series'].includes(req.mediaType)) {
      throw new Error(`Request at index ${i} has invalid "mediaType" (must be "movie" or "series")`);
    }
  }

  return {
    requests: parsed.requests,
    options: parsed.options || {},
  };
}

// ---------------------------------------------------------------------------
// Batch execution
// ---------------------------------------------------------------------------

function executeBatch(cache, requests, options = {}) {
  const results = [];
  const startedAt = Date.now();

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const reqStartedAt = Date.now();

    const searchOptions = {
      mediaId: request.mediaId,
      mediaType: request.mediaType || 'mediaType' in request ? request.mediaType : 'movie',
      season: request.season ?? null,
      episode: request.episode ?? null,
      limit: request.limit || options.limit || 50,
      offset: request.offset || options.offset || 0,
      persist: request.persist !== undefined ? request.persist : (options.persist !== undefined ? options.persist : true),
    };

    let result;
    let error = null;
    try {
      result = await searchByMedia(cache, searchOptions);
    } catch (err) {
      error = err.message;
    }

    const elapsedMs = Date.now() - reqStartedAt;

    const entry = {
      index: i,
      request: {
        mediaId: request.mediaId,
        mediaType: searchOptions.mediaType,
        season: searchOptions.season,
        episode: searchOptions.episode,
        label: request.label || null,
      },
      elapsedMs,
    };

    if (error) {
      entry.error = error;
      entry.totalCandidates = 0;
      entry.eligibleCount = 0;
      entry.ineligibleCount = 0;
      entry.topResult = null;
      entry.topTier = null;
      entry.topConfidence = null;
      entry.identitySummary = null;
      entry.ranking = null;
    } else {
      entry.requestId = result.requestId;
      entry.totalCandidates = result.total;
      entry.eligibleCount = result.identitySummary?.eligibleCount ?? result.total;
      entry.ineligibleCount = result.identitySummary?.ineligibleCount ?? 0;
      entry.topResult = result.results?.[0] || null;
      entry.topTier = result.results?.[0]?.identity?.tier || null;
      entry.topConfidence = result.results?.[0]?.identity?.confidence ?? null;
      entry.identitySummary = result.identitySummary;
      entry.ranking = result.ranking;
    }

    results.push(entry);
  }

  const totalElapsedMs = Date.now() - startedAt;

  return {
    results,
    totalElapsedMs,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Summary metrics
// ---------------------------------------------------------------------------

function computeSummary(results) {
  const totalRequests = results.length;
  const requestsWithResults = results.filter(r => r.totalCandidates > 0).length;
  const requestsWithNoResults = totalRequests - requestsWithResults;
  const requestsWithErrors = results.filter(r => r.error).length;

  const totalCandidates = results.reduce((sum, r) => sum + r.totalCandidates, 0);
  const totalEligible = results.reduce((sum, r) => sum + r.eligibleCount, 0);
  const totalIneligible = results.reduce((sum, r) => sum + r.ineligibleCount, 0);

  const averageCandidatesPerRequest = totalRequests > 0 ? totalCandidates / totalRequests : 0;
  const averageEligiblePerRequest = totalRequests > 0 ? totalEligible / totalRequests : 0;
  const averageIneligiblePerRequest = totalRequests > 0 ? totalIneligible / totalRequests : 0;

  // Tier distribution across all top results
  const tierDistribution = {};
  for (const r of results) {
    if (r.topTier) {
      tierDistribution[r.topTier] = (tierDistribution[r.topTier] || 0) + 1;
    }
  }

  // Eligibility code distribution
  const eligibilityCodeDistribution = {};
  for (const r of results) {
    const codes = r.identitySummary?.ineligibleByCode || {};
    for (const [code, count] of Object.entries(codes)) {
      eligibilityCodeDistribution[code] = (eligibilityCodeDistribution[code] || 0) + count;
    }
  }

  // Average top score
  const topScores = results.filter(r => r.topResult?.score != null).map(r => r.topResult.score);
  const averageTopScore = topScores.length > 0 ? topScores.reduce((a, b) => a + b, 0) / topScores.length : 0;

  // Requests with exact episode match
  const requestsWithExactEpisodeMatch = results.filter(r =>
    r.identitySummary?.exactEpisodeMatches > 0
  ).length;

  // Requests with season pack
  const requestsWithSeasonPack = results.filter(r =>
    r.identitySummary?.seasonPackMatches > 0
  ).length;

  // Average elapsed time
  const totalElapsed = results.reduce((sum, r) => sum + r.elapsedMs, 0);
  const averageElapsedMs = totalRequests > 0 ? totalElapsed / totalRequests : 0;

  return {
    totalRequests,
    requestsWithResults,
    requestsWithNoResults,
    requestsWithErrors,
    totalCandidates,
    totalEligible,
    totalIneligible,
    averageCandidatesPerRequest: round(averageCandidatesPerRequest),
    averageEligiblePerRequest: round(averageEligiblePerRequest),
    averageIneligiblePerRequest: round(averageIneligiblePerRequest),
    tierDistribution,
    eligibilityCodeDistribution,
    averageTopScore: round(averageTopScore),
    requestsWithExactEpisodeMatch,
    requestsWithSeasonPack,
    averageElapsedMs: round(averageElapsedMs),
  };
}

function round(n, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.error('Error: input file is required');
    printUsage();
    process.exit(1);
  }

  // Load input
  let input;
  try {
    input = loadInput(args.input);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (input.requests.length === 0) {
    console.error('Error: no requests in input file');
    process.exit(1);
  }

  // Open cache
  const cache = createDiscoveryCache(args.dbPath !== ':memory:' ? { dbPath: args.dbPath } : {});

  try {
    // Execute batch
    const { results, totalElapsedMs, timestamp } = executeBatch(cache, input.requests, input.options);

    // Compute summary
    const summary = computeSummary(results);

    // Build output
    const output = {
      summary: {
        ...summary,
        totalElapsedMs,
      },
      config: {
        inputFile: resolve(args.input),
        dbPath: args.dbPath,
        requestCount: input.requests.length,
        options: input.options,
      },
      timestamp,
      results,
    };

    // Write or print output
    const jsonOutput = args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);

    if (args.output) {
      writeFileSync(resolve(args.output), jsonOutput, 'utf-8');
      if (args.verbose) {
        console.log(`Results written to ${resolve(args.output)}`);
      }
    }

    if (args.verbose || !args.output) {
      // Print summary to stdout
      console.log(`\n=== Media Request Batch Results ===`);
      console.log(`Timestamp: ${timestamp}`);
      console.log(`Requests: ${summary.totalRequests}`);
      console.log(`With results: ${summary.requestsWithResults}`);
      console.log(`With no results: ${summary.requestsWithNoResults}`);
      console.log(`With errors: ${summary.requestsWithErrors}`);
      console.log(`Total candidates: ${summary.totalCandidates}`);
      console.log(`Average candidates/request: ${summary.averageCandidatesPerRequest}`);
      console.log(`Average eligible/request: ${summary.averageEligiblePerRequest}`);
      console.log(`Average ineligible/request: ${summary.averageIneligiblePerRequest}`);
      console.log(`Average top score: ${summary.averageTopScore}`);
      console.log(`Requests with exact episode match: ${summary.requestsWithExactEpisodeMatch}`);
      console.log(`Requests with season pack: ${summary.requestsWithSeasonPack}`);
      console.log(`Average elapsed: ${summary.averageElapsedMs}ms`);
      console.log(`Total elapsed: ${totalElapsedMs}ms`);

      if (Object.keys(summary.tierDistribution).length > 0) {
        console.log(`\nTop-tier distribution:`);
        for (const [tier, count] of Object.entries(summary.tierDistribution).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${tier}: ${count}`);
        }
      }

      if (Object.keys(summary.eligibilityCodeDistribution).length > 0) {
        console.log(`\nIneligibility codes:`);
        for (const [code, count] of Object.entries(summary.eligibilityCodeDistribution).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${code}: ${count}`);
        }
      }

      console.log(`\n--- Per-request details ---`);
      for (const r of results) {
        const label = r.request.label ? ` (${r.request.label})` : '';
        const scope = r.request.season != null
          ? ` S${String(r.request.season).padStart(2, '0')}${r.request.episode != null ? `E${String(r.request.episode).padStart(2, '0')}` : ''}`
          : '';
        if (r.error) {
          console.log(`  [${r.index}] ${r.request.mediaId}${label}${scope}: ERROR - ${r.error}`);
        } else {
          const topInfo = r.topResult
            ? `top=${r.topTier} score=${r.topResult.score?.toFixed(3)} conf=${r.topConfidence?.toFixed(2)}`
            : 'no results';
          console.log(`  [${r.index}] ${r.request.mediaId}${label}${scope}: ${r.totalCandidates} candidates (${r.eligibleCount} eligible, ${r.ineligibleCount} ineligible) ${topInfo} ${r.elapsedMs}ms`);
        }
      }

      if (args.output) {
        console.log(`\nFull results written to ${resolve(args.output)}`);
      }
    }

    // Exit with error code if any requests failed
    if (summary.requestsWithErrors > 0) {
      process.exit(2);
    }
  } finally {
    cache.close();
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
