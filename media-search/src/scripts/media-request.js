#!/usr/bin/env node
/**
 * Media Request CLI
 *
 * Executes a media search request and displays ranked results.
 *
 * Usage:
 *   npm run media-request -- <mediaId> <mediaType> [--season N] [--episode N] [--limit N] [--no-persist]
 *
 * Examples:
 *   npm run media-request -- tt0182576 series --season 5 --episode 12
 *   npm run media-request -- tt0111161 movie
 */

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { searchByMedia } from '../api/media-request.js';

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';

function parseArgs(argv) {
  const args = {
    mediaId: null,
    mediaType: 'movie',
    season: null,
    episode: null,
    limit: 50,
    offset: 0,
    persist: true,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--season' && argv[i + 1]) { args.season = parseInt(argv[++i], 10); }
    else if (a === '--episode' && argv[i + 1]) { args.episode = parseInt(argv[++i], 10); }
    else if (a === '--limit' && argv[i + 1]) { args.limit = parseInt(argv[++i], 10); }
    else if (a === '--offset' && argv[i + 1]) { args.offset = parseInt(argv[++i], 10); }
    else if (a === '--no-persist') { args.persist = false; }
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else if (!a.startsWith('--')) { positional.push(a); }
  }

  if (positional.length >= 1) args.mediaId = positional[0];
  if (positional.length >= 2) args.mediaType = positional[1];

  return args;
}

function printUsage() {
  console.log(`
Media Request CLI

Usage:
  npm run media-request -- <mediaId> <mediaType> [options]

Arguments:
  mediaId       Media ID (IMDB, TMDB, etc.) — required
  mediaType     'movie' or 'series' — default: movie

Options:
  --season N    Season number (series only)
  --episode N   Episode number (series only)
  --limit N     Max results — default: 50
  --offset N    Pagination offset — default: 0
  --no-persist  Skip database persistence
  --help, -h    Show this help

Examples:
  npm run media-request -- tt0182576 series --season 5 --episode 12
  npm run media-request -- tt0111161 movie
`);
}

function formatScore(score) {
  if (score === null || score === undefined) return '-';
  return score.toFixed(3);
}

function truncate(str, max = 50) {
  if (!str) return '-';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.mediaId) {
    console.error('Error: mediaId is required');
    printUsage();
    process.exit(1);
  }

  const cache = createDiscoveryCache(DB_PATH !== ':memory:' ? { dbPath: DB_PATH } : {});

  try {
    const startedAt = Date.now();

    const result = await searchByMedia(cache, {
      mediaId: args.mediaId,
      mediaType: args.mediaType,
      season: args.season,
      episode: args.episode,
      limit: args.limit,
      offset: args.offset,
      persist: args.persist,
    });

    const duration = Date.now() - startedAt;

    console.log('\n=== Media Request ===');
    console.log(`Query: ${result.query.mediaType} ${result.query.mediaId}` +
      (result.query.season ? ` S${result.query.season}E${result.query.episode}` : ''));
    console.log(`Candidates: ${result.total}`);
    console.log(`Duration: ${duration}ms`);
    if (result.requestId) {
      console.log(`Persisted: request #${result.requestId}`);
    }

    if (result.total === 0) {
      console.log('\nNo matching candidates found.');
      console.log('\nPossible reasons:');
      console.log('  - No candidate_media association for this mediaId');
      console.log('  - Identity enrichment not yet run for matching candidates');
      return;
    }

    console.log('\n=== Identity Summary ===');
    const summary = result.identitySummary;
    console.log(`Top tier: ${summary.tier}`);
    console.log(`Confidence: ${summary.confidence}`);
    console.log(`Evidence: ${summary.evidence.join(', ') || '-'}`);
    console.log(`Resolution states:`);
    for (const [state, count] of Object.entries(summary.resolutionStates || {})) {
      console.log(`  ${state}: ${count}`);
    }

    console.log('\n=== Results ===');
    console.log(`Rank  Score    Tier       State       Filename`);
    console.log(`────  ────────  ─────────  ──────────  ──────────────────────────────────────`);

    for (const r of result.results) {
      const rank = String(r.rank).padStart(4);
      const score = formatScore(r.score).padEnd(8);
      const tier = (r.identity?.tier || '-').padEnd(9);
      const state = (r.identity?.state || '-').padEnd(11);
      const filename = truncate(r.filename, 50);
      console.log(`${rank}  ${score}  ${tier}  ${state}  ${filename}`);
    }

    // Detailed view for top 3
    const topN = result.results.slice(0, 3);
    if (topN.length > 0) {
      console.log('\n=== Top Results (Detailed) ===');
      for (const r of topN) {
        console.log(`\n[Rank ${r.rank}] ${r.filename}`);
        console.log(`  InfoHash: ${r.infoHash}`);
        console.log(`  Score: ${formatScore(r.score)}`);
        console.log(`  Identity: tier=${r.identity?.tier}, state=${r.identity?.state}, confidence=${r.identity?.confidence}`);
        if (r.identity?.evidence?.length) {
          console.log(`  Evidence: ${r.identity.evidence.join(', ')}`);
        }
        if (r.identity?.matchMethod) {
          console.log(`  Match method: ${r.identity.matchMethod}`);
        }
        if (r.scoreBreakdown && Object.keys(r.scoreBreakdown).length > 0) {
          console.log(`  Score breakdown:`);
          for (const [k, v] of Object.entries(r.scoreBreakdown)) {
            console.log(`    ${k}: ${v}`);
          }
        }
        if (r.release && Object.keys(r.release).length > 0) {
          console.log(`  Release: title=${r.release.title}, year=${r.release.year}, ` +
            `resolution=${r.release.resolution}, source=${r.release.source}, codec=${r.release.codec}`);
        }
        if (r.observations?.length > 0) {
          console.log(`  Observations:`);
          for (const o of r.observations) {
            console.log(`    ${o.provider}: ${o.state}${o.cached ? ' (cached)' : ''}`);
          }
        }
      }
    }

    // Ranking tier distribution
    if (result.ranking?.TierCounts) {
      console.log('\n=== Ranking Tier Distribution ===');
      for (const [tier, count] of Object.entries(result.ranking.TierCounts)) {
        if (count > 0) {
          console.log(`  ${tier}: ${count}`);
        }
      }
    }

    console.log('');

  } catch (err) {
    console.error(`\nError: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  } finally {
    cache.close();
  }
}

main();
