/**
 * Household deferred-request tranche — focused proof.
 *
 * A Seerr request HashSucker cannot fulfill yet must become durable
 * scheduled intent automatically:
 *  1. classifier: future vs released vs transient vs hard (pure)
 *  2. zero-candidate movie webhook → 202 deferred + future_intent row
 *  3. duplicate webhook → no duplicate intent (idempotent)
 *  4. exact S/E isolation in the store
 *  5. transient throw → deferred; deterministic throw → 500, no intent
 *  6. MEDIA_DECLINED/MEDIA_DELETED → withdraw pending rows only
 *  7. MEDIA_FAILED stays ignored (fulfillment problem, not cancellation)
 *  8. revive: withdrawn/exhausted rows re-arm on fresh demand
 *
 * Run:
 *   node --test test/seerr-defer.test.js
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createRequestHandler } from '../src/server/app.js';
import { buildSeerrIntent } from '../src/lib/intents/providers/seerr.js';
import {
  classifySeerrDeferral,
  parseReleaseDateMs,
  DEFER_REASONS,
} from '../src/lib/defers/seerr-defer.js';
import { createAnticipationScheduler } from '../src/lib/anticipation/scheduler.js';

const TOKEN = 'test-seerr-defer-token';
const NOW = Date.parse('2026-09-13T12:00:00Z');

// ---------------------------------------------------------------------------
// 1. Pure classifier
// ---------------------------------------------------------------------------

test('classifier: future release date → future-not-released with expectedAt', () => {
  const r = classifySeerrDeferral({
    dateRaw: '2026-12-18',
    total: 0,
    selectionReason: 'no candidates',
    nowMs: NOW,
  });
  assert.equal(r.outcome, DEFER_REASONS.FUTURE_NOT_RELEASED);
  assert.equal(r.retryable, true);
  assert.equal(r.expectedAt, Date.parse('2026-12-18'));
});

test('classifier: past date → released-no-candidate (expectedAt preserved)', () => {
  const r = classifySeerrDeferral({ dateRaw: '2024-02-27', total: 0, nowMs: NOW });
  assert.equal(r.outcome, DEFER_REASONS.RELEASED_NO_CANDIDATE);
  assert.equal(r.retryable, true);
  assert.equal(r.expectedAt, Date.parse('2024-02-27'));
});

test('classifier: unknown date → released-no-candidate with null expectedAt', () => {
  for (const dateRaw of [null, '', 'not-a-date', '2199-13-99', '1800-01-01']) {
    const r = classifySeerrDeferral({ dateRaw, total: 0, nowMs: NOW });
    assert.equal(r.outcome, DEFER_REASONS.RELEASED_NO_CANDIDATE, `dateRaw=${dateRaw}`);
    assert.equal(r.retryable, true);
    assert.equal(r.expectedAt, null, `dateRaw=${dateRaw}`);
  }
});

test('classifier: candidates present → fulfilled, never retryable', () => {
  const r = classifySeerrDeferral({ dateRaw: '2026-12-18', total: 3, nowMs: NOW });
  assert.equal(r.outcome, 'fulfilled');
  assert.equal(r.retryable, false);
});

test('classifier: candidates without a binding → candidate-not-fulfillable', () => {
  const r = classifySeerrDeferral({ dateRaw: '2026-12-16', total: 3, bound: false, nowMs: NOW });
  assert.equal(r.outcome, DEFER_REASONS.CANDIDATE_NOT_FULFILLABLE);
  assert.equal(r.retryable, true);
  assert.equal(r.expectedAt, Date.parse('2026-12-16'));
});

test('classifier: transient throw → candidate-not-fulfillable (retryable)', () => {
  const r = classifySeerrDeferral({
    dateRaw: '2024-01-01',
    total: null,
    error: new Error('TorBox inventory timeout after 8000ms'),
    nowMs: NOW,
  });
  assert.equal(r.outcome, DEFER_REASONS.CANDIDATE_NOT_FULFILLABLE);
  assert.equal(r.retryable, true);
});

test('classifier: deterministic throws → hard-failure (never retry)', () => {
  for (const msg of [
    'mediaId is required',
    'unsupported media type: audio',
    'hydrateMovie not provided to searchByMedia',
    'seerr-identity-unresolved: tmdb=1396 reason=identity-unavailable',
    'malformed request body',
  ]) {
    const r = classifySeerrDeferral({ total: null, error: new Error(msg), nowMs: NOW });
    assert.equal(r.outcome, DEFER_REASONS.HARD_FAILURE, `msg=${msg}`);
    assert.equal(r.retryable, false, `msg=${msg}`);
  }
});

test('parseReleaseDateMs: accepts ISO dates, rejects fabrication bait', () => {
  assert.equal(parseReleaseDateMs('2024-02-27'), Date.parse('2024-02-27'));
  assert.equal(parseReleaseDateMs('2026-12-18T00:00:00.000Z'), Date.parse('2026-12-18T00:00:00.000Z'));
  assert.equal(parseReleaseDateMs(null), null);
  assert.equal(parseReleaseDateMs(''), null);
  assert.equal(parseReleaseDateMs('soon'), null);
  assert.equal(parseReleaseDateMs('1500-01-01'), null);
  assert.equal(parseReleaseDateMs('2500-01-01'), null);
});

// ---------------------------------------------------------------------------
// 2-5. Store convergence semantics
// ---------------------------------------------------------------------------

function memStore() {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  return { cache, store: createFutureIntentStore({ db: cache.db }) };
}

test('store: idempotent seed — duplicate creates no second row', () => {
  const { store } = memStore();
  const a = store.seed({ mediaType: 'movie', mediaId: 'tt1', source: 'seerr:req-1', deferReason: 'released-no-candidate' });
  const b = store.seed({ mediaType: 'movie', mediaId: 'tt1', source: 'seerr:req-1', deferReason: 'released-no-candidate' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.intent.id, a.intent.id);
  assert.equal(store.list().length, 1);
});

test('store: duplicate seed fills missing expected_at/defer_reason, never clobbers', () => {
  const { store } = memStore();
  const a = store.seed({ mediaType: 'movie', mediaId: 'tt2', source: 'seerr:req-a' });
  assert.equal(a.intent.expected_at, null);
  const b = store.seed({
    mediaType: 'movie', mediaId: 'tt2', source: 'arr:other',
    expectedAt: 1234567890, deferReason: 'future-not-released',
  });
  assert.equal(b.created, false);
  assert.equal(b.intent.expected_at, 1234567890);
  assert.equal(b.intent.defer_reason, 'future-not-released');
  assert.equal(b.intent.source, 'seerr:req-a', 'first seeder keeps provenance');
  // A worse (null) duplicate must not erase the filled values.
  const c = store.seed({ mediaType: 'movie', mediaId: 'tt2', source: 'seerr:req-b' });
  assert.equal(c.intent.expected_at, 1234567890);
  assert.equal(c.intent.defer_reason, 'future-not-released');
});

test('store: exact S/E isolation — same series, different episodes diverge', () => {
  const { store } = memStore();
  const e1 = store.seed({ mediaType: 'series', mediaId: 'ttS', season: 1, episode: 1, source: 'seerr:req-s:1:1' });
  const e2 = store.seed({ mediaType: 'series', mediaId: 'ttS', season: 1, episode: 2, source: 'seerr:req-s:1:2' });
  assert.notEqual(e1.intent.id, e2.intent.id);
  assert.equal(store.findByIdentity({ mediaId: 'ttS', season: 1, episode: 1 }).id, e1.intent.id);
  assert.equal(store.findByIdentity({ mediaId: 'ttS', season: 1, episode: 3 }), null);
});

test('store: revive re-arms withdrawn/exhausted rows, ignores live ones', () => {
  const { store } = memStore();
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'ttR', source: 'seerr:req-r' });
  store.transition(intent.id, 'withdrawn', { last_error: 'arr-unmonitored' });
  assert.equal(store.revive(intent.id, { deferReason: 'released-no-candidate' }), true);
  const row = store.findByIdentity({ mediaId: 'ttR' });
  assert.equal(row.state, 'anticipated');
  assert.equal(row.attempts, 0);
  assert.equal(row.defer_reason, 'released-no-candidate');
  // Live rows are untouched.
  assert.equal(store.revive(row.id), false);
});

test('store: hasPendingForMedia distinguishes waiting from done', () => {
  const { store } = memStore();
  assert.equal(store.hasPendingForMedia('ttX'), false);
  assert.equal(store.hasPendingForMedia(null), false);
  store.seed({ mediaType: 'series', mediaId: 'ttX', season: 2, episode: 3, source: 'seerr:req-x' });
  assert.equal(store.hasPendingForMedia('ttX'), true);
  const row = store.findByIdentity({ mediaId: 'ttX', season: 2, episode: 3 });
  store.transition(row.id, 'playable', { torrent_file_id: 'tf_z' });
  assert.equal(store.hasPendingForMedia('ttX'), false);
});

// ---------------------------------------------------------------------------
// Scheduler exhaustion: deferred rows park, others die
// ---------------------------------------------------------------------------

function memScheduler(store) {
  return createAnticipationScheduler({
    store,
    baseUrl: 'http://test:3000',
    fetchFn: async () => { throw new Error('must-not-call-network'); },
    clock: () => 1_000_000,
    log: () => {},
  });
}

test('scheduler: exhausted deferred row re-arms at low cadence, never dies', async () => {
  const { cache, store } = memStore();
  const { intent } = store.seed({
    mediaType: 'movie', mediaId: 'ttZ', source: 'seerr:req-z',
    deferReason: 'released-no-candidate',
  });
  store.transition(intent.id, 'failed', { last_error: 'prepare-http-200', next_check_at: 1 });
  cache.db.prepare('UPDATE future_intents SET attempts = 6 WHERE id = ?').run(intent.id);
  const sched = memScheduler(store);
  const row = { ...store.findByIdentity({ mediaId: 'ttZ' }) };
  const r = await sched.processIntent(row);
  assert.equal(r.acted, true);
  assert.equal(r.to, 'anticipated');
  assert.equal(r.rearmed, true);
  const after = store.findByIdentity({ mediaId: 'ttZ' });
  assert.equal(after.state, 'anticipated');
  assert.ok(after.next_check_at > 1_000_000 + 6 * 86400 * 1000, 're-armed ~7d out, not hot-looped');
});

test('scheduler: exhausted non-deferred row still dies (no behavior change)', async () => {
  const { cache, store } = memStore();
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'ttD', source: 'operator' });
  store.transition(intent.id, 'failed', { last_error: 'prepare-http-400', next_check_at: 1 });
  cache.db.prepare('UPDATE future_intents SET attempts = 6 WHERE id = ?').run(intent.id);
  const sched = memScheduler(store);
  const row = { ...store.findByIdentity({ mediaId: 'ttD' }) };
  const r = await sched.processIntent(row);
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'attempts-exhausted');
});

test('store: withdrawSeerrRequest hits parent+children, spares prepared and foreign rows', () => {
  const { store } = memStore();
  const parent = store.seed({ mediaType: 'series', mediaId: 'ttW', source: 'seerr:req-w' });
  const child = store.seed({ mediaType: 'series', mediaId: 'ttW', season: 1, episode: 1, source: 'seerr:req-w:s1:e1' });
  const ready = store.seed({ mediaType: 'movie', mediaId: 'ttP', source: 'seerr:req-w' });
  store.transition(ready.intent.id, 'prepared', { torrent_file_id: 'tf_x' });
  const other = store.seed({ mediaType: 'movie', mediaId: 'ttO', source: 'seerr:req-other' });
  const n = store.withdrawSeerrRequest('req-w', 'seerr-withdrawn:MEDIA_DECLINED');
  assert.equal(n, 2, 'parent + child withdraw');
  assert.equal(store.findByIdentity({ mediaId: 'ttW' }).state, 'withdrawn');
  assert.equal(store.findByIdentity({ mediaId: 'ttW', season: 1, episode: 1 }).state, 'withdrawn');
  assert.equal(store.findByIdentity({ mediaId: 'ttP' }).state, 'prepared', 'prepared truth survives');
  assert.equal(other.intent.id != null && store.findByIdentity({ mediaId: 'ttO' }).state, 'anticipated');
  assert.equal(store.withdrawSeerrRequest('', 'x'), 0);
  assert.equal(store.withdrawSeerrRequest('req-missing', 'x'), 0);
});

// ---------------------------------------------------------------------------
// 6-7. Withdrawal notification classification
// ---------------------------------------------------------------------------

function withdrawalPayload(type, requestId) {
  return {
    notification_type: type,
    subject: 'cancel test',
    media: { media_type: 'movie', imdbId: 'tt0133093', tmdbId: '603', tvdbId: null },
    request: { request_id: requestId },
    extra: [],
  };
}

test('buildSeerrIntent: MEDIA_DECLINED/MEDIA_DELETED → withdrawal signal', () => {
  for (const type of ['MEDIA_DECLINED', 'MEDIA_DELETED']) {
    const r = buildSeerrIntent(withdrawalPayload(type, 'req-cancel-1'));
    assert.equal(r.ok, true, type);
    assert.equal(r.withdrawal, true, type);
    assert.equal(r.intent.sourceId, 'req-cancel-1', type);
  }
});

test('buildSeerrIntent: MEDIA_FAILED stays ignored (fulfillment problem, not cancel)', () => {
  const r = buildSeerrIntent(withdrawalPayload('MEDIA_FAILED', 'req-fail-1'));
  assert.equal(r.ignored, true);
});

// ---------------------------------------------------------------------------
// Handler-level: deferred response contract + idempotency
// ---------------------------------------------------------------------------

function buildCache() {
  return createDiscoveryCache({ dbPath: ':memory:' });
}

function buildHandler(cache) {
  // Harness drift note: createRequestHandler unconditionally builds the
  // playback revalidator chain, which requires a terminal evidence store.
  // Seerr ingress never touches playback; an inert stub keeps these tests
  // on the ingress path without standing up provider machinery.
  return createRequestHandler({ searchCache: cache, terminalEvidenceStore: { get: () => null, set: () => {} } });
}

async function postJson(handler, urlPath, body, headers = {}) {
  const input = Readable.from([Buffer.from(JSON.stringify(body))]);
  input.method = 'POST';
  input.url = urlPath;
  input.headers = { ...headers };
  return new Promise((resolve, reject) => {
    const chunks = [];
    const response = {
      writeHead(status, responseHeaders) {
        this.status = status;
        this.responseHeaders = responseHeaders;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') });
      },
    };
    handler(input, response).catch(reject);
  });
}

test('handler: zero-candidate movie → 202 deferred + durable future intent', async () => {
  process.env.SEERR_WEBHOOK_TOKEN = TOKEN;
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'No candidates available',
      media: { media_type: 'movie', imdbId: 'tt99999991', tmdbId: '99999991', tvdbId: null },
      request: { request_id: 'req-defer-001' },
      extra: [],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 202, `expected 202 deferred, got: ${res.text}`);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'deferred');
    assert.equal(body.deferReason, 'released-no-candidate');
    assert.ok(body.futureIntentId > 0, 'response carries the durable intent id');
    assert.ok(body.nextCheckAt > 0, 'response carries next retry');
    const rows = cache.db.prepare("SELECT * FROM future_intents WHERE media_id = 'tt99999991'").all();
    assert.equal(rows.length, 1, 'exactly one durable intent');
    assert.equal(rows[0].source, 'seerr:req-defer-001');
    assert.equal(rows[0].state, 'anticipated');
    assert.equal(rows[0].defer_reason, 'released-no-candidate');
    // The media_intent row is durable and NOT an error.
    const mi = cache.db.prepare("SELECT last_error FROM media_intents WHERE source_id = 'req-defer-001'").get();
    assert.equal(mi.last_error, null);
  } finally {
    delete process.env.SEERR_WEBHOOK_TOKEN;
  }
});

test('handler: duplicate deferred webhook re-drives while still pending, no second intent', async () => {
  process.env.SEERR_WEBHOOK_TOKEN = TOKEN;
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'dup test',
      media: { media_type: 'movie', imdbId: 'tt99999992', tmdbId: '99999992', tvdbId: null },
      request: { request_id: 'req-defer-002' },
      extra: [],
    };
    const first = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    const second = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(first.status, 202);
    // Still pending → redelivery re-drives the pipeline (converge now,
    // not at the next scheduler tick) onto the SAME durable row.
    assert.equal(second.status, 202);
    assert.equal(JSON.parse(first.text).futureIntentId, JSON.parse(second.text).futureIntentId);
    const rows = cache.db.prepare("SELECT * FROM future_intents WHERE media_id = 'tt99999992'").all();
    assert.equal(rows.length, 1, 'redelivery must not duplicate durable intent');
  } finally {
    delete process.env.SEERR_WEBHOOK_TOKEN;
  }
});

test('handler: MEDIA_DECLINED withdraws pending intent, spares prepared rows', async () => {
  process.env.SEERR_WEBHOOK_TOKEN = TOKEN;
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const approval = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'will cancel',
      media: { media_type: 'movie', imdbId: 'tt99999993', tmdbId: '99999993', tvdbId: null },
      request: { request_id: 'req-defer-003' },
      extra: [],
    };
    const created = await postJson(handler, '/api/ingress/seerr', approval, { authorization: `Bearer ${TOKEN}` });
    assert.equal(created.status, 202);
    const declined = await postJson(
      handler, '/api/ingress/seerr',
      withdrawalPayload('MEDIA_DECLINED', 'req-defer-003'),
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(declined.status, 200);
    const body = JSON.parse(declined.text);
    assert.equal(body.status, 'withdrawn');
    assert.equal(body.withdrawn, 1);
    const row = cache.db.prepare("SELECT state FROM future_intents WHERE media_id = 'tt99999993'").get();
    assert.equal(row.state, 'withdrawn');
    // Unknown request id: acknowledged, nothing pending.
    const ghost = await postJson(
      handler, '/api/ingress/seerr',
      withdrawalPayload('MEDIA_DELETED', 'req-never-existed'),
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(JSON.parse(ghost.text).status, 'withdrawal-nothing-pending');
  } finally {
    delete process.env.SEERR_WEBHOOK_TOKEN;
  }
});
