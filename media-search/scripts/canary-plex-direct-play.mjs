#!/usr/bin/env node
/**
 * Direct-Play + Refresh-Invariant Canary
 *
 * Slice 2.5 / B7 (orig) + Slice 2.9 stop/restart fix: prove that the
 * direct-play session for Fleabag S01E03 (tt5687612) opens, supports
 * multiple seeks, STOPS cleanly without poisoning the provider
 * capability, and a FRESH session restarts.
 *
 * The fix (Slice 2.9): the prior revision called `controller.abort()`
 * on a controller that timedFetch had already replaced with its own
 * internal controller. That left the "stop" branch effectively a
 * no-op against a header-only `Connection: close` — which technically
 * worked but made the contract ambiguous: a future reader could not
 * tell whether the abort was load-bearing for any subsequent request.
 *
 * This revision models the canary as TWO EXPLICIT SESSIONS:
 *
 *   SESSION 1 — opening + seeks + stop/close
 *     - beginning Range  → 206
 *     - forward seek 25% → 206
 *     - forward seek 50% → 206
 *     - backward seek ~10% → 206
 *     - near-tail          → 206
 *     - stop / close (Connection: close, no abort of anything)
 *
 *   SESSION 2 — independent fetch/connection
 *     - reopen beginning or small nonzero range → 206
 *     - seek once                              → 206
 *     - stop cleanly
 *
 * CRITICAL: each session owns a private AbortController. We never
 * call .abort() on a controller whose fetch has already returned,
 * and we never share a single signal across the two sessions. The
 * stop in session 1 sends `Connection: close` and discards the
 * response body — it does NOT touch any external state.
 *
 * The canary MUST demonstrate that client stop/close does NOT
 * poison the provider capability: session 2 sees a fresh 206
 * from the same Plex Part.
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
const FETCH_TIMEOUT_MS = 120_000; // 120s: accommodates cold capability + slow provider path

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

/**
 * Session-scoped fetch. Each call constructs a brand-new AbortController
 * bound to its OWN timeout. The signal is private to this call.
 * The returned `controller` is exposed so the caller can decide
 * whether to abort — but the contract here is: do NOT abort a
 * controller whose fetch has already resolved.
 *
 * @returns {Promise<{response: Response, safeUrl: string, elapsedMs: number, controller: AbortController}>}
 */
async function sessionFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(new Error('canary-fetch-timeout')); } catch { /* ignore */ }
  }, FETCH_TIMEOUT_MS);
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
    return { response, safeUrl, elapsedMs: Date.now() - start, controller };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a single range. Each invocation is its own session.
 * No shared AbortController across calls.
 */
async function readRange(partKey, { start, end, size }) {
  if (end >= size) end = size - 1;
  const expected = end - start + 1;
  const url = `${PLEX_URL}${partKey}?X-Plex-Token=${PLEX_TOKEN}`;
  const { response, safeUrl, elapsedMs, controller } = await sessionFetch(url, {
    headers: { range: `bytes=${start}-${end}` },
  });
  try {
    const observed = Number(response.headers.get('content-length') || 0);
    const buf = Buffer.from(await response.arrayBuffer());
    const cr = response.headers.get('content-range');
    const ok = response.status === 206
      && observed === expected
      && buf.length === expected
      && cr === `bytes ${start}-${end}/${size}`;
    return { ok, status: response.status, contentRange: cr, expected, actual: buf.length, elapsedMs, safeUrl };
  } finally {
    // The fetch has resolved and we have read the body. The signal
    // is now attached to nothing observable; we still avoid calling
    // .abort() on it because doing so is the exact pattern that
    // conflated stop and abort in the prior revision. Letting the
    // controller be GC'd is the cleanest expression of "done".
    void controller;
  }
}

/**
 * Stop / close the current session. This is the SESSION 1 only.
 *
 * Strategy: a single GET with `Connection: close` so the underlying
 * socket is closed by the server. We DO NOT abort any controller;
 * we DO NOT touch session 2's state; we DO NOT touch any shared
 * signal. The connection-level close is the only mechanism.
 *
 * Returns the final response status. The response body is discarded
 * without being held beyond this function.
 */
async function stopSession(partKey) {
  const url = `${PLEX_URL}${partKey}?X-Plex-Token=${PLEX_TOKEN}`;
  // This fetch has its OWN AbortController inside sessionFetch.
  // We never call .abort() externally. The Connection: close
  // header asks the server to close the socket after the response.
  const { response, safeUrl } = await sessionFetch(url, {
    headers: { range: 'bytes=0-0', connection: 'close' },
  });
  return { status: response.status, safeUrl };
}

async function resolvePart() {
  // Strategy 1: explicit env override with known size (avoids Plex metadata lookup)
  if (process.env.FLEABAG_PART_ID) {
    return {
      partId: Number(process.env.FLEABAG_PART_ID),
      partKey: `/library/parts/${process.env.FLEABAG_PART_ID}/file.mkv`,
      partSize: Number(process.env.FLEABAG_E03_SIZE || 0),
      partFile: process.env.FLEABAG_PART_FILE || '<env override>',
    };
  }
  // Strategy 2: walk the season children (show->season->children).
  // The season children response includes Part elements inline, so we can
  // extract E03's Part from a single response without a separate metadata
  // request (which can timeout on episodes with large metadata).
  const showKey = '177';
  const { response: seasonResp, safeUrl: seasonUrl } = await sessionFetch(
    `${PLEX_URL}/library/metadata/${showKey}/children?X-Plex-Token=${PLEX_TOKEN}`,
  );
  if (!seasonResp.ok) {
    emit('canary.season_unreachable', { safe_url: seasonUrl, status: seasonResp.status });
    return null;
  }
  const seasonXml = await seasonResp.text();
  // Find Season 1 — the Directory has index="1" and a children key
  const seasonMatch = seasonXml.match(/<Directory\b(?=[^>]*\bindex="1")[^>]*\bkey="\/library\/metadata\/(\d+)\/children"[^>]*>/i)
    || seasonXml.match(/<Directory\b(?=[^>]*\bindex="1")[^>]*\bkey="\/library\/metadata\/(\d+)"[^>]*>/i)
    || seasonXml.match(/<Directory\b[^>]*\bkey="\/library\/metadata\/(\d+)\/children"[^>]*>/i);
  if (!seasonMatch) {
    emit('canary.season_not_found', { show_key: showKey });
    return null;
  }
  const seasonKey = seasonMatch[1];
  const { response: epResp, safeUrl: epUrl } = await sessionFetch(
    `${PLEX_URL}/library/metadata/${seasonKey}/children?X-Plex-Token=${PLEX_TOKEN}`,
  );
  if (!epResp.ok) {
    emit('canary.episode_list_unreachable', { safe_url: epUrl, status: epResp.status });
    return null;
  }
  const epXml = await epResp.text();
  // Find Episode 3 (index="3", parentIndex="1") — extract its Part inline
  // The Part element is a sibling inside the Video element.
  const epMatch = epXml.match(
    /<Video\b(?=[^>]*\bindex="3")(?=[^>]*\bparentIndex="1")[^>]*>[\s\S]*?<Part\b([^>]*)>/i
  );
  if (!epMatch) {
    emit('canary.episode_not_found', { season_key: seasonKey });
    return null;
  }
  const partAttrs = epMatch[epMatch.length - 1];
  const partId = (partAttrs.match(/\bid="(\d+)"/) || [])[1];
  const partKey = (partAttrs.match(/\bkey="([^"]+)"/) || [])[1];
  const partFile = (partAttrs.match(/\bfile="([^"]+)"/) || [])[1];
  const partSize = (partAttrs.match(/\bsize="(\d+)"/) || [])[1];
  if (!partId || !partKey || !partFile || !partSize) {
    emit('canary.part_not_found', { season_key: seasonKey, parsed: { partId, partKey, partFile, partSize } });
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

  // ─────────────────────────────────────────────────────────────────────
  // SESSION 1: open, seek, stop/close
  // Each step is its own independent sessionFetch() call. There is
  // no shared AbortController. The stop/close at the end uses
  // Connection: close and never aborts anything.
  // ─────────────────────────────────────────────────────────────────────
  emit('canary.session1_begin', { part_id: part.partId });

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
  // 7. Stop / connection close — does NOT abort any signal
  const stop = await stopSession(part.partKey);
  okOr('direct_play.stop_close', stop.status === 206, { status: stop.status });
  emit('canary.session1_end', { part_id: part.partId });

  // ─────────────────────────────────────────────────────────────────────
  // SESSION 2: independent fetch/connection.
  // sessionFetch() returns a brand-new AbortController per call.
  // Nothing from session 1 is in scope here.
  // ─────────────────────────────────────────────────────────────────────
  emit('canary.session2_begin', { part_id: part.partId });

  // 8. Reopen beginning or small nonzero range
  const r8a = await readRange(part.partKey, { start: 0, end: MAX_BYTES - 1, size });
  okOr('direct_play.restart_beginning', r8a.ok, { status: r8a.status, content_range: r8a.contentRange });
  // 9. Seek once
  const r9 = await readRange(part.partKey, {
    start: 64 * 1024,
    end: 64 * 1024 + 64 * 1024 - 1,
    size,
  });
  okOr('direct_play.restart_nonzero', r9.ok, { status: r9.status, content_range: r9.contentRange });
  // 10. Stop cleanly
  const stop2 = await stopSession(part.partKey);
  okOr('direct_play.restart_stop_close', stop2.status === 206, { status: stop2.status });
  emit('canary.session2_end', { part_id: part.partId });

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
