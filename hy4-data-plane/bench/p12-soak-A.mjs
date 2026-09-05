// p12-soak-A: P12 default-ON long sequential soak.
//
// P12 §3.A: long sequential read of N=26 chunks on the P12 default-ON
// container (sequential_threshold=2, ahead_chunks=1). After sequential
// confidence arms, the playback_intel layer should trigger a prefetch for the
// next chunk before the next demand arrives. We measure triggered/completed/
// served/joined counts vs the demand-only baseline (N=26 demand bytes from CDN).

import http from 'node:http';
import crypto from 'node:crypto';

const DP = process.env.DP_URL || 'http://127.0.0.1:3011';
const TFID = process.env.TFID || 'tf_46203b5e-2a8d-44f7-9a93-20114c60b24d';
const CHUNK = parseInt(process.env.CHUNK_SIZE || '8388608', 10);
const N = parseInt(process.env.N || '26', 10);
const GAP_MS = parseInt(process.env.GAP_MS || '1200', 10);
const LABEL = process.env.LABEL || 'p12-A';

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

function chunkFetch(idx, withHash) {
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
        const ttfb = Date.now() - t0;
        resolve({
          idx, status: res.statusCode, ttfbMs: ttfb, bytes,
          sha256: withHash ? crypto.createHash('sha256').update(body).digest('hex') : null,
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
    bytes_fetched_upstream: m?.cache?.bytes_fetched_upstream || 0,
    chunk_claims: m?.cache?.chunk_claims || 0,
    chunks_present: m?.cache?.chunks_present || 0,
    api_requests: m?.layer_A_api?.requests || 0,
    cdn_206: m?.layer_C_cdn?.['206'] || 0,
    cap_acq: m?.capability?.acquisitions || 0,
    cap_reuse: m?.capability?.reuses || 0,
    pf_trig: m?.playback_intelligence?.prefetch_triggered || 0,
    pf_comp: m?.playback_intelligence?.prefetch_chunks_completed || 0,
    pf_served: m?.playback_intelligence?.prefetch_served_demand || 0,
    pf_joined_inf: m?.playback_intelligence?.prefetch_joined_inflight || 0,
    pf_joined_dem: m?.playback_intelligence?.prefetch_joined_by_demand || 0,
    pf_fail: m?.playback_intelligence?.prefetch_failures || 0,
    pf_skipped: m?.playback_intelligence?.prefetch_chunks_skipped_present || 0,
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

async function main() {
  process.stderr.write(`[p12-A] DP=${DP} TFID=${TFID} N=${N} GAP_MS=${GAP_MS}\n`);
  let prevM = snapshot(await getJSON('/metrics'));
  for (let i = 0; i < N; i++) {
    const doHash = (i === 0 || i === 12 || i === N - 1);
    const r = await chunkFetch(i, doHash);
    const nowM = snapshot(await getJSON('/metrics'));
    const d = delta(nowM, prevM);
    process.stderr.write(
      `[p12-A] ${LABEL} #${String(i).padStart(2)} status=${r.status} ttfb=${String(r.ttfbMs).padStart(4)}ms bytes=${r.bytes} ` +
      `bytes_up=+${d.bytes_upstream_issued} cdn=+${d.cdn_206} api=+${d.api_requests} ` +
      `pf=+${d.pf_trig}/${d.pf_comp}/${d.pf_served}/${d.pf_joined_inf} skip=+${d.pf_skipped} ` +
      `auto=${d.auto_try}+${d.auto_wait} spare=${d.spare_cap}\n`
    );
    if (doHash) process.stderr.write(`  sha256[${i}] = ${r.sha256?.slice(0, 16)}...\n`);
    prevM = nowM;
    if (i < N - 1) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  const final = await getJSON('/metrics');
  process.stderr.write(`\n[p12-A] ${LABEL} :: FINAL playback_intelligence:\n`);
  const pi = final.playback_intelligence;
  for (const k of Object.keys(pi)) {
    if (typeof pi[k] === 'number' || typeof pi[k] === 'string' || typeof pi[k] === 'boolean') {
      process.stderr.write(`  ${k} = ${pi[k]}\n`);
    }
  }
  const c = final.cache;
  const cap = final.capability;
  process.stderr.write(`[p12-A] ${LABEL} :: cache: bytes_upstream_issued=${c?.bytes_upstream_issued} bytes_fetched_upstream=${c?.bytes_fetched_upstream} chunk_claims=${c?.chunk_claims} chunks_present=${c?.chunks_present}\n`);
  process.stderr.write(`[p12-A] ${LABEL} :: upstream: layer_A_api.requests=${final.layer_A_api?.requests} layer_C_cdn[206]=${final.layer_C_cdn?.['206']} cap.acq=${cap?.acquisitions} cap.reuse=${cap?.reuses}\n`);
}

main().catch((e) => { process.stderr.write(String(e?.stack || e) + '\n'); process.exit(1); });
