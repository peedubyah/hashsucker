/**
 * Availability Checker Tests
 *
 * Tests for the provider availability observation subsystem.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { AvailabilityChecker, createAvailabilityChecker } from '../src/lib/intents/availability.js';

// =============================================================================
// Mock fetch for TorBox API
// =============================================================================

let mockFetch = null;
let originalFetch = globalThis.fetch;

function setupMockFetch(handler) {
  mockFetch = handler;
  globalThis.fetch = mockFetch;
}

function teardownMockFetch() {
  globalThis.fetch = originalFetch;
  mockFetch = null;
}

// =============================================================================
// Test: AvailabilityChecker requires cache instance
// =============================================================================

test('availability: requires cache instance', () => {
  assert.throws(
    () => new AvailabilityChecker(),
    /Cache instance is required/
  );
});

test('availability: accepts cache instance', () => {
  const cache = createDiscoveryCache();
  const checker = new AvailabilityChecker(cache, { apiKey: 'test' });
  assert.ok(checker);
  assert.equal(checker.apiKey, 'test');
  cache.close();
});

test('availability: uses env var for API key', () => {
  process.env.TORBOX_API_KEY = 'env-key';
  const cache = createDiscoveryCache();
  const checker = new AvailabilityChecker(cache);
  assert.equal(checker.apiKey, 'env-key');
  delete process.env.TORBOX_API_KEY;
  cache.close();
});

// =============================================================================
// Test: cached / uncached / unknown states
// =============================================================================

test('availability: checkAvailability returns cached state', async () => {
  let callCount = 0;
  setupMockFetch(async (url, options) => {
    callCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          'abcdef0123456789abcdef0123456789abcdef01': { name: 'Cached.Release', size: 1500000000 },
        },
      }),
    };
  });

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

    const result = await checker.checkAvailability(['abcdef0123456789abcdef0123456789abcdef01']);

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].state, 'cached');
    assert.equal(result.results[0].infoHash, 'abcdef0123456789abcdef0123456789abcdef01');
    assert.ok(result.results[0].fileMetadata);
    assert.equal(result.results[0].fileMetadata.name, 'Cached.Release');

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

test('availability: checkAvailability returns uncached state', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {},
    }),
  }));

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

    const result = await checker.checkAvailability(['abcdef0123456789abcdef0123456789abcdef01']);

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].state, 'uncached');

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

test('availability: checkAvailability returns unknown on error', async () => {
  setupMockFetch(async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
  }));

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

    const result = await checker.checkAvailability(['abcdef0123456789abcdef0123456789abcdef01']);

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].state, 'unknown');
    assert.equal(result.results[0].errorCategory, 'temporarily-unavailable');

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: batch checking
// =============================================================================

test('availability: checkAvailability batches hashes', async () => {
  let callCount = 0;
  setupMockFetch(async (url, options) => {
    callCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {},
      }),
    };
  });

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, {
      apiKey: 'test',
      batchSize: 2,
    });

    const hashes = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'cccccccccccccccccccccccccccccccccccccccc',
      'dddddddddddddddddddddddddddddddddddddddd',
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    ];

    const result = await checker.checkAvailability(hashes);

    assert.equal(result.results.length, 5);
    // 5 hashes with batchSize=2 = 3 batches
    assert.equal(result.batches, 3);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: freshness reuse
// =============================================================================

test('availability: fresh observations are reused', async () => {
  let callCount = 0;
  setupMockFetch(async (url, options) => {
    callCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          'abcdef0123456789abcdef0123456789abcdef01': { name: 'Cached.Release' },
        },
      }),
    };
  });

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, {
      apiKey: 'test',
      freshnessTtlMs: 300000,
    });

    const hash = 'abcdef0123456789abcdef0123456789abcdef01';

    // First check - should hit API
    const result1 = await checker.checkAvailability([hash]);
    assert.equal(callCount, 1);
    assert.equal(result1.results[0].state, 'cached');

    // Second check within TTL - should reuse
    const result2 = await checker.checkAvailability([hash]);
    assert.equal(callCount, 1); // No additional API call
    assert.equal(result2.results[0].state, 'cached');

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

test('availability: force recheck ignores freshness', async () => {
  let callCount = 0;
  setupMockFetch(async (url, options) => {
    callCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          'abcdef0123456789abcdef0123456789abcdef01': { name: 'Cached.Release' },
        },
      }),
    };
  });

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

    const hash = 'abcdef0123456789abcdef0123456789abcdef01';

    // First check
    await checker.checkAvailability([hash]);
    assert.equal(callCount, 1);

    // Force recheck
    await checker.checkAvailability([hash], { force: true });
    assert.equal(callCount, 2);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: provider error does not destroy previous observation
// =============================================================================

test('availability: provider error preserves previous observation', async () => {
  let shouldFail = false;
  setupMockFetch(async (url, options) => {
    if (shouldFail) {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          'abcdef0123456789abcdef0123456789abcdef01': { name: 'Cached.Release' },
        },
      }),
    };
  });

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, {
      apiKey: 'test',
      freshnessTtlMs: 1000, // Short TTL
    });

    const hash = 'abcdef0123456789abcdef0123456789abcdef01';

    // First check - cached
    const result1 = await checker.checkAvailability([hash]);
    assert.equal(result1.results[0].state, 'cached');

    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Second check with failure - should mark as unknown but preserve history
    shouldFail = true;
    const result2 = await checker.checkAvailability([hash]);
    assert.equal(result2.results[0].state, 'unknown');

    // History should have both observations
    const history = cache.getProviderObservationHistory(hash, null);
    assert.ok(history.length >= 2);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: file IDs preserved from TorBox response
// =============================================================================

test('availability: file metadata preserved from TorBox response', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        'abcdef0123456789abcdef0123456789abcdef01': {
          name: 'Some.Release.2024.720p',
          size: 1500000000,
          id: 12345,
        },
      },
    }),
  }));

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

    const result = await checker.checkAvailability(['abcdef0123456789abcdef0123456789abcdef01']);

    assert.ok(result.results[0].fileMetadata);
    assert.equal(result.results[0].fileMetadata.name, 'Some.Release.2024.720p');
    assert.equal(result.results[0].fileMetadata.size, 1500000000);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: rate limiting
// =============================================================================

test('availability: rate limiting tracks request timestamps', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {},
    }),
  }));

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, {
      apiKey: 'test',
      maxRequestsPerMinute: 60,
    });

    // Make multiple requests
    await checker.checkAvailability(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    await checker.checkAvailability(['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);

    // Check timestamps were recorded
    assert.ok(checker._requestTimestamps.length >= 2);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: getAvailability
// =============================================================================

test('availability: getAvailability returns current state', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        'abcdef0123456789abcdef0123456789abcdef01': { name: 'Cached.Release' },
      },
    }),
  }));

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

    const hash = 'abcdef0123456789abcdef0123456789abcdef01';

    // Check first
    await checker.checkAvailability([hash]);

    // Get availability
    const availability = checker.getAvailability(hash);
    assert.ok(availability);
    assert.equal(availability.provider, 'torbox');
    assert.equal(availability.state, 'cached');
    assert.ok(availability.ageMs >= 0);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

test('availability: getAvailability returns null for unknown hash', () => {
  const cache = createDiscoveryCache();
  const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

  const availability = checker.getAvailability('unknownhash');
  assert.equal(availability, null);

  cache.close();
});

// =============================================================================
// Test: getAvailabilityBatch
// =============================================================================

test('availability: getAvailabilityBatch returns multiple states', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': { name: 'Cached1' },
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': null,
      },
    }),
  }));

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

    const hashes = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ];

    await checker.checkAvailability(hashes);

    const availability = checker.getAvailabilityBatch(hashes);

    assert.equal(availability['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'].state, 'cached');
    assert.equal(availability['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'].state, 'uncached');

    // Check that unchecked hash returns null
    const unchecked = checker.getAvailability('cccccccccccccccccccccccccccccccccccccccc');
    assert.equal(unchecked, null);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: deduplication
// =============================================================================

test('availability: checkAvailability deduplicates hashes', async () => {
  let callCount = 0;
  setupMockFetch(async () => {
    callCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {},
      }),
    };
  });

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

    const hashes = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // duplicate
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // different case, same hash
    ];

    const result = await checker.checkAvailability(hashes);

    // Should only check 1 unique hash
    assert.equal(result.results.length, 1);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: checkCandidates from search result
// =============================================================================

test('availability: checkCandidates extracts hashes from search result', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': { name: 'Release1' },
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': { name: 'Release2' },
      },
    }),
  }));

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, { apiKey: 'test' });

    const searchResult = {
      results: [
        { infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', filename: 'Release1.mkv' },
        { infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', filename: 'Release2.mkv' },
      ],
    };

    const result = await checker.checkCandidates(searchResult);

    assert.equal(result.results.length, 2);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: concurrency
// =============================================================================

test('availability: concurrency limits parallel requests', async () => {
  let activeRequests = 0;
  let maxActiveRequests = 0;

  setupMockFetch(async (url, options) => {
    activeRequests++;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

    // Simulate slow response
    await new Promise(resolve => setTimeout(resolve, 50));

    activeRequests--;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {},
      }),
    };
  });

  try {
    const cache = createDiscoveryCache();
    const checker = createAvailabilityChecker(cache, {
      apiKey: 'test',
      batchSize: 1,
      concurrency: 2,
    });

    const hashes = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'cccccccccccccccccccccccccccccccccccccccc',
      'dddddddddddddddddddddddddddddddddddddddd',
    ];

    await checker.checkAvailability(hashes);

    // With concurrency=2, max active requests should be <= 2
    assert.ok(maxActiveRequests <= 2);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: media-request response exposes availability
// =============================================================================

test('availability: media-request response includes availability field', async () => {
  const cache = createDiscoveryCache();

  // Add candidate and associate with media
  const hash1 = 'aabbccddeeff00112233445566778899aabbccdd';
  cache.upsertCandidate({
    infoHash: hash1,
    fileIndex: null,
    filename: 'Test.Movie.2024.720p.mkv',
    title: 'Test Movie',
  });

  cache.associateMedia(hash1, null, 'tt0133093', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'confirmed',
  });

  // Record an observation
  cache.appendProviderObservation({
    provider: 'torbox',
    accountScope: 'default',
    scope: 'torrent',
    infoHash: hash1,
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: Date.now(),
    expiresAt: Date.now() + 300000,
    source: 'torbox-checkcached',
    evidence: { fileMetadata: { name: 'Test.Movie.2024.720p.mkv' } },
    latencyMs: 150,
  });

  // Import searchByMedia
  const { searchByMedia } = await import('../src/api/media-request.js');

  const result = await searchByMedia(cache, {
    mediaId: 'tt0133093',
    mediaType: 'movie',
  });

  assert.equal(result.results.length, 1);
  assert.ok(result.results[0].availability);
  assert.ok(result.results[0].availability.torbox);
  assert.equal(result.results[0].availability.torbox.state, 'cached');

  cache.close();
});

// =============================================================================
// Test: createAvailabilityChecker factory
// =============================================================================

test('availability: createAvailabilityChecker uses config', () => {
  const cache = createDiscoveryCache();
  const checker = createAvailabilityChecker(cache, {
    apiKey: 'custom-key',
    maxRequestsPerMinute: 60,
    batchSize: 5,
    concurrency: 3,
  });

  assert.equal(checker.apiKey, 'custom-key');
  assert.equal(checker.maxRequestsPerMinute, 60);
  assert.equal(checker.batchSize, 5);
  assert.equal(checker.concurrency, 3);

  cache.close();
});
