#!/usr/bin/env node
/**
 * DMM Probe Seeder
 *
 * Populates the cache probe queue from real DMM corpus candidates.
 *
 * Usage:
 *   npm run dmm:seed-probes -- --dry-run --limit 1000
 *   npm run dmm:seed-probes -- --limit 1000
 *   npm run dmm:seed-probes -- --db /path/to/discovery-cache.db --limit 500
 *
 * Priority signals (simple, deterministic):
 *   - Base: 0
 *   - Has parsed release metadata (release_attributes): +10
 *   - Has trusted media identity (candidate_media, resolved): +20
 *
 * Queue reasons:
 *   - corpus:identity+metadata
 *   - corpus:identity
 *   - corpus:metadata
 *   - corpus:base
 */

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.DISCOVERY_DB || './discovery-cache.db';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dbPath: DB_PATH,
    limit: 1000,
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) { args.limit = parseInt(argv[++i], 10); }
    else if (a === '--db' && argv[i + 1]) { args.dbPath = argv[++i]; }
    else if (a === '--dry-run' || a === '-n') { args.dryRun = true; }
    else if (a === '--verbose' || a === '-v') { args.verbose = true; }
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
  }

  return args;
}

function printUsage() {
  console.log(`
DMM Probe Seeder — populate cache probe queue from corpus candidates

Usage:
  npm run dmm:seed-probes -- [options]

Options:
  --limit N       Max candidates to process (default: 1000)
  --db <path>     Discovery cache database path (default: ./discovery-cache.db or $DISCOVERY_DB)
  --dry-run, -n   Show what would be done without writing
  --verbose, -v   Show detailed per-hash output
  --help, -h      Show this help

Examples:
  npm run dmm:seed-probes -- --dry-run --limit 100
  npm run dmm:seed-probes -- --limit 1000
`);
}

// ---------------------------------------------------------------------------
// Corpus inspection
// ---------------------------------------------------------------------------

const INFO_HASH_RE = /^[a-f0-9]{40}$/;

function isValidInfoHash(hash) {
  return typeof hash === 'string' && INFO_HASH_RE.test(hash);
}

/**
 * Inspect corpus and collect candidate hashes with their priority signals.
 * Uses a direct read-only connection to avoid coupling to cache internals.
 */
function inspectCorpus(dbPath, limit) {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    // Check which tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('candidate_media', 'release_attributes')"
    ).all().map(r => r.name);
    const hasMedia = tables.includes('candidate_media');
    const hasRelease = tables.includes('release_attributes');

    // Build a set of hashes with trusted media identity
    // Only use this signal if resolution_state column exists and we can identify resolved media
    const identityHashes = new Set();
    if (hasMedia) {
      const cmCols = db.prepare("PRAGMA table_info(candidate_media)").all().map(c => c.name);
      const hasResolutionState = cmCols.includes('resolution_state');
      // Only query for trusted identity if we can determine it from the schema
      if (hasResolutionState) {
        const rows = db.prepare(`
          SELECT DISTINCT info_hash
          FROM candidate_media
          WHERE info_hash IS NOT NULL
            AND resolution_state = 'resolved'
        `).all();
        for (const r of rows) {
          if (isValidInfoHash(r.info_hash)) identityHashes.add(r.info_hash);
        }
      }
      // If resolution_state is absent, omit identity signal entirely for this database
    }

    // Build a set of hashes with parsed release metadata
    const metadataHashes = new Set();
    if (hasRelease) {
      const rows = db.prepare(`
        SELECT DISTINCT info_hash
        FROM release_attributes
        WHERE info_hash IS NOT NULL
      `).all();
      for (const r of rows) {
        if (isValidInfoHash(r.info_hash)) metadataHashes.add(r.info_hash);
      }
    }

    // Get total candidate count
    const totalCount = db.prepare(
      "SELECT COUNT(*) as c FROM candidates WHERE info_hash IS NOT NULL AND info_hash != ''"
    ).get().c;

    // Fetch candidate hashes (bounded), ordered by DMM prevalence (fragment_count DESC)
    // Prefer hashes that appear in more fragments — weak probe-ordering signal only.
    const candidates = db.prepare(`
      SELECT DISTINCT c.info_hash, COALESCE(p.fragment_count, 0) as fragment_count
      FROM candidates c
      LEFT JOIN dmm_hash_prevalence p ON c.info_hash = p.info_hash
      WHERE c.info_hash IS NOT NULL AND c.info_hash != ''
      ORDER BY fragment_count DESC, c.first_seen ASC
      LIMIT ?
    `).all(limit);

    const hashes = [];
    for (const c of candidates) {
      if (isValidInfoHash(c.info_hash)) {
        const hash = c.info_hash;
        const hasIdentity = identityHashes.has(hash);
        const hasMetadata = metadataHashes.has(hash);
        let priority = 0;
        let reason = 'corpus:base';
        if (hasIdentity && hasMetadata) { priority = 30; reason = 'corpus:identity+metadata'; }
        else if (hasIdentity) { priority = 20; reason = 'corpus:identity'; }
        else if (hasMetadata) { priority = 10; reason = 'corpus:metadata'; }
        hashes.push({ hash, priority, reason, fragment_count: c.fragment_count || 0 });
      }
    }

    return {
      totalCandidates: totalCount,
      hashes,
      hasMedia,
      hasRelease,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('DMM Probe Seeder');
  console.log(`  Database: ${args.dbPath}`);
  console.log(`  Limit: ${args.limit}`);
  console.log(`  Mode: ${args.dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log('');

  // Inspect corpus
  const corpus = inspectCorpus(args.dbPath, args.limit);

  console.log('Corpus inspection:');
  console.log(`  Total candidates in DB: ${corpus.totalCandidates}`);
  console.log(`  Valid unique hashes found: ${corpus.hashes.length}`);
  console.log(`  Has candidate_media table: ${corpus.hasMedia}`);
  console.log(`  Has release_attributes table: ${corpus.hasRelease}`);
  console.log('');

  // Open cache for enqueueing
  const cache = createDiscoveryCache({ dbPath: args.dbPath });

  try {
    // Get current queue state
    const statsBefore = cache.getCacheProbeStats();
    console.log('Queue state before:');
    console.log(`  Total: ${statsBefore.total}, Pending: ${statsBefore.pending}, Checking: ${statsBefore.checking}`);
    console.log('');

    // Count how many hashes already have active probes
    let alreadyQueued = 0;
    let freshSkipped = 0;
    let wouldCreate = 0;
    const priorityDist = new Map();

    for (const h of corpus.hashes) {
      const existing = cache.getCacheProbeByHash(h.hash);
      if (existing && (existing.status === 'pending' || existing.status === 'checking')) {
        alreadyQueued++;
        if (args.verbose) console.log(`  [skip] ${h.hash} — already ${existing.status}`);
      } else if (cache.hasFreshTorBoxObservation(h.hash, null)) {
        // Refresh-aware: skip hashes with fresh authoritative TorBox observations
        freshSkipped++;
        if (args.verbose) console.log(`  [skip] ${h.hash} — fresh TorBox observation exists`);
      } else {
        wouldCreate++;
        const key = `${h.priority}:${h.reason}`;
        priorityDist.set(key, (priorityDist.get(key) || 0) + 1);
        if (!args.dryRun) {
          cache.enqueueProbe(h.hash, { priority: h.priority, reason: h.reason });
        }
        if (args.verbose) console.log(`  [${args.dryRun ? 'would-add' : 'add'}] ${h.hash} — priority=${h.priority} reason=${h.reason} fragment_count=${h.fragment_count || 0}`);
      }
    }

    console.log('Seed results:');
    console.log(`  Hashes already actively queued: ${alreadyQueued}`);
    console.log(`  Hashes with fresh TorBox observation (skipped): ${freshSkipped}`);
    console.log(`  Probes ${args.dryRun ? 'that would be created' : 'created'}: ${wouldCreate}`);
    console.log('');

    // Priority distribution
    console.log('Priority/reason distribution:');
    const sortedDist = [...priorityDist.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    for (const [key, count] of sortedDist) {
      const [priority, reason] = key.split(':');
      console.log(`  priority=${priority} reason=${reason}: ${count}`);
    }
    const priorities = corpus.hashes.map(h => h.priority);
    const minPriority = priorities.length > 0 ? Math.min(...priorities) : 0;
    const maxPriority = priorities.length > 0 ? Math.max(...priorities) : 0;
    console.log(`  Priority range: ${minPriority} - ${maxPriority}`);
    console.log('');

    // Final queue state
    const statsAfter = cache.getCacheProbeStats();
    console.log('Queue state after:');
    console.log(`  Total: ${statsAfter.total}, Pending: ${statsAfter.pending}, Checking: ${statsAfter.checking}, Complete: ${statsAfter.complete}, Failed: ${statsAfter.failed}`);
    console.log('');

    // Show highest-priority rows
    if (statsAfter.total > 0 && !args.dryRun) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(args.dbPath, { readOnly: true });
      try {
        const topRows = db.prepare(`
          SELECT info_hash, priority, reason, status
          FROM cache_probe_queue
          ORDER BY priority DESC, created_at ASC
          LIMIT 5
        `).all();
        console.log('Highest-priority queue rows:');
        for (const r of topRows) {
          console.log(`  ${r.info_hash} priority=${r.priority} reason=${r.reason} status=${r.status}`);
        }
        console.log('');

        // Show a few genuine corpus SHA-1 hashes
        const sampleRows = db.prepare(`
          SELECT info_hash, priority, reason
          FROM cache_probe_queue
          WHERE reason LIKE 'corpus:%'
          ORDER BY RANDOM()
          LIMIT 3
        `).all();
        console.log('Sample corpus hashes in queue:');
        for (const r of sampleRows) {
          console.log(`  ${r.info_hash} (${r.reason})`);
        }
        console.log('');

        // Verify idempotency: re-running should not create duplicates
        console.log('Idempotency check (re-enqueue all corpus hashes):');
        for (const h of corpus.hashes) {
          const existing = cache.getCacheProbeByHash(h.hash);
          if (existing && (existing.status === 'pending' || existing.status === 'checking')) {
            // Already active — skip (duplicate suppression)
          } else if (cache.hasFreshTorBoxObservation(h.hash, null)) {
            // Fresh observation — would be skipped by seeder
          } else {
            // Would create new probe — verify idempotency
            cache.enqueueProbe(h.hash, { priority: h.priority, reason: h.reason });
          }
        }
        const statsVerify = cache.getCacheProbeStats();
        if (statsVerify.total === statsAfter.total) {
          console.log(`  PASS — queue total unchanged (${statsVerify.total}) after re-enqueue`);
        } else {
          console.log(`  FAIL — queue total changed from ${statsAfter.total} to ${statsVerify.total}`);
        }
      } finally {
        db.close();
      }
    }

    console.log('');
    console.log(args.dryRun ? '✅ Dry run complete (no writes performed)' : '✅ Probe seeding complete');
  } finally {
    cache.close();
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
