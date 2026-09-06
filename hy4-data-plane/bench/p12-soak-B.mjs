// p12-soak-B: P12 default-ON seek-heavy soak.
//
// P12 §3.B: short sequential -> far seek -> short sequential -> seek. We prove:
//   1. seek_reprioritizations increments per seek
//   2. Old region stops extending (no new prefetch trigger in old region after seek)
//   3. New demand priority=0 (unchanged), ahead=1 fires for new region
//   4. Stale prefetch intent does not amplify upstream (bounded waste)

import http from 'node:http';
import crypto from 'node:crypto';

const DP = process.env.DP_URL || 'http://127.0.0.1:3011';
const TFID = process.env.TFID || 'tf_46203b5e-2a8d-44f7-9a93-20114c60b24d';
const CHUNK = parseInt(process.env.CHUNK_SIZE || '8388608', 10);
const LABEL = process.env.LABEL || 'p12-B';
const GAP_MS = parseInt(process.env.GAP_MS || '400', 10);

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

async function emit(label, prevM, idx, withHash) {
  const r = await chunkFetch(idx, withHash);
  const nowM = snapshot(await getJSON('/metrics'));
  const d = delta(nowM, prevM);
  process.stderr.write(
    `[p12-B] ${label} #${String(idx).padStart(2)} status=${r.status} ttfb=${String(r.ttfbMs).padStart(4)}ms bytes=${r.bytes} ` +
    `bytes_up=+${d.bytes_upstream_issued} cdn=+${d.cdn_206} api=+${d.api_requests} ` +
    `pf=+${d.pf_trig}/${d.pf_comp}/${d.pf_served}/${d.pf_joined_inf} skip=+${d.pf_skipped} ` +
    `seek_repri=+${d.seek_repri} auto=${d.auto_try}+${d.auto_wait} spare=${d.spare_cap}\n`
  );
  if (withHash) process.stderr.write(`  sha256[${idx}] = ${r.sha256?.slice(0, 16)}...\n`);
  return nowM;
}

async function main() {
  process.stderr.write(`[p12-B] DP=${DP} TFID=${TFID} GAP_MS=${GAP_MS}\n`);
  // First, a "warm" sequential pass of 5 chunks in the LOW region
  let m = snapshot(await getJSON('/metrics'));
  process.stderr.write(`[p12-B] ${LABEL} PHASE-1: low-region sequential 0..4\n`);
  for (let i = 0; i < 5; i++) {
    m = await emit(LABEL, m, i, i === 0);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  // Now SEEK FAR (chunk 20) - this is the seek
  process.stderr.write(`[p12-B] ${LABEL} PHASE-2: SEEK to chunk 20 (far jump)\n`);
  m = await emit(LABEL, m, 20, false);
  await new Promise((r) => setTimeout(r, GAP_MS));
  // Continue sequential 20..24 in the high region
  process.stderr.write(`[p12-B] ${LABEL} PHASE-3: high-region sequential 20..24\n`);
  for (let i = 21; i < 25; i++) {
    m = await emit(LABEL, m, i, i === 24);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  // SEEK BACK to chunk 5 (another seek)
  process.stderr.write(`[p12-B] ${LABEL} PHASE-4: SEEK to chunk 5 (back jump)\n`);
  m = await emit(LABEL, m, 5, false);
  await new Promise((r) => setTimeout(r, GAP_MS));
  // Continue sequential 5..9
  process.stderr.write(`[p12-B] ${LABEL} PHASE-5: low-region sequential 5..9\n`);
  for (let i = 6; i < 10; i++) {
    m = await emit(LABEL, m, i, i === 9);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  // Final summary
  const final = await getJSON('/metrics');
  process.stderr.write(`\n[p12-B] ${LABEL} :: FINAL playback_intelligence:\n`);
  const pi = final.playback_intelligence;
  for (const k of Object.keys(pi)) {
    if (typeof pi[k] === 'number' || typeof pi[k] === 'string' || typeof pi[k] === 'boolean') {
      process.stderr.write(`  ${k} = ${pi[k]}\n`);
    }
  }
  const c = final.cache;
  const cap = final.capability;
  process.stderr.write(`[p12-B] ${LABEL} :: cache: bytes_upstream_issued=${c?.bytes_upstream_issued} chunk_claims=${c?.chunk_claims} chunks_present=${c?.chunks_present}\n`);
  process.stderr.write(`[p12-B] ${LABEL} :: upstream: layer_A_api.requests=${final.layer_A_api?.requests} layer_C_cdn[206]=${final.layer_C_cdn?.['206']} cap.acq=${cap?.acquisitions} cap.reuse=${cap?.reuses}\n`);
}

main().catch((e) => { process.stderr.write(String(e?.stack || e) + '\n'); process.exit(1); });
