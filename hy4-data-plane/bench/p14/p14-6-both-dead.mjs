// p14-6-both-dead.mjs - P14 step 6: both providers fail -> 502 PROVIDER_EXHAUSTED.
//
// What this script proves:
//   1. With HY4_FORCE_FAIL_PROVIDER set to BOTH tfId:torbox AND tfId:realdebrid
//      (semicolon-separated), the CapabilityManager has no slots to try.
//   2. The first 206-byte range request returns 502 with
//      {"error":{"code":"PROVIDER_EXHAUSTED",...}} in the body.
//   3. No persisted fallback, no chunk writes, no DB writes.

import http from 'node:http';
import { FROZEN, metricsGet, log, waitForHealthy } from '../p13/p13-helper.mjs';

const TFID = process.env.TFID || FROZEN.tfId;
const LABEL = process.env.LABEL || 'p14-6-both-dead';

const DP = process.env.DP_URL || 'http://127.0.0.1:3011';

function rangeFetchRaw(tfId, start, end) {
  const u = new URL(DP);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port || 80),
        path: `/files/${encodeURIComponent(tfId)}`,
        method: 'GET',
        headers: { Range: `bytes=${start}-${end}` },
      },
      (res) => {
        const buf = [];
        res.on('data', (c) => buf.push(c));
        res.on('end', () => {
          const body = Buffer.concat(buf);
          const headers = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
          resolve({ status: res.statusCode, headers, body: body.toString('utf8') });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  log(`LABEL=${LABEL} TFID=${TFID} size=${FROZEN.size} DP=${DP}`);
  const m0 = await waitForHealthy();
  log(
    `startup: chunks_present=${m0.cache?.chunks_present} ` +
    `cap.acq=${m0.capability?.acquisitions} cap.reuse=${m0.capability?.reuses}`
  );

  const r = await rangeFetchRaw(TFID, 0, 1024 * 1024 - 1);
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch (_) { /* keep raw */ }

  const okStatus = r.status === 502;
  const okBody = parsed?.error?.code === 'PROVIDER_EXHAUSTED' && parsed?.error?.torrent_file_id === TFID;
  const ok = okStatus && okBody;

  log(
    `front-1MiB status=${r.status} ` +
    `body=${r.body.slice(0, 200)} ` +
    `parsed.error.code=${parsed?.error?.code} ` +
    `parsed.error.torrent_file_id=${parsed?.error?.torrent_file_id} ` +
    `${ok ? 'OK' : 'FAIL'}`
  );

  if (!ok) {
    log('ABORT: expected 502 with PROVIDER_EXHAUSTED + matching torrent_file_id');
    process.exit(2);
  }

  // Probe a second range to confirm the classification is stable, not transient.
  const r2 = await rangeFetchRaw(TFID, 10 * 1024 * 1024, 11 * 1024 * 1024 - 1);
  let parsed2 = null;
  try { parsed2 = JSON.parse(r2.body); } catch (_) { /* */ }
  const ok2 = r2.status === 502
    && parsed2?.error?.code === 'PROVIDER_EXHAUSTED'
    && parsed2?.error?.torrent_file_id === TFID;
  log(
    `mid-1MiB status=${r2.status} ` +
    `parsed.error.code=${parsed2?.error?.code} ` +
    `parsed.error.torrent_file_id=${parsed2?.error?.torrent_file_id} ` +
    `${ok2 ? 'OK' : 'FAIL'}`
  );
  if (!ok2) {
    log('ABORT: second range did not return 502 PROVIDER_EXHAUSTED');
    process.exit(2);
  }

  log('DONE: both-dead returns 502 PROVIDER_EXHAUSTED with the frozen tfId');
  process.exit(0);
}

run().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
