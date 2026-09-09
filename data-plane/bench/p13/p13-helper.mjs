// p13-helper.mjs - shared utilities for P13 dual-provider byte graduation.
//
// P13 RESUME brief, step 1: identity is FROZEN at
//   tfId      = tf_5de34a78-0a1a-410b-8de5-76ded2680e7d
//   infoHash  = 06bfe49fdc99ad0c6fef1f761382a8181490e456
//   size      = 34319716114 (34.3 GB)
// Providers (from S-1):
//   torbox       placement 88408468
//   realdebrid   placement 5VFSK7HKPITZW
//
// Helpers in this module:
//   FROZEN       - the frozen identity
//   rangeFetch   - GET /files/:tfId with Range header, returns {status, headers, body, ttfbMs, bytes, sha256}
//   metricsGet   - GET /metrics
//   snapshot     - flat counter snapshot from /metrics
//   delta        - counter diff between two snapshots
//   providerFromProvidersHeader - parse "X-Capability-Provider" or "X-Provider-Used" header
//   waitForHealthy - poll /metrics until it returns a number
//   logHeader     - log tag formatter

import http from 'node:http';
import crypto from 'node:crypto';

export const FROZEN = Object.freeze({
  tfId: 'tf_5de34a78-0a1a-410b-8de5-76ded2680e7d',
  infoHash: '06bfe49fdc99ad0c6fef1f761382a8181490e456',
  size: 34319716114,
  canonicalPath:
    'Black.Panther.2018.2160p...RIFE.4.18-60fps-DirtyHippie/Black.Panther.2018.2160p...RIFE.4.18-60fps-DirtyHippie.mkv',
  providers: Object.freeze({
    torbox: { placement: '88408468', label: 'torbox' },
    realdebrid: { placement: '5VFSK7HKPITZW', label: 'realdebrid' },
  }),
});

const DP_DEFAULT = 'http://127.0.0.1:3011';

export function rangeFetch(tfId, start, end, opts = {}) {
  const DP = opts.DP || process.env.DP_URL || DP_DEFAULT;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const u = new URL(DP);
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port || 80),
        path: `/files/${encodeURIComponent(tfId)}`,
        method: 'GET',
        headers: { Range: `bytes=${start}-${end}` },
      },
      (res) => {
        const buf = [];
        let bytes = 0;
        res.on('data', (c) => { buf.push(c); bytes += c.length; });
        res.on('end', () => {
          const body = Buffer.concat(buf);
          // Common provider-attribution header (set by the Rust data plane).
          // We also check server headers for X-Cache / X-Provider for forensics.
          const headers = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
          resolve({
            status: res.statusCode,
            headers,
            body,
            ttfbMs: Date.now() - t0,
            bytes,
            sha256: crypto.createHash('sha256').update(body).digest('hex'),
            range: { start, end, len: end - start + 1 },
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

export function metricsGet(opts = {}) {
  const DP = opts.DP || process.env.DP_URL || DP_DEFAULT;
  return new Promise((resolve, reject) => {
    http
      .get(DP + '/metrics', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

export function snapshot(m) {
  return {
    bytes_requested_total: m?.cache?.bytes_requested_total || 0,
    bytes_upstream_issued: m?.cache?.bytes_upstream_issued || 0,
    bytes_local: m?.cache?.bytes_local || 0,
    chunk_claims: m?.cache?.chunk_claims || 0,
    chunks_present: m?.cache?.chunks_present || 0,
    api_requests: m?.layer_A_api?.requests || 0,
    cdn_206: m?.layer_C_cdn?.['206'] || 0,
    cdn_416: m?.layer_C_cdn?.['416'] || 0,
    cap_acq: m?.capability?.acquisitions || 0,
    cap_reuse: m?.capability?.reuses || 0,
    breakers_open: m?.capability?.breakers_open || 0,
    pf_trig: m?.playback_intelligence?.prefetch_triggered || 0,
    pf_comp: m?.playback_intelligence?.prefetch_chunks_completed || 0,
    pf_served: m?.playback_intelligence?.prefetch_served_demand || 0,
    seek_repri: m?.playback_intelligence?.seek_reprioritizations || 0,
  };
}

export function delta(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = a[k] - b[k];
  return out;
}

export function providerFromHeaders(headers) {
  // The Rust data plane does not currently emit an X-Provider-Used header;
  // provider attribution has to be derived from capability + breaker state
  // in /metrics, or by HY4_FORCE_PROVIDER env. We return a placeholder.
  return headers['x-provider-used'] || headers['x-capability-provider'] || null;
}

export async function waitForHealthy(deadlineMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const m = await metricsGet();
      if (m && m.layer_A_api !== undefined) return m;
    } catch (e) { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Rust data plane not healthy after ${deadlineMs}ms`);
}

export function nowLabel() {
  return new Date().toISOString().replace('T', ' ').replace('Z', 'Z');
}

export function log(line) {
  process.stderr.write(`[p13 ${nowLabel()}] ${line}\n`);
}

// Format a snapshot delta as a compact one-line summary.
export function fmtDelta(d) {
  return (
    `bytes_req=+${d.bytes_requested_total} ` +
    `bytes_up=+${d.bytes_upstream_issued} ` +
    `bytes_local=+${d.bytes_local} ` +
    `cdn_206=+${d.cdn_206} ` +
    `cdn_416=+${d.cdn_416} ` +
    `api=+${d.api_requests} ` +
    `cap.acq=+${d.cap_acq} ` +
    `cap.reuse=+${d.cap_reuse} ` +
    `brk_open=${d.breakers_open} ` +
    `pf=${d.pf_trig}/${d.pf_comp}/${d.pf_served}`
  );
}
