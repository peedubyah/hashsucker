/**
 * Byte prewarm (anticipatory tranche).
 *
 * Warms exactly the grid chunks containing Plex's observed ingest ranges:
 * head [0, HEAD_BYTES) + tail [size-TAIL_BYTES, size). Measured Phase-1
 * behavior: head request 0-128MiB + tail probes (64KB-4MB at EOF).
 * Bounded concurrency, overall timeout, best-effort: prewarm failure
 * never fails publication (on-demand serve remains the fallback).
 * No Rust changes: plain data-plane Range GETs fill grid cache.
 */
export const PREWARM_HEAD_BYTES = 128 * 1024 * 1024;
export const PREWARM_TAIL_BYTES = 8 * 1024 * 1024;
export const PREWARM_CONCURRENCY = 4;
export const PREWARM_CHUNK = 8 * 1024 * 1024;
export const PREWARM_TIMEOUT_MS = 120_000;

function rangesFor(size) {
  const ranges = [];
  if (!(Number.isSafeInteger(size) && size > 0)) return ranges;
  const headEnd = Math.min(PREWARM_HEAD_BYTES, size);
  for (let start = 0; start < headEnd; start += PREWARM_CHUNK) {
    ranges.push([start, Math.min(start + PREWARM_CHUNK, size) - 1]);
  }
  const tailStart = Math.max(0, size - PREWARM_TAIL_BYTES);
  // Avoid re-adding a tail chunk fully inside the head range.
  if (tailStart >= headEnd) {
    for (let start = tailStart; start < size; start += PREWARM_CHUNK) {
      ranges.push([start, Math.min(start + PREWARM_CHUNK, size) - 1]);
    }
  }
  return ranges;
}

async function pool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: String(err?.message || err).slice(0, 120) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Prewarm grid cache for a TorrentFile via data-plane Range GETs.
 * Returns { warmed, failed, bytes, ms }. Drains bodies (cache fill
 * happens server-side on fetch, but draining guarantees delivery).
 */
export async function prewarmRanges({
  dataPlaneBaseUrl, torrentFileId, size, fetchFn = fetch,
  concurrency = PREWARM_CONCURRENCY, timeoutMs = PREWARM_TIMEOUT_MS,
  signal = null,
} = {}) {
  const t0 = Date.now();
  if (!dataPlaneBaseUrl || !torrentFileId) throw new Error('dataPlaneBaseUrl and torrentFileId required');
  const ranges = rangesFor(size);
  if (ranges.length === 0) return { warmed: 0, failed: 0, bytes: 0, ms: 0, ranges: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  const base = String(dataPlaneBaseUrl).replace(/\/+$/, '');
  const one = async ([start, end]) => {
    const res = await fetchFn(`${base}/files/${encodeURIComponent(torrentFileId)}`, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: ctl.signal,
    });
    if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
    let bytes = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    return bytes;
  };
  try {
    const results = await pool(ranges, concurrency, one);
    let warmed = 0, failed = 0, bytes = 0;
    for (const r of results) {
      if (r.ok) { warmed++; bytes += r.value; } else failed++;
    }
    return { warmed, failed, bytes, ms: Date.now() - t0, ranges: ranges.length };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Byte-readiness probe: a tiny head read through the full serve path
 * (capability + provider + grid). True = bytes demonstrably serve now.
 */
export async function probeByteReady({ dataPlaneBaseUrl, torrentFileId, fetchFn = fetch, timeoutMs = 30_000 } = {}) {
  const base = String(dataPlaneBaseUrl).replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${base}/files/${encodeURIComponent(torrentFileId)}`, {
      headers: { Range: 'bytes=0-65535' },
      signal: ctl.signal,
    });
    if (res.status !== 206 && res.status !== 200) return false;
    const reader = res.body.getReader();
    const { done, value } = await reader.read();
    try { await reader.cancel(); } catch {}
    return !done && (value?.length ?? 0) > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function __rangesForTests(size) {
  return rangesFor(size);
}
