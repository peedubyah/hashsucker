import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackObjectApiError } from '../src/api/playback-object.js';
import { resolvePlayback, classifyUnboundResult, PLAY_OUTCOME } from '../src/lib/playback/orchestrate.js';

const CACHED = { availability: { torbox: { state: 'cached' } }, identity: { eligible: true } };
const UNCACHED = { availability: { torbox: { state: 'uncached' } }, identity: { eligible: true } };
const INELIGIBLE = { availability: {}, identity: { eligible: false } };

function cand(overrides = {}) {
  return {
    infoHash: 'aa'.repeat(20), rank: 1, filename: 'M.mkv', selectedFileSize: 100,
    title: 'M', ...CACHED, ...overrides,
  };
}

test('classifier distinguishes the unbound shapes without provider calls', () => {
  assert.equal(classifyUnboundResult(null).kind, 'no-candidates');
  assert.equal(classifyUnboundResult({}).kind, 'no-candidates');
  assert.equal(classifyUnboundResult({ results: [] }).kind, 'no-candidates');
  assert.equal(classifyUnboundResult({ results: [cand({ identity: { eligible: false } })], selection: {} }).kind, 'no-eligible');
  // All attempted (in skipped) and uncached → prepare material.
  const attempted = cand({ infoHash: 'bb'.repeat(20), rank: 1, ...UNCACHED });
  const r = classifyUnboundResult({ results: [attempted], selection: { skipped: [{ infoHash: attempted.infoHash }] } });
  assert.equal(r.kind, 'prepare-candidate');
  assert.equal(r.candidate.infoHash, attempted.infoHash);
  // Untried + executable → defensive retry material with rank reason.
  const untried = cand({ infoHash: 'cc'.repeat(20), rank: 3, ...CACHED });
  const r2 = classifyUnboundResult({ results: [untried], selection: { skipped: [] } });
  assert.equal(r2.kind, 'executable-alternative');
  assert.equal(r2.reason, 'quality-floor-fallback');
  const untriedTop = cand({ infoHash: 'dd'.repeat(20), rank: 1, ...CACHED });
  const r3 = classifyUnboundResult({ results: [untriedTop], selection: {} });
  assert.equal(r3.kind, 'executable-alternative');
  assert.equal(r3.reason, 'preferred');
});

const SECRET_ENV = { PLAYBACK_TOKEN_SECRET: 'test-secret-that-is-long-enough-0123456789' };

// The real cold path RESOLVES with a pipeline result and throws
// NO_AUTHORITATIVE_REPRESENTATION itself when no Binding follows (with
// the pipeline result attached). Stubs mimic that shape.
function stubIntent(pipelineResult) {
  return {
    mediaId: 'tt0133093',
    mediaType: 'movie',
    env: SECRET_ENV,
    prepareFn: async () => pipelineResult ?? {},
  };
}

test('ready passes through untouched with preferred reason', async () => {
  const controlPlaneStore = {
    getLibraryItemByIdentityKey: () => ({ id: 'item-1' }),
    getActiveBindingForLibraryItem: () => ({ torrentFile: { id: 'tf-warm-1' } }),
  };
  const out = await resolvePlayback({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    env: SECRET_ENV,
    controlPlaneStore,
    prepareFn: async () => { throw new Error('warm path must not call the pipeline'); },
  });
  assert.equal(out.outcome, PLAY_OUTCOME.READY);
  assert.equal(out.representationReason, 'preferred');
  assert.equal(out.torrentFileId, 'tf-warm-1');
  assert.equal(out.warm, true);
  assert.ok(String(out.playbackUrl).startsWith('/play/'));
});

test('ambiguous intent maps to needs-user-decision, never preparation', async () => {
  let depsCalled = 0;
  const out = await resolvePlayback({
    query: 'Alien',
    env: SECRET_ENV,
    searchFn: async () => ({ results: [
      { id: 'tt0078748', title: 'Alien', year: 1979, type: 'movie' },
      { id: 'tt1442462', title: 'Alien', year: 2024, type: 'series' },
    ] }),
    prepareFn: async () => { throw new Error('must not reach the pipeline'); },
    prepareDeps: async () => { depsCalled += 1; return null; },
  });
  assert.equal(out.outcome, PLAY_OUTCOME.AMBIGUOUS);
  assert.equal(out.candidates.length, 2);
  assert.equal(depsCalled, 0, 'ambiguity never starts preparation');
});

test('non-representation errors surface as error outcome', async () => {
  const err = new PlaybackObjectApiError(502, 'REQUEST_PIPELINE_FAILED', 'boom');
  const out = await resolvePlayback({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    env: SECRET_ENV,
    prepareFn: async () => { throw err; },
  });
  assert.equal(out.outcome, PLAY_OUTCOME.ERROR);
  assert.equal(out.code, 'REQUEST_PIPELINE_FAILED');
});

test('no candidates → not-available without touching preparation', async () => {
  let depsCalled = 0;
  const out = await resolvePlayback({
    ...stubIntent({ results: [], selection: {} }),
    prepareDeps: async () => { depsCalled += 1; return null; },
  });
  assert.equal(out.outcome, PLAY_OUTCOME.NOT_AVAILABLE);
  assert.equal(out.reason, 'no-candidate');
  assert.equal(depsCalled, 0, 'no preparation machinery consulted');
});

test('all-attempted-uncached starts preparation with rank-1 candidate', async () => {
  const attempted = cand({ infoHash: 'bb'.repeat(20), ...UNCACHED });
  const started = [];
  const fakeDriver = {
    startPreparation: (input) => {
      started.push(input);
      return { preparation: { id: 7, provider: 'torbox' }, created: true, joined: false };
    },
  };
  const out = await resolvePlayback({
    ...stubIntent({ results: [attempted], selection: { skipped: [{ infoHash: attempted.infoHash }] } }),
    prepareDeps: async () => ({ driver: fakeDriver, eligibleProviders: ['torbox', 'realdebrid'] }),
    sessionId: 's-1',
  });
  assert.equal(out.outcome, PLAY_OUTCOME.PREPARING);
  assert.equal(out.preparationId, 7);
  assert.equal(out.provider, 'torbox');
  assert.equal(out.joined, false);
  assert.equal(out.representationReason, 'prepared-representation');
  assert.equal(started.length, 1);
  assert.equal(started[0].infoHash, attempted.infoHash);
  assert.deepEqual(started[0].providers, ['torbox', 'realdebrid']);
  assert.equal(started[0].sessionId, 's-1');
  assert.match(out.message, /automatically/);
});

test('untried executable retries once widened, then binds READY', async () => {
  const untried = cand({ infoHash: 'cc'.repeat(20), rank: 3, ...CACHED });
  const pipelineResult = { results: [untried], selection: { skipped: [] } };
  let calls = 0;
  let bound = false;
  const controlPlaneStore = {
    getLibraryItemByIdentityKey: () => ({ id: 'item-9' }),
    getActiveBindingForLibraryItem: () => (bound ? { torrentFile: { id: 'tf-alt-9' } } : null),
  };
  const out = await resolvePlayback({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    env: SECRET_ENV,
    controlPlaneStore,
    prepareFn: async (cache, request) => {
      calls += 1;
      if (calls === 1) return pipelineResult;
      // Second (widened) pass binds through the normal path.
      bound = true;
      assert.equal(request.maxServiceabilityAlternates, 25, 'retry widens the traversal bound');
      return pipelineResult;
    },
  });
  assert.equal(calls, 2, 'exactly one retry');
  assert.equal(out.outcome, PLAY_OUTCOME.READY);
  assert.equal(out.representationReason, 'equivalent-executable');
  assert.equal(out.torrentFileId, 'tf-alt-9');
});

test('second Play joins the same preparation (no duplicate)', async () => {
  const attempted = cand({ infoHash: 'bb'.repeat(20), ...UNCACHED });
  const fakeDriver = {
    startPreparation: () => ({ preparation: { id: 7, provider: 'torbox' }, created: false, joined: true }),
  };
  const out = await resolvePlayback({
    ...stubIntent({ results: [attempted], selection: { skipped: [{ infoHash: attempted.infoHash }] } }),
    prepareDeps: async () => ({ driver: fakeDriver, eligibleProviders: ['torbox'] }),
  });
  assert.equal(out.outcome, PLAY_OUTCOME.PREPARING);
  assert.equal(out.joined, true);
  assert.match(out.message, /already running/);
});

test('no preparation machinery → not-available (today behavior preserved)', async () => {
  const attempted = cand({ infoHash: 'bb'.repeat(20), ...UNCACHED });
  const out = await resolvePlayback({
    ...stubIntent({ results: [attempted], selection: { skipped: [{ infoHash: attempted.infoHash }] } }),
  });
  assert.equal(out.outcome, PLAY_OUTCOME.NOT_AVAILABLE);
  assert.equal(out.reason, 'preparation-unavailable');
});

test('rejected start (over-size) surfaces reason, not preparing', async () => {
  const attempted = cand({ infoHash: 'bb'.repeat(20), ...UNCACHED });
  const fakeDriver = {
    startPreparation: () => ({ preparation: null, created: false, reason: 'over-size-limit:999' }),
  };
  const out = await resolvePlayback({
    ...stubIntent({ results: [attempted], selection: { skipped: [{ infoHash: attempted.infoHash }] } }),
    prepareDeps: async () => ({ driver: fakeDriver, eligibleProviders: ['torbox'] }),
  });
  assert.equal(out.outcome, PLAY_OUTCOME.NOT_AVAILABLE);
  assert.equal(out.reason, 'over-size-limit:999');
});
