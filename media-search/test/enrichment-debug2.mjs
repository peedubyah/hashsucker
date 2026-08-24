#!/usr/bin/env node
/**
 * Debug Cinemeta search results vs resolver scoring
 */

import { copyFileSync } from 'node:fs';
import path from 'node:path';

const REPOSITORY_ROOT = path.resolve(process.cwd(), '..');
const ARTIFACT_ROOT = path.join(REPOSITORY_ROOT, 'artifacts/stage3');
const FIXTURE_DB = path.join(ARTIFACT_ROOT, 'dmm-stage3-functional.db');
const WORKING_DB = path.join(ARTIFACT_ROOT, 'enrichment-debug2.db');

copyFileSync(FIXTURE_DB, WORKING_DB);

const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
const { getStrongestReleaseAttributes } = await import('../src/lib/discovery/release-attributes.js');
const { searchCatalog } = await import('../src/lib/metadata/cinemeta.js');

const cache = createDiscoveryCache({ dbPath: WORKING_DB });

// Get first 3 unresolved candidates
const unresolved = cache.getUnresolvedCandidates({ limit: 3 });

console.log('=== Debugging Cinemeta Search vs Resolver Scoring ===\n');

for (const candidate of unresolved) {
  const parsed = getStrongestReleaseAttributes(cache, candidate.infoHash, candidate.fileIndex);
  const title = parsed?.title || candidate.filename;
  
  console.log(`\n--- Query: "${title}" ---`);
  
  try {
    const results = await searchCatalog(title);
    console.log(`Cinemeta returned ${results.length} results`);
    for (const r of results.slice(0, 5)) {
      console.log(`  - ${r.title} (${r.year}) id=${r.id}`);
    }
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }
}

cache.close();
