#!/usr/bin/env node
/**
 * Cache Probe Worker
 *
 * Bounded background-style worker that consumes multiple cache probe batches
 * while staying within TorBox rate limits.
 *
 * Usage:
 *   npm run cache:probe -- --db <path> --max-batches 5
 *   npm run cache:probe -- --db <path> --batch-size 10 --max-batches 3
 *
 * Environment variables:
 *   CACHE_PROBE_BATCH_SIZE         Hashes per batch (default: 10)
 *   CACHE_PROBE_REQUESTS_PER_MINUTE  Max TorBox HTTP requests/minute (default: 20)
 *
 * Reuses:
 *   - claimProbeBatch() from cache.js
 *   - AvailabilityChecker / checkTorBoxCached from intents/availability.js
 *   - appendProviderObservation (via AvailabilityChecker._recordObservation)
 *   - completeProbe() / failProbe() from cache.js
 */

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createAvailabilityChecker } from '../lib/intents/availability.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DISCOVERY_DB || './discovery-cache.db';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = parseInt(process.env.CACHE_PROBE_BATCH_SIZE || '10', 10);
const DEFAULT_REQUESTS_PER_MINUTE = parseInt(process.env.CACHE_PROBE_REQUESTS_PER_MINUTE || '20', 10);
const DEFAULT_MAX_BATCHES = 5; // Conservative default - operator must explicitly request more

// ---------------------------------------------------------------------------
// Environment loading (minimal - follow existing convention)
// ---------------------------------------------------------------------------

function loadEnv() {
  // Check if already loaded
  if (process.env.TORBOX_API_KEY) return;

  // Try to load from .env files (same locations as docker compose would mount)
  const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(process.cwd(), '..', '..', '.env'),
  ];

  for (const envPath of envPaths) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        // Don't override existing env vars
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      break; // Found and loaded
    } catch {
      // Try next path
    }
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dbPath: DB_PATH,
    batchSize: DEFAULT_BATCH_SIZE,
    maxBatches: DEFAULT_MAX_BATCHES,
    requestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db' && argv[i + 1]) { args.dbPath = argv[++i]; }
    else if (a === '--batch-size' && argv[i + 1]) { args.batchSize = parseInt(argv[++i], 10); }
    else if (a === '--max-batches' && argv[i + 1]) { args.maxBatches = parseInt(argv[++i], 10); }
    else if (a === '--requests-per-minute' && argv[i + 1]) { args.requestsPerMinute = parseInt(argv[++i], 10); }
    else if (a === '--verbose' || a === '-v') { args.verbose = true; }
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
  }

  return args;
}

function printUsage() {
  console.log(`
Cache Probe Worker — bounded multi-batch TorBox availability checker

Usage:
  npm run cache:probe -- [options]

Options:
  --db <path>              Discovery cache database path (default: ./discovery-cache.db or $DISCOVERY_DB)
  --batch-size N           Hashes per batch (default: 10 or $CACHE_PROBE_BATCH_SIZE)
  --max-batches N          Max batches to process (default: 5, bounded execution)
  --requests-per-minute N  Max TorBox HTTP requests/minute (default: 20 or $CACHE_PROBE_REQUESTS_PER_MINUTE)
  --verbose, -v            Show detailed per-hash output
  --help, -h               Show this help

Environment:
  CACHE_PROBE_BATCH_SIZE         Hashes per batch (default: 10)
  CACHE_PROBE_REQUESTS_PER_MINUTE  Max TorBox HTTP requests/minute (default: 20)

Examples:
  npm run cache:probe -- --db ./artifacts/stage3/dmm-stage3-ranking.db --max-batches 5
  npm run cache:probe -- --db ./artifacts/stage3/dmm-stage3-ranking.db --batch-size 10 --max-batches 3
`);
}

// ---------------------------------------------------------------------------
// Rate limiter for inter-batch pacing
// ---------------------------------------------------------------------------

class InterBatchRateLimiter {
  constructor(requestsPerMinute) {
    this.requestsPerMinute = requestsPerMinute;
    this.timestamps = [];
  }

  async pace(requestsMade = 1) {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove timestamps older than 1 minute
    this.timestamps = this.timestamps.filter(t => t > oneMinuteAgo);

    // Add current request timestamps
    for (let i = 0; i < requestsMade; i++) {
      this.timestamps.push(now);
    }

    // If we're at the limit, wait until the oldest request expires
    if (this.timestamps.length >= this.requestsPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = oldest - oneMinuteAgo + 100; // 100ms buffer
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  console.log('Cache Probe Worker');
  console.log(`  Database: ${args.dbPath}`);
  console.log(`  Batch size: ${args.batchSize}`);
  console.log(`  Max batches: ${args.maxBatches}`);
  console.log(`  Requests/minute: ${args.requestsPerMinute}`);
  console.log('');

  // Provider credential preflight
  if (!process.env.TORBOX_API_KEY) {
    console.error('ERROR: TORBOX_API_KEY is not available in environment or .env file');
    console.error('The provider credential must be refreshed before probing can proceed.');
    process.exit(1);
  }
  console.log('  TorBox credential: available');
  console.log('');

  // Open cache
  const cache = createDiscoveryCache({ dbPath: args.dbPath });

  try {
    // Get queue state before
    const statsBefore = cache.getCacheProbeStats();
    console.log('Queue state before:');
    console.log(`  Total: ${statsBefore.total}, Pending: ${statsBefore.pending}, Checking: ${statsBefore.checking}`);
    console.log('');

    // Count observations before
    const db = new DatabaseSync(args.dbPath, { readOnly: true });
    let obsCountBefore = 0;
    try {
      const row = db.prepare("SELECT COUNT(*) as c FROM provider_observation_events WHERE provider = 'torbox'").get();
      obsCountBefore = row.c;
    } finally {
      db.close();
    }

    // Create availability checker (uses existing TorBox implementation)
    const checker = createAvailabilityChecker(cache, {
      batchSize: args.batchSize,
      maxRequestsPerMinute: args.requestsPerMinute,
      freshnessTtlMs: 0, // Force recheck - we want fresh observations
    });

    // Inter-batch rate limiter (AvailabilityChecker only limits within a single checkAvailability call)
    const rateLimiter = new InterBatchRateLimiter(args.requestsPerMinute);

    let totalClaimed = 0;
    let totalChecked = 0;
    let totalCached = 0;
    let totalUncached = 0;
    let totalFailed = 0;
    let totalCompleted = 0;
    let totalHttpRequests = 0;
    let batchesProcessed = 0;

    // Process bounded batches
    for (let batchNum = 0; batchNum < args.maxBatches; batchNum++) {
      // Check if there's pending work
      const pendingStats = cache.getCacheProbeStats();
      if (pendingStats.pending === 0) {
        console.log(`Batch ${batchNum + 1}: No pending probes available - stopping`);
        break;
      }

      // Claim a batch from the queue
      const claimed = cache.claimProbeBatch(args.batchSize);
      if (claimed.length === 0) {
        console.log(`Batch ${batchNum + 1}: No pending probes available - stopping`);
        break;
      }

      totalClaimed += claimed.length;
      const hashes = claimed.map(p => p.infoHash);

      console.log(`Batch ${batchNum + 1}: Claimed ${claimed.length} probes`);
      if (args.verbose) {
        for (const p of claimed) {
          console.log(`  - ${p.infoHash} (priority=${p.priority}, reason=${p.reason})`);
        }
      }

      // Pace between batches to respect rate limit
      await rateLimiter.pace(1);

      // Check availability using existing TorBox implementation
      const result = await checker.checkAvailability(hashes, { force: true });
      batchesProcessed++;
      totalHttpRequests += result.batches;
      totalChecked += result.results.length;

      // Process results
      for (const r of result.results) {
        const probeEntry = claimed.find(p => p.infoHash === r.infoHash);
        if (!probeEntry) continue;

        if (r.state === 'cached') {
          totalCached++;
          cache.completeProbe(probeEntry.id);
          totalCompleted++;
        } else if (r.state === 'uncached') {
          totalUncached++;
          cache.completeProbe(probeEntry.id);
          totalCompleted++;
        } else {
          // unknown / error
          totalFailed++;
          cache.failProbe(probeEntry.id);
        }
      }

      console.log(`  Results: ${result.results.length} checked in ${result.batches} API requests (${result.elapsedMs}ms)`);
    }

    console.log('');
    console.log('========================================');
    console.log('SUMMARY');
    console.log('========================================');
    console.log(`  Batches processed: ${batchesProcessed}`);
    console.log(`  Queue entries pending before: ${statsBefore.pending}`);
    console.log(`  Queue entries claimed: ${totalClaimed}`);
    console.log(`  Real hashes sent to TorBox: ${totalChecked}`);
    console.log(`  Actual TorBox HTTP requests: ${totalHttpRequests}`);
    console.log(`  Cached results: ${totalCached}`);
    console.log(`  Uncached results: ${totalUncached}`);
    console.log(`  Provider failures: ${totalFailed}`);
    if (totalChecked > 0) {
      console.log(`  Cache hit percentage: ${((totalCached / totalChecked) * 100).toFixed(1)}%`);
    }
    console.log(`  Queue entries completed: ${totalCompleted}`);
    console.log(`  Queue entries failed: ${totalFailed}`);
    console.log('');

    // Queue state after
    const statsAfter = cache.getCacheProbeStats();
    console.log('Queue state after:');
    console.log(`  Total: ${statsAfter.total}, Pending: ${statsAfter.pending}, Checking: ${statsAfter.checking}`);
    console.log('');

    // Observation count after
    const db2 = new DatabaseSync(args.dbPath, { readOnly: true });
    let obsCountAfter = 0;
    try {
      const row = db2.prepare("SELECT COUNT(*) as c FROM provider_observation_events WHERE provider = 'torbox'").get();
      obsCountAfter = row.c;
    } finally {
      db2.close();
    }
    console.log('Observations:');
    console.log(`  Before: ${obsCountBefore}`);
    console.log(`  After: ${obsCountAfter}`);
    console.log(`  Added: ${obsCountAfter - obsCountBefore}`);
    console.log('');

    console.log('✅ Cache probe worker complete');
  } finally {
    cache.close();
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  if (err.code === 'BAD_TOKEN' || err.code === 'AUTH_ERROR' || err.status === 401 || err.status === 403) {
    console.error('The TorBox provider credential must be refreshed.');
  }
  process.exit(1);
});
