/**
 * Resolver Telemetry Tests
 *
 * Tests for the resolver attempt telemetry recording.
 * Verifies that every /stream/:type/:id resolution produces
 * one structured attempt record in the lifecycle event store.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createLifecycleEventStore } from '../src/lib/operator/event-store.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createRequestHandler } from '../src/server/app.js';
import { createRevalidator } from '../src/lib/resolver/availability-revalidation.js';
import {
  createResolverTelemetry,
  getRecentResolverTelemetry,
  RESOLVER_OUTCOME,
} from '../src/lib/resolver/telemetry.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

// ═══════════════════════════════════════════════════════════════════════════════
// Unit tests for createResolverTelemetry
// ═══════════════════════════════════════════════════════════════════════════════

test('createResolverTelemetry: records successful redirect attempt', () => {
  const eventStore = createLifecycleEventStore();
  const telemetry = createResolverTelemetry({ eventStore });

  const requestId = telemetry.recordAttempt({
    mediaId: 'tt1234567',
    mediaType: 'movie',
    infoHash: HASH,
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
    availabilitySource: 'stored-fresh',
    providerCheckOccurred: false,
    outcome: RESOLVER_OUTCOME.REDIRECTED,
    failureCode: null,
    redirectStatus: 307,
    durationMs: 42,
  });

  assert.ok(requestId, 'returns a requestId');

  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);

  const record = records[0];
  assert.equal(record.mediaId, 'tt1234567');
  assert.equal(record.mediaType, 'movie');
  assert.equal(record.infoHash, HASH);
  assert.equal(record.releaseKey, `${HASH}:torrent`);
  assert.equal(record.provider, 'torbox');
  assert.equal(record.availabilitySource, 'stored-fresh');
  assert.equal(record.providerCheckOccurred, false);
  assert.equal(record.outcome, 'redirected');
  assert.equal(record.failureCode, null);
  assert.equal(record.redirectStatus, 307);
  assert.equal(record.durationMs, 42);
  assert.equal(record.status, 'completed');
});

test('createResolverTelemetry: records failed attempt with typed failure code', () => {
  const eventStore = createLifecycleEventStore();
  const telemetry = createResolverTelemetry({ eventStore });

  telemetry.recordAttempt({
    mediaId: 'tt1234567',
    mediaType: 'movie',
    infoHash: HASH,
    releaseKey: `${HASH}:torrent`,
    provider: 'torbox',
    availabilitySource: 'playback-revalidation',
    providerCheckOccurred: true,
    outcome: RESOLVER_OUTCOME.FAILED,
    failureCode: 'PROVIDER_NOT_CACHED',
    redirectStatus: null,
    durationMs: 150,
  });

  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);

  const record = records[0];
  assert.equal(record.outcome, 'failed');
  assert.equal(record.failureCode, 'PROVIDER_NOT_CACHED');
  assert.equal(record.status, 'failed');
  assert.equal(record.providerCheckOccurred, true);
});

test('createResolverTelemetry: does not log tokens or full URLs', () => {
  const eventStore = createLifecycleEventStore();
  const telemetry = createResolverTelemetry({ eventStore });

  // Attempt to record sensitive data — should be stripped
  telemetry.recordAttempt({
    mediaId: 'tt1234567',
    mediaType: 'movie',
    infoHash: HASH,
    provider: 'torbox',
    outcome: RESOLVER_OUTCOME.REDIRECTED,
    redirectStatus: 307,
    durationMs: 10,
    // These should NOT appear in the record
    token: 'secret-token-123',
    redirectUrl: 'https://api.torbox.app/v1/api/torrents/requestdl?token=secret',
    fullUrl: 'https://api.torbox.app/v1/api/torrents/requestdl?token=secret&torrent_id=123',
  });

  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  const record = records[0];

  // Verify sensitive fields are not present
  assert.equal(record.token, undefined, 'token not logged');
  assert.equal(record.redirectUrl, undefined, 'redirectUrl not logged');
  assert.equal(record.fullUrl, undefined, 'fullUrl not logged');
});

test('createResolverTelemetry: error does not throw', () => {
  // Event store that throws on recordEvent
  const brokenEventStore = {
    recordEvent: () => { throw new Error('Storage failure'); },
  };

  const telemetry = createResolverTelemetry({ eventStore: brokenEventStore });

  // Should not throw
  const requestId = telemetry.recordAttempt({
    mediaId: 'tt1234567',
    outcome: RESOLVER_OUTCOME.REDIRECTED,
  });

  assert.equal(requestId, null, 'returns null on failure');
});

test('createResolverTelemetry: requires eventStore', () => {
  assert.throws(
    () => createResolverTelemetry({}),
    /eventStore with recordEvent is required/
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration tests — full HTTP stack with telemetry
// ═══════════════════════════════════════════════════════════════════════════════

test('integration: successful 307 redirect records telemetry', async () => {
  const eventStore = createLifecycleEventStore();
  const cache = createDiscoveryCache();
  const controlPlane = createControlPlaneStore();
  const mediaId = 'tt_telemetry_success';
  const infoHash = HASH;
  const now = Date.now();

  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null, source: 'test' },
    [{ infoHash, fileIndex: null, filename: 'Movie.mkv', score: 0.85, rank: 1, release: { infoHash, fileIndex: null, releaseKey: `${infoHash}:torrent` } }]
  );

  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    filename: 'Movie.mkv', provider: 'torbox', providerState: 'cached',
    identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: now,
  });

  cache.appendProviderObservation({
    provider: 'torbox', accountScope: 'primary', scope: 'candidate',
    infoHash, fileIndex: null, state: 'cached', kind: 'authoritative',
    observedAt: now - 60_000, expiresAt: now + 300_000, source: 'test',
  });

  const placement = controlPlane.recordPlacement({
    provider: 'torbox', accountScope: 'primary', infoHash,
    providerResourceId: '12345', state: 'ready', ownership: 'owned', provenance: 'test',
  });

  controlPlane.replaceProviderFileInventory(placement.id, [{
    providerFileId: '67890', path: '/movie.mkv', name: 'movie.mkv', size: 1000000, selected: true,
  }], { authoritative: true, complete: true });

  controlPlane.recordFileMapping({
    infoHash, fileIndex: null, fileIndexKey: -1, releaseKey: `${infoHash}:torrent`,
    placementId: placement.id, providerFileId: '67890', state: 'mapped', method: 'test', authoritative: true,
  });

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

  const input = Readable.from([]);
  input.method = 'GET';
  input.url = `/stream/movie/${mediaId}`;

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 307);

  // Verify telemetry was recorded
  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);

  const record = records[0];
  assert.equal(record.outcome, 'redirected');
  assert.equal(record.mediaId, mediaId);
  assert.equal(record.infoHash, infoHash);
  assert.equal(record.provider, 'torbox');
  assert.equal(record.redirectStatus, 307);
  assert.equal(record.status, 'completed');
  assert.ok(record.durationMs >= 0);

  cache.close();
});

test('integration: missing selection records failed telemetry', async () => {
  const eventStore = createLifecycleEventStore();
  const cache = createDiscoveryCache();
  const mediaId = 'tt_telemetry_no_selection';

  const handler = createRequestHandler({
    searchCache: cache,
    eventStore,
  });

  const input = Readable.from([]);
  input.method = 'GET';
  input.url = `/stream/movie/${mediaId}`;

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 501);

  // Verify telemetry was recorded
  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);

  const record = records[0];
  assert.equal(record.outcome, 'failed');
  assert.equal(record.failureCode, 'NO_SELECTION');
  assert.equal(record.mediaId, mediaId);
  assert.equal(record.status, 'failed');

  cache.close();
});

test('integration: provider check failure records telemetry without blocking', async () => {
  const eventStore = createLifecycleEventStore();
  const cache = createDiscoveryCache();
  const controlPlane = createControlPlaneStore();
  const mediaId = 'tt_telemetry_check_fail';
  const infoHash = HASH;
  const now = Date.now();

  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null, source: 'test' },
    [{ infoHash, fileIndex: null, filename: 'Movie.mkv', score: 0.85, rank: 1, release: { infoHash, fileIndex: null, releaseKey: `${infoHash}:torrent` } }]
  );

  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    filename: 'Movie.mkv', provider: 'torbox', providerState: 'cached',
    identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: now,
  });

  // Stale observation
  cache.appendProviderObservation({
    provider: 'torbox', accountScope: 'primary', scope: 'candidate',
    infoHash, fileIndex: null, state: 'cached', kind: 'authoritative',
    observedAt: now - 600_000, expiresAt: now - 300_000, source: 'test',
  });

  // Mock revalidator that throws (provider check fails)
  const revalidator = createRevalidator({
    checkTorBoxCached: async () => { throw new Error('Network timeout'); },
    now: () => now + 600_000,
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore,
    revalidator,
  });

  const input = Readable.from([]);
  input.method = 'GET';
  input.url = `/stream/movie/${mediaId}`;

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(input, res).catch(reject);
  });

  // Should get 503 (provider check failed)
  assert.equal(response.status, 503);

  // Verify telemetry was recorded despite the failure
  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);

  const record = records[0];
  assert.equal(record.outcome, 'failed');
  assert.equal(record.failureCode, 'PROVIDER_CHECK_FAILED');
  assert.equal(record.providerCheckOccurred, true);
  assert.equal(record.status, 'failed');

  cache.close();
});

test('integration: telemetry failure does not block resolution', async () => {
  // Event store that throws on recordEvent
  const brokenEventStore = {
    recordEvent: () => { throw new Error('Storage is broken'); },
    getEventsByStage: () => [],
  };

  const cache = createDiscoveryCache();
  const controlPlane = createControlPlaneStore();
  const mediaId = 'tt_telemetry_no_block';
  const infoHash = HASH;
  const now = Date.now();

  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null, source: 'test' },
    [{ infoHash, fileIndex: null, filename: 'Movie.mkv', score: 0.85, rank: 1, release: { infoHash, fileIndex: null, releaseKey: `${infoHash}:torrent` } }]
  );

  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    filename: 'Movie.mkv', provider: 'torbox', providerState: 'cached',
    identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: now,
  });

  cache.appendProviderObservation({
    provider: 'torbox', accountScope: 'primary', scope: 'candidate',
    infoHash, fileIndex: null, state: 'cached', kind: 'authoritative',
    observedAt: now - 60_000, expiresAt: now + 300_000, source: 'test',
  });

  const placement = controlPlane.recordPlacement({
    provider: 'torbox', accountScope: 'primary', infoHash,
    providerResourceId: '12345', state: 'ready', ownership: 'owned', provenance: 'test',
  });

  controlPlane.replaceProviderFileInventory(placement.id, [{
    providerFileId: '67890', path: '/movie.mkv', name: 'movie.mkv', size: 1000000, selected: true,
  }], { authoritative: true, complete: true });

  controlPlane.recordFileMapping({
    infoHash, fileIndex: null, fileIndexKey: -1, releaseKey: `${infoHash}:torrent`,
    placementId: placement.id, providerFileId: '67890', state: 'mapped', method: 'test', authoritative: true,
  });

  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => ({ cached: new Set(hashes), failed: new Set(), details: new Map(), latencyMs: new Map() }),
    now: () => now + 60_000,
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore: brokenEventStore,
    revalidator,
  });

  const input = Readable.from([]);
  input.method = 'GET';
  input.url = `/stream/movie/${mediaId}`;

  // Should still get 307 even though telemetry storage is broken
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 307, 'resolution succeeds despite telemetry failure');
  assert.match(response.headers.location, /torrents\/requestdl/);

  cache.close();
});

test('integration: uncached result records failed telemetry', async () => {
  const eventStore = createLifecycleEventStore();
  const cache = createDiscoveryCache();
  const controlPlane = createControlPlaneStore();
  const mediaId = 'tt_telemetry_uncached';
  const infoHash = HASH;
  const now = Date.now();

  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null, source: 'test' },
    [{ infoHash, fileIndex: null, filename: 'Movie.mkv', score: 0.85, rank: 1, release: { infoHash, fileIndex: null, releaseKey: `${infoHash}:torrent` } }]
  );

  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    filename: 'Movie.mkv', provider: 'torbox', providerState: 'cached',
    identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: now,
  });

  // Stale observation
  cache.appendProviderObservation({
    provider: 'torbox', accountScope: 'primary', scope: 'candidate',
    infoHash, fileIndex: null, state: 'cached', kind: 'authoritative',
    observedAt: now - 600_000, expiresAt: now - 300_000, source: 'test',
  });

  // Mock revalidator that returns uncached
  const revalidator = createRevalidator({
    checkTorBoxCached: async (hashes) => ({ cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() }),
    now: () => now + 600_000,
    maxAgeMs: 5 * 60 * 1000,
  });

  const handler = createRequestHandler({
    searchCache: cache,
    controlPlaneStore: controlPlane,
    eventStore,
    revalidator,
  });

  const input = Readable.from([]);
  input.method = 'GET';
  input.url = `/stream/movie/${mediaId}`;

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(input, res).catch(reject);
  });

  assert.equal(response.status, 409, 'uncached → 409 Conflict');

  // Verify telemetry was recorded
  const records = getRecentResolverTelemetry(eventStore, { limit: 10 });
  assert.equal(records.length, 1);

  const record = records[0];
  assert.equal(record.outcome, 'failed');
  assert.equal(record.failureCode, 'PROVIDER_NOT_CACHED');
  assert.equal(record.providerCheckOccurred, true);
  assert.equal(record.status, 'failed');

  cache.close();
});

test('integration: debug endpoint returns resolver telemetry', async () => {
  const eventStore = createLifecycleEventStore();
  const cache = createDiscoveryCache();
  const controlPlane = createControlPlaneStore();
  const mediaId = 'tt_telemetry_debug';
  const infoHash = HASH;
  const now = Date.now();

  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null, source: 'test' },
    [{ infoHash, fileIndex: null, filename: 'Movie.mkv', score: 0.85, rank: 1, release: { infoHash, fileIndex: null, releaseKey: `${infoHash}:torrent` } }]
  );

  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${infoHash}:torrent`, infoHash, fileIndex: null,
    filename: 'Movie.mkv', provider: 'torbox', providerState: 'cached',
    identityTier: 'Verified', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: now,
  });

  cache.appendProviderObservation({
    provider: 'torbox', accountScope: 'primary', scope: 'candidate',
    infoHash, fileIndex: null, state: 'cached', kind: 'authoritative',
    observedAt: now - 60_000, expiresAt: now + 300_000, source: 'test',
  });

  const placement = controlPlane.recordPlacement({
    provider: 'torbox', accountScope: 'primary', infoHash,
    providerResourceId: '12345', state: 'ready', ownership: 'owned', provenance: 'test',
  });

  controlPlane.replaceProviderFileInventory(placement.id, [{
    providerFileId: '67890', path: '/movie.mkv', name: 'movie.mkv', size: 1000000, selected: true,
  }], { authoritative: true, complete: true });

  controlPlane.recordFileMapping({
    infoHash, fileIndex: null, fileIndexKey: -1, releaseKey: `${infoHash}:torrent`,
    placementId: placement.id, providerFileId: '67890', state: 'mapped', method: 'test', authoritative: true,
  });

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

  // First, make a resolver request to generate telemetry
  const streamInput = Readable.from([]);
  streamInput.method = 'GET';
  streamInput.url = `/stream/movie/${mediaId}`;

  await new Promise((resolve, reject) => {
    const res = {
      writeHead() {},
      end() { resolve(); },
    };
    handler(streamInput, res).catch(reject);
  });

  // Now query the debug endpoint
  const debugInput = Readable.from([]);
  debugInput.method = 'GET';
  debugInput.url = '/api/debug/resolver-telemetry?limit=10';

  const debugResponse = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    handler(debugInput, res).catch(reject);
  });

  assert.equal(debugResponse.status, 200);
  const body = JSON.parse(debugResponse.text);
  assert.ok(body.total >= 1);
  assert.ok(body.records.length >= 1);

  const record = body.records[0];
  assert.equal(record.outcome, 'redirected');
  assert.equal(record.mediaId, mediaId);

  cache.close();
});
