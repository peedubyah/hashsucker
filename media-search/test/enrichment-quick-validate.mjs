#!/usr/bin/env node
/**
 * Quick Enrichment Validation Run
 *
 * Runs a small batch (10 items) to validate resolver quality
 * without waiting for the full 100-item batch.
 */

import { copyFileSync } from 'node:fs';
import path from 'node:path';

// Go up from media-search to hashsucker root
const REPOSITORY_ROOT = path.resolve(process.cwd(), '..');
const ARTIFACT_ROOT = path.join(REPOSITORY_ROOT, 'artifacts/stage3');
const FIXTURE_DB = path.join(ARTIFACT_ROOT, 'dmm-stage3-functional.db');
const WORKING_DB = path.join(ARTIFACT_ROOT, 'enrichment-quick-test.db');

// Copy fixture to working copy
console.log('Creating working copy of fixture database...');
copyFileSync(FIXTURE_DB, WORKING_DB);

const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
const { getEnrichmentDiagnostics, formatEnrichmentDiagnostics } = await import('../src/lib/discovery/enrichment-diagnostics.js');
const { runIdentityEnrichmentWorker } = await import('../src/lib/discovery/identity-enrichment-worker.js');
const { CinemetaIdentityResolver } = await import('../src/lib/discovery/cinemeta-identity-resolver.js');

function section(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

// Step 1: Baseline
section('STEP 1: BASELINE');
const cache = createDiscoveryCache({ dbPath: WORKING_DB });
const baseline = getEnrichmentDiagnostics(cache);
console.log(`Total candidates: ${baseline.coverage.totalCandidates}`);
console.log(`With media: ${baseline.coverage.candidatesWithMedia}`);
console.log(`Coverage: ${(baseline.coverage.coveragePercentage * 100).toFixed(1)}%`);

// Step 2: Seed
section('STEP 2: SEED');
const seedResult = cache.enqueueUnresolvedCandidates({ limit: 1000 });
console.log(`Seeded: ${seedResult.enqueued}`);
console.log(`Skipped: ${seedResult.skipped}`);

// Step 3: Process just 10 for quick validation
section('STEP 3: PROCESS 10 (Quick Validation)');
const resolver = new CinemetaIdentityResolver();
const processStats = await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

console.log(`Processed: ${processStats.processed}`);
console.log(`Resolved: ${processStats.resolved}`);
console.log(`Failed: ${processStats.failed}`);
console.log(`Skipped: ${processStats.skipped}`);

// Step 4: Status after
section('STEP 4: STATUS AFTER 10');
const after = getEnrichmentDiagnostics(cache);
console.log(`Queue pending: ${after.queue.pending}`);
console.log(`Queue resolved: ${after.queue.resolved}`);
console.log(`Coverage: ${(after.coverage.coveragePercentage * 100).toFixed(1)}%`);

// Step 5: Sample results
section('STEP 5: SAMPLE RESULTS');

const successSample = cache.db.prepare(`
  SELECT c.filename, ra.title as parsed_title, ra.year as parsed_year,
         ra.season as parsed_season, ra.episode as parsed_episode,
         cm.media_id, cm.confidence, cm.evidence, cm.match_method
  FROM candidate_media cm
  JOIN candidates c ON c.info_hash = cm.info_hash AND c.file_index_key = cm.file_index_key
  LEFT JOIN release_attributes ra ON ra.info_hash = cm.info_hash AND ra.file_index_key = cm.file_index_key
  WHERE cm.resolver_source = 'cinemeta'
  ORDER BY cm.confidence DESC
  LIMIT 10
`).all();

console.log('\n--- Successful Associations ---');
for (const row of successSample) {
  const evidence = JSON.parse(row.evidence || '[]');
  console.log(`\nFile: ${row.filename?.substring(0, 60)}`);
  console.log(`  Parsed: ${row.parsed_title} (${row.parsed_year}) S${row.season}E${row.episode}`);
  console.log(`  Media: ${row.media_id} confidence=${row.confidence.toFixed(2)}`);
  console.log(`  Evidence: ${evidence.join(', ')}`);
}

// Failures
const failureSample = cache.db.prepare(`
  SELECT c.filename, ra.title as parsed_title, ra.year as parsed_year,
         ieq.status, ieq.error_message, ieq.attempts
  FROM identity_enrichment_queue ieq
  JOIN candidates c ON c.info_hash = ieq.info_hash AND c.file_index_key = ieq.file_index_key
  LEFT JOIN release_attributes ra ON ra.info_hash = ieq.info_hash AND ra.file_index_key = ieq.file_index_key
  WHERE ieq.status IN ('failed', 'pending')
  ORDER BY ieq.attempts DESC
  LIMIT 10
`).all();

console.log('\n--- Failures/Pending ---');
for (const row of failureSample) {
  console.log(`\nFile: ${row.filename?.substring(0, 60)}`);
  console.log(`  Parsed: ${row.parsed_title} (${row.parsed_year})`);
  console.log(`  Status: ${row.status} attempts=${row.attempts}`);
  console.log(`  Error: ${row.error_message || 'No match'}`);
}

cache.close();
console.log('\nQuick validation complete.');
