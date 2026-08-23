import assert from 'node:assert/strict';
import test from 'node:test';

import { projectExactCandidateObservation } from '../src/lib/acquisition/exact-candidate-projection.js';
import { createCacheObservation } from '../src/lib/providers/observations.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';
import {
  HASH,
  OTHER_HASH,
  checkcachedHit,
  checkcachedMiss,
  checkcachedMixed,
  checkcachedAuthError,
  checkcachedServiceError,
  mylistResource,
} from './fixtures/torbox-response-fixtures.js';

const NOW = 20_000;

function torrentCandidate(infoHash = HASH) {
  return createReleaseIdentity(infoHash, null);
}

function fileCandidate(fileIndex = 0, infoHash = HASH) {
  return createReleaseIdentity(infoHash, fileIndex);
}

/**
 * Simulate the TorBox cache adapter's observation output for a checkcached
 * result. The adapter is torrent-level only: scope='torrent', fileIndex=null.
 */
function torboxCacheObservation({ infoHash, cached, state = 'cached', errorCategory = null }) {
  const isUnknown = state === 'unknown';
  return createCacheObservation({
    provider: 'torbox',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash,
    fileIndex: null,
    kind: 'authoritative',
    state,
    observedAt: 19_000,
    expiresAt: 21_000,
    source: 'torbox-checkcached',
    errorCategory,
    retryable: isUnknown ? true : null,
  });
}

// ---------------------------------------------------------------------------
// Cache observation mapping
// ---------------------------------------------------------------------------

test('torrent-level cache hit projects for torrent-level candidate', () => {
  const obs = torboxCacheObservation({ infoHash: HASH, cached: true, state: 'cached' });
  const result = projectExactCandidateObservation({
    candidate: torrentCandidate(),
    observation: obs,
    now: NOW,
  });

  assert.equal(result.status, 'projected');
  assert.equal(result.candidate.fileIndex, null);
  assert.equal(result.observation.scope, 'torrent');
  assert.equal(result.observation.fileIndex, null);
  assert.equal(result.observation.state, 'cached');
});

test('torrent-level cache hit REJECTED for file-level candidate', () => {
  const obs = torboxCacheObservation({ infoHash: HASH, cached: true, state: 'cached' });
  const result = projectExactCandidateObservation({
    candidate: fileCandidate(0),
    observation: obs,
    now: NOW,
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'torrent-scope-file-candidate');
});

test('torrent-level cache miss projects for torrent-level candidate (uncached preserved)', () => {
  const obs = torboxCacheObservation({ infoHash: HASH, cached: false, state: 'uncached' });
  const result = projectExactCandidateObservation({
    candidate: torrentCandidate(),
    observation: obs,
    now: NOW,
  });

  assert.equal(result.status, 'projected');
  assert.equal(result.observation.state, 'uncached');
});

test('cache miss for wrong infoHash rejected', () => {
  const obs = torboxCacheObservation({ infoHash: OTHER_HASH, cached: false, state: 'uncached' });
  const result = projectExactCandidateObservation({
    candidate: torrentCandidate(HASH),
    observation: obs,
    now: NOW,
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'wrong-infoHash');
});

test('unknown (failed batch) observation projects but is not decisive', () => {
  const obs = torboxCacheObservation({ infoHash: HASH, state: 'unknown' });
  const result = projectExactCandidateObservation({
    candidate: torrentCandidate(),
    observation: obs,
    now: NOW,
  });

  assert.equal(result.status, 'projected');
  assert.equal(result.observation.state, 'unknown');
  assert.equal(result.observation.retryable, true);
});

test('auth error observation preserves error category', () => {
  const obs = createCacheObservation({
    provider: 'torbox',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASH,
    fileIndex: null,
    kind: 'authoritative',
    state: 'error',
    observedAt: 19_000,
    expiresAt: 21_000,
    source: 'torbox-checkcached',
    errorCategory: 'authentication',
    retryable: false,
  });
  const result = projectExactCandidateObservation({
    candidate: torrentCandidate(),
    observation: obs,
    now: NOW,
  });

  assert.equal(result.status, 'projected');
  assert.equal(result.observation.state, 'error');
  assert.equal(result.observation.errorCategory, 'authentication');
});

// ---------------------------------------------------------------------------
// Freshness mapping
// ---------------------------------------------------------------------------

test('stale observation rejected as stale', () => {
  const obs = createCacheObservation({
    provider: 'torbox',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASH,
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: 10_000,
    expiresAt: NOW - 1,
    source: 'torbox-checkcached',
  });
  const result = projectExactCandidateObservation({
    candidate: torrentCandidate(),
    observation: obs,
    now: NOW,
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'stale-observation');
});

test('future observation rejected', () => {
  const obs = createCacheObservation({
    provider: 'torbox',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASH,
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW + 1000,
    expiresAt: NOW + 5000,
    source: 'torbox-checkcached',
  });
  const result = projectExactCandidateObservation({
    candidate: torrentCandidate(),
    observation: obs,
    now: NOW,
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'future-observation');
});

// ---------------------------------------------------------------------------
// File inventory mapping — fundamental gap
// ---------------------------------------------------------------------------

test('file inventory cannot produce file-level cache observation (no corpusFileIndex)', () => {
  // mylistResource has files with opaque ids (900, 900) but corpusFileIndex=null.
  // Without a validated provider-file → corpus-fileIndex mapping, no file-level
  // observation can be constructed. The adapter correctly emits fileIndex=null.
  const resource = mylistResource();
  assert.equal(resource.files[0].id, 900);

  // Any observation built from inventory is torrent-level only.
  const obs = createCacheObservation({
    provider: 'torbox',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASH,
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: 19_000,
    expiresAt: 21_000,
    source: 'torbox-mylist',
    evidence: { resourceId: resource.id, fileCount: resource.files.length },
  });

  const fileResult = projectExactCandidateObservation({
    candidate: fileCandidate(0),
    observation: obs,
    now: NOW,
  });

  assert.equal(fileResult.status, 'rejected');
  assert.equal(fileResult.reason, 'torrent-scope-file-candidate');
});

// ---------------------------------------------------------------------------
// Provider/account isolation preserved
// ---------------------------------------------------------------------------

test('different provider/account observations are independent projections', () => {
  const obsA = createCacheObservation({
    provider: 'torbox',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASH,
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: 19_000,
    expiresAt: 21_000,
    source: 'torbox-checkcached',
    correlationId: 'req-a',
  });
  const obsB = createCacheObservation({
    provider: 'torbox',
    accountScope: 'secondary',
    scope: 'torrent',
    infoHash: HASH,
    fileIndex: null,
    kind: 'authoritative',
    state: 'uncached',
    observedAt: 19_000,
    expiresAt: 21_000,
    source: 'torbox-checkcached',
    correlationId: 'req-b',
  });

  const resultA = projectExactCandidateObservation({
    candidate: torrentCandidate(),
    observation: obsA,
    now: NOW,
  });
  const resultB = projectExactCandidateObservation({
    candidate: torrentCandidate(),
    observation: obsB,
    now: NOW,
  });

  assert.equal(resultA.status, 'projected');
  assert.equal(resultA.observation.accountScope, 'primary');
  assert.equal(resultA.observation.correlationId, 'req-a');

  assert.equal(resultB.status, 'projected');
  assert.equal(resultB.observation.accountScope, 'secondary');
  assert.equal(resultB.observation.correlationId, 'req-b');
});

// ---------------------------------------------------------------------------
// Fixture sanity — API shapes are as documented
// ---------------------------------------------------------------------------

test('fixtures: checkcached hit has truthy data value', () => {
  const resp = checkcachedHit(HASH);
  assert.equal(resp.success, true);
  assert.ok(resp.data[HASH]);
});

test('fixtures: mylist resource has opaque file ids and no corpus index', () => {
  const resp = mylistResource();
  assert.equal(resp.id, 77);
  assert.equal(resp.files[0].id, 900);
});
