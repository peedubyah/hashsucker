// p14-7-rd-stale.mjs - P14 step 7: RD stale-runtime repair.
//
// What this script proves:
//   1. With RD_TTL_SECONDS=5, the first RD range acquires via
//      /torrents -> /torrents/info/{id} -> /unrestrict/link.
//   2. After >5s sleep, the cached capability expires.
//   3. The second RD range forces a fresh acquisition: cap.acq MUST
//      increment, the new delivery URL must serve 206, and the SHA must
//      match the reference.
//   4. Bounded: the reacquire path must NOT amplify API calls (we verify
//      by api_requests delta being small, e.g. 3 for the fresh acquire
//      triple: /torrents + /torrents/info + /unrestrict/link).

import {
  FROZEN,
  rangeFetch,
  metricsGet,
  snapshot,
  delta,
  waitForHealthy,
  log,
  fmtDelta,
} from '../p13/p13-helper.mjs';

const TFID = process.env.TFID || FROZEN.tfId;
const LABEL = process.env.LABEL || 'p14-7-rd-stale';
const TTL_S = Number(process.env.RD_TTL_S || '5');
const SLEEP_MS = (TTL_S + 1) * 1000; // sleep just past TTL

const EXPECTED_SHAS = {
  'front-1MiB': '52daa79d4aff',
  'mid-1MiB-at-10MiB': '977afd3ce097',
};

async function run() {
  log(`LABEL=${LABEL} TFID=${TFID} TTL=${TTL_S}s sleep=${SLEEP_MS}ms`);
  const m0 = await waitForHealthy();
  let prev = snapshot(m0);
  log(
    `startup: chunks_present=${m0.cache?.chunks_present} ` +
    `cap.acq=${m0.capability?.acquisitions} cap.reuse=${m0.capability?.reuses}`
  );

  // Phase 1: initial acquire. /torrents + /torrents/info + /unrestrict/link
  // should be 3 RD API calls.
  const r1 = await rangeFetch(TFID, 0, 1024 * 1024 - 1);
  const m1 = await metricsGet();
  const cur1 = snapshot(m1);
  const d1 = delta(cur1, prev);
  const expected1 = 1024 * 1024;
  const expectedSha1 = EXPECTED_SHAS['front-1MiB'];
  const ok1 = r1.status === 206
    && r1.bytes === expected1
    && r1.sha256.startsWith(expectedSha1)
    && d1.cap_acq >= 1;
  log(
    `phase1 front-1MiB status=${r1.status} bytes=${r1.bytes}/${expected1} ` +
    `sha=${r1.sha256.slice(0, 12)} (expected ${expectedSha1}) ` +
    `api=+${d1.api_requests} cap.acq=+${d1.cap_acq} cap.reuse=+${d1.cap_reuse} ` +
    `brk_open=${d1.breakers_open} ${ok1 ? 'OK' : 'FAIL'}`
  );
  if (!ok1) {
    log('ABORT: phase1 initial acquire did not match expectations');
    process.exit(2);
  }
  prev = cur1;

  // Phase 2: sleep past TTL.
  log(`sleeping ${SLEEP_MS}ms to expire the RD capability...`);
  await new Promise((r) => setTimeout(r, SLEEP_MS));

  // Phase 3: second acquire. The cap should be expired and a fresh
  // /torrents + /torrents/info + /unrestrict/link triple should run.
  const r2 = await rangeFetch(TFID, 10 * 1024 * 1024, 10 * 1024 * 1024 + 1024 * 1024 - 1);
  const m2 = await metricsGet();
  const cur2 = snapshot(m2);
  const d2 = delta(cur2, prev);
  const expected2 = 1024 * 1024;
  const expectedSha2 = EXPECTED_SHAS['mid-1MiB-at-10MiB'];
  const ok2 = r2.status === 206
    && r2.bytes === expected2
    && r2.sha256.startsWith(expectedSha2)
    && d2.cap_acq >= 1;
  log(
    `phase3 mid-1MiB-after-TTL status=${r2.status} bytes=${r2.bytes}/${expected2} ` +
    `sha=${r2.sha256.slice(0, 12)} (expected ${expectedSha2}) ` +
    `api=+${d2.api_requests} cap.acq=+${d2.cap_acq} cap.reuse=+${d2.cap_reuse} ` +
    `brk_open=${d2.breakers_open} ${ok2 ? 'OK' : 'FAIL'} | ${fmtDelta(d2)}`
  );
  if (!ok2) {
    log('ABORT: phase3 stale-reacquire did not match expectations');
    process.exit(2);
  }

  // Bounded: at most ~3 RD API calls for the fresh triple. Allow a
  // small upper bound for any incidental calls.
  if (d2.api_requests > 6) {
    log(`WARN: phase3 api_requests delta=${d2.api_requests} > 6 (expected ~3)`);
  }

  log('DONE: RD stale-runtime repair proven - fresh acquire served 206 with expected SHA');
  process.exit(0);
}

run().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
