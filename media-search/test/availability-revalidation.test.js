/**
 * Availability Revalidation Tests
 *
 * Tests for the playback-time TorBox availability revalidation logic.
 * Covers all decision paths in the revalidation flow.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRevalidator,
  mapRevalidationToHttp,
  REVALIDATION_SOURCE,
  REVALIDATION_OUTCOME,
} from '../src/lib/resolver/availability-revalidation.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

/**
 * Create a mock cache with provider observations.
 */
function createMockCache(observations = []) {
  const storedObservations = [...observations];
  return {
    getProviderObservations: (infoHash, fileIndex, options = {}) => {
      let result = storedObservations.filter(
        (o) => o.infoHash === infoHash && o.fileIndex === fileIndex
      );
      if (!options.includeStale) {
        const now = options.now ?? Date.now();
        result = result.filter((o) => o.expiresAt == null || o.expiresAt > now);
      }
      if (options.kinds) {
        const kindsSet = new Set(options.kinds);
        result = result.filter((o) => kindsSet.has(o.kind));
      }
      return result;
    },
    appendProviderObservation: (obs) => {
      storedObservations.push(obs);
      return obs;
    },
    _storedObservations: storedObservations,
  };
}

/**
 * Create a mock TorBox cache check function.
 */
function createMockCheckTorBoxCached(result) {
  return async (hashes) => {
    const cached = new Set();
    const failed = new Set();
    const details = new Map();
    const latencyMs = new Map();

    for (const hash of hashes) {
      const normalized = hash.toLowerCase();
      if (result.cached?.has(normalized)) {
        cached.add(normalized);
        details.set(normalized, result.details?.get(normalized) || { size: 1000 });
      } else if (result.failed?.has(normalized)) {
        failed.add(normalized);
      }
      latencyMs.set(normalized, result.latencyMs ?? 150);
    }

    return { cached, failed, details, latencyMs };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test 1: Fresh cached observation → zero TorBox check → 307
// ═══════════════════════════════════════════════════════════════════════════════

test('fresh cached observation → zero TorBox check → 307', async () => {
  let checkCallCount = 0;
  const mockCheck = async (hashes) => {
    checkCallCount++;
    return createMockCheckTorBoxCached({ cached: new Set(hashes) })(hashes);
  };

  const now = 100_000;
  const cache = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - 60_000, // 1 minute ago
      expiresAt: now + 300_000, // 5 minutes from now
      source: 'test',
    },
  ]);

  const revalidator = createRevalidator({
    checkTorBoxCached: mockCheck,
    now: () => now,
    maxAgeMs: 5 * 60 * 1000, // 5 minutes
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.STORED_FRESH);
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.CACHED);
  assert.equal(result.providerCheckOccurred, false);
  assert.equal(result.previousObservationAge, 60_000);
  assert.equal(checkCallCount, 0, 'zero provider calls when observation is fresh');

  const httpOutcome = mapRevalidationToHttp(result);
  assert.equal(httpOutcome.status, 307);
  assert.equal(httpOutcome.shouldRedirect, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 2: Stale cached observation → one TorBox check → cached → 307
// ═══════════════════════════════════════════════════════════════════════════════

test('stale cached observation → one TorBox check → cached → 307', async () => {
  let checkCallCount = 0;
  const mockCheck = async (hashes) => {
    checkCallCount++;
    return createMockCheckTorBoxCached({
      cached: new Set([HASH]),
      details: new Map([[HASH, { size: 5_000_000 }]]),
    })(hashes);
  };

  const now = 1_000_000;
  const cache = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - 600_000, // 10 minutes ago (stale)
      expiresAt: now - 300_000, // expired 5 minutes ago
      source: 'test',
    },
  ]);

  const revalidator = createRevalidator({
    checkTorBoxCached: mockCheck,
    now: () => now,
    maxAgeMs: 5 * 60 * 1000, // 5 minutes
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.PLAYBACK_REVALIDATION);
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.CACHED);
  assert.equal(result.providerCheckOccurred, true);
  assert.equal(result.previousObservationAge, 600_000);
  assert.equal(checkCallCount, 1, 'exactly one provider call when observation is stale');
  assert.ok(result.checkLatencyMs > 0, 'check latency is recorded');

  // Observation was persisted
  const newObservations = cache._storedObservations.filter(
    (o) => o.source === 'playback-revalidation'
  );
  assert.equal(newObservations.length, 1);
  assert.equal(newObservations[0].state, 'cached');

  const httpOutcome = mapRevalidationToHttp(result);
  assert.equal(httpOutcome.status, 307);
  assert.equal(httpOutcome.shouldRedirect, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 3: Stale cached observation → one TorBox check → uncached → no redirect
// ═══════════════════════════════════════════════════════════════════════════════

test('stale cached observation → one TorBox check → uncached → no redirect', async () => {
  let checkCallCount = 0;
  const mockCheck = async (hashes) => {
    checkCallCount++;
    // Return uncached (not in cached set, not in failed set)
    return createMockCheckTorBoxCached({})(hashes);
  };

  const now = 1_000_000;
  const cache = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - 600_000, // stale
      expiresAt: now - 300_000,
      source: 'test',
    },
  ]);

  const revalidator = createRevalidator({
    checkTorBoxCached: mockCheck,
    now: () => now,
    maxAgeMs: 5 * 60 * 1000,
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.PLAYBACK_REVALIDATION);
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.UNCACHED);
  assert.equal(result.providerCheckOccurred, true);
  assert.equal(checkCallCount, 1);

  // Uncached observation was persisted
  const newObservations = cache._storedObservations.filter(
    (o) => o.source === 'playback-revalidation'
  );
  assert.equal(newObservations.length, 1);
  assert.equal(newObservations[0].state, 'uncached');

  const httpOutcome = mapRevalidationToHttp(result);
  assert.equal(httpOutcome.status, 409);
  assert.equal(httpOutcome.shouldRedirect, false);
  assert.equal(httpOutcome.body.code, 'PROVIDER_NOT_CACHED');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 4: Missing observation → one TorBox check
// ═══════════════════════════════════════════════════════════════════════════════

test('missing observation → one TorBox check', async () => {
  let checkCallCount = 0;
  const mockCheck = async (hashes) => {
    checkCallCount++;
    return createMockCheckTorBoxCached({
      cached: new Set([HASH]),
    })(hashes);
  };

  const now = 100_000;
  const cache = createMockCache(); // No observations

  const revalidator = createRevalidator({
    checkTorBoxCached: mockCheck,
    now: () => now,
    maxAgeMs: 5 * 60 * 1000,
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.PLAYBACK_REVALIDATION);
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.CACHED);
  assert.equal(result.providerCheckOccurred, true);
  assert.equal(result.previousObservationAge, null, 'no previous observation');
  assert.equal(checkCallCount, 1, 'one provider call when no observation exists');

  const httpOutcome = mapRevalidationToHttp(result);
  assert.equal(httpOutcome.status, 307);
  assert.equal(httpOutcome.shouldRedirect, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 5: Provider check error does not overwrite previous cached observation as uncached
// ═══════════════════════════════════════════════════════════════════════════════

test('provider check error does not overwrite previous cached observation as uncached', async () => {
  let checkCallCount = 0;
  const mockCheck = async (hashes) => {
    checkCallCount++;
    // Simulate a transient failure (network error, not auth)
    throw new Error('Network timeout');
  };

  const now = 1_000_000;
  const cache = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - 600_000, // stale
      expiresAt: now - 300_000,
      source: 'test',
    },
  ]);

  const revalidator = createRevalidator({
    checkTorBoxCached: mockCheck,
    now: () => now,
    maxAgeMs: 5 * 60 * 1000,
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.PLAYBACK_REVALIDATION);
  assert.equal(result.cacheState, REVALIDATION_OUTCOME.UNKNOWN);
  assert.equal(result.providerCheckOccurred, true);
  assert.equal(result.checkError, 'Network timeout');
  assert.equal(checkCallCount, 1);

  // New observation is 'unknown', NOT 'uncached'
  const newObservations = cache._storedObservations.filter(
    (o) => o.source === 'playback-revalidation'
  );
  assert.equal(newObservations.length, 1);
  assert.equal(newObservations[0].state, 'unknown');
  assert.equal(newObservations[0].errorCategory, 'temporarily-unavailable');

  // Original cached observation is preserved
  const originalObs = cache._storedObservations.find((o) => o.source === 'test');
  assert.equal(originalObs.state, 'cached');

  const httpOutcome = mapRevalidationToHttp(result);
  assert.equal(httpOutcome.status, 503);
  assert.equal(httpOutcome.shouldRedirect, false);
  assert.equal(httpOutcome.body.code, 'PROVIDER_CHECK_FAILED');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 6: Freshness boundary behaves deterministically
// ═══════════════════════════════════════════════════════════════════════════════

test('freshness boundary behaves deterministically', async () => {
  const now = 1_000_000;
  const maxAgeMs = 5 * 60 * 1000; // 5 minutes

  // Just under the boundary → fresh
  const cacheFresh = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - maxAgeMs + 1, // 1ms under boundary
      expiresAt: now + maxAgeMs,
      source: 'test',
    },
  ]);

  // Just over the boundary → stale
  const cacheStale = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - maxAgeMs - 1, // 1ms over boundary
      expiresAt: now - 1,
      source: 'test',
    },
  ]);

  let freshCheckCount = 0;
  let staleCheckCount = 0;

  const revalidatorFresh = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      freshCheckCount++;
      return createMockCheckTorBoxCached({})(hashes);
    },
    now: () => now,
    maxAgeMs,
  });

  const revalidatorStale = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      staleCheckCount++;
      return createMockCheckTorBoxCached({})(hashes);
    },
    now: () => now,
    maxAgeMs,
  });

  const freshResult = await revalidatorFresh.revalidateAvailability({
    cache: cacheFresh,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  const staleResult = await revalidatorStale.revalidateAvailability({
    cache: cacheStale,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  assert.equal(freshResult.availabilitySource, REVALIDATION_SOURCE.STORED_FRESH);
  assert.equal(freshCheckCount, 0, 'no check when just under boundary');

  assert.equal(staleResult.availabilitySource, REVALIDATION_SOURCE.PLAYBACK_REVALIDATION);
  assert.equal(staleCheckCount, 1, 'check when just over boundary');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 7: No media bytes are proxied
// ═══════════════════════════════════════════════════════════════════════════════

test('no media bytes are proxied — revalidation returns only decision metadata', async () => {
  const now = 100_000;
  const cache = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - 60_000,
      expiresAt: now + 300_000,
      source: 'test',
    },
  ]);

  const revalidator = createRevalidator({
    checkTorBoxCached: async () => ({ cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() }),
    now: () => now,
    maxAgeMs: 5 * 60 * 1000,
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  // Result contains only decision metadata, no media bytes
  assert.ok(!result.stream, 'no stream property');
  assert.ok(!result.bytes, 'no bytes property');
  assert.ok(!result.mediaData, 'no mediaData property');
  assert.ok(!result.content, 'no content property');

  // HTTP outcome for redirect has no body
  const httpOutcome = mapRevalidationToHttp(result);
  assert.equal(httpOutcome.body, null, '307 response has no body');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 8: Provider check with failed hash (transient failure)
// ═══════════════════════════════════════════════════════════════════════════════

test('provider check with failed hash returns unknown, not uncached', async () => {
  const now = 100_000;
  const cache = createMockCache();

  const mockCheck = async (hashes) => {
    return createMockCheckTorBoxCached({
      failed: new Set([HASH]), // Hash explicitly failed
    })(hashes);
  };

  const revalidator = createRevalidator({
    checkTorBoxCached: mockCheck,
    now: () => now,
    maxAgeMs: 5 * 60 * 1000,
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  assert.equal(result.cacheState, REVALIDATION_OUTCOME.UNKNOWN);
  assert.equal(result.observation.state, 'unknown');
  assert.equal(result.observation.errorCategory, 'temporarily-unavailable');
  assert.equal(result.observation.retryable, true);

  const httpOutcome = mapRevalidationToHttp(result);
  assert.equal(httpOutcome.status, 503);
  assert.equal(httpOutcome.shouldRedirect, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 9: Telemetry fields are complete
// ═══════════════════════════════════════════════════════════════════════════════

test('telemetry fields are complete for stored-fresh path', async () => {
  const now = 1_000_000;
  const cache = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - 120_000,
      expiresAt: now + 180_000,
      source: 'test',
    },
  ]);

  const revalidator = createRevalidator({
    checkTorBoxCached: async () => ({ cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() }),
    now: () => now,
    maxAgeMs: 5 * 60 * 1000,
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  // All telemetry fields present
  assert.equal(result.mediaId, 'tt1234567');
  assert.equal(result.releaseKey, `${HASH}:torrent`);
  assert.equal(result.infoHash, HASH);
  assert.equal(result.provider, 'torbox');
  assert.equal(result.previousObservationAge, 120_000);
  assert.equal(result.providerCheckOccurred, false);
  assert.equal(result.checkLatencyMs, null);
  assert.ok(result.observation);
});

test('telemetry fields are complete for playback-revalidation path', async () => {
  const now = 100_000;
  const cache = createMockCache();

  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => createMockCheckTorBoxCached({
      cached: new Set([HASH]),
      details: new Map([[HASH, { size: 1000 }]]),
      latencyMs: 250,
    })(hashes),
    now: () => now,
    maxAgeMs: 5 * 60 * 1000,
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  // All telemetry fields present
  assert.equal(result.mediaId, 'tt1234567');
  assert.equal(result.releaseKey, `${HASH}:torrent`);
  assert.equal(result.infoHash, HASH);
  assert.equal(result.provider, 'torbox');
  assert.equal(result.previousObservationAge, null);
  assert.equal(result.providerCheckOccurred, true);
  assert.equal(result.checkLatencyMs, 250);
  assert.ok(result.observation);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 10: Revalidator requires checkTorBoxCached function
// ═══════════════════════════════════════════════════════════════════════════════

test('revalidator requires checkTorBoxCached function', () => {
  assert.throws(
    () => createRevalidator({}),
    (err) => err instanceof TypeError && /checkTorBoxCached/.test(err.message)
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 11: Multiple observations — uses most recent
// ═══════════════════════════════════════════════════════════════════════════════

test('multiple observations — uses most recent authoritative TorBox', async () => {
  const now = 100_000;
  const cache = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - 300_000, // older
      expiresAt: now,
      source: 'test',
    },
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'authoritative',
      state: 'cached',
      observedAt: now - 60_000, // newer, fresh
      expiresAt: now + 300_000,
      source: 'test',
    },
  ]);

  let checkCallCount = 0;
  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      checkCallCount++;
      return createMockCheckTorBoxCached({})(hashes);
    },
    now: () => now,
    maxAgeMs: 5 * 60 * 1000,
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.STORED_FRESH);
  assert.equal(result.providerCheckOccurred, false);
  assert.equal(checkCallCount, 0, 'uses most recent observation, no check needed');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 12: Non-authoritative observations are ignored
// ═══════════════════════════════════════════════════════════════════════════════

test('non-authoritative observations are ignored', async () => {
  const now = 100_000;
  const cache = createMockCache([
    {
      provider: 'torbox',
      infoHash: HASH,
      fileIndex: null,
      kind: 'predicted', // Not authoritative
      state: 'cached',
      observedAt: now - 60_000,
      expiresAt: now + 300_000,
      source: 'test',
    },
  ]);

  let checkCallCount = 0;
  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      checkCallCount++;
      return createMockCheckTorBoxCached({ cached: new Set([HASH]) })(hashes);
    },
    now: () => now,
    maxAgeMs: 5 * 60 * 1000,
  });

  const result = await revalidator.revalidateAvailability({
    cache,
    infoHash: HASH,
    mediaId: 'tt1234567',
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
  });

  assert.equal(result.availabilitySource, REVALIDATION_SOURCE.PLAYBACK_REVALIDATION);
  assert.equal(result.providerCheckOccurred, true);
  assert.equal(checkCallCount, 1, 'ignores predicted observations, performs check');
});
