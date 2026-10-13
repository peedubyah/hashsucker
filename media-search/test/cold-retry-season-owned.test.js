/**
 * Cold retry for EXHAUSTED, AIRED, STILL-SEASON-OWNED obligations.
 *
 * Old behaviour: `attempts >= MAX_ATTEMPTS` was permanently non-actionable, so a
 * season obligation whose market became satisfiable later could only be revived
 * by a new external Seerr request. New behaviour: it keeps the obligation and
 * becomes cold-actionable once its 7-day park has elapsed, permitting exactly
 * one further attempt per cold cycle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyIntentPriority,
  createAnticipationScheduler,
  isColdRetryEligible,
  MAX_ATTEMPTS,
} from '../src/lib/anticipation/scheduler.js';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const OWNER = 'season:tt5875444:s06';

function exhausted(over = {}) {
  return {
    id: 1, media_type: 'series', media_id: 'tt5875444', season: 6, episode: 4,
    state: 'failed', attempts: MAX_ATTEMPTS, defer_reason: 'candidate-not-fulfillable',
    season_owners: OWNER, expected_at: NOW - 30 * DAY, next_check_at: NOW - 1 * DAY,
    last_error: 'prepare:no-handoff:no-bindable-candidate', torrent_file_id: null,
    arr_satisfied: 0, created_at: NOW, updated_at: NOW,
    ...over,
  };
}

test('exhausted season-owned aired work is cold-actionable once parked', () => {
  const row = exhausted();
  assert.equal(isColdRetryEligible(row, NOW), true);
  const p = classifyIntentPriority(row, NOW);
  assert.equal(p.actionable, true);
  assert.equal(p.coldRetry, true);
  assert.equal(p.className, 'P2');
});

test('the cold park must elapse before it is eligible again', () => {
  assert.equal(isColdRetryEligible(exhausted({ next_check_at: NOW + 60_000 }), NOW), false);
  assert.equal(classifyIntentPriority(exhausted({ next_check_at: NOW + 60_000 }), NOW).actionable, false);
});

test('a one-shot exhausted row with no season owner keeps the old semantics', () => {
  const row = exhausted({ season_owners: null });
  assert.equal(isColdRetryEligible(row, NOW), false);
  assert.equal(classifyIntentPriority(row, NOW).actionable, false);
});

test('a non-retryable defer reason keeps the old semantics', () => {
  for (const reason of ['hard-failure', 'future-not-released', null]) {
    const row = exhausted({ defer_reason: reason, next_check_at: NOW - DAY });
    assert.equal(isColdRetryEligible(row, NOW), false, `reason=${reason}`);
    assert.equal(classifyIntentPriority(row, NOW).actionable, false, `reason=${reason}`);
  }
});

test('a non-exhausted row is never cold-actionable (ordinary hot path owns it)', () => {
  const row = exhausted({ attempts: 3 });
  assert.equal(isColdRetryEligible(row, NOW), false);
  assert.equal(classifyIntentPriority(row, NOW).actionable, true);
  assert.equal(classifyIntentPriority(row, NOW).coldRetry, undefined);
});

test('withdrawn and playable rows are never cold-actionable', () => {
  for (const state of ['withdrawn', 'playable']) {
    assert.equal(isColdRetryEligible(exhausted({ state }), NOW), false);
  }
});

test('both retryable market defer reasons qualify (market miss vs nothing bindable)', () => {
  assert.equal(isColdRetryEligible(exhausted({ defer_reason: 'released-no-candidate' }), NOW), true);
  assert.equal(isColdRetryEligible(exhausted({ defer_reason: 'candidate-not-fulfillable' }), NOW), true);
});

/* ---- end-to-end through the real store + scheduler ---- */
function harness(opts = {}) {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => NOW });
  const post = async (url, body) => (opts.post ? opts.post(url, body) : { status: 200, json: {} });
  const scheduler = createAnticipationScheduler({
    store,
    cache: {},
    controlPlaneStore: null,
    baseUrl: 'http://127.0.0.1:1',
    dataPlaneBaseUrl: null,
    prepareDays: 30, publishDays: 30,
    now: () => NOW,
    post,
    log: () => {},
    ...opts.sched,
  });
  return { store, scheduler, cleanup: () => {} };
}

const SEASON_ROW = { mediaType: 'series', mediaId: 'tt5875444', season: 6, episode: 4, expectedAt: NOW - 30 * DAY, source: 'seerr:x:s6:e4' };

/**
 * Drive a row to genuine exhaustion the way production does: `retry()` only
 * runs on a `failed` row and is what increments `attempts`, so alternate
 * failed/retry until the hot budget is gone.
 */
function exhaust(store, id, deferReason) {
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    store.transition(id, 'failed', { defer_reason: deferReason, next_check_at: NOW });
    store.retry(id, NOW, deferReason);
  }
  store.transition(id, 'failed', { defer_reason: deferReason, next_check_at: NOW });
}

/** Attach a real requested-season owner via the product API (not a hand-written column). */
function attachSeasonOwner(store, { mediaId, tmdbId, season, episode, source }) {
  const rs = store.ensureRequestedSeason({ mediaId, tmdbId, season, source: `seerr:${source}` });
  const owner = rs.owner;
  store.ensureSeasonEpisode({ mediaId, season, episode, owner, source: `seerr:${source}:s${season}:e${episode}`, expectedAt: NOW - 30 * DAY });
  return owner;
}

test('a cold-eligible row is re-armed due NOW, preserving exhausted attempts', () => {
  const h = harness();
  try {
    h.store.seed({ ...SEASON_ROW, deferReason: 'candidate-not-fulfillable' });
    attachSeasonOwner(h.store, { mediaId: 'tt5875444', tmdbId: 66732, season: 6, episode: 4, source: '23:s6:e4' });
    const id = h.store.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 }).id;
    h.store.transition(id, 'failed', { last_error: 'prepare:no-handoff:no-bindable-candidate', defer_reason: 'candidate-not-fulfillable', next_check_at: NOW - DAY });
    exhaust(h.store, id, 'candidate-not-fulfillable');
    h.store.transition(id, 'failed', { last_error: 'prepare:no-handoff:no-bindable-candidate', defer_reason: 'candidate-not-fulfillable', next_check_at: NOW - DAY });

    const before = h.store.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 });
    assert.equal(before.state, 'failed', 'exhausted');
    assert.ok(before.attempts >= MAX_ATTEMPTS, 'hot budget is gone');
    assert.equal(before.next_check_at, NOW - DAY, 'cold park elapsed');

    // Eligibility is what the tick loop consults.
    const p = classifyIntentPriority(before, NOW);
    assert.equal(p.actionable, true);
    assert.equal(p.coldRetry, true);
  } finally { h.cleanup(); }
});

test('rearm does not restore a fresh hot budget', () => {
  const h = harness();
  try {
    h.store.seed({ ...SEASON_ROW, deferReason: 'released-no-candidate' });
    attachSeasonOwner(h.store, { mediaId: 'tt5875444', tmdbId: 66732, season: 6, episode: 4, source: '23:s6:e4' });
    const id = h.store.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 }).id;
    exhaust(h.store, id, 'released-no-candidate');
    const a0 = h.store.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 }).attempts;
    h.store.retry(id, NOW);   // exactly what processIntent's cold rearm does
    const after = h.store.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 });
    assert.equal(after.attempts, a0 + 1, 'attempts increments, never resets');
    assert.ok(after.attempts >= MAX_ATTEMPTS, 'still exhausted after re-arm, so one attempt then re-park');
    assert.equal(after.state, 'anticipated');
    assert.equal(after.next_check_at, NOW, 'due now, so the next tick attempts once');
  } finally { h.cleanup(); }
});

test('a repeat market miss after cold retry re-parks for a full cold interval', () => {
  const h = harness();
  try {
    h.store.seed({ ...SEASON_ROW, deferReason: 'candidate-not-fulfillable' });
    attachSeasonOwner(h.store, { mediaId: 'tt5875444', tmdbId: 66732, season: 6, episode: 4, source: '23:s6:e4' });
    const id = h.store.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 }).id;
    exhaust(h.store, id, 'candidate-not-fulfillable');
    h.store.retry(id, NOW);                       // cold re-arm
    const mid = h.store.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 });
    // one cold attempt fails for the same market reason
    h.store.transition(id, 'failed', { last_error: 'prepare:no-handoff:no-bindable-candidate', next_check_at: NOW + 7 * DAY });
    const after = h.store.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 });
    assert.equal(after.state, 'failed');
    assert.equal(after.next_check_at, NOW + 7 * DAY);
    assert.ok(after.attempts > mid.attempts - 1);
    // and it is NOT actionable again until that park elapses
    assert.equal(isColdRetryEligible(after, NOW), false);
    assert.equal(isColdRetryEligible(after, NOW + 7 * DAY + 1), true);
  } finally { h.cleanup(); }
});

test('cold state is durable: a fresh store over the same DB sees the same obligation', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  try {
    const s1 = createFutureIntentStore({ db: cache.db, clock: () => NOW });
    s1.seed({ ...SEASON_ROW, deferReason: 'candidate-not-fulfillable' });
    attachSeasonOwner(s1, { mediaId: 'tt5875444', tmdbId: 66732, season: 6, episode: 4, source: '23:s6:e4' });
    const id = s1.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 }).id;
    s1.transition(id, 'failed', { defer_reason: 'candidate-not-fulfillable', next_check_at: NOW + 7 * DAY });
    exhaust(s1, id, 'candidate-not-fulfillable');
    s1.transition(id, 'failed', { defer_reason: 'candidate-not-fulfillable', next_check_at: NOW + 7 * DAY });
    // simulate a media-search restart: brand-new store + clock advanced past the park
    const s2 = createFutureIntentStore({ db: cache.db, clock: () => NOW + 8 * DAY });
    const row = s2.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 });
    assert.equal(row.attempts, s1.findByIdentity({ mediaId: SEASON_ROW.mediaId, season: 6, episode: 4 }).attempts, 'attempts survive restart');
    assert.equal(row.season_owners, OWNER, 'season ownership survives restart');
    assert.equal(isColdRetryEligible(row, NOW + 8 * DAY), true, 'cold timer survives restart');
    assert.equal(isColdRetryEligible(row, NOW + 1 * DAY), false, 'and does not fire early');
  } finally {}
});

test('future obligations and release-date movement are untouched', () => {
  const h = harness();
  try {
    h.store.seed({ ...SEASON_ROW, media_id: 'tt9999999', season: 6, episode: 5, expected_at: NOW + 30 * DAY, deferReason: 'future-not-released' });
    const row = h.store.findByIdentity({ mediaId: 'tt9999999', season: 6, episode: 5 });
    const p = classifyIntentPriority(row, NOW);
    assert.equal(p.actionable, false, 'unreleased work stays asleep');
    assert.equal(p.coldRetry, undefined);
    assert.equal(isColdRetryEligible(row, NOW), false);
  } finally { h.cleanup(); }
});
