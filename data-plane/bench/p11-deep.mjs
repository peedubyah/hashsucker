// p11-deep - P11 deep metrics diff
import http from 'node:http';

const DP = process.env.DP_URL || 'http://127.0.0.1:3009';

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(`${DP}${path}`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const m = await getJSON('/metrics');
  // print all interesting counters
  const show = (path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), m);
    if (v !== undefined) console.log(`${path} = ${v}`);
  };
  for (const p of [
    'cache.bytes_upstream_issued',
    'cache.bytes_fetched_upstream',
    'cache.bytes_upstream',
    'cache.chunk_overfetch_bytes',
    'cache.chunk_claims',
    'cache.chunk_join_waits',
    'cache.inflight_joins',
    'cache.chunks_present',
    'cache.fetch_spans',
    'cache.spans_collapsed_chunks',
    'cache.gap_join_full_miss',
    'cache.gap_join_partial_hit',
    'layer_A_api.requests',
    'layer_C_cdn.requests',
    'layer_C_cdn.206',
    'capability.acquisitions',
    'capability.reuses',
    'capability.reacquisitions',
    'recovery.attempts',
    'playback_intelligence.prefetch_triggered',
    'playback_intelligence.prefetch_chunks_requested',
    'playback_intelligence.prefetch_chunks_completed',
    'playback_intelligence.prefetch_chunks_skipped_present',
    'playback_intelligence.prefetch_joined_inflight',
    'playback_intelligence.prefetch_failures',
    'playback_intelligence.prefetch_served_demand',
    'playback_intelligence.prefetch_joined_by_demand',
    'playback_intelligence.spare_capacity',
    'playback_intelligence.auto_selected_wait',
    'playback_intelligence.auto_selected_try',
  ]) show(p);
}
main().catch((e) => { console.error(e); process.exit(1); });
