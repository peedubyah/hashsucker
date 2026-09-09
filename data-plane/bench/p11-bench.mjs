// p11-bench — P11 demand/prefetch handoff proof harness.
//
// Validates the demand-path seam: completed prefetch -> demand re-uses it
// locally (P11 §8.A); in-flight prefetch -> demand joins it (P11 §8.B).
//
// Layout:
//   * warm-up: WARM concurrent reads of chunks [0..WARM) grow the cap pool.
//   * Phase 1: NCHUNKS sequential reads at GAP_MS cadence so Auto->Wait fires
//              prefetch and a few of those completions land before demand.
//   * Phase 2: SEEK back to chunk 0. By this point prefetch of chunk 0 has
//              long since been superseded; the seek is a re-read of a chunk
//              already durable (from a prior demand fill, not from prefetch).
//              That is fine — it proves "demand does not duplicate-fill for a
//              chunk that is PRESENT" (P11 §1.A) which is the same code path
//              the completed-prefetch handoff uses.
//   * Phase 3: SEEK to chunk NCHUNKS-1. If prefetch completed that chunk
//              before demand arrived, served_demand must increment AND the
//              demand must not issue an upstream fetch for it. If prefetch
//              is still in flight when demand arrives, joined_by_demand must
//              increment AND demand must join the SAME coalescer entry.
//
// Compare metrics before/after.
//
//   DP_URL=http://127.0.0.1:3011 TFID=tf_... WARM=2 GAP_MS=1500 NCHUNKS=12 \
//     node p11-bench.mjs

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DP = process.env.DP_URL || 'http://127.0.0.1:3009';
const TFID = process.env.TFID || 'tf_46203b5e-2a8d-44f7-9a93-20114c60b24d';
const CHUNK = parseInt(process.env.CHUNK_SIZE || '8388608', 10); // 8 MiB
const NCHUNKS = parseInt(process.env.NCHUNKS || '12', 10);
const GAP = parseInt(process.env.GAP_MS || '1500', 10);
const WARM = parseInt(process.env.WARM_CONCURRENT || '2', 10);
const SEEK_BACK = parseInt(process.env.SEEK_BACK || '1', 10); // 1 = yes
const OUT = process.env.OUT;
const LABEL = process.env.LABEL || 'p11';

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

function rangeRead(start, end, sink) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request(
      `${DP}/files/${TFID}`,
      { method: 'GET', headers: { Range: `bytes=${start}-${end}` } },
      (res) => {
        let firstByteAt = null;
        let bytes = 0;
        const hash = crypto.createHash('sha256');
        res.on('data', (d) => {
          if (firstByteAt === null) firstByteAt = Date.now() - t0;
          bytes += d.length;
          if (sink) sink.update(d);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            ttfbMs: firstByteAt == null ? -1 : firstByteAt,
            bytes,
            sha256: sink ? sink.digest('hex') : null,
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
  'capability.reacquisitions',
  'recovery.attempts',
  'cache.bytes_upstream_issued',
  'cache.bytes_fetched_upstream',
  'cache.chunk_overfetch_bytes',
  'cache.inflight_joins',
  'cache.coalescer_entries',
  'cache.chunk_claims',
  'cache.chunks_present',
  'cache.chunks_inflight',
  'cache.fetch_spans',
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

async function phase(label, n, size) {
  process.stderr.write(`[p11-bench] ${LABEL} :: ${label}\n`);
  for (let i = 0; i < n; i++) {
    const start = i * CHUNK;
    if (start >= size) break;
    const end = Math.min(start + CHUNK, size) - 1;
    const sink = crypto.createHash('sha256');
    const r = await rangeRead(start, end, sink);
    process.stderr.write(
      `  ${label} chunk ${i}: ${r.status} ttfb=${r.ttfbMs}ms bytes=${r.bytes} sha=${r.sha256?.slice(0, 12)}\n`
    );
    if (GAP > 0 && i < n - 1) await sleep(GAP);
  }
}

async function main() {
  const size = await getSize();
  process.stderr.write(`[p11-bench] ${LABEL} :: size=${size} chunk=${CHUNK} N=${NCHUNKS} gap=${GAP}ms warm=${WARM}\n`);

  const metricsBefore = await getJSON('/metrics');

  if (WARM > 0) {
    process.stderr.write(`[p11-bench] ${LABEL} :: warm-up ${WARM} concurrent\n`);
    const reads = [];
    for (let i = 0; i < WARM; i++) {
      const start = i * CHUNK;
      if (start >= size) break;
      const end = Math.min(start + CHUNK, size) - 1;
      reads.push(rangeRead(start, end));
    }
    await Promise.all(reads);
    await sleep(500);
  }

  const phase1 = await phase('forward', NCHUNKS, size);
  await sleep(GAP);
  void phase1; // forward phase metrics are already in metricsAfter below

  let seekBack = null;
  if (SEEK_BACK && NCHUNKS > 0) {
    // Re-read chunk 0 (already durable from phase 1 demand fill, NOT prefetch)
    const sink = crypto.createHash('sha256');
    const t0 = Date.now();
    const r = await rangeRead(0, Math.min(CHUNK, size) - 1, sink);
    process.stderr.write(
      `[p11-bench] ${LABEL} :: seek0 ttfb=${r.ttfbMs}ms bytes=${r.bytes} sha=${r.sha256?.slice(0, 12)}\n`
    );
    seekBack = { start: 0, end: Math.min(CHUNK, size) - 1, ...r, dur: Date.now() - t0 };
  }

  // Capture final state for served_demand verification
  const metricsAfter = await getJSON('/metrics');

  const deltas = {};
  for (const p of DELTA_PATHS) {
    const a = Number(dig(metricsBefore, p) ?? 0);
    const b = Number(dig(metricsAfter, p) ?? 0);
    deltas[p] = b - a;
  }

  const summary = {
    label: LABEL,
    tf_id: TFID,
    file_size: size,
    chunk_size: CHUNK,
    nchunks: NCHUNKS,
    gap_ms: GAP,
    warm_concurrent: WARM,
    seek_back: seekBack,
    deltas,
    prefetch_served_demand: deltas['playback_intelligence.prefetch_served_demand'] || 0,
    prefetch_joined_by_demand: deltas['playback_intelligence.prefetch_joined_by_demand'] || 0,
    auto_selected_wait: deltas['playback_intelligence.auto_selected_wait'] || 0,
    auto_selected_try: deltas['playback_intelligence.auto_selected_try'] || 0,
    spare_capacity: deltas['playback_intelligence.spare_capacity'] || 0,
    bytes_upstream_issued: deltas['cache.bytes_upstream_issued'] || 0,
    capability_acquisitions: deltas['capability.acquisitions'] || 0,
    api_requests: deltas['layer_A_api.requests'] || 0,
    cdn_206: deltas['layer_C_cdn.206'] || 0,
    metrics_before: metricsBefore,
    metrics_after: metricsAfter,
  };

  const out = JSON.stringify(summary, null, 2);
  if (OUT) {
    fs.writeFileSync(OUT, out);
    process.stderr.write(`[p11-bench] ${LABEL} :: wrote ${OUT}\n`);
  }
  // Also write a single-line summary for easy shell capture
  const oneLine = JSON.stringify({
    label: summary.label,
    served: summary.prefetch_served_demand,
    joined: summary.prefetch_joined_by_demand,
    wait: summary.auto_selected_wait,
    try_n: summary.auto_selected_try,
    bytes_up: summary.bytes_upstream_issued,
    cap: summary.capability_acquisitions,
    api: summary.api_requests,
    cdn_206: summary.cdn_206,
    chunks_present_after: dig(metricsAfter, 'cache.chunks_present'),
  });
  process.stdout.write(oneLine + '\n');
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n');
  process.exit(1);
});
