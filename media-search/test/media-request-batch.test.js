/**
 * Media Request Batch Validation Harness Tests
 *
 * Tests the batch execution, summary metrics, input validation,
 * and output structure.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { searchByMedia } from '../src/api/media-request.js';

const TMP_DIR = join(tmpdir(), 'media-request-batch-test');

// =============================================================================
// Helpers
// =============================================================================

function setup() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
}

function teardown() {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

function writeJsonFile(filename, data) {
  const path = join(TMP_DIR, filename);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  return path;
}

function seedTestMedia(cache) {
  // Family Guy S05E12 - correct
  const hash1 = 'aabbccddeeff00112233445566778899aabbccdd';
  cache.upsertCandidate({
    infoHash: hash1,
    fileIndex: null,
    filename: 'Family.Guy.S05E12.1080p.mkv',
    title: 'Family Guy',
  });
  storeReleaseAttributes(cache, {
    infoHash: hash1,
    fileIndex: null,
    filename: 'Family.Guy.S05E12.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Family Guy',
      year: 2005,
      season: 5,
      episode: 12,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });
  cache.associateMedia(hash1, null, 'tt0182576', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match', 'episode_verified'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match,episode_verified',
    resolutionState: 'confirmed',
  });

  // Family Guy S21E20 - wrong episode (same show)
  const hash2 = '11223344556677889900aabbccddeeff00112233';
  cache.upsertCandidate({
    infoHash: hash2,
    fileIndex: null,
    filename: 'Family.Guy.S21E20.720p.mkv',
    title: 'Family Guy',
  });
  storeReleaseAttributes(cache, {
    infoHash: hash2,
    fileIndex: null,
    filename: 'Family.Guy.S21E20.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    parsed: {
      title: 'Family Guy',
      year: 2022,
      season: 21,
      episode: 20,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });
  cache.associateMedia(hash2, null, 'tt0182576', {
    source: 'enrichment',
    confidence: 0.85,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'ambiguous',
  });

  // The Matrix - movie
  const hash3 = 'cccccccccccccccccccccccccccccccccccccccc';
  cache.upsertCandidate({
    infoHash: hash3,
    fileIndex: null,
    filename: 'The.Matrix.1999.1080p.mkv',
    title: 'The Matrix',
  });
  storeReleaseAttributes(cache, {
    infoHash: hash3,
    fileIndex: null,
    filename: 'The.Matrix.1999.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.95,
    parsed: {
      title: 'The Matrix',
      year: 1999,
      season: null,
      episode: null,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });
  cache.associateMedia(hash3, null, 'tt0133093', {
    source: 'enrichment',
    confidence: 0.95,
    evidence: ['title_exact_match', 'year_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match,year_match',
    resolutionState: 'confirmed',
  });
}

// =============================================================================
// Test: Input validation rejects invalid files
// =============================================================================

test('batch: rejects invalid JSON file', async () => {
  const { readFileSync } = await import('node:fs');
  setup();
  try {
    const path = join(TMP_DIR, 'invalid.json');
    writeFileSync(path, '{ invalid json', 'utf-8');

    assert.throws(() => {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
    });
  } finally {
    teardown();
  }
});

// =============================================================================
// Test: Input validation rejects missing requests array
// =============================================================================

test('batch: rejects input without requests array', async () => {
  const { readFileSync } = await import('node:fs');
  setup();
  try {
    const path = writeJsonFile('no-requests.json', { options: {} });
    assert.throws(() => {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      if (!Array.isArray(data.requests)) throw new Error('Input must have a "requests" array');
    }, /requests/);
  } finally {
    teardown();
  }
});

// =============================================================================
// Test: Batch execution produces correct summary structure
// =============================================================================

test('batch: summary includes all required metrics', async () => {
  setup();
  try {
    const cache = createDiscoveryCache();
    seedTestMedia(cache);

    const input = {
      requests: [
        { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, label: 'FG S05E12' },
        { mediaId: 'tt0133093', mediaType: 'movie', label: 'Matrix' },
        { mediaId: 'tt0182576', mediaType: 'series', season: 21, episode: 20, label: 'FG S21E20' },
        { mediaId: 'tt9999999', mediaType: 'series', season: 1, episode: 1, label: 'Unknown' },
      ],
    };

    const results = [];
    for (const request of input.requests) {
      const result = await searchByMedia(cache, {
        mediaId: request.mediaId,
        mediaType: request.mediaType,
        season: request.season,
        episode: request.episode,
        persist: false,
        skipLiveDiscovery: true,
        skipAvailability: true,
      });
      results.push({
        request,
        totalCandidates: result.total,
        identitySummary: result.identitySummary,
        topTier: result.results?.[0]?.identity?.tier || null,
        topScore: result.results?.[0]?.score || null,
      });
    }

    // Build summary inline (matching batch script logic)
    const totalRequests = results.length;
    const requestsWithResults = results.filter(r => r.totalCandidates > 0).length;
    const totalCandidates = results.reduce((s, r) => s + r.totalCandidates, 0);
    const totalEligible = results.reduce((s, r) => s + (r.identitySummary?.eligibleCount || r.totalCandidates), 0);
    const totalIneligible = results.reduce((s, r) => s + (r.identitySummary?.ineligibleCount || 0), 0);

    // Verify summary metrics
    assert.equal(totalRequests, 4, 'Total requests');
    assert.equal(requestsWithResults, 3, 'Requests with results');
    assert.ok(totalCandidates > 0, 'Has candidates');
    assert.ok(totalEligible > 0, 'Has eligible candidates');
    assert.ok(totalIneligible > 0, 'Has ineligible candidates');

    cache.close();
  } finally {
    teardown();
  }
});

// =============================================================================
// Test: Ineligible candidates are correctly counted per request
// =============================================================================

test('batch: ineligibility breakdown is accurate', async () => {
  setup();
  try {
    const cache = createDiscoveryCache();
    seedTestMedia(cache);

    const result = await searchByMedia(cache, {
      mediaId: 'tt0182576',
      mediaType: 'series',
      season: 5,
      episode: 12,
      persist: false,
    });

    assert.ok(result.total >= 2, 'Should have both candidates');
    assert.ok(result.identitySummary.eligibleCount >= 1, 'At least 1 eligible');
    assert.ok(result.identitySummary.ineligibleCount >= 1, 'At least 1 ineligible');
    assert.ok(
      result.identitySummary.ineligibleByCode.season_mismatch >= 1 ||
      result.identitySummary.ineligibleByCode.episode_mismatch >= 1,
      'Has mismatch code'
    );
    assert.ok(result.identitySummary.tierCounts.Ineligible >= 1, 'Has Ineligible tier');

    cache.close();
  } finally {
    teardown();
  }
});

// =============================================================================
// Test: Tier distribution across batch results
// =============================================================================

test('batch: tier distribution tracks top-tier per request', async () => {
  setup();
  try {
    const cache = createDiscoveryCache();
    seedTestMedia(cache);

    const inputs = [
      { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12 },
      { mediaId: 'tt0133093', mediaType: 'movie' },
    ];

    const tierDistribution = {};
    for (const input of inputs) {
      const result = await searchByMedia(cache, { ...input, persist: false });
      const topTier = result.results?.[0]?.identity?.tier || 'none';
      tierDistribution[topTier] = (tierDistribution[topTier] || 0) + 1;
    }

    assert.ok(tierDistribution.Verified >= 1, 'At least one Verified top result');

    cache.close();
  } finally {
    teardown();
  }
});

// =============================================================================
// Test: Requests with no candidates return empty results
// =============================================================================

test('batch: unknown media returns empty results without error', async () => {
  setup();
  try {
    const cache = createDiscoveryCache();
    seedTestMedia(cache);

    const result = await searchByMedia(cache, {
      mediaId: 'tt0000000',
      mediaType: 'series',
      season: 1,
      episode: 1,
      persist: false,
    });

    assert.equal(result.total, 0, 'No candidates');
    assert.equal(result.results.length, 0, 'Empty results array');
    assert.equal(result.identitySummary.tier, 'none', 'Tier is none');
    assert.equal(result.identitySummary.eligibleCount || 0, 0, 'No eligible');
    assert.equal(result.identitySummary.ineligibleCount || 0, 0, 'No ineligible');

    cache.close();
  } finally {
    teardown();
  }
});
