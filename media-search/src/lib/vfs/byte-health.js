/**
 * Runtime byte-serviceability registry (hardening tranche).
 *
 * The Lowdown failure exposed a semantic gap: an item could be published,
 * indexed by the consumer, and reported "fulfilled"/"ready" while NO byte route
 * could actually serve it. "Consumer-visible" is not "serviceable".
 *
 * This registry answers one narrow question, from OBSERVED reads only:
 *
 *   Can this exact authoritative TorrentFile produce a real byte response
 *   right now?
 *
 * It is NOT durable truth and NOT identity. It never touches ProviderPlacement,
 * TorrentFile, Binding, or VFS rows. It is process-local, bounded, and driven
 * entirely by the outcome of real VFS reads (and the anticipation byte probe) —
 * there is NO extra provider API probe on any request or read.
 *
 * State per TorrentFile:
 *   serviceable   — the most recent observed read delivered bytes.
 *   unserviceable — the most recent observed read failed at the provider/route
 *                   layer; suppressed (short-circuited) until `until`, then
 *                   half-open (the next read is allowed to try again).
 *   unknown       — never observed (default; never claimed either way).
 *
 * A route failure is suppressed for a bounded, escalating backoff so repeated
 * clients do not hammer a known-bad route, but a single failure never poisons
 * the provider: the window expires, one read probes, and success clears it.
 */

const DEFAULT_BACKOFF_MS = 20_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_ENTRIES = 4096;

/** @type {Map<string, {state:string, reason:string, provider:string|null, failures:number, until:number, observedAt:number}>} */
const registry = new Map();
let logSink = null;

/** Optional structured logger (set by the server). Never throws. */
export function setByteHealthLogger(fn) {
  logSink = typeof fn === 'function' ? fn : null;
}

function logTransition(tfId, entry, prevState) {
  if (!logSink) return;
  try {
    logSink(
      `byte-health tf=${tfId} ${prevState ?? 'unknown'}->${entry.state} `
      + `provider=${entry.provider ?? 'n/a'} reason=${entry.reason} `
      + `failures=${entry.failures} retry_in_ms=${Math.max(0, entry.until - Date.now())}`,
    );
  } catch {
    // Observability must never break the byte path.
  }
}

function evictIfNeeded() {
  if (registry.size <= MAX_ENTRIES) return;
  // Map preserves insertion order; drop the oldest ~10% in one pass.
  const drop = Math.ceil(MAX_ENTRIES * 0.1);
  let i = 0;
  for (const key of registry.keys()) {
    registry.delete(key);
    if (++i >= drop) break;
  }
}

/**
 * Record a successful byte delivery for an exact TorrentFile.
 * Clears any suppression immediately (recovery is automatic and observable).
 */
export function recordServiceable(tfId, { provider = null } = {}) {
  if (!tfId) return;
  const prev = registry.get(tfId);
  const entry = {
    state: 'serviceable',
    reason: 'bytes-observed',
    provider: provider ?? prev?.provider ?? null,
    failures: 0,
    until: 0,
    observedAt: Date.now(),
  };
  registry.set(tfId, entry);
  if (prev?.state !== 'serviceable') logTransition(tfId, entry, prev?.state);
}

/**
 * Record a provider/route byte failure for an exact TorrentFile.
 *
 * @param {string} tfId
 * @param {{ reason?: string, provider?: string|null, retryAfterMs?: number }} [opts]
 */
export function recordUnserviceable(tfId, { reason = 'provider-route-failure', provider = null, retryAfterMs = null } = {}) {
  if (!tfId) return;
  const prev = registry.get(tfId);
  const failures = (prev?.failures ?? 0) + 1;
  const backoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : Math.min(DEFAULT_BACKOFF_MS * 2 ** Math.min(failures - 1, 4), MAX_BACKOFF_MS);
  const entry = {
    state: 'unserviceable',
    reason,
    provider: provider ?? prev?.provider ?? null,
    failures,
    until: Date.now() + backoff,
    observedAt: Date.now(),
  };
  registry.set(tfId, entry);
  evictIfNeeded();
  if (prev?.state !== 'unserviceable') logTransition(tfId, entry, prev?.state);
}

/**
 * Runtime serviceability view for an exact TorrentFile. Never claims more than
 * was observed: an unobserved TorrentFile is `unknown`, not `serviceable`.
 */
export function getServiceability(tfId, nowMs = Date.now()) {
  const entry = tfId ? registry.get(tfId) : null;
  if (!entry) return { state: 'unknown', reason: null, provider: null, retryInMs: null };
  const retryInMs = entry.until > nowMs ? entry.until - nowMs : 0;
  return {
    state: entry.state,
    reason: entry.reason,
    provider: entry.provider,
    failures: entry.failures,
    retryInMs,
  };
}

/** Test-only reset. */
export function __resetByteHealth() {
  registry.clear();
}
