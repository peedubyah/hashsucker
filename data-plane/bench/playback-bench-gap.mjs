// playback-bench-gap — P10 value-proof harness (gapped sequential playback).
//
// Like playback-bench.mjs but models REAL playback cadence: it sleeps GAP_MS
// between sequential 8 MiB Range reads so the data plane has idle gaps in which
// Wait-style prefetch can run ahead. It also supports a WARM_CONCURRENT burst
// before the sequential loop: 2+ concurrent reads force the real CapabilityManager
// to grow its pool to 2 capabilities (its existing concurrent-read-pressure rule),
// giving the manager a genuinely idle lane so Auto-mode will select Wait.
//
// Proves, on the REAL capability manager + REAL provider:
//   * Condition A (GAP_MS=0, saturated):            auto -> Try, no-op, no regression
//   * Condition B (GAP_MS>0, after warm pool):      auto -> Wait, prefetch serves demand
//     (prefetch_served_demand > 0, later-demand TTFB near-instant)
//
//   DP_URL=http://127.0.0.1:3013 TFID=tf_8596... \
//     PREFETCH_ENABLED=1 PREFETCH_MODE=auto GAP_MS=1500 WARM_CONCURRENT=2 \
//     NCHUNKS=12 OUT=gap.json node playback-bench-gap.mjs
//
// New P10 delta fields captured:
//   playback_intelligence.prefetch_served_demand
//   playback_intelligence.prefetch_joined_by_demand
//   playback_intelligence.spare_capacity
//   playback_intelligence.auto_selected_wait
//   playback_intelligence.auto_selected_try

import http from 'node:http';
import fs from 'node:fs';

const DP = process.env.DP_URL || 'http://127.0.0.1:3009';
const TFID = process.env.TFID || 'tt1825683';
const CHUNK = parseInt(process.env.CHUNK_SIZE || '8388608', 10); // 8 MiB
const NCHUNKS = parseInt(process.env.NCHUNKS || '16', 10);
const OUT = process.env.OUT;
const GAP = parseInt(process.env.GAP_MS || '0', 10); // idle gap between reads
const WARM = parseInt(process.env.WARM_CONCURRENT || '0', 10); // concurrent warmup burst
const OUTPI = process.env.OUT_PI; // optional path to dump the playback_intelligence block

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
        const cr = res.headers['content-range'];
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
const DELTA_PATHS = [
  'requests',
  'bytes_streamed',
  'layer_A_api.requests',
  'layer_C_cdn.requests',
  'layer_C_cdn.206',
  'capability.acquisitions',
  'capability.reuses',
  'recovery.attempts',
  'cache.bytes_upstream_issued',
  'cache.inflight_joins',
  'cache.coalescer_entries',
  'cache.chunks_present',
  'playback_intelligence.prefetch_triggered',
  'playback_intelligence.prefetch_chunks_requested',
  'playback_intelligence.prefetch_chunks_completed',
  'playback_intelligence.prefetch_chunks_skipped_present',
  'playback_intelligence.prefetch_joined_inflight',
  'playback_intelligence.prefetch_failures',
  'playback_intelligence.seek_reprioritizations',
  'playback_intelligence.prefetch_served_demand',
  'playback_intelligence.prefetch_joined_by_demand',
  'playback_intelligence.spare_capacity',
  'playback_intelligence.auto_selected_wait',
  'playback_intelligence.auto_selected_try',
];

async function main() {
  let size;
  try {
    size = await getSize();
  } catch (e) {
    console.error(`[gap-bench] cannot learn file size: ${e.message}`);
    process.exit(2);
  }
  const metricsBefore = await getJSON('/metrics');

  // Optional warm-up burst: force the real capability manager's pool to grow to
  // >=2 caps (concurrent-read-pressure rule) so an idle lane exists for Auto->Wait.
  if (WARM > 0) {
    process.stderr.write(`[gap-bench] warm-up: ${WARM} concurrent reads to grow pool\n`);
    const reads = [];
    for (let i = 0; i < WARM; i++) {
      const start = i * CHUNK;
      const end = Math.min(start + CHUNK, size) - 1;
      reads.push(rangeRead(start, end));
    }
    await Promise.all(reads);
    // small settle so the 2nd cap is established before the sequential loop
    await sleep(500);
  }

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
    if (GAP > 0 && i < NCHUNKS - 1) {
      await sleep(GAP);
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
    gap_ms: GAP,
    warm_concurrent: WARM,
    chunks_read: perChunk.length,
    non_206: non206,
    per_chunk_ttfb_ms: ttfb,
    avg_ttfb_ms: ttfb.length
      ? Math.round((ttfb.reduce((a, b) => a + b, 0) / ttfb.length) * 10) / 10
      : 0,
    // post-warmup region: where prefetch should have been serving demand.
    post_warmup_ttfb_ms: (() => {
      const w = ttfb.slice(3);
      return w.length ? Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10 : 0;
    })(),
    prefetch_served_demand: deltas['playback_intelligence.prefetch_served_demand'] || 0,
    prefetch_joined_by_demand: deltas['playback_intelligence.prefetch_joined_by_demand'] || 0,
    auto_selected_wait: deltas['playback_intelligence.auto_selected_wait'] || 0,
    auto_selected_try: deltas['playback_intelligence.auto_selected_try'] || 0,
    spare_capacity: deltas['playback_intelligence.spare_capacity'] || 0,
    deltas,
    playback_intelligence: dig(metricsAfter, 'playback_intelligence'),
  };

  const out = JSON.stringify(summary, null, 2);
  if (OUT) {
    fs.writeFileSync(OUT, out);
    console.error(`[gap-bench] wrote ${OUT}`);
  } else {
    console.log(out);
  }
  if (OUTPI) {
    fs.writeFileSync(OUTPI, JSON.stringify(dig(metricsAfter, 'playback_intelligence'), null, 2));
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
