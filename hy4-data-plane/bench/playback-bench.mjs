// playback-bench — P9 proof harness for the Rust data plane.
//
// Drives a deterministic sequential chunk-read workload against
//   GET /files/:tfId   (Range: bytes=START-END)
// measures per-chunk time-to-first-byte (TTFB), and captures the data plane's
// /metrics snapshot before and after so provider-acquire / CDN / prefetch
// counters can be diffed. Run it twice — once against a prefetch-OFF data plane
// and once against a prefetch-ON data plane — and diff the two summaries.
//
// Runtime-only, no persistence, no provider discovery. It only exercises the
// public data-plane Range surface the same way Plex/Kodi/movie-web would.
//
//   DP_URL=http://127.0.0.1:3009 TFID=tt1825683 NCHUNKS=16 OUT=off.json \
//     node playback-bench.mjs
//
// Key fields in the printed JSON:
//   per_chunk_ttfb_ms[i]  : TTFB of the i-th sequential 8 MiB chunk read
//   metrics_before/after  : raw /metrics (for diffing in a spreadsheet)
//   deltas                : derived diff of the most decision-relevant counters

import http from 'node:http';
import fs from 'node:fs';

const DP = process.env.DP_URL || 'http://127.0.0.1:3009';
const TFID = process.env.TFID || 'tt1825683';
const CHUNK = parseInt(process.env.CHUNK_SIZE || '8388608', 10); // 8 MiB
const NCHUNKS = parseInt(process.env.NCHUNKS || '16', 10);
const OUT = process.env.OUT; // optional path to write JSON

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`${DP}${path}`, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`parse ${path}: ${e.message}\n${body.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

function getSize() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${DP}/files/${TFID}`,
      { method: 'GET', headers: { Range: 'bytes=0-0' } },
      (res) => {
        const cr = res.headers['content-range']; // bytes 0-0/SIZE
        res.resume();
        res.on('end', () => {
          if (!cr) return reject(new Error('no content-range (is the tfId valid?)'));
          const m = cr.match(/bytes \d+-\d+\/(\d+)/);
          if (!m) return reject(new Error(`bad content-range: ${cr}`));
          resolve(Number(m[1]));
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function rangeRead(start, end) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request(
      `${DP}/files/${TFID}`,
      { method: 'GET', headers: { Range: `bytes=${start}-${end}` } },
      (res) => {
        let firstByteAt = null;
        let bytes = 0;
        res.on('data', (d) => {
          if (firstByteAt === null) firstByteAt = Date.now() - t0;
          bytes += d.length;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            ttfbMs: firstByteAt == null ? -1 : firstByteAt,
            bytes,
          })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('socket', (s) => s.on('error', reject));
    req.end();
  });
}

// Drill into the nested /metrics JSON by dotted path.
function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
const DELTA_PATHS = [
  'requests',
  'bytes_streamed',
  'layer_A_api.requests',
  'layer_A_api.redirect_true_used',
  'layer_C_cdn.requests',
  'layer_C_cdn.206',
  'capability.acquisitions',
  'capability.reuses',
  'capability.reacquisitions',
  'recovery.attempts',
  'cache.bytes_upstream_issued',
  'cache.bytes_fetched_upstream',
  'cache.chunk_overfetch_bytes',
  'cache.inflight_joins',
  'cache.coalescer_entries',
  'cache.chunks_present',
  'cache.chunks_inflight',
  'playback_intelligence.prefetch_triggered',
  'playback_intelligence.prefetch_chunks_requested',
  'playback_intelligence.prefetch_chunks_completed',
  'playback_intelligence.prefetch_chunks_skipped_present',
  'playback_intelligence.prefetch_joined_inflight',
  'playback_intelligence.prefetch_failures',
  'playback_intelligence.seek_reprioritizations',
];

async function main() {
  let size;
  try {
    size = await getSize();
  } catch (e) {
    console.error(`[playback-bench] cannot learn file size: ${e.message}`);
    process.exit(2);
  }
  const metricsBefore = await getJSON('/metrics');

  const perChunk = [];
  let non206 = 0;
  for (let i = 0; i < NCHUNKS; i++) {
    const start = i * CHUNK;
    if (start >= size) break;
    const end = Math.min(start + CHUNK, size) - 1;
    const r = await rangeRead(start, end);
    if (r.status !== 206) non206++;
    perChunk.push({ i, start, end, status: r.status, ttfbMs: r.ttfbMs, bytes: r.bytes });
    if (i % 4 === 0 || i === NCHUNKS - 1) {
      process.stderr.write(`  chunk ${i}: ${r.status} ttfb=${r.ttfbMs}ms bytes=${r.bytes}\n`);
    }
  }

  const metricsAfter = await getJSON('/metrics');

  const deltas = {};
  for (const p of DELTA_PATHS) {
    const a = Number(dig(metricsBefore, p) ?? 0);
    const b = Number(dig(metricsAfter, p) ?? 0);
    deltas[p] = b - a;
  }

  const ttfb = perChunk.map((c) => c.ttfbMs);
  const summary = {
    tf_id: TFID,
    file_size: size,
    chunks_read: perChunk.length,
    non_206: non206,
    per_chunk_ttfb_ms: ttfb,
    avg_ttfb_ms: ttfb.length ? Math.round((ttfb.reduce((a, b) => a + b, 0) / ttfb.length) * 10) / 10 : 0,
    // After warmup (skip first 2 chunks) — the region where prefetch should win.
    post_warmup_ttfb_ms: (() => {
      const w = ttfb.slice(2);
      return w.length ? Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10 : 0;
    })(),
    deltas,
    metrics_before: metricsBefore,
    metrics_after: metricsAfter,
  };

  const out = JSON.stringify(summary, null, 2);
  if (OUT) {
    fs.writeFileSync(OUT, out);
    console.error(`[playback-bench] wrote ${OUT}`);
  } else {
    console.log(out);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
