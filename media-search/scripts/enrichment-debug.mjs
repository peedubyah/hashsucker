#!/usr/bin/env node
/**
 * Debug Enrichment - Show detailed resolver output
 */

import { copyFileSync } from 'node:fs';
import path from 'node:path';

// Go up from media-search to hashsucker root
const REPOSITORY_ROOT = path.resolve(process.cwd(), '..');
const ARTIFACT_ROOT = path.join(REPOSITORY_ROOT, 'artifacts/stage3');
const FIXTURE_DB = path.join(ARTIFACT_ROOT, 'dmm-stage3-functional.db');
const WORKING_DB = path.join(ARTIFACT_ROOT, 'enrichment-debug.db');

copyFileSync(FIXTURE_DB, WORKING_DB);

const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
const { CinemetaIdentityResolver } = await import('../src/lib/discovery/cinemeta-identity-resolver.js');
const { getStrongestReleaseAttributes } = await import('../src/lib/discovery/release-attributes.js');

const cache = createDiscoveryCache({ dbPath: WORKING_DB });
const resolver = new CinemetaIdentityResolver();

// Get first 5 unresolved candidates
const unresolved = cache.getUnresolvedCandidates({ limit: 5 });

console.log('=== Debugging Resolver Output ===\n');

for (const candidate of unresolved) {
  console.log(`\n--- Candidate: ${candidate.filename?.substring(0, 60)} ---`);
  
  const parsed = getStrongestReleaseAttributes(cache, candidate.infoHash, candidate.fileIndex);
  console.log(`Parsed: title="${parsed?.title}" year=${parsed?.year} S${parsed?.season}E${parsed?.episode}`);
  
  console.log(`canResolve: ${resolver.canResolve({ candidate, parsedAttributes: parsed })}`);
  
  try {
    const result = await resolver.resolveIdentity({ candidate, parsedAttributes: parsed });
    console.log(`Matches: ${result.matches.length}`);
    for (const match of result.matches) {
      console.log(`  - ${match.mediaId} (${match.mediaType}) confidence=${match.confidence.toFixed(2)} evidence=[${match.evidence.join(', ')}]`);
    }
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }
}

cache.close();
console.log('\nDebug complete.');
