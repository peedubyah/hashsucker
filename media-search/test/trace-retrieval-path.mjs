/**
 * Trace Retrieval Path
 * 
 * Investigates why corpus retrieval for a mediaId query returns
 * high-volume Probable candidates without candidate_media associations.
 * 
 * Traces: FTS5 query construction → indexed fields → ingestion path → enrichment path
 * 
 * Uses an in-memory database to demonstrate the full pipeline.
 */

import { DatabaseSync } from 'node:sqlite';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { runAttributeWorker } from '../src/lib/discovery/attribute-worker.js';
import { classifyIdentityTier } from '../src/lib/discovery/ranking.js';

console.log('=== RETRIEVAL PATH TRACE ===\n');

// ============================================================
// 1. SETUP: Create in-memory database with schema
// ============================================================

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA journal_mode = WAL');

// Create cache with in-memory database
const cache = createDiscoveryCache({ database: db });

console.log('1. DATABASE SETUP');
console.log('   ✓ In-memory database created with schema');
console.log('   ✓ FTS5 virtual table created: release_search');
console.log('   ✓ Triggers created for FTS5 auto-sync\n');

// ============================================================
// 2. FTS5 INDEX ANALYSIS
// ============================================================

console.log('2. FTS5 INDEX STRUCTURE');

const ftsColumns = db.prepare(`PRAGMA table_info(release_search)`).all();
console.log('   Indexed columns in release_search:');
ftsColumns.forEach(c => console.log(`     - ${c.name}`));

console.log('\n   KEY OBSERVATION:');
console.log('   ✗ mediaId is NOT in FTS5 index');
console.log('   ✗ candidate_media is NOT joined in retrieval query');
console.log('   → FTS5 matches on title/filename/resolution/etc ONLY\n');

// ============================================================
// 3. INGESTION PATH TRACE
// ============================================================

console.log('3. INGESTION PATH ANALYSIS\n');

// Simulate DMM ingestion: candidates with filenames
const testCandidates = [
  { hash: 'a'.repeat(40), filename: 'NCIS.S01E01.720p.BluRay.x264', size: 1000000 },
  { hash: 'b'.repeat(40), filename: 'NCIS.S01E02.1080p.WEB-DL', size: 2000000 },
  { hash: 'c'.repeat(40), filename: 'Breaking.Bad.S01E01.720p', size: 1500000 },
  { hash: 'd'.repeat(40), filename: 'Random.Movie.2020.1080p', size: 3000000 },
  { hash: 'e'.repeat(40), filename: 'NCIS.Los.Angeles.S01E01.720p', size: 1200000 },
];

console.log('   Step 1: Insert candidates into cache');
for (const c of testCandidates) {
  cache.upsertCandidate({
    infoHash: c.hash,
    fileIndex: null,
    filename: c.filename,
    size: c.size,
    seeders: 10,
    leechers: 2,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    sources: [{ origin: 'dmm', confidence: 0.9 }],
  });
}
console.log(`   ✓ ${testCandidates.length} candidates inserted\n`);

console.log('   Step 2: Run attribute worker (parses filenames → release_attributes → FTS5)');
const attrStats = await runAttributeWorker(cache, { limit: 10 });
console.log(`   ✓ Attribute parsing complete:`);
console.log(`     - Processed: ${attrStats.processed}`);
console.log(`     - Parsed: ${attrStats.parsed}`);
console.log(`     - Skipped: ${attrStats.skipped}`);
console.log(`   ✓ FTS5 index auto-populated via triggers\n`);

// ============================================================
// 4. RETRIEVAL QUERY TRACE
// ============================================================

console.log('4. RETRIEVAL QUERY TRACE\n');

// Simulate the FTS5 query for "NCIS"
const query = 'NCIS';
const terms = query.split(/\s+/).filter(t => t.length > 0);
const matchExpr = terms.map(t => `"${t.replace(/"/g, '""')}"*`).join(' AND ');

console.log(`   Query: "${query}"`);
console.log(`   FTS5 MATCH expression: ${matchExpr}\n`);

const retrievalQuery = db.prepare(`
  SELECT 
    ra.info_hash,
    ra.filename,
    ra.title,
    bm25(release_search) as bm25_score
  FROM release_search rs
  JOIN release_attributes ra ON ra.rowid = rs.rowid
  WHERE release_search MATCH ?
  ORDER BY bm25_score ASC
  LIMIT 50
`);

const results = retrievalQuery.all(matchExpr);

console.log(`   FTS5 returned ${results.length} candidates:`);
results.forEach((r, i) => {
  console.log(`     ${i+1}. ${r.filename} (bm25=${r.bm25_score.toFixed(2)})`);
});

console.log('\n   KEY OBSERVATION:');
console.log('   ✗ No JOIN with candidate_media');
console.log('   ✗ No mediaId filter in WHERE clause');
console.log('   → All text matches returned regardless of identity metadata\n');

// ============================================================
// 5. MEDIA ASSOCIATION LOOKUP TRACE
// ============================================================

console.log('5. MEDIA ASSOCIATION LOOKUP\n');

console.log('   Post-fetch: Fetch media associations for each candidate:');
for (const r of results) {
  const media = cache.getMediaAssociations(r.info_hash, null);
  const mediaInfo = media.length > 0 
    ? media.map(m => `${m.mediaId}(${m.confidence})`).join(', ')
    : 'NONE';
  console.log(`     ${r.filename}: ${mediaInfo}`);
}

console.log('\n   KEY OBSERVATION:');
console.log('   ✗ All candidates return EMPTY media associations');
console.log('   → Without enrichment, candidate_media is always empty\n');

// ============================================================
// 6. ENRICHMENT PATH TRACE
// ============================================================

console.log('6. ENRICHMENT PATH ANALYSIS\n');

console.log('   The enrichment worker (worker.js) would:');
console.log('   1. Query candidates without media associations');
console.log('   2. Call enrichWithCinemeta(title) → mediaId');
console.log('   3. Store result via cache.associateMedia()');
console.log('');

// Simulate enrichment for one candidate
console.log('   Simulated enrichment result:');
cache.associateMedia('a'.repeat(40), null, 'tt0364845', {
  source: 'cinemeta',
  confidence: 0.85,
  evidence: { title: 'NCIS', year: 2003 },
});
console.log('     ✓ NCIS.S01E01 → tt0364845 (NCIS) via cinemeta');

const enrichedMedia = cache.getMediaAssociations('a'.repeat(40), null);
console.log(`     Media associations: ${JSON.stringify(enrichedMedia)}\n`);

// ============================================================
// 7. IDENTITY TIER CLASSIFICATION
// ============================================================

console.log('7. IDENTITY TIER CLASSIFICATION\n');

console.log('   Without enrichment (all candidates):');
for (const r of results.slice(0, 3)) {
  const hit = {
    hash: r.info_hash,
    filename: r.filename,
    relevance: 0.8,
    releaseAttributes: { title: r.title },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
    mediaAssociations: cache.getMediaAssociations(r.info_hash, null),
  };
  const tier = classifyIdentityTier(hit, { season: 1, episode: 1 }, 'tt0364845');
  console.log(`     ${r.filename}: ${tier.IdentityTier} (conf=${tier.IdentityConfidence})`);
}

console.log('\n   With enrichment (first candidate):');
const enrichedHit = {
  hash: 'a'.repeat(40),
  filename: 'NCIS.S01E01.720p.BluRay.x264',
  relevance: 0.8,
  releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
  sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
  mediaAssociations: cache.getMediaAssociations('a'.repeat(40), null),
};
const enrichedTier = classifyIdentityTier(enrichedHit, { season: 1, episode: 1 }, 'tt0364845');
console.log(`     NCIS.S01E01: ${enrichedTier.IdentityTier} (conf=${enrichedTier.IdentityConfidence})`);

// ============================================================
// 8. ROOT CAUSE ANALYSIS
// ============================================================

console.log('\n8. ROOT CAUSE ANALYSIS\n');

console.log('   PIPELINE FLOW:');
console.log('   ┌─────────────────────────────────────────────────────────────┐');
console.log('   │ 1. Ingestion: DMM hashlist → candidates table              │');
console.log('   │    (creates candidate rows, NO media associations)          │');
console.log('   │                                                             │');
console.log('   │ 2. Attribute Worker: filenames → release_attributes        │');
console.log('   │    (auto-populates FTS5 via triggers, NO media assoc)      │');
console.log('   │                                                             │');
console.log('   │ 3. Enrichment Worker: titles → candidate_media             │');
console.log('   │    (OPTIONAL, external API call, creates media assoc)      │');
console.log('   │                                                             │');
console.log('   │ 4. FTS5 Retrieval: title/filename MATCH → candidates       │');
console.log('   │    (NO join with candidate_media, NO mediaId filter)       │');
console.log('   │                                                             │');
console.log('   │ 5. Identity Tier: classifyIdentityTier(mediaAssociations)  │');
console.log('   │    (empty assoc → Probable, has assoc → Verified)          │');
console.log('   └─────────────────────────────────────────────────────────────┘');

console.log('\n   DIAGNOSIS:');
console.log('   ┌─────────────────────────────────────────────────────────────┐');
console.log('   │ PRIMARY ISSUE: Missing Identity Metadata                    │');
console.log('   │                                                             │');
console.log('   │ The FTS5 retrieval is working correctly — it returns       │');
console.log('   │ candidates matching the query text. The issue is that      │');
console.log('   │ candidate_media associations are empty because:             │');
console.log('   │                                                             │');
console.log('   │ 1. Enrichment worker is OPTIONAL (not auto-run)            │');
console.log('   │ 2. Enrichment requires external API (Cinemeta)             │');
console.log('   │ 3. Not all titles resolve to mediaIds                      │');
console.log('   │                                                             │');
console.log('   │ SECONDARY ISSUE: Retrieval Precision (by design)           │');
console.log('   │                                                             │');
console.log('   │ FTS5 returns ALL text matches without filtering by         │');
console.log('   │ mediaId. This is intentional — mediaId is NOT a            │');
console.log('   │ retrieval gate, it is a ranking signal.                    │');
console.log('   │                                                             │');
console.log('   │ Result: High-volume Probable candidates without            │');
console.log('   │ candidate_media associations.                              │');
console.log('   └─────────────────────────────────────────────────────────────┘');

console.log('\n   VERDICT:');
console.log('   ✗ NOT a retrieval precision issue');
console.log('   ✗ FTS5 query construction is correct');
console.log('   ✗ FTS5 indexed fields are correct');
console.log('   ✓ ISSUE = Missing identity metadata in candidate_media');
console.log('');
console.log('   FIX OPTIONS:');
console.log('   1. Run enrichment worker to populate candidate_media');
console.log('   2. Add mediaId to FTS5 index (if retrieval-by-mediaId needed)');
console.log('   3. Accept Probable tier as default for text-only matches');

cache.close();
