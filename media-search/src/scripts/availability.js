#!/usr/bin/env node
/**
 * Availability Checker CLI
 *
 * Debug/operator tool for checking provider availability of media-request candidates.
 *
 * Usage:
 *   npm run availability -- check --request-id 123
 *   npm run availability -- status
 *   npm run availability -- check --hashes 'hash1,hash2,hash3'
 */

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { AvailabilityChecker, createAvailabilityChecker } from '../lib/intents/availability.js';

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    command: null,
    requestId: null,
    hashes: null,
    dbPath: DB_PATH,
    verbose: false,
    force: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--request-id' && argv[i + 1]) { args.requestId = argv[++i]; }
    else if (a === '--hashes' && argv[i + 1]) { args.hashes = argv[++i]; }
    else if (a === '--db' && argv[i + 1]) { args.dbPath = argv[++i]; }
    else if (a === '--verbose' || a === '-v') { args.verbose = true; }
    else if (a === '--force' || a === '-f') { args.force = true; }
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else if (!a.startsWith('--')) { positional.push(a); }
  }

  if (positional.length >= 1) {
    args.command = positional[0];
  }

  return args;
}

function printUsage() {
  console.log(`
Availability Checker CLI

Usage:
  npm run availability -- <command> [options]

Commands:
  check                 Check availability for candidates
  status                Show availability status for hashes

Options:
  --request-id <id>     Media request ID to check
  --hashes <list>       Comma-separated list of info hashes
  --force, -f           Force recheck (ignore freshness)
  --db <path>           Database path (default: :memory: or $DISCOVERY_DB)
  --verbose, -v         Print detailed output
  --help, -h            Show this help

Examples:
  npm run availability -- check --request-id 123
  npm run availability -- check --hashes 'abc123,def456'
  npm run availability -- status --hashes 'abc123,def456'
`);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdCheck(cache, args) {
  const checker = createAvailabilityChecker(cache);

  let hashes = [];

  if (args.requestId) {
    // Get hashes from media request results
    const results = cache.getMediaRequestResults(parseInt(args.requestId, 10));
    hashes = results.map(r => r.info_hash);
    console.log(`Checking availability for request ${args.requestId} (${hashes.length} candidates)...`);
  } else if (args.hashes) {
    hashes = args.hashes.split(',').map(h => h.trim().toLowerCase());
    console.log(`Checking availability for ${hashes.length} hashes...`);
  } else {
    console.error('Error: --request-id or --hashes is required');
    printUsage();
    process.exit(1);
  }

  if (hashes.length === 0) {
    console.log('No hashes to check.');
    return;
  }

  const result = await checker.checkAvailability(hashes, { force: args.force });

  console.log(`\nChecked ${result.results.length} hashes in ${result.elapsedMs}ms (${result.batches} batches)`);

  // Group by state
  const byState = {};
  for (const r of result.results) {
    byState[r.state] = (byState[r.state] || 0) + 1;
  }

  console.log('\nResults:');
  for (const [state, count] of Object.entries(byState)) {
    console.log(`  ${state}: ${count}`);
  }

  if (args.verbose) {
    console.log('\nDetails:');
    for (const r of result.results) {
      const metadata = r.fileMetadata ? ` (${r.fileMetadata.name || 'unknown'})` : '';
      console.log(`  ${r.infoHash}: ${r.state}${metadata}`);
    }
  }
}

async function cmdStatus(cache, args) {
  const checker = createAvailabilityChecker(cache);

  let hashes = [];

  if (args.hashes) {
    hashes = args.hashes.split(',').map(h => h.trim().toLowerCase());
  } else {
    console.error('Error: --hashes is required for status command');
    printUsage();
    process.exit(1);
  }

  console.log(`Availability status for ${hashes.length} hashes:`);

  const availability = checker.getAvailabilityBatch(hashes);

  for (const [hash, info] of Object.entries(availability)) {
    if (info) {
      const age = info.ageMs ? `${Math.round(info.ageMs / 1000)}s ago` : 'unknown';
      console.log(`  ${hash}: ${info.state} (${age})`);
    } else {
      console.log(`  ${hash}: no observation`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) {
    console.error('Error: command is required');
    printUsage();
    process.exit(1);
  }

  // Open cache
  const cache = createDiscoveryCache(args.dbPath !== ':memory:' ? { dbPath: args.dbPath } : {});

  try {
    switch (args.command) {
      case 'check':
        await cmdCheck(cache, args);
        break;
      case 'status':
        await cmdStatus(cache, args);
        break;
      default:
        console.error(`Error: unknown command "${args.command}"`);
        printUsage();
        process.exit(1);
    }
  } finally {
    cache.close();
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
