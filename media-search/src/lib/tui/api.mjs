/**
 * HashSucker operator API client for the TUI (and any future terminal
 * tooling). Thin fetch wrappers over the same read-mostly endpoints the
 * web UI uses — no business logic duplicated here.
 */
const BASE = (process.env.HASHSUCKER_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

/** Readiness reports 503 with a JSON body when not ready — still payload. */
async function getLenient(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  try {
    return await res.json();
  } catch {
    throw new Error(`${res.status} ${path}`);
  }
}

export const api = {
  base: BASE,
  health: () => get('/health'),
  ready: () => getLenient('/health/ready'),
  diagnostics: () => get('/api/diagnostics'),
  activity: (limit = 30) => get(`/api/operator/activity?limit=${limit}`),
  library: (limit = 100) => get(`/api/library?limit=${limit}`),
  quality: (tfs) => get(`/api/operator/quality?tfs=${tfs.join(',')}`),
  downloads: (limit = 50) => get(`/api/operator/downloads?limit=${limit}`),
  failedEvents: (limit = 20) => get(`/api/operator/events/failed?limit=${limit}`),
  workers: () => get('/api/operator/workers'),
  enrichment: () => get('/api/operator/enrichment'),
  hygiene: () => get('/api/operator/hygiene'),
};

export function bytes(n) {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n}`;
}

export function ago(ts) {
  if (ts == null) return '—';
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
