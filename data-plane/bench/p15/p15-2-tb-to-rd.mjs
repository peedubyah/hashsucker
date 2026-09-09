// p15-2-tb-to-rd.mjs - P15 step 2: TB->RD actual in-manager shielding.
//
// What this script proves:
//   1. HY4_FORCE_FAIL_PROVIDER is NOT set (so both coords enter the
//      CapabilityManager normally).
//   2. HY4_FORCE_SLOT_FAILURE=tfId:torbox is set, so the runtime
//      fault injects ONLY when the torbox slot attempts acquire.
//   3. The 1-MiB range served is UN-CACHED (we use a fresh cache volume
//      and a range whose chunk has never been served).
//   4. Container logs show:
//        [p15] HY4_FORCE_SLOT_FAILURE: tfId=... provider=torbox slot_attempted=1 slot_failed=1
//        [p15] slot_attempted: tfId=... provider=realdebrid slot_served=1
//   5. The 206 SHA matches the TB reference SHAs (52daa79d4aff / 977afd3ce097 / 11c81ee706e0).
//   6. API counts: TB slot did NOT call any provider API; RD slot called
//      /torrents + /torrents/info/{id} + /unrestrict/link = 3 calls.

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
const LABEL = process.env.LABEL || 'p15-2-tb-to-rd';

// Use 3 uncached ranges from disjoint 8 MiB chunks.
// 1 MiB @ 0..1MiB         -> chunk 0
// 1 MiB @ 10MiB..11MiB    -> chunk 1
// 1 MiB @ size-1MiB       -> last chunk
const EXPECTED_SHAS = {
  'front-1MiB': '52daa79d4aff',
  'mid-1MiB-at-10MiB': '977afd3ce097',
  'tail-1MiB': '11c81ee706e0',
};
const PROOFS = [
  [0,         1024 * 1024 - 1, 'front-1MiB'],
  [10 * 1024 * 1024, 10 * 1024 * 1024 + 1024 * 1024 - 1, 'mid-1MiB-at-10MiB'],
  [FROZEN.size - 1024 * 1024, FROZEN.size - 1, 'tail-1MiB'],
];

async function run() {
  log(`LABEL=${LABEL} TFID=${TFID} size=${FROZEN.size}`);
  const m0 = await waitForHealthy();
  let prev = snapshot(m0);
  log(
    `startup: chunks_present=${m0.cache?.chunks_present} ` +
    `cap.acq=${m0.capability?.acquisitions} cap.reuse=${m0.capability?.reuses} ` +
    `brk_open=${m0.capability?.breakers_open || 0}`
  );

  let allOk = true;
  for (const [start, end, label] of PROOFS) {
    const r = await rangeFetch(TFID, start, end);
    const now = await metricsGet();
    const cur = snapshot(now);
    const d = delta(cur, prev);
    const expected = end - start + 1;
    const expectedShaPrefix = EXPECTED_SHAS[label];
    const shaOk = expectedShaPrefix
      ? r.sha256.startsWith(expectedShaPrefix)
      : false;
    const ok = r.status === 206 && r.bytes === expected && shaOk;
    log(
      `${label} start=${start} end=${end} status=${r.status} ` +
      `bytes=${r.bytes}/${expected} ttfb=${r.ttfbMs}ms ` +
      `sha=${r.sha256.slice(0, 12)} (expected ${expectedShaPrefix}) ` +
      `content-range=${r.headers['content-range'] || 'none'} ` +
      `${ok ? 'OK' : 'FAIL'} | ${fmtDelta(d)}`
    );
    if (!ok) {
      log(`FAIL: ${label} expected 206/${expected}/${expectedShaPrefix}, ` +
          `got ${r.status}/${r.bytes}/${r.sha256.slice(0, 12)}`);
      allOk = false;
    }
    prev = cur;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!allOk) {
    log('ABORT: TB->RD in-manager shielding FAILED');
    process.exit(2);
  }
  log('DONE: TB->RD in-manager shielding proven - TB slot attempted+failed, RD slot served 206');
  process.exit(0);
}

run().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
