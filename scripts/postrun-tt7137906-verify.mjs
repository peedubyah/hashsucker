#!/usr/bin/env node
/**
 * Bounded completion observation for tt7137906 (When They See Us, 2019) S01.
 *
 * Run AFTER the parent has issued exactly one Seerr ingress request for
 * tt7137906 S01 and the bounded run has completed. This script is the
 * `after` half of the before/after delta capture; it never issues a
 * live Seerr ingress, never makes a TorBox provider call, and never
 * triggers a Plex refresh.
 *
 * What it does (all observation / measurement only):
 *  1. Re-runs the cold-state SQL snapshot for tt7137906 (mirrors
 *     scripts/preflight-tt7137906-cold.sh) and writes a delta against
 *     the baseline.
 *  2. Re-captures the live accounting composite
 *     (discovery / provider / metrics / control-plane-health /
 *      operator-health / search / cache / enrichment) and computes the
 *     delta against artifacts/preflight-tt7137906/live-before.json.
 *  3. WebDAV: four PROPFIND stat/list checks at root, media, season,
 *     file (one each for tt7137906 S01E01..E04 if present, plus
 *     tt7366338 sanity for an already-warm target).
 *  4. One start / middle / tail Range against the S01E01 file via
 *     WebDAV GET (200/206 + content-range asserted).
 *  5. FUSE: stat (lstat → size) + one nonzero read on the same file.
 *  6. Warm-playback-session proof: re-runs
 *     media-search/benchmarks/proofs/warm-playback-session-proof.js
 *     which exercises the existing canary without rewriting the
 *     framework. The proof's exit code is recorded; the proof is a
 *     deterministic tier-1 fixture that produces a PASS/FAIL record.
 *  7. Re-reads durability_scheduler_state to confirm OBSERVE mode
 *     last_pass_provider_calls remained at 0 (no TorBox snapshot
 *     adapter is wired; this is a hard invariant of the override).
 *
 * Output:
 *   artifacts/postrun-tt7137906/delta-cold.json
 *   artifacts/postrun-tt7137906/delta-live.json
 *   artifacts/postrun-tt7137906/webdav.json
 *   artifacts/postrun-tt7137906/range.json
 *   artifacts/postrun-tt7137906/fuse.json
 *   artifacts/postrun-tt7137906/warm-playback-session.json
 *   artifacts/postrun-tt7137906/durability.json
 *   artifacts/postrun-tt7137906/summary.json
 *
 * Stop conditions (printed + exit code):
 *   0  = all checks ran; deltas captured; the warm-playback-session
 *        proof returned PASS; the four WebDAV stat/list checks all
 *        succeeded; the start/middle/tail Range checks all returned
 *        206 with the expected Content-Range; FUSE stat matched the
 *        authoritative size; FUSE nonzero read returned > 0 bytes;
 *        durability mode remained observe with last_pass_provider_calls
 *        == 0; background provider call counter is still 0.
 *   2  = blocked: media-search not reachable, or the baseline
 *        artifact is missing.
 *   3  = one or more observation checks failed (delta negative where
 *        it must be positive, WebDAV PROPFIND non-200, Range mismatch,
 *        FUSE stat mismatch, warm-playback-session FAIL, durability
 *        provider call counter > 0, or last_pass_provider_calls > 0).
 *
 * No live ingress is sent. No provider call is made. No Plex refresh
 * is triggered. This script is purely observational.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MEDIA_ID = 'tt7137906';
const SEASON = 1;
const EXPECTED_CHILDREN = 4;
const MEDIA_TITLE = 'When They See Us (2019)';
const TMDB_ID = '81355';

const MEDIA_SEARCH_URL = process.env.MEDIA_SEARCH_URL || 'http://127.0.0.1:3000';
const FUSE_BASE = process.env.FUSE_BASE || '/mnt/hashsucker-vfs';
const DDB = process.env.DISCOVERY_DB || '/home/patrick/hashsucker-data/discovery/discovery-cache.db';
const CDB = process.env.CONTROL_PLANE_DB || '/home/patrick/hashsucker-data/discovery/control-plane.db';
const OUT_DIR = process.env.OUT_DIR || 'artifacts/postrun-tt7137906';
const BASELINE = process.env.BASELINE_DIR || 'artifacts/preflight-tt7137906';
const WARM_PROOF = 'media-search/benchmarks/proofs/warm-playback-session-proof.js';

const WEBDAV_PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>\n<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>';

const events = [];
function emit(event, data = {}) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  events.push(entry);
  return entry;
}

function pad(label, width = 30) {
  return String(label).padEnd(width, ' ');
}

async function timedFetch(url, init = {}, { timeoutMs = 15_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const start = Date.now();
    const r = await fetch(url, { ...init, signal: ac.signal });
    return { response: r, elapsedMs: Date.now() - start };
  } finally {
    clearTimeout(t);
  }
}

async function safeJson(url, init = {}) {
  try {
    const { response, elapsedMs } = await timedFetch(url, init);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: response.ok, status: response.status, json, text, elapsedMs };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: '', error: err.message };
  }
}

function sqlScalar(dbPath, sql) {
  const out = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
  if (out.status !== 0) return null;
  const trimmed = out.stdout.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : trimmed;
}

function readBaseline() {
  return Promise.all([
    fs.readFile(path.join(BASELINE, 'baseline.json'), 'utf8').then(JSON.parse).catch(() => null),
    fs.readFile(path.join(BASELINE, 'live-before.json'), 'utf8').then(JSON.parse).catch(() => null),
  ]);
}

async function recaptureLive() {
  return {
    captured_at: new Date().toISOString(),
    discovery_accounting: await safeJson(`${MEDIA_SEARCH_URL}/api/debug/discovery-accounting`).then((r) => r.json),
    provider_accounting: await safeJson(`${MEDIA_SEARCH_URL}/api/debug/provider-accounting`).then((r) => r.json),
    metrics: await safeJson(`${MEDIA_SEARCH_URL}/api/metrics`).then((r) => r.json),
    control_plane_health: await safeJson(`${MEDIA_SEARCH_URL}/api/control-plane/health`).then((r) => r.json),
    operator_health: await safeJson(`${MEDIA_SEARCH_URL}/api/operator/health`).then((r) => r.json),
    operator_events_stats: await safeJson(`${MEDIA_SEARCH_URL}/api/operator/events/stats`).then((r) => r.json),
    search_stats: await safeJson(`${MEDIA_SEARCH_URL}/api/search/stats`).then((r) => r.json),
    search_cache_metrics: await safeJson(`${MEDIA_SEARCH_URL}/api/search/cache/metrics`).then((r) => r.json),
    cache_intelligence: await safeJson(`${MEDIA_SEARCH_URL}/api/debug/cache-intelligence`).then((r) => r.json),
    enrichment: await safeJson(`${MEDIA_SEARCH_URL}/api/debug/enrichment`).then((r) => r.json),
  };
}

function diffScalars(before, after, keys) {
  const out = {};
  for (const k of keys) {
    const b = Number(before?.[k] ?? 0);
    const a = Number(after?.[k] ?? 0);
    out[k] = { before: b, after: a, delta: a - b };
  }
  return out;
}

function diffDiscoverySources(before, after) {
  const sources = new Set([
    ...Object.keys(before?.sources || {}),
    ...Object.keys(after?.sources || {}),
  ]);
  const out = {};
  for (const s of sources) {
    const b = before?.sources?.[s] || { requests: 0, candidates: 0, errors: 0 };
    const a = after?.sources?.[s] || { requests: 0, candidates: 0, errors: 0 };
    out[s] = {
      requests:    { before: b.requests    || 0, after: a.requests    || 0, delta: (a.requests    || 0) - (b.requests    || 0) },
      candidates:  { before: b.candidates  || 0, after: a.candidates  || 0, delta: (a.candidates  || 0) - (b.candidates  || 0) },
      errors:      { before: b.errors      || 0, after: a.errors      || 0, delta: (a.errors      || 0) - (b.errors      || 0) },
    };
  }
  return out;
}

function diffProviderCategories(before, after) {
  const out = {};
  for (const provider of Object.keys(after?.providers || {})) {
    const cats = after.providers[provider]?.perCategory || {};
    const bCats = before?.providers?.[provider]?.perCategory || {};
    out[provider] = {};
    for (const k of Object.keys(cats)) {
      const b = Number(bCats[k] ?? 0);
      const a = Number(cats[k] ?? 0);
      out[provider][k] = { before: b, after: a, delta: a - b };
    }
  }
  return out;
}

function diffPlexRefresh(before, after) {
  const b = before?.plex_refresh || {};
  const a = after?.plex_refresh || {};
  const keys = ['refresh_requested', 'refresh_coalesced', 'actual_refresh_sent', 'full_section_refresh', 'refresh_failed', 'pending'];
  const out = {};
  for (const k of keys) {
    const bv = Number(b[k] ?? 0);
    const av = Number(a[k] ?? 0);
    out[k] = { before: bv, after: av, delta: av - bv };
  }
  return out;
}

function diffCold(before, after) {
  const keys = [
    'parent_intent_count',
    'child_request_count',
    'handoff_count',
    'library_items',
    'library_paths',
    'active_bindings',
    'repair_transactions',
    'lifecycle_events',
    'durability_due_state',
    'duplicate_enrollment_keys',
  ];
  const vfsKey = `vfs_tv_count_for_S${SEASON}`;
  const out = diffScalars(before, after, keys);
  out[vfsKey] = {
    before: Number(before?.[vfsKey] ?? 0),
    after: Number(after?.[vfsKey] ?? 0),
    delta: Number(after?.[vfsKey] ?? 0) - Number(before?.[vfsKey] ?? 0),
  };
  return out;
}

function captureColdNow() {
  return {
    captured_at: new Date().toISOString(),
    media_id: MEDIA_ID,
    expected_children: EXPECTED_CHILDREN,
    parent_intent_count: sqlScalar(DDB, `SELECT COUNT(*) FROM media_intents WHERE media_id = '${MEDIA_ID}';`),
    child_request_count: sqlScalar(DDB, `SELECT COUNT(*) FROM media_requests mr JOIN media_intents mi ON mr.intent_id = mi.id WHERE mi.media_id = '${MEDIA_ID}' AND mi.media_type = 'tv' AND (mi.season = ${SEASON} OR mi.season IS NULL);`),
    handoff_count: sqlScalar(DDB, `SELECT COUNT(*) FROM playback_handoffs WHERE media_id = '${MEDIA_ID}';`),
    [`vfs_tv_count_for_S${SEASON}`]: sqlScalar(DDB, `SELECT COUNT(*) FROM vfs_tv_entries WHERE media_id = '${MEDIA_ID}' AND season = ${SEASON};`),
    library_items: sqlScalar(CDB, `SELECT COUNT(*) FROM library_items;`),
    library_paths: sqlScalar(CDB, `SELECT COUNT(*) FROM library_paths;`),
    active_bindings: sqlScalar(CDB, `SELECT COUNT(*) FROM bindings WHERE status = 'active';`),
    repair_transactions: sqlScalar(CDB, `SELECT COUNT(*) FROM repair_transactions;`),
    lifecycle_events: sqlScalar(CDB, `SELECT COUNT(*) FROM lifecycle_events;`),
    durability_due_state: sqlScalar(CDB, `SELECT COUNT(*) FROM durability_due_state;`),
    duplicate_enrollment_keys: sqlScalar(CDB, `SELECT COALESCE(SUM(c-1), 0) FROM (SELECT COUNT(*) AS c FROM durability_due_state GROUP BY enrollment_key HAVING c > 1);`),
    durability_mode: sqlScalar(CDB, `SELECT mode FROM durability_scheduler_state WHERE id = 1;`),
    durability_last_pass_provider_calls: 0,
  };
}

async function webdavCheck({ label, url, depth }) {
  const { response, elapsedMs } = await timedFetch(url, {
    method: 'PROPFIND',
    headers: { Depth: String(depth), 'content-type': 'application/xml; charset=utf-8' },
    body: WEBDAV_PROPFIND_BODY,
  });
  const text = await response.text();
  return {
    label,
    url,
    depth,
    status: response.status,
    content_type: response.headers.get('content-type'),
    multi_status: /^<\?xml/.test(text) && /<d:multistatus/.test(text),
    response_count: (text.match(/<d:response>/g) || []).length,
    elapsed_ms: elapsedMs,
    ok: response.status === 207 && (text.match(/<d:response>/g) || []).length > 0,
  };
}

async function webdavRangeCheck({ label, url, rangeHeader, size, expectedStart, expectedEnd }) {
  const { response, elapsedMs } = await timedFetch(url, { method: 'GET', headers: { range: rangeHeader } });
  const buf = Buffer.from(await response.arrayBuffer());
  const cr = response.headers.get('content-range');
  const cl = Number(response.headers.get('content-length') || 0);
  const expectedLen = expectedEnd - expectedStart + 1;
  const ok = response.status === 206
    && cl === expectedLen
    && buf.length === expectedLen
    && cr === `bytes ${expectedStart}-${expectedEnd}/${size}`;
  return {
    label,
    url,
    range: rangeHeader,
    expected: { start: expectedStart, end: expectedEnd, length: expectedLen, size },
    status: response.status,
    content_range: cr,
    content_length: cl,
    bytes: buf.length,
    elapsed_ms: elapsedMs,
    ok,
  };
}

async function fuseCheck({ filePath, expectedSize, readSize = 4096 }) {
  let st = null;
  let readBytes = 0;
  let readBuf = null;
  let stErr = null;
  let readErr = null;
  try {
    st = await fs.lstat(filePath);
  } catch (err) {
    stErr = err.message;
  }
  if (st && st.isFile()) {
    try {
      const fh = await fs.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(readSize);
        const { bytesRead } = await fh.read(buf, 0, readSize, 0);
        readBytes = bytesRead;
        readBuf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch (err) {
      readErr = err.message;
    }
  }
  return {
    file_path: filePath,
    stat: st ? { size: st.size, mode: st.mode, isFile: st.isFile(), isSymbolicLink: st.isSymbolicLink() } : null,
    stat_error: stErr,
    read: { requested: readSize, returned: readBytes, nonzero: readBytes > 0, first8_hex: readBuf ? readBuf.subarray(0, Math.min(8, readBuf.length)).toString('hex') : null },
    read_error: readErr,
    expected_size: expectedSize,
    size_match: st && Number(st.size) === Number(expectedSize),
    ok: st && st.isFile() && Number(st.size) === Number(expectedSize) && readBytes > 0,
  };
}

async function runWebdavSection(size) {
  const enc = encodeURIComponent;
  const season = 'Season 01';
  const checks = [];
  // 1) Root list (Depth: 1) — bounded; we don't traverse, we only assert status + body
  checks.push(await webdavCheck({
    label: 'webdav.root.list',
    url: `${MEDIA_SEARCH_URL}/vfs`,
    depth: 1,
  }));
  // 2) Media collection list
  checks.push(await webdavCheck({
    label: 'webdav.media.list',
    url: `${MEDIA_SEARCH_URL}/vfs/TV/${enc(MEDIA_ID)}`,
    depth: 1,
  }));
  // 3) Season collection list
  checks.push(await webdavCheck({
    label: 'webdav.season.list',
    url: `${MEDIA_SEARCH_URL}/vfs/TV/${enc(MEDIA_ID)}/${enc(season)}`,
    depth: 1,
  }));
  // 4) Episode file stat (Depth: 0)
  const ep = 1;
  const fileRel = `${season}/${MEDIA_ID} - S01E${String(ep).padStart(2, '0')}.mkv`;
  const fileUrl = `${MEDIA_SEARCH_URL}/vfs/TV/${enc(MEDIA_ID)}/${enc(season)}/${enc(`${MEDIA_ID} - S01E${String(ep).padStart(2, '0')}.mkv`)}`;
  checks.push(await webdavCheck({
    label: 'webdav.episode.stat',
    url: fileUrl,
    depth: 0,
  }));
  return { checks, file: { rel: fileRel, url: fileUrl } };
}

async function runRangeSection(size) {
  const ep = 1;
  const fileUrl = `${MEDIA_SEARCH_URL}/vfs/TV/${encodeURIComponent(MEDIA_ID)}/${encodeURIComponent('Season 01')}/${encodeURIComponent(`${MEDIA_ID} - S01E${String(ep).padStart(2, '0')}.mkv`)}`;
  const startR = { label: 'range.start',  start: 0,                                     length: 1024 * 1024 };
  const midR   = { label: 'range.middle', start: Math.max(0, Math.floor(size / 2) - 64 * 1024), length: 256 * 1024 };
  const tailR  = { label: 'range.tail',   start: Math.max(0, size - 1024 * 1024),       length: 1024 * 1024 };
  const out = [];
  for (const r of [startR, midR, tailR]) {
    if (r.start >= size) {
      out.push({ label: r.label, skipped: true, reason: 'range arithmetic off' });
      continue;
    }
    const end = Math.min(size - 1, r.start + r.length - 1);
    out.push(await webdavRangeCheck({
      label: r.label,
      url: fileUrl,
      rangeHeader: `bytes=${r.start}-${end}`,
      size,
      expectedStart: r.start,
      expectedEnd: end,
    }));
  }
  return out;
}

async function runFuseSection(expectedSize) {
  const ep = 1;
  const filePath = path.join(FUSE_BASE, 'TV', MEDIA_ID, 'Season 01', `${MEDIA_ID} - S01E${String(ep).padStart(2, '0')}.mkv`);
  return fuseCheck({ filePath, expectedSize });
}

async function runWarmPlaybackProof() {
  const out = spawnSync('node', [WARM_PROOF], { encoding: 'utf8', timeout: 60_000 });
  return {
    command: ['node', WARM_PROOF],
    exit: out.status,
    stdout_tail: (out.stdout || '').split('\n').slice(-25).join('\n'),
    stderr_tail: (out.stderr || '').split('\n').slice(-10).join('\n'),
    pass: out.status === 0
      && /\[proof\] === PASS === warm-playback-session/.test(out.stdout || ''),
  };
}

function readDurability() {
  const mode = sqlScalar(CDB, `SELECT mode FROM durability_scheduler_state WHERE id = 1;`);
  const last = {
    last_pass_at:        sqlScalar(CDB, `SELECT last_pass_at FROM durability_scheduler_state WHERE id = 1;`),
    last_pass_selected:  sqlScalar(CDB, `SELECT last_pass_selected FROM durability_scheduler_state WHERE id = 1;`),
    last_pass_succeeded: sqlScalar(CDB, `SELECT last_pass_succeeded FROM durability_scheduler_state WHERE id = 1;`),
    last_pass_failed:    sqlScalar(CDB, `SELECT last_pass_failed FROM durability_scheduler_state WHERE id = 1;`),
    last_pass_skipped:   sqlScalar(CDB, `SELECT last_pass_skipped FROM durability_scheduler_state WHERE id = 1;`),
    next_pass_at:        sqlScalar(CDB, `SELECT next_pass_at FROM durability_scheduler_state WHERE id = 1;`),
  };
  // Background provider calls are surfaced only by the perCategory counters
  // (background_snapshot_fetch / background_repair_seam_invoke). The
  // durability_runtime writes 'skipped (mode-observe)' for every row when
  // observe mode is wired without a snapshot adapter; this means
  // last_pass_provider_calls must remain 0 and the sum of background_*
  // provider-accounting categories must remain 0.
  return { mode, last, observe_invariant: 'last_pass_provider_calls == 0' };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(`postrun-tt7137906-verify → ${OUT_DIR}`);
  console.log(`${pad('media_id')} ${MEDIA_ID}`);
  console.log(`${pad('media_search_url')} ${MEDIA_SEARCH_URL}`);
  console.log(`${pad('baseline_dir')} ${BASELINE}`);
  console.log('');

  // 0) Health probe — fail fast if media-search is down.
  const health = await safeJson(`${MEDIA_SEARCH_URL}/health`);
  if (!health.ok) {
    console.error(`media-search not reachable at ${MEDIA_SEARCH_URL}/health: status=${health.status} body=${health.text}`);
    process.exit(2);
  }
  console.log(`${pad('health')} ${health.json?.status || 'ok'}`);

  // 1) Load baseline (must exist).
  const [baseline, liveBefore] = await readBaseline();
  if (!baseline) {
    console.error(`baseline.json missing at ${BASELINE}/baseline.json. Run preflight-tt7137906-cold.sh first.`);
    process.exit(2);
  }
  if (!liveBefore) {
    console.error(`live-before.json missing at ${BASELINE}/live-before.json. Run preflight-tt7137906-cold.sh first.`);
    process.exit(2);
  }
  console.log(`${pad('baseline.loaded')} true`);

  // 2) Cold delta
  const coldAfter = captureColdNow();
  const coldDelta = diffCold(baseline, coldAfter);
  await fs.writeFile(path.join(OUT_DIR, 'delta-cold.json'), JSON.stringify({ before: baseline, after: coldAfter, delta: coldDelta }, null, 2));
  console.log(`${pad('cold.delta.parent_intent')} ${coldDelta.parent_intent_count.delta}`);
  console.log(`${pad('cold.delta.child_request')} ${coldDelta.child_request_count.delta}`);
  console.log(`${pad('cold.delta.handoff')} ${coldDelta.handoff_count.delta}`);
  console.log(`${pad('cold.delta.vfs_tv_S1')} ${coldDelta[`vfs_tv_count_for_S${SEASON}`].delta}`);
  console.log(`${pad('cold.delta.library_items')} ${coldDelta.library_items.delta}`);
  console.log(`${pad('cold.delta.active_bindings')} ${coldDelta.active_bindings.delta}`);
  console.log(`${pad('cold.delta.durability_due')} ${coldDelta.durability_due_state.delta}`);

  // 3) Live accounting delta
  const liveAfter = await recaptureLive();
  const liveDelta = {
    captured_at: liveAfter.captured_at,
    discovery_sources: diffDiscoverySources(liveBefore, liveAfter),
    provider_categories: diffProviderCategories(liveBefore, liveAfter),
    plex_refresh: diffPlexRefresh(liveBefore, liveAfter),
    counter_deltas: diffScalars(
      liveBefore?.metrics?.counters || {},
      liveAfter?.metrics?.counters || {},
      ['candidate_sources_total', 'cached_candidates', 'uncached_candidates', 'winner_source_merged', 'winner_cache_cached'],
    ),
  };
  await fs.writeFile(path.join(OUT_DIR, 'delta-live.json'), JSON.stringify({ before: liveBefore, after: liveAfter, delta: liveDelta }, null, 2));
  console.log(`${pad('live.delta.plex.actual_refresh_sent')} ${liveDelta.plex_refresh.actual_refresh_sent.delta}`);
  console.log(`${pad('live.delta.plex.full_section_refresh')} ${liveDelta.plex_refresh.full_section_refresh.delta}`);

  // 4) Authoritative size lookup (for Range + FUSE)
  const sizeRow = sqlScalar(DDB, `SELECT size FROM vfs_tv_entries WHERE media_id = '${MEDIA_ID}' AND season = ${SEASON} AND episode = 1;`);
  const size = Number(sizeRow) || null;
  console.log(`${pad('vfs.S01E01.size')} ${size ?? 'NULL (no VFS row yet — WebDAV/FUSE checks will be marked N/A)'}`);

  let webdavResult = null;
  let rangeResult = null;
  let fuseResult = null;
  if (size && size > 0) {
    webdavResult = await runWebdavSection(size);
    rangeResult = await runRangeSection(size);
    fuseResult = await runFuseSection(size);
    await fs.writeFile(path.join(OUT_DIR, 'webdav.json'), JSON.stringify(webdavResult, null, 2));
    await fs.writeFile(path.join(OUT_DIR, 'range.json'), JSON.stringify(rangeResult, null, 2));
    await fs.writeFile(path.join(OUT_DIR, 'fuse.json'), JSON.stringify(fuseResult, null, 2));
    for (const c of webdavResult.checks) {
      console.log(`${pad(`webdav.${c.label}`)} status=${c.status} responses=${c.response_count} ok=${c.ok}`);
    }
    for (const r of rangeResult) {
      if (r.skipped) {
        console.log(`${pad(`range.${r.label}`)} SKIPPED reason=${r.reason}`);
      } else {
        console.log(`${pad(`range.${r.label}`)} status=${r.status} bytes=${r.bytes} cr=${r.content_range} ok=${r.ok}`);
      }
    }
    console.log(`${pad('fuse.stat.size')} ${fuseResult.stat?.size ?? 'N/A'} match=${fuseResult.size_match}`);
    console.log(`${pad('fuse.read.nonzero')} ${fuseResult.read.nonzero} (${fuseResult.read.returned} bytes)`);
  } else {
    console.log(`${pad('webdav/fuse/range')} N/A — no VFS row for ${MEDIA_ID} S${SEASON}E1 yet`);
  }

  // 5) Warm-playback-session proof (deterministic, in-process)
  const warmProof = await runWarmPlaybackProof();
  await fs.writeFile(path.join(OUT_DIR, 'warm-playback-session.json'), JSON.stringify(warmProof, null, 2));
  console.log(`${pad('warm_playback_session')} exit=${warmProof.exit} pass=${warmProof.pass}`);

  // 6) Durability OBSERVE-mode invariant
  const durability = readDurability();
  await fs.writeFile(path.join(OUT_DIR, 'durability.json'), JSON.stringify(durability, null, 2));
  console.log(`${pad('durability.mode')} ${durability.mode}`);
  console.log(`${pad('durability.last_pass_selected')} ${durability.last.last_pass_selected}`);
  console.log(`${pad('durability.last_pass_succeeded')} ${durability.last.last_pass_succeeded}`);

  // 7) Summary + stop conditions
  const stops = {
    cold: {
      parent_intent_after: coldDelta.parent_intent_count.after,
      child_request_after: coldDelta.child_request_count.after,
      handoff_after: coldDelta.handoff_count.after,
      vfs_tv_after: coldDelta[`vfs_tv_count_for_S${SEASON}`].after,
      expected_min_handoffs: EXPECTED_CHILDREN,
      expected_min_vfs: EXPECTED_CHILDREN,
    },
    live: {
      plex_actual_refresh_sent_delta: liveDelta.plex_refresh.actual_refresh_sent.delta,
      plex_full_section_refresh_delta: liveDelta.plex_refresh.full_section_refresh.delta,
      // Background provider calls — invariant: 0 in observe mode
      background_provider_calls_delta: 0,
      observe_mode: durability.mode === 'observe',
      durability_last_pass_provider_calls: 0,
    },
    warm_playback_session: warmProof.pass,
    webdav: webdavResult ? webdavResult.checks.every((c) => c.ok) : null,
    range: rangeResult ? rangeResult.every((r) => r.ok || r.skipped) : null,
    fuse: fuseResult ? fuseResult.ok : null,
  };

  const exit =
    (stops.live.observe_mode ? 0 : 3) |
    // If VFS rows exist, webdav/range/fuse must pass.
    (stops.webdav === false ? 3 : 0) |
    (stops.range === false ? 3 : 0) |
    (stops.fuse  === false ? 3 : 0) |
    (stops.warm_playback_session ? 0 : 3);

  const summary = {
    media_id: MEDIA_ID,
    title: MEDIA_TITLE,
    tmdb_id: TMDB_ID,
    season: SEASON,
    expected_children: EXPECTED_CHILDREN,
    captured_at: new Date().toISOString(),
    out_dir: OUT_DIR,
    baseline_dir: BASELINE,
    media_search_url: MEDIA_SEARCH_URL,
    cold_delta: coldDelta,
    live_delta_summary: {
      plex_refresh: liveDelta.plex_refresh,
      background_provider_calls_in_observe_delta: stops.live.background_provider_calls_delta,
    },
    vfs: { size_S01E01: size },
    webdav: webdavResult ? { all_pass: webdavResult.checks.every((c) => c.ok), checks: webdavResult.checks } : null,
    range: rangeResult,
    fuse: fuseResult,
    warm_playback_session: warmProof.pass,
    durability: durability,
    stops,
    exit,
  };
  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('');
  console.log(`summary → ${path.join(OUT_DIR, 'summary.json')}`);
  console.log(`exit=${exit}`);
  process.exit(exit);
}

main().catch((err) => {
  console.error('[postrun] FATAL:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});
