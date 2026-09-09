// p12-soak-D-phase3: post-restart reads (re-read cached, then new chunk 15)
import http from 'node:http';
import crypto from 'node:crypto';

const DP = process.env.DP_URL || 'http://127.0.0.1:3011';
const TFID = process.env.TFID || 'tf_46203b5e-2a8d-44f7-9a93-20114c60b24d';
const CHUNK = parseInt(process.env.CHUNK_SIZE || '8388608', 10);
const LABEL = process.env.LABEL || 'p12-D';

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

async function emit(label, prevM, idx) {
  const r = await chunkFetch(idx);
  const nowM = snapshot(await getJSON('/metrics'));
  const d = delta(nowM, prevM);
  process.stderr.write(
    `[p12-D] ${label} #${String(idx).padStart(2)} status=${r.status} ttfb=${String(r.ttfbMs).padStart(4)}ms bytes=${r.bytes} ` +
    `bytes_up=+${d.bytes_upstream_issued} cdn=+${d.cdn_206} api=+${d.api_requests} ` +
    `pf=+${d.pf_trig}/${d.pf_comp}/${d.pf_served} seek_repri=+${d.seek_repri} ` +
    `chunks_present=${nowM.chunks_present} cap.acq=${nowM.cap_acq} cap.reuse=${nowM.cap_reuse} ` +
    `sha=${r.sha256?.slice(0, 12)}\n`
  );
  return nowM;
}

async function main() {
  process.stderr.write(`[p12-D] ${LABEL} PHASE-3: post-restart DP=${DP}\n`);
  // Wait for healthy
  for (let i = 0; i < 15; i++) {
    try {
      const m = await getJSON('/metrics');
      if (m.cache) {
        process.stderr.write(`[p12-D] ${LABEL} POST-RESTART probe ok (attempt ${i+1})\n`);
        break;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }

  // PHASE 3a: re-read 0..3 (should hit cache)
  process.stderr.write(`[p12-D] ${LABEL} PHASE-3a: re-read 0..3 (should hit cache)\n`);
  let m = snapshot(await getJSON('/metrics'));
  for (let i = 0; i < 4; i++) {
    m = await emit(LABEL, m, i);
    await new Promise((r) => setTimeout(r, 200));
  }
  // PHASE 3b: read new chunk 15 + 16
  process.stderr.write(`[p12-D] ${LABEL} PHASE-3b: read new chunk 15, 16 (should fetch upstream)\n`);
  m = await emit(LABEL, m, 15);
  await new Promise((r) => setTimeout(r, 200));
  m = await emit(LABEL, m, 16);

  // FINAL
  const final = await getJSON('/metrics');
  process.stderr.write(`\n[p12-D] ${LABEL} :: FINAL playback_intelligence:\n`);
  const pi = final.playback_intelligence;
  for (const k of Object.keys(pi)) {
    if (typeof pi[k] === 'number' || typeof pi[k] === 'string' || typeof pi[k] === 'boolean') {
      process.stderr.write(`  ${k} = ${pi[k]}\n`);
    }
  }
  process.stderr.write(`[p12-D] ${LABEL} :: hot: ${JSON.stringify(pi.top)}\n`);
  const c = final.cache;
  const cap = final.capability;
  process.stderr.write(`[p12-D] ${LABEL} :: cache: bytes_upstream_issued=${c?.bytes_upstream_issued} chunk_claims=${c?.chunk_claims} chunks_present=${c?.chunks_present}\n`);
  process.stderr.write(`[p12-D] ${LABEL} :: upstream: layer_A_api.requests=${final.layer_A_api?.requests} layer_C_cdn[206]=${final.layer_C_cdn?.['206']} cap.acq=${cap?.acquisitions} cap.reuse=${cap?.reuses}\n`);
}

main().catch((e) => { process.stderr.write(String(e?.stack || e) + '\n'); process.exit(1); });
