/**
 * Selection-time serviceability probe (execution-quality tranche).
 *
 * Answers one narrow question for a bound candidate, cheaply:
 *
 *   Can this exact authoritative TorrentFile deliver bytes from here right now?
 *
 * Evidence order (cheapest first):
 *   1. recent runtime byte-health (no provider work);
 *   2. a single bounded byte read through the real serve path.
 *
 * It never performs a provider API sweep and never touches durable placement
 * truth. The result feeds the selection gate so a cached-but-dead
 * representation does not win over an executable one.
 */

import { getServiceability, recordServiceable, recordUnserviceable } from './byte-health.js';
import { probeByteReady } from '../anticipation/prewarm.js';

export function createServiceabilityProbe({
  dataPlaneBaseUrl,
  timeoutMs = 10_000,
  probeFn = probeByteReady,
} = {}) {
  return async function serviceabilityProbe(torrentFileId, { provider = null } = {}) {
    if (!torrentFileId) return { serviceable: false, reason: 'no-torrent-file' };
    if (!dataPlaneBaseUrl) return { serviceable: false, reason: 'no-probe-seam' };

    // 1. Recent runtime evidence (no provider work).
    const health = getServiceability(torrentFileId);
    if (health.state === 'serviceable') {
      return { serviceable: true, source: 'health' };
    }
    if (health.state === 'unserviceable' && health.retryInMs > 0) {
      return { serviceable: false, source: 'health', reason: health.reason ?? 'unserviceable' };
    }

    // 2. Bounded real byte probe (half-open when the health window expired).
    let ok = false;
    try {
      ok = await probeFn({ dataPlaneBaseUrl, torrentFileId, timeoutMs });
    } catch {
      ok = false;
    }
    if (ok) {
      recordServiceable(torrentFileId, { provider });
      return { serviceable: true, source: 'probe' };
    }
    recordUnserviceable(torrentFileId, { reason: 'byte-probe-failed', provider });
    return { serviceable: false, source: 'probe', reason: 'byte-probe-failed' };
  };
}
