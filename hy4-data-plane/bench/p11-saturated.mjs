// p11-saturated - P11 §8.D saturated regression proof.
//
// Single-cap, no idle lane, Auto must -> Try, no prefetch completion, no new
// latency/API regression vs demand-only. Use WARM=1 (single capability), gap=0
// (no idle time for prefetch to start, but the warm cap is being used so spare
// capacity stays at 0).

import http from 'node:http';
import crypto from 'node:crypto';

const DP = process.env.DP_URL || 'http://127.0.0.1:3011';
const TFID = process.env.TFID || 'tf_46203b5e-2a8d-44f7-9a93-20114c60b24d';
const CHUNK = parseInt(process.env.CHUNK_SIZE || '8388608', 10);
const N = parseInt(process.env.N || '8', 10);
const WARM = parseInt(process.env.WARM || '1', 10);
const GAP = parseInt(process.env.GAP_MS || '0', 10);
const LABEL = process.env.LABEL || 'sat';

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(`${DP}${path}`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
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
          resolve({ status: res.statusCode, ttfbMs: firstByteAt == null ? -1 : firstByteAt, bytes, sha256: sink ? sink.digest('hex') : null })
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

function snap(m) {
  return {
    bytes_up: m?.cache?.bytes_upstream_issued || 0,
    cdn: m?.layer_C_cdn?.['206'] || 0,
    api: m?.layer_A_api?.requests || 0,
    cap: m?.capability?.acquisitions || 0,
    served: m?.playback_intelligence?.prefetch_served_demand || 0,
    completed: m?.playback_intelligence?.prefetch_chunks_completed || 0,
    wait: m?.playback_intelligence?.auto_selected_wait || 0,
    try_n: m?.playback_intelligence?.auto_selected_try || 0,
    spare: m?.playback_intelligence?.spare_capacity || 0,
    chunk_claims: m?.cache?.chunk_claims || 0,
    chunks_present: m?.cache?.chunks_present || 0,
  };
}

async function main() {
  const size = await getSize();
  process.stderr.write(`[p11-sat] ${LABEL} :: size=${size} N=${N} warm=${WARM} gap=${GAP}ms\n`);

  const m0 = snap(await getJSON('/metrics'));

  if (WARM > 0) {
    process.stderr.write(`[p11-sat] ${LABEL} :: warm ${WARM} concurrent\n`);
    const reads = [];
    for (let i = 0; i < WARM; i++) {
      reads.push(rangeRead(i * CHUNK, (i + 1) * CHUNK - 1));
    }
    await Promise.all(reads);
  }

  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const r = await rangeRead(i * CHUNK, (i + 1) * CHUNK - 1, crypto.createHash('sha256'));
    process.stderr.write(`  ${LABEL} chunk ${i}: ttfb=${r.ttfbMs}ms dur=${Date.now() - t0}ms bytes=${r.bytes}\n`);
    if (GAP > 0 && i < N - 1) await sleep(GAP);
  }

  const m1 = snap(await getJSON('/metrics'));
  const d = {};
  for (const k of Object.keys(m1)) d[k] = m1[k] - m0[k];

  process.stderr.write(`\n[p11-sat] ${LABEL} :: DELTAS\n`);
  for (const k of Object.keys(d)) process.stderr.write(`  ${k} = +${d[k]}\n`);
  process.stderr.write(`  final.spare = ${m1.spare}\n`);
  process.stderr.write(`  final.chunks_present = ${m1.chunks_present}\n`);
  process.stderr.write(
    `  verdict: try=${d.try_n} wait=${d.wait} completed=${d.completed} served=${d.served} ` +
    `(must be try-only, 0 completions, 0 served)\n`
  );
}

main().catch((e) => { process.stderr.write(String(e?.stack || e) + '\n'); process.exit(1); });
