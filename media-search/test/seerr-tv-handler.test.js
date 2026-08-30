/**
 * Seerr TV Handler — Focused Pass 2 Tests
 *
 * Scope: handleSeerrIngress TV fan-out control flow. Validates the
 * end-to-end contract:
 *  - one requested season → N concrete child scopes
 *  - parent never reaches searchByMedia (no media_request row)
 *  - children have mediaType='tv' with correct season/episode
 *  - child intentId reaches media_request FK
 *  - duplicate successful parent does not fan out again
 *  - partial prior failure can retry
 *  - already-successful children are skipped on retry
 *  - malformed/missing Requested Seasons fails explicitly
 *
 * No full suite. No production canary. No dynamic imports.
 *
 * Run:
 *   node --test test/seerr-tv-handler.test.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createRequestHandler } from '../src/server/app.js';

const TOKEN = 'test-seerr-token-deadbeef';

function buildCache() {
  return createDiscoveryCache({ dbPath: ':memory:' });
}

function buildHandler(cache) {
  return createRequestHandler({ searchCache: cache });
}

function setSeerrToken() {
  process.env.SEERR_WEBHOOK_TOKEN = TOKEN;
}

function clearSeerrToken() {
  delete process.env.SEERR_WEBHOOK_TOKEN;
}

/**
 * Seed one candidate row so searchByMedia can return a non-empty result
 * and create a media_request row (mirrors the helper in seerr-ingress.test.js).
 */
function seedCandidateForMedia(cache, mediaId, infoHash, fileIndex = 0) {
  const now = Date.now();
  const fiKey = fileIndex == null ? -1 : fileIndex;
  cache.db.prepare(`
    INSERT INTO candidates (info_hash, file_index, file_index_key, filename, size, first_seen, last_seen, metadata, sources)
    VALUES (@info_hash, @file_index, @fi_key, 'Test.Show.2020.S01E01.1080p.mkv', 1000000000, @now, @now, '{}', '[]')
  `).run({ info_hash: infoHash, file_index: fileIndex, fi_key: fiKey, now });
  cache.db.prepare(`
    INSERT OR IGNORE INTO candidate_media
      (info_hash, file_index_key, media_id, source, confidence, evidence, associated_at)
    VALUES (@info_hash, @fi_key, @media_id, 'seerr', 0.9, '{}', @now)
  `).run({ info_hash: infoHash, fi_key: fiKey, media_id: mediaId, now });
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
        resolve({
          status: this.status,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      },
    };
    try {
      handler(input, response, (err) => err && reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Build a Seerr stub that:
 *  - /api/v1/tv/<tmdbId>           → returns imdbId
 *  - /api/v1/tv/<tmdbId>/season/N  → returns up to episodeCount episodes
 *                                     with episodeNumber, name, airDate, id
 *  - everything else                → 404
 */
function makeSeerrStub({ seasonEpisodes = 7 } = {}) {
  return http.createServer((req, res) => {
    const seasonMatch = /^\/api\/v1\/tv\/(\d+)\/season\/(\d+)$/.exec(req.url);
    if (seasonMatch) {
      const seasonNum = Number(seasonMatch[2]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        seasonNumber: seasonNum,
        episodes: Array.from({ length: seasonEpisodes }, (_, i) => ({
          episodeNumber: i + 1,
          name: `S${seasonNum}E${i + 1}`,
          airDate: '2020-01-01',
          id: i + 1,
        })),
      }));
      return;
    }
    if (/^\/api\/v1\/tv\/\d+$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ imdbId: 'tt0903747' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

// ---------------------------------------------------------------------------
// Core fan-out
// ---------------------------------------------------------------------------

test('TV handler: one requested season → N concrete child scopes; parent never reaches searchByMedia', async () => {
  const seerrStub = makeSeerrStub({ seasonEpisodes: 7 });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  setSeerrToken();
  const prevUrl = process.env.SEERR_URL;
  const prevKey = process.env.SEERR_API_KEY;
  process.env.SEERR_URL = `http://127.0.0.1:${seerrStub.address().port}`;
  process.env.SEERR_API_KEY = 'k';
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    // Seed a candidate for the resolved IMDb so searchByMedia has something
    // to persist as a media_request row.
    for (let i = 0; i < 7; i += 1) {
      seedCandidateForMedia(cache, 'tt0903747', `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb${String(i).padStart(2, '0')}`);
    }
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'Auto-approved Breaking Bad S1',
      media: { media_type: 'series', imdbId: null, tmdbId: '1396', tvdbId: null },
      request: { request_id: 'req-tv-fanout-pass2-001' },
      extra: [{ name: 'Requested Seasons', value: '1' }],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'tv-fan-out');
    assert.equal(body.mediaId, 'tt0903747');
    assert.equal(body.mediaType, 'series');
    assert.equal(body.parentIntentId > 0, true);
    assert.equal(body.childCount, 7);
    assert.equal(body.childResults.length, 7);

    // Every successful child must report a non-zero resultCount. This
    // proves the handler reads the real return contract `result.total`,
    // not a non-existent `result.resultCount`. With 7 seeded candidates
    // each child should report resultCount > 0.
    for (const r of body.childResults) {
      assert.ok(r.resultCount > 0,
        `child S${r.season}E${r.episode} must report nonzero resultCount, got ${r.resultCount}`);
    }

    // Children: mediaType=tv, season=1, episode=1..7
    const children = cache.db.prepare(
      "SELECT id, media_type, season, episode, source_id FROM media_intents WHERE media_type = 'tv' AND source = 'seerr' ORDER BY episode"
    ).all();
    assert.equal(children.length, 7);
    for (let i = 0; i < 7; i += 1) {
      assert.equal(children[i].season, 1);
      assert.equal(children[i].episode, i + 1);
      assert.equal(children[i].source_id, `req-tv-fanout-pass2-001:s1:e${i + 1}`);
    }

    // Parent never reaches searchByMedia — no media_requests row for parent
    const parentRequests = cache.db.prepare(
      'SELECT id FROM media_requests WHERE intent_id = ?'
    ).all(body.parentIntentId);
    assert.equal(parentRequests.length, 0, 'parent must not invoke searchByMedia');

    // Children each have a media_requests row whose intent_id matches the
    // child media_intents.id (FK linkage).
    const childIds = children.map((c) => c.id);
    const placeholders = childIds.map(() => '?').join(',');
    const childRequests = cache.db.prepare(
      `SELECT intent_id FROM media_requests WHERE intent_id IN (${placeholders})`
    ).all(...childIds);
    assert.equal(childRequests.length, 7, 'every child must have a media_request row');
    const linkedIntentIds = new Set(childRequests.map((r) => r.intent_id));
    for (const childId of childIds) {
      assert.equal(linkedIntentIds.has(childId), true,
        `child intent_id=${childId} must be linked from media_requests`);
    }
  } finally {
    if (prevUrl === undefined) delete process.env.SEERR_URL;
    else process.env.SEERR_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = prevKey;
    clearSeerrToken();
    seerrStub.close();
  }
});

// ---------------------------------------------------------------------------
// Duplicate successful parent
// ---------------------------------------------------------------------------

test('TV handler: duplicate successful parent → duplicate reply, no re-fan-out', async () => {
  const seerrStub = makeSeerrStub({ seasonEpisodes: 2 });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  setSeerrToken();
  const prevUrl = process.env.SEERR_URL;
  const prevKey = process.env.SEERR_API_KEY;
  process.env.SEERR_URL = `http://127.0.0.1:${seerrStub.address().port}`;
  process.env.SEERR_API_KEY = 'k';
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'dup',
      media: { media_type: 'series', imdbId: null, tmdbId: '1396', tvdbId: null },
      request: { request_id: 'req-tv-dup-pass2-002' },
      extra: [{ name: 'Requested Seasons', value: '1' }],
    };
    const first = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.text).status, 'tv-fan-out');

    const second = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(second.status, 200);
    const dupBody = JSON.parse(second.text);
    assert.equal(dupBody.status, 'duplicate');
    assert.equal(dupBody.intentId > 0, true);

    // No new child rows
    const parents = cache.db.prepare(
      "SELECT id FROM media_intents WHERE media_type = 'series' AND source = 'seerr' AND source_id = 'req-tv-dup-pass2-002'"
    ).all();
    assert.equal(parents.length, 1);
    const children = cache.db.prepare(
      "SELECT id FROM media_intents WHERE media_type = 'tv' AND source_id LIKE 'req-tv-dup-pass2-002:%'"
    ).all();
    assert.equal(children.length, 2, 'children must be created exactly once');
  } finally {
    if (prevUrl === undefined) delete process.env.SEERR_URL;
    else process.env.SEERR_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = prevKey;
    clearSeerrToken();
    seerrStub.close();
  }
});

// ---------------------------------------------------------------------------
// Partial prior failure → retry
// ---------------------------------------------------------------------------

test('TV handler: partial prior failure → second webhook retries (does not short-circuit)', async () => {
  // Stub that fails the first 2 season calls, then succeeds on the 3rd.
  let seasonCallCount = 0;
  const seerrStub = http.createServer((req, res) => {
    const seasonMatch = /^\/api\/v1\/tv\/(\d+)\/season\/(\d+)$/.exec(req.url);
    if (seasonMatch) {
      seasonCallCount += 1;
      if (seasonCallCount <= 2) {
        res.writeHead(500);
        res.end('transient failure');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        seasonNumber: 1,
        episodes: [
          { episodeNumber: 1, name: 'E1', airDate: '2020-01-01', id: 1 },
        ],
      }));
      return;
    }
    if (/^\/api\/v1\/tv\/\d+$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ imdbId: 'tt0903747' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  setSeerrToken();
  const prevUrl = process.env.SEERR_URL;
  const prevKey = process.env.SEERR_API_KEY;
  process.env.SEERR_URL = `http://127.0.0.1:${seerrStub.address().port}`;
  process.env.SEERR_API_KEY = 'k';
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'partial fail',
      media: { media_type: 'series', imdbId: null, tmdbId: '1396', tvdbId: null },
      request: { request_id: 'req-tv-partial-pass2-003' },
      extra: [{ name: 'Requested Seasons', value: '1' }],
    };

    // First attempt: season API fails 2 times → eventually succeeds on
    // the 3rd (within the structural retry budget for this stub).
    const first = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(first.status, 500, 'first attempt must surface the structural failure');
    const firstBody = JSON.parse(first.text);
    assert.equal(firstBody.status, 'tv-fan-out-enumeration-failed');

    // Parent row exists with last_error set
    const parent = cache.db.prepare(
      "SELECT id, last_processed_at, last_error FROM media_intents WHERE media_type = 'series' AND source_id = 'req-tv-partial-pass2-003'"
    ).get();
    assert.ok(parent, 'parent must exist');
    assert.match(parent.last_error, /seerr-season-enumeration-failed/);

    // Reset stub: every season call now succeeds.
    let secondSeasonCount = 0;
    seerrStub.removeAllListeners('request');
    seerrStub.on('request', (req, res) => {
      const seasonMatch = /^\/api\/v1\/tv\/(\d+)\/season\/(\d+)$/.exec(req.url);
      if (seasonMatch) {
        secondSeasonCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          seasonNumber: 1,
          episodes: [
            { episodeNumber: 1, name: 'E1', airDate: '2020-01-01', id: 1 },
            { episodeNumber: 2, name: 'E2', airDate: '2020-01-08', id: 2 },
          ],
        }));
        return;
      }
      if (/^\/api\/v1\/tv\/\d+$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ imdbId: 'tt0903747' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const second = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(second.status, 200, second.text);
    const secondBody = JSON.parse(second.text);
    assert.equal(secondBody.status, 'tv-fan-out', 'retry must succeed (no permanent parent poisoning)');
    assert.equal(secondBody.childCount, 2);
    assert.equal(secondSeasonCount, 1);
  } finally {
    if (prevUrl === undefined) delete process.env.SEERR_URL;
    else process.env.SEERR_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = prevKey;
    clearSeerrToken();
    seerrStub.close();
  }
});

// ---------------------------------------------------------------------------
// Partial retry: one child completes, one child throws, retry must skip
// the completed one and re-invoke searchByMedia for the failed one.
// Asserted by concrete call counts on cache.persistMediaRequest and by
// the sourceIds that reached it — not by a 'skipped' response property.
// ---------------------------------------------------------------------------

test('TV handler: partial retry — completed child is skipped, failed child is re-invoked', async () => {
  const seerrStub = makeSeerrStub({ seasonEpisodes: 2 });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  setSeerrToken();
  const prevUrl = process.env.SEERR_URL;
  const prevKey = process.env.SEERR_API_KEY;
  process.env.SEERR_URL = `http://127.0.0.1:${seerrStub.address().port}`;
  process.env.SEERR_API_KEY = 'k';
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    // Seed a candidate for S01E01 only. S01E02 will fall through to live
    // discovery and either return zero results (if the stub is reachable)
    // or throw. We control determinism by instrumenting persistMediaRequest
    // to throw on the second child's call regardless of upstream behaviour.
    seedCandidateForMedia(cache, 'tt0903747', 'dddddddddddddddddddddddddddddddddddd00');

    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'partial retry',
      media: { media_type: 'series', imdbId: null, tmdbId: '1396', tvdbId: null },
      request: { request_id: 'req-tv-partial-retry-pass21' },
      extra: [{ name: 'Requested Seasons', value: '1' }],
    };

    // Instrument cache.persistMediaRequest to record every call and
    // throw deterministically when called for S01E02 on the FIRST
    // webhook only. (Persist is called once per child by searchByMedia
    // when persist:true; on retry we restore the original implementation
    // so S01E02 can complete.)
    const callLog = []; // { phase: 'first'|'second', sourceId, intentId }
    const originalPersist = cache.persistMediaRequest.bind(cache);
    let throwNextForS01E02 = true;
    cache.persistMediaRequest = function instrumented(intent, results) {
      const sourceId = intent?.sourceId ?? null;
      const intentId = intent?.intentId ?? null;
      const isS01E02 = sourceId === 'req-tv-partial-retry-pass21:s1:e2';
      callLog.push({ phase: throwNextForS01E02 ? 'first' : 'second', sourceId, intentId });
      if (isS01E02 && throwNextForS01E02) {
        // Make the second child's searchByMedia throw so the handler
        // records it on the child and continues. This is the
        // "child throws" half of the partial-retry scenario.
        const err = new Error('synthesized-episode-failure-s1e2');
        throw err;
      }
      return originalPersist(intent, results);
    };

    try {
      // ── First webhook: S01E01 completes, S01E02 throws.
      const first = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
      assert.equal(first.status, 200, first.text);
      const firstBody = JSON.parse(first.text);
      assert.equal(firstBody.status, 'tv-fan-out');
      assert.equal(firstBody.childCount, 2, 'both children are upserted even if one fails');

      // S01E01 reached persistMediaRequest exactly once and succeeded.
      // S01E02 reached persistMediaRequest exactly once and threw.
      const firstCalls = callLog.filter((c) => c.phase === 'first');
      assert.equal(firstCalls.length, 2, 'first webhook: both children called persistMediaRequest');
      const first01 = firstCalls.find((c) => c.sourceId === 'req-tv-partial-retry-pass21:s1:e1');
      const first02 = firstCalls.find((c) => c.sourceId === 'req-tv-partial-retry-pass21:s1:e2');
      assert.ok(first01, 'first webhook: S01E01 must reach persistMediaRequest');
      assert.ok(first02, 'first webhook: S01E02 must reach persistMediaRequest');

      // S01E01 has a completed media_request row; S01E02 has none.
      const s01e01Completed = cache.db.prepare(
        "SELECT id, status FROM media_requests WHERE intent_id = ? AND source = 'seerr'"
      ).all(first01.intentId);
      assert.equal(s01e01Completed.length, 1, 'S01E01 must have a media_request row');
      assert.equal(s01e01Completed[0].status, 'completed', 'S01E01 row must be completed');
      const s01e02Completed = cache.db.prepare(
        "SELECT id, status FROM media_requests WHERE intent_id = ?"
      ).all(first02.intentId);
      assert.equal(s01e02Completed.length, 0, 'S01E02 must have NO media_request row (throw)');

      // Child S01E02 has last_error recorded; parent is retryable.
      const parentRow = cache.db.prepare(
        "SELECT id, last_processed_at, last_error FROM media_intents WHERE media_type = 'series' AND source_id = 'req-tv-partial-retry-pass21'"
      ).get();
      assert.ok(parentRow, 'parent must exist');
      const s01e02Row = cache.db.prepare(
        "SELECT last_error FROM media_intents WHERE id = ?"
      ).get(first02.intentId);
      assert.match(s01e02Row.last_error, /searchByMedia-failed/,
        'S01E02 must have a last_error recording the per-episode failure');

      // ── Second webhook (identical): stop throwing, let everything
      //    complete. The completed-skip path must short-circuit S01E01
      //    so it does NOT reach persistMediaRequest again, while S01E02
      //    is retried.
      throwNextForS01E02 = false;

      const second = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
      assert.equal(second.status, 200, second.text);
      const secondBody = JSON.parse(second.text);
      assert.equal(secondBody.status, 'tv-fan-out');
      assert.equal(secondBody.childCount, 2);

      // S01E01 must NOT have been passed to searchByMedia again — i.e.
      // persistMediaRequest must NOT have been called with S01E01's
      // sourceId on the second webhook. S01E02 must have been called.
      const secondCalls = callLog.filter((c) => c.phase === 'second');
      assert.equal(secondCalls.length, 1,
        'second webhook: only S01E02 must reach persistMediaRequest (S01E01 skipped)');
      assert.equal(secondCalls[0].sourceId, 'req-tv-partial-retry-pass21:s1:e2',
        'second webhook: the only persistMediaRequest call must be for S01E02');

      // S01E02 now has a completed media_request row.
      const s01e02AfterRetry = cache.db.prepare(
        "SELECT id, status FROM media_requests WHERE intent_id = ? AND source = 'seerr'"
      ).all(first02.intentId);
      assert.equal(s01e02AfterRetry.length, 1, 'S01E02 must have a media_request row after retry');
      assert.equal(s01e02AfterRetry[0].status, 'completed', 'S01E02 row must be completed after retry');

      // Final-state assertions after the second webhook succeeds:
      // the failed child and the parent must both be cleared of any
      // stale error, and the parent must be marked processed.
      const s01e02RowAfter = cache.db.prepare(
        "SELECT last_error, last_processed_at FROM media_intents WHERE id = ?"
      ).get(first02.intentId);
      assert.equal(s01e02RowAfter.last_error, null,
        'previously-failed child must have last_error cleared after retry succeeds');
      const parentRowAfter = cache.db.prepare(
        "SELECT last_error, last_processed_at FROM media_intents WHERE id = ?"
      ).get(parentRow.id);
      assert.equal(parentRowAfter.last_error, null,
        'parent must have last_error cleared when retry completes');
      assert.notEqual(parentRowAfter.last_processed_at, null,
        'parent must have last_processed_at set when retry completes');

      // Total persistMediaRequest call count across both webhooks: 3
      // (S01E01 ×1, S01E02 ×2 — S01E02 retried).
      assert.equal(callLog.length, 3,
        'total persistMediaRequest calls = S01E01 once + S01E02 twice (one throw, one success)');
    } finally {
      cache.persistMediaRequest = originalPersist;
    }
  } finally {
    if (prevUrl === undefined) delete process.env.SEERR_URL;
    else process.env.SEERR_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = prevKey;
    clearSeerrToken();
    seerrStub.close();
  }
});

// ---------------------------------------------------------------------------
// Malformed / missing Requested Seasons
// ---------------------------------------------------------------------------

test('TV handler: missing Requested Seasons entry → parse-failed, parent last_error, no fan-out', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'missing season entry',
      media: { media_type: 'series', imdbId: 'tt0903747', tmdbId: '1396', tvdbId: null },
      request: { request_id: 'req-tv-missing-pass2-005' },
      extra: [{ name: 'Other', value: 'whatever' }],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'parse-failed');
    assert.equal(body.reason, 'requested-seasons-missing');
    const parent = cache.getMediaIntent(body.intentId);
    assert.match(parent.lastError, /extra-season-parse-failed/);
    // Parent must not have a media_request row (no searchByMedia).
    const reqs = cache.db.prepare('SELECT id FROM media_requests WHERE intent_id = ?').all(body.intentId);
    assert.equal(reqs.length, 0);
  } finally {
    clearSeerrToken();
  }
});

test('TV handler: malformed Requested Seasons value → parse-failed, parent last_error, no fan-out', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'malformed season value',
      media: { media_type: 'series', imdbId: 'tt0903747', tmdbId: '1396', tvdbId: null },
      request: { request_id: 'req-tv-malformed-pass2-006' },
      extra: [{ name: 'Requested Seasons', value: 'Season 1, 3' }],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'parse-failed');
    assert.match(body.reason, /extra-season-value-not-positive-integer/);
    const parent = cache.getMediaIntent(body.intentId);
    assert.match(parent.lastError, /extra-season-parse-failed/);
  } finally {
    clearSeerrToken();
  }
});

// ---------------------------------------------------------------------------
// Multiple requested seasons
// ---------------------------------------------------------------------------

test('TV handler: multiple requested seasons → episodes enumerated per season in one call', async () => {
  const seerrStub = makeSeerrStub({ seasonEpisodes: 3 });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  setSeerrToken();
  const prevUrl = process.env.SEERR_URL;
  const prevKey = process.env.SEERR_API_KEY;
  process.env.SEERR_URL = `http://127.0.0.1:${seerrStub.address().port}`;
  process.env.SEERR_API_KEY = 'k';
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'multi-season',
      media: { media_type: 'series', imdbId: null, tmdbId: '1396', tvdbId: null },
      request: { request_id: 'req-tv-multi-pass2-007' },
      extra: [{ name: 'Requested Seasons', value: '1, 2' }],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'tv-fan-out');
    assert.equal(body.childCount, 6, '3 episodes × 2 seasons');
    const seasons = new Set(body.childResults.map((r) => r.season));
    assert.deepEqual([...seasons].sort((a, b) => a - b), [1, 2]);
  } finally {
    if (prevUrl === undefined) delete process.env.SEERR_URL;
    else process.env.SEERR_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = prevKey;
    clearSeerrToken();
    seerrStub.close();
  }
});

// ---------------------------------------------------------------------------
// TV externalIds fallback (production contract)
//
// Real Seerr TV detail responses do NOT carry `imdbId` on the root
// object — the IMDb id lives under `externalIds.imdbId`. The handler
// must fall back to that shape so a real Seerr TV request resolves
// the same way a movie request does.
// ---------------------------------------------------------------------------

/**
 * Build a Seerr stub that mirrors the real Seerr TV detail payload
 * shape: no root `imdbId`, IMDb lives on `externalIds.imdbId`.
 */
function makeSeerrStubTvExternalIds({ seasonEpisodes = 3 } = {}) {
  return http.createServer((req, res) => {
    const seasonMatch = /^\/api\/v1\/tv\/(\d+)\/season\/(\d+)$/.exec(req.url);
    if (seasonMatch) {
      const seasonNum = Number(seasonMatch[2]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        seasonNumber: seasonNum,
        episodes: Array.from({ length: seasonEpisodes }, (_, i) => ({
          episodeNumber: i + 1,
          name: `S${seasonNum}E${i + 1}`,
          airDate: '2020-01-01',
          id: i + 1,
        })),
      }));
      return;
    }
    if (/^\/api\/v1\/tv\/\d+$/.test(req.url)) {
      // Real-world Seerr TV detail: root imdbId absent; IMDb id is on
      // the nested `externalIds` object.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 1396,
        name: 'Breaking Bad',
        originalName: 'Breaking Bad',
        firstAirDate: '2008-01-20',
        externalIds: {
          imdbId: 'tt0903747',
          tvdbId: 81189,
          facebookId: null,
          instagramId: null,
          twitterId: null,
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test('TV handler: TV detail with externalIds.imdbId (no root imdbId) resolves and fans out', async () => {
  const seerrStub = makeSeerrStubTvExternalIds({ seasonEpisodes: 3 });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  setSeerrToken();
  const prevUrl = process.env.SEERR_URL;
  const prevKey = process.env.SEERR_API_KEY;
  process.env.SEERR_URL = `http://127.0.0.1:${seerrStub.address().port}`;
  process.env.SEERR_API_KEY = 'k';
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'TV externalIds',
      media: { media_type: 'series', imdbId: null, tmdbId: '1396', tvdbId: null },
      request: { request_id: 'req-tv-external-ids-008' },
      extra: [{ name: 'Requested Seasons', value: '1' }],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'tv-fan-out');
    assert.equal(body.childCount, 3, '3 episodes for the single requested season');
    // Every child must carry the IMDb id resolved from externalIds,
    // and the parent must be the series-level intent with that IMDb.
    const parent = cache.getMediaIntent(body.parentIntentId);
    assert.ok(parent, 'parent intent must exist');
    assert.equal(parent.imdbId, 'tt0903747');
    const children = cache.db.prepare(
      "SELECT * FROM media_intents WHERE source='seerr' AND media_type='tv' ORDER BY season, episode"
    ).all();
    assert.equal(children.length, 3);
    for (const c of children) {
      assert.equal(c.imdb_id, 'tt0903747', `child ${c.id} imdb_id`);
      assert.equal(c.season, 1);
    }
    // The parent's last_error must be null and last_processed_at set,
    // proving identity was resolved (not the prior production failure).
    assert.equal(parent.lastError, null);
    assert.notEqual(parent.lastProcessedAt, null);
  } finally {
    if (prevUrl === undefined) delete process.env.SEERR_URL;
    else process.env.SEERR_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = prevKey;
    clearSeerrToken();
    seerrStub.close();
  }
});

test('TV handler: TV detail with no usable IMDb (no root, no externalIds) is an explicit identity failure, not a silent search', async () => {
  const seerrStub = http.createServer((req, res) => {
    const seasonMatch = /^\/api\/v1\/tv\/(\d+)\/season\/(\d+)$/.exec(req.url);
    if (seasonMatch) {
      const seasonNum = Number(seasonMatch[2]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        seasonNumber: seasonNum,
        episodes: [{ episodeNumber: 1, name: 'E1', airDate: '2020-01-01', id: 1 }],
      }));
      return;
    }
    if (/^\/api\/v1\/tv\/\d+$/.test(req.url)) {
      // Detail returns successfully but carries no IMDb anywhere.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 9999,
        name: 'No IMDb Show',
        originalName: 'No IMDb Show',
        firstAirDate: '2020-01-01',
        externalIds: { tvdbId: 12345 },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  setSeerrToken();
  const prevUrl = process.env.SEERR_URL;
  const prevKey = process.env.SEERR_API_KEY;
  process.env.SEERR_URL = `http://127.0.0.1:${seerrStub.address().port}`;
  process.env.SEERR_API_KEY = 'k';
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'TV no imdb',
      media: { media_type: 'series', imdbId: null, tmdbId: '9999', tvdbId: null },
      request: { request_id: 'req-tv-no-imdb-009' },
      extra: [{ name: 'Requested Seasons', value: '1' }],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    // Resolver returns identity-unresolved → handler returns 500 with
    // status 'identity-unresolved'. A retry must remain possible.
    assert.equal(res.status, 500, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'identity-unresolved');
    assert.equal(body.reason, 'identity-unresolved');
    // The parent must be persisted with an explicit last_error so a
    // operator can diagnose, and it must NOT have a media_request row
    // (we never reached searchByMedia).
    const parent = cache.db.prepare(
      "SELECT * FROM media_intents WHERE source='seerr' AND source_id=?"
    ).get('req-tv-no-imdb-009');
    assert.ok(parent, 'parent intent must be persisted');
    assert.match(parent.last_error, /seerr-identity-unresolved/);
    const mediaReqs = cache.db.prepare(
      "SELECT * FROM media_requests WHERE source='seerr'"
    ).all();
    assert.equal(mediaReqs.length, 0, 'parent must never own a media_request row');
    // No TV children were created because identity failed before fan-out.
    const tvChildren = cache.db.prepare(
      "SELECT COUNT(*) AS c FROM media_intents WHERE source='seerr' AND media_type='tv'"
    ).get().c;
    assert.equal(tvChildren, 0, 'no children when identity fails');
  } finally {
    if (prevUrl === undefined) delete process.env.SEERR_URL;
    else process.env.SEERR_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = prevKey;
    clearSeerrToken();
    seerrStub.close();
  }
});
