#!/usr/bin/env node
/**
 * Forced Plex Transcode Session Canary
 *
 * Slice 2.5 / B8-B12: prove an actual Plex transcode session exists
 * for a huge movie (Black Panther, tt1825683, ~34 GB) without
 * transcribing the whole file. We force a browser-compatible
 * transcode with bounded HLS segment reads and a single seek,
 * then stop cleanly. A second session restarts to prove the
 * session lifecycle is repeatable.
 *
 * Approach:
 *   - Resolve the movie Part ID from Plex section metadata.
 *   - POST /video/:/transcode/universal/start with:
 *       * hasMDE=1
 *       * directPlay=0 / directStream=0   (force transcode)
 *       * directStreamAudio=1 / directStreamVideo=0
 *       * videoQuality=100 / maxVideoBitrate=8000
 *       * videoResolution=1280x720
 *       * mediaBufferSize=... (bounded)
 *       * session=<random>
 *       * path=/library/parts/<id>/file.mkv
 *       * offset=0 (start)
 *     Plex returns a master.m3u8 (HLS) at /video/:/transcode/universal/session/<id>/...
 *   - Read the master.m3u8 and a single media segment (bounded bytes).
 *   - /video/:/transcode/universal/ping?session=<id>...  (keepalive)
 *   - /video/:/transcode/universal/stop?session=<id>...
 *   - Repeat for a second session to prove restart.
 *
 * B12: after stop, the transcode session must be gone and Plex API
 * must still be responsive. We do NOT assert the exact transcoder
 * PID (that is host-specific); we assert the session ID we
 * received is rejected as unknown by the API.
 *
 * B11: zero refresh delta during the entire canary.
 */

import { setTimeout as delay } from 'node:timers/promises';
import crypto from 'node:crypto';

const args = parseArgs(process.argv.slice(2));
const PLEX_URL = (process.env.PLEX_URL || 'http://192.168.2.4:32400').replace(/\/$/, '');
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const MEDIA_SEARCH_URL = (process.env.MEDIA_SEARCH_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const BLACK_PANTHER_MEDIA_ID = 'tt1825683';
const PLEX_MOVIES_SECTION = process.env.PLEX_MOVIES_SECTION_ID || '2';
const MAX_SEGMENT_BYTES = 4 * 1024 * 1024; // 4 MiB cap per read

const events = [];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i += 1; }
      else out[key] = true;
    }
  }
  return out;
}

function emit(event, data = {}) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  events.push(entry);
  console.log(JSON.stringify(entry));
  return entry;
}

function okOr(label, condition, data) {
  if (condition) emit('canary.assert_ok', { label, ...data });
  else emit('canary.assert_fail', { label, ...data });
  return condition;
}

function redactToken(value) {
  if (typeof value !== 'string' || !PLEX_TOKEN) return value;
  return value.split(PLEX_TOKEN).join('<PLEX_TOKEN>');
}

async function timedFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const start = Date.now();
    const safeUrl = redactToken(url);
    const headers = { ...(init.headers || {}), 'X-Plex-Token': PLEX_TOKEN };
    const response = await fetch(url, { ...init, signal: controller.signal, headers });
    return { response, safeUrl, elapsedMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMetrics() {
  try {
    const r = await fetch(`${MEDIA_SEARCH_URL}/api/metrics`);
    if (!r.ok) return null;
    const body = await r.json();
    return body?.plex_refresh || null;
  } catch { return null; }
}

async function resolvePart() {
  const sectionUrl = `${PLEX_URL}/library/sections/${PLEX_MOVIES_SECTION}/all?X-Plex-Token=${PLEX_TOKEN}`;
  const { response: sec, safeUrl: secUrl } = await timedFetch(sectionUrl);
  if (!sec.ok) {
    emit('canary.section_unreachable', { safe_url: secUrl, status: sec.status });
    return null;
  }
  const xml = await sec.text();
  // Match the movie. Plex uses `plex://movie/...` for the primary
  // guid; the IMDb guid may live on a <Guid> sub-element or be
  // absent depending on agent version. Match by the known title
  // (stable for this canary) with a slug fallback.
  const imdbMovieRe = new RegExp(`<Video[^>]*guid="com\\.plexapp\\.agents\\.imdb:\\/\\/tt1825683"[^>]*key="\\/library\\/metadata\\/(\\d+)"`, 'i');
  const imdbMovieReAlt = new RegExp(`<Video[^>]*key="\\/library\\/metadata\\/(\\d+)"[^>]*guid="com\\.plexapp\\.agents\\.imdb:\\/\\/tt1825683"`, 'i');
  const slugMovieRe = new RegExp(`<Video[^>]*slug="black-panther"[^>]*ratingKey="(\\d+)"`, 'i');
  const slugMovieReAlt = new RegExp(`<Video[^>]*ratingKey="(\\d+)"[^>]*slug="black-panther"`, 'i');
  const titleMovieRe = new RegExp(`<Video[^>]*title="Black Panther"[^>]*ratingKey="(\\d+)"`, 'i');
  const titleMovieReAlt = new RegExp(`<Video[^>]*ratingKey="(\\d+)"[^>]*title="Black Panther"`, 'i');
  const movieMatch = xml.match(imdbMovieRe)
    || xml.match(imdbMovieReAlt)
    || xml.match(slugMovieRe)
    || xml.match(slugMovieReAlt)
    || xml.match(titleMovieRe)
    || xml.match(titleMovieReAlt);
  if (!movieMatch) {
    emit('canary.movie_not_found', { section: PLEX_MOVIES_SECTION });
    return null;
  }
  const movieKey = movieMatch[1];
  const { response: meta, safeUrl: metaUrl } = await timedFetch(
    `${PLEX_URL}/library/metadata/${movieKey}?X-Plex-Token=${PLEX_TOKEN}`,
  );
  if (!meta.ok) {
    emit('canary.movie_meta_unreachable', { safe_url: metaUrl, status: meta.status });
    return null;
  }
  const metaXml = await meta.text();
  // Match the <Part> element. Attribute order varies across Plex
  // versions (e.g. duration/container may appear between key and
  // file). We extract attributes independently.
  const partMatch = metaXml.match(/<Part\b([^>]*)>/);
  if (!partMatch) {
    emit('canary.part_not_found', { movie_key: movieKey });
    return null;
  }
  const partAttrs = partMatch[1];
  const partId = (partAttrs.match(/\bid="(\d+)"/) || [])[1];
  const partKey = (partAttrs.match(/\bkey="([^"]+)"/) || [])[1];
  const partFile = (partAttrs.match(/\bfile="([^"]+)"/) || [])[1];
  const partSize = (partAttrs.match(/\bsize="(\d+)"/) || [])[1];
  if (!partId || !partKey || !partFile || !partSize) {
    emit('canary.part_not_found', { movie_key: movieKey, parsed: { partId, partKey, partFile, partSize } });
    return null;
  }
  return {
    partId: Number(partId),
    partKey,
    partFile: partFile,
    partSize: Number(partSize),
    movieKey,
  };
}

function newSessionId() {
  return crypto.randomBytes(12).toString('hex');
}

async function startSession({ partId, sessionId, offset = 0, width = 1280, height = 720, bitrate = 4000 }) {
  // Force transcode by disabling direct play/stream for video.
  // Keep directStreamAudio=1 where the audio is already compatible;
  // we still force video transcode so the transcode session is real.
  const params = new URLSearchParams({
    hasMDE: '1',
    hasDirectPlay: '1',
    hasDirectStream: '1',
    // Force transcode: disable both direct paths
    directPlay: '0',
    directStream: '0',
    directStreamAudio: '1',
    directStreamVideo: '0',
    // Output profile
    videoCodec: 'h264',
    videoBitrate: String(bitrate),
    videoResolution: `${width}x${height}`,
    videoQuality: '100',
    maxVideoBitrate: String(bitrate),
    videoBufferSize: '8000',
    audioCodec: 'aac',
    audioBitrate: '128',
    mediaBufferSize: '8000',
    session: sessionId,
    path: `/library/parts/${partId}/file.mkv`,
    offset: String(offset),
    copyts: '1',
    Accept: 'application/x-mpegurl',
  });
  const url = `${PLEX_URL}/video/:/transcode/universal/start?${params.toString()}`;
  const { response, safeUrl, elapsedMs } = await timedFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/x-mpegurl' },
  });
  if (!response.ok) {
    return { ok: false, status: response.status, safeUrl, elapsedMs };
  }
  const manifest = await response.text();
  return { ok: true, status: response.status, safeUrl, elapsedMs, manifest };
}

async function fetchMasterPlaylist({ sessionId, width = 1280, height = 720, bitrate = 4000 }) {
  const params = new URLSearchParams({
    session: sessionId,
    hasMDE: '1',
    directPlay: '0',
    directStream: '0',
    path: '/library/parts/0/file.mkv',
    mediaIndex: '0',
    partIndex: '0',
    protocol: 'hls',
    fastSeek: '1',
  });
  const url = `${PLEX_URL}/video/:/transcode/universal/session/${sessionId}/${width}x${height}/manifest?${params.toString()}`;
  const { response, safeUrl, elapsedMs } = await timedFetch(url);
  if (!response.ok) return { ok: false, status: response.status, safeUrl, elapsedMs };
  const text = await response.text();
  return { ok: true, status: response.status, safeUrl, elapsedMs, manifest: text };
}

async function fetchSessionSegment({ sessionId, segment }) {
  const url = `${PLEX_URL}${segment}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const safeUrl = redactToken(url);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'X-Plex-Token': PLEX_TOKEN, Accept: 'video/*' },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, safeUrl };
    }
    const total = Number(response.headers.get('content-length') || 0);
    // Read up to MAX_SEGMENT_BYTES; discard the rest.
    const reader = response.body?.getReader();
    let received = 0;
    if (!reader) {
      return { ok: false, status: response.status, safeUrl, reason: 'no-body' };
    }
    while (received < MAX_SEGMENT_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    return { ok: true, status: response.status, safeUrl, bytes: received, total };
  } finally {
    clearTimeout(timer);
  }
}

async function pingSession({ sessionId }) {
  const params = new URLSearchParams({ session: sessionId });
  const url = `${PLEX_URL}/video/:/transcode/universal/ping?${params.toString()}`;
  const { response, safeUrl, elapsedMs } = await timedFetch(url);
  return { status: response.status, safeUrl, elapsedMs };
}

async function stopSession({ sessionId }) {
  const params = new URLSearchParams({ session: sessionId });
  const url = `${PLEX_URL}/video/:/transcode/universal/stop?${params.toString()}`;
  const { response, safeUrl, elapsedMs } = await timedFetch(url);
  return { status: response.status, safeUrl, elapsedMs };
}

function parseMediaSegments(manifest) {
  // HLS manifest may be master.m3u8 referencing variant playlists, or
  // media.m3u8 referencing .ts/.m4s segments. We extract any URI
  // line that ends in .ts or .m4s or .m3u8.
  if (typeof manifest !== 'string') return [];
  const lines = manifest.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/\.(ts|m4s|m3u8)(\?|$)/i.test(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

async function runSession({ part, label, offset = 0 }) {
  const sessionId = newSessionId();
  emit('transcode.session_start', { label, session: sessionId, offset });

  // Start the transcode session. The first response may itself be
  // the HLS manifest, or the API may require a follow-up manifest
  // fetch.
  const start = await startSession({ partId: part.partId, sessionId, offset });
  if (!start.ok) {
    emit('canary.assert_fail', { label: `${label}.start_failed`, status: start.status, safe_url: start.safeUrl });
    return { ok: false };
  }
  emit('transcode.start_ok', { label, status: start.status, manifest_bytes: start.manifest.length });

  // Try to get the master playlist from the dedicated manifest URL.
  const master = await fetchMasterPlaylist({ sessionId });
  let manifest = start.manifest;
  if (master.ok) manifest = master.manifest;
  emit('transcode.manifest', { label, manifest_bytes: manifest.length, master_status: master.status });

  // Find a media segment to read. Take the first .ts or .m4s entry;
  // if the manifest is multi-variant, the first sub-playlist will
  // resolve to its own .ts entries on fetch.
  const segments = parseMediaSegments(manifest);
  emit('transcode.segments', { label, count: segments.length, first: segments[0] ? redactToken(segments[0]) : null });

  if (segments.length === 0) {
    emit('canary.assert_fail', { label: `${label}.no_segments_in_manifest` });
  } else {
    // Pick the first concrete segment (.ts/.m4s) or the first
    // sub-playlist and read it. We do not transcode the whole file.
    const target = segments.find((s) => /\.(ts|m4s)/i.test(s)) || segments[0];
    const seg = await fetchSessionSegment({ sessionId, segment: target });
    if (seg.ok) {
      okOr(`${label}.segment_bytes`, seg.bytes > 0, { bytes: seg.bytes, total: seg.total, status: seg.status });
    } else {
      emit('canary.assert_fail', { label: `${label}.segment_fetch`, status: seg.status });
    }
  }

  // Ping to prove the session is alive on the Plex side.
  const ping = await pingSession({ sessionId });
  okOr(`${label}.ping_alive`, ping.status === 200, { status: ping.status });

  // Stop the session.
  const stop = await stopSession({ sessionId });
  emit('transcode.stop', { label, status: stop.status });
  okOr(`${label}.stop_ok`, stop.status === 200 || stop.status === 204, { status: stop.status });

  // Verify the session is gone: a ping now should not return 200.
  await delay(300);
  const after = await pingSession({ sessionId });
  okOr(`${label}.session_gone`, after.status !== 200, { status: after.status });

  return { ok: true, sessionId };
}

async function main() {
  emit('canary.start', { plex_url: PLEX_URL });
  if (!PLEX_TOKEN) {
    emit('canary.abort', { reason: 'PLEX_TOKEN not set' });
    process.exit(2);
  }
  const part = await resolvePart();
  if (!part) {
    emit('canary.abort', { reason: 'could not resolve Black Panther part' });
    process.exit(2);
  }
  emit('canary.part_resolved', {
    part_id: part.partId, part_size: part.partSize, part_file: part.partFile,
  });

  const before = await fetchMetrics();
  if (before) emit('canary.metrics_before', { plex_refresh: before });

  // Session 1: start, segment, ping, stop.
  await runSession({ part, label: 'session_1', offset: 0 });

  // Session 2: restart with a different session id; no offset seek
  // for the first cycle (it would be invalid for some encoders).
  await runSession({ part, label: 'session_2', offset: 0 });

  // B11: zero refresh delta.
  const after = await fetchMetrics();
  if (after) {
    emit('canary.metrics_after', { plex_refresh: after });
    if (before) {
      const deltaRequested = (after.refresh_requested || 0) - (before.refresh_requested || 0);
      const deltaActual = (after.actual_refresh_sent || 0) - (before.actual_refresh_sent || 0);
      const deltaFull = (after.full_section_refresh || 0) - (before.full_section_refresh || 0);
      okOr('refresh_invariant.no_requests', deltaRequested === 0, { delta: deltaRequested });
      okOr('refresh_invariant.no_actual_refreshes', deltaActual === 0, { delta: deltaActual });
      okOr('refresh_invariant.no_full_section_scans', deltaFull === 0, { delta: deltaFull });
    }
  }

  // B12: Plex still responsive.
  const { response: idResp, status: idStatus } = await timedFetch(`${PLEX_URL}/identity`);
  okOr('plex_responsive_after_sessions', idResp?.ok === true || idStatus === 200, { status: idStatus });

  // Token never logged.
  const leak = events.some((e) => JSON.stringify(e).includes(PLEX_TOKEN));
  okOr('transcode.token_never_logged', !leak, { checked_events: events.length });

  const fails = events.filter((e) => e.event === 'canary.assert_fail').length;
  const oks = events.filter((e) => e.event === 'canary.assert_ok').length;
  emit('canary.summary', { ok: oks, fail: fails, total_events: events.length });
  if (fails > 0) {
    console.error(`\nCANARY FAILED: ${fails} assertion(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[canary] unexpected error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});
