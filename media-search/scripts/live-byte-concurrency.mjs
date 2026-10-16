/**
 * Live cached-byte-route concurrency probe.
 *
 * Three concurrent readers of the SAME chunk through the real
 * `/bytes/:tfId` route must produce exactly ONE provider pull, proven by the
 * data plane's own counters (chunk fills vs in-flight joins) rather than by
 * timing.
 *
 * Usage: node scripts/live-byte-concurrency.mjs <tfId> [readers]
 */

import { execFileSync } from 'node:child_process';

const tfId = process.argv[2];
const readers = Number(process.argv[3] ?? '3');
const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const dataPlane = process.env.DATA_PLANE_URL ?? 'http://data-plane:3001';

const snap = async () => {
  const res = await fetch(`${dataPlane}/metrics`);
  const d = await res.json();
  return {
    cdn_requests: d.layer_C_cdn?.requests ?? 0,
    upstream_bytes: d.cache?.bytes_upstream ?? 0,
    fills: d.cache?.chunk_fills ?? 0,
    fills_failed: d.cache?.chunk_fills_failed ?? 0,
    inflight_joins: d.cache?.inflight_joins ?? 0,
    join_waiters: d.cache?.inflight_joiners ?? 0,
    api_calls: d.layer_A_api?.requests ?? 0,
    provider_failovers: d.failovers_total ?? 0,
    all_same_tf: d.all_same_tf ?? 0,
    client_truncated: d.recovery?.client_truncated ?? 0,
    misses: d.cache?.misses ?? 0,
  };
};

const offset = Number(process.argv[4] ?? 8_000_000_000);
const before = await snap();
const started = Date.now();
const results = await Promise.all(
  Array.from({ length: readers }, () => fetch(`${base}/bytes/${encodeURIComponent(tfId)}`, {
    headers: { range: `bytes=${offset}-${offset + 99_999}` },
  }).then((r) => r.arrayBuffer().then((b) => ({ status: r.status, len: b.byteLength, body: Buffer.from(b) })))),
);
const elapsed = Date.now() - started;
const after = await snap();
const allSame = new Set(results.map((r) => r.body.toString('hex'))).size === 1;

console.log(`readers: ${results.map((r) => `${r.status}/${r.len}`).join(' ')} in ${elapsed}ms`);
console.log(`identical bytes across readers: ${allSame}`);
for (const key of Object.keys(before)) {
  const delta = after[key] - before[key];
  console.log(`  ${key}=${delta}`);
}
const served = results.filter((r) => r.status === 206 && r.len === 100_000).length;
console.log(`served complete: ${served}/${readers}`);
console.log(`provider pulls for the shared chunk: ${after.fills - before.fills}`);
console.log(`joins (waiters on one fill): ${after.inflight_joins - before.inflight_joins}`);
void execFileSync;
