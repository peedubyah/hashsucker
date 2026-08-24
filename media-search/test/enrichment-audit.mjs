#!/usr/bin/env node
/**
 * Controlled Production Enrichment Run
 *
 * Runs enrichment against the stage3 fixture database to validate
 * resolver quality before scaling to the full corpus.
 *
 * Usage: node test/enrichment-audit.mjs
 */

import { execSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, '../..');
const ARTIFACT_ROOT = path.join(REPOSITORY_ROOT, 'artifacts/stage3');
const FIXTURE_DB = path.join(ARTIFACT_ROOT, 'dmm-stage3-functional.db');
const WORKING_DB = path.join(ARTIFACT_ROOT, 'enrichment-audit-working.db');

// Copy fixture to working copy
console.log('Creating working copy of fixture database...');
copyFileSync(FIXTURE_DB, WORKING_DB);

// Set environment to use working copy
process.env.DISCOVERY_DB = WORKING_DB;

// Import cache after setting env
const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
const { getEnrichmentDiagnostics, formatEnrichmentDiagnostics } = await import('../src/lib/discovery/enrichment-diagnostics.js');

function section(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

// Step 1: Capture baseline
section('STEP 1: BASELINE');
const cache = createDiscoveryCache({ dbPath: WORKING_DB });
const baseline = getEnrichmentDiagnostics(cache);
console.log(formatEnrichmentDiagnostics(baseline));

// Step 2: Seed
section('STEP 2: SEED');
const seedResult = cache.enqueueUnresolvedCandidates({ limit: 1000 });
console.log(`Seeded: ${seedResult.enqueued}`);
console.log(`Skipped (already in queue): ${seedResult.skipped}`);
console.log(`Total unresolved: ${seedResult.total}`);

// Step 3: Process first 100
section('STEP 3: PROCESS FIRST 100');
const { runIdentityEnrichmentWorker } = await import('../src/lib/discovery/identity-enrichment-worker.js');
const { CinemetaIdentityResolver } = await import('../src/lib/discovery/cinemeta-identity-resolver.js');

const resolver = new CinemetaIdentityResolver();
const processStats = await runIdentityEnrichmentWorker(cache, { resolver, limit: 100 });

console.log(`Total items: ${processStats.total}`);
console.log(`Processed: ${processStats.processed}`);
console.log(`Resolved: ${processStats.resolved}`);
console.log(`Failed: ${processStats.failed}`);
console.log(`Skipped: ${processStats.skipped}`);
if (processStats.errors.length > 0) {
  console.log(`Errors: ${processStats.errors.length}`);
  for (const err of processStats.errors.slice(0, 5)) {
    console.log(`  - ${err.error} (${err.infoHash})`);
  }
}

// Step 4: Capture status after
section('STEP 4: STATUS AFTER FIRST 100');
const after100 = getEnrichmentDiagnostics(cache);
console.log(formatEnrichmentDiagnostics(after100));

// Step 5: Audit results
section('STEP 5: AUDIT RESULTS');

// Get sample of successful associations
const successSample = cache.db.prepare(`
  SELECT c.filename, c.title as candidate_title, ra.title as parsed_title, ra.year as parsed_year,
         ra.season as parsed_season, ra.episode as parsed_episode,
         cm.media_id, cm.confidence, cm.evidence, cm.resolver_source, cm.match_method
  FROM candidate_media cm
  JOIN candidates c ON c.info_hash = cm.info_hash AND c.file_index_key = cm.file_index_key
  LEFT JOIN release_attributes ra ON ra.info_hash = cm.info_hash AND ra.file_index_key = cm.file_index_key
  WHERE cm.resolver_source = 'cinemeta'
  ORDER BY cm.confidence DESC
  LIMIT 10
`).all();

console.log('\n--- 10 Representative Successful Associations ---');
for (const row of successSample) {
  const evidence = JSON.parse(row.evidence || '[]');
  console.log(`\nFilename: ${row.filename}`);
  console.log(`  Parsed: ${row.parsed_title} (${row.parsed_year}) S${row.season}E${row.episode}`);
  console.log(`  Resolved: ${row.media_id} (confidence: ${row.confidence.toFixed(2)})`);
  console.log(`  Evidence: ${evidence.join(', ')}`);
  console.log(`  Match method: ${row.match_method}`);
}

// Get sample of failures/ambiguous
const failureSample = cache.db.prepare(`
  SELECT c.filename, c.title as candidate_title, ra.title as parsed_title, ra.year as parsed_year,
         ra.season as parsed_season, ra.episode as parsed_episode,
         ieq.status, ieq.error_message, ieq.error_category, ieq.attempts
  FROM identity_enrichment_queue ieq
  JOIN candidates c ON c.info_hash = ieq.info_hash AND c.file_index_key = ieq.file_index_key
  LEFT JOIN release_attributes ra ON ra.info_hash = ieq.info_hash AND ra.file_index_key = ieq.file_index_key
  WHERE ieq.status IN ('failed', 'pending')
  ORDER BY ieq.attempts DESC, ieq.updated_at DESC
  LIMIT 10
`).all();

console.log('\n--- 10 Failures/Ambiguous Cases ---');
for (const row of failureSample) {
  console.log(`\nFilename: ${row.filename}`);
  console.log(`  Parsed: ${row.parsed_title} (${row.parsed_year}) S${row.season}E${row.episode}`);
  console.log(`  Status: ${row.status} (attempts: ${row.attempts})`);
  console.log(`  Error: ${row.error_message || 'No match found'}`);
  console.log(`  Category: ${row.error_category || 'N/A'}`);
}

// Summary
section('SUMMARY');
console.log(`Seeded: ${seedResult.enqueued}`);
console.log(`Processed: ${processStats.processed}`);
console.log(`Resolved: ${processStats.resolved}`);
console.log(`Failed: ${processStats.failed}`);
console.log(`Unresolved: ${after100.queue.pending}`);
console.log(`Retryable: ${after100.queue.unresolved}`);
console.log(`Coverage before: ${(baseline.coverage.coveragePercentage * 100).toFixed(1)}%`);
console.log(`Coverage after: ${(after100.coverage.coveragePercentage * 100).toFixed(1)}%`);
console.log(`Resolver success rate: ${(after100.resolverPerformance.overallSuccessRate * 100).toFixed(1)}%`);
console.log(`Confidence distribution:`, after100.confidence.distribution);

cache.close();

console.log('\nAudit complete.');
