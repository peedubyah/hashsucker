#!/usr/bin/env node
/**
 * Enrichment Pipeline CLI
 *
 * Commands:
 *   npm run enrichment -- seed [--limit N] [--offset N]
 *   npm run enrichment -- process [--limit N]
 *   npm run enrichment -- status
 *
 * Populates the identity enrichment queue from unresolved candidates,
 * then processes them through the CinemetaIdentityResolver.
 */

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { runIdentityEnrichmentWorker } from '../lib/discovery/identity-enrichment-worker.js';
import { CinemetaIdentityResolver } from '../lib/discovery/cinemeta-identity-resolver.js';
import { getEnrichmentDiagnostics, formatEnrichmentDiagnostics } from '../lib/discovery/enrichment-diagnostics.js';

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';
const command = process.argv[2];

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      result.limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--offset' && args[i + 1]) {
      result.offset = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--max-attempts' && args[i + 1]) {
      result.maxAttempts = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return result;
}

async function cmdSeed(args) {
  const { limit = 1000, offset = 0, maxAttempts = 3 } = parseArgs(args);
  const cache = createDiscoveryCache({ dbPath: DB_PATH });

  const before = {
    unresolved: cache.countUnresolvedCandidates(),
    queue: cache.getEnrichmentStats(),
  };

  console.log('Seeding enrichment queue...');
  console.log(`  Limit: ${limit}, Offset: ${offset}, Max attempts: ${maxAttempts}`);
  console.log(`  Unresolved candidates before: ${before.unresolved}`);
  console.log(`  Queue size before: ${before.queue.total}`);
  console.log('');

  const result = cache.enqueueUnresolvedCandidates({ limit, offset, maxAttempts });

  const after = {
    unresolved: cache.countUnresolvedCandidates(),
    queue: cache.getEnrichmentStats(),
  };

  console.log('Seed results:');
  console.log(`  Enqueued: ${result.enqueued}`);
  console.log(`  Skipped (already in queue): ${result.skipped}`);
  console.log(`  Total processed: ${result.total}`);
  console.log('');
  console.log('State after seeding:');
  console.log(`  Unresolved candidates: ${after.unresolved}`);
  console.log(`  Queue size: ${after.queue.total}`);
  console.log(`    Pending: ${after.queue.pending}`);
  console.log(`    Processing: ${after.queue.processing}`);
  console.log(`    Resolved: ${after.queue.resolved}`);
  console.log(`    Failed: ${after.queue.failed}`);

  cache.close();
}

async function cmdProcess(args) {
  const { limit = 100 } = parseArgs(args);
  const cache = createDiscoveryCache({ dbPath: DB_PATH });
  const resolver = new CinemetaIdentityResolver();

  const before = {
    queue: cache.getEnrichmentStats(),
    coverage: cache.getCandidateMediaCoverage(),
  };

  console.log('Processing enrichment queue...');
  console.log(`  Limit: ${limit}`);
  console.log(`  Resolver: ${resolver.sourceName} v${resolver.version}`);
  console.log(`  Queue size before: ${before.queue.total}`);
  console.log(`  Coverage before: ${(before.coverage.coveragePercentage * 100).toFixed(1)}%`);
  console.log('');

  const stats = await runIdentityEnrichmentWorker(cache, { resolver, limit });

  const after = {
    queue: cache.getEnrichmentStats(),
    coverage: cache.getCandidateMediaCoverage(),
  };

  console.log('Processing results:');
  console.log(`  Total items: ${stats.total}`);
  console.log(`  Processed: ${stats.processed}`);
  console.log(`  Resolved: ${stats.resolved}`);
  console.log(`  Failed: ${stats.failed}`);
  console.log(`  Skipped: ${stats.skipped}`);
  if (stats.errors.length > 0) {
    console.log(`  Errors: ${stats.errors.length}`);
    for (const err of stats.errors.slice(0, 5)) {
      console.log(`    - ${err.error} (${err.infoHash})`);
    }
  }
  console.log('');
  console.log('State after processing:');
  console.log(`  Queue size: ${after.queue.total}`);
  console.log(`    Pending: ${after.queue.pending}`);
  console.log(`    Processing: ${after.queue.processing}`);
  console.log(`    Resolved: ${after.queue.resolved}`);
  console.log(`    Failed: ${after.queue.failed}`);
  console.log(`  Coverage: ${(after.coverage.coveragePercentage * 100).toFixed(1)}%`);
  console.log(`  Candidates with resolved media: ${after.coverage.candidatesWithResolvedMedia}`);

  cache.close();
}

async function cmdStatus() {
  const cache = createDiscoveryCache({ dbPath: DB_PATH });

  const diagnostics = getEnrichmentDiagnostics(cache);

  console.log(formatEnrichmentDiagnostics(diagnostics));

  cache.close();
}

// Main
async function main() {
  const args = process.argv.slice(3);

  switch (command) {
    case 'seed':
      await cmdSeed(args);
      break;
    case 'process':
      await cmdProcess(args);
      break;
    case 'status':
      await cmdStatus(args);
      break;
    default:
      console.error('Usage: npm run enrichment -- <seed|process|status> [options]');
      console.error('');
      console.error('Commands:');
      console.error('  seed [--limit N] [--offset N] [--max-attempts N]');
      console.error('    Enqueue unresolved candidates for enrichment');
      console.error('  process [--limit N]');
      console.error('    Process pending items through Cinemeta resolver');
      console.error('  status');
      console.error('    Show enrichment diagnostics');
      console.error('');
      console.error('Options:');
      console.error('  --limit N       Max items to process (default: 1000 for seed, 100 for process)');
      console.error('  --offset N      Offset for pagination (seed only)');
      console.error('  --max-attempts N  Max retry attempts (seed only, default: 3)');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
