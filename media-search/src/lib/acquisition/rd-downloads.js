/**
 * Real-Debrid /downloads history acquisition.
 *
 * Fetches the authenticated Real-Debrid `/downloads` endpoint incrementally,
 * normalizes each entry to a RAW OBSERVATION record (no infoHash, no
 * canonical Release identity), and writes an immutable NDJSON snapshot
 * to disk.
 *
 * HARD CONTRACT
 * =============
 *  - /downloads is NOT canonical Release evidence. It has no infoHash
 *    and no deterministic bridge to /torrents. We persist it as raw
 *    download-event observation, not as historical_provider_evidence.
 *  - No discovery-cache SQLite is touched. This module produces snapshot
 *    files only.
 *  - No secrets are persisted. The RD API key is consumed transiently.
 *  - Fields we DO NOT persist (transient / forensic-noise / auth):
 *      link            (transient one-shot download URL)
 *      download        (transient CDN URL with one-shot token)
 *      host_icon       (cosmetic)
 *      chunks          (transport-only)
 *  - Fields we DO persist (durable, useful source facts):
 *      id              (stable RD download id, primary identity)
 *      filename        (raw)
 *      normalized_filename (lowercased + deduped whitespace)
 *      filesize        (exact bytes)
 *      mimeType        (categorization only)
 *      streamable      (int 0/1)
 *      generated       (RD-generated timestamp, ISO 8601)
 *      first_seen_at   (acquisition observation wallclock)
 *      last_seen_at    (acquisition observation wallclock)
 *  - Per-row parsed/enriched attributes (from parser-adapter when
 *    present) are emitted as a `parsed` object on each row.
 *  - Determinism: re-acquiring unchanged source content produces a
 *    byte-identical normalized snapshot. A genuinely new source event
 *    (new RD download id) produces a new row.
 *  - Bounded memory: peak RSS scales with `chunkRows` (the spill size)
 *    and `mergeFanIn` (the merge cursor buffer), NOT with total input.
 *    Reuses the streaming k-way merge from rd-history.js.
 *  - Idempotency: re-reading the same /downloads row produces ONE
 *    raw observation, keyed on the stable RD download id. Two distinct
 *    RD ids with the same filename+filesize produce TWO distinct
 *    raw observations (the 52 Oppenheimer rows are NOT collapsed).
 *  - Auth: only through env, --api-key-file, or --api-key. The token
 *    is never printed, never written to the snapshot, never written
 *    to the manifest.
 *
 * Usage:
 *   import { acquireRdDownloads, normalizeDownloadEntry } from
 *     '../lib/acquisition/rd-downloads.js';
 *
 *   await acquireRdDownloads({
 *     apiKey: process.env.REALDEBRID_API_KEY,
 *     outputPath: '/path/to/rd-downloads-2026-09-03.ndjson',
 *     pageSize: 5000,
 *     chunkRows: 200000,
 *   });
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { parseFilename } from '../discovery/parser-adapter.js';

// ============================================================================
// Constants
// ============================================================================

const PROVIDER = 'realdebrid';
const SOURCE_ID = 'downloads';
const RD_API_BASE_DEFAULT = 'https://api.real-debrid.com/rest/1.0';
const DEFAULT_PAGE_SIZE = 5000;
const DEFAULT_CHUNK_ROWS = 200_000;
const DEFAULT_MERGE_FAN_IN = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;

// ============================================================================
// Normalization
// ============================================================================

/**
 * Normalize a /downloads entry into a raw observation.
 *
 * Returns null when the entry lacks the required durable fields. The
 * downstream importer (cache.js ingest) is responsible for rejecting
 * rows that fail its own PK validation; this function is the source-
 * level gate.
 *
 * @param {object} entry
 * @param {number} [nowMs=Date.now()]
 * @returns {object|null} normalized row
 */
export function normalizeDownloadEntry(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  // id is the stable source event identity. RD download ids are
  // documented as stable for the lifetime of the download record.
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (id.length === 0) return null;
  const filename = typeof entry.filename === 'string' ? entry.filename : '';
  if (filename.length === 0) return null;
  const filesize = Number(entry.filesize);
  if (!Number.isFinite(filesize) || filesize < 0) return null;
  const generatedMs = parseJsonDateMs(entry.generated);
  // `generated` is required (RD stamps every download). Without it we
  // cannot order events, and we cannot compute last_seen correctly.
  if (generatedMs == null) return null;

  const normalizedFilename = normalizeFilename(filename);
  const mimeType = typeof entry.mimeType === 'string' ? entry.mimeType : null;
  const streamable = entry.streamable === 1 || entry.streamable === true ? 1 : 0;

  // Parse the filename into structured attributes (optional evidence).
  // Failure is non-fatal: parser may be unable to extract anything
  // (e.g. ad-hoc archive names, non-release content). We emit
  // { parser_confidence: 0, parsed_title: null, ... } in that case so
  // correlation can skip it explicitly.
  let parsed = null;
  let parserConfidence = 0;
  try {
    const p = parseFilename(filename);
    if (p && p.parsed) {
      parsed = p.parsed;
      parserConfidence = typeof p.confidence === 'number' ? p.confidence : 0;
    }
  } catch {
    // Defensive: parseFilename should never throw, but we do not
    // let a parser failure kill a single /downloads row.
    parsed = null;
    parserConfidence = 0;
  }

  return {
    provider: PROVIDER,
    source_id: SOURCE_ID,
    source_event_id: id,
    rd_id: id,
    filename,
    normalized_filename: normalizedFilename,
    exact_bytes: filesize,
    mime_type: mimeType,
    streamable,
    generated_at: generatedMs,
    first_seen_at: nowMs,
    last_seen_at: nowMs,
    parsed_title: parsed && typeof parsed.title === 'string' ? parsed.title : null,
    parsed_year: parsed && typeof parsed.year === 'number' ? parsed.year : null,
    season: parsed && typeof parsed.season === 'number' ? parsed.season : null,
    episode: parsed && typeof parsed.episode === 'number' ? parsed.episode : null,
    resolution: parsed && typeof parsed.resolution === 'string' ? parsed.resolution : null,
    source_type: parsed && typeof parsed.source === 'string' ? parsed.source : null,
    codec: parsed && typeof parsed.codec === 'string' ? parsed.codec : null,
    release_group: parsed && typeof parsed.releaseGroup === 'string' ? parsed.releaseGroup : null,
    parser_confidence: parserConfidence,
  };
}

/**
 * Lowercase + collapse whitespace runs to single space. Strips
 * surrounding whitespace. Does NOT strip file extensions or
 * release-group separators — the correlation layer uses
 * normalized_filename for fast equality, but the raw `filename`
 * field is preserved for evidence.
 */
export function normalizeFilename(s) {
  if (typeof s !== 'string') return '';
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseJsonDateMs(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (s.startsWith('/Date(')) {
    const m = /^\/Date\((-?\d+)\)\/$/.exec(s);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// ============================================================================
// Fetch with retry
// ============================================================================

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage({
  apiBase,
  fetchFn,
  apiKey,
  offset,
  limit,
  timeoutMs,
  maxRetries,
  retryBaseMs,
  log,
}) {
  const url = new URL(`${apiBase}/downloads`);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'media-search-rd-acquirer/1.0',
        },
        signal: ac.signal,
      });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : retryBaseMs * Math.pow(2, attempt);
        log(`[acquire-rd-downloads] transient HTTP ${res.status} at offset=${offset}; retry in ${waitMs}ms`);
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`HTTP ${res.status} at offset=${offset}: ${text.slice(0, 200)}`);
      }
      const totalHeader = res.headers.get('x-total-count');
      const total = totalHeader != null ? Number(totalHeader) : null;
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Malformed JSON from RD /downloads at offset=${offset}`);
      }
      if (!Array.isArray(payload)) {
        throw new Error(`Expected JSON array from RD /downloads at offset=${offset}, got ${typeof payload}`);
      }
      return { entries: payload, total };
    } catch (err) {
      clearTimeout(t);
      if (err && err.name === 'AbortError') {
        lastErr = new Error(`timeout after ${timeoutMs}ms at offset=${offset}`);
      } else if (err && /HTTP \d{3}/.test(err.message || '')) {
        throw err; // terminal 4xx
      } else {
        lastErr = err;
      }
      if (attempt < maxRetries) {
        const waitMs = retryBaseMs * Math.pow(2, attempt);
        log(`[acquire-rd-downloads] ${lastErr && lastErr.message} at offset=${offset}; retry in ${waitMs}ms`);
        await sleep(waitMs);
      }
    }
  }
  throw lastErr || new Error(`failed to fetch /downloads at offset=${offset}`);
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

// ============================================================================
// External-sort k-way merge (reused pattern from rd-history.js)
//
// Identical contract: O(mergeFanIn) cursors, sorted on sourceEventId.
// See rd-history.js for the detailed memory / determinism commentary.
// ============================================================================

class MinHeap {
  constructor(cmp) { this.arr = []; this.cmp = cmp; }
  push(x) { this.arr.push(x); this._siftUp(this.arr.length - 1); }
  pop() {
    if (this.arr.length === 0) return undefined;
    const top = this.arr[0];
    const last = this.arr.pop();
    if (this.arr.length > 0) {
      this.arr[0] = last;
      this._siftDown(0);
    }
    return top;
  }
  size() { return this.arr.length; }
  _siftUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cmp(this.arr[i], this.arr[parent]) < 0) {
        [this.arr[i], this.arr[parent]] = [this.arr[parent], this.arr[i]];
        i = parent;
      } else break;
    }
  }
  _siftDown(i) {
    const n = this.arr.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < n && this.cmp(this.arr[l], this.arr[best]) < 0) best = l;
      if (r < n && this.cmp(this.arr[r], this.arr[best]) < 0) best = r;
      if (best === i) break;
      [this.arr[i], this.arr[best]] = [this.arr[best], this.arr[i]];
      i = best;
    }
  }
}

async function* openChunkLines(p) {
  const s = fs.createReadStream(p, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: s, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    yield JSON.parse(line);
  }
}

async function mergeBatch(batchFiles, out, _log) {
  const iters = batchFiles.map((p) => openChunkLines(p));
  const cursors = [];
  for (let i = 0; i < iters.length; i += 1) {
    const it = iters[i][Symbol.asyncIterator]();
    const first = await it.next();
    if (first.done) continue;
    cursors.push({ idx: i, it, row: first.value });
  }
  const heap = new MinHeap((a, b) => {
    if (a.row.source_event_id < b.row.source_event_id) return -1;
    if (a.row.source_event_id > b.row.source_event_id) return 1;
    if (a.idx < b.idx) return -1;
    if (a.idx > b.idx) return 1;
    return 0;
  });
  for (const c of cursors) heap.push(c);

  let prevEventId = null;
  let rowsEmitted = 0;
  while (heap.size() > 0) {
    const top = heap.pop();
    if (top.row.source_event_id !== prevEventId) {
      out.write(`${JSON.stringify(top.row)}\n`);
      rowsEmitted += 1;
      prevEventId = top.row.source_event_id;
    }
    const next = await top.it.next();
    if (next.done) continue;
    top.row = next.value;
    heap.push(top);
  }
  return { rowsEmitted };
}

async function streamingKWayMerge({ chunkFiles, out, mergeFanIn, log }) {
  let inputs = [...chunkFiles];
  let totalRowsEmitted = 0;
  let totalPasses = 0;
  while (inputs.length > 1) {
    totalPasses += 1;
    const nextInputs = [];
    for (let i = 0; i < inputs.length; i += mergeFanIn) {
      const batch = inputs.slice(i, i + mergeFanIn);
      if (batch.length === 1) {
        nextInputs.push(batch[0]);
        continue;
      }
      const outPath = batch[0].replace(/\.ndjson$/, `.m${totalPasses}.${i}.ndjson`);
      const ws = fs.createWriteStream(outPath, { encoding: 'utf8' });
      let emitted = 0;
      try {
        const r = await mergeBatch(batch, ws, log);
        emitted = r.rowsEmitted;
      } finally {
        await new Promise((resolve, reject) => {
          ws.end((err) => err ? reject(err) : resolve());
        });
      }
      // Remove the consumed chunk files (they are no longer needed)
      for (const p of batch) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
      nextInputs.push(outPath);
      totalRowsEmitted = emitted; // last merge's count is canonical
    }
    inputs = nextInputs;
  }
  if (inputs.length === 1) {
    const finalPath = inputs[0];
    // Count lines BEFORE we unlink
    totalRowsEmitted = await countLinesInFile(finalPath);
    const inStream = fs.createReadStream(finalPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: inStream, crlfDelay: Infinity });
    for await (const raw of rl) {
      if (raw.length === 0) continue;
      out.write(`${raw}\n`);
    }
    rl.close();
    inStream.destroy();
    try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
  }
  return { rowsEmitted: totalRowsEmitted, passes: Math.max(totalPasses, 1) };
}

async function countLinesInFile(p) {
  let n = 0;
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(p, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: s, crlfDelay: Infinity });
    rl.on('line', () => { n += 1; });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  return n;
}

function collectChunkFiles(tmpDir, chunkCount) {
  const out = [];
  for (let i = 0; i < chunkCount; i += 1) {
    out.push(path.join(tmpDir, `chunk-${String(i).padStart(6, '0')}.ndjson`));
  }
  return out;
}

async function sha256File(p) {
  const h = createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(p, { encoding: 'utf8' });
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return h.digest('hex');
}

// ============================================================================
// Main acquirer
// ============================================================================

/**
 * @typedef {Object} AcquireRdDownloadsConfig
 * @property {string} apiKey                   Real-Debrid API token (transient)
 * @property {string} outputPath               NDJSON output path
 * @property {string} [apiBase]                RD API base URL
 * @property {Function} [fetchFn]               fetch implementation (for tests)
 * @property {number} [pageSize=5000]          RD pagination size
 * @property {number} [chunkRows=200000]       Spill threshold; 0 = in-memory
 * @property {number} [mergeFanIn=64]          k-way merge fan-in
 * @property {number} [timeoutMs=30000]        Per-request timeout
 * @property {number} [maxRetries=3]           Per-request retry budget
 * @property {number} [retryBaseMs=500]        Backoff base
 * @property {Function} [now]                  now() override (for tests)
 * @property {Function} [log]                  Log function
 * @property {string} [tmpDir]                 Tmp dir for spill chunks
 * @property {boolean} [skipOffsetZero]        Skip offset=0 (handles the
 *                                              RD /downloads offset=0 bug
 *                                              that returns 204)
 */

/**
 * @typedef {Object} AcquireRdDownloadsResult
 * @property {number} rowsSeen
 * @property {number} rowsAccepted
 * @property {number} rowsRejected
 * @property {number} pagesFetched
 * @property {number} chunkCount
 * @property {number} mergePasses
 * @property {string} outputPath
 * @property {object} manifest
 */

/**
 * Acquire the full /downloads history to an immutable NDJSON snapshot.
 *
 * @param {AcquireRdDownloadsConfig} config
 * @returns {Promise<AcquireRdDownloadsResult>}
 */
export async function acquireRdDownloads(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('config is required');
  }
  if (!config.apiKey || typeof config.apiKey !== 'string') {
    throw new TypeError('config.apiKey is required');
  }
  if (!config.outputPath || typeof config.outputPath !== 'string') {
    throw new TypeError('config.outputPath is required');
  }
  const apiBase = config.apiBase || RD_API_BASE_DEFAULT;
  const fetchFn = config.fetchFn || fetch;
  const pageSize = Math.min(
    Math.max(1, config.pageSize ?? DEFAULT_PAGE_SIZE),
    5000
  );
  const chunkRows = config.chunkRows ?? DEFAULT_CHUNK_ROWS;
  const mergeFanIn = Math.max(2, config.mergeFanIn ?? DEFAULT_MERGE_FAN_IN);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const now = config.now ?? (() => Date.now());
  const log = config.log || (() => {});
  const tmpDir = config.tmpDir
    || `${config.outputPath}.tmp-${process.pid}-${now()}`;
  // RD /downloads is known to return HTTP 204 for offset=0 (unlike
  // /torrents, the total is reachable via X-Total-Count on the
  // unparameterized GET). We default to skipping offset=0 and start
  // pagination at offset=1.
  const skipOffsetZero = config.skipOffsetZero !== false;

  const outputPath = path.resolve(config.outputPath);
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const partialPath = `${outputPath}.partial`;

  const ws = fs.createWriteStream(partialPath, { encoding: 'utf8' });

  const stats = {
    rowsSeen: 0,
    rowsAccepted: 0,
    rowsRejected: 0,
    pagesFetched: 0,
    chunkCount: 0,
    mergePasses: 0,
  };

  // In-memory dedup state (chunkRows === 0 only)
  const memSeen = new Map(); // source_event_id -> row

  let chunkBuf = []; // [source_event_id, row]

  async function flushChunk() {
    if (chunkBuf.length === 0) return null;
    chunkBuf.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const chunkPath = path.join(
      tmpDir, `chunk-${String(stats.chunkCount).padStart(6, '0')}.ndjson`
    );
    const cws = fs.createWriteStream(chunkPath, { encoding: 'utf8' });
    let prevKey = null;
    let emitted = 0;
    for (const [eventId, row] of chunkBuf) {
      if (eventId === prevKey) continue;
      prevKey = eventId;
      cws.write(`${JSON.stringify(row)}\n`);
      emitted += 1;
    }
    await new Promise((resolve, reject) => {
      cws.end((err) => err ? reject(err) : resolve());
    });
    stats.chunkCount += 1;
    chunkBuf = [];
    return { chunkPath, rows: emitted };
  }

  function handleEntry(entry) {
    stats.rowsSeen += 1;
    const out = normalizeDownloadEntry(entry, now());
    if (!out) {
      stats.rowsRejected += 1;
      return;
    }
    if (chunkRows > 0) {
      chunkBuf.push([out.source_event_id, out]);
    } else {
      const prev = memSeen.get(out.source_event_id);
      if (prev == null) {
        memSeen.set(out.source_event_id, out);
        stats.rowsAccepted += 1;
      } else {
        // Re-sighting of the same RD download id: keep the first
        // observation. first_seen_at is sticky, last_seen_at
        // refreshes. (This is rare; RD does not typically re-emit
        // the same id at different generated timestamps.)
        prev.last_seen_at = Math.max(prev.last_seen_at, out.last_seen_at);
      }
    }
  }

  try {
    // First page: RD's /downloads is known to return HTTP 204 for
    // offset=0. We start at offset=1 when skipOffsetZero is true.
    // The first page establishes the iteration range.
    let nextOffset = skipOffsetZero ? 1 : 0;
    let total = null;
    let seen = 0;
    let done = false;

    while (!done) {
      const page = await fetchPage({
        apiBase, fetchFn, apiKey: config.apiKey,
        offset: nextOffset,
        limit: pageSize,
        timeoutMs, maxRetries, retryBaseMs, log,
      });
      stats.pagesFetched += 1;
      if (total == null) {
        total = page.total;
        log(`[acquire-rd-downloads] total=${total} pageSize=${pageSize}`);
      }
      const entries = page.entries || [];
      for (const entry of entries) {
        handleEntry(entry);
      }
      seen += entries.length;
      if (chunkRows > 0 && chunkBuf.length >= chunkRows) await flushChunk();
      // Termination conditions:
      //  1. The page returned fewer entries than requested (end of data).
      //  2. The page was empty.
      //  3. Pre-emptive: the next offset would exhaust the dataset.
      //     Compute the "data offset" (offset-1 when skipOffsetZero is
      //     true, else offset) and the next data offset; if the next
      //     one would be at or past the total, we're done. This
      //     avoids an empty trailing fetch.
      if (entries.length === 0) {
        done = true;
        break;
      }
      if (entries.length < pageSize) {
        done = true;
        break;
      }
      if (total != null) {
        const dataOffset = skipOffsetZero ? nextOffset - 1 : nextOffset;
        const nextDataOffset = dataOffset + entries.length;
        if (nextDataOffset >= total) {
          done = true;
          break;
        }
      }
      nextOffset += pageSize;
    }

    await flushChunk();

    if (chunkRows > 0) {
      await new Promise((resolve, reject) => {
        ws.end((err) => err ? reject(err) : resolve());
      });
      if (stats.chunkCount > 0) {
        const chunkFiles = collectChunkFiles(tmpDir, stats.chunkCount);
        log(`[acquire-rd-downloads] merging ${chunkFiles.length} chunks (fan-in ${mergeFanIn})`);
        const mergedPath = `${partialPath}.merged`;
        const mws = fs.createWriteStream(mergedPath, { encoding: 'utf8' });
        let mergedEmitted = 0;
        try {
          const r = await streamingKWayMerge({
            chunkFiles,
            out: mws,
            mergeFanIn,
            log,
          });
          mergedEmitted = r.rowsEmitted;
          stats.mergePasses = r.passes;
        } finally {
          await new Promise((resolve, reject) => {
            mws.end((err) => err ? reject(err) : resolve());
          });
        }
        fs.renameSync(mergedPath, partialPath);
        stats.rowsAccepted = mergedEmitted;
      }
    } else {
      await new Promise((resolve, reject) => {
        ws.end((err) => err ? reject(err) : resolve());
      });
      const sorted = [...memSeen.values()]
        .sort((a, b) => (
          a.source_event_id < b.source_event_id ? -1
            : a.source_event_id > b.source_event_id ? 1
            : 0
        ));
      const finalWs = fs.createWriteStream(partialPath, { encoding: 'utf8' });
      for (const r of sorted) {
        finalWs.write(`${JSON.stringify(r)}\n`);
      }
      await new Promise((resolve, reject) => {
        finalWs.end((err) => err ? reject(err) : resolve());
      });
      stats.rowsAccepted = sorted.length;
    }

    // Compute content-derived sourceVersion
    const contentKey = await sha256File(partialPath);
    fs.writeFileSync(`${outputPath}.contentkey`, `${contentKey}\n`, 'utf8');
    fs.renameSync(partialPath, outputPath);

    const sha256 = await sha256File(outputPath);
    // Clean up the .contentkey now that the canonical snapshot exists
    try { fs.unlinkSync(`${outputPath}.contentkey`); } catch { /* ignore */ }

    const manifest = {
      provider: PROVIDER,
      sourceId: SOURCE_ID,
      sourceVersion: contentKey,
      rowsSeen: stats.rowsSeen,
      rowsAccepted: stats.rowsAccepted,
      rowsRejected: stats.rowsRejected,
      pagesFetched: stats.pagesFetched,
      chunkCount: stats.chunkCount,
      mergePasses: stats.mergePasses,
      outputPath: outputPath,
      outputSha256: sha256,
      acquiredAt: now(),
      schemaVersion: 1,
      notes: [
        'RD /downloads is NOT canonical Release evidence.',
        'No infoHash, no deterministic bridge to /torrents.',
        'Persisted as raw observation only. Not written to historical_provider_evidence.',
      ],
    };
    fs.writeFileSync(
      `${outputPath}.manifest.json`,
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    // Best-effort tmp cleanup
    try {
      const remaining = fs.readdirSync(tmpDir);
      for (const f of remaining) {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
      }
      fs.rmdirSync(tmpDir);
    } catch { /* ignore */ }

    return { ...stats, outputPath, manifest };
  } catch (err) {
    // Best-effort cleanup on error
    try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
    try {
      if (fs.existsSync(tmpDir)) {
        const remaining = fs.readdirSync(tmpDir);
        for (const f of remaining) {
          try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
        }
        fs.rmdirSync(tmpDir);
      }
    } catch { /* ignore */ }
    throw err;
  }
}
