// p12-soak-E: P12 default-ON mixed-files soak (single-tfId interleaved).
//
// P12 §3.E: with only one durable tfId available in this environment, simulate
// mixed-file behavior by running two parallel demand sessions interleaved on
// the same tfId (different chunk ranges, different cadences). Confirm
// playback_intelligence state is internally consistent (one hot entry for the
// tfId, no state bleed between sessions, capability reuses stable, no API
// amplification).

import http from 'node:http';
import crypto from 'node:crypto';

const DP = process.env.DP_URL || 'http://127.0.0.1:3011';
const TFID = process.env.TFID || 'tf_46203b5e-2a8d-44f7-9a93-20114c60b24d';
const CHUNK = parseInt(process.env.CHUNK_SIZE || '8388608', 10);
const LABEL = process.env.LABEL || 'p12-E';

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(DP + path, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function chunkFetch(idx) {
  const start = idx * CHUNK;
  const end = Math.min((idx + 1) * CHUNK, 211552345) - 1;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const u = new URL(DP);
    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port || 80),
      path: `/files/${TFID}`,
      method: 'GET',
      headers: { Range: `bytes=${start}-${end}` },
    }, (res) => {
      const buf = [];
      let bytes = 0;
      res.on('data', (c) => { buf.push(c); bytes += c.length; });
      res.on('end', () => {
        const body = Buffer.concat(buf);
        resolve({
          idx, status: res.statusCode, ttfbMs: Date.now() - t0, bytes,
          sha256: crypto.createHash('sha256').update(body).digest('hex'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function snapshot(m) {
  return {
    bytes_upstream_issued: m?.cache?.bytes_upstream_issued || 0,
    chunk_claims: m?.cache?.chunk_claims || 0,
    chunks_present: m?.cache?.chunks_present || 0,
    api_requests: m?.layer_A_api?.requests || 0,
    cdn_206: m?.layer_C_cdn?.['206'] || 0,
    cap_acq: m?.capability?.acquisitions || 0,
    cap_reuse: m?.capability?.reuses || 0,
    pf_trig: m?.playback_intelligence?.prefetch_triggered || 0,
    pf_comp: m?.playback_intelligence?.prefetch_chunks_completed || 0,
    pf_served: m?.playback_intelligence?.prefetch_served_demand || 0,
    pf_joined: m?.playback_intelligence?.prefetch_joined_by_demand || 0,
    pf_inflight: m?.playback_intelligence?.prefetch_joined_inflight || 0,
    seek_repri: m?.playback_intelligence?.seek_reprioritizations || 0,
    auto_try: m?.playback_intelligence?.auto_selected_try || 0,
    auto_wait: m?.playback_intelligence?.auto_selected_wait || 0,
    spare_cap: m?.playback_intelligence?.spare_capacity || 0,
  };
}

function delta(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = a[k] - b[k];
  return out;
}

async function emit(label, prevM, idx, stream) {
  const r = await chunkFetch(idx);
  const nowM = snapshot(await getJSON('/metrics'));
  const d = delta(nowM, prevM);
  process.stderr.write(
    `[p12-E] ${label} #${String(idx).padStart(2)} status=${r.status} ttfb=${String(r.ttfbMs).padStart(4)}ms bytes=${r.bytes} stream=${stream} ` +
    `bytes_up=+${d.bytes_upstream_issued} cdn=+${d.cdn_206} api=+${d.api_requests} ` +
    `pf=+${d.pf_trig}/${d.pf_comp}/${d.pf_served} pj=+${d.pf_joined} pji=+${d.pf_inflight} ` +
    `chunks_present=${nowM.chunks_present} cap.acq=${nowM.cap_acq} cap.reuse=${nowM.cap_reuse}\n`
  );
  return nowM;
}

async function main() {
  process.stderr.write(`[p12-E] ${LABEL} DP=${DP} TFID=${TFID}\n`);
  // Two "logical files" sharing one tfId: stream A reads 0..4, stream B reads 10..14
  // They run interleaved in time. If per-TF state is correct, only one hot entry
  // exists in the playback_intel map; if it's wrong, the state may show two
  // competing forward_runs or one being overwritten by the other.
  const streamA = [0, 1, 2, 3, 4];
  const streamB = [10, 11, 12, 13, 14];

  process.stderr.write(`[p12-E] ${LABEL} interleaving two streams on the same tfId\n`);
  let m = snapshot(await getJSON('/metrics'));
  for (let round = 0; round < 5; round++) {
    m = await emit(LABEL, m, streamA[round], 'A');
    m = await emit(LABEL, m, streamB[round], 'B');
    await new Promise((r) => setTimeout(r, 300));
  }

  // Wait for prefetch to settle
  process.stderr.write(`[p12-E] ${LABEL} waiting 4s for prefetch to settle\n`);
  await new Promise((r) => setTimeout(r, 4000));

  const final = await getJSON('/metrics');
  process.stderr.write(`\n[p12-E] ${LABEL} :: FINAL playback_intelligence:\n`);
  const pi = final.playback_intelligence;
  for (const k of Object.keys(pi)) {
    if (typeof pi[k] === 'number' || typeof pi[k] === 'string' || typeof pi[k] === 'boolean') {
      process.stderr.write(`  ${k} = ${pi[k]}\n`);
    }
  }
  process.stderr.write(`[p12-E] ${LABEL} :: top.length=${pi.top?.length} (one per known tfId)\n`);
  for (const t of pi.top || []) {
    process.stderr.write(`[p12-E] ${LABEL} :: hot: forward_run=${t.forward_run} confidence=${t.confidence} region=${JSON.stringify(t.forward_region)} hot_chunks_count=${t.hot_chunks?.length}\n`);
  }
  const c = final.cache;
  const cap = final.capability;
  process.stderr.write(`[p12-E] ${LABEL} :: cache: bytes_upstream_issued=${c?.bytes_upstream_issued} chunk_claims=${c?.chunk_claims} chunks_present=${c?.chunks_present}\n`);
  process.stderr.write(`[p12-E] ${LABEL} :: upstream: layer_A_api.requests=${final.layer_A_api?.requests} layer_C_cdn[206]=${final.layer_C_cdn?.['206']} cap.acq=${cap?.acquisitions} cap.reuse=${cap?.reuses}\n`);
}

main().catch((e) => { process.stderr.write(String(e?.stack || e) + '\n'); process.exit(1); });
