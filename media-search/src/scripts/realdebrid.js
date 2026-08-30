#!/usr/bin/env node
/**
 * Real-Debrid Operator CLI
 *
 * Diagnostic/operator tool for Real-Debrid account validation and single-hash probing.
 *
 * Usage:
 *   npm run realdebrid -- validate
 *   npm run realdebrid -- probe --hash <infoHash>
 *
 * Environment:
 *   REAL_DEBRID_API_TOKEN - Real-Debrid API token (required)
 *
 * The probe mode:
 *   1. Adds the supplied magnet
 *   2. Waits for RD to expose torrent/file metadata
 *   3. Prints status and available file metadata
 *   4. Does NOT select/download files
 *   5. Deletes the temporary RD torrent before exit
 */

import { createRealDebridClient } from '../lib/providers/realdebrid/client.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { probeAndPersist } from '../lib/providers/realdebrid/observe.js';

const API_KEY = process.env.REALDEBRID_API_KEY;
const DB_PATH = process.env.DISCOVERY_DB || './discovery-cache.db';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    command: null,
    hash: null,
    verbose: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hash' && argv[i + 1]) { args.hash = argv[++i]; }
    else if (a === '--verbose' || a === '-v') { args.verbose = true; }
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
Real-Debrid Operator CLI

Usage:
  npm run realdebrid -- <command> [options]

Commands:
  validate              Validate RD account via GET /user
  probe                 Add magnet, inspect files, delete (single hash probe)

Options:
  --hash <infoHash>     Info hash for probe mode
  --verbose, -v         Print detailed output
  --help, -h            Show this help

Environment:
  REALDEBRID_API_KEY    Required for all commands

Examples:
  REALDEBRID_API_KEY=xxx npm run realdebrid -- validate
  REALDEBRID_API_KEY=xxx npm run realdebrid -- probe --hash abc123...
`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdValidate(client) {
  console.log('Validating Real-Debrid account...');

  const account = await client.validateAccount();

  console.log('\n✓ Account validated');
  console.log(`  ID: ${account.id}`);
  console.log(`  Username: ${account.username}`);
  console.log(`  Email: ${account.email}`);
  console.log(`  Type: ${account.type}`);
  console.log(`  Points: ${account.points}`);
  console.log(`  Expiration: ${account.expiration}`);
  if (account.premium) {
    console.log(`  Premium: ${account.premium}`);
  }

  return account;
}

async function cmdProbe(client, args) {
  if (!args.hash) {
    console.error('Error: --hash is required for probe mode');
    printUsage();
    process.exit(1);
  }

  const infoHash = args.hash.toLowerCase().trim();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    console.error(`Error: invalid infoHash: ${infoHash}`);
    process.exit(1);
  }

  console.log(`Probing Real-Debrid for hash: ${infoHash}`);

  // Open cache for observation persistence
  const cache = createDiscoveryCache({ dbPath: DB_PATH });

  try {
    const { observation, classification, rdStatus, rdErrorCode, latencyMs } = await probeAndPersist(client, cache, {
      infoHash,
    });

    console.log(`\n✓ Probe complete`);
    console.log(`  Classification: ${classification}`);
    console.log(`  RD Status: ${rdStatus || 'N/A'}`);
    if (rdErrorCode) {
      console.log(`  RD Error Code: ${rdErrorCode}`);
    }
    console.log(`  Latency: ${latencyMs}ms`);
    console.log(`  Observation persisted to provider_observation_current + provider_observation_events`);

    return { observation, classification };
  } finally {
    cache.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) {
    printUsage();
    process.exit(1);
  }

  if (!API_KEY) {
    console.error('Error: REALDEBRID_API_KEY is not configured');
    console.error('');
    console.error('Set the environment variable:');
    console.error('  export REALDEBRID_API_KEY=your_key_here');
    console.error('');
    console.error('Or in docker compose .env file:');
    console.error('  REALDEBRID_API_KEY=your_key_here');
    process.exit(1);
  }

  const client = createRealDebridClient({ apiKey: API_KEY });

  try {
    switch (args.command) {
      case 'validate':
        await cmdValidate(client);
        break;
      case 'probe':
        await cmdProbe(client, args);
        break;
      default:
        console.error(`Unknown command: ${args.command}`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error(`\n✗ Error: ${error.message}`);
    if (error.rdErrorCode != null) {
      console.error(`  RD error code: ${error.rdErrorCode}`);
    }
    if (error.category) {
      console.error(`  Category: ${error.category}`);
    }
    if (error.provider) {
      console.error(`  Provider: ${error.provider}`);
    }
    if (error.operation) {
      console.error(`  Operation: ${error.operation}`);
    }
    process.exit(1);
  }
}

main();
