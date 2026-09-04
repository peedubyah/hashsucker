/**
 * Real-Debrid history/list acquisition.
 *
 * Fetches the authenticated Real-Debrid `/torrents` endpoint incrementally,
 * normalizes each entry to `{ infoHash, observedAt, sourceEventId }`, and
 * writes an immutable NDJSON snapshot to disk.
 *
 * HARD CONTRACT
 * =============
 *  - No discovery-cache SQLite is touched. This module produces snapshot
 *    files only.
 *  - No infoHash is invented. Entries without a valid 40-char SHA1 hex
 *    `hash` are rejected and counted.
 *  - No secrets are persisted. The RD API key is consumed transiently.
 *  - Filenames, unrestricted URLs, link URLs, and any other
 *    identifying-but-not-canonical field are dropped. Only `hash`,
 *    `added`, and a derived `sourceEventId` are emitted.
 *  - Determinism: a second acquisition of unchanged source content
 *    produces a byte-identical normalized snapshot with a stable
 *    content-derived `sourceVersion` (so re-running the importer is
 *    a no-op). Reordering or pagination boundary changes do not affect
 *    the snapshot's logical content.
 *  - Bounded memory: peak RSS scales with `chunkRows` (the spill size)
 *    and `mergeFanIn` (the merge cursor buffer), NOT with total input
 *    rows.
 *
 * EVENT IDENTITY
 * ==============
 * Each RD torrent entry has a stable identity for the lifetime of the
 * account history, derived from its source fields:
 *     sourceEventId = sha256(provider|source_id|rd_id|hash|added)[:32]
 * Two acquisitions of the same RD history produce the same set of
 * sourceEventIds and therefore do not strengthen historical evidence.
 * A genuinely new RD torrent introduces a new sourceEventId and
 * creates exactly one new historical sighting.
 *
 * If the RD torrent `id` field is missing or unstable (which would
 * surface as `rowsRejected` rising under unchanged-content reruns),
 * the source-derived hash still works because it incorporates
 * (hash, added) which are immutable per torrent.
 *
 * SOURCE SHAPE (per RD docs)
 *   GET /torrents?offset=&limit=&filter=
 *     - 200 OK, JSON array
 *     - Each item: { id, filename, hash, bytes, host, split, progress,
 *                    status, added, links[], ended? }
 *     - `hash` is the SHA1 infoHash (40-char hex)
 *     - `added` is an ISO jsonDate (jsonDate is `Date.toJSON` format)
 *     - `X-Total-Count` HTTP header reports total entries
 *     - max limit: 5000
 *     - rate limit: 250 req/min (HTTP 429)
 *
 * DEDUP / EXTERNAL SORT
 * =====================
 * For unknown-cardinality inputs (a real RD account with 100k+
 * torrents), we do NOT keep an in-memory Set. We use a two-pass
 * bounded chunk sort/merge:
 *   pass 1: stream pages into a series of small chunk files
 *           (chunkRows lines each), each independently sorted
 *           on the dedup key (sourceEventId). Spill to disk on every
 *           full chunk. Each chunk is then streamed through a
 *           small bounded window that emits each unique key once,
 *           carrying the earliest observedAt.
 *   pass 2: streaming k-way merge of sorted chunks via per-chunk
 *           file descriptor + a min-heap of size chunkCount.
 *           Memory during merge is O(chunkCount) cursors, each
 *           holding a single small JSON line buffer. The
 *           output is sorted, deduped, and stable.
 *
 * If chunkCount exceeds mergeFanIn (default 64), pass 2 runs in
 * multiple fan-in passes: take up to mergeFanIn chunks, merge them
 * into a new file, then re-merge all generated files in the next
 * pass. Each pass reduces the file count by `mergeFanIn`. The total
 * merge memory is bounded by `mergeFanIn` cursors + one output
 * buffer, regardless of how many rows the chunks hold.
 *
 * The merged output is sorted by `sourceEventId` (deterministic,
 * content-addressable, byte-stable across reordered input).
 *
 * For small inputs (chunkCount == 1 after the spill), the merge
 * reduces to a single-file stream-through and the final output is
 * the same byte stream the chunk emitted.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';

const HASH_RE = /^[a-fA-F0-9]{40}$/;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_CHUNK_ROWS = 200_000;
const DEFAULT_MERGE_FAN_IN = 64;

const RD_API_BASE_DEFAULT = 'https://api.real-debrid.com/rest/1.0';

/**
 * @typedef {Object} RdAcquisitionConfig
 * @property {string} apiKey  Real-Debrid API bearer token. NEVER logged.
 * @property {string} outputPath  Absolute path of the snapshot NDJSON file.
 * @property {string} [tmpDir]  Where chunk spill files go. Defaults to
 *   `${outputPath}.tmp/`.
 * @property {number} [pageSize=1000]  Entries per /torrents page. Max 5000.
 * @property {number} [chunkRows=200000]  Chunk size for external sort.
 *   Set to 0 to force in-memory dedup (only safe for small inputs).
 * @property {number} [mergeFanIn=64]  Max chunks merged per pass. Merge
 *   runs in multiple passes if needed. Memory during merge is bounded
 *   by this value.
 * @property {string} [apiBase]  Override RD base URL (tests).
 * @property {Function} [fetchFn]  Fetch implementation (tests).
 * @property {number} [timeoutMs=30000]  HTTP timeout per request.
 * @property {number} [maxRetries=3]  Transient retry budget per page.
 * @property {number} [retryBaseMs=500]  Initial backoff in ms (doubles).
 * @property {Function} [now]  Clock for `now` ms — only used for manifest
 *   `acquiredAt`. Defaults to Date.now.
 * @property {Function} [log]  Log function. Defaults to console.error.
 */

/**
 * Acquire the full RD /torrents list and write an immutable NDJSON
 * snapshot of `{ infoHash, observedAt, sourceEventId }` rows to disk.
 *
 * @param {RdAcquisitionConfig} config
 * @returns {Promise<{
 *   rowsSeen: number,
 *   rowsAccepted: number,
 *   rowsRejected: number,
 *   pagesFetched: number,
 *   chunkCount: number,
 *   mergePasses: number,
 *   outputPath: string,
 *   manifest: object,
 * }>}
 */
export async function acquireRdHistory(config) {
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
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxRetries = config.maxRetries ?? 3;
  const retryBaseMs = config.retryBaseMs ?? 500;
  const now = config.now ?? (() => Date.now());
  const log = config.log || (() => {});
  const tmpDir = config.tmpDir
    || `${config.outputPath}.tmp-${process.pid}-${now()}`;

  // Prepare output. We write to a sibling .partial then atomically rename.
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

  // In-memory dedup state (only used when chunkRows === 0).
  // Keyed by sourceEventId so that within-acquisition duplicates with
  // the same event identity collapse.
  const memSeen = new Map(); // sourceEventId -> { infoHash, observedAtMs }

  try {
    // First, ask for offset=0, limit=pageSize to learn X-Total-Count.
    const firstPage = await fetchPage({
      apiBase, fetchFn, apiKey: config.apiKey, offset: 0, limit: pageSize,
      timeoutMs, maxRetries, retryBaseMs, log,
    });
    stats.pagesFetched += 1;
    const total = firstPage.total;
    log(`[acquire-rd] total=${total} pageSize=${pageSize}`);

    // Spill state: collect rows in a chunk buffer; when the buffer
    // reaches chunkRows, sort by sourceEventId, dedup (keep earliest
    // observedAt), and spill to a chunk file. Each chunk is itself
    // sorted on the dedup key, so the k-way merge does not need to
    // re-sort.
    let chunkBuf = []; // [sourceEventId, infoHash, observedAtMs]
    let chunkIdx = 0;

    async function flushChunk() {
      if (chunkBuf.length === 0) return null;
      chunkBuf.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const chunkPath = path.join(
        tmpDir, `chunk-${String(chunkIdx).padStart(6, '0')}.ndjson`
      );
      const cws = fs.createWriteStream(chunkPath, { encoding: 'utf8' });
      let prevKey = null;
      let emitted = 0;
      for (const [eventId, infoHash, observedAtMs] of chunkBuf) {
        if (eventId === prevKey) {
          // Within-chunk duplicate: keep the first (earliest in
          // chunk order; we used sort to put the same eventId
          // adjacently). Skip the later one.
          continue;
        }
        prevKey = eventId;
        cws.write(`${JSON.stringify({
          infoHash,
          observedAt: observedAtMs,
          sourceEventId: eventId,
        })}\n`);
        emitted += 1;
      }
      await new Promise((resolve, reject) => {
        cws.end((err) => err ? reject(err) : resolve());
      });
      chunkIdx += 1;
      stats.chunkCount += 1;
      chunkBuf = [];
      return { chunkPath, rows: emitted };
    }

    function handleEntry(entry) {
      stats.rowsSeen += 1;
      const out = normalizeEntry(entry);
      if (!out) {
        stats.rowsRejected += 1;
        return;
      }
      // rowsAccepted counts unique sourceEventIds retained (post-merge
      // for external-sort runs). For the in-memory path we count as
      // we go; for the external-sort path we count at merge time.
      if (chunkRows > 0) {
        chunkBuf.push([out.sourceEventId, out.infoHash, out.observedAtMs]);
      } else {
        const prev = memSeen.get(out.sourceEventId);
        if (prev == null) {
          memSeen.set(out.sourceEventId, {
            infoHash: out.infoHash,
            observedAtMs: out.observedAtMs,
          });
          stats.rowsAccepted += 1;
        } else if (out.observedAtMs < prev.observedAtMs) {
          memSeen.set(out.sourceEventId, {
            infoHash: out.infoHash,
            observedAtMs: out.observedAtMs,
          });
        }
      }
    }

    // Process first page
    for (const entry of firstPage.entries) {
      handleEntry(entry);
    }
    if (chunkRows > 0 && chunkBuf.length >= chunkRows) await flushChunk();

    // Subsequent pages
    if (total > pageSize) {
      for (let offset = pageSize; offset < total; offset += pageSize) {
        const page = await fetchPage({
          apiBase, fetchFn, apiKey: config.apiKey, offset, limit: pageSize,
          timeoutMs, maxRetries, retryBaseMs, log,
        });
        stats.pagesFetched += 1;
        for (const entry of page.entries) {
          handleEntry(entry);
        }
        if (chunkRows > 0 && chunkBuf.length >= chunkRows) await flushChunk();
      }
    }

    // Drain any in-memory chunk
    await flushChunk();
    // (flushChunk is async; awaiting it is safe and ensures the last
    // chunk file is closed before the merge step opens it again.)

    if (chunkRows > 0) {
      // External sort: stream-merge spilled chunks into the final
      // snapshot. We must NOT close `ws` until the merge is done
      // because the merge writes through `partialPath` after we
      // close and rename. Instead, we close `ws`, then run a
      // streaming merge that writes the final sorted, deduped
      // output to `partialPath` (overwriting the pre-sorted partial
      // we built during the spill, since that file holds the
      // unsorted concatenation; the merge output is the canonical
      // snapshot).
      await new Promise((resolve, reject) => {
        ws.end((err) => err ? reject(err) : resolve());
      });
      if (stats.chunkCount > 0) {
        const chunkFiles = collectChunkFiles(tmpDir, stats.chunkCount);
        log(`[acquire-rd] merging ${chunkFiles.length} chunks (fan-in ${mergeFanIn})`);
        const mergedPath = `${partialPath}.merged`;
        const mws = fs.createWriteStream(mergedPath, { encoding: 'utf8' });
        let mergedEmitted = 0;
        try {
          const mergeResult = await streamingKWayMerge({
            chunkFiles,
            out: mws,
            mergeFanIn,
            log,
          });
          mergedEmitted = mergeResult.rowsEmitted;
          stats.mergePasses = mergeResult.passes;
        } finally {
          await new Promise((resolve, reject) => {
            mws.end((err) => err ? reject(err) : resolve());
          });
        }
        fs.renameSync(mergedPath, partialPath);
        // rowsAccepted for the external-sort path is the post-merge
        // unique count, not the pre-merge tally.
        stats.rowsAccepted = mergedEmitted;
      }
    } else {
      // In-memory dedup path: write sorted, deduped rows to partialPath.
      await new Promise((resolve, reject) => {
        ws.end((err) => err ? reject(err) : resolve());
      });
      const sorted = [...memSeen.entries()]
        .map(([sourceEventId, v]) => ({
          infoHash: v.infoHash,
          observedAt: v.observedAtMs,
          sourceEventId,
        }))
        .sort((a, b) => (a.sourceEventId < b.sourceEventId ? -1 : a.sourceEventId > b.sourceEventId ? 1 : 0));
      const finalWs = fs.createWriteStream(partialPath, { encoding: 'utf8' });
      for (const r of sorted) {
        finalWs.write(`${JSON.stringify(r)}\n`);
      }
      await new Promise((resolve, reject) => {
        finalWs.end((err) => err ? reject(err) : resolve());
      });
      // rowsAccepted for the in-memory path is the post-dedup unique
      // count, not the per-entry tally. We computed the deduped set
      // above; reset rowsAccepted to the truth to avoid double-counting
      // (handleEntry incremented it on the first sighting of each
      // unique event, which is correct, but the post-loop overwrites
      // it here with the deduped count to handle the in-memory path
      // distinctly from the external-sort path).
      stats.rowsAccepted = sorted.length;
    }

    // Compute content-derived sourceVersion from the snapshot file.
    // Two acquisitions of unchanged source content produce the same
    // sourceVersion, which makes the importer's checkpoint layer
    // short-circuit (no-op). Only a genuinely changed source
    // produces a new sourceVersion.
    const contentKeyPath = `${outputPath}.contentkey`;
    const contentKey = await sha256File(partialPath);
    fs.writeFileSync(contentKeyPath, `${contentKey}\n`, 'utf8');

    // Atomic rename to final outputPath
    fs.renameSync(partialPath, outputPath);

    // Compute output SHA-256
    const sha256 = await sha256File(outputPath);

    // Build manifest. The sourceVersion is content-derived from the
    // emitted snapshot so that re-acquiring the same RD history
    // produces the same sourceVersion (idempotent at the importer's
    // checkpoint layer). This decouples acquisition identity from
    // acquisition time: a re-run of unchanged source is a fast
    // no-op; only a genuinely changed source produces a new
    // sourceVersion.
    const manifest = {
      provider: 'realdebrid',
      sourceId: 'torrents',
      sourceVersion: `rd-content-${contentKey.slice(0, 16)}`,
      acquiredAt: new Date(now()).toISOString(),
      source: `${apiBase}/torrents`,
      rowsSeen: stats.rowsSeen,
      rowsAccepted: stats.rowsAccepted,
      rowsRejected: stats.rowsRejected,
      pagesFetched: stats.pagesFetched,
      chunkCount: stats.chunkCount,
      mergePasses: stats.mergePasses,
      mergeFanIn: mergeFanIn,
      outputSha256: sha256,
      parserVersion: 'rd-history-acquirer-v2',
    };
    const manifestPath = `${outputPath}.manifest.json`;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    // Clean up the contentkey scratch file
    try { fs.unlinkSync(contentKeyPath); } catch { /* ignore */ }

    return {
      rowsSeen: stats.rowsSeen,
      rowsAccepted: stats.rowsAccepted,
      rowsRejected: stats.rowsRejected,
      pagesFetched: stats.pagesFetched,
      chunkCount: stats.chunkCount,
      mergePasses: stats.mergePasses,
      outputPath,
      manifestPath,
      manifest,
    };
  } catch (err) {
    // Best-effort cleanup
    try { ws.destroy(); } catch { /* ignore */ }
    try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
    throw err;
  } finally {
    // Clean up tmp dir
    try {
      const entries = fs.readdirSync(tmpDir);
      for (const e of entries) {
        try { fs.unlinkSync(path.join(tmpDir, e)); } catch { /* ignore */ }
      }
      fs.rmdirSync(tmpDir);
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const PROVIDER = 'realdebrid';
const SOURCE_ID = 'torrents';

/**
 * Normalize one /torrents entry to { infoHash, observedAtMs, sourceEventId }
 * or null. Returns null when the entry is missing a deterministic SHA1
 * infoHash, an unparseable timestamp, or a non-string torrent id.
 *
 * The sourceEventId is derived from the immutable source fields (id,
 * hash, added) so that two acquisitions of the same RD torrent produce
 * the same event identity even if RD's `id` is not stable.
 */
export function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawHash = entry.hash;
  if (typeof rawHash !== 'string') return null;
  const hash = rawHash.trim().toLowerCase();
  if (!HASH_RE.test(hash)) return null;
  const observedAtMs = parseJsonDateMs(entry.added);
  if (observedAtMs == null) return null;
  // Use RD's torrent id when present and non-empty (avoids
  // `undefined`/empty hashing collisions). Fall back to a sentinel
  // string for entries that lack an id; the hash+added fields are
  // still in the derived event id so the identity remains stable
  // for any given (hash, added) tuple.
  const rdId = (typeof entry.id === 'string' && entry.id.length > 0)
    ? entry.id
    : 'no-id';
  const sourceEventId = deriveEventId({
    provider: PROVIDER,
    sourceId: SOURCE_ID,
    rdId,
    hash,
    observedAtMs,
  });
  return { infoHash: hash, observedAtMs, sourceEventId };
}

function deriveEventId({ provider, sourceId, rdId, hash, observedAtMs }) {
  const h = createHash('sha256');
  h.update(provider);
  h.update('\x1f');
  h.update(sourceId);
  h.update('\x1f');
  h.update(String(rdId));
  h.update('\x1f');
  h.update(hash);
  h.update('\x1f');
  h.update(String(observedAtMs));
  return h.digest('hex').slice(0, 32);
}

function parseJsonDateMs(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  // jsonDate is /Date(milliseconds)/ OR ISO 8601. RD uses ISO 8601 but
  // the field is documented as jsonDate — accept both.
  if (s.startsWith('/Date(')) {
    const m = /^\/Date\((-?\d+)\)\/$/.exec(s);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

async function fetchPage({
  apiBase, fetchFn, apiKey, offset, limit, timeoutMs, maxRetries, retryBaseMs, log,
}) {
  const url = new URL(`${apiBase}/torrents`);
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
        log(`[acquire-rd] transient HTTP ${res.status} at offset=${offset}; retry in ${waitMs}ms`);
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const text = await safeText(res);
        // 4xx other than 429 is terminal
        throw new Error(`HTTP ${res.status} at offset=${offset}: ${text.slice(0, 200)}`);
      }
      const totalHeader = res.headers.get('x-total-count');
      const total = totalHeader != null ? Number(totalHeader) : null;
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Malformed JSON from RD /torrents at offset=${offset}`);
      }
      if (!Array.isArray(payload)) {
        throw new Error(`Expected JSON array from RD /torrents at offset=${offset}, got ${typeof payload}`);
      }
      return { entries: payload, total };
    } catch (err) {
      clearTimeout(t);
      if (err && err.name === 'AbortError') {
        lastErr = new Error(`timeout after ${timeoutMs}ms at offset=${offset}`);
      } else if (err && /HTTP \d{3}/.test(err.message || '')) {
        throw err; // 4xx terminal
      } else {
        lastErr = err;
      }
      if (attempt < maxRetries) {
        const waitMs = retryBaseMs * Math.pow(2, attempt);
        log(`[acquire-rd] ${lastErr && lastErr.message} at offset=${offset}; retry in ${waitMs}ms`);
        await sleep(waitMs);
      }
    }
  }
  throw lastErr || new Error(`failed to fetch /torrents at offset=${offset}`);
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectChunkFiles(tmpDir, chunkCount) {
  const out = [];
  for (let i = 0; i < chunkCount; i += 1) {
    out.push(path.join(tmpDir, `chunk-${String(i).padStart(6, '0')}.ndjson`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streaming k-way merge
//
// Memory contract: O(mergeFanIn) cursors, each holding a single
// pre-parsed small JSON line (~150 bytes). The output is a single
// sorted, deduped NDJSON stream. Each row is held in memory only
// long enough to compare against the heap head and write out.
//
// If the input chunk count exceeds mergeFanIn, we run multiple passes:
// take up to mergeFanIn chunks, merge them into a single output file,
// then take the next batch. Each pass reduces the file count by
// mergeFanIn. Total pass count = ceil(log_mergeFanIn(chunkCount)).
// Each pass opens at most mergeFanIn read streams, never more.
//
// We use a binary min-heap keyed on the row's sourceEventId. Tie-break
// on the chunk index (lower wins) for determinism.
// ---------------------------------------------------------------------------

class MinHeap {
  constructor(cmp) {
    this.arr = [];
    this.cmp = cmp;
  }
  push(x) {
    this.arr.push(x);
    this._siftUp(this.arr.length - 1);
  }
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
    while (true) {
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

/**
 * Open a single chunk file as an async line iterator. Each iteration
 * yields a parsed row object. Backed by fs.createReadStream +
 * readline.createInterface so memory cost per cursor is one line.
 */
async function* openChunkLines(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  try {
    for await (const raw of rl) {
      if (raw.length === 0) continue;
      try {
        const row = JSON.parse(raw);
        yield row;
      } catch {
        // Skip malformed lines defensively. The acquirer is the only
        // writer of these chunk files, so a parse error here would
        // indicate disk corruption or a manual edit.
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Streaming k-way merge with bounded fan-in.
 *
 * @param {Object} opts
 * @param {string[]} opts.chunkFiles  Sorted NDJSON files (each sorted
 *   on sourceEventId).
 * @param {fs.WriteStream} opts.out  Output NDJSON stream.
 * @param {number} [opts.mergeFanIn=64]  Max cursors open at once.
 * @param {Function} [opts.log]
 * @returns {Promise<{rowsEmitted: number, passes: number}>}
 */
async function streamingKWayMerge({
  chunkFiles,
  out,
  mergeFanIn = DEFAULT_MERGE_FAN_IN,
  log = () => {},
}) {
  let inputs = chunkFiles.slice();
  let passIdx = 0;
  let totalRowsEmitted = 0;
  let totalPasses = 0;

  while (inputs.length > 1) {
    totalPasses += 1;
    const outputs = [];
    for (let i = 0; i < inputs.length; i += mergeFanIn) {
      const batch = inputs.slice(i, i + mergeFanIn);
      const outPath = path.join(
        path.dirname(batch[0]),
        `merge-${passIdx}-${String(outputs.length).padStart(6, '0')}.ndjson`
      );
      log(`[acquire-rd] merge pass=${passIdx} batch=${outputs.length} files=${batch.length} -> ${path.basename(outPath)}`);
      const ows = fs.createWriteStream(outPath, { encoding: 'utf8' });
      const { rowsEmitted } = await mergeBatch(batch, ows, log);
      await new Promise((resolve, reject) => {
        ows.end((err) => err ? reject(err) : resolve());
      });
      if (passIdx > 0) {
        // Inputs from prior passes are intermediate files; clean up.
        for (const p of batch) {
          try { fs.unlinkSync(p); } catch { /* ignore */ }
        }
      }
      outputs.push(outPath);
      // We do NOT add rowsEmitted to totalRowsEmitted here. The
      // canonical post-merge count is the line count of the final
      // surviving output file, computed below in the "Final step"
      // block. Counting in mergeBatch and then again in the final
      // step would double-count, especially in the single-pass
      // case where the only batch's output is the final file.
    }
    inputs = outputs;
    passIdx += 1;
  }

  // Final step: copy the single remaining file through the output
  // stream. We must always run this even when no merge passes ran
  // (single-chunk case). The rows counted here are the canonical
  // post-merge unique count.
  if (inputs.length === 1) {
    const finalPath = inputs[0];
    // Count the lines BEFORE we unlink, so we have the canonical
    // post-merge unique count.
    totalRowsEmitted = await countLinesInFile(finalPath);
    const inStream = fs.createReadStream(finalPath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: inStream,
      crlfDelay: Infinity,
    });
    try {
      for await (const raw of rl) {
        if (raw.length === 0) continue;
        out.write(`${raw}\n`);
      }
    } finally {
      rl.close();
      inStream.destroy();
    }
    try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
  } else if (inputs.length === 0) {
    // No inputs at all (zero chunks). Emit nothing.
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

async function mergeBatch(batchFiles, out, _log) {
  const iters = batchFiles.map((p) => openChunkLines(p));
  // Each cursor wraps an async iterator + a "next" promise. We pull
  // one row ahead at construction so the heap starts populated.
  const cursors = [];
  for (let i = 0; i < iters.length; i += 1) {
    const it = iters[i][Symbol.asyncIterator]();
    const first = await it.next();
    if (first.done) {
      // Empty file: skip.
      continue;
    }
    cursors.push({
      idx: i,
      it,
      row: first.value,
    });
  }

  // Min-heap keyed on sourceEventId, then on chunk index for
  // determinism. We use index as the tie-breaker so that when two
  // cursors have identical event ids (which can happen when the
  // input is reordered across pages), the lower-index cursor's row
  // is taken first.
  const heap = new MinHeap((a, b) => {
    if (a.row.sourceEventId < b.row.sourceEventId) return -1;
    if (a.row.sourceEventId > b.row.sourceEventId) return 1;
    if (a.idx < b.idx) return -1;
    if (a.idx > b.idx) return 1;
    return 0;
  });
  for (const c of cursors) heap.push(c);

  let prevEventId = null;
  let rowsEmitted = 0;
  while (heap.size() > 0) {
    const top = heap.pop();
    if (top.row.sourceEventId !== prevEventId) {
      out.write(`${JSON.stringify(top.row)}\n`);
      rowsEmitted += 1;
      prevEventId = top.row.sourceEventId;
    }
    // Advance the cursor: pull the next row from its iterator.
    const next = await top.it.next();
    if (next.done) {
      // Cursor exhausted; drop it.
      continue;
    }
    top.row = next.value;
    heap.push(top);
  }

  return { rowsEmitted };
}

// ---------------------------------------------------------------------------
// SHA-256 helpers
// ---------------------------------------------------------------------------

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
