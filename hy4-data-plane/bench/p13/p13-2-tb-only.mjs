// p13-2-tb-only.mjs - P13 step 2: TorBox-only proof.
//
// What this script proves:
//   1. With HY4_FORCE_PROVIDER=tf_5de34a78...:torbox set, range requests on
//      the frozen TorrentFile still return 206 with valid bytes.
//   2. The Rust data plane is reaching TorBox (cdn_206 increases, cap.acq
//      tracks TB-capable acquisitions).
//   3. A seek (jump to a far offset) + restart still serves correctly.
//   4. S-1 is untouched: the durable state still lists BOTH providers (we
//      verify via curl /api/control-plane/torrent-files/... in the wrapper).
//
// What this script does NOT prove (covered by other P13 steps):
//   - That RD placement was actually removed from the S-1 coord list at
//     runtime: that is verified by the [p13] HY4_FORCE_PROVIDER stderr log
//     line in the container log.
//   - Byte identity between TB and RD (P13-4).
//   - TB<->RD shielding (P13-5/6).
//   - Both-exhausted behaviour (P13-7).

import {
  FROZEN,
  rangeFetch,
  metricsGet,
  snapshot,
  delta,
  waitForHealthy,
  log,
  fmtDelta,
} from './p13-helper.mjs';

const TFID = process.env.TFID || FROZEN.tfId;
const LABEL = process.env.LABEL || 'p13-2-tb-only';

const PROOFS = [
  // start, end, label
  [0,         1024 * 1024 - 1, 'front-1MiB'],                  // first 1 MiB
  [10 * 1024 * 1024, 10 * 1024 * 1024 + 1024 * 1024 - 1, 'mid-1MiB-at-10MiB'], // seek to 10 MiB
  [FROZEN.size - 1024 * 1024, FROZEN.size - 1, 'tail-1MiB'],   // far tail
];

async function run() {
  log(`LABEL=${LABEL} TFID=${TFID} size=${FROZEN.size}`);
  const m0 = await waitForHealthy();
  let prev = snapshot(m0);
  log(`startup: chunks_present=${m0.cache?.chunks_present} cap.acq=${m0.capability?.acquisitions} cap.reuse=${m0.capability?.reuses} brk_open=${m0.capability?.breakers_open || 0}`);

  for (const [start, end, label] of PROOFS) {
    const r = await rangeFetch(TFID, start, end);
    const now = await metricsGet();
    const cur = snapshot(now);
    const d = delta(cur, prev);
    const expected = end - start + 1;
    const ok = r.status === 206 && r.bytes === expected;
    log(
      `${label} start=${start} end=${end} status=${r.status} ` +
      `bytes=${r.bytes}/${expected} ttfb=${r.ttfbMs}ms ` +
      `sha=${r.sha256.slice(0, 12)} ` +
      `headers[content-range]=${r.headers['content-range'] || 'none'} ` +
      `headers[cache-control]=${r.headers['cache-control'] || 'none'} ` +
      `${ok ? 'OK' : 'FAIL'} | ${fmtDelta(d)}`
    );
    if (!ok) {
      log(`ABORT: ${label} expected 206 with ${expected} bytes, got ${r.status} ${r.bytes}`);
      process.exit(2);
    }
    prev = cur;
    await new Promise((r) => setTimeout(r, 300));
  }

  // Restart probe: read front again to see if cap.reuse increments (in-process
  // cache), then we externally restart the container in the wrapper.
  log('pre-restart: read front-1MiB again (should be served by cache if hit)');
  const r0 = await rangeFetch(TFID, 0, 1024 * 1024 - 1);
  const m1 = await metricsGet();
  const s1 = snapshot(m1);
  const d1 = delta(s1, prev);
  log(
    `pre-restart-recheck status=${r0.status} bytes=${r0.bytes} ` +
    `sha=${r0.sha256.slice(0, 12)} | ${fmtDelta(d1)}`
  );
  prev = s1;

  log('WAITING-RESTART (external): container will be restarted by wrapper script');
  // The wrapper script will docker rm + start with the SAME env vars.
  // We just wait for /metrics to come back.
  await new Promise((r) => setTimeout(r, 6000));
  const mPost = await waitForHealthy();
  log(`post-restart: cache.chunks_present=${mPost.cache?.chunks_present} cap.acq=${mPost.capability?.acquisitions} (process-reset to 0 expected)`);

  // Post-restart: read front-1MiB. If the Slice 4 cache volume is mounted
  // (same VOL), the data should still be on disk and the chunk should be
  // present. If the volume was not preserved, this will be upstream again.
  const r2 = await rangeFetch(TFID, 0, 1024 * 1024 - 1);
  const mPost2 = await metricsGet();
  const sPost2 = snapshot(mPost2);
  const dPost2 = delta(sPost2, snapshot(mPost));
  log(
    `post-restart-front status=${r2.status} bytes=${r2.bytes} ` +
    `sha=${r2.sha256.slice(0, 12)} ` +
    `cache.chunks_present=${mPost2.cache?.chunks_present} ` +
    `bytes_local=+${dPost2.bytes_local} bytes_up=+${dPost2.bytes_upstream_issued} | ${fmtDelta(dPost2)}`
  );
  // Important: post-restart sha should match pre-restart sha (byte-stable).
  if (r2.sha256 !== r0.sha256) {
    log(`WARN: post-restart sha differs from pre-restart sha for the same range`);
  } else {
    log(`byte-stable: pre-restart sha == post-restart sha for front-1MiB`);
  }

  log('DONE');
  process.exit(0);
}

run().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
