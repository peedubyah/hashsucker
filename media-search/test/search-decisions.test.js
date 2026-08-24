/**
 * Search Decisions Store Tests
 *
 * Tests createSearchDecisionStore, recordDecision, decisionFromTrace.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSearchDecisionStore, decisionFromTrace } from '../src/lib/discovery/search-decisions.js';

test('createSearchDecisionStore creates in-memory store', () => {
  const store = createSearchDecisionStore();
  assert.equal(store.countDecisions(), 0);
  store.close();
});

test('recordDecision stores a decision', () => {
  const store = createSearchDecisionStore();
  const id = store.recordDecision({
    query: 'test query',
    candidate_count: 10,
    winning_release_key: 'hash123:torrent',
    winner_source: 'dmm-corpus',
    winner_score: 0.85,
    score_breakdown: { cacheScore: 0.9, qualityScore: 0.8 },
    cache_state: 'cached',
    rejected_count: 2,
    media_id: 'tt12345',
  });
  assert.equal(typeof id, 'number');
  assert.equal(store.countDecisions(), 1);
  store.close();
});

test('getRecentDecisions returns decisions in reverse chronological order', () => {
  const store = createSearchDecisionStore();
  store.recordDecision({ query: 'first', candidate_count: 5, timestamp: 1000 });
  store.recordDecision({ query: 'second', candidate_count: 10, timestamp: 2000 });
  store.recordDecision({ query: 'third', candidate_count: 15, timestamp: 3000 });

  const recent = store.getRecentDecisions(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].query, 'third');
  assert.equal(recent[1].query, 'second');
  store.close();
});

test('getDecisionsByQuery filters by query', () => {
  const store = createSearchDecisionStore();
  store.recordDecision({ query: 'movie', candidate_count: 5 });
  store.recordDecision({ query: 'show', candidate_count: 10 });
  store.recordDecision({ query: 'movie', candidate_count: 15 });

  const movieDecisions = store.getDecisionsByQuery('movie');
  assert.equal(movieDecisions.length, 2);
  assert.ok(movieDecisions.every(d => d.query === 'movie'));
  store.close();
});

test('recordDecision defaults timestamp to now', () => {
  const store = createSearchDecisionStore();
  const before = Date.now();
  store.recordDecision({ query: 'test', candidate_count: 1 });
  const after = Date.now();

  const decisions = store.getRecentDecisions(1);
  assert.ok(decisions[0].timestamp >= before && decisions[0].timestamp <= after);
  store.close();
});

test('recordDecision defaults rejected_count to 0', () => {
  const store = createSearchDecisionStore();
  store.recordDecision({ query: 'test', candidate_count: 1 });

  const decisions = store.getRecentDecisions(1);
  assert.equal(decisions[0].rejected_count, 0);
  store.close();
});

test('recordDecision defaults cache_state to unknown', () => {
  const store = createSearchDecisionStore();
  store.recordDecision({ query: 'test', candidate_count: 1 });

  const decisions = store.getRecentDecisions(1);
  assert.equal(decisions[0].cache_state, 'unknown');
  store.close();
});

test('decisionFromTrace extracts winner from trace', () => {
  const trace = {
    query: 'movie',
    pipeline: { discovered: 50 },
    candidates: [
      {
        rank: 1,
        hash: 'abcdef0123456789abcdef0123456789abcdef01',
        fileIndex: null,
        releaseKey: 'abcdef0123456789abcdef0123456789abcdef01:torrent',
        score: 0.875,
        source: 'corpus',
        provenance: {
          source: 'dmm-corpus',
          sourceType: 'stored',
          cacheState: 'cached',
        },
        justification: {
          scoreBreakdown: {
            cacheScore: 0.9,
            qualityScore: 0.85,
            sourceScore: 0.9,
            metadataScore: 0.3,
            popularityScore: 0.95,
          },
        },
      },
    ],
    rejections: [{ hash: 'other', reason: 'DUPLICATED', description: 'dup' }],
  };

  const decision = decisionFromTrace(trace, 'tt12345');
  assert.equal(decision.query, 'movie');
  assert.equal(decision.candidate_count, 50);
  assert.equal(decision.winning_release_key, 'abcdef0123456789abcdef0123456789abcdef01:torrent');
  assert.equal(decision.winner_source, 'dmm-corpus');
  assert.equal(decision.winner_score, 0.875);
  assert.equal(decision.cache_state, 'cached');
  assert.equal(decision.rejected_count, 1);
  assert.equal(decision.media_id, 'tt12345');
  assert.equal(decision.score_breakdown.cacheScore, 0.9);
  assert.equal(decision.score_breakdown.qualityScore, 0.85);
});

test('decisionFromTrace handles empty candidates', () => {
  const trace = {
    query: 'test',
    pipeline: { discovered: 0 },
    candidates: [],
    rejections: [],
  };

  const decision = decisionFromTrace(trace);
  assert.equal(decision.query, 'test');
  assert.equal(decision.candidate_count, 0);
  assert.equal(decision.winning_release_key, null);
  assert.equal(decision.winner_score, null);
  assert.equal(decision.cache_state, 'unknown');
});

test('decisionFromTrace handles candidate without provenance', () => {
  const trace = {
    query: 'test',
    pipeline: { discovered: 1 },
    candidates: [
      {
        rank: 1,
        hash: 'abc123',
        fileIndex: null,
        releaseKey: 'abc123:torrent',
        score: 0.5,
        source: 'corpus',
        justification: { scoreBreakdown: {} },
      },
    ],
    rejections: [],
  };

  const decision = decisionFromTrace(trace);
  assert.equal(decision.winner_source, 'corpus');
  assert.equal(decision.cache_state, 'unknown');
});
