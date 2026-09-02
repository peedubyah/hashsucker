/**
 * Plex Notifier
 *
 * Asks Plex to partial-scan the VFS path of a newly fulfilled item, so the
 * library picks up the file that Hashsucker's WebDAV server has just
 * materialized under `/vfs/Movies/...` and `/vfs/TV/...`.
 *
 * Configuration: PLEX_URL, PLEX_TOKEN, section IDs, and Plex-visible roots.
 * Failure is non-fatal to fulfillment.
 *
 * Refresh coalescing:
 *   notifyPlex() defers the actual HTTP call to a process-local keyed
 *   debouncer (createRefreshCoalescer). Multiple calls that resolve to
 *   the same (collection, sectionId, scanPath) within a short bounded
 *   window produce exactly ONE Plex partial-refresh. Different paths
 *   and different libraries never coalesce with each other.
 *
 *   A failed/timeout refresh NEVER escalates to a full-section scan.
 *   The operator must request that explicitly.
 *
 * The Plex token is treated as a secret. It is read from process.env
 * (configured via .env), sent as a header, and never written to logs,
 * metrics, or the response payload.
 */

import path from 'node:path';

import { createRefreshCoalescer, REFRESH_DEFAULTS } from '../plex/refresh-coalescer.js';

const PLEX_TIMEOUT_MS = 5_000;

function configFor(mediaType) {
  if (mediaType === 'movie') {
    return {
      sectionId: process.env.PLEX_MOVIES_SECTION_ID,
      root: process.env.PLEX_MOVIES_ROOT,
      collection: 'Movies',
    };
  }
  if (mediaType === 'series' || mediaType === 'tv') {
    return {
      sectionId: process.env.PLEX_TV_SECTION_ID,
      root: process.env.PLEX_TV_ROOT,
      collection: 'TV',
    };
  }
  return { sectionId: null, root: null, collection: null };
}

export function isPlexEnabled() {
  return Boolean(process.env.PLEX_URL && process.env.PLEX_TOKEN);
}

/**
 * Compute the scan path the notifier would dispatch a refresh for.
 * Pure / side-effect-free, exposed for tests and operator tooling.
 *
 * Returns { ok: true, sectionId, scanPath, collection } on success.
 * Returns { ok: false, error } if the inputs do not yield a safe,
 * targeted path. The caller MUST surface the error rather than
 * falling back to a full-section scan.
 */
export function planPlexRefresh({ mediaType, canonicalPath }) {
  if (!isPlexEnabled()) {
    return { ok: false, error: 'plex-disabled' };
  }
  const { sectionId, root, collection } = configFor(mediaType);
  if (!sectionId || !root || !canonicalPath) {
    return { ok: false, error: 'missing-section-root-or-path' };
  }
  const segments = canonicalPath.split('/');
  if (path.posix.isAbsolute(canonicalPath)
    || !path.posix.isAbsolute(root)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
    || segments[0] !== collection
    || segments.length < 3) {
    return { ok: false, error: 'invalid-canonical-path' };
  }
  const scanPath = path.posix.join(root, ...segments.slice(1, -1));
  return { ok: true, sectionId, scanPath, collection };
}

// ── Coalescer wiring ────────────────────────────────────────────────────────

let coalescerSingleton = null;
let metricsSink = null;

function getCoalescer() {
  if (coalescerSingleton) return coalescerSingleton;
  coalescerSingleton = createRefreshCoalescer({
    windowMs: REFRESH_DEFAULTS.windowMs,
    fetchTimeoutMs: PLEX_TIMEOUT_MS,
    dispatch: performPlexRefresh,
    onAccount: (snap) => {
      if (metricsSink) {
        try { metricsSink(snap); } catch { /* ignore */ }
      }
    },
  });
  return coalescerSingleton;
}

/**
 * Test/diagnostic injection point. Allows callers to swap the
 * coalescer (e.g. for a deterministic clock in tests). Returns the
 * previous instance so it can be restored.
 */
export function _setCoalescerForTests(replacement) {
  const previous = coalescerSingleton;
  coalescerSingleton = replacement;
  return previous;
}

/**
 * Wire the coalescer's accounting into the live metrics module so the
 * /api/metrics endpoint exposes the Plex refresh counters.
 */
export function bindPlexMetricsSink(fn) {
  metricsSink = typeof fn === 'function' ? fn : null;
  return () => { if (metricsSink === fn) metricsSink = null; };
}

export function getPlexRefreshAccount() {
  return getCoalescer().getAccount();
}

export function resetPlexRefreshAccount() {
  getCoalescer().resetAccount();
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

async function performPlexRefresh({ sectionId, scanPath, collection, mediaId, mediaType }) {
  if (!isPlexEnabled()) {
    return { ok: false, error: 'plex-disabled' };
  }
  if (!sectionId || !scanPath) {
    // Defensive: the coalescer should never call us without a key,
    // but if it does, refuse rather than fall back to full-section.
    return { ok: false, error: 'missing-section-or-path' };
  }
  const baseUrl = process.env.PLEX_URL.replace(/\/$/, '');
  const url = `${baseUrl}/library/sections/${sectionId}/refresh?path=${encodeURIComponent(scanPath)}`;
  console.log(`[Plex] partial-refresh dispatch section=${sectionId} path=${scanPath} media=${mediaId || '?'} type=${mediaType || '?'}`);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Plex-Token': process.env.PLEX_TOKEN,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(PLEX_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, method: 'partial-refresh', error: `plex-http-${response.status}` };
    }
    return { ok: true, method: 'partial-refresh' };
  } catch (err) {
    return { ok: false, method: 'partial-refresh', error: err?.message || 'fetch-failed' };
  }
}

/**
 * Notify Plex of a newly published file.
 *
 * Returns:
 *   { notified: true,  method, coalesced }    on a successful or coalesced refresh
 *   { notified: false, method: null, error } on a no-op or failure
 *
 * PLAYBACK paths (WebDAV / Part / FUSE / direct play / transcode) MUST
 * NOT call this. Refresh is publication-driven only.
 */
export async function notifyPlex({ mediaId, mediaType, canonicalPath }) {
  if (!isPlexEnabled()) {
    return { notified: false, method: null, error: null };
  }

  const plan = planPlexRefresh({ mediaType, canonicalPath });
  if (!plan.ok) {
    // Refuse to silently escalate. Surface the error so the operator
    // can decide whether to request a full-section scan explicitly.
    console.error(`[Plex] refresh refused for ${mediaId || '?'}: ${plan.error}`);
    return { notified: false, method: null, error: plan.error };
  }

  const coalescer = getCoalescer();
  const { coalesced, result } = coalescer.schedule({
    sectionId: plan.sectionId,
    scanPath: plan.scanPath,
    collection: plan.collection,
    mediaId,
    mediaType,
  });
  const settled = await result;
  if (coalesced) {
    return {
      notified: settled.ok === true,
      method: settled.method,
      coalesced: true,
      error: settled.ok ? null : (settled.error || 'coalesced-failed'),
    };
  }
  if (settled.ok) {
    return { notified: true, method: settled.method, coalesced: false, error: null };
  }
  return { notified: false, method: settled.method, error: settled.error || 'refresh-failed' };
}
