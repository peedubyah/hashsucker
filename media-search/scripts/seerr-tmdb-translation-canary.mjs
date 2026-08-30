#!/usr/bin/env node
/**
 * Seerr TMDB→IMDb Translation Canary — production path
 *
 * Drives the real production ingress endpoint with a realistic Seerr
 * payload that arrives TMDB-only (no IMDb), and proves the boundary
 * translator correctly:
 *
 *   1. Seerr webhook arrives at /api/ingress/seerr with imdbId=null,
 *      tmdbId=603 (The Matrix).
 *   2. HashSucker calls Seerr /api/v1/movie/603 with X-Api-Key, reads
 *      imdbId = tt0133093, validates it is tt-form.
 *   3. The media_intents row is persisted with media_id = tt0133093,
 *      imdb_id = tt0133093, tmdb_id = 603 (preserved).
 *   4. The existing single-intent pipeline creates a media_request row
 *      linked to the intent.
 *
 * Final assertions on the durable row:
 *   - media_id = tt0133093
 *   - imdb_id  = tt0133093
 *   - tmdb_id  = 603
 *   - source_id = req-seerr-canary-<timestamp>
 *   - last_error = NULL
 *   - at least one media_request row referencing this intent
 *
 * Failures (TMDB unresolved, misconfigured, network down, etc.) leave
 * the intent row durable with explicit last_error and do NOT create a
 * media_request row.
 */

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

const DB_PATH = '/home/patrick/hashsucker-data/discovery/discovery-cache.db';
const ENDPOINT = 'http://127.0.0.1:3000/api/ingress/seerr';
const TMDB_ID = '603'; // The Matrix
const EXPECTED_IMDB = 'tt0133093';
const REQ_ID = `req-seerr-canary-${Date.now()}`;

const TOKEN = process.env.SEERR_WEBHOOK_TOKEN;
if (!TOKEN) {
  console.error('SEERR_WEBHOOK_TOKEN must be set in env');
  process.exit(1);
}

const payload = {
  notification_type: 'MEDIA_AUTO_APPROVED',
  subject: 'Seerr canary: request The Matrix',
  media: {
    media_type: 'movie',
    imdbId: null,
    tmdbId: TMDB_ID,
    tvdbId: null,
  },
  request: { request_id: REQ_ID },
  extra: [],
};

console.log('--- Seerr TMDB→IMDb Translation Canary ---');
console.log('endpoint:', ENDPOINT);
console.log('payload:', JSON.stringify(payload));

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TOKEN}`,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
console.log(`status: ${res.status}`);
console.log('body:', text);

let body;
try { body = JSON.parse(text); } catch (e) { body = null; }

if (res.status !== 200) {
  console.error('FAIL: expected 200, got', res.status, text);
  process.exit(2);
}
if (!body || body.status !== 'created') {
  console.error('FAIL: response status is not "created"');
  process.exit(2);
}
if (body.mediaId !== EXPECTED_IMDB) {
  console.error(`FAIL: mediaId is ${body.mediaId}, expected ${EXPECTED_IMDB}`);
  process.exit(2);
}
if (body.imdbId !== EXPECTED_IMDB) {
  console.error(`FAIL: imdbId is ${body.imdbId}, expected ${EXPECTED_IMDB}`);
  process.exit(2);
}
if (body.tmdbId !== TMDB_ID) {
  console.error(`FAIL: tmdbId is ${body.tmdbId}, expected ${TMDB_ID} (preserved)`);
  process.exit(2);
}
if (body.identityStatus !== 'imdb-resolved') {
  console.error(`FAIL: identityStatus is ${body.identityStatus}, expected imdb-resolved`);
  process.exit(2);
}

// Now verify the durable row in the production cache
const cache = createDiscoveryCache({ dbPath: DB_PATH });
const intents = cache.getMediaIntentsBySource('seerr', 100);
const intent = intents.find((i) => i.sourceId === REQ_ID);
if (!intent) {
  console.error(`FAIL: no media_intents row with source_id = ${REQ_ID}`);
  process.exit(2);
}
console.log('--- media_intents row ---');
console.log('  id:        ', intent.id);
console.log('  media_id:  ', intent.mediaId);
console.log('  imdb_id:   ', intent.imdbId);
console.log('  tmdb_id:   ', intent.tmdbId);
console.log('  source:    ', intent.source);
console.log('  source_id: ', intent.sourceId);
console.log('  lastError: ', intent.lastError);
console.log('  lastProcessedAt:', intent.lastProcessedAt);

if (intent.mediaId !== EXPECTED_IMDB) {
  console.error(`FAIL: media_intents.media_id = ${intent.mediaId}, expected ${EXPECTED_IMDB}`);
  process.exit(2);
}
if (intent.imdbId !== EXPECTED_IMDB) {
  console.error(`FAIL: media_intents.imdb_id = ${intent.imdbId}, expected ${EXPECTED_IMDB}`);
  process.exit(2);
}
if (intent.tmdbId !== TMDB_ID) {
  console.error(`FAIL: media_intents.tmdb_id = ${intent.tmdbId}, expected ${TMDB_ID}`);
  process.exit(2);
}
if (intent.lastError != null) {
  console.error(`FAIL: lastError is "${intent.lastError}", expected null`);
  process.exit(2);
}

// media_request row
const requests = cache.db.prepare(
  'SELECT id, intent_id, source, media_id, status FROM media_requests WHERE intent_id = ?'
).all(intent.id);
console.log('--- media_requests rows for this intent ---');
console.log(`  count: ${requests.length}`);
for (const r of requests) {
  console.log(`  id=${r.id} intent_id=${r.intent_id} source=${r.source} media_id=${r.media_id} status=${r.status}`);
}
if (requests.length === 0) {
  console.error('FAIL: no media_request row was created for the resolved intent');
  process.exit(2);
}
for (const r of requests) {
  if (r.source !== 'seerr') {
    console.error(`FAIL: media_request.source = ${r.source}, expected seerr`);
    process.exit(2);
  }
  if (r.media_id !== EXPECTED_IMDB) {
    console.error(`FAIL: media_request.media_id = ${r.media_id}, expected ${EXPECTED_IMDB}`);
    process.exit(2);
  }
}

console.log('');
console.log('--- CANARY PASSED ---');
console.log(`request_id   ${REQ_ID}`);
console.log(`TMDB ID      ${TMDB_ID} → resolved IMDb ${EXPECTED_IMDB}`);
console.log(`media_id     tt...   (operational) — preserved tmdb_id ${TMDB_ID}`);
console.log(`intent       #${intent.id} → media_request #${requests.map((r) => r.id).join(', ')}`);
console.log(`resultCount  ${body.resultCount ?? 0}`);
