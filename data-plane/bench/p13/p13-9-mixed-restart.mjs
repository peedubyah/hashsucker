// p13-9-mixed-restart.mjs - P13 step 9: mixed provider + restart.
//
// What this script proves:
//   The HY4_FORCE_PROVIDER gate is hot-reloadable across container
//   restarts. The same range (and same SHA256 when the underlying
//   provider can serve it) is observable across three different
//   gate configurations in sequence:
//     1. TB-only
//     2. dual (TB+RD)
//     3. RD-only
//   At each step, the S-1 listDataPlaneCoordinates is re-fetched from
//   the durable store and the gate is re-applied. The Slice 4 cache
//   volume is preserved, so cached bytes are still served from disk
//   when the gate allows the provider that originally filled them.
//
// The wrapper script (p13-9-driver.sh) cycles the container through
// the three gate modes; this script just exercises the range reads
// and reports SHA stability.

import {
  FROZEN,
  rangeFetch,
  metricsGet,
  log,
} from './p13-helper.mjs';

const TFID = process.env.TFID || FROZEN.tfId;
const DP = process.env.DP || 'http://127.0.0.1:3013';
const PHASE = process.env.PHASE || 'unknown';

const RANGES = [
  { name: 'front-1MiB', start: 0, end: 1024 * 1024 - 1 },
  { name: 'mid-1MiB',   start: 10 * 1024 * 1024, end: 10 * 1024 * 1024 + 1024 * 1024 - 1 },
  { name: 'tail-1MiB',  start: FROZEN.size - 1024 * 1024, end: FROZEN.size - 1 },
];

async function main() {
  log(`PHASE=${PHASE} TFID=${TFID} DP=${DP}`);
  for (const r of RANGES) {
    const res = await rangeFetch(TFID, r.start, r.end, { DP });
    log(`  ${r.name} status=${res.status} bytes=${res.bytes} sha=${res.sha256.slice(0, 12)}`);
  }
  const m = await metricsGet({ DP });
  log(`  metrics: chunks_present=${m.cache?.chunks_present} cap.acq=${m.capability?.acquisitions} cap.reuse=${m.capability?.reuses} brk_open=${m.breaker_opens} all_same_tf=${m.all_same_tf}`);
  log('DONE');
  process.exit(0);
}

main().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
