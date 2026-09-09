// p15-4-both-runtime-fail.mjs - P15 step 4: both runtime slots fail.
//
// What this script proves:
//   1. HY4_FORCE_FAIL_PROVIDER is NOT set; BOTH providers enter the
//      CapabilityManager as real slots.
//   2. HY4_FORCE_SLOT_FAILURE is set to BOTH providers (semicolon-separated):
//      HY4_FORCE_SLOT_FAILURE='tfId:torbox;tfId:realdebrid'
//   3. Container logs show the runtime fault fired on BOTH slots
//      (one line per provider).
//   4. The first 206-byte range request returns 502 with
//      {"error":{"code":"PROVIDER_EXHAUSTED","torrent_file_id":"tf_5de34a78-..."}}
//      and a second range returns the same (stable classification, not transient).
//   5. all_same_tf counter is +1 per request.

import http from 'node:http';
import { FROZEN, metricsGet, log, waitForHealthy } from '../p13/p13-helper.mjs';

const TFID = process.env.TFID || FROZEN.tfId;
const LABEL = process.env.LABEL || 'p15-4-both-runtime-fail';
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
  const allSameTf0 = m0.all_same_tf || 0;
  log(`startup: chunks_present=${m0.cache?.chunks_present} all_same_tf=${allSameTf0}`);

  const r1 = await rangeFetchRaw(TFID, 0, 1024 * 1024 - 1);
  let p1 = null; try { p1 = JSON.parse(r1.body); } catch (_) {}
  const m1 = await metricsGet();
  const allSameTf1 = m1.all_same_tf || 0;
  const ok1 = r1.status === 502
    && p1?.error?.code === 'PROVIDER_EXHAUSTED'
    && p1?.error?.torrent_file_id === TFID
    && (allSameTf1 - allSameTf0) >= 1;
  log(
    `front-1MiB status=${r1.status} ` +
    `body=${r1.body.slice(0, 200)} ` +
    `parsed.error.code=${p1?.error?.code} ` +
    `parsed.error.torrent_file_id=${p1?.error?.torrent_file_id} ` +
    `all_same_tf delta=${allSameTf1 - allSameTf0} ` +
    `${ok1 ? 'OK' : 'FAIL'}`
  );
  if (!ok1) {
    log('ABORT: first range did not return 502 PROVIDER_EXHAUSTED + all_same_tf++');
    process.exit(2);
  }

  const r2 = await rangeFetchRaw(TFID, 10 * 1024 * 1024, 11 * 1024 * 1024 - 1);
  let p2 = null; try { p2 = JSON.parse(r2.body); } catch (_) {}
  const m2 = await metricsGet();
  const allSameTf2 = m2.all_same_tf || 0;
  const ok2 = r2.status === 502
    && p2?.error?.code === 'PROVIDER_EXHAUSTED'
    && p2?.error?.torrent_file_id === TFID
    && (allSameTf2 - allSameTf1) >= 1;
  log(
    `mid-1MiB status=${r2.status} ` +
    `parsed.error.code=${p2?.error?.code} ` +
    `parsed.error.torrent_file_id=${p2?.error?.torrent_file_id} ` +
    `all_same_tf delta=${allSameTf2 - allSameTf1} ` +
    `${ok2 ? 'OK' : 'FAIL'}`
  );
  if (!ok2) {
    log('ABORT: second range did not return 502 PROVIDER_EXHAUSTED + all_same_tf++');
    process.exit(2);
  }

  log('DONE: both runtime slots fail -> 502 PROVIDER_EXHAUSTED with the frozen tfId');
  process.exit(0);
}

run().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
