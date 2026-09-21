/**
 * Shared idle gate for background workers (enrichment, hygiene).
 *
 * One quiet notion everywhere: download work pending, recent HUMAN
 * foreground requests, event-loop lag, worker-busy hints, or corpus
 * bootstrap busy defers. Background-generated request rows
 * (anticipation/prepare/upgrade-watch) never count as foreground —
 * otherwise background workers would defer each other forever.
 * All signals runtime-only; nothing durable.
 */

export const BACKGROUND_REQUEST_SOURCES = new Set(['anticipation', 'prepare', 'upgrade-watch']);

function envNumber(env, name, { fallback, min = 0 }) {
  const v = Number(env?.[name]);
  if (!Number.isFinite(v) || v < min) return fallback;
  return v;
}

/** Event-loop lag in ms (runtime-only quiet signal; ~5 lines, no deps). */
export async function measureLoopLag() {
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return Date.now() - start;
}

export function createQuietGate({
  cache,
  downloadStore = null,
  busyHints = null,
  isCorpusBusy = null,
  measureLag = measureLoopLag,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const idleAfterMs = () => envNumber(env, 'IDLE_AFTER_MIN', { fallback: 15, min: 1 }) * 60_000;
  const lagLimitMs = () => envNumber(env, 'IDLE_MAX_LAG_MS', { fallback: 250, min: 10 });

  async function isQuiet() {
    const reasons = [];
    try {
      const claimable = downloadStore?.listClaimable?.(1) ?? [];
      if (claimable.length > 0) reasons.push('download-work-pending');
    } catch { /* store unavailable */ }
    try {
      const reqs = cache?.getMediaRequests?.() ?? [];
      let latest = 0;
      for (const r of reqs) {
        if (BACKGROUND_REQUEST_SOURCES.has(r.source)) continue;
        latest = Math.max(latest, r.created_at ?? 0);
      }
      if (now() - latest < idleAfterMs()) reasons.push('recent-foreground-request');
    } catch { /* requests unavailable */ }
    try {
      const lag = await measureLag();
      if (lag > lagLimitMs()) reasons.push(`event-loop-lag-${lag}ms`);
    } catch { /* lag unmeasurable */ }
    try {
      const hints = busyHints?.() ?? {};
      for (const [k, v] of Object.entries(hints)) {
        if (v) reasons.push(`worker-busy:${k}`);
      }
    } catch { /* hints unavailable */ }
    try {
      if (await isCorpusBusy?.()) reasons.push('corpus-bootstrap-busy');
    } catch { /* corpus state unknown */ }
    return { quiet: reasons.length === 0, reasons };
  }

  return { isQuiet, measureLoopLag };
}
