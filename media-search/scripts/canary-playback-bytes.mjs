#!/usr/bin/env node
/**
 * Playback Byte Canary — bounded byte-access proof against an
 * already-published authoritative file.
 *
 * Scope (per Worker B, slice 2.5):
 *   DIRECT WEBDAV: start Range, multiple middle Ranges, near-tail Range,
 *                  invalid EOF Range (must be 416 + Content-Range bytes STAR/SLASH size)
 *   FUSE:          stat, beginning read, multiple nonzero seeks, tail read,
 *                  bounded ffprobe (best-effort if mount is present)
 *   PLEX:          actual media Part start, middle, tail (current Part ID 418
 *                  for Fleabag E03, re-resolved from Plex metadata)
 *   CONCURRENCY:   ~4 concurrent small reads (64 KiB–1 MiB each)
 *
 * The canary is BOUNDED. It does NOT benchmark throughput, it does NOT
 * download the whole file, and it does NOT print media binary to the
 * terminal.
 *
 * Required env (or .env in repo root):
 *   WEBDAV_BASE_URL      default: http://127.0.0.1:3000
 *   PLEX_URL             default: http://192.168.2.4:32400
 *   PLEX_TOKEN           required for Plex section
 *   PLEX_LIBRARY_SECTION default: 3
 *   FLEABAG_PART_ID      optional override; otherwise resolved from Plex
 *
 * Usage:
 *   node scripts/canary-playback-bytes.mjs
 *   node scripts/canary-playback-bytes.mjs --no-plex
 *   node scripts/canary-playback-bytes.mjs --no-fuse
 *   node scripts/canary-playback-bytes.mjs --concurrency 4
 */

import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

const args = parseArgs(process.argv.slice(2));
const WEBDAV_BASE = process.env.WEBDAV_BASE_URL || 'http://127.0.0.1:3000';
const PLEX_URL = (process.env.PLEX_URL || 'http://192.168.2.4:32400').replace(/\/$/, '');
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const PLEX_SECTION = process.env.PLEX_LIBRARY_SECTION || '3';
const FLEABAG_MEDIA_ID = 'tt5687612';
const FLEABAG_SEASON = 1;
const FLEABAG_EPISODE = 3;
const FLEABAG_CANONICAL = `TV/${FLEABAG_MEDIA_ID}/Season 01/${FLEABAG_MEDIA_ID} - S01E03.mkv`;
const FLEABAG_FUSE = `/mnt/hashsucker-vfs/TV/${FLEABAG_MEDIA_ID}/Season 01/${FLEABAG_MEDIA_ID} - S01E03.mkv`;
const DEFAULT_PART_ID = process.env.FLEABAG_PART_ID || null;
const CONCURRENCY = Number(args.concurrency || process.env.CANARY_CONCURRENCY || 4);
const MAX_BYTES = 1024 * 1024; // 1 MiB upper bound per read
const REQUEST_TIMEOUT_MS = 15_000;

const events = [];

function parseArgs(argv) {
  const out = { concurrency: 4, withPlex: true, withFuse: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-plex') out.withPlex = false;
    else if (a === '--no-fuse') out.withFuse = false;
    else if (a === '--concurrency') {
      out.concurrency = Math.max(1, Math.min(8, Number(argv[++i] || 4)));
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

async function timedFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const start = Date.now();
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, elapsedMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWebDavRange({ range, size, dest }) {
  const url = `${WEBDAV_BASE}/vfs/${FLEABAG_CANONICAL.split('/').map(encodeURIComponent).join('/')}`;
  const start = Date.now();
  const { response, elapsedMs } = await timedFetch(url, { headers: { range } });
  const observed = Number(response.headers.get('content-length') || 0);
  const buf = Buffer.from(await response.arrayBuffer());
  const cr = response.headers.get('content-range');
  if (dest) fs.writeFileSync(dest, buf);
  return { status: response.status, observed, contentRange: cr, elapsedMs, bytes: buf.length };
}

function pickValidRange({ size, start, length }) {
  if (start >= size) return null;
  const end = Math.min(size - 1, start + length - 1);
  return { start, end, header: `bytes=${start}-${end}` };
}

// ─── WebDAV direct ──────────────────────────────────────────────────────────
async function runWebDavSection(size) {
  const sections = [
    { label: 'start',     range: pickValidRange({ size, start: 0,            length: 1024 * 1024 }) },
    { label: 'middle-1',  range: pickValidRange({ size, start: Math.floor(size / 3),     length: 256 * 1024 }) },
    { label: 'middle-2',  range: pickValidRange({ size, start: Math.floor(size / 2) - 64 * 1024, length: 512 * 1024 }) },
    { label: 'middle-3',  range: pickValidRange({ size, start: Math.floor((size * 2) / 3), length: 64 * 1024 }) },
    { label: 'near-tail', range: pickValidRange({ size, start: size - 1024 * 1024, length: 1024 * 1024 }) },
  ];
  for (const s of sections) {
    if (!s.range) {
      emit('canary.skip', { label: s.label, reason: 'range arithmetic off' });
      continue;
    }
    const expected = s.range.end - s.range.start + 1;
    try {
      const result = await fetchWebDavRange({ range: s.range.header, size, dest: `/tmp/playback-canary-${s.label}.bin` });
      const ok = result.status === 206
        && result.observed === expected
        && result.bytes === expected
        && result.contentRange === `bytes ${s.range.start}-${s.range.end}/${size}`;
      okOr(`webdav.${s.label}`, ok, {
        request: s.range.header, status: result.status,
        content_range: result.contentRange, expected, actual: result.bytes,
        elapsed_ms: result.elapsedMs,
      });
    } catch (err) {
      emit('canary.assert_fail', { label: `webdav.${s.label}`, error: err.message });
    }
  }

  // 416: start at exact EOF
  const eofHeader = `bytes=${size}-${size}`;
  try {
    const { response, elapsedMs } = await timedFetch(
      `${WEBDAV_BASE}/vfs/${FLEABAG_CANONICAL.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { range: eofHeader } },
    );
    const cr = response.headers.get('content-range');
    const cl = Number(response.headers.get('content-length') || 0);
    // Read the body so the connection can close cleanly. Don't keep the bytes.
    await response.arrayBuffer();
    const ok = response.status === 416
      && cr === `bytes */${size}`
      && cl > 0
      && cl < 1024; // body should be tiny (the JSON error envelope)
    okOr('webdav.eof_416', ok, {
      request: eofHeader, status: response.status, content_range: cr, content_length: cl, elapsed_ms: elapsedMs,
    });
  } catch (err) {
    emit('canary.assert_fail', { label: 'webdav.eof_416', error: err.message });
  }

  // 416: start well past EOF (start > EOF, end past EOF)
  const overflowHeader = `bytes=${size + 1000}-${size + 2000}`;
  try {
    const { response, elapsedMs } = await timedFetch(
      `${WEBDAV_BASE}/vfs/${FLEABAG_CANONICAL.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { range: overflowHeader } },
    );
    const cr = response.headers.get('content-range');
    await response.arrayBuffer();
    const ok = response.status === 416 && cr === `bytes */${size}`;
    okOr('webdav.overflow_416', ok, {
      request: overflowHeader, status: response.status, content_range: cr, elapsed_ms: elapsedMs,
    });
  } catch (err) {
    emit('canary.assert_fail', { label: 'webdav.overflow_416', error: err.message });
  }

  // 416: end < start
  try {
    const { response, elapsedMs } = await timedFetch(
      `${WEBDAV_BASE}/vfs/${FLEABAG_CANONICAL.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { range: `bytes=${Math.floor(size / 2)}-${Math.floor(size / 4)}` } },
    );
    const cr = response.headers.get('content-range');
    await response.arrayBuffer();
    const ok = response.status === 416 && cr === `bytes */${size}`;
    okOr('webdav.reversed_416', ok, {
      request: `bytes=${Math.floor(size / 2)}-${Math.floor(size / 4)}`,
      status: response.status, content_range: cr, elapsed_ms: elapsedMs,
    });
  } catch (err) {
    emit('canary.assert_fail', { label: 'webdav.reversed_416', error: err.message });
  }

  // 416: malformed multipart
  try {
    const { response, elapsedMs } = await timedFetch(
      `${WEBDAV_BASE}/vfs/${FLEABAG_CANONICAL.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { range: 'bytes=0-10,20-30' } },
    );
    const cr = response.headers.get('content-range');
    await response.arrayBuffer();
    const ok = response.status === 416 && cr === `bytes */${size}`;
    okOr('webdav.multipart_416', ok, {
      request: 'bytes=0-10,20-30', status: response.status, content_range: cr, elapsed_ms: elapsedMs,
    });
  } catch (err) {
    emit('canary.assert_fail', { label: 'webdav.multipart_416', error: err.message });
  }
}

// ─── Bounded concurrency ───────────────────────────────────────────────────
async function runConcurrencySection(size) {
  const offsets = [
    0,
    64 * 1024,
    Math.floor(size / 4),
    Math.floor(size / 2),
    size - 64 * 1024,
  ];
  const queue = offsets.map((start) => pickValidRange({ size, start, length: 64 * 1024 })).filter(Boolean);
  emit('canary.concurrency_start', { concurrency: CONCURRENCY, total: queue.length, max_bytes: MAX_BYTES });
  const start = Date.now();
  const results = await runWithConcurrency(queue.map((r) => () => fetchWebDavRange({ range: r.header, size })), CONCURRENCY);
  const elapsedMs = Date.now() - start;
  let pass = 0;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      const v = r.value;
      const ok = v.status === 206 && v.observed === 65536 && v.bytes === 65536;
      if (ok) pass += 1;
    }
  }
  emit('canary.concurrency_done', { pass, total: results.length, elapsed_ms: elapsedMs });
  // rate-limit evidence: if many failures with status 429 → log evidence.
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.status === 429) {
      emit('canary.rate_limit_evidence', { source: 'webdav', status: 429 });
      break;
    }
  }
}

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= tasks.length) return;
      try {
        results[idx] = { status: 'fulfilled', value: await tasks[idx]() };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ─── FUSE section (best-effort) ─────────────────────────────────────────────
async function runFuseSection(expectedSize) {
  if (!args.withFuse) {
    emit('canary.skip', { section: 'fuse', reason: '--no-fuse' });
    return;
  }
  if (!fs.existsSync(FLEABAG_FUSE)) {
    emit('canary.skip', { section: 'fuse', reason: 'mount not present', path: FLEABAG_FUSE });
    return;
  }
  // stat
  try {
    const stat = fs.statSync(FLEABAG_FUSE);
    const ok = Number.isSafeInteger(stat.size) && stat.size === expectedSize;
    okOr('fuse.stat', ok, { path: FLEABAG_FUSE, expected: expectedSize, actual: stat.size });
  } catch (err) {
    emit('canary.assert_fail', { label: 'fuse.stat', error: err.message });
  }
  // reads
  const reads = [
    { label: 'fuse.beginning', offset: 0, length: 4096 },
    { label: 'fuse.middle-1',  offset: Math.floor(expectedSize / 3), length: 4096 },
    { label: 'fuse.middle-2',  offset: Math.floor(expectedSize / 2), length: 4096 },
    { label: 'fuse.tail',      offset: expectedSize - 4096, length: 4096 },
  ];
  for (const r of reads) {
    if (r.offset < 0 || r.offset + r.length > expectedSize) {
      emit('canary.skip', { label: r.label, reason: 'offset out of range' });
      continue;
    }
    const start = Date.now();
    const fd = fs.openSync(FLEABAG_FUSE, 'r');
    try {
      const buf = Buffer.alloc(r.length);
      fs.readSync(fd, buf, 0, r.length, r.offset);
      const nonzero = buf.some((b) => b !== 0);
      const ok = buf.length === r.length && nonzero;
      okOr(r.label, ok, { offset: r.offset, length: r.length, nonzero, elapsed_ms: Date.now() - start });
    } finally {
      fs.closeSync(fd);
    }
  }
  // bounded ffprobe
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-print_format', 'json',
    '-timeout', '5000000', // 5s I/O timeout (microseconds)
    FLEABAG_FUSE,
  ], { encoding: 'utf8', timeout: 12_000 });
  if (probe.error) {
    emit('canary.skip', { section: 'fuse.ffprobe', reason: probe.error.message });
  } else if (probe.status === 0) {
    let parsed = null;
    try { parsed = JSON.parse(probe.stdout || '{}'); } catch { /* ignore */ }
    const format = parsed?.format?.format_name;
    const ok = typeof format === 'string' && /matroska|webm/i.test(format);
    okOr('fuse.ffprobe', ok, { format_name: format, probe_status: probe.status });
  } else {
    emit('canary.assert_fail', { label: 'fuse.ffprobe', probe_status: probe.status, stderr: probe.stderr?.slice(0, 500) });
  }
}

// ─── Plex section (best-effort) ─────────────────────────────────────────────
async function resolveFleabagPartId() {
  if (DEFAULT_PART_ID) return Number(DEFAULT_PART_ID);
  if (!PLEX_TOKEN) return null;
  try {
    // Find the correct Fleabag show key (grandparentRatingKey).
    const shows = await timedFetch(
      `${PLEX_URL}/library/sections/${PLEX_SECTION}/all?type=4&grandparentTitle=Fleabag&X-Plex-Token=${PLEX_TOKEN}`,
    );
    const showXml = await shows.response.text();
    const grkMatches = [...showXml.matchAll(/grandparentRatingKey="(\d+)"/g)].map((m) => m[1]);
    const grk = [...new Set(grkMatches)][0];
    if (!grk) return null;
    // Episodes of Fleabag season 1.
    const eps = await timedFetch(
      `${PLEX_URL}/library/metadata/${grk}/allLeaves&X-Plex-Token=${PLEX_TOKEN}`,
    );
    const epsXml = await eps.response.text();
    const re = new RegExp(`ratingKey="(\\d+)"[^>]*parentIndex="1"[^>]*index="3"`, 'i');
    const m = epsXml.match(re);
    if (!m) return null;
    const episodeKey = m[1];
    const meta = await timedFetch(
      `${PLEX_URL}/library/metadata/${episodeKey}?X-Plex-Token=${PLEX_TOKEN}`,
    );
    const metaXml = await meta.response.text();
    const partMatch = metaXml.match(/<Part\s+id="(\d+)"\s+key="([^"]+)"\s+file="([^"]+)"\s+size="(\d+)"/);
    if (!partMatch) return null;
    return {
      partId: Number(partMatch[1]),
      partKey: partMatch[2],
      partFile: partMatch[3],
      partSize: Number(partMatch[4]),
    };
  } catch (err) {
    emit('canary.plex_resolve_error', { error: err.message });
    return null;
  }
}

async function runPlexSection(expectedSize) {
  if (!args.withPlex) {
    emit('canary.skip', { section: 'plex', reason: '--no-plex' });
    return;
  }
  if (!PLEX_TOKEN) {
    emit('canary.skip', { section: 'plex', reason: 'PLEX_TOKEN not set' });
    return;
  }
  const resolved = await resolveFleabagPartId();
  if (!resolved || typeof resolved !== 'object') {
    emit('canary.skip', { section: 'plex', reason: 'part not found' });
    return;
  }
  emit('canary.plex_part', {
    part_id: resolved.partId, part_key: resolved.partKey, part_size: resolved.partSize,
    expected_size: expectedSize, size_matches: resolved.partSize === expectedSize,
  });
  const partSize = resolved.partSize;
  const ranges = [
    { label: 'plex.start',     start: 0,             length: 1024 * 1024 },
    { label: 'plex.middle',    start: Math.floor(partSize / 2), length: 256 * 1024 },
    { label: 'plex.tail',      start: partSize - 1024 * 1024, length: 1024 * 1024 },
  ];
  for (const r of ranges) {
    const end = Math.min(partSize - 1, r.start + r.length - 1);
    const expected = end - r.start + 1;
    const url = `${PLEX_URL}${resolved.partKey}?X-Plex-Token=${PLEX_TOKEN}`;
    try {
      const { response, elapsedMs } = await timedFetch(url, { headers: { range: `bytes=${r.start}-${end}` } });
      const observed = Number(response.headers.get('content-length') || 0);
      const buf = Buffer.from(await response.arrayBuffer());
      const cr = response.headers.get('content-range');
      const ok = response.status === 206 && observed === expected && buf.length === expected
        && cr === `bytes ${r.start}-${end}/${partSize}`;
      okOr(r.label, ok, {
        request: `bytes=${r.start}-${end}`, status: response.status, content_range: cr,
        expected, actual: buf.length, elapsed_ms: elapsedMs,
      });
    } catch (err) {
      emit('canary.assert_fail', { label: r.label, error: err.message });
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  emit('canary.start', {
    webdav_base: WEBDAV_BASE, plex_url: PLEX_URL, with_plex: args.withPlex,
    with_fuse: args.withFuse, concurrency: CONCURRENCY,
  });

  // 1. Read authoritative size from VFS TV row.
  let size = null;
  try {
    const dbPath = process.env.DISCOVERY_DB || '/home/patrick/hashsucker-data/discovery/discovery-cache.db';
    const out = spawnSync('sqlite3', [dbPath,
      `SELECT size FROM vfs_tv_entries WHERE media_id='${FLEABAG_MEDIA_ID}' AND season=${FLEABAG_SEASON} AND episode=${FLEABAG_EPISODE};`,
    ], { encoding: 'utf8' });
    if (out.status === 0) {
      const parsed = Number(out.stdout.trim());
      if (Number.isSafeInteger(parsed) && parsed > 0) size = parsed;
    }
  } catch { /* ignore */ }
  if (size == null) {
    emit('canary.abort', { reason: 'could not read authoritative size from VFS row' });
    process.exit(2);
  }
  emit('canary.size', { size });

  // 2. WebDAV start/middle/tail/416
  await runWebDavSection(size);

  // 3. FUSE
  await runFuseSection(size);

  // 4. Plex
  await runPlexSection(size);

  // 5. Concurrency batch
  await runConcurrencySection(size);

  // Summary
  const fails = events.filter((e) => e.event === 'canary.assert_fail').length;
  const oks = events.filter((e) => e.event === 'canary.assert_ok').length;
  emit('canary.summary', { ok: oks, fail: fails, total_events: events.length });
  if (fails > 0) {
    console.error(`\nCANARY FAILED: ${fails} assertion(s) failed`);
    process.exit(1);
  }
  // We do NOT print binary content; only structured events.
}

main().catch((err) => {
  console.error('[canary] unexpected error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});
