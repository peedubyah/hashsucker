/**
 * Live byte-route measurement for the cached byte path (Jellyfin surface).
 *
 * Answers the operational questions for STREAM_BYTE_ROUTE=cached:
 *   - does a healthy route serve byte-exact bytes through /bytes/:tfId?
 *   - do concurrent readers of the SAME file share one provider pull?
 *   - how many provider-control (data-plane) requests does each read cost?
 *
 * This drives the real request path (Node /bytes/:tfId → Rust /files/:tfId →
 * provider) against the live control plane. It does not sabotage any provider
 * account; route-loss recovery is proved by the Rust serve-layer harness.
 *
 * Usage (inside the media-search container):
 *   node scripts/live-byte-route-measure.mjs [--file <tfId>] [--readers 3]
 */

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const READERS = Number(argOf('--readers', '3'));

const store = createControlPlaneStore({ dbPath: process.env.CONTROL_PLANE_DB });
const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

const wanted = argOf('--file', null);
let tfId = wanted;
if (!tfId) {
  const row = store.db.prepare(`
    SELECT DISTINCT tf.id AS id
    FROM torrent_files tf
    JOIN bindings b ON b.torrent_file_id = tf.id AND b.status = 'active'
    JOIN provider_files pf ON pf.torrent_file_id = tf.id AND pf.present = 1
      AND pf.mapping_state = 'mapped'
    JOIN provider_placements pl ON pl.id = pf.placement_id AND pl.state <> 'removed'
    WHERE pl.provider = 'torbox'
    ORDER BY tf.size ASC
    LIMIT 1
  `).get();
  tfId = row?.id ?? null;
}
if (!tfId) {
  console.log('no active-bound TorrentFile with a TorBox route');
  process.exit(1);
}

const tf = store.db.prepare('SELECT info_hash, internal_path, size FROM torrent_files WHERE id = ?').get(tfId);
console.log(`torrentFile: ${tfId} size=${tf.size} path=${tf.internal_path?.slice(0, 60)}`);

/** The data plane reports metrics as JSON, not Prometheus text. */
const dataPlaneMetrics = async () => {
  const res = await fetch(`${process.env.DATA_PLANE_URL ?? 'http://data-plane:3001'}/metrics`);
  return res.json();
};

/** Label -> data-plane metrics key (the ones that answer the questions). */
const keys = {
  provider_api_calls: 'layer_A_api_requests',
  cdn_requests: 'layer_C_cdn_2xx',
  fills: 'cache_chunk_fills',
  fills_failed: 'cache_chunk_fills_failed',
  inflight_joins: 'cache_inflight_joins',
  join_waiters: 'cache_inflight_joiners',
  breaker_opens: 'breaker_opens',
  failovers: 'failovers_total',
  all_same_tf: 'all_same_tf',
};

const snap = async () => {
  const m = await dataPlaneMetrics();
  const pick = {};
  for (const [label, key] of Object.entries(keys)) pick[label] = Number(m[key] ?? 0);
  return pick;
};

const readRange = async (start, end) => {
  const started = Date.now();
  const res = await fetch(`${base}/bytes/${encodeURIComponent(tfId)}`, {
    headers: { range: `bytes=${start}-${end}` },
  });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, len: body.length, ms: Date.now() - started, body, headers: res.headers };
};

// ── 1. healthy single read ────────────────────────────────────────────────
const before = await snap();
const one = await readRange(0, 1023);
const afterOne = await snap();
const delta = (a, b) => keys
  .filter((k) => a[k] !== null && b[k] !== null)
  .map((k) => `${k}+${b[k] - a[k]}`)
  .join(' ');
console.log(`single read: status=${one.status} bytes=${one.len} in ${one.ms}ms range=${one.headers.get('content-range')}`);
console.log(`  provider/cache deltas: ${delta(before, afterOne)}`);

// ── 2. same-file concurrency ──────────────────────────────────────────────
const mid = Math.floor(tf.size / 2);
const beforeGroup = await snap();
const started = Date.now();
const readers = await Promise.all(
  Array.from({ length: READERS }, (_, i) => readRange(mid + i * 0, mid + 1023)),
);
const elapsed = Date.now() - started;
const afterGroup = await snap();
const ok = readers.filter((r) => r.status === 206 && r.len === 1024).length;
const identical = new Set(readers.map((r) => r.body.toString('hex'))).size === 1;
console.log(`concurrent readers: ${ok}/${READERS} served 206+1024 in ${elapsed}ms, identical bytes: ${identical}`);
console.log(`  provider/cache deltas: ${delta(beforeGroup, afterGroup)}`);

const final = await snap();
console.log('final data-plane snapshot:', JSON.stringify(final));
store.close();
