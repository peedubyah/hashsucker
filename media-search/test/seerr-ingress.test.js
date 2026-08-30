/**
 * Seerr Webhook Ingress — Focused Proof
 *
 * Validates the smallest production-ready ingress surface:
 *  1. no auth → 401
 *  2. wrong bearer token → 401
 *  3. correct token + valid movie payload → one Seerr intent
 *  4. same payload twice → still one intent
 *  5. IMDb/TMDB/TVDB bundle is preserved
 *  6. test/non-actionable notification does not create an intent
 *  7. malformed media payload → 400
 *
 * Run:
 *   node --test test/seerr-ingress.test.js
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createRequestHandler } from '../src/server/app.js';
import {
  buildSeerrIntent,
  checkSeerrAuth,
  deriveMediaIdentity,
  SEERR_CONSTANTS,
} from '../src/lib/intents/providers/seerr.js';

const TOKEN = 'test-seerr-token-deadbeef';
const VALID_PAYLOAD = {
  notification_type: 'MEDIA_AUTO_APPROVED',
  subject: 'Alice requested Inception',
  media: {
    media_type: 'movie',
    imdbId: 'tt1375666',
    tmdbId: '27205',
    tvdbId: null,
    plexRatingKey: '12345',
    jellyfinMediaId: null,
  },
  request: {
    request_id: 'req-abc-001',
  },
  extra: [],
};

function buildCache() {
  return createDiscoveryCache({ dbPath: ':memory:' });
}

function buildHandler(cache) {
  return createRequestHandler({ searchCache: cache });
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
          headers: this.responseHeaders,
        });
      },
    };
    handler(input, response).catch(reject);
  });
}

function setSeerrToken() {
  process.env.SEERR_WEBHOOK_TOKEN = TOKEN;
}
function clearSeerrToken() {
  delete process.env.SEERR_WEBHOOK_TOKEN;
}

test('seerr ingress: no Authorization header → 401', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const res = await postJson(handler, '/api/ingress/seerr', VALID_PAYLOAD);
    assert.equal(res.status, 401);
    assert.match(res.text, /missing-authorization/);
    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 0, 'no intent should be created');
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: wrong bearer token → 401', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const res = await postJson(
      handler,
      '/api/ingress/seerr',
      VALID_PAYLOAD,
      { authorization: 'Bearer not-the-real-token' },
    );
    assert.equal(res.status, 401);
    assert.match(res.text, /invalid-token/);
    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 0);
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: missing token in env → 503', async () => {
  clearSeerrToken();
  const cache = buildCache();
  const handler = buildHandler(cache);
  const res = await postJson(
    handler,
    '/api/ingress/seerr',
    VALID_PAYLOAD,
    { authorization: `Bearer ${TOKEN}` },
  );
  assert.equal(res.status, 503);
  assert.match(res.text, /service-misconfigured/);
});

test('seerr ingress: correct token + valid movie → one durable intent', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const res = await postJson(
      handler,
      '/api/ingress/seerr',
      VALID_PAYLOAD,
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'created');
    assert.equal(body.notificationType, 'MEDIA_AUTO_APPROVED');
    assert.equal(body.mediaId, 'tt1375666');
    assert.equal(body.imdbId, 'tt1375666');
    assert.equal(body.tmdbId, '27205');
    assert.equal(body.tvdbId, null);
    assert.ok(body.intentId > 0);

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 1, 'exactly one Seerr intent must be persisted');
    const intent = intents[0];
    assert.equal(intent.mediaId, 'tt1375666');
    assert.equal(intent.source, 'seerr');
    assert.equal(intent.sourceType, 'request');
    assert.equal(intent.sourceId, 'req-abc-001');
    assert.equal(intent.mediaType, 'movie');
    assert.equal(intent.imdbId, 'tt1375666');
    assert.equal(intent.tmdbId, '27205');
    assert.equal(intent.tvdbId, null);
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: same payload twice → still one intent (idempotent)', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const headers = { authorization: `Bearer ${TOKEN}` };

    const first = await postJson(handler, '/api/ingress/seerr', VALID_PAYLOAD, headers);
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.text).status, 'created');

    const second = await postJson(handler, '/api/ingress/seerr', VALID_PAYLOAD, headers);
    assert.equal(second.status, 200);
    assert.equal(JSON.parse(second.text).status, 'duplicate');

    const third = await postJson(handler, '/api/ingress/seerr', VALID_PAYLOAD, headers);
    assert.equal(third.status, 200);
    assert.equal(JSON.parse(third.text).status, 'duplicate');

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 1, 'duplicate deliveries must not create additional intent rows');
    // request_count reflects both the ingress upsert (1) and the immediate
    // downstream processing event (1). Duplicate webhooks take the duplicate
    // path and never reach either, so the count is stable across deliveries.
    assert.equal(intents[0].requestCount, 2, 'duplicate deliveries must not increment request_count');
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: IMDb/TMDB/TVDB bundle is preserved through persistence', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'Auto-approved: Severance',
      media: {
        media_type: 'tv',
        imdbId: 'tt11280740',
        tmdbId: '95396',
        tvdbId: '305288',
      },
      request: { request_id: 'req-bundle-002' },
      extra: [{ name: 'requestedSeasons', value: '[1]' }],
    };
    const res = await postJson(
      handler,
      '/api/ingress/seerr',
      payload,
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.imdbId, 'tt11280740');
    assert.equal(body.tmdbId, '95396');
    assert.equal(body.tvdbId, '305288');
    assert.equal(body.mediaId, 'tt11280740', 'IMDb is preferred when present');

    const stored = cache.getMediaIntent(body.intentId);
    assert.equal(stored.imdbId, 'tt11280740');
    assert.equal(stored.tmdbId, '95396');
    assert.equal(stored.tvdbId, '305288');
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: TEST_NOTIFICATION does not create an intent', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const testPayload = {
      notification_type: 'TEST_NOTIFICATION',
      subject: 'Test',
      media: { media_type: 'movie', imdbId: 'tt1375666', tmdbId: '27205', tvdbId: null },
      request: { request_id: 'req-test-999' },
      extra: [],
    };
    const res = await postJson(
      handler,
      '/api/ingress/seerr',
      testPayload,
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'ignored');
    assert.equal(body.reason, 'test-notification');

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 0, 'Test notification must not create a media intent');
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: non-approval notification is acknowledged but ignored', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'REQUEST_DECLINED',
      subject: 'Declined',
      media: { media_type: 'movie', imdbId: 'tt1375666', tmdbId: '27205', tvdbId: null },
      request: { request_id: 'req-declined-100' },
      extra: [],
    };
    const res = await postJson(
      handler,
      '/api/ingress/seerr',
      payload,
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'ignored');
    assert.match(body.reason, /non-approval-notification/);

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 0);
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: malformed media payload (no identity) → 400', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'broken',
      media: { media_type: 'movie' }, // no IMDb/TMDB/TVDB
      request: { request_id: 'req-bad-200' },
      extra: [],
    };
    const res = await postJson(
      handler,
      '/api/ingress/seerr',
      payload,
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /lacks IMDb, TMDB, or TVDB/);
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: malformed media payload (no request_id) → 400', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'no request id',
      media: { media_type: 'movie', imdbId: 'tt1375666', tmdbId: '27205', tvdbId: null },
      request: {}, // no request_id
      extra: [],
    };
    const res = await postJson(
      handler,
      '/api/ingress/seerr',
      payload,
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /Missing Seerr request_id/);
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: malformed media payload (no media_type) → 400', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'no media type',
      media: { imdbId: 'tt1375666' },
      request: { request_id: 'req-no-type-300' },
      extra: [],
    };
    const res = await postJson(
      handler,
      '/api/ingress/seerr',
      payload,
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /media_type/);
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: null/empty string IDs are not persisted as truthy', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'nullish ids',
      media: {
        media_type: 'movie',
        imdbId: 'tt1375666',
        tmdbId: 'null',
        tvdbId: '',
      },
      request: { request_id: 'req-nullish-400' },
      extra: [],
    };
    const res = await postJson(
      handler,
      '/api/ingress/seerr',
      payload,
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.tmdbId, null, 'string "null" must be normalized to null');
    assert.equal(body.tvdbId, null, 'empty string tvdbId must be null');

    const stored = cache.getMediaIntent(body.intentId);
    assert.equal(stored.tmdbId, null);
    assert.equal(stored.tvdbId, null);
  } finally {
    clearSeerrToken();
  }
});

test('buildSeerrIntent: derives mediaId from IMDb when present', () => {
  const built = buildSeerrIntent({
    notification_type: 'MEDIA_AUTO_APPROVED',
    subject: 'x',
    media: { media_type: 'movie', imdbId: 'tt1375666', tmdbId: '27205' },
    request: { request_id: 'r-1' },
  });
  assert.equal(built.ok, true);
  assert.equal(built.intent.mediaId, 'tt1375666');
  assert.equal(built.intent.imdbId, 'tt1375666');
  assert.equal(built.intent.tmdbId, '27205');
});

test('buildSeerrIntent: tmdb-only payload uses tmdb:<id>', () => {
  const built = buildSeerrIntent({
    notification_type: 'MEDIA_AUTO_APPROVED',
    subject: 'x',
    media: { media_type: 'movie', imdbId: null, tmdbId: '27205' },
    request: { request_id: 'r-2' },
  });
  assert.equal(built.ok, true);
  assert.equal(built.intent.mediaId, 'tmdb:27205');
});

test('checkSeerrAuth: rejects missing token in env', () => {
  const r = checkSeerrAuth('Bearer abc', undefined);
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('checkSeerrAuth: rejects missing header', () => {
  const r = checkSeerrAuth(undefined, 'somesecret');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('checkSeerrAuth: rejects malformed header', () => {
  const r = checkSeerrAuth('Basic abc', 'somesecret');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.reason, 'malformed-authorization');
});

test('checkSeerrAuth: rejects wrong token', () => {
  const r = checkSeerrAuth('Bearer wrong', 'right-token');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.reason, 'invalid-token');
});

test('checkSeerrAuth: accepts correct token', () => {
  const r = checkSeerrAuth('Bearer right-token', 'right-token');
  assert.equal(r.ok, true);
});

test('deriveMediaIdentity: TVDB-only falls back to tvdb:<id>', () => {
  const id = deriveMediaIdentity({ imdbId: null, tmdbId: null, tvdbId: '305288' });
  assert.equal(id.mediaId, 'tvdb:305288');
});

test('deriveMediaIdentity: non-numeric TMDB is rejected', () => {
  const id = deriveMediaIdentity({ imdbId: null, tmdbId: 'abc', tvdbId: null });
  assert.equal(id, null);
});

test('seerr ingress: whitelist constants are locked to MEDIA_AUTO_APPROVED + MEDIA_APPROVED', () => {
  // The actionable whitelist must contain exactly the two constants
  // confirmed against this Seerr build. Speculative aliases that are
  // NOT emitted by this Seerr version must stay out of the set so
  // they are routed through the non-approval-notification ignored path.
  assert.equal(SEERR_CONSTANTS.APPROVAL_NOTIFICATION_TYPES.length, 2);
  assert.ok(SEERR_CONSTANTS.APPROVAL_NOTIFICATION_TYPES.includes('MEDIA_AUTO_APPROVED'));
  assert.ok(SEERR_CONSTANTS.APPROVAL_NOTIFICATION_TYPES.includes('MEDIA_APPROVED'));
  for (const dropped of [
    'REQUEST_APPROVED',
    'REQUEST_AUTOMATICALLY_APPROVED',
  ]) {
    assert.equal(
      SEERR_CONSTANTS.APPROVAL_NOTIFICATION_TYPES.includes(dropped),
      false,
      `${dropped} must NOT be in the actionable whitelist`,
    );
  }
  // Test notifications stay ignored.
  assert.ok(SEERR_CONSTANTS.TEST_NOTIFICATION_TYPES.includes('TEST_NOTIFICATION'));
});

test('seerr ingress: MEDIA_AUTO_APPROVED payload creates an intent (post-fix regression)', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'auto-approved movie',
      media: { media_type: 'movie', imdbId: 'tt1375666', tmdbId: '27205', tvdbId: null },
      request: { request_id: 'req-media-auto-approved-500' },
      extra: [],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'created', `expected created, got: ${res.text}`);
    assert.equal(body.notificationType, 'MEDIA_AUTO_APPROVED');
    assert.equal(body.mediaId, 'tt1375666');

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 1);
    assert.equal(intents[0].sourceId, 'req-media-auto-approved-500');
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: REQUEST_APPROVED (speculative alias) is now ignored, not created', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'REQUEST_APPROVED',
      subject: 'speculative alias',
      media: { media_type: 'movie', imdbId: 'tt1375666', tmdbId: '27205', tvdbId: null },
      request: { request_id: 'req-speculative-600' },
      extra: [],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'ignored', `expected ignored, got: ${res.text}`);
    assert.equal(body.notificationType, 'REQUEST_APPROVED');

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 0);
  } finally {
    clearSeerrToken();
  }
});

// =============================================================================
// Processing integration tests
// =============================================================================

/**
 * Seed a minimal corpus candidate so searchByMedia has something to rank and persist.
 * Mirrors the pattern used in corpus-confidence-features.test.js and
 * availability.test.js for end-to-end searchByMedia coverage.
 */
function seedCandidateForMedia(cache, mediaId, infoHash, fileIndex = 0) {
  const now = Date.now();
  const fiKey = fileIndex == null ? -1 : fileIndex;
  cache.db.prepare(`
    INSERT INTO candidates (info_hash, file_index, file_index_key, filename, size, first_seen, last_seen, metadata, sources)
    VALUES (@info_hash, @file_index, @fi_key, 'Test.Movie.2024.1080p.mkv', 1000000000, @now, @now, '{}', '[]')
  `).run({ info_hash: infoHash, file_index: fileIndex, fi_key: fiKey, now });

  cache.db.prepare(`
    INSERT INTO release_attributes (info_hash, file_index_key, source, filename, confidence, media_type, season, resolution, codec, audio, source_type, release_group, language, parsed_at)
    VALUES (@info_hash, @fi_key, 'test', 'Test.Movie.2024.1080p.mkv', 0.9, 'movie', NULL, '1080p', 'h264', 'aac', 'web', 'test-rg', 'en', @now)
  `).run({ info_hash: infoHash, fi_key: fiKey, now });
}

test('seerr ingress: actionable webhook → one media_intents row AND one media_requests row', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const mediaId = 'tt1375666';
    const infoHash = 'abcd1234567890abcdef1234567890ab123456';
    seedCandidateForMedia(cache, mediaId, infoHash);

    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'Alice requested Inception',
      media: {
        media_type: 'movie',
        imdbId: 'tt1375666',
        tmdbId: '27205',
        tvdbId: null,
      },
      request: { request_id: 'req-process-001' },
      extra: [],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'created', `expected created, got: ${res.text}`);
    assert.ok(body.requestId > 0, 'response must include the newly created requestId');
    assert.ok(body.resultCount > 0, 'response must include the search result count');

    // Exactly one Seerr intent
    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 1);
    const intent = intents[0];
    assert.equal(intent.id, body.intentId);
    assert.equal(intent.mediaId, mediaId);
    assert.equal(intent.source, 'seerr');
    assert.equal(intent.sourceType, 'request');
    assert.equal(intent.sourceId, 'req-process-001');
    assert.equal(intent.lastProcessedAt != null, true, 'lastProcessedAt must be set after processing');

    // Exactly one media_request linked to that intent
    const requests = cache.db.prepare(
      'SELECT id, intent_id, source, media_id FROM media_requests WHERE intent_id = ?'
    ).all(intent.id);
    assert.equal(requests.length, 1, 'exactly one media_request must be created for the intent');
    assert.equal(requests[0].source, 'seerr');
    assert.equal(requests[0].media_id, mediaId);
    assert.equal(requests[0].id, body.requestId);
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: duplicate webhook → one intent and one media request (no extra rows)', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const mediaId = 'tt1375666';
    const infoHash = 'bbbbbbaaaaaaaaaa2222222233333333bb';
    seedCandidateForMedia(cache, mediaId, infoHash);

    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'Alice requested Inception',
      media: { media_type: 'movie', imdbId: 'tt1375666', tmdbId: '27205', tvdbId: null },
      request: { request_id: 'req-dup-001' },
      extra: [],
    };
    const headers = { authorization: `Bearer ${TOKEN}` };

    const first = await postJson(handler, '/api/ingress/seerr', payload, headers);
    assert.equal(first.status, 200);
    const firstBody = JSON.parse(first.text);
    assert.equal(firstBody.status, 'created');
    const firstRequestId = firstBody.requestId;

    const second = await postJson(handler, '/api/ingress/seerr', payload, headers);
    assert.equal(second.status, 200);
    assert.equal(JSON.parse(second.text).status, 'duplicate');

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 1, 'duplicate must not create a second intent');
    assert.equal(intents[0].requestCount, 2, 'request_count reflects ingress+processing bumps');

    // Exactly one media_request, not two
    const requests = cache.db.prepare(
      'SELECT id, intent_id, source FROM media_requests WHERE intent_id = ?'
    ).all(intents[0].id);
    assert.equal(requests.length, 1, 'duplicate must not create a second media_request');
    assert.equal(requests[0].id, firstRequestId, 'duplicate returns same requestId');
    assert.equal(requests[0].source, 'seerr');
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: test notification → neither intent nor media_request row', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    const payload = {
      notification_type: 'TEST_NOTIFICATION',
      subject: 'Test',
      media: { media_type: 'movie', imdbId: 'tt1375666', tmdbId: '27205', tvdbId: null },
      request: { request_id: 'req-test-proc-001' },
      extra: [],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'ignored');

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 0, 'test notification must not create a media intent');
    const requests = cache.db.prepare("SELECT id FROM media_requests WHERE source = 'seerr'").all();
    assert.equal(requests.length, 0, 'test notification must not create a media request');
  } finally {
    clearSeerrToken();
  }
});

test('seerr ingress: zero-candidate result leaves durable intent with lastProcessedAt set', async () => {
  setSeerrToken();
  try {
    const cache = buildCache();
    const handler = buildHandler(cache);
    // mediaId with no corpus candidates: searchByMedia returns {total:0} gracefully.
    // This is a valid outcome — not an error — so the handler returns 200.
    // The intent row must survive with lastProcessedAt set (idempotent invariant:
    // row is always durable regardless of downstream outcome).
    const payload = {
      notification_type: 'MEDIA_AUTO_APPROVED',
      subject: 'No candidates available',
      media: { media_type: 'movie', imdbId: 'tt99999999', tmdbId: '99999999', tvdbId: null },
      request: { request_id: 'req-zero-001' },
      extra: [],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, { authorization: `Bearer ${TOKEN}` });
    // Zero-candidate is a valid outcome; handler returns 200.
    assert.equal(res.status, 200, `expected 200 for zero-candidate, got: ${res.text}`);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'created');
    assert.equal(body.resultCount, 0, 'zero candidates yields resultCount=0');
    assert.equal(body.requestId, null, 'no requestId when no candidates');

    // Intent row is durable with lastProcessedAt set
    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 1, 'intent row must survive zero-candidate processing');
    assert.equal(intents[0].id, body.intentId);
    assert.equal(intents[0].lastProcessedAt != null, true, 'lastProcessedAt must be set even with zero results');
    assert.equal(intents[0].lastError, null, 'zero-candidate is not an error; lastError must be null');

    // No media_request row was created (persist only happens when results exist)
    const requests = cache.db.prepare("SELECT id FROM media_requests WHERE source = 'seerr'").all();
    assert.equal(requests.length, 0, 'no media_request should exist when resultCount=0');
  } finally {
    clearSeerrToken();
  }
});

// ---------------------------------------------------------------------------
// Seerr identity translation — production seam (boundary resolver)
//
// These tests prove the resolver at the Seerr ingress boundary itself,
// using a real local HTTP server as the Seerr endpoint. They do NOT
// touch the generic MediaIntentProcessor.
// ---------------------------------------------------------------------------

import http from 'node:http';
import { resolveSeerrIdentity } from '../src/server/app.js';

test('resolveSeerrIdentity: returns imdbId when Seerr detail returns tt-form', async () => {
  const seerrStub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ imdbId: 'tt0133093' }));
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    const result = await resolveSeerrIdentity(
      { tmdbId: '27205', mediaType: 'movie' },
      { SEERR_URL: `http://127.0.0.1:${port}`, SEERR_API_KEY: 'k' },
    );
    assert.equal(result.ok, true);
    assert.equal(result.imdbId, 'tt0133093');
  } finally {
    seerrStub.close();
  }
});

test('resolveSeerrIdentity: returns identity-unresolved when Seerr has no IMDb', async () => {
  const seerrStub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ imdbId: null }));
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    const result = await resolveSeerrIdentity(
      { tmdbId: '999999', mediaType: 'movie' },
      { SEERR_URL: `http://127.0.0.1:${port}`, SEERR_API_KEY: 'k' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'identity-unresolved');
  } finally {
    seerrStub.close();
  }
});

test('resolveSeerrIdentity: returns identity-misconfigured when env is empty', async () => {
  const result = await resolveSeerrIdentity(
    { tmdbId: '27205', mediaType: 'movie' },
    { SEERR_URL: '', SEERR_API_KEY: '' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'identity-misconfigured');
});

test('resolveSeerrIdentity: returns identity-not-found on 404', async () => {
  const seerrStub = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    const result = await resolveSeerrIdentity(
      { tmdbId: '999999', mediaType: 'movie' },
      { SEERR_URL: `http://127.0.0.1:${port}`, SEERR_API_KEY: 'k' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'identity-not-found');
  } finally {
    seerrStub.close();
  }
});

test('resolveSeerrIdentity: routes series through /api/v1/tv/<tmdbId>', async () => {
  let lastPath = null;
  const seerrStub = http.createServer((req, res) => {
    lastPath = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ imdbId: 'tt0903747' }));
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    const result = await resolveSeerrIdentity(
      { tmdbId: '1396', mediaType: 'series' },
      { SEERR_URL: `http://127.0.0.1:${port}`, SEERR_API_KEY: 'k' },
    );
    assert.equal(result.ok, true);
    assert.equal(result.imdbId, 'tt0903747');
    assert.equal(lastPath, '/api/v1/tv/1396');
  } finally {
    seerrStub.close();
  }
});

// ---------------------------------------------------------------------------
// Public ingress boundary proof: TMDB-only movie → Seerr resolves IMDb →
// media_intents.media_id = tt... AND media_request created
// ---------------------------------------------------------------------------

test('seerr ingress: TMDB-only movie → Seerr resolves → media_id becomes tt...', async () => {
  const seerrStub = http.createServer((req, res) => {
    // Pretend Seerr has the IMDb for this TMDB.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ imdbId: 'tt0133093' }));
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
      subject: 'TMDB-only movie',
      media: { media_type: 'movie', imdbId: null, tmdbId: '27205', tvdbId: null },
      request: { request_id: 'req-tmdb-movie-canary' },
      extra: [],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'created');
    assert.equal(body.identityStatus, 'imdb-resolved');
    assert.equal(body.mediaId, 'tt0133093');
    assert.equal(body.imdbId, 'tt0133093');
    assert.equal(body.tmdbId, '27205');

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 1);
    const intent = intents[0];
    assert.equal(intent.mediaId, 'tt0133093');
    assert.equal(intent.imdbId, 'tt0133093');
    assert.equal(intent.tmdbId, '27205', 'tmdb_id must be preserved');
    assert.equal(intent.sourceId, 'req-tmdb-movie-canary');
    assert.equal(intent.lastError, null, 'resolved intent must have no last_error');
  } finally {
    if (prevUrl === undefined) delete process.env.SEERR_URL;
    else process.env.SEERR_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = prevKey;
    clearSeerrToken();
    seerrStub.close();
  }
});

test('seerr ingress: TMDB-only with Seerr unresolved → 500 + durable intent + last_error + no media_request', async () => {
  const seerrStub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ imdbId: null }));
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
      subject: 'TMDB only',
      media: { media_type: 'movie', imdbId: null, tmdbId: '999999', tvdbId: null },
      request: { request_id: 'req-tmdb-unresolved-canary' },
      extra: [],
    };
    const res = await postJson(handler, '/api/ingress/seerr', payload, {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 500, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'identity-unresolved');
    assert.equal(body.reason, 'identity-unresolved');

    const intents = cache.getMediaIntentsBySource('seerr', 100);
    assert.equal(intents.length, 1, 'unresolved intent must still be durable');
    const intent = intents[0];
    assert.equal(intent.mediaId, 'tmdb:999999');
    assert.equal(intent.imdbId, null);
    assert.equal(intent.tmdbId, '999999');
    assert.match(intent.lastError || '', /seerr-identity-unresolved/);

    const requests = cache.db.prepare("SELECT id FROM media_requests WHERE source = 'seerr'").all();
    assert.equal(requests.length, 0, 'unresolved identity must not produce a media_request');
  } finally {
    if (prevUrl === undefined) delete process.env.SEERR_URL;
    else process.env.SEERR_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = prevKey;
    clearSeerrToken();
    seerrStub.close();
  }
});
