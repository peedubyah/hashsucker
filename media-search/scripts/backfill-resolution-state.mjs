/**
 * Backfill resolution_state for existing candidate_media rows.
 *
 * Reads existing rows from the enrichment DB, classifies each using
 * classifyResolutionState(), and updates the resolution_state column.
 *
 * Usage:
 *   node test/backfill-resolution-state.mjs [db-path]
 *
 * Defaults to /tmp/enrichment-working.db
 */

import { DatabaseSync } from 'node:sqlite';
import { classifyResolutionState } from '../src/lib/discovery/enrichment-sources/confidence.js';

const dbPath = process.argv[2] || '/tmp/enrichment-working.db';

const db = new DatabaseSync(dbPath);

// Ensure column exists
try {
  db.exec(`ALTER TABLE candidate_media ADD COLUMN resolution_state TEXT NOT NULL DEFAULT 'unresolved';`);
} catch (e) {
  // Column already exists
}

// Get all rows that need backfilling
const rows = db.prepare(`
  SELECT info_hash, file_index_key, media_id, confidence, evidence, match_method
  FROM candidate_media
  WHERE resolution_state = 'unresolved'
    AND resolver_source IS NOT NULL
`).all();

console.log(`Backfilling ${rows.length} rows...`);

const updateStmt = db.prepare(`
  UPDATE candidate_media
  SET resolution_state = ?
  WHERE info_hash = ? AND file_index_key = ? AND media_id = ?
`);

const stateCounts = {};

for (const row of rows) {
  let evidence = [];
  try {
    evidence = JSON.parse(row.evidence || '[]');
  } catch {
    // ignore parse errors
  }

  const state = classifyResolutionState({
    confidence: row.confidence,
    evidence,
    matchCount: 1,
  });

  updateStmt.run(state, row.info_hash, row.file_index_key, row.media_id);

  stateCounts[state] = (stateCounts[state] || 0) + 1;
}

console.log('\nBackfill complete. Resolution state distribution:');
for (const [state, count] of Object.entries(stateCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${state}: ${count}`);
}

// Show some examples per state
console.log('\nExamples per state:');
for (const state of Object.keys(stateCounts).sort()) {
  const examples = db.prepare(`
    SELECT cm.info_hash, cm.media_id, cm.confidence, cm.match_method, cm.evidence, ra.title as release_title
    FROM candidate_media cm
    LEFT JOIN release_attributes ra ON ra.info_hash = cm.info_hash AND ra.file_index_key = cm.file_index_key
    WHERE cm.resolution_state = ?
    LIMIT 3
  `).all(state);

  console.log(`\n  ${state}:`);
  for (const ex of examples) {
    console.log(`    ${ex.release_title || ex.info_hash.slice(0, 16)} → ${ex.media_id} (conf=${ex.confidence}, method=${ex.match_method})`);
  }
}

db.close();
console.log('\nDone.');
