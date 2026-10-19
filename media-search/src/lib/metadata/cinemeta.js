/**
 * Cinemeta metadata client (public Stremio metadata catalog).
 *
 * This service is OPTIONAL ENRICHMENT. It supplies a clean presentation
 * title/year and an optional title cross-check for identity. It is never
 * authority for a Release, a TorrentFile, a Binding, or a byte.
 *
 * Therefore this module must never be able to:
 *   - hold a request, publication, or playback open indefinitely, and
 *   - re-pay the same failure on every request while it is unavailable.
 *
 * Two mechanisms enforce that:
 *
 *   1. A bounded, ABORTABLE HTTP call. `AbortSignal.timeout` is attached to
 *      the request, so a slow catalog is actually cancelled — the socket is
 *      not left running after the caller has moved on. The budget is
 *      deliberately larger than the observed healthy latency (p50 ~80 ms,
 *      observed slow-but-valid up to ~1.7 s) so a merely slow catalog still
 *      answers, and small enough that a stalled catalog cannot dominate a
 *      request.
 *
 *   2. A short per-lookup FAILURE cache. A failed lookup is remembered
 *      for a bounded window, so an unavailable catalog is not re-paid on
 *      every request. The cache is scoped twice over — by the exact
 *      catalog path AND by the transport that produced the observation —
 *      so one unavailable id can never silence a different id, and a
 *      failure observed on one transport is never replayed on another.
 *      Successful lookups are NOT cached here: a fresh answer is always
 *      allowed, and the callers that need memoization (the request path)
 *      own their own cache.
 *
 * Degradation semantics: every caller already treats a thrown error as
 * "no metadata" and continues with durable/canonical facts. A degraded
 * result is stable afterwards — the published VFS canonical path and the
 * `.strm` path are preserved once written, so a later successful refresh
 * does NOT silently move a published item (moving it would churn the
 * consumer projection). Recovery is therefore: bounded wait, then continue.
 */

const DEFAULT_BASE = 'https://v3-cinemeta.strem.io';

/**
 * Budget for one catalog call. Healthy p50 is ~80 ms; the observed
 * slow-but-valid maximum was ~1.7 s. The budget sits above that so a
 * merely slow catalog still answers, and far below any request-scale
 * timeout so a stalled catalog cannot dominate a request.
 */
export const CINEMETA_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CINEMETA_TIMEOUT_MS ?? 3000);
  return Number.isSafeInteger(raw) && raw >= 100 ? raw : 3000;
})();

/** How long a failed lookup is remembered (so it is not re-paid). */
function failureCacheMs() {
  const raw = Number(process.env.CINEMETA_FAILURE_CACHE_MS ?? 30_000);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 30_000;
}

/**
 * Per-lookup failure cache.
 *
 * Keyed by transport + catalog path: a failure is an observation ABOUT a
 * transport answering a path, so it may only be replayed for the same
 * transport and the same question.
 */
const failureCache = new Map();
const transportIds = new WeakMap();
let nextTransportId = 1;

function transportId(fetchImpl) {
  let id = transportIds.get(fetchImpl);
  if (!id) {
    id = nextTransportId++;
    transportIds.set(fetchImpl, id);
  }
  return id;
}

/** Error carrying the upstream status so callers can tell "not found" apart. */
export class MetadataHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MetadataHttpError';
    this.status = status;
  }
}

function baseUrl() {
  return String(process.env.CINEMETA_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

function now() {
  return Date.now();
}

/** Drop every remembered failure. Test seam. */
export function _resetCinemetaCacheForTests() {
  failureCache.clear();
}

function failureCacheGet(key) {
  const hit = failureCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now()) {
    failureCache.delete(key);
    return null;
  }
  return hit;
}

function failureCacheSet(key, error, ttlMs) {
  if (ttlMs <= 0) return;
  failureCache.set(key, { error, expiresAt: now() + ttlMs });
  if (failureCache.size > 512) {
    const oldest = failureCache.keys().next().value;
    failureCache.delete(oldest);
  }
}

/**
 * One bounded, abortable catalog GET.
 *
 * @param {string} pathname
 * @param {Function} [fetchImpl]
 * @param {{timeoutMs?: number}} [options]
 */
async function getJson(pathname, fetchImpl = fetch, { timeoutMs = CINEMETA_TIMEOUT_MS } = {}) {
  const key = `${transportId(fetchImpl)}:${pathname}`;
  const remembered = failureCacheGet(key);
  if (remembered) throw remembered.error;
  let response;
  try {
    response = await fetchImpl(`${baseUrl()}${pathname}`, {
      headers: { accept: 'application/json', 'user-agent': 'media-search/0.1.0' },
      // Abortable: a stalled catalog is cancelled, not merely abandoned.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Transport error, DNS failure, or our own timeout: a transient
    // failure of an optional service. Remember it briefly so the same
    // lookup is not re-paid on every request.
    failureCacheSet(key, error, failureCacheMs());
    throw error;
  }
  if (!response.ok) {
    const error = new MetadataHttpError(`Metadata service returned HTTP ${response.status}`, response.status);
    // A definitive answer ("this id is not in the catalog") is stable, so
    // it is remembered for the same window as a transient failure; a 5xx is
    // remembered only briefly.
    failureCacheSet(key, error, failureCacheMs());
    throw error;
  }
  return response.json();
}

function publicMeta(meta) {
  // Alias evidence (identity slice): preserve alternate/original titles
  // when the upstream catalog provides them so title matching can accept
  // localized/stylized releases instead of weakened fuzzy containment.
  // Additive — never fetched separately.
  const aliases = Array.isArray(meta?.aliases)
    ? meta.aliases.filter((a) => typeof a === 'string' && a.trim()).slice(0, 12)
    : [];
  return {
    id: meta.id,
    type: meta.type,
    title: meta.name,
    posterUrl: meta.poster || null,
    year: meta.year || meta.releaseInfo || null,
    overview: meta.description || null,
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

export async function searchCatalog(query, fetchImpl = fetch) {
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 120) throw new Error('Search must be 2–120 characters');

  // Check if query is an IMDb ID for direct lookup
  const imdbMatch = q.toLowerCase().match(/^(tt\d+)$/);
  if (imdbMatch) {
    const id = imdbMatch[1];
    // Try movie first, then series
    for (const type of ['movie', 'series']) {
      try {
        const result = await getMedia(type, id, fetchImpl);
        if (result) return [result];
      } catch {
        // Continue to next type
      }
    }
    return [];
  }

  // Text search: use the top catalog search endpoint for each type
  const types = ['series', 'movie'];
  const attempts = await Promise.allSettled(types.map((type) =>
    getJson(`/catalog/${type}/top/search=${encodeURIComponent(q)}.json`, fetchImpl)
  ));
  const payloads = attempts.filter((attempt) => attempt.status === 'fulfilled').map((attempt) => attempt.value);
  if (payloads.length === 0) throw attempts[0].reason;
  const needle = q.toLowerCase();
  const relevance = (meta) => {
    const name = String(meta.name || '').toLowerCase();
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    return 3;
  };
  return payloads.flatMap((payload) => payload.metas || []).map(publicMeta)
    .map((meta, index) => ({ meta, index }))
    .sort((a, b) => relevance(a.meta) - relevance(b.meta) || a.index - b.index)
    .map(({ meta }) => meta)
    .slice(0, 40);
}

export async function getMedia(type, id, fetchImpl = fetch) {
  if (!['series', 'movie'].includes(type)) throw new Error('Invalid media type');
  if (!/^[a-z0-9:_-]+$/i.test(String(id || ''))) throw new Error('Invalid media ID');
  const payload = await getJson(`/meta/${type}/${encodeURIComponent(id)}.json`, fetchImpl);
  if (!payload.meta) return null;
  const media = publicMeta(payload.meta);
  media.videos = type === 'series'
    ? (payload.meta.videos || []).filter((video) =>
        Number.isInteger(video.season) && Number.isInteger(video.episode) && video.episode > 0
      ).map((video) => ({
        id: video.id,
        season: video.season,
        episode: video.episode,
        title: video.title || `Episode ${video.episode}`,
        released: video.released || null,
        thumbnail: video.thumbnail || null,
      }))
    : [];
  return media;
}
