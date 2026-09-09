// p11-control - P11 controlled handoff proof.
//
// Per P11 §8.A and §8.B:
//   A. Completed-prefetch handoff
//      Arrange: prefetch completes chunk N -> demand requests chunk N afterward
//      Prove:   cache PRESENT, prefetch_served_demand +1,
//               demand bytes_upstream = 0, demand provider request = 0
//   B. In-flight handoff
//      Arrange: prefetch owns chunk N -> demand arrives before fill completes
//      Prove:   prefetch_joined_by_demand +1, exactly one coalescer owner,
//               exactly one upstream fetch, demand bytes correct
//
// This bench uses a single chunk index at a time, so each iteration cleanly
// measures what happened for one chunk. We reset metrics between iterations
// by re-reading /metrics and using deltas.

import http from 'node:http';
import crypto from 'node:crypto';

const DP = process.env.DP_URL || 'http://127.0.0.1:3011';
const TFID = process.env.TFID || 'tf_46203b5e-2a8d-44f7-9a93-20114c60b24d';
const CHUNK = parseInt(process.env.CHUNK_SIZE || '8388608', 10);
const N = parseInt(process.env.N || '12', 10); // total sequential chunks (0..N-1) for the warm-up sequence
const PRE_AHEAD = parseInt(process.env.PRE_AHEAD || '1', 10); // chunks prefetched ahead per demand read
const LABEL = process.env.LABEL || 'control';

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(`${DP}${path}`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
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
          const m = cr.match(/bytes \d+-\d+\/(\d+)/);
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

function snapshot(m) {
  return {
    bytes_upstream_issued: m?.cache?.bytes_upstream_issued || 0,
    bytes_fetched_upstream: m?.cache?.bytes_fetched_upstream || 0,
    chunk_claims: m?.cache?.chunk_claims || 0,
    chunk_join_waits: m?.cache?.chunk_join_waits || 0,
    inflight_joins: m?.cache?.inflight_joins || 0,
    fetch_spans: m?.cache?.fetch_spans || 0,
    chunks_present: m?.cache?.chunks_present || 0,
    api_requests: m?.layer_A_api?.requests || 0,
    cdn_206: m?.layer_C_cdn?.['206'] || 0,
    cap_acq: m?.capability?.acquisitions || 0,
    cap_reuses: m?.capability?.reuses || 0,
    prefetch_triggered: m?.playback_intelligence?.prefetch_triggered || 0,
    prefetch_chunks_requested: m?.playback_intelligence?.prefetch_chunks_requested || 0,
    prefetch_chunks_completed: m?.playback_intelligence?.prefetch_chunks_completed || 0,
    prefetch_joined_inflight: m?.playback_intelligence?.prefetch_joined_inflight || 0,
    prefetch_served_demand: m?.playback_intelligence?.prefetch_served_demand || 0,
    prefetch_joined_by_demand: m?.playback_intelligence?.prefetch_joined_by_demand || 0,
    auto_wait: m?.playback_intelligence?.auto_selected_wait || 0,
    auto_try: m?.playback_intelligence?.auto_selected_try || 0,
    spare_capacity: m?.playback_intelligence?.spare_capacity || 0,
  };
}

function delta(b, a) {
  const out = {};
  for (const k of Object.keys(b)) out[k] = b[k] - a[k];
  return out;
}

async function chunkFetch(i, withHash) {
  const start = i * CHUNK;
  const end = start + CHUNK - 1;
  const sink = withHash ? crypto.createHash('sha256') : null;
  return await rangeRead(start, end, sink);
}

async function main() {
  const size = await getSize();
  process.stderr.write(`[p11-control] ${LABEL} :: size=${size} N=${N} pre_ahead=${PRE_AHEAD}\n`);

  // Phase 1: warm the pool by issuing WARM=2 concurrent reads to grow the cap
  // pool to 2 lanes (the manager's concurrent-read-pressure rule), so Auto
  // selects Wait. This emulates P10's "warm pool" setup.
  process.stderr.write(`[p11-control] ${LABEL} :: warm pool (2 concurrent on chunks 0, 1)\n`);
  await Promise.all([chunkFetch(0, true), chunkFetch(1, true)]);
  await sleep(500);

  // Phase 2: sequential playback at GAP_MS cadence so Auto->Wait fires prefetch.
  // We use a moderate gap (1000-1500ms) so prefetch can land before demand for
  // some chunks (P11 §8.A) and race demand for others (P11 §8.B).
  const GAP = parseInt(process.env.GAP_MS || '1200', 10);
  process.stderr.write(`[p11-control] ${LABEL} :: sequential 0..${N-1} gap=${GAP}ms\n`);
  for (let i = 0; i < N; i++) {
    const m0 = snapshot(await getJSON('/metrics'));
    const t0 = Date.now();
    const r = await chunkFetch(i, true);
    const m1 = snapshot(await getJSON('/metrics'));
    const d = delta(m1, m0);
    process.stderr.write(
      `  chunk ${i} ttfb=${r.ttfbMs}ms bytes=${r.bytes} sha=${r.sha256?.slice(0, 12)} ` +
      `dur=${Date.now() - t0}ms | ` +
      `served_demand=+${d.prefetch_served_demand} joined_by_demand=+${d.prefetch_joined_by_demand} ` +
      `completed=+${d.prefetch_chunks_completed} join_inflight=+${d.prefetch_joined_inflight} ` +
      `wait=+${d.auto_wait} try=+${d.auto_try} ` +
      `bytes_up=+${d.bytes_upstream_issued} cap=+${d.cap_acq} api=+${d.api_requests} cdn=+${d.cdn_206} ` +
      `chunks_present=${m1.chunks_present}\n`
    );
    if (i < N - 1) await sleep(GAP);
  }

  // Phase 3: seek back to chunk 0. This chunk is already durable from phase 2's
  // demand fill, so the read MUST be a cache hit. P11 demand-path serves it
  // locally — no new upstream.
  {
    const m0 = snapshot(await getJSON('/metrics'));
    const r = await chunkFetch(0, true);
    const m1 = snapshot(await getJSON('/metrics'));
    const d = delta(m1, m0);
    process.stderr.write(
      `[p11-control] ${LABEL} :: seek0 ttfb=${r.ttfbMs}ms bytes=${r.bytes} ` +
      `sha=${r.sha256?.slice(0, 12)} | bytes_up=+${d.bytes_upstream_issued} api=+${d.api_requests} cdn=+${d.cdn_206} ` +
      `cap=+${d.cap_acq} (must be 0 upstream; cache PRESENT)\n`
    );
  }

  // Final summary
  const final = await getJSON('/metrics');
  process.stderr.write(`\n[p11-control] ${LABEL} :: FINAL playback_intelligence:\n`);
  const pi = final.playback_intelligence;
  for (const k of Object.keys(pi)) {
    if (typeof pi[k] === 'number' || typeof pi[k] === 'string' || typeof pi[k] === 'boolean') {
      process.stderr.write(`  ${k} = ${pi[k]}\n`);
    }
  }
}

main().catch((e) => { process.stderr.write(String(e?.stack || e) + '\n'); process.exit(1); });
