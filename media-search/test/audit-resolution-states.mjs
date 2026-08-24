/**
 * Audit resolution states for enrichment sample.
 *
 * Shows the breakdown of resolution states with examples,
 * separating "found a match" from "trusted identity".
 *
 * Usage:
 *   node test/audit-resolution-states.mjs [db-path]
 *
 * Defaults to /tmp/enrichment-working.db
 */

import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2] || '/tmp/enrichment-working.db';
const db = new DatabaseSync(dbPath);

console.log('=== Resolution State Audit ===\n');

// Overall distribution
const distribution = db.prepare(`
  SELECT resolution_state, COUNT(*) as count,
         ROUND(AVG(confidence), 2) as avg_confidence
  FROM candidate_media
  WHERE resolver_source IS NOT NULL
  GROUP BY resolution_state
  ORDER BY count DESC
`).all();

console.log('Distribution:');
for (const row of distribution) {
  console.log(`  ${row.resolution_state}: ${row.count} (avg_conf=${row.avg_confidence})`);
}

// Breakdown by confidence bucket for each state
console.log('\nBy confidence bucket:');
const bucketed = db.prepare(`
  SELECT
    resolution_state,
    CASE
      WHEN confidence >= 0.9 THEN 'very_high'
      WHEN confidence >= 0.7 THEN 'high'
      WHEN confidence >= 0.5 THEN 'medium'
      WHEN confidence >= 0.3 THEN 'low'
      ELSE 'very_low'
    END as bucket,
    COUNT(*) as count
  FROM candidate_media
  WHERE resolver_source IS NOT NULL
  GROUP BY resolution_state, bucket
  ORDER BY resolution_state, bucket
`).all();

const byState = {};
for (const row of bucketed) {
  if (!byState[row.resolution_state]) byState[row.resolution_state] = [];
  byState[row.resolution_state].push(`${row.bucket}=${row.count}`);
}
for (const [state, buckets] of Object.entries(byState)) {
  console.log(`  ${state}: ${buckets.join(', ')}`);
}

// Show ambiguous examples (the ones that need review)
console.log('\n=== Ambiguous matches (need review) ===');
const ambiguous = db.prepare(`
  SELECT cm.info_hash, cm.media_id, cm.confidence, cm.match_method, cm.evidence,
         ra.title as release_title, ra.year as release_year, ra.season, ra.episode
  FROM candidate_media cm
  LEFT JOIN release_attributes ra ON ra.info_hash = cm.info_hash AND ra.file_index_key = cm.file_index_key
  WHERE cm.resolution_state = 'ambiguous'
  ORDER BY cm.confidence DESC
  LIMIT 20
`).all();

for (const ex of ambiguous) {
  console.log(`  ${ex.release_title || '?'} ${ex.release_year || ''} → ${ex.media_id}`);
  console.log(`    conf=${ex.confidence} method=${ex.match_method}`);
  console.log(`    evidence=${ex.evidence}`);
  console.log(`    release attrs: year=${ex.release_year} s=${ex.season} e=${ex.episode}`);
  console.log('');
}

// Show confirmed/probable examples
console.log('=== Confirmed/Probable matches (trusted) ===');
const confirmed = db.prepare(`
  SELECT cm.info_hash, cm.media_id, cm.confidence, cm.match_method, cm.evidence,
         ra.title as release_title, ra.year as release_year
  FROM candidate_media cm
  LEFT JOIN release_attributes ra ON ra.info_hash = cm.info_hash AND ra.file_index_key = cm.file_index_key
  WHERE cm.resolution_state IN ('confirmed', 'probable')
  ORDER BY cm.confidence DESC
`).all();

for (const ex of confirmed) {
  console.log(`  ${ex.release_title || '?'} → ${ex.media_id}`);
  console.log(`    conf=${ex.confidence} method=${ex.match_method} state=${ex.resolution_state || 'n/a'}`);
  console.log('');
}

// Summary
const totals = db.prepare(`
  SELECT
    COUNT(*) as total,
    COUNT(CASE WHEN resolution_state = 'confirmed' THEN 1 END) as confirmed,
    COUNT(CASE WHEN resolution_state = 'probable' THEN 1 END) as probable,
    COUNT(CASE WHEN resolution_state = 'ambiguous' THEN 1 END) as ambiguous,
    COUNT(CASE WHEN resolution_state = 'rejected' THEN 1 END) as rejected,
    COUNT(CASE WHEN resolution_state = 'unresolved' THEN 1 END) as unresolved
  FROM candidate_media
  WHERE resolver_source IS NOT NULL
`).get();

console.log('=== Summary ===');
console.log(`Total enrichment rows: ${totals.total}`);
console.log(`Confirmed (trusted):   ${totals.confirmed}`);
console.log(`Probable (usable):     ${totals.probable}`);
console.log(`Ambiguous (review):    ${totals.ambiguous}`);
console.log(`Rejected:              ${totals.rejected}`);
console.log(`Unresolved:            ${totals.unresolved}`);
console.log(`\nTrusted ratio: ${(totals.confirmed + totals.probable)}/${totals.total} (${((totals.confirmed + totals.probable) / totals.total * 100).toFixed(1)}%)`);

db.close();
