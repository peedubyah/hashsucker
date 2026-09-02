#!/usr/bin/env node
/**
 * Direct-Play + Refresh-Invariant Canary
 *
 * Slice 2.5 / B7: prove that the direct-play session for Fleabag
 * S01E03 (tt5687612) opens, supports multiple seeks, stops cleanly,
 * and restarts. Crucially, NONE of these operations may trigger a
 * Plex partial-refresh. The notifier is publication-driven only.
 *
 * Sequence (B7):
 *   1. Source opens (Plex Part ID)
 *   2. Beginning bytes
 *   3. Forward seek
 *   4. Another forward seek
 *   5. Backward seek
 *   6. Near-tail seek
 *   7. Stop / connection close
 *   8. Restart (open again)
 *   9. Beginning / non-zero read again
 *
 * Bonus invariant (B11): refresh accounting does not change during
 * the canary. We pull /api/metrics before and after and assert the
 * delta is zero on actual_refresh_sent and refresh_requested.
 *
 * The canary is BOUNDED. Each seek is a single Range request; we
 * never download the whole file. The Plex session is the
 * already-published Part — no new metadata fetch.
 *
 * Required env:
 *   PLEX_URL             default: http://192.168.2.4:32400
 *   PLEX_TOKEN           required
 *   MEDIA_SEARCH_URL     default: http://127.0.0.1:3000
 *   FLEABAG_PART_ID      optional override
 *
 * Usage:
 *   node scripts/canary-plex-direct-play.mjs
 *   node scripts/canary-plex-direct-play.mjs --no-metrics
 */

import { setTimeout as delay } from 'node:timers/promises';

const args = parseArgs(process.argv.slice(2));
const PLEX_URL = (process.env.PLEX_URL || 'http://192.168.2.4:32400').replace(/\/$/, '');
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const MEDIA_SEARCH_URL = (process.env.MEDIA_SEARCH_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const WITH_METRICS = !args['no-metrics'];
const FLEABAG_MEDIA_ID = 'tt5687612';
const FLEABAG_SECTION = process.env.PLEX_TV_SECTION_ID || '3';
const MAX_BYTES = 1024 * 1024; // 1 MiB per read

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
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const start = Date.now();
    const safeUrl = redactToken(url);
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers || {}),
        'X-Plex-Token': PLEX_TOKEN,
        Accept: '*/*',
      },
    });
    return { response, safeUrl, elapsedMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function readRange(partKey, { start, end, size }) {
  if (end >= size) end = size - 1;
  const expected = end - start + 1;
  const url = `${PLEX_URL}${partKey}?X-Plex-Token=${PLEX_TOKEN}`;
  const { response, safeUrl, elapsedMs } = await timedFetch(url, {
    headers: { range: `bytes=${start}-${end}` },
  });
  const observed = Number(response.headers.get('content-length') || 0);
  const buf = Buffer.from(await response.arrayBuffer());
  const cr = response.headers.get('content-range');
  const ok = response.status === 206
    && observed === expected
    && buf.length === expected
    && cr === `bytes ${start}-${end}/${size}`;
  // Discard the bytes — we don't need them in memory.
  return { ok, status: response.status, contentRange: cr, expected, actual: buf.length, elapsedMs, safeUrl };
}

async function stopSession(partKey) {
  // Plex Part reads are stateless GET requests. "Stopping" the
  // session is just closing the connection. We simulate by
  // requesting with Connection: close and reading a 0-byte tail.
  const url = `${PLEX_URL}${partKey}?X-Plex-Token=${PLEX_TOKEN}`;
  const controller = new AbortController();
  const { response, safeUrl } = await timedFetch(url, {
    headers: { range: 'bytes=0-0', connection: 'close' },
    signal: controller.signal,
  });
  controller.abort();
  return { status: response.status, safeUrl };
}

async function resolvePart() {
  // Strategy 1: explicit env override
  if (process.env.FLEABAG_PART_ID) {
    return {
      partId: Number(process.env.FLEABAG_PART_ID),
      partKey: `/library/parts/${process.env.FLEABAG_PART_ID}/file.mkv`,
      partSize: 0, // unknown; resolved below
      partFile: '<env override>',
    };
  }
  // Strategy 2: walk the section metadata for tt5687612 S01E03
  const sectionUrl = `${PLEX_URL}/library/sections/${FLEABAG_SECTION}/all?X-Plex-Token=${PLEX_TOKEN}`;
  const { response: sec, safeUrl: secUrl } = await timedFetch(sectionUrl);
  if (!sec.ok) {
    emit('canary.section_unreachable', { safe_url: secUrl, status: sec.status });
    return null;
  }
  const xml = await sec.text();
  // Find the show for tt5687612. Plex's section listing uses a
  // `plex://show/...` GUID for the show; the IMDb GUID appears on
  // <Guid> sub-elements or on individual <Video> (episode) entries.
  // We match by the IMDb GUID first, falling back to the show slug
  // or title (which is stable for this canary).
  const imdbShowRe = new RegExp(`<Directory[^>]*guid="com\\.plexapp\\.agents\\.imdb:\\/\\/tt5687612"[^>]*key="\\/library\\/metadata\\/(\\d+)"`, 'i');
  const imdbShowReAlt = new RegExp(`<Directory[^>]*key="\\/library\\/metadata\\/(\\d+)"[^>]*guid="com\\.plexapp\\.agents\\.imdb:\\/\\/tt5687612"`, 'i');
  const slugShowRe = new RegExp(`<Directory[^>]*slug="fleabag"[^>]*ratingKey="(\\d+)"`, 'i');
  const slugShowReAlt = new RegExp(`<Directory[^>]*ratingKey="(\\d+)"[^>]*slug="fleabag"`, 'i');
  const titleShowRe = new RegExp(`<Directory[^>]*title="Fleabag"[^>]*ratingKey="(\\d+)"`, 'i');
  const titleShowReAlt = new RegExp(`<Directory[^>]*ratingKey="(\\d+)"[^>]*title="Fleabag"`, 'i');
  const showMatch = xml.match(imdbShowRe)
    || xml.match(imdbShowReAlt)
    || xml.match(slugShowRe)
    || xml.match(slugShowReAlt)
    || xml.match(titleShowRe)
    || xml.match(titleShowReAlt);
  if (!showMatch) {
    emit('canary.show_not_found', { section: FLEABAG_SECTION });
    return null;
  }
  const showKey = showMatch[1];
  const { response: allLeaves, safeUrl: leavesUrl } = await timedFetch(
    `${PLEX_URL}/library/metadata/${showKey}/allLeaves?X-Plex-Token=${PLEX_TOKEN}`,
  );
  if (!allLeaves.ok) {
    emit('canary.leaves_unreachable', { safe_url: leavesUrl, status: allLeaves.status });
    return null;
  }
  const leavesXml = await allLeaves.text();
  // Find S01E03. The attribute order varies across Plex versions
  // (e.g. index may appear before parentIndex). Use a regex that
  // matches the Video element by its three identifying attributes
  // regardless of order, then extract the key.
  const epRe = new RegExp(
    `<Video\\b(?=[^>]*\\bindex="3")(?=[^>]*\\bparentIndex="1")[^>]*?\\bkey="\\/library\\/metadata\\/(\\d+)"`,
    'i'
  );
  // Fallback: match by ratingKey when key is absent or out of order.
  const epReRatingKey = new RegExp(
    `<Video\\b(?=[^>]*\\bindex="3")(?=[^>]*\\bparentIndex="1")[^>]*?\\bratingKey="(\\d+)"`,
    'i'
  );
  const epMatch = leavesXml.match(epRe) || leavesXml.match(epReRatingKey);
  if (!epMatch) {
    emit('canary.episode_not_found', { show_key: showKey });
    return null;
  }
  const episodeKey = epMatch[1];
  const { response: meta, safeUrl: metaUrl } = await timedFetch(
    `${PLEX_URL}/library/metadata/${episodeKey}?X-Plex-Token=${PLEX_TOKEN}`,
  );
  if (!meta.ok) {
    emit('canary.episode_meta_unreachable', { safe_url: metaUrl, status: meta.status });
    return null;
  }
  const metaXml = await meta.text();
  // Match the <Part> element. Attribute order varies across Plex
  // versions (e.g. duration/container may appear between key and
  // file). We extract attributes independently.
  const partMatch = metaXml.match(/<Part\b([^>]*)>/);
  if (!partMatch) {
    emit('canary.part_not_found', { episode_key: episodeKey });
    return null;
  }
  const partAttrs = partMatch[1];
  const partId = (partAttrs.match(/\bid="(\d+)"/) || [])[1];
  const partKey = (partAttrs.match(/\bkey="([^"]+)"/) || [])[1];
  const partFile = (partAttrs.match(/\bfile="([^"]+)"/) || [])[1];
  const partSize = (partAttrs.match(/\bsize="(\d+)"/) || [])[1];
  if (!partId || !partKey || !partFile || !partSize) {
    emit('canary.part_not_found', { episode_key: episodeKey, parsed: { partId, partKey, partFile, partSize } });
    return null;
  }
  return {
    partId: Number(partId),
    partKey,
    partFile,
    partSize: Number(partSize),
  };
}

async function fetchMetrics() {
  try {
    const r = await fetch(`${MEDIA_SEARCH_URL}/api/metrics`);
    if (!r.ok) return null;
    const body = await r.json();
    return body?.plex_refresh || null;
  } catch { return null; }
}

async function main() {
  emit('canary.start', { plex_url: PLEX_URL, with_metrics: WITH_METRICS });
  if (!PLEX_TOKEN) {
    emit('canary.abort', { reason: 'PLEX_TOKEN not set' });
    process.exit(2);
  }

  const part = await resolvePart();
  if (!part || !part.partSize) {
    emit('canary.abort', { reason: 'could not resolve Fleabag part' });
    process.exit(2);
  }
  emit('canary.part_resolved', {
    part_id: part.partId, part_file: part.partFile, part_size: part.partSize,
  });
  const size = part.partSize;
  if (size < 10 * 1024 * 1024) {
    emit('canary.warn', { reason: 'part is unusually small; size sanity failed', size });
  }

  // Pre-metrics snapshot
  const before = WITH_METRICS ? await fetchMetrics() : null;
  if (before) emit('canary.metrics_before', { plex_refresh: before });

  // 1. Source opens — proven by the first successful range read.
  // 2. Beginning bytes
  const r2 = await readRange(part.partKey, { start: 0, end: Math.min(MAX_BYTES - 1, size - 1), size });
  okOr('direct_play.open_beginning', r2.ok, { status: r2.status, content_range: r2.contentRange, actual: r2.actual });
  // 3. Forward seek — ~25% into the file
  const r3 = await readRange(part.partKey, {
    start: Math.floor(size * 0.25),
    end: Math.floor(size * 0.25) + 256 * 1024 - 1,
    size,
  });
  okOr('direct_play.forward_seek_25pct', r3.ok, { status: r3.status, content_range: r3.contentRange });
  // 4. Another forward seek — ~50%
  const r4 = await readRange(part.partKey, {
    start: Math.floor(size * 0.50),
    end: Math.floor(size * 0.50) + 256 * 1024 - 1,
    size,
  });
  okOr('direct_play.forward_seek_50pct', r4.ok, { status: r4.status, content_range: r4.contentRange });
  // 5. Backward seek — back to ~10%
  const r5 = await readRange(part.partKey, {
    start: Math.floor(size * 0.10),
    end: Math.floor(size * 0.10) + 256 * 1024 - 1,
    size,
  });
  okOr('direct_play.backward_seek_10pct', r5.ok, { status: r5.status, content_range: r5.contentRange });
  // 6. Near-tail seek — last 1 MiB
  const r6 = await readRange(part.partKey, {
    start: size - MAX_BYTES,
    end: size - 1,
    size,
  });
  okOr('direct_play.near_tail', r6.ok, { status: r6.status, content_range: r6.contentRange, actual: r6.actual });
  // 7. Stop / connection close
  const stop = await stopSession(part.partKey);
  okOr('direct_play.stop_close', stop.status === 206, { status: stop.status });
  // 8. Restart
  const r8a = await readRange(part.partKey, { start: 0, end: MAX_BYTES - 1, size });
  okOr('direct_play.restart_beginning', r8a.ok, { status: r8a.status, content_range: r8a.contentRange });
  // 9. Non-zero read again
  const r9 = await readRange(part.partKey, {
    start: 64 * 1024,
    end: 64 * 1024 + 64 * 1024 - 1,
    size,
  });
  okOr('direct_play.restart_nonzero', r9.ok, { status: r9.status, content_range: r9.contentRange });

  // B11 invariant: zero refresh delta
  await delay(200);
  const after = WITH_METRICS ? await fetchMetrics() : null;
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
  } else {
    emit('canary.skip', { section: 'metrics', reason: 'unavailable' });
  }

  // Token-leak check
  const leak = events.some((e) => JSON.stringify(e).includes(PLEX_TOKEN));
  okOr('direct_play.token_never_logged', !leak, { checked_events: events.length });

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
