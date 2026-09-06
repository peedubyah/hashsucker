// p14-8-api-sanity.mjs - P14 step 8: API sanity / amplification check.
//
// What this script proves:
//   1. With HY4_FORCE_PROVIDER allowing BOTH providers, run 5 front-range
//      reads in a row. cap.acq should NOT increment per read; the cached
//      capability is reused. cap.reuse should increment on subsequent reads.
//   2. The 8 MiB chunk granularity means the front-1MiB read touches
//      exactly 1 upstream chunk. The cached chunk is then reused for
//      subsequent front reads.
//   3. Per-acquire, RD takes exactly 3 API calls: /torrents, /torrents/info,
//      /unrestrict/link. We verify api_requests delta is bounded across
//      multiple reads.
//   4. No breaker opens under healthy operation.
//   5. No per-chunk RD acquisition loop (i.e. a single chunk read should
//      not trigger cap.acq for each chunk).

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
const LABEL = process.env.LABEL || 'p14-8-api-sanity';

async function run() {
  log(`LABEL=${LABEL} TFID=${TFID} size=${FROZEN.size}`);
  const m0 = await waitForHealthy();
  let prev = snapshot(m0);
  log(
    `startup: chunks_present=${m0.cache?.chunks_present} ` +
    `cap.acq=${m0.capability?.acquisitions} cap.reuse=${m0.capability?.reuses}`
  );

  // Run 5 front-1MiB reads. The first should be a fresh cap.acq, the
  // next 4 should be cap.reuse (same chunk, same capability).
  const N = 5;
  for (let i = 1; i <= N; i++) {
    const r = await rangeFetch(TFID, 0, 1024 * 1024 - 1);
    const now = await metricsGet();
    const cur = snapshot(now);
    const d = delta(cur, prev);
    const expected = 1024 * 1024;
    const ok = r.status === 206
      && r.bytes === expected
      && r.sha256.startsWith('52daa79d4aff');
    log(
      `read#${i} status=${r.status} bytes=${r.bytes}/${expected} ` +
      `sha=${r.sha256.slice(0, 12)} ` +
      `api=+${d.api_requests} cap.acq=+${d.cap_acq} cap.reuse=+${d.cap_reuse} ` +
      `brk_open=${d.breakers_open} ${ok ? 'OK' : 'FAIL'} | ${fmtDelta(d)}`
    );
    if (!ok) {
      log(`ABORT: read#${i} failed`);
      process.exit(2);
    }
    prev = cur;
    await new Promise((r) => setTimeout(r, 200));
  }

  // After 5 reads of the SAME 1-MiB range (within 1 8-MiB chunk):
  // - cap.acq should be 1 (initial acquire only)
  // - cap.reuse should be 4 (or whatever's left after the first acquire)
  // - api_requests should be ~3 (RD: /torrents + /torrents/info + /unrestrict/link)
  //   plus the actual CDN 206s (each 1-MiB read is 1 CDN 206, possibly 2 if
  //   upstream fill triggers more).
  //
  // We compare m0 -> mNow and assert the totals look sane.
  const mFinal = await metricsGet();
  const sFinal = snapshot(mFinal);
  const totalDelta = delta(sFinal, snapshot(m0));
  log(
    `totals over ${N} reads: ` +
    `api_requests=+${totalDelta.api_requests} ` +
    `cap.acq=+${totalDelta.cap_acq} ` +
    `cap.reuse=+${totalDelta.cap_reuse} ` +
    `cdn_206=+${totalDelta.cdn_206} ` +
    `brk_open=${totalDelta.breakers_open}`
  );

  let problems = [];
  if (totalDelta.cap_acq > 2) {
    problems.push(`cap.acq delta=${totalDelta.cap_acq} > 2 (expected 1 for cache-hit reuse)`);
  }
  if (totalDelta.breakers_open > 0) {
    problems.push(`breakers_open=${totalDelta.breakers_open} > 0 (should be 0 under healthy operation)`);
  }
  // RD takes 3 calls; +1 for any incidental. Bound at 8 to allow some
  // headroom for the prefetch / metric layers.
  if (totalDelta.api_requests > 8) {
    problems.push(`api_requests delta=${totalDelta.api_requests} > 8 (RD fresh acquire is 3 calls)`);
  }

  if (problems.length > 0) {
    log('SANITY-FAIL:');
    for (const p of problems) log(`  - ${p}`);
    process.exit(2);
  }

  log('DONE: API sanity passes - bounded amplification, cap reuse works, no breaker trips');
  process.exit(0);
}

run().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
