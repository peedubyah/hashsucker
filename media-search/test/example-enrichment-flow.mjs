/**
 * Example: Identity Enrichment Flow
 *
 * Demonstrates the complete pipeline:
 *   candidate
 *     |
 *     v
 *   identity queue
 *     |
 *     v
 *   resolver
 *     |
 *     v
 *   candidate_media association
 *     |
 *     v
 *   future ranking improvement
 */

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { runIdentityEnrichmentWorker } from '../src/lib/discovery/identity-enrichment-worker.js';
import { BaseIdentityResolver } from '../src/lib/discovery/identity-resolver.js';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

console.log('=== Identity Enrichment Flow Demo ===\n');

// Step 1: Create cache and ingest a candidate
console.log('1. Ingest candidate');
const cache = createDiscoveryCache();

cache.upsertCandidate({
  infoHash: HASH,
  fileIndex: null,
  filename: 'Breaking.Bad.S05E14.Felina.1080p.BluRay.x264-TEST.mkv',
  title: 'Breaking Bad S05E14 Felina',
});

console.log(`   Candidate ingested: ${HASH.slice(0, 8)}...`);

// Step 2: Parse filename into release attributes (done by attribute worker)
console.log('\n2. Parse filename into release attributes');
storeReleaseAttributes(cache, {
  infoHash: HASH,
  fileIndex: null,
  filename: 'Breaking.Bad.S05E14.Felina.1080p.BluRay.x264-TEST.mkv',
  source: 'ptn-regex',
  confidence: 0.9,
  parsed: {
    title: 'Breaking Bad',
    year: 2013,
    season: 5,
    episode: 14,
    episodeRange: null,
    resolution: '1080p',
    sourceType: 'BluRay',
    codec: 'x264',
    hdr: false,
    audio: 'DTS',
    language: 'en',
    releaseGroup: 'TEST',
  },
  evidence: ['title_extracted', 'season_episode_extracted', 'resolution_extracted'],
});

console.log('   Release attributes stored');

// Step 3: Check current state (no media associations yet)
console.log('\n3. Check current state (no media associations yet)');
const initialAssociations = cache.getMediaAssociations(HASH, null);
console.log(`   Media associations: ${initialAssociations.length}`);

// Step 4: Enqueue for identity resolution
console.log('\n4. Enqueue for identity resolution');
cache.enqueueIdentityResolution(HASH, null, { maxAttempts: 3, resolverSource: 'cinemeta' });
console.log('   Candidate enqueued for enrichment');

// Step 5: Show queue stats
console.log('\n5. Queue statistics');
const stats = cache.getEnrichmentStats();
console.log(`   Pending: ${stats.pending}, Processing: ${stats.processing}, Resolved: ${stats.resolved}, Failed: ${stats.failed}`);

// Step 6: Run identity enrichment worker
console.log('\n6. Run identity enrichment worker');

// Create a mock resolver that simulates external API call
class MockCinemetaResolver extends BaseIdentityResolver {
  constructor() {
    super({ sourceName: 'cinemeta', version: '3.0.0' });
  }

  async resolveIdentity({ candidate, parsedAttributes }) {
    // Simulate API call to Cinemeta
    console.log(`   [Cinemeta] Searching for: "${parsedAttributes.title}" (${parsedAttributes.year})`);

    // Simulate finding a match
    if (parsedAttributes.title === 'Breaking Bad' && parsedAttributes.season === 5) {
      return {
        matches: [
          {
            mediaId: 'tt0903747',
            mediaType: 'series',
            confidence: 0.95,
            evidence: ['title_exact_match', 'year_match', 'season_episode_match'],
          },
        ],
      };
    }

    return { matches: [] };
  }
}

const workerStats = await runIdentityEnrichmentWorker(cache, {
  resolver: new MockCinemetaResolver(),
  limit: 10,
  onProgress: (item, result) => {
    console.log(`   [Worker] Processed ${item.infoHash.slice(0, 8)}...: ${result.matches.length} matches found`);
  },
});

console.log(`\n   Worker stats: processed=${workerStats.processed}, resolved=${workerStats.resolved}, failed=${workerStats.failed}`);

// Step 7: Verify results
console.log('\n7. Verify results');
const finalAssociations = cache.getMediaAssociations(HASH, null);
console.log(`   Media associations: ${finalAssociations.length}`);

if (finalAssociations.length > 0) {
  const assoc = finalAssociations[0];
  console.log(`   - mediaId: ${assoc.mediaId}`);
  console.log(`   - confidence: ${assoc.confidence}`);
  console.log(`   - source: ${assoc.source}`);
  console.log(`   - resolverSource: ${assoc.resolverSource}`);
  console.log(`   - resolverVersion: ${assoc.resolverVersion}`);
  console.log(`   - evidence: ${JSON.stringify(assoc.evidence)}`);
}

// Step 8: Show updated queue stats
console.log('\n8. Updated queue statistics');
const finalStats = cache.getEnrichmentStats();
console.log(`   Pending: ${finalStats.pending}, Processing: ${finalStats.processing}, Resolved: ${finalStats.resolved}, Failed: ${finalStats.failed}`);

// Step 9: Show how this improves future ranking
console.log('\n9. Future ranking impact');
console.log('   With candidate_media associations now populated:');
console.log('   - Identity tier classification can use Verified/ProviderConfirmed');
console.log('   - identityConfidence component will contribute to composite score');
console.log('   - Better ranking between corpus and live discovery results');

cache.close();

console.log('\n=== Enrichment Flow Complete ===');
