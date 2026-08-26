/**
 * Alternate Candidate Fallback Integration Tests
 *
 * Tests for the full HTTP stream resolver with alternate candidate fallback.
 * Verifies that when the primary candidate is unavailable, the resolver
 * falls back to the next persisted eligible candidate without running
 * discovery or changing ranking.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createLifecycleEventStore } from '../src/lib/operator/event-store.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createRequestHandler } from '../src/server/app.js';
import { createRevalidator, REVALIDATION_OUTCOME } from '../src/lib/resolver/availability-revalidation.js';
import { createResolverTelemetry, getRecentResolverTelemetry, RESOLVER_OUTCOME } from '../src/lib/resolver/telemetry.js';

const HASH1 = 'abcdef0123456789abcdef0123456789abcdef01';
const HASH2 = 'abcdef0123456789abcdef0123456789abcdef02';
const HASH3 = 'abcdef0123456789abcdef0123456789abcdef03';

/**
 * Helper: Create a mock request and response for testing.
 */
function createMockRequest(url) {
  const input = Readable.from([]);
  input.method = 'GET';
  input.url = url;
  return input;
}

function createMockResponse() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    return res;
  });
}

/**
 * Helper: Setup cache with multiple candidates.
 */
function setupCacheWithCandidates({ mediaId, primaryHash, additionalCandidates, primaryObservationState }) {
  const cache = createDiscoveryCache();
  const now = Date.now();

  // Persist media request
  const results = [
    { infoHash: primaryHash, fileIndex: null, filename: 'Movie.mkv', score: 0.85, rank: 1, release: { infoHash: primaryHash, fileIndex: null, releaseKey: `${primaryHash}:torrent` } },
    ...additionalCandidates.map((c, i) => ({
      infoHash: c.infoHash,
      fileIndex: c.fileIndex ?? null,
      filename: c.filename || `Movie${i + 2}.mkv`,
      score: c.score ?? 0.8 - (i * 0.1),
      rank: i + 2,
      release: { infoHash: c.infoHash, fileIndex: c.fileIndex ?? null, releaseKey: c.fileIndex === null ? `${c.infoHash}:torrent` : `${c.infoHash}:${c.fileIndex}` },
    })),
  ];

  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null, source: 'test' },
    results,
  );

  // Persist playback handoff (pointing to primary)
  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${primaryHash}:torrent`, infoHash: primaryHash, fileIndex: null,
    filename: 'Movie.mkv', provider: 'torbox', providerState: 'cached',
    identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: now,
  });

  // Add provider observations for all candidates
  // Primary
  cache.appendProviderObservation({
    provider: 'torbox', accountScope: 'primary', scope: 'candidate',
    infoHash: primaryHash, fileIndex: null, state: primaryObservationState, kind: 'authoritative',
    observedAt: now - 60_000, expiresAt: now + 300_000, source: 'test',
  });

  // Additional candidates
  for (const c of additionalCandidates) {
    cache.appendProviderObservation({
      provider: 'torbox', accountScope: 'primary', scope: 'candidate',
      infoHash: c.infoHash, fileIndex: c.fileIndex ?? null, state: c.observationState || 'cached', kind: 'authoritative',
      observedAt: now - 60_000, expiresAt: now + 300_000, source: 'test',
    });
  }

  return { cache, requestId, now };
}

/**
 * Helper: Setup control plane with placements for all candidates.
 */
function setupControlPlaneWithPlacements(controlPlane, hashes) {
  const placements = {};
  for (const hash of hashes) {
    const placement = controlPlane.recordPlacement({
      provider: 'torbox', accountScope: 'primary', infoHash: hash,
      providerResourceId: `torrent_${hash}`, state: 'ready', ownership: 'owned', provenance: 'test',
    });
    placements[hash] = placement;

    controlPlane.replaceProviderFileInventory(placement.id, [{
      providerFileId: `file_${hash}`, path: '/movie.mkv', name: 'movie.mkv', size: 1000000, selected: true,
    }], { authoritative: true, complete: true });

    controlPlane.recordFileMapping({
      infoHash: hash, fileIndex: null, fileIndexKey: -1, releaseKey: `${hash}:torrent`,
      placementId: placement.id, providerFileId: `file_${hash}`, state: 'mapped', method: 'test', authoritative: true,
    });
  }
  return placements;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Test 1: Primary cached → no fallback (existing behavior)
// ═══════════════════════════════════════════════════════════════════════════════

test('integration: primary cached → no fallback (existing behavior)', async () => {
  const mediaId = 'tt_fallback_primary_cached';
  const eventStore = createLifecycleEventStore();
  const controlPlane = createControlPlaneStore();

  const { cache, now } = setupCacheWithCandidates({
    mediaId,
    primaryHash: HASH1,
    additionalCandidates: [{ infoHash: HASH2 }],
    primaryObservationState: 'cached',
  });

  setupControlPlaneWithPlacements(controlPlane, [HASH1, HASH2]);

  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => ({ cached: new Set(hashes), failed: new Set(), details: new Map(), latencyMs: new Map() }),
    now: () => now + 60_000,
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore,
    revalidator,
  });

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(createMockRequest(`/stream/movie/${mediaId}`), res).catch(reject);
  });

  assert.equal(response.status, 307);
  assert.equal(response.headers['x-fallback-used'], undefined);

  // Verify telemetry shows normal redirect (no fallback)
  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'redirected');
  assert.equal(records[0].fallbackUsed, undefined);

  cache.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Test 2: Primary uncached → fallback to rank #2 cached
// ═══════════════════════════════════════════════════════════════════════════════

test('integration: primary uncached → fallback to rank #2 cached', async () => {
  const mediaId = 'tt_fallback_uncached';
  const eventStore = createLifecycleEventStore();
  const controlPlane = createControlPlaneStore();

  const { cache, now } = setupCacheWithCandidates({
    mediaId,
    primaryHash: HASH1,
    additionalCandidates: [{ infoHash: HASH2, observationState: 'cached' }],
    primaryObservationState: 'uncached',
  });

  setupControlPlaneWithPlacements(controlPlane, [HASH1, HASH2]);

  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      // Primary is uncached, secondary is cached
      const cached = new Set();
      const failed = new Set();
      for (const h of hashes) {
        if (h === HASH1) {
          // uncached
        } else {
          cached.add(h);
        }
      }
      return { cached, failed, details: new Map(), latencyMs: new Map() };
    },
    now: () => now + 60_000,
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore,
    revalidator,
  });

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(createMockRequest(`/stream/movie/${mediaId}`), res).catch(reject);
  });

  assert.equal(response.status, 307);
  assert.equal(response.headers['x-fallback-used'], 'true');
  assert.equal(response.headers['x-fallback-rank'], '2');
  assert.equal(response.headers['x-fallback-original-release-key'], `${HASH1}:torrent`);
  assert.equal(response.headers['x-fallback-selected-release-key'], `${HASH2}:torrent`);

  // Verify telemetry shows fallback was used
  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'redirected');
  assert.equal(records[0].fallbackUsed, true);
  assert.equal(records[0].originalReleaseKey, `${HASH1}:torrent`);
  assert.equal(records[0].selectedReleaseKey, `${HASH2}:torrent`);
  assert.equal(records[0].fallbackRank, 2);

  cache.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Test 3: Primary provider check fails → fallback to rank #2
// ═══════════════════════════════════════════════════════════════════════════════

test('integration: primary provider check fails → fallback to rank #2', async () => {
  const mediaId = 'tt_fallback_check_fail';
  const eventStore = createLifecycleEventStore();
  const controlPlane = createControlPlaneStore();

  const { cache, now } = setupCacheWithCandidates({
    mediaId,
    primaryHash: HASH1,
    additionalCandidates: [{ infoHash: HASH2, observationState: 'cached' }],
    primaryObservationState: 'cached', // Fresh observation exists but check will fail
  });

  setupControlPlaneWithPlacements(controlPlane, [HASH1, HASH2]);

  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      // Primary check fails, secondary succeeds
      const cached = new Set();
      const failed = new Set();
      for (const h of hashes) {
        if (h === HASH1) {
          failed.add(h);
        } else {
          cached.add(h);
        }
      }
      return { cached, failed, details: new Map(), latencyMs: new Map() };
    },
    now: () => now + 600_000, // Force stale
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore,
    revalidator,
  });

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(createMockRequest(`/stream/movie/${mediaId}`), res).catch(reject);
  });

  assert.equal(response.status, 307);
  assert.equal(response.headers['x-fallback-used'], 'true');

  // Verify telemetry shows fallback was used with provider error reason
  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0].fallbackUsed, true);
  assert.ok(records[0].reason.includes('provider check failed') || records[0].reason.includes('primary unavailable'));

  cache.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Test 4: Rank #2 ineligible → skipped, rank #3 used
// ═══════════════════════════════════════════════════════════════════════════════

test('integration: rank #2 ineligible → skipped, rank #3 used', async () => {
  const mediaId = 'tt_fallback_ineligible';
  const eventStore = createLifecycleEventStore();
  const controlPlane = createControlPlaneStore();

  const cache = createDiscoveryCache();
  const now = Date.now();

  // Manually persist results with ineligible rank #2
  const results = [
    { infoHash: HASH1, fileIndex: null, filename: 'Movie.mkv', score: 0.85, rank: 1, release: { infoHash: HASH1, fileIndex: null, releaseKey: `${HASH1}:torrent` } },
    { infoHash: HASH2, fileIndex: null, filename: 'Movie2.mkv', score: 0.8, rank: 2, release: { infoHash: HASH2, fileIndex: null, releaseKey: `${HASH2}:torrent` } },
    { infoHash: HASH3, fileIndex: null, filename: 'Movie3.mkv', score: 0.75, rank: 3, release: { infoHash: HASH3, fileIndex: null, releaseKey: `${HASH3}:torrent` } },
  ];

  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null, source: 'test' },
    results,
  );

  // Mark rank #2 as ineligible (update the result)
  cache.db.prepare("UPDATE media_request_results SET eligible = 0, ineligible_reason = 'test', ineligible_code = 'test' WHERE request_id = ? AND rank = 2").run(requestId);

  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${HASH1}:torrent`, infoHash: HASH1, fileIndex: null,
    filename: 'Movie.mkv', provider: 'torbox', providerState: 'cached',
    identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: now,
  });

  // Primary uncached, rank #2 ineligible, rank #3 cached
  cache.appendProviderObservation({
    provider: 'torbox', accountScope: 'primary', scope: 'candidate',
    infoHash: HASH1, fileIndex: null, state: 'uncached', kind: 'authoritative',
    observedAt: now - 60_000, expiresAt: now + 300_000, source: 'test',
  });
  cache.appendProviderObservation({
    provider: 'torbox', accountScope: 'primary', scope: 'candidate',
    infoHash: HASH2, fileIndex: null, state: 'cached', kind: 'authoritative',
    observedAt: now - 60_000, expiresAt: now + 300_000, source: 'test',
  });
  cache.appendProviderObservation({
    provider: 'torbox', accountScope: 'primary', scope: 'candidate',
    infoHash: HASH3, fileIndex: null, state: 'cached', kind: 'authoritative',
    observedAt: now - 60_000, expiresAt: now + 300_000, source: 'test',
  });

  setupControlPlaneWithPlacements(controlPlane, [HASH1, HASH2, HASH3]);

  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      const cached = new Set();
      const failed = new Set();
      for (const h of hashes) {
        if (h === HASH1) {
          // uncached
        } else {
          cached.add(h);
        }
      }
      return { cached, failed, details: new Map(), latencyMs: new Map() };
    },
    now: () => now + 60_000,
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore,
    revalidator,
  });

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(createMockRequest(`/stream/movie/${mediaId}`), res).catch(reject);
  });

  assert.equal(response.status, 307);
  assert.equal(response.headers['x-fallback-used'], 'true');
  assert.equal(response.headers['x-fallback-rank'], '3');

  cache.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Test 5: All alternates unavailable → typed failure
// ═══════════════════════════════════════════════════════════════════════════════

test('integration: all alternates unavailable → typed failure', async () => {
  const mediaId = 'tt_fallback_all_unavailable';
  const eventStore = createLifecycleEventStore();
  const controlPlane = createControlPlaneStore();

  const { cache, now } = setupCacheWithCandidates({
    mediaId,
    primaryHash: HASH1,
    additionalCandidates: [{ infoHash: HASH2, observationState: 'uncached' }],
    primaryObservationState: 'uncached',
  });

  setupControlPlaneWithPlacements(controlPlane, [HASH1, HASH2]);

  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      // All uncached
      return { cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() };
    },
    now: () => now + 60_000,
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore,
    revalidator,
  });

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(createMockRequest(`/stream/movie/${mediaId}`), res).catch(reject);
  });

  // Should get 409 (provider not cached) since all alternates are unavailable
  assert.equal(response.status, 409);
  assert.equal(response.headers['x-fallback-used'], undefined);

  // Verify telemetry shows failure
  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'failed');
  assert.equal(records[0].failureCode, 'PROVIDER_NOT_CACHED');

  cache.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Test 6: Fallback does not mutate persisted handoff
// ═══════════════════════════════════════════════════════════════════════════════

test('integration: fallback does not mutate persisted handoff', async () => {
  const mediaId = 'tt_fallback_no_mutation';
  const eventStore = createLifecycleEventStore();
  const controlPlane = createControlPlaneStore();

  const { cache, now } = setupCacheWithCandidates({
    mediaId,
    primaryHash: HASH1,
    additionalCandidates: [{ infoHash: HASH2, observationState: 'cached' }],
    primaryObservationState: 'uncached',
  });

  setupControlPlaneWithPlacements(controlPlane, [HASH1, HASH2]);

  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      const cached = new Set();
      const failed = new Set();
      for (const h of hashes) {
        if (h === HASH1) {
          // uncached
        } else {
          cached.add(h);
        }
      }
      return { cached, failed, details: new Map(), latencyMs: new Map() };
    },
    now: () => now + 60_000,
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore,
    revalidator,
  });

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(createMockRequest(`/stream/movie/${mediaId}`), res).catch(reject);
  });

  assert.equal(response.status, 307);
  assert.equal(response.headers['x-fallback-used'], 'true');

  // Verify handoff still points to primary (not mutated)
  const storedKnowledge = cache.getStoredKnowledge(mediaId);
  assert.ok(storedKnowledge);
  assert.equal(storedKnowledge.handoff.infoHash, HASH1);
  assert.equal(storedKnowledge.handoff.releaseKey, `${HASH1}:torrent`);

  cache.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Test 7: Fallback telemetry recorded with correct structure
// ═══════════════════════════════════════════════════════════════════════════════

test('integration: fallback telemetry recorded with correct structure', async () => {
  const mediaId = 'tt_fallback_telemetry';
  const eventStore = createLifecycleEventStore();
  const controlPlane = createControlPlaneStore();

  const { cache, now } = setupCacheWithCandidates({
    mediaId,
    primaryHash: HASH1,
    additionalCandidates: [{ infoHash: HASH2, observationState: 'cached' }],
    primaryObservationState: 'uncached',
  });

  setupControlPlaneWithPlacements(controlPlane, [HASH1, HASH2]);

  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => {
      const cached = new Set();
      const failed = new Set();
      for (const h of hashes) {
        if (h === HASH1) {
          // uncached
        } else {
          cached.add(h);
        }
      }
      return { cached, failed, details: new Map(), latencyMs: new Map() };
    },
    now: () => now + 60_000,
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore,
    revalidator,
  });

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(createMockRequest(`/stream/movie/${mediaId}`), res).catch(reject);
  });

  assert.equal(response.status, 307);

  // Verify telemetry structure matches expected format
  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);

  const record = records[0];
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.originalReleaseKey, `${HASH1}:torrent`);
  assert.equal(record.selectedReleaseKey, `${HASH2}:torrent`);
  assert.equal(record.fallbackRank, 2);
  assert.ok(record.reason.includes('primary unavailable') || record.reason.includes('next persisted eligible'));
  assert.equal(record.outcome, 'redirected');
  assert.equal(record.redirectStatus, 307);

  cache.close();
});
