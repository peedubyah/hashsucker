import assert from 'node:assert/strict';
import test from 'node:test';

import { projectExactCandidateObservation } from '../src/lib/acquisition/exact-candidate-projection.js';
import { createCacheObservation } from '../src/lib/providers/observations.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';

const NOW = 20_000;
const HASH = 'a'.repeat(40);

function candidate(fileIndex = 0, infoHash = HASH) {
  return createReleaseIdentity(infoHash, fileIndex);
}

function observation(options = {}) {
  return createCacheObservation({
    provider: options.provider ?? 'provider-a',
    accountScope: options.accountScope ?? 'primary',
    scope: options.scope ?? 'candidate',
    infoHash: options.infoHash ?? HASH,
    fileIndex: Object.hasOwn(options, 'fileIndex') ? options.fileIndex : 0,
    kind: options.kind ?? 'authoritative',
    state: options.state ?? 'cached',
    observedAt: options.observedAt ?? 19_000,
    expiresAt: options.expiresAt ?? 21_000,
    source: options.source ?? 'fixture-provider',
    errorCategory: options.errorCategory,
    retryable: options.retryable,
    retryAfterMs: options.retryAfterMs,
    correlationId: options.correlationId,
  });
}

function project(candidateInput, observationInput, now = NOW) {
  return projectExactCandidateObservation({
    candidate: candidateInput,
    observation: observationInput,
    now,
  });
}

test('exact match accepted', () => {
  const result = project(candidate(0), observation());
  assert.equal(result.status, 'projected');
  assert.equal(result.candidate.releaseKey, `${HASH}:0`);
  assert.equal(result.candidate.infoHash, HASH);
  assert.equal(result.candidate.fileIndex, 0);
  assert.equal(result.observation.state, 'cached');
  assert.equal(result.freshness.fresh, true);
  assert.equal(result.freshness.freshness, 'fresh');
  assert.ok(Object.isFrozen(result));
});

test('wrong fileIndex rejected', () => {
  const result = project(candidate(1), observation({ fileIndex: 0 }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'wrong-fileIndex');
  assert.equal(result.candidate.fileIndex, 1);
  assert.equal(result.observation.fileIndex, 0);
});

test('wrong infoHash rejected', () => {
  const otherHash = 'b'.repeat(40);
  const result = project(candidate(0), observation({ infoHash: otherHash }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'wrong-infoHash');
});

test('null fileIndex distinct from zero (null candidate, 0 observation rejected)', () => {
  const result = project(candidate(null), observation({ fileIndex: 0 }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'wrong-fileIndex');
  assert.equal(result.candidate.fileIndex, null);
  assert.equal(result.observation.fileIndex, 0);
});

test('null fileIndex distinct from zero (0 candidate, null observation rejected)', () => {
  const result = project(candidate(0), observation({ fileIndex: null }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'wrong-fileIndex');
});

test('null candidate matches null observation accepted', () => {
  const result = project(candidate(null), observation({ fileIndex: null }));
  assert.equal(result.status, 'projected');
  assert.equal(result.candidate.fileIndex, null);
  assert.equal(result.observation.fileIndex, null);
});

test('torrent scope vs file scope: torrent observation cannot authorize file candidate', () => {
  const result = project(candidate(0), observation({ scope: 'torrent', fileIndex: null }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'torrent-scope-file-candidate');
});

test('torrent scope vs file scope: torrent observation authorizes torrent candidate', () => {
  const result = project(candidate(null), observation({ scope: 'torrent', fileIndex: null }));
  assert.equal(result.status, 'projected');
  assert.equal(result.candidate.fileIndex, null);
});

test('torrent scope wrong infoHash rejected', () => {
  const otherHash = 'b'.repeat(40);
  const result = project(candidate(null), observation({
    scope: 'torrent',
    fileIndex: null,
    infoHash: otherHash,
  }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'wrong-infoHash');
});

test('provider mismatch is NOT a rejection - metadata preserved', () => {
  const result = project(candidate(0), observation({ provider: 'provider-b' }));
  assert.equal(result.status, 'projected');
  assert.equal(result.observation.provider, 'provider-b');
  assert.equal(result.observation.accountScope, 'primary');
});

test('account mismatch is NOT a rejection - metadata preserved', () => {
  const result = project(candidate(0), observation({ accountScope: 'secondary' }));
  assert.equal(result.status, 'projected');
  assert.equal(result.observation.provider, 'provider-a');
  assert.equal(result.observation.accountScope, 'secondary');
});

test('distinct provider/account observations do not merge or overwrite', () => {
  const obsA = observation({ provider: 'provider-a', accountScope: 'primary', correlationId: 'a' });
  const obsB = observation({ provider: 'provider-b', accountScope: 'secondary', correlationId: 'b' });

  const resultA = project(candidate(0), obsA);
  const resultB = project(candidate(0), obsB);

  assert.equal(resultA.status, 'projected');
  assert.equal(resultB.status, 'projected');
  assert.equal(resultA.observation.provider, 'provider-a');
  assert.equal(resultA.observation.accountScope, 'primary');
  assert.equal(resultA.observation.correlationId, 'a');
  assert.equal(resultB.observation.provider, 'provider-b');
  assert.equal(resultB.observation.accountScope, 'secondary');
  assert.equal(resultB.observation.correlationId, 'b');
});

test('no scope leakage - candidate scope observation with fileIndex cannot authorize torrent candidate', () => {
  const result = project(candidate(null), observation({ scope: 'candidate', fileIndex: 0 }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'wrong-fileIndex');
});

test('candidate scope observation with null fileIndex matches torrent candidate (no leakage)', () => {
  const result = project(candidate(null), observation({ scope: 'candidate', fileIndex: null }));
  assert.equal(result.status, 'projected');
  assert.equal(result.candidate.fileIndex, null);
  assert.equal(result.observation.fileIndex, null);
});

test('provider-resource scope rejected as unsupported', () => {
  const result = project(candidate(0), observation({ scope: 'provider-resource' }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'unsupported-scope');
});

test('exposure scope rejected as unsupported', () => {
  const result = project(candidate(0), observation({ scope: 'exposure' }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'unsupported-scope');
});

test('stale observation rejected', () => {
  const result = project(candidate(0), observation({ expiresAt: NOW }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'stale-observation');
});

test('expired observation rejected', () => {
  const result = project(candidate(0), observation({ expiresAt: NOW - 1000 }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'stale-observation');
});

test('future observation rejected', () => {
  const result = project(candidate(0), observation({ observedAt: NOW + 1000 }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'future-observation');
});

test('unbounded observation (no expiry) rejected', () => {
  const obs = createCacheObservation({
    provider: 'provider-a',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASH,
    fileIndex: 0,
    kind: 'authoritative',
    state: 'cached',
    observedAt: 19_000,
    source: 'fixture-provider',
  });
  const result = project(candidate(0), obs);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'unbounded-observation');
});

test('inferred observation rejected as non-authoritative', () => {
  const result = project(candidate(0), observation({ kind: 'inferred' }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'non-authoritative-observation');
});

test('predicted observation rejected as non-authoritative', () => {
  const result = project(candidate(0), observation({ kind: 'predicted' }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'non-authoritative-observation');
});

test('malformed observation rejected with detail', () => {
  const result = project(candidate(0), { scope: 'candidate' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'malformed-observation');
  assert.ok(result.detail, 'expected rejection detail message');
});

test('preserves error and retry metadata on rejection', () => {
  const result = project(candidate(0), observation({
    state: 'error',
    errorCategory: 'rate-limit',
    retryable: true,
    retryAfterMs: 30_000,
    expiresAt: NOW - 1,
  }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'stale-observation');
  assert.equal(result.observation.errorCategory, 'rate-limit');
  assert.equal(result.observation.retryable, true);
  assert.equal(result.observation.retryAfterMs, 30_000);
});

test('uncached but fresh authoritative observation is projected (state preserved)', () => {
  const result = project(candidate(0), observation({ state: 'uncached' }));
  assert.equal(result.status, 'projected');
  assert.equal(result.observation.state, 'uncached');
});

test('unknown authoritative observation projected with state preserved', () => {
  const result = project(candidate(0), observation({ state: 'unknown' }));
  assert.equal(result.status, 'projected');
  assert.equal(result.observation.state, 'unknown');
});

test('missing evaluation time does not silently use system time', () => {
  const obs = observation({ observedAt: 1, expiresAt: 2 });
  const result = projectExactCandidateObservation({
    candidate: candidate(0),
    observation: obs,
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'missing-evaluation-time');
  assert.equal(result.observation, obs, 'observation preserved unchanged');
  assert.equal(result.candidate.fileIndex, 0);
});

test('explicit null evaluation time rejected (not treated as missing)', () => {
  assert.throws(() => projectExactCandidateObservation({
    candidate: candidate(0),
    observation: observation(),
    now: null,
  }), /non-negative millisecond/);
});

test('programmer error: invalid candidate throws', () => {
  assert.throws(() => projectExactCandidateObservation({
    candidate: null,
    observation: observation(),
    now: NOW,
  }), /candidate must be an object/);
});

test('programmer error: invalid observation throws', () => {
  assert.throws(() => projectExactCandidateObservation({
    candidate: candidate(0),
    observation: null,
    now: NOW,
  }), /observation must be an object/);
});

test('programmer error: invalid now throws', () => {
  assert.throws(() => projectExactCandidateObservation({
    candidate: candidate(0),
    observation: observation(),
    now: -1,
  }), /non-negative millisecond/);
});

test('programmer error: releaseKey mismatch throws', () => {
  assert.throws(() => projectExactCandidateObservation({
    candidate: { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:1` },
    observation: observation(),
    now: NOW,
  }), /releaseKey must match/);
});
