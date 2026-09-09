// p14-4-tb-to-rd.mjs - P14 step 4: TB->RD shielding proof.
//
// What this script proves:
//   1. With a dual-provider container (no allowlist), set
//      HY4_FORCE_FAIL_PROVIDER=tf_5de34a78...:torbox so the TB slot is
//      surgically removed BEFORE CapabilityManager construction.
//   2. RD is the only remaining slot, and it serves 206 with the same
//      reference SHAs as the TB-only container.
//   3. This is the inverse of P14-5 (RD->TB shielding) and uses the
//      /torrents-based RD acquisition path from P14-A.

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
const LABEL = process.env.LABEL || 'p14-4-tb-to-rd';

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
      log(
        `FAIL: ${label} expected 206/${expected}/${expectedShaPrefix}, ` +
        `got ${r.status}/${r.bytes}/${r.sha256.slice(0, 12)}`
      );
      allOk = false;
    }
    prev = cur;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!allOk) {
    log('ABORT: TB->RD shielding proof FAILED (one or more ranges did not match)');
    process.exit(2);
  }
  log('DONE: TB->RD shielding proven - RD slot served 206 with TB reference SHAs');
  process.exit(0);
}

run().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
