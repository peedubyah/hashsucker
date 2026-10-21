/**
 * Selection-decision diagnostic.
 *
 * The diagnostic exists to answer one question after the fact: WHICH
 * candidate won, and WHY did every candidate ranked above it lose? The
 * persisted ranking (`media_request_results`) and the persisted winner
 * (`playback_handoffs`) do not carry the losers or the reasons, so without
 * this the question is unanswerable.
 *
 * The contract this file pins:
 *  - the diagnostic is APPEND-ONLY (no update, no delete path);
 *  - it is a DIAGNOSTIC: it never participates in selection and never
 *    changes the decision, the Binding, the TorrentFile, or the handoff;
 *  - it stores the raw skip reasons VERBATIM (no pre-classification);
 *  - a failure to write can NEVER fail the request.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { recordSelectionDecision } from '../src/api/media-request-stages.js';

function ctxStub(overrides = {}) {
  return {
    mediaId: 'tt0111161',
    mediaType: 'movie',
    season: null,
    episode: null,
    source: 'test',
    ...overrides,
  };
}

test('diagnostic: the decision and the skip reasons are recorded verbatim', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  try {
    const explainable = [
      { rank: 1, infoHash: 'a'.repeat(40), fileIndex: 3, score: 0.9 },
      { rank: 2, infoHash: 'b'.repeat(40), fileIndex: 0, score: 0.7 },
    ];
    const selection = {
      selected: { infoHash: 'b'.repeat(40), fileIndex: 0, rank: 2 },
      reason: 'exact-size bound',
      serviceability: { state: 'serviceable', reason: null },
      skipped: [
        { infoHash: 'a'.repeat(40), rank: 1, torboxState: 'cached', reason: 'movie-ambiguous' },
      ],
    };

    const rowId = recordSelectionDecision({
      cache, ctx: ctxStub(), requestId: 42, selection, explainable,
    });
    assert.ok(rowId > 0, 'a row was appended');

    const [row] = cache.listSelectionDecisions({ limit: 10 });
    assert.equal(row.requestId, 42);
    assert.equal(row.mediaId, 'tt0111161');
    assert.equal(row.reason, 'exact-size bound');
    assert.equal(row.selected.infoHash, 'b'.repeat(40));
    assert.equal(row.selected.rank, 2);
    assert.equal(row.selected.fileIndex, 0);
    assert.equal(row.candidateCount, 2);

    // The loser carries the RAW reason, not a classification.
    assert.equal(row.skipped.length, 1);
    assert.equal(row.skipped[0].rank, 1);
    assert.equal(row.skipped[0].infoHash, 'a'.repeat(40));
    assert.equal(row.skipped[0].reason, 'movie-ambiguous');
    assert.equal(row.skipped[0].torboxState, 'cached');
    // The file index of the loser is recovered from the ranked row.
    assert.equal(row.skipped[0].fileIndex, 3);
  } finally {
    cache.close();
  }
});

test('diagnostic: the table is append-only — a second decision adds a row, neither is changed', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  try {
    const selection = (hash, rank) => ({
      selected: { infoHash: hash, fileIndex: 0, rank },
      reason: 'exact-size bound',
      skipped: [],
    });
    recordSelectionDecision({ cache, ctx: ctxStub(), requestId: 1, selection: selection('a'.repeat(40), 1), explainable: [] });
    recordSelectionDecision({ cache, ctx: ctxStub(), requestId: 2, selection: selection('b'.repeat(40), 2), explainable: [] });

    const rows = cache.listSelectionDecisions({ limit: 10 });
    assert.equal(rows.length, 2, 'both decisions are retained');
    assert.deepEqual(rows.map((r) => r.requestId).sort(), [1, 2]);

    // There is no update or delete surface on the cache for this table.
    assert.equal(typeof cache.updateSelectionDecision, 'undefined');
    assert.equal(typeof cache.deleteSelectionDecision, 'undefined');
  } finally {
    cache.close();
  }
});

test('diagnostic: a write failure never propagates to the caller', () => {
  const brokenCache = {
    appendSelectionDecision() { throw new Error('disk is on fire'); },
  };
  const result = recordSelectionDecision({
    cache: brokenCache,
    ctx: ctxStub(),
    requestId: 7,
    selection: { selected: { infoHash: 'a'.repeat(40), fileIndex: 0, rank: 1 }, reason: 'x', skipped: [] },
    explainable: [],
  });
  assert.equal(result, null, 'the failure is contained');
});

test('diagnostic: a decision with no winner is still recorded (a miss is a fact)', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  try {
    recordSelectionDecision({
      cache,
      ctx: ctxStub(),
      requestId: 9,
      selection: { selected: null, reason: 'no-bindable-candidate', skipped: [{ infoHash: 'c'.repeat(40), rank: 1, reason: 'path-a-failed:NO_PLACEMENT' }] },
      explainable: [],
    });
    const [row] = cache.listSelectionDecisions({ limit: 10 });
    assert.equal(row.selected, null);
    assert.equal(row.reason, 'no-bindable-candidate');
    assert.equal(row.skipped[0].reason, 'path-a-failed:NO_PLACEMENT');
  } finally {
    cache.close();
  }
});

test('diagnostic: the recording does not mutate the selection it observes', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  try {
    const selection = {
      selected: { infoHash: 'a'.repeat(40), fileIndex: 0, rank: 1 },
      reason: 'exact-size bound',
      skipped: [{ infoHash: 'b'.repeat(40), rank: 2, reason: 'movie-ambiguous' }],
    };
    const before = JSON.stringify(selection);
    recordSelectionDecision({ cache, ctx: ctxStub(), requestId: 3, selection, explainable: [] });
    assert.equal(JSON.stringify(selection), before, 'the selection object is untouched');
  } finally {
    cache.close();
  }
});
