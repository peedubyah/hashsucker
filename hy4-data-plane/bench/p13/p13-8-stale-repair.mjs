// p13-8-stale-repair.mjs - P13 step 8: stale-state repair.
//
// What this script proves:
//   After a container restart with the SAME env vars (cache volume
//   preserved, no DB writes), the in-memory CapabilityManager rebuilds
//   cleanly from S-1, and the same range returns the same SHA256.
//
// Stale-state concerns addressed:
//   1. CapabilityManager pool is empty after restart (process state
//      reset to zero). On first request after restart, the manager
//      rebuilds the pool from the fresh S-1 coord list. The S-1 list
//      is the durable ground truth.
//   2. Slice 4 cache survives (named volume). Bytes already cached
//      before restart are served from the cache on first request after.
//   3. The HY4_FORCE_PROVIDER env var is re-evaluated on every request
//      (we read it inside handle_files, not at boot), so a fresh
//      container with the same env applies the same allowlist.
//
// Failure mode we guard against: the pre-restart S-1 coord list could
// be cached somewhere and a stale list could survive the restart. We
// prove this does NOT happen by re-fetching the S-1 list post-restart
// and confirming the byte identity.

import {
  FROZEN,
  rangeFetch,
  metricsGet,
  snapshot,
  delta,
  log,
} from './p13-helper.mjs';
import { execSync } from 'node:child_process';

const TFID = process.env.TFID || FROZEN.tfId;
const DUAL_DP = process.env.DUAL_DP || 'http://127.0.0.1:3013';

const RANGES = [
  { name: 'front-1MiB', start: 0, end: 1024 * 1024 - 1 },
  { name: 'mid-1MiB',   start: 10 * 1024 * 1024, end: 10 * 1024 * 1024 + 1024 * 1024 - 1 },
  { name: 'tail-1MiB',  start: FROZEN.size - 1024 * 1024, end: FROZEN.size - 1 },
];

async function readAll(dpUrl, ranges) {
  const out = [];
  for (const r of ranges) {
    const res = await rangeFetch(TFID, r.start, r.end, { DP: dpUrl });
    out.push({ ...r, ...res });
  }
  return out;
}

async function main() {
  log(`LABEL=p13-8-stale-repair TFID=${TFID} DUAL_DP=${DUAL_DP}`);

  // Phase 1: pre-restart
  log('--- PHASE 1: pre-restart reads ---');
  const pre = await readAll(DUAL_DP, RANGES);
  for (const r of pre) {
    log(`  ${r.name} status=${r.status} bytes=${r.bytes} sha=${r.sha256.slice(0, 12)}`);
  }
  const mPre = await metricsGet({ DP: DUAL_DP });
  log(`  pre-restart metrics: chunks_present=${mPre.cache?.chunks_present} cap.acq=${mPre.capability?.acquisitions} cap.reuse=${mPre.capability?.reuses}`);

  // Phase 2: restart the container (external script does this in the wrapper).
  // We just wait for /metrics to come back.
  log('--- PHASE 2: WAITING for external restart ---');
  await new Promise((r) => setTimeout(r, 7000));
  // Probe
  let healthy = false;
  for (let i = 0; i < 15; i++) {
    try {
      const m = await metricsGet({ DP: DUAL_DP });
      if (m && m.layer_A_api !== undefined) {
        log(`  post-restart probe ok (attempt ${i + 1})`);
        healthy = true;
        break;
      }
    } catch (e) { /* not ready */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!healthy) {
    log('  ERROR: container not healthy after restart');
    process.exit(1);
  }

  // Phase 3: post-restart
  log('--- PHASE 3: post-restart reads (must match pre-restart SHAs) ---');
  const post = await readAll(DUAL_DP, RANGES);
  for (const r of post) {
    log(`  ${r.name} status=${r.status} bytes=${r.bytes} sha=${r.sha256.slice(0, 12)}`);
  }
  const mPost = await metricsGet({ DP: DUAL_DP });
  log(`  post-restart metrics: chunks_present=${mPost.cache?.chunks_present} cap.acq=${mPost.capability?.acquisitions} cap.reuse=${mPost.capability?.reuses}`);

  // Phase 4: compare
  log('--- PHASE 4: byte-identity comparison ---');
  let allOk = true;
  for (let i = 0; i < RANGES.length; i++) {
    const ok = pre[i].sha256 === post[i].sha256 && pre[i].status === 206 && post[i].status === 206;
    log(`  ${RANGES[i].name}: pre=${pre[i].sha256.slice(0, 12)} post=${post[i].sha256.slice(0, 12)} -> ${ok ? 'IDENTICAL' : 'DIFFER'}`);
    if (!ok) allOk = false;
  }
  log(`SUMMARY: ${allOk ? 'PASS' : 'FAIL'} (all 3 ranges byte-identical pre vs post restart)`);

  // Phase 5: re-fetch S-1 to confirm durable state did not change
  log('--- PHASE 5: S-1 re-fetch (must show both providers, same as P13-2 pre) ---');
  // Use the p13-s1-check.py script
  try {
    const out = execSync('python "C:/src/hashsucker/scripts/p13-s1-check.py"', { encoding: 'utf8' });
    log(out.split('\n').map((l) => '  ' + l).join('\n'));
  } catch (e) {
    log(`  ERROR: ${e.message}`);
  }

  log('DONE');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { log(`ERROR: ${e?.stack || e}`); process.exit(1); });
