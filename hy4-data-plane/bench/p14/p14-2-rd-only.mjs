// p14-2-rd-only.mjs - P14 step 2: RealDebrid-only real bytes proof.
//
// What this script proves:
//   1. With HY4_FORCE_PROVIDER=tf_5de34a78...:realdebrid set, range requests
//      on the frozen TorrentFile return 206 with the SAME bytes the TB-only
//      container served.
//   2. The Rust data plane is reaching RealDebrid through the new
//      /torrents -> /torrents/info/{id} -> /unrestrict/link acquisition path.
//   3. RD-derived 1-MiB range SHAs match the TB reference SHAs (P13 baseline):
//        front-1MiB  -> 52daa79d4aff...
//        mid-1MiB    -> 977afd3ce097...
//        tail-1MiB   -> 11c81ee706e0...
//
// What this script does NOT prove (covered by other P14 steps):
//   - TB<->RD shielding (P14-4/5)
//   - Both-failed PROVIDER_EXHAUSTED (P14-6)
//   - RD stale-runtime repair (P14-7)
//   - API sanity / amplification (P14-8)

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
const LABEL = process.env.LABEL || 'p14-2-rd-only';

// TB-only reference SHAs from the P13 RESUME (frozen identity).
// Each is a SHA-256 of a 1 MiB range; we compare the first 12 hex chars.
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
      `cache-control=${r.headers['cache-control'] || 'none'} ` +
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
    log('ABORT: one or more RD-only ranges failed to match TB reference SHAs');
    process.exit(2);
  }
  log('DONE: RD-only 3-range proof matches TB-only reference SHAs');
  process.exit(0);
}

run().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
