/**
 * Real-Debrid history/list acquisition.
 *
 * Fetches the authenticated Real-Debrid `/torrents` endpoint incrementally,
 * extracts the SHA1 infoHash (RD calls it `hash`) from each entry along
 * with its `added` jsonDate timestamp, and writes an immutable NDJSON
 * snapshot of `{ infoHash, observedAt }` rows to disk.
 *
 * HARD CONTRACT
 * =============
 *  - No discovery-cache SQLite is touched. This module produces snapshot
 *    files only.
 *  - No infoHash is invented. Entries without a valid 40-char SHA1 hex
 *    `hash` are rejected and counted.
 *  - No secrets are persisted. The RD API key is consumed transiently.
 *  - Filenames, unrestricted URLs, link URLs, torrent ids, and any other
 *    identifying-but-not-canonical field are dropped. Only `hash` and
 *    `added` are emitted.
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
 * DEDUP
 * =====
 * For unknown-cardinality inputs (the motivating case: a real RD account
 * with 100k+ torrents), we do NOT keep an in-memory Set. We use a
 * two-pass bounded chunk sort/merge:
 *   pass 1: stream pages into a series of small chunk files
 *           (CHUNK_ROWS lines each), each independently sorted
 *           by infoHash. Spill to disk on every full chunk.
 *   pass 2: k-way merge of sorted chunks, emitting one deduped NDJSON
 *           stream to the final snapshot path.
 *
 * The merged output is sorted (deterministic, content-addressable).
 *
 * For small inputs (page count * page size below the chunk threshold),
 * we skip the spill and dedup in-memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HASH_RE = /^[a-fA-F0-9]{40}$/;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_CHUNK_ROWS = 200_000;

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
 * snapshot of `{ infoHash, observedAt }` rows to disk.
 *
 * @param {RdAcquisitionConfig} config
 * @returns {Promise<{
 *   rowsSeen: number,
 *   rowsAccepted: number,
 *   rowsRejected: number,
 *   pagesFetched: number,
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

  // Streaming write: each line is one observation
  //   { infoHash, observedAt } — observedAt is epoch ms (we normalize from
  //   RD's jsonDate to epoch ms at parse time so the importer's
  //   observedAt semantics are unified).
  const ws = fs.createWriteStream(partialPath, { encoding: 'utf8' });

  const stats = {
    rowsSeen: 0,
    rowsAccepted: 0,
    rowsRejected: 0,
    pagesFetched: 0,
  };

  // In-memory dedup state (only used when chunkRows === 0)
  const memSeen = new Map(); // infoHash -> observedAtMs (earliest)

  try {
    // First, ask for offset=0, limit=pageSize to learn X-Total-Count.
    const firstPage = await fetchPage({
      apiBase, fetchFn, apiKey: config.apiKey, offset: 0, limit: pageSize,
      timeoutMs, maxRetries, retryBaseMs, log,
    });
    stats.pagesFetched += 1;
    const total = firstPage.total;
    log(`[acquire-rd] total=${total} pageSize=${pageSize}`);

    // Spill state
    let chunkBuf = []; // 2D array of [infoHash, observedAtMs]
    let chunkIdx = 0;
    async function flushChunk() {
      if (chunkBuf.length === 0) return null;
      chunkBuf.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const chunkPath = path.join(tmpDir, `chunk-${String(chunkIdx).padStart(6, '0')}.ndjson`);
      const cws = fs.createWriteStream(chunkPath, { encoding: 'utf8' });
      for (const [hash, observedAtMs] of chunkBuf) {
        cws.write(`${JSON.stringify({ infoHash: hash, observedAt: observedAtMs })}\n`);
      }
      await new Promise((resolve, reject) => {
        cws.end((err) => err ? reject(err) : resolve());
      });
      chunkIdx += 1;
      const drained = chunkBuf.length;
      chunkBuf = [];
      return { chunkPath, rows: drained };
    }

    async function handleEntry(entry) {
      stats.rowsSeen += 1;
      const out = normalizeEntry(entry);
      if (!out) {
        stats.rowsRejected += 1;
        return;
      }
      // rowsAccepted = unique valid hashes retained. Duplicates within
      // a single acquisition are silently merged.
      if (chunkRows > 0) {
        chunkBuf.push([out.infoHash, out.observedAtMs]);
        if (chunkBuf.length >= chunkRows) {
          await flushChunk();
        }
        // rowsAccepted for external-sort runs is finalized at merge
        // time (we cannot use an in-memory Set for large inputs).
        // Until then we count rows with a valid hash.
        stats.rowsAccepted += 1;
      } else {
        const prev = memSeen.get(out.infoHash);
        if (prev == null) {
          memSeen.set(out.infoHash, out.observedAtMs);
          stats.rowsAccepted += 1;
        } else if (out.observedAtMs < prev) {
          memSeen.set(out.infoHash, out.observedAtMs);
        }
      }
    }

    // Process first page
    for (const entry of firstPage.entries) {
      await handleEntry(entry);
    }

    // Subsequent pages
    if (total > pageSize) {
      for (let offset = pageSize; offset < total; offset += pageSize) {
        const page = await fetchPage({
          apiBase, fetchFn, apiKey: config.apiKey, offset, limit: pageSize,
          timeoutMs, maxRetries, retryBaseMs, log,
        });
        stats.pagesFetched += 1;
        for (const entry of page.entries) {
          await handleEntry(entry);
        }
      }
    }

    // Drain any in-memory chunk
    const lastChunk = await flushChunk();

    if (chunkRows > 0) {
      // External sort: k-way merge spilled chunks into a new file, then
      // atomically replace partial.
      await new Promise((resolve, reject) => {
        ws.end((err) => err ? reject(err) : resolve());
      });
      if (chunkIdx > 0 || (lastChunk && lastChunk.rows > 0)) {
        const chunkFiles = collectChunkFiles(tmpDir, chunkIdx);
        log(`[acquire-rd] merging ${chunkFiles.length} chunks`);
        const mergedPath = `${partialPath}.merged`;
        const mws = fs.createWriteStream(mergedPath, { encoding: 'utf8' });
        let mergedEmitted = 0;
        try {
          mergedEmitted = await kWayMerge(chunkFiles, mws, stats, log);
        } finally {
          await new Promise((resolve, reject) => {
            mws.end((err) => err ? reject(err) : resolve());
          });
        }
        fs.renameSync(mergedPath, partialPath);
        // rowsAccepted for the external-sort path is the post-merge
        // unique count, not the pre-merge "valid rows" tally.
        stats.rowsAccepted = mergedEmitted;
      }
    } else {
      // In-memory dedup path: write sorted, deduped rows to partialPath.
      await new Promise((resolve, reject) => {
        ws.end((err) => err ? reject(err) : resolve());
      });
      const sortedHashes = [...memSeen.keys()].sort();
      const finalWs = fs.createWriteStream(partialPath, { encoding: 'utf8' });
      for (const h of sortedHashes) {
        finalWs.write(`${JSON.stringify({ infoHash: h, observedAt: memSeen.get(h) })}\n`);
      }
      await new Promise((resolve, reject) => {
        finalWs.end((err) => err ? reject(err) : resolve());
      });
    }

    // Atomic rename to final outputPath
    fs.renameSync(partialPath, outputPath);

    // Compute output SHA-256
    const sha256 = await sha256File(outputPath);

    // Build manifest
    const manifest = {
      provider: 'realdebrid',
      sourceId: 'torrents',
      sourceVersion: `acquired-${new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
      acquiredAt: new Date(now()).toISOString(),
      source: `${apiBase}/torrents`,
      rowsSeen: stats.rowsSeen,
      rowsAccepted: stats.rowsAccepted,
      rowsRejected: stats.rowsRejected,
      pagesFetched: stats.pagesFetched,
      outputSha256: sha256,
      parserVersion: 'rd-history-acquirer-v1',
    };
    const manifestPath = `${outputPath}.manifest.json`;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    return {
      rowsSeen: stats.rowsSeen,
      rowsAccepted: stats.rowsAccepted,
      rowsRejected: stats.rowsRejected,
      pagesFetched: stats.pagesFetched,
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

/**
 * Normalize one /torrents entry to { infoHash, observedAtMs } or null.
 * Returns null when the entry is missing a deterministic SHA1 infoHash
 * or an unparseable timestamp.
 */
export function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawHash = entry.hash;
  if (typeof rawHash !== 'string') return null;
  const hash = rawHash.trim().toLowerCase();
  if (!HASH_RE.test(hash)) return null;
  const observedAtMs = parseJsonDateMs(entry.added);
  if (observedAtMs == null) return null;
  return { infoHash: hash, observedAtMs };
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

function collectChunkFiles(tmpDir, chunkIdx) {
  const out = [];
  for (let i = 0; i < chunkIdx; i += 1) {
    out.push(path.join(tmpDir, `chunk-${String(i).padStart(6, '0')}.ndjson`));
  }
  return out;
}

/**
 * k-way merge of pre-sorted chunk files. Each line is JSON
 * `{ infoHash, observedAt }`. We merge on infoHash (lex order),
 * dropping duplicates while keeping the earliest observedAtMs.
 *
 * Chunk files are bounded (chunkRows * ~70 bytes ≈ 14 MB at 200k rows).
 * For typical use (a handful of chunks) we can read each one fully into
 * memory and split on newlines. This keeps the merge logic simple,
 * synchronous, and bounded by `chunkRows`.
 */
async function kWayMerge(chunkFiles, out, stats, log) {
  const chunks = chunkFiles.map((p) => {
    const text = fs.readFileSync(p, 'utf8');
    // Sort already enforced at spill time; do not re-sort here to avoid
    // re-allocating. The split produces an array of non-empty JSON
    // lines.
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  });

  const cursors = chunks.map((lines) => (lines.length > 0 ? safeJson(lines.shift()) : null));

  let emitted = 0;
  while (true) {
    // Find the minimum infoHash across cursors
    let minIdx = -1;
    for (let i = 0; i < cursors.length; i += 1) {
      const c = cursors[i];
      if (!c) continue;
      if (minIdx === -1 || c.infoHash < cursors[minIdx].infoHash) {
        minIdx = i;
      }
    }
    if (minIdx === -1) break;
    // Coalesce all equal infoHash: keep earliest observedAt
    let winner = cursors[minIdx];
    // Advance every cursor whose row contributed to this dedup group.
    for (let i = 0; i < cursors.length; i += 1) {
      const c = cursors[i];
      if (!c) continue;
      if (c.infoHash !== winner.infoHash) continue;
      if (c.observedAt < winner.observedAt) winner = c;
      cursors[i] = chunks[i].length > 0 ? safeJson(chunks[i].shift()) : null;
    }

    out.write(`${JSON.stringify({ infoHash: winner.infoHash, observedAt: winner.observedAt })}\n`);
    emitted += 1;
    if (emitted % 100000 === 0) {
      log(`[acquire-rd] merged ${emitted} rows`);
    }
  }
  return emitted;
}

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(absPath);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}
