#!/usr/bin/env node
/**
 * Validate playback handoff against real Family Guy S05E12 case.
 */

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { searchByMedia } from '../src/api/media-request.js';

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';

async function validate() {
  const cache = createDiscoveryCache(DB_PATH !== ':memory:' ? { dbPath: DB_PATH } : {});

  const startedAt = Date.now();

  // Request Family Guy S05E12
  const request = {
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    mediaTitle: 'Family Guy',
    persist: true,
  };

  console.log('=== PLAYBACK HANDOFF VALIDATION ===\n');
  console.log(`Request: ${request.mediaId} S${String(request.season).padStart(2, '0')}E${String(request.episode).padStart(2, '0')}\n`);

  const result = await searchByMedia(cache, request);
  const duration = Date.now() - startedAt;

  console.log(`Search completed in ${duration}ms`);
  console.log(`Total candidates: ${result.total}`);
  console.log(`Eligible: ${result.identitySummary.eligibleCount}`);
  console.log(`Selection: ${result.selection.reason}`);

  if (result.selection.selected) {
    console.log(`Selected: rank=${result.selection.selected.rank}, filename=${result.selection.selected.filename}`);
  }

  console.log('\n--- HANDOFF ---');
  console.log(JSON.stringify(result.handoff, null, 2));

  // Verify handoff structure
  if (result.handoff) {
    console.log('\n--- HANDOFF VERIFICATION ---');
    console.log(`requestId present: ${!!result.handoff.requestId}`);
    console.log(`mediaId match: ${result.handoff.mediaId === request.mediaId}`);
    console.log(`releaseKey format: ${result.handoff.releaseKey}`);
    console.log(`provider: ${result.handoff.provider}`);
    console.log(`providerState: ${result.handoff.providerState}`);
    console.log(`identityTier: ${result.handoff.identityTier}`);
    console.log(`selectionReason: ${result.handoff.selectionReason}`);
    console.log(`selectedAt timestamp: ${result.handoff.selectedAt}`);
  }

  // Test retrieval
  if (result.handoff && result.handoff.requestId) {
    const retrieved = cache.getPlaybackHandoffByRequestId(result.handoff.requestId);
    console.log('\n--- PERSISTENCE VERIFICATION ---');
    console.log(`Persisted handoff found: ${!!retrieved}`);
    if (retrieved) {
      console.log(`Retrieved infoHash: ${retrieved.info_hash}`);
      console.log(`Retrieved releaseKey: ${retrieved.release_key}`);
    }
  }

  // Print required validation output
  console.log('\n--- REQUIRED VALIDATION OUTPUT ---');
  console.log(`media request ID: ${result.requestId}`);
  console.log(`handoff request ID: ${result.handoff?.requestId ?? 'MISSING'}`);
  console.log(`persisted handoff ID: ${result.handoff?.requestId ? cache.getPlaybackHandoffByRequestId(result.handoff.requestId)?.id : 'N/A'}`);
  console.log(`releaseKey: ${result.handoff?.releaseKey ?? 'N/A'}`);
  console.log(`provider: ${result.handoff?.provider ?? 'N/A'}`);

  // Verify agreement
  if (result.requestId && result.handoff && result.requestId === result.handoff.requestId) {
    console.log('\n✓ IDs AGREE');
  } else {
    console.log('\n✗ IDs DO NOT AGREE');
    process.exit(1);
  }
}

validate().catch(console.error);
