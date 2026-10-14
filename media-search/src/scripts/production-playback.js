#!/usr/bin/env node
/**
 * Authenticated Plex playback acceptance probe.
 *
 * This is deliberately not a metadata-only pass. It requires an actual Plex
 * client session to appear in /status/sessions and correlates the observed
 * session/ratingKey with the configured fixture. The probe never synthesizes
 * a successful playback result from library metadata or a direct Part URL.
 *
 * Plex Web/native clients must be started by the operator or CI device; this
 * process observes the real PMS request/session path and polls boundedly.
 */
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { confirmPlexEpisode } from '../lib/consumers/plex.js';

const base = String(process.env.PLEX_URL || '').replace(/\/$/, '');
const token = process.env.PLEX_TOKEN || '';
const fixture = {
  mediaId: process.env.PRODUCTION_TEST_MEDIA_ID || 'tt26545992',
  season: Number(process.env.PRODUCTION_TEST_SEASON || 1),
  episode: Number(process.env.PRODUCTION_TEST_EPISODE || 1),
  ratingKey: process.env.PRODUCTION_TEST_PLEX_RATING_KEY || '497',
  torrentFileId: process.env.PRODUCTION_TEST_TORRENT_FILE_ID || 'tf_426aa723-3dfc-427a-8cc2-3871f231ff6c',
};
const timeoutMs = Number(process.env.PRODUCTION_PLAYBACK_TIMEOUT_MS || 120_000);
const clientId = process.env.PRODUCTION_PLEX_CLIENT_ID || `hashsucker-playback-${Date.now()}`;
const headers = {
  Accept: 'application/json',
  'X-Plex-Token': token,
  'X-Plex-Client-Identifier': clientId,
  'X-Plex-Product': 'HashSucker Production Playback Probe',
  'X-Plex-Version': '1.0',
  'X-Plex-Platform': 'Node',
  'X-Plex-Device': 'Production Playback Probe',
};
const started = performance.now();
const result = { mode: 'observational-authenticated-playback', fixture, clientId, flow: [], assertions: {} };
const get = async (pathname, extra = {}) => {
  const response = await fetch(`${base}${pathname}`, { headers: { ...headers, ...extra }, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { response, json, text };
};
const sessions = async () => (await get('/status/sessions')).json?.MediaContainer?.Metadata || [];
const matchingSession = (rows) => rows.find((row) => String(row.ratingKey || '') === String(fixture.ratingKey)
  || String(row.grandparentGuid || '').includes(fixture.mediaId));

if (!base || !token) {
  console.error(JSON.stringify({ ...result, status: 'UNPROVEN', reason: 'PLEX_URL/PLEX_TOKEN missing' }, null, 2));
  process.exit(2);
}
try {
  const identity = await get('/identity');
  result.plexVersion = identity.response.headers.get('x-plex-version') || identity.json?.MediaContainer?.version || null;
  result.flow.push({ path: '/identity', status: identity.response.status });
  const metadata = await get(`/library/metadata/${encodeURIComponent(fixture.ratingKey)}`);
  const item = metadata.json?.MediaContainer?.Metadata?.[0];
  const part = item?.Media?.flatMap((media) => media.Part || []).find(Boolean) || null;
  result.flow.push({ path: `/library/metadata/${fixture.ratingKey}`, status: metadata.response.status, ratingKey: item?.ratingKey || null, part });
  result.assertions.metadata = Boolean(item?.ratingKey === fixture.ratingKey && part?.file && part?.id);
  const before = await sessions();
  result.sessionsBefore = before.length;
  const decision = await get(`/player/playbackInfo?key=${encodeURIComponent(`/library/metadata/${fixture.ratingKey}`)}&protocol=http&mediaIndex=0&partIndex=0&directPlay=1&directStream=1&fastSeek=1`);
  result.flow.push({ path: '/player/playbackInfo', status: decision.response.status, body: decision.text.slice(0, 500) });
  result.playbackDecision = decision.json || { status: decision.response.status, body: decision.text.slice(0, 500) };
  const deadline = Date.now() + timeoutMs;
  let active = null;
  while (Date.now() < deadline) {
    const rows = await sessions();
    active = matchingSession(rows);
    if (active) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  result.session = active ? {
    sessionId: active.Session?.id || active.sessionId || null,
    ratingKey: active.ratingKey || null,
    player: active.Player || null,
    media: active.Media || null,
    part: active.Media?.flatMap((media) => media.Part || []).find(Boolean) || null,
    viewOffset: active.viewOffset || 0,
    duration: active.duration || null,
  } : null;
  result.assertions.sessionObserved = Boolean(active);
  result.assertions.sameFixture = Boolean(active && String(active.ratingKey) === String(fixture.ratingKey));
  result.assertions.realPlayback = result.assertions.sessionObserved && result.assertions.sameFixture;
  result.status = result.assertions.metadata && result.assertions.realPlayback ? 'PASS' : 'UNPROVEN';
  result.reason = result.status === 'PASS'
    ? 'Plex session observed for exact fixture; continue with client-driven start/seek correlation.'
    : 'No real Plex playback session was observed. Metadata and playbackInfo are not treated as playback proof.';
} catch (error) {
  result.status = 'FAIL';
  result.reason = error.message;
}
result.latencyMs = Math.round(performance.now() - started);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === 'PASS' ? 0 : 1;
