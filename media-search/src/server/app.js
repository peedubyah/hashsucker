import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { toControlPlaneItemDetail, toControlPlaneItemSummary } from '../api/control-plane-dto.js';
import { createReleaseIdentity, toPublicReleaseDto, validateReleaseIdentity } from '../api/release-contract.js';
import { searchByMedia } from '../api/media-request.js';
import { getControlPlaneHealth } from '../lib/control-plane/health.js';
import { planReconciliation } from '../lib/control-plane/reconciler.js';
import {
  readRequest, listAllRequests, moveRequest, purgeRequest,
} from '../lib/operator/index.js';
import { getTraceLog } from '../lib/operator/trace.js';
import { runDiagnostic, listDiagnostics, getSystemHealth } from '../lib/operator/diagnostics.js';
import { checkRequestLifecycleHealth } from '../lib/operator/request-health.js';
import {
  retryFailedRequest,
  resetStuckRequest,
  deleteOrphanedRequest,
} from '../lib/operator/request-actions.js';
import { inspectRequests } from '../lib/operator/request-inspector.js';
import { projectRdZurgLifecycle } from '../lib/control-plane/rd-zurg-slice.js';
import { QueueImporterClient } from '../lib/importer/queue-client.js';
import { getMedia, searchCatalog } from '../lib/metadata/cinemeta.js';
import { searchTitles, getMediaById, getCacheMetrics } from '../lib/metadata/unified-search.js';
import { createHandoff, HANDLING_MODES } from '../lib/requests/handoff.js';
import { createRequestIntent } from '../lib/requests/intent.js';
import { bindPlexMetricsSink, openSeasonFanOutScope } from '../lib/requests/plex-notifier.js';
import { unpublishMedia } from '../lib/library/unpublish.js';
import { listLibrary } from '../lib/library/listing.js';
import { buildDiagnostics } from '../lib/diagnostics/readiness.js';
import { runReconcile } from '../lib/consumers/reconcile.js';
import { evaluateRetirement, readRetirementPolicy } from '../lib/consumers/eligibility.js';
import { setPlexRefreshAccount } from '../lib/metrics.js';
import {
  buildSeerrIntent,
  checkSeerrAuth,
  parseRequestedSeasons,
  resolveSeerrSeasonEpisodes,
} from '../lib/intents/providers/seerr.js';
import { classifySeerrDeferral } from '../lib/defers/seerr-defer.js';
import { createAvailabilityWakeLog } from '../lib/defers/availability-wakes.js';
import { fulfillVirtualSelection } from '../lib/requests/virtual-library.js';
import { searchReleases, combinedSearch, searchTrace, getSearchStats } from '../lib/discovery/search-engine.js';
import { runLiveDiscovery, runLiveDiscoveryWithCounts } from '../lib/discovery/live-bridge.js';
import { formatSearchTrace } from '../lib/discovery/search-trace-formatter.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createSearchDecisionStore, decisionFromTrace } from '../lib/discovery/search-decisions.js';
import { runDMMIngestion } from '../lib/discovery/dmm-ingestion-runner.js';
import { emit, EVENTS } from '../lib/trace/events.js';
import { runAttributeWorker } from '../lib/discovery/attribute-worker.js';
import { resolveProjection, parseIdentityFromParams, ResolverError } from '../lib/resolver/resolver.js';
import { buildMediaSource, SourceError } from '../lib/resolver/source.js';
import { createMediaStream, canTransport, TransportError } from '../lib/resolver/transport.js';
import { liveness, readiness } from '../lib/health.js';
import { getMetrics } from '../lib/metrics.js';
import { getRequestDebug } from '../lib/debug.js';
import { createRequestTiming } from '../lib/requests/timing.js';
import { formatRequestTiming, formatSearchTiming, formatTimingComparison, formatFailedRequest } from '../lib/requests/timing-formatter.js';
import { createWorkerVisibility } from '../lib/operator/worker-visibility.js';
import { formatWorkerStatus } from '../lib/operator/worker-formatter.js';
import { createLifecycleEventStore } from '../lib/operator/event-store.js';
import { formatRequestTimeline, formatRecentRuns, formatFailedRuns } from '../lib/operator/event-formatter.js';
import { getEnrichmentDiagnostics, formatEnrichmentDiagnostics } from '../lib/discovery/enrichment-diagnostics.js';
import { resolveStream, parseMediaIdentity, StreamResolverError } from '../lib/stream-resolver/index.js';
import { resolveTorBoxRedirect, RedirectResolutionError, formatRedirectLog } from '../lib/resolver/torbox-redirect.js';
import { createAlternateFallback, FALLBACK_REASON } from '../lib/resolver/alternate-fallback.js';
import { materializeVfsEntry } from '../lib/vfs/materialize.js';
import { createRevalidator, mapRevalidationToHttp, REVALIDATION_SOURCE, REVALIDATION_OUTCOME } from '../lib/resolver/availability-revalidation.js';
import { createTerminalDeliveryEvidenceStore } from '../lib/resolver/terminal-delivery-evidence.js';
import { checkTorBoxCached } from '../lib/providers/torbox.js';
import { createResolverTelemetry, getRecentResolverTelemetry, RESOLVER_OUTCOME } from '../lib/resolver/telemetry.js';
import { createResolverProfiler } from '../lib/resolver/profiler.js';
import { createTorBoxProvider } from '../lib/providers/torbox.js';
import { createTorBoxInventoryProvider } from '../lib/providers/torbox-inventory.js';
import { buildRequestScopedEnsureFn } from '../lib/requests/scoped-ensure.js';
import { createCorpusLifecycle, corpusUpdateIntervalMs, corpusAutoBootstrap } from '../lib/discovery/corpus-lifecycle.js';
import { createFutureIntentStore, isWantedByArr } from '../lib/anticipation/future-intents.js';
import { createArrClient } from '../lib/anticipation/arr-client.js';
import { createArrSync } from '../lib/anticipation/arr-sync.js';
import { ensureTorBoxDelivery, TorBoxDeliveryError, resolveTorBoxDeliveryWithStaleRecovery } from '../lib/resolver/torbox-delivery.js';
import {
  getTorBoxDownloadUrlCache,
  resolveTorBoxDownloadUrl,
  TorBoxDownloadUrlError,
} from '../lib/resolver/torbox-download-url-cache.js';
import { isUrlLive } from '../lib/resolver/liveness.js';
import { wrapTorBoxDownloadUrlCacheWithAccounting } from '../lib/providers/accounting-cache-wrapper.js';
import { providerAccounting, formatProviderAccounting } from '../lib/providers/provider-accounting.js';
import { discoveryAccounting, formatDiscoveryAccounting } from '../lib/discovery/discovery-accounting.js';
import { createRealDebridClient, RdCooldownError } from '../lib/providers/realdebrid/client.js';
import { attemptRdResolution, getRdPlaybackUrl } from '../lib/providers/realdebrid/resolve.js';
import { createRdEnsure } from '../lib/providers/realdebrid/ensure.js';
import { createPromotionStore, PROMOTION_STATUS } from '../lib/promotion/store.js';
import { resolvePromotionTarget } from '../lib/promotion/resolve.js';
import { resolvePermanentTarget, isWithinRoot } from '../lib/promotion/paths.js';
import { createPromotionWorker } from '../lib/promotion/worker.js';
import { serveLocalFile } from '../lib/promotion/serve-local.js';
import { createDownloadStore } from '../lib/download/store.js';
import { createDownloadResolver } from '../lib/download/resolve.js';
import { createDownloadWorker } from '../lib/download/worker.js';
import { isWithinRoot as isWithinDownloadRoot } from '../lib/download/paths.js';

/**
 * Build a request-scoped Real-Debrid ensure function (RD-only tranche).
 * One createRdEnsure instance per request: its internal memo makes
 * repeated ensure calls for the same infoHash within one request free,
 * and request end drops the memo. Returns null when RD is unavailable
 * so callers fall back to TorBox-only behavior bit-for-bit.
 */
function buildRequestRdEnsureFn({ rdClient, controlPlaneStore, clock = () => Date.now() } = {}) {
  if (!rdClient || !controlPlaneStore) return null;
  try {
    const { ensure } = createRdEnsure({ store: controlPlaneStore, client: rdClient, now: clock });
    return (params) => ensure(params);
  } catch {
    return null;
  }
}

/**
 * Spread-ready RD ensure for searchByMedia calls. Builds one memoized
 * ensure per call site invocation (request-scoped lifetime); empty
 * object when RD is unavailable so TorBox-only behavior is bit-for-bit.
 */
function rdEnsureForRequest({ rdClient, controlPlaneStore, clock = () => Date.now() } = {}) {
  const fn = buildRequestRdEnsureFn({ rdClient, controlPlaneStore, clock });
  return fn ? { ensureRealDebridFileIdentity: fn } : {};
}
import { getRdResolutionCache } from '../lib/providers/realdebrid/rd-resolution-cache.js';
import { createMovieWebDav } from '../lib/vfs/movie-webdav.js';
import { createTvWebDav } from '../lib/vfs/tv-webdav.js';
import { PROVIDER_CAPABILITIES } from '../lib/providers/capabilities.js';
import { createSecondPlacementEnsurer } from '../lib/control-plane/second-placement.js';
import { createPrewarmCaller } from '../lib/control-plane/prewarm.js';
import { createPlaybackRedundancy, isPlaybackRedundancyEnabled } from '../lib/control-plane/playback-redundancy.js';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

// S-1 wire schema version for the Rust data-plane control contract.
//
// Must stay equal to SUPPORTED_SCHEMA_VERSION in the Rust plane. The Rust
// side refuses to start on a mismatch rather than guessing at the payload
// shape, so bumping this without bumping Rust is a deliberate, loud
// breakage -- not a silent drift.
//
// NOTE: the Rust client builds `{controlUrl}/data-plane/files/{id}`, so
// CONTROL_URL must be the /api prefix, e.g.
//   CONTROL_URL=http://media-search:3000/api
const DATA_PLANE_SCHEMA_VERSION = 1;

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/**
 * Provider accounting debug endpoint.
 *
 * GET /api/debug/provider-accounting
 *   → current snapshot, JSON.
 *
 * GET /api/debug/provider-accounting?since=<epochMs>
 *   → delta snapshot vs. the snapshot at `since`. The server keeps no
 *     per-call state; the caller must echo back a previously observed
 *     timestamp. The endpoint is secret-free.
 *
 * GET /api/debug/provider-accounting?format=text
 *   → concise terminal report of TorBox counters. The same fields the
 *     task budget specifies are always rendered, even when zero.
 */
function handleProviderAccountingDebug(response, url) {
  const params = url.searchParams;
  const sinceRaw = params.get('since');
  const format = (params.get('format') || 'json').toLowerCase();
  const provider = (params.get('provider') || 'torbox').toLowerCase();
  const current = providerAccounting.snapshot();
  let body;
  let since = null;
  if (sinceRaw) {
    const parsed = Number(sinceRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return sendJson(response, 400, { error: 'invalid-since', message: 'since must be epoch ms' });
    }
    since = parsed;
    // The accounting registry stores `timestamp` as the snapshot's
    // collection time. The caller-supplied `since` is the timestamp of
    // a prior snapshot they observed. We compute the delta by
    // subtracting the *current* counter values from the *current*
    // counters and clamping zero — since the registry only ever
    // increments. The caller computes their own delta using their
    // previously held `before` counters; this endpoint just emits
    // the current state. The `since` query parameter is therefore
    // an informational hint; the real delta must be computed
    // client-side. We surface a `since` field for the response so
    // the caller can persist it for the next call.
    body = current;
  } else {
    body = current;
  }
  if (format === 'text') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(formatProviderAccounting(body, { title: `${provider} accounting`, provider }));
    return;
  }
  return sendJson(response, 200, { ...body, since });
}

/**
 * Discovery accounting debug endpoint.
 *
 * GET /api/debug/discovery-accounting
 *   → current snapshot, JSON.
 *   Shape: { timestamp, sources: { [name]: { requests, candidates, errors } } }
 *
 * GET /api/debug/discovery-accounting?since=<epochMs>
 *   → informational; the registry is monotonic and the caller
 *     computes the actual delta client-side. (Same contract as
 *     provider-accounting.)
 *
 * GET /api/debug/discovery-accounting?format=text
 *   → compact terminal report.
 *
 * The endpoint is secret-free. Source names are operator-assigned
 * identifiers. No URLs, no API keys, no addon credentials.
 */
function handleDiscoveryAccountingDebug(response, url) {
  const params = url.searchParams;
  const sinceRaw = params.get('since');
  const format = (params.get('format') || 'json').toLowerCase();
  const showAll = params.get('all') === '1' || params.get('all') === 'true';
  const current = discoveryAccounting.snapshot();
  let since = null;
  if (sinceRaw) {
    const parsed = Number(sinceRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return sendJson(response, 400, { error: 'invalid-since', message: 'since must be epoch ms' });
    }
    since = parsed;
  }
  if (format === 'text') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(formatDiscoveryAccounting(current, { title: 'Live Discovery', showAll }));
    return;
  }
  return sendJson(response, 200, { ...current, since });
}

/**
 * Parse HTTP Range header into transport byte options.
 * Supports: bytes=start-end, bytes=start-, bytes=-suffix
 * Returns null if no valid range header present.
 * Throws on malformed ranges.
 */
function parseByteRange(rangeHeader, fileSize) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
  const spec = rangeHeader.slice(6);
  const match = spec.match(/^(\d*)-(\d*)$/);
  if (!match) throw new Error('Malformed Range header');
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') throw new Error('Malformed Range header');
  let start;
  let end;
  if (startStr === '') {
    // suffix range: bytes=-N means last N bytes
    const suffix = parseInt(endStr, 10);
    if (suffix === 0) throw new Error('Zero-length range');
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? fileSize - 1 : parseInt(endStr, 10);
  }
  if (start > end) throw new Error('Invalid range: start > end');
  if (start >= fileSize) throw new Error('Range start exceeds file size');
  end = Math.min(end, fileSize - 1);
  return { start, end };
}

/**
 * Stream media bytes to HTTP response.
 * Pipes Node.js Readable to response with proper backpressure handling.
 * Destroys stream on error to prevent fd leaks.
 */
function sendMediaStream(response, { stream, metadata, status, isRange }) {
  return new Promise((resolve, reject) => {
    const headers = {
      'content-type': metadata.contentType,
      'content-length': metadata.contentLength,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    };
    if (isRange) {
      headers['content-range'] = `bytes ${metadata.byteRange.start}-${metadata.byteRange.end}/${metadata.byteRange.total}`;
    }
    response.writeHead(status, headers);
    let finished = false;
    const cleanup = () => {
      stream.removeListener('error', onError);
      stream.removeListener('end', onEnd);
    };
    const onError = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      }
      stream.destroy();
      reject(err);
    };
    const onEnd = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
    };
    stream.on('error', onError);
    stream.on('end', onEnd);
    stream.pipe(response);
  });
}

/**
 * Map resolver/source/transport errors to HTTP status codes.
 */
function mapMediaError(error) {
  if (error instanceof ResolverError) {
    return { status: error.status, error: error.message };
  }
  if (error instanceof SourceError) {
    const map = {
      'no-binding': 410,
      'no-exposure': 423,
      'null-relative-path': 423,
      'mount-not-configured': 503,
      'path-traversal': 400,
    };
    return { status: map[error.code] || 502, error: error.message };
  }
  if (error instanceof TransportError) {
    const map = {
      'unsupported-transport': 502,
      'missing-path': 502,
      'invalid-path': 400,
      'invalid-source': 400,
      'file-not-found': 404,
      'permission-denied': 403,
      'not-a-file': 502,
      'stat-error': 502,
      'stream-creation-failed': 502,
      'invalid-range': 416,
      'range-out-of-bounds': 416,
    };
    return { status: map[error.code] || 502, error: error.message };
  }
  throw error;
}

/**
 * Handle GET /media/{info_hash}/{file_index} — byte delivery endpoint.
 * Wires identity → projection → source → transport → HTTP response.
 */
async function handleMediaDelivery({ request, response, controlPlaneStore, env }) {
  requireControlPlaneStore(controlPlaneStore);
  const match = request.url.match(/^\/media\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, infoHashParam, fileIndexParam] = match;
  let identity;
  try {
    identity = parseIdentityFromParams(infoHashParam, fileIndexParam);
  } catch (err) {
    if (err instanceof ResolverError) {
      response.writeHead(err.status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: err.message }));
      return true;
    }
    throw err;
  }
  let source;
  try {
    const projection = resolveProjection({
      store: controlPlaneStore,
      infoHash: identity.infoHash,
      fileIndex: identity.fileIndex,
      env,
    });
    source = buildMediaSource({ projection, env });
  } catch (err) {
    const { status, error } = mapMediaError(err);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error }));
    return true;
  }
  // Determine byte range from Range header
  const rangeHeader = request.headers.range;
  let byteRange = null;
  if (rangeHeader) {
    try {
      byteRange = parseByteRange(rangeHeader, source.size || 0);
    } catch (err) {
      response.writeHead(416, {
        'content-type': 'application/json; charset=utf-8',
        'content-range': `bytes */${source.size || 0}`,
      });
      response.end(JSON.stringify({ error: err.message }));
      return true;
    }
  }
  let result;
  try {
    result = createMediaStream(source, byteRange || undefined);
  } catch (err) {
    const { status, error } = mapMediaError(err);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error }));
    return true;
  }
  const isRange = byteRange != null;
  const status = isRange ? 206 : 200;
  await sendMediaStream(response, {
    stream: result.stream,
    metadata: result.metadata,
    status,
    isRange,
  });
  return true;
}

async function sendStatic(response, pathname, staticRoot) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const requestedPath = path.resolve(staticRoot, relativePath);
  const relative = path.relative(staticRoot, requestedPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

  let filePath = requestedPath;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (path.extname(pathname)) return false;
    filePath = path.join(staticRoot, 'index.html');
  }

  try {
    const body = await fs.readFile(filePath);
    const contentType = CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
    const cacheControl = path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    response.writeHead(200, { 'content-type': contentType, 'cache-control': cacheControl });
    response.end(body);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

/**
 * Seerr identity translation at the Seerr ingress boundary.
 *
 * Seerr may report a media identity using only TMDB. The rest of the
 * HashSucker discovery pipeline is keyed on IMDb (and TVDB for series).
 * This helper resolves TMDB → IMDb by calling the Seerr detail endpoint
 * once at the boundary and returns the resolved IMDb; the persisted
 * media_intents row then carries the IMDb form as the operational
 * mediaId, with tmdb_id preserved alongside for traceability.
 *
 * Translation NEVER happens inside the generic discovery pipeline. If
 * a TMDB-only intent arrives without a configured SEERR_URL/API_KEY,
 * the resolver returns `{ ok: false, reason: 'identity-misconfigured' }`
 * and the caller records an explicit identity-unresolved last_error
 * instead of silently feeding `tmdb:*` to an IMDb-keyed search.
 *
 * @param {{ tmdbId: string, mediaType: 'movie'|'series' }} identity
 * @param {{ fetch?: typeof fetch, SEERR_URL?: string, SEERR_API_KEY?: string, logger?: Console }} env
 * @returns {Promise<{ok: true, imdbId: string, canonicalTitle: string|null, releaseDate: string|null} | {ok: false, reason: string, status?: number}>}
 */
async function resolveSeerrIdentity(identity, env = process.env) {
  const tmdbId = String(identity.tmdbId || '').trim();
  if (!/^[0-9]+$/.test(tmdbId)) {
    return { ok: false, reason: 'identity-bad-tmdb' };
  }
  const baseUrl = String(env.SEERR_URL || '').trim();
  const apiKey = String(env.SEERR_API_KEY || '').trim();
  if (!baseUrl || !apiKey) {
    return { ok: false, reason: 'identity-misconfigured' };
  }
  const path = identity.mediaType === 'series' ? 'tv' : 'movie';
  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/v1/${path}/${encodeURIComponent(tmdbId)}`;
  const f = typeof env.fetch === 'function' ? env.fetch : fetch;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const resp = await f(endpoint, {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        Accept: 'application/json',
        'User-Agent': 'hashsucker-seerr-ingress/1.0',
      },
      signal: ac.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, reason: 'identity-unauthorized', status: resp.status };
    }
    if (resp.status === 404) {
      return { ok: false, reason: 'identity-not-found', status: 404 };
    }
    if (!resp.ok) {
      return { ok: false, reason: 'identity-unavailable', status: resp.status };
    }
    let body;
    try {
      body = await resp.json();
    } catch {
      return { ok: false, reason: 'identity-unparseable' };
    }
    if (!body || typeof body !== 'object') {
      return { ok: false, reason: 'identity-unparseable' };
    }
    // Movie detail responses include `imdbId` at the root; TV detail
    // responses do NOT — the IMDb id lives on the nested `externalIds`
    // object (`{ imdbId, tvdbId, ... }`). The nested fallback is
    // considered only for series so movie identity behaviour remains
    // structurally unchanged rather than merely unchanged for the
    // observed movie response shape.
    const externalIds = identity.mediaType === 'series'
      && body && typeof body.externalIds === 'object' && body.externalIds !== null
      ? body.externalIds
      : null;
    const raw = body.imdbId ?? body.imdb_id
      ?? externalIds?.imdbId ?? externalIds?.imdb_id
      ?? null;
    const imdbId = raw == null ? null : String(raw).trim();
    if (!imdbId || !/^tt[0-9]{7,}$/.test(imdbId)) {
      return { ok: false, reason: 'identity-unresolved' };
    }
    // The same Seerr detail response used for TMDB→IMDb resolution also
    // carries canonical title and release date (Seerr MovieDetails: title,
    // originalTitle, releaseDate; TvDetails: name, originalName,
    // firstAirDate). Surface them on the ok result so the caller can
    // thread the canonical title into the search path without a second
    // I/O. Trivially-cheap string normalization only — no schema/storage
    // effects.
    const canonicalTitleRaw =
      body.originalTitle ?? body.original_title ??
      body.originalName ?? body.original_name ??
      body.title ?? body.name ?? null;
    const canonicalTitle = canonicalTitleRaw == null
      ? null
      : String(canonicalTitleRaw).trim() || null;
    const releaseDateRaw =
      body.releaseDate ?? body.release_date ??
      body.firstAirDate ?? body.first_air_date ?? null;
    const releaseDate = releaseDateRaw == null
      ? null
      : String(releaseDateRaw).trim() || null;
    return { ok: true, imdbId, canonicalTitle, releaseDate };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'identity-timeout' : 'identity-unavailable';
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// Exported for testability only; production callers go through
// handleSeerrIngress.
export { resolveSeerrIdentity };

/**
 * Handle a Seerr webhook at the boundary.
 *
 * Flow:
 *   1. Bearer auth via SEERR_WEBHOOK_TOKEN
 *   2. Build intent (pure function, no I/O)
 *   3. Idempotency check on (source, source_id) — exact request_id
 *   4. If TMDB-only and SEERR_URL/API_KEY are configured, resolve to IMDb
 *      once. On unresolved identity, persist a durable intent with
 *      last_error set and return 500 — NOT zero candidates.
 *   5. Persist the durable intent (idempotent on media_id+type+source+season+episode)
 *   6. Invoke the existing single-intent searchByMedia() pipeline. The
 *      intent row is durable; a searchByMedia failure is recorded as
 *      last_error and re-thrown so the caller can decide.
 *
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 * @param {Object} searchCache
 */
async function handleSeerrIngress(
  request,
  response,
  searchCache,
  hydrateVfs = null,
  { controlPlaneStore = null, ensureTorBoxFileIdentityFn = null,
    torBoxProvider = null, torBoxApiKey = null, torBoxApiBase = undefined,
    clock = () => Date.now(), hasExplicitEnsureFn = false,
    futureIntentStore = null, availabilityWakeLog = null, schedulingNudge = null,
    rdClient = null, ensureRealDebridFileIdentity = null } = {},
) {
  // 1. Auth
  const authHeader = request.headers && typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : (request.headers && Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : null);
  const auth = checkSeerrAuth(authHeader, process.env.SEERR_WEBHOOK_TOKEN);
  if (!auth.ok) {
    return sendJson(response, auth.status || 401, { error: 'unauthorized', message: auth.reason });
  }

  // 2. Build intent (pure)
  let body;
  try {
    body = await readBody(request);
  } catch (err) {
    return sendJson(response, 400, { error: 'malformed-body', message: err.message });
  }
  const built = buildSeerrIntent(body);
  if (built.ignored) {
    return sendJson(response, 200, {
      status: 'ignored',
      reason: built.reason,
      notificationType: built.notificationType,
    });
  }
  if (built.error) {
    return sendJson(response, 400, { error: 'malformed-payload', message: built.error });
  }
  const { intent, notificationType } = built;
  const isWithdrawal = built.withdrawal === true;
  const isAvailable = built.available === true;

  // Human cancellation (declined/deleted request): withdraw still-pending
  // deferred rows for this Seerr request id. Passive only — no Seerr API
  // polling, no identity resolution, no provider work. Prepared+ rows and
  // other sources' rows are untouched by construction.
  if (isWithdrawal) {
    const withdrawn = futureIntentStore
      ? futureIntentStore.withdrawSeerrRequest(intent.sourceId, `seerr-withdrawn:${notificationType}`)
      : 0;
    return sendJson(response, 200, {
      status: withdrawn > 0 ? 'withdrawn' : 'withdrawal-nothing-pending',
      notificationType,
      sourceId: intent.sourceId,
      withdrawn,
    });
  }

  // Seerr availability wake-up (availability tranche): MEDIA_AVAILABLE is
  // a scheduling nudge, never fulfillment proof. Matching deferred rows
  // go due-now; the existing scheduler claims them through normal
  // corpus/live discovery and ranking. No Seerr calls, no discovery, no
  // ranking inside the handler — and no second fulfillment pipeline.
  if (isAvailable) {
    const wakeAt = clock();
    let awakened = 0;
    let via = 'none';
    if (futureIntentStore) {
      awakened = futureIntentStore.wakeSeerrRequest(intent.sourceId, wakeAt);
      via = 'request';
      if (awakened === 0) {
        // No row keyed to this request id (re-requested under a new id,
        // or housekeeping event): fall back to exact media identity in
        // every operational form worth trying.
        const forms = [intent.mediaId];
        if (intent.tmdbId) forms.push(`tmdb:${intent.tmdbId}`);
        if (intent.tvdbId) forms.push(`tvdb:${intent.tvdbId}`);
        awakened = futureIntentStore.wakeMedia(forms, wakeAt);
        via = awakened > 0 ? 'identity' : 'none';
      }
    }
    try {
      availabilityWakeLog?.record({
        requestId: intent.sourceId,
        mediaId: intent.mediaId,
        awakened,
        via,
      });
    } catch {}
    // Prompt the scheduler toward an early pass (debounced there) so
    // event→retry starts in seconds. The claim stays authoritative:
    // an already-claimed row cannot be double-driven by this nudge.
    if (awakened > 0) {
      try {
        schedulingNudge?.();
      } catch {}
    }
    return sendJson(response, 200, {
      status: awakened > 0 ? 'woken' : 'availability-no-match',
      notificationType,
      sourceId: intent.sourceId,
      mediaId: intent.mediaId,
      awakened,
      via,
    });
  }

  // 3. Idempotency by Seerr request_id (source_id).
  //    A parent counts as successfully completed/idempotent only when
  //    last_processed_at IS NOT NULL AND last_error IS NULL. If an
  //    earlier attempt created the parent but failed during season
  //    enumeration/fan-out, a subsequent webhook with the same request
  //    ID must be allowed to retry rather than being permanently
  //    poisoned by the parent row.
  //    Household deferred-request tranche: a deferred ("not yet") outcome
  //    is durable intent, not completion. While a non-terminal deferred
  //    row exists for this media, redelivery re-drives the pipeline
  //    (converge faster than the scheduler tick); only short-circuit
  //    when nothing is still pending.
  const existing = searchCache.db.prepare(
    'SELECT id, last_processed_at, last_error FROM media_intents WHERE source = ? AND source_id = ? LIMIT 1'
  ).get('seerr', intent.sourceId);
  if (existing && existing.last_processed_at != null && existing.last_error == null) {
    let stillPending = false;
    try {
      stillPending = futureIntentStore
        ? futureIntentStore.hasPendingForMedia(intent.mediaId)
        : false;
    } catch {}
    if (!stillPending) {
      return sendJson(response, 200, {
        status: 'duplicate',
        notificationType,
        intentId: existing.id,
      });
    }
  }

  // 4. Parse requested seasons BEFORE resolving identity so we can fail
  //    fast on a malformed/missing Requested Seasons entry (movies skip
  //    this entirely).
  const seasonParse = intent.mediaType === 'series'
    ? parseRequestedSeasons(built.extra)
    : { valid: true, seasons: [] };
  const isTvFanout = intent.mediaType === 'series' && seasonParse.valid && seasonParse.seasons.length > 0;

  // 5. Translate TMDB → IMDb at the Seerr boundary (movies always, TV
  //    when we have a TMDB to resolve). For TV fan-out we need IMDb to
  //    drive the parent and child media_id; for movies the same path
  //    continues to apply. When IMDb is already present we skip Seerr.
  let operationalIntent = intent;
  let identityStatus = 'imdb-already-known';
  let canonicalMediaTitle = null;
  let canonicalMediaYear = null;
  // Full ISO release/air date from the same Seerr detail response that
  // supplied the IMDb id (no extra metadata fanout). Drives deferred-
  // request classification: future date → future-not-released with an
  // expected_at the scheduler can sleep on; anything else → bounded retry.
  let canonicalReleaseDate = null;
  if (!intent.imdbId && intent.tmdbId) {
    const resolved = await resolveSeerrIdentity(
      { tmdbId: intent.tmdbId, mediaType: intent.mediaType },
      process.env,
    );
    if (!resolved.ok) {
      const intentId = searchCache.upsertMediaIntent({
        ...intent,
        imdbId: null,
        tmdbId: intent.tmdbId,
      });
      const failureMsg = `seerr-identity-unresolved: tmdb=${intent.tmdbId} reason=${resolved.reason}`;
      searchCache.db.prepare(
        'UPDATE media_intents SET last_error = ?, last_processed_at = ? WHERE id = ?'
      ).run(failureMsg, Date.now(), intentId);
      const httpStatus = resolved.reason === 'identity-misconfigured' ? 503 : 500;
      return sendJson(response, httpStatus, {
        status: 'identity-unresolved',
        notificationType,
        intentId,
        mediaId: intent.mediaId,
        mediaType: intent.mediaType,
        tmdbId: intent.tmdbId,
        reason: resolved.reason,
      });
    }
    operationalIntent = {
      ...intent,
      imdbId: resolved.imdbId,
      mediaId: resolved.imdbId,
    };
    identityStatus = 'imdb-resolved';
    if (typeof resolved.canonicalTitle === 'string' && resolved.canonicalTitle.length > 0) {
      canonicalMediaTitle = resolved.canonicalTitle;
    }
    // Surface the release year too. The Seerr detail body returns
    // `releaseDate` as an ISO date (e.g. "2024-02-27"); we only need the
    // 4-digit year to drive the canonical VFS path. We intentionally do
    // not add a second metadata lookup — the year is already in the same
    // Seerr response that supplied the IMDb id and canonical title.
    if (typeof resolved.releaseDate === 'string' && /^\d{4}/.test(resolved.releaseDate)) {
      const parsed = Number.parseInt(resolved.releaseDate.slice(0, 4), 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        canonicalMediaYear = parsed;
      }
      canonicalReleaseDate = resolved.releaseDate.trim() || null;
    }
  }

  // 6. Movie / single-episode path. Skipped entirely when this is a TV
  //    fan-out (handled in the branch below).
  if (!isTvFanout) {
    // For series with a missing/malformed Requested Seasons entry we
    // still persist the parent so the operator can see the parse
    // failure in last_error, but we never expand to "all seasons" and
    // we never call searchByMedia on the parent.
    const intentId = searchCache.upsertMediaIntent({
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      season: operationalIntent.season,
      episode: operationalIntent.episode,
      source: operationalIntent.source,
      sourceType: operationalIntent.sourceType,
      sourceId: operationalIntent.sourceId,
      sourceLabel: operationalIntent.sourceLabel,
      status: operationalIntent.status,
      priority: operationalIntent.priority,
      requestedBy: null,
      imdbId: operationalIntent.imdbId,
      tmdbId: operationalIntent.tmdbId,
      tvdbId: operationalIntent.tvdbId,
    });

    if (intent.mediaType === 'series' && !seasonParse.valid) {
      searchCache.db.prepare(
        'UPDATE media_intents SET last_error = ?, last_processed_at = ? WHERE id = ?'
      ).run(`extra-season-parse-failed:${seasonParse.reason}`, Date.now(), intentId);
    }

    // For non-TV (movies) the existing single-intent pipeline continues.
    // Request-scoped mylist memoization (same mechanism as POST
    // /api/media-request): one coordinator-owned snapshot for this
    // webhook's selection attempts instead of a full account-list
    // download per verify+inventory pair.
    if (intent.mediaType !== 'series') {
      const requestEnsureFn = buildRequestScopedEnsureFn({
        fallbackFn: ensureTorBoxFileIdentityFn,
        explicitFn: hasExplicitEnsureFn,
        controlPlaneStore,
        torBoxProvider,
        apiKey: torBoxApiKey,
        apiBase: torBoxApiBase,
        clock,
        scope: 'seerr-ingress',
      });
      const requestRdEnsureFn = ensureRealDebridFileIdentity
        ?? buildRequestRdEnsureFn({ rdClient, controlPlaneStore, clock });
      return await runSingleSearchByMedia({
        searchCache, operationalIntent, canonicalMediaTitle, canonicalMediaYear, canonicalReleaseDate, intentId,
        identityStatus, notificationType, response, hydrateVfs,
        ensureTorBoxFileIdentity: requestEnsureFn,
        ensureRealDebridFileIdentity: requestRdEnsureFn,
        controlPlaneStore,
        futureIntentStore,
        clock,
      });
    }
    // For series with parse failure, we stop here — the parent is durable
    // and last_error is recorded, but we never invoke searchByMedia.
    return sendJson(response, 200, {
      status: 'parse-failed',
      identityStatus,
      notificationType,
      intentId,
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      reason: seasonParse.valid ? null : seasonParse.reason,
    });
  }

  // ── 7. TV fan-out: parent + concrete episode children ───────────────────
  // Persist / reuse the parent media_intent. If an earlier attempt left
  // a parent with last_error != null, we reset the parent to retry;
  // existing children with successful media_request rows are skipped
  // below to avoid re-processing episodes that already succeeded.
  let parentIntentId = existing ? existing.id : null;
  if (parentIntentId == null) {
    parentIntentId = searchCache.upsertMediaIntent({
      mediaId: operationalIntent.mediaId,
      mediaType: 'series',
      season: null,
      episode: null,
      source: operationalIntent.source,
      sourceType: operationalIntent.sourceType,
      sourceId: operationalIntent.sourceId,
      sourceLabel: operationalIntent.sourceLabel,
      status: 'active',
      priority: operationalIntent.priority,
      requestedBy: null,
      imdbId: operationalIntent.imdbId,
      tmdbId: operationalIntent.tmdbId,
      tvdbId: operationalIntent.tvdbId,
    });
  } else {
    // Reset parent processing state so the next attempt can mark it again.
    searchCache.db.prepare(
      'UPDATE media_intents SET last_error = NULL, last_processed_at = NULL WHERE id = ?'
    ).run(parentIntentId);
  }

  // 8. Enumerate requested seasons via the Seerr TV API. The first season
  //    that fails structurally (env missing, network, 5xx) aborts the
  //    whole attempt; per-episode failures below are isolated.
  const childResults = [];
  let structurallyFailed = null;
  // Open a season fan-out scope so every per-child notifyPlex() call
  // for this mediaId is buffered; on close() the coalescer dispatches
  // exactly one targeted Plex partial-refresh per (collection, scanPath)
  // bucket instead of one per child. N children spanning seconds
  // collapse to a single HTTP call. Scope is closed after the
  // season loop completes (structurally or normally) below.
  const seasonScope = openSeasonFanOutScope(operationalIntent.mediaId);
  for (const seasonNum of seasonParse.seasons) {
    let episodes;
    try {
      episodes = await resolveSeerrSeasonEpisodes(
        Number(operationalIntent.tmdbId),
        seasonNum,
        process.env,
      );
    } catch (seasonErr) {
      structurallyFailed = { season: seasonNum, error: seasonErr.message };
      break;
    }

    // 9. Per-episode children.
    for (const ep of episodes) {
      const childSourceId = `${operationalIntent.sourceId}:s${seasonNum}:e${ep.episodeNumber}`;

      // Skip already-successful children on retry. A child counts as
      // successfully completed when it has a media_request row whose
      // status='completed' (existing pipeline writes this when
      // searchByMedia returns successfully).
      const priorChild = searchCache.db.prepare(
        "SELECT id FROM media_intents WHERE source = ? AND source_id = ? LIMIT 1"
      ).get('seerr', childSourceId);
      if (priorChild) {
        const priorDone = searchCache.db.prepare(
          "SELECT 1 FROM media_requests WHERE intent_id = ? AND status = 'completed' LIMIT 1"
        ).get(priorChild.id);
        if (priorDone) {
          childResults.push({
            season: seasonNum,
            episode: ep.episodeNumber,
            childIntentId: priorChild.id,
            skipped: true,
            reason: 'already-successful',
          });
          continue;
        }
      }

      const childIntentId = searchCache.upsertMediaIntent({
        mediaId: operationalIntent.mediaId,
        mediaType: 'tv',
        season: seasonNum,
        episode: ep.episodeNumber,
        source: operationalIntent.source,
        sourceType: 'request',
        sourceId: childSourceId,
        sourceLabel: operationalIntent.sourceLabel
          ? `${operationalIntent.sourceLabel} S${String(seasonNum).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`
          : null,
        status: 'active',
        priority: operationalIntent.priority,
        requestedBy: null,
        imdbId: operationalIntent.imdbId,
        tmdbId: operationalIntent.tmdbId,
        tvdbId: operationalIntent.tvdbId,
      });

      try {
        // Fresh request-scoped mylist memoization per episode child: the
        // coordinator must not outlive one searchByMedia call, otherwise a
        // later sibling could verify against a stale snapshot.
        const childEnsureFn = buildRequestScopedEnsureFn({
          fallbackFn: ensureTorBoxFileIdentityFn,
          explicitFn: hasExplicitEnsureFn,
          controlPlaneStore,
          torBoxProvider,
          apiKey: torBoxApiKey,
          apiBase: torBoxApiBase,
          clock,
          scope: 'seerr-ingress-tv',
        });
        const result = await searchByMedia(searchCache, {
          mediaId: operationalIntent.mediaId,
          // searchByMedia's intent factory accepts only 'movie' or 'series'
          // (it maps to streamType internally as 'tv' for episodes). The
          // media_intents row stores 'tv' for episode children; the
          // searchByMedia parameter is the streamType discriminator.
          mediaType: 'series',
          mediaTitle: canonicalMediaTitle,
          season: seasonNum,
          episode: ep.episodeNumber,
          source: operationalIntent.source,
          sourceType: 'request',
          sourceId: childSourceId,
          sourceLabel: operationalIntent.sourceLabel
            ? `${operationalIntent.sourceLabel} S${String(seasonNum).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`
            : null,
          requestedBy: null,
          priority: operationalIntent.priority,
          intentId: childIntentId,
          persist: true,
          hydrateVfs,
          controlPlaneStore,
          // Slice 1.75: pre-publication TorBox file identity binding
          // for TV episodes. TV episodes typically have exact per-file
          // size on the candidate (behaviorHints.videoSize). When
          // configured, this matches the size against the live TorBox
          // inventory and threads the resulting torrentFileId into
          // the handoff.
          ...(childEnsureFn ? { ensureTorBoxFileIdentity: childEnsureFn } : {}),
          // RD ensure: explicit injection wins (tests), else per-request build.
          ...(ensureRealDebridFileIdentity
            ? { ensureRealDebridFileIdentity }
            : rdEnsureForRequest({ rdClient, controlPlaneStore, clock })),
          // TV series don't currently use the canonical title/year for
          // the VFS path (TV materializer uses its own filename-derived
          // identity — unchanged in this slice). Forwarding them is
          // safe and lets the handoff record the canonical identity
          // for telemetry / future TV work without forcing a separate
          // codepath.
          ...(canonicalMediaTitle ? { canonicalTitle: canonicalMediaTitle } : {}),
          ...(canonicalMediaYear != null ? { canonicalYear: canonicalMediaYear } : {}),
        });
        childResults.push({
          season: seasonNum,
          episode: ep.episodeNumber,
          childIntentId,
          // searchByMedia returns its candidate count as `total`, not
          // `resultCount`. (Look at the return object in
          // src/api/media-request.js — there is no `resultCount` field.)
          resultCount: result?.total ?? 0,
          // Household deferred-request tranche: an aired-or-future
          // episode with zero candidates — or candidates that never
          // bound — becomes durable intent keyed on exact S/E
          // (ep.airDate comes from the Seerr season call above — no
          // extra metadata fanout). Deferred children are not failures;
          // the parent outcome below excludes them from failedCount.
          ...unfulfilledTvDeferral({
            store: futureIntentStore,
            mediaId: operationalIntent.mediaId,
            season: seasonNum,
            episode: ep.episodeNumber,
            airDate: ep.airDate,
            childSourceId,
            result,
            clock,
          }),
        });
        // Clear any stale error from a prior failed attempt on this
        // child — successful processing supersedes the earlier failure.
        searchCache.db.prepare(
          'UPDATE media_intents SET last_error = NULL, last_processed_at = ? WHERE id = ?'
        ).run(Date.now(), childIntentId);
      } catch (episodeErr) {
        // Per-episode failure isolation: a transient pipeline failure
        // becomes durable deferred intent (exact S/E); a deterministic
        // failure is recorded on this child as before. Either way the
        // remaining episodes continue.
        const classification = classifySeerrDeferral({
          dateRaw: ep.airDate,
          total: null,
          error: episodeErr,
          nowMs: clock(),
        });
        const deferral = futureIntentStore ? deferSeerrRequest({
          store: futureIntentStore,
          mediaType: 'series',
          mediaId: operationalIntent.mediaId,
          season: seasonNum,
          episode: ep.episodeNumber,
          seerrSourceId: childSourceId,
          classification,
        }) : null;
        if (deferral) {
          searchCache.db.prepare(
            'UPDATE media_intents SET last_error = NULL, last_processed_at = ? WHERE id = ?'
          ).run(Date.now(), childIntentId);
          childResults.push({
            season: seasonNum,
            episode: ep.episodeNumber,
            childIntentId,
            resultCount: 0,
            deferred: true,
            deferReason: deferral.deferReason,
            futureIntentId: deferral.futureIntentId,
            detail: classification.detail,
          });
          continue;
        }
        // Per-episode failure isolation: record on this child and
        // continue with remaining episodes in the season.
        searchCache.db.prepare(
          'UPDATE media_intents SET last_error = ?, last_processed_at = ? WHERE id = ?'
        ).run(`searchByMedia-failed:s${seasonNum}e${ep.episodeNumber} ${episodeErr.message}`, Date.now(), childIntentId);
        childResults.push({
          season: seasonNum,
          episode: ep.episodeNumber,
          childIntentId,
          error: episodeErr.message,
        });
      }
    }
  }

  // 10. Mark parent processing outcome.
  // Close the season fan-out scope BEFORE recording the parent
  // outcome and before any return path. close() awaits the
  // dispatched refreshes so the operator sees a consistent state:
  // either the Plex partial-refresh has been sent (and the
  // coalescer accounting reflects it) or it has not. This is the
  // lifecycle-semantics seam: N child notifies → one HTTP call.
  try {
    await seasonScope.close();
  } catch (scopeCloseErr) {
    // A failed close() is non-fatal for the Seerr response. The
    // season-fan-out outcome (success / partial failure) is
    // independent of whether the refresh dispatch itself failed.
    console.error(`[Plex] season-fan-out scope close error for ${operationalIntent.mediaId}: ${scopeCloseErr.message}`);
  }

  if (structurallyFailed) {
    searchCache.db.prepare(
      'UPDATE media_intents SET last_error = ?, last_processed_at = ? WHERE id = ?'
    ).run(
      `seerr-season-enumeration-failed:s${structurallyFailed.season} ${structurallyFailed.error}`,
      Date.now(),
      parentIntentId,
    );
    return sendJson(response, 500, {
      status: 'tv-fan-out-enumeration-failed',
      identityStatus,
      notificationType,
      parentIntentId,
      mediaId: operationalIntent.mediaId,
      mediaType: 'series',
      failedSeason: structurallyFailed.season,
      childResults,
      error: structurallyFailed.error,
    });
  }

  // If any child errored, the parent is NOT successfully completed —
  // a subsequent webhook with the same request ID must be allowed to
  // retry the failed children. We record the failure on the parent so
  // the duplicate short-circuit (last_processed_at IS NOT NULL AND
  // last_error IS NULL) does not poison the parent row.
  // Household deferred-request tranche: deferred children likewise keep
  // the parent redeliverable, under their own marker (deferred is
  // scheduled work, not a failure — the scheduler also converges on it).
  const failedChildren = childResults.filter((r) => r.error);
  const deferredChildren = childResults.filter((r) => r.deferred === true);
  if (failedChildren.length > 0) {
    const summary = failedChildren
      .map((r) => `s${r.season}e${r.episode}:${r.error}`)
      .join(',');
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_error = ? WHERE id = ?'
    ).run(Date.now(), `tv-fan-out-children-failed:${summary}`, parentIntentId);
  } else if (deferredChildren.length > 0) {
    const summary = deferredChildren
      .map((r) => `s${r.season}e${r.episode}:${r.deferReason}`)
      .join(',');
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_error = ? WHERE id = ?'
    ).run(Date.now(), `tv-fan-out-children-deferred:${summary}`, parentIntentId);
  } else {
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_error = NULL WHERE id = ?'
    ).run(Date.now(), parentIntentId);
  }

  return sendJson(response, 200, {
    status: 'tv-fan-out',
    identityStatus,
    notificationType,
    parentIntentId,
    childCount: childResults.filter((r) => r.episode != null).length,
    failedCount: failedChildren.length,
    deferredCount: childResults.filter((r) => r.deferred === true).length,
    childResults,
    mediaId: operationalIntent.mediaId,
    mediaType: 'series',
    canonicalTitle: canonicalMediaTitle,
  });
}

/**
 * Household deferred-request tranche: turn a retryable Seerr "not yet"
 * into durable future intent so the anticipation scheduler converges on
 * it automatically. Idempotent on exact media identity (the store's
 * unique index); a re-request revives withdrawn/exhausted rows instead
 * of duplicating them. Returns null when there is no store or the
 * classification is not retryable.
 */
function deferSeerrRequest({ store, mediaType, mediaId, season, episode, seerrSourceId, classification }) {
  if (!store || !classification || classification.retryable !== true) return null;
  const { intent } = store.seed({
    mediaType,
    mediaId,
    season: season ?? null,
    episode: episode ?? null,
    source: `seerr:${seerrSourceId}`,
    expectedAt: classification.expectedAt,
    deferReason: classification.outcome,
  });
  store.revive(intent.id, { expectedAt: classification.expectedAt, deferReason: classification.outcome });
  const row = store.findByIdentity({ mediaId, season: season ?? null, episode: episode ?? null }) ?? intent;
  return {
    futureIntentId: row.id,
    deferReason: row.defer_reason ?? classification.outcome,
    intentState: row.state,
    expectedAt: row.expected_at,
    nextCheckAt: row.next_check_at,
  };
}

/**
 * TV unfulfilled-child deferral fragment for one episode child. Returns
 * the extra childResults fields (or {} when the child fulfilled). Covers
 * both zero-candidate children and children whose candidates never bound
 * a provider-backed handoff.
 */
function unfulfilledTvDeferral({ store, mediaId, season, episode, airDate, childSourceId, result, clock = () => Date.now() }) {
  const total = result?.total ?? 0;
  const bound = result?.handoff != null;
  if (!store || (total !== 0 && bound)) return {};
  const classification = classifySeerrDeferral({
    dateRaw: airDate,
    total,
    bound,
    selectionReason: result?.selection?.reason ?? null,
    nowMs: clock(),
  });
  const deferral = deferSeerrRequest({
    store,
    mediaType: 'series',
    mediaId,
    season,
    episode,
    seerrSourceId: childSourceId,
    classification,
  });
  if (!deferral) return {};
  return {
    deferred: true,
    deferReason: deferral.deferReason,
    futureIntentId: deferral.futureIntentId,
    expectedAt: deferral.expectedAt,
    nextCheckAt: deferral.nextCheckAt,
  };
}

/**
 * Single-intent searchByMedia path used by movies (and series with a
 * missing/malformed Requested Seasons entry, which never reach here).
 */
async function runSingleSearchByMedia({
  searchCache, operationalIntent, canonicalMediaTitle, canonicalMediaYear, canonicalReleaseDate = null, intentId,
  identityStatus, notificationType, response, hydrateVfs = null,
  ensureTorBoxFileIdentity = null, ensureRealDebridFileIdentity = null,
  controlPlaneStore = null, futureIntentStore = null, clock = () => Date.now(),
}) {
  try {
    const result = await searchByMedia(searchCache, {
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      mediaTitle: canonicalMediaTitle,
      season: operationalIntent.season,
      episode: operationalIntent.episode,
      source: operationalIntent.source,
      sourceType: operationalIntent.sourceType,
      sourceId: operationalIntent.sourceId,
      sourceLabel: operationalIntent.sourceLabel,
      requestedBy: null,
      priority: operationalIntent.priority,
      intentId,
      persist: true,
      hydrateVfs,
      controlPlaneStore,
      // Slice 1.75: pre-publication TorBox file identity binding.
      // When the operator has configured the TorBox provider + control
      // plane, the seam matches the selected candidate's exact per-file
      // size against the live TorBox inventory BEFORE the handoff is
      // persisted and threads the resulting torrentFileId into the
      // handoff. When the seam is absent (operator has not configured
      // a real TorBox account, e.g. tests), the search path persists
      // legacy handoffs with torrentFileId=null.
      ...(ensureTorBoxFileIdentity ? { ensureTorBoxFileIdentity } : {}),
      ...(ensureRealDebridFileIdentity ? { ensureRealDebridFileIdentity } : {}),
      // Forward the canonical Seerr detail identity (originalTitle +
      // releaseDate) so the VFS materializer builds a clean Plex-facing
      // path like Movies/Dune Part Two (2024)/Dune Part Two (2024).mkv
      // instead of inheriting the noisy provider release name.
      ...(canonicalMediaTitle ? { canonicalTitle: canonicalMediaTitle } : {}),
      ...(canonicalMediaYear != null ? { canonicalYear: canonicalMediaYear } : {}),
    });
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_result_count = ?, last_error = NULL WHERE id = ?'
    ).run(Date.now(), result.total ?? 0, intentId);
    // Household deferred-request tranche: zero usable candidates is not
    // a fulfillment — it is durable demand the scheduler must converge
    // on. Neither is an unbound candidate set (e.g. unreleased titles
    // with only fake/uncached rows and no provider-backed handoff).
    // Classify (future vs released vs transient) and seed a future
    // intent instead of silently dropping the human decision.
    if ((result.total ?? 0) === 0 || result.handoff == null) {
      const classification = classifySeerrDeferral({
        dateRaw: canonicalReleaseDate,
        total: result.total ?? 0,
        bound: result.handoff != null,
        selectionReason: result.selection?.reason ?? null,
        nowMs: clock(),
      });
      const deferral = deferSeerrRequest({
        store: futureIntentStore,
        mediaType: operationalIntent.mediaType,
        mediaId: operationalIntent.mediaId,
        season: operationalIntent.season,
        episode: operationalIntent.episode,
        seerrSourceId: operationalIntent.sourceId,
        classification,
      });
      if (deferral) {
        return sendJson(response, 202, {
          status: 'deferred',
          identityStatus,
          notificationType,
          intentId,
          resultCount: result.total ?? 0,
          mediaId: operationalIntent.mediaId,
          mediaType: operationalIntent.mediaType,
          imdbId: operationalIntent.imdbId,
          tmdbId: operationalIntent.tmdbId,
          tvdbId: operationalIntent.tvdbId,
          deferReason: deferral.deferReason,
          futureIntentId: deferral.futureIntentId,
          intentState: deferral.intentState,
          expectedAt: deferral.expectedAt,
          nextCheckAt: deferral.nextCheckAt,
        });
      }
    }
    return sendJson(response, 200, {
      status: 'created',
      identityStatus,
      notificationType,
      intentId,
      requestId: result.requestId ?? null,
      resultCount: result.total ?? 0,
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      imdbId: operationalIntent.imdbId,
      tmdbId: operationalIntent.tmdbId,
      tvdbId: operationalIntent.tvdbId,
    });
  } catch (err) {
    // A thrown pipeline error is either transient (provider, hydration,
    // availability — retry later via durable intent) or deterministic
    // (bad identity/mapping — fail loudly, never background-retry).
    const classification = classifySeerrDeferral({
      dateRaw: canonicalReleaseDate,
      total: null,
      error: err,
      nowMs: clock(),
    });
    const deferral = deferSeerrRequest({
      store: futureIntentStore,
      mediaType: operationalIntent.mediaType,
      mediaId: operationalIntent.mediaId,
      season: operationalIntent.season,
      episode: operationalIntent.episode,
      seerrSourceId: operationalIntent.sourceId,
      classification,
    });
    if (deferral) {
      searchCache.db.prepare(
        'UPDATE media_intents SET last_processed_at = ?, last_result_count = ?, last_error = NULL WHERE id = ?'
      ).run(Date.now(), 0, intentId);
      return sendJson(response, 202, {
        status: 'deferred',
        identityStatus,
        notificationType,
        intentId,
        resultCount: 0,
        mediaId: operationalIntent.mediaId,
        mediaType: operationalIntent.mediaType,
        imdbId: operationalIntent.imdbId,
        tmdbId: operationalIntent.tmdbId,
        tvdbId: operationalIntent.tvdbId,
        deferReason: deferral.deferReason,
        futureIntentId: deferral.futureIntentId,
        intentState: deferral.intentState,
        expectedAt: deferral.expectedAt,
        nextCheckAt: deferral.nextCheckAt,
        detail: classification.detail,
      });
    }
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_error = ? WHERE id = ?'
    ).run(Date.now(), err.message, intentId);
    return sendJson(response, 500, {
      status: 'processing-failed',
      identityStatus,
      notificationType,
      intentId,
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      error: 'seerr-processing-failed',
      message: err.message,
    });
  }
}

function requireControlPlaneStore(store) {
  if (!store) throw new Error('Control-plane store is not configured');
}

function parseBoundedLimit(value) {
  if (value == null || value === '') return 50;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be between 1 and 100');
  }
  return limit;
}

function parseOptionalReleaseIdentity(params) {
  const infoHash = params.get('infoHash');
  const fileIndexValue = params.get('fileIndex');
  if (infoHash == null && fileIndexValue == null) return null;
  if (infoHash == null || fileIndexValue == null) {
    throw new Error('infoHash and fileIndex are required together');
  }
  let fileIndex;
  if (fileIndexValue === 'torrent') {
    fileIndex = null;
  } else if (/^(0|[1-9]\d*)$/.test(fileIndexValue)) {
    fileIndex = Number(fileIndexValue);
  } else {
    throw new Error('fileIndex must be torrent or a non-negative integer');
  }
  return createReleaseIdentity(infoHash, fileIndex);
}

function parseOptionalStage6Scope(params) {
  const fields = ['accountScope', 'zurgInstanceScope', 'mountScope'];
  const values = fields.map((field) => params.get(field));
  if (values.every((value) => value == null)) return null;
  if (values.some((value) => value == null)) {
    throw new Error('accountScope, zurgInstanceScope, and mountScope are required together');
  }
  for (const [index, value] of values.entries()) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) {
      throw new Error(`${fields[index]} must be a provider-safe identifier`);
    }
  }
  return {
    provider: 'realdebrid',
    accountScope: values[0].toLowerCase(),
    instanceScope: values[1].toLowerCase(),
    mountScope: values[2].toLowerCase(),
  };
}

/**
 * Adapt a `rowToPlaybackHandoff` shape (returned by `getTvPlaybackHandoff`)
 * to the selection shape expected by the rest of the resolver route.
 *
 * The selection shape carries `selectedHash` (not `infoHash`) and adds
 * `status: 'selected'`, `requestId`, `providerState`, etc. — all fields the
 * resolver reads downstream. Mirrors the mapping in `getExistingSelection`.
 */
function adaptTvHandoffToSelection(handoff) {
  return {
    status: 'selected',
    requestId: handoff.requestId,
    mediaId: handoff.mediaId,
    mediaType: handoff.mediaType,
    season: handoff.season ?? null,
    episode: handoff.episode ?? null,
    releaseKey: handoff.releaseKey,
    selectedHash: handoff.infoHash,
    fileIndex: handoff.fileIndex,
    filename: handoff.filename,
    provider: handoff.provider,
    providerState: handoff.providerState,
    identityTier: handoff.identityTier,
    resolutionState: handoff.resolutionState,
    reason: handoff.selectionReason || 'existing tv handoff',
    selectedAt: handoff.selectedAt,
  };
}

/**
 * Try alternate candidate fallback when primary selection is unavailable.
 * Loads persisted request results, filters by eligibility and scope, and
 * checks availability in rank order until a usable candidate is found.
 *
 * @returns {Promise<boolean>} True if fallback succeeded and response was sent
 */
async function tryAlternateCandidateFallback({
  searchCache,
  alternateFallback,
  revalidator,
  controlPlaneStore,
  resolveTorBoxDeliverySeam,
  existingSelection,
  primaryRevalidation,
  rawId,
  mediaType,
  recordTelemetry,
  response,
  sendJson,
  clock,
}) {
  // Load persisted request to get expected scope and results. For series
  // episodes, scope the request lookup to the exact (mediaId, season,
  // episode) tuple so the persisted request — and therefore the persisted
  // candidate list used as fallback pool — matches the current episode.
  const fallbackEpisodeSeason = existingSelection?.season ?? null;
  const fallbackEpisodeNum = existingSelection?.episode ?? null;
  const persistedRequest = searchCache.getMediaRequestsByMediaId(
    rawId,
    fallbackEpisodeSeason,
    fallbackEpisodeNum,
  );
  if (!persistedRequest) return false;

  // Build expected scope from the original request
  const expectedScope = {
    media_type: persistedRequest.media_type,
    season: persistedRequest.season,
    episode: persistedRequest.episode,
  };

  // Find a usable alternate candidate
  const fallback = await alternateFallback.findUsableAlternate({
    mediaId: rawId,
    primaryReleaseKey: existingSelection.releaseKey,
    expectedScope,
  });

  if (!fallback) return false;

  const { candidate, revalidation, rdResolution } = fallback;

  const fallbackReason = primaryRevalidation.cacheState === REVALIDATION_OUTCOME.UNCACHED
    ? FALLBACK_REASON.PRIMARY_UNAVAILABLE
    : FALLBACK_REASON.PRIMARY_PROVIDER_ERROR;
  const fallbackTelemetry = alternateFallback.buildFallbackTelemetry({
    originalReleaseKey: existingSelection.releaseKey,
    selectedReleaseKey: candidate.releaseKey,
    fallbackRank: candidate.rank,
    reason: fallbackReason,
  });

  // Same-TorrentFile cross-provider path: when the alternate candidate's
  // TorBox check was uncached/unknown but bounded RD resolution produced a
  // usable URL, prefer RD over the TorBox seam. This handles the case where
  // the same infoHash is cached on RD but not on TorBox — the legacy TorBox
  // seam path would either retry placement (waste) or return a typed
  // failure. Use RD directly with the same fallback telemetry envelope.
  if (rdResolution && rdResolution.usable && rdResolution.url) {
    recordTelemetry(RESOLVER_OUTCOME.REDIRECTED, null, 307, {
      infoHash: candidate.info_hash,
      releaseKey: candidate.releaseKey,
      provider: 'realdebrid',
      availabilitySource: revalidation.availabilitySource,
      providerCheckOccurred: revalidation.providerCheckOccurred,
      ...fallbackTelemetry,
    });
    const rdHeaders = {
      location: rdResolution.url,
      'cache-control': 'no-store',
      'x-torrent-id': rdResolution.torrentId,
      'x-file-id': rdResolution.rdFileId,
      'x-availability-source': revalidation.availabilitySource,
      'x-provider-check-occurred': revalidation.providerCheckOccurred ? 'true' : 'false',
      'x-fallback-used': 'true',
      'x-fallback-rank': String(candidate.rank),
      'x-fallback-original-release-key': existingSelection.releaseKey,
      'x-fallback-selected-release-key': candidate.releaseKey,
      'x-url-live-checked': 'true',
      'x-rd-torrent-id': rdResolution.torrentId,
      'x-rd-file-id': rdResolution.rdFileId,
      'x-rd-resolution-source': rdResolution.resolution === 'cache' ? 'cache' : 'fresh',
    };
    response.writeHead(307, rdHeaders);
    response.end();
    return true;
  }

  // Alternate delivery seam: run the SAME authoritative TorBox delivery
  // seam used by the primary path. This reuses an existing control-plane
  // placement, passively recovers an account placement, or cached-only-
  // creates a new one, then establishes the exact provider-file mapping
  // and resolves the requestdl URL through the short-lived CDN URL cache.
  // If the seam is not wired (test/legacy environments), fall through so
  // the caller can surface the typed failure from the original revalidation.
  if (!controlPlaneStore || typeof resolveTorBoxDeliverySeam !== 'function') {
    return false;
  }

  try {
    const delivery = await resolveTorBoxDeliverySeam({
      infoHash: candidate.info_hash,
      fileIndex: candidate.fileIndex,
      releaseKey: candidate.releaseKey,
      filename: candidate.filename,
    });

    // Worker A — Defect A: do NOT promote on redirect URL existence alone.
    // Verify a single bounded byte response from the delivery URL before
    // committing the alternate to the durable handoff / VFS / binding /
    // exposure / durability path. Mirrors the primary RD liveness check.
    let validatedBytes = false;
    try {
      validatedBytes = await isUrlLive(delivery.url);
    } catch (liveErr) {
      validatedBytes = false;
    }

    // Wire the existing promoteAlternate helper into the alternate TorBox
    // success path. The helper is idempotent under replay; on success it
    // persists the canonical handoff and the caller is responsible for
    // materializing the VFS row + binding + exposure. A failed gate is
    // non-fatal: we still 307 the user to the (now-known-live) URL so the
    // bounded redirect semantics are preserved.
    if (validatedBytes) {
      try {
        const promotion = alternateFallback.promoteAlternate({
          candidate,
          delivery,
          controlPlaneStore,
          evidence: { validatedBytes: true },
          mediaRequest: {
            mediaId: rawId,
            media_type: mediaType,
            season: persistedRequest?.season ?? null,
            episode: persistedRequest?.episode ?? null,
          },
          now: clock,
        });
        if (promotion?.promoted) {
          // The handoff returned by promoteAlternate carries
          // torrentFileIdentity (placement + providerFile + torrentFileId).
          // materializeVfsEntry is the single owner of the VFS row update
          // and the binding write. Reuse normal machinery — no parallel
          // writer.
          try {
            await materializeVfsEntry(
              searchCache,
              promotion.handoff,
              controlPlaneStore,
              clock,
              { allowLegacy: true },
            );
          } catch (vfsErr) {
            console.warn(`[alternate-fallback] VFS materialize failed: ${vfsErr.message}`);
          }
        } else {
          console.warn(`[alternate-fallback] promoteAlternate refused: ${promotion?.reason ?? 'unknown'}`);
        }
      } catch (promoteErr) {
        // Promotion failure must never block the 307 — the bounded
        // redirect is still the user-facing contract.
        console.warn(`[alternate-fallback] promoteAlternate threw: ${promoteErr.message}`);
      }
    }

    recordTelemetry(RESOLVER_OUTCOME.REDIRECTED, null, 307, {
      infoHash: candidate.info_hash,
      releaseKey: candidate.releaseKey,
      provider: 'torbox',
      availabilitySource: revalidation.availabilitySource,
      providerCheckOccurred: revalidation.providerCheckOccurred,
      ...fallbackTelemetry,
    });
    const headers = {
      location: delivery.url,
      'cache-control': 'no-store',
      'x-torrent-id': delivery.placementId,
      'x-file-id': delivery.providerFileId,
      'x-availability-source': revalidation.availabilitySource,
      'x-provider-check-occurred': revalidation.providerCheckOccurred ? 'true' : 'false',
      'x-fallback-used': 'true',
      'x-fallback-rank': String(candidate.rank),
      'x-fallback-original-release-key': existingSelection.releaseKey,
      'x-fallback-selected-release-key': candidate.releaseKey,
      'x-url-live-checked': validatedBytes ? 'true' : 'false',
    };
    response.writeHead(307, headers);
    response.end();
    return true;
  } catch (deliveryErr) {
    // The alternate-delivery seam raises the same error taxonomy as the
    // primary seam (TorBoxDeliveryError, TorBoxDownloadUrlError). Surface
    // it as a typed failure with the original alternate candidate's
    // identity — never fall back to the legacy pure-redirect resolver,
    // which cannot create placements.
    if (deliveryErr instanceof TorBoxDeliveryError || deliveryErr instanceof TorBoxDownloadUrlError) {
      recordTelemetry(RESOLVER_OUTCOME.FAILED, deliveryErr.code, null, {
        infoHash: candidate.info_hash,
        releaseKey: candidate.releaseKey,
        provider: 'torbox',
        availabilitySource: revalidation.availabilitySource,
        providerCheckOccurred: revalidation.providerCheckOccurred,
        ...fallbackTelemetry,
      });
      sendJson(response, deliveryErr.status, {
        error: deliveryErr.message,
        code: deliveryErr.code,
        mediaId: rawId,
        mediaType,
      });
      return true;
    }
    // Preserve the historical error-class contract: a RedirectResolutionError
    // here would mean a code-path bug (the pure redirect resolver is no
    // longer invoked from this seam). Re-throw to surface it.
    throw deliveryErr;
  }
}

function validateSupportedRequest(body) {
  const intent = createRequestIntent({ type: body.type || 'series', mediaId: body.mediaId });
  const singleEpisode = intent.mediaType === 'tv' && intent.scope === 'episode' && intent.episodes.length === 1;
  const movie = intent.mediaType === 'movie' && intent.scope === 'movie' && intent.season === null && intent.episodes.length === 0;
  if (!singleEpisode && !movie) {
    throw new Error('Only explicit movies and single TV episode requests are supported');
  }

  const identity = validateReleaseIdentity(body.release);
  const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) || null : null;
  const release = {
    ...identity,
    title: text(body.release.title),
    filename: text(body.release.filename),
    size: Number.isFinite(body.release.size) && body.release.size >= 0 ? body.release.size : null,
    resolution: text(body.release.resolution, 30),
    quality: text(body.release.quality, 30),
    codec: text(body.release.codec, 30),
    hdr: text(body.release.hdr, 30),
  };
  const handlingMode = body.handlingMode ?? 'download';
  if (!HANDLING_MODES.includes(handlingMode)) {
    throw new Error(`Invalid handling mode: ${handlingMode}`);
  }
  return { intent, release, handlingMode };
}

export function createApp(dependencies = {}) {
  return http.createServer(createRequestHandler(dependencies));
}

export function createRequestHandler(dependencies = {}) {
  const importer = dependencies.importer || new QueueImporterClient();
  const operatorRoot = dependencies.operatorRoot || process.env.REQUESTS_ROOT || '/requests';
  const catalogSearch = dependencies.searchCatalog || searchCatalog;
  const mediaLookup = dependencies.getMedia || getMedia;
  const combinedSearchFn = dependencies.combinedSearch || combinedSearch;
  const virtualFulfillment = dependencies.fulfillVirtualSelection || fulfillVirtualSelection;
  // Internal search uses a persistent discovery cache.
  // dbPath can be injected via dependencies or DISCOVERY_DB env var.
  // Defaults to in-memory for testing (when no dbPath provided).
  const dbPath = dependencies.dbPath || process.env.DISCOVERY_DB;
  const searchCache = dependencies.searchCache || dependencies.discoveryCache || createDiscoveryCache(dbPath ? { dbPath } : {});
  const searchDecisionDbPath = dependencies.searchDecisionDbPath || process.env.SEARCH_DECISIONS_DB;
  const searchDecisionStore = dependencies.searchDecisionStore || createSearchDecisionStore(searchDecisionDbPath ? { dbPath: searchDecisionDbPath } : {});
  const eventStoreDbPath = dependencies.eventStoreDbPath || process.env.EVENT_STORE_DB;
  const eventStore = dependencies.eventStore || createLifecycleEventStore(eventStoreDbPath ? { dbPath: eventStoreDbPath } : {});
  const controlPlaneStore = dependencies.controlPlaneStore ?? null;
  const controlPlaneHealth = dependencies.getControlPlaneHealth || getControlPlaneHealth;
  const clock = dependencies.now || (() => Date.now());
  const staticRoot = dependencies.staticRoot === undefined ? process.env.STATIC_ROOT : dependencies.staticRoot;
  const env = dependencies.env ?? process.env;

  // Corpus lifecycle (bootstrap + incremental DMM updates). One instance
  // per handler: its in-flight flag is the process single-flight guard.
  // Injectable for tests via dependencies.corpusLifecycle.
  let corpusLifecycleInstance = dependencies.corpusLifecycle ?? null;
  function getCorpusLifecycle() {    if (!corpusLifecycleInstance) {
      corpusLifecycleInstance = createCorpusLifecycle({
        cache: searchCache,
        repo: env.CORPUS_DMM_REPO || 'debridmediamanager/hashlists',
        githubToken: env.CORPUS_GITHUB_TOKEN || env.GITHUB_TOKEN || null,
        clock,
      });
    }
    return corpusLifecycleInstance;
  }

  // Future-intent store (anticipatory tranche). Table lives in the
  // discovery DB beside the corpus; injectable for tests.
  let futureIntentStoreInstance = dependencies.futureIntentStore ?? null;
  function getFutureIntentStore() {
    if (!futureIntentStoreInstance) {
      futureIntentStoreInstance = createFutureIntentStore({ db: searchCache.db, clock });
    }
    return futureIntentStoreInstance;
  }

  // Availability wake log (availability tranche). Same DB, same pattern.
  let availabilityWakeLogInstance = dependencies.availabilityWakeLog ?? null;
  function getAvailabilityWakeLog() {
    if (!availabilityWakeLogInstance) {
      availabilityWakeLogInstance = createAvailabilityWakeLog({ db: searchCache.db, clock });
    }
    return availabilityWakeLogInstance;
  }

  // Promotion store (permanent-storage tranche). Table lives in
  // control-plane.db beside the TorrentFile truth; injectable for
  // tests via dependencies.promotionStore.
  let promotionStoreInstance = dependencies.promotionStore ?? null;
  function getPromotionStore() {
    if (!promotionStoreInstance) {
      if (!controlPlaneStore?.db) return null;
      try {
        promotionStoreInstance = createPromotionStore({ db: controlPlaneStore.db, clock });
      } catch {
        return null;
      }
    }
    return promotionStoreInstance;
  }

  // Owned-storage root for permanent promotion output. Unset = the
  // promote API refuses with an exact reason; nothing else changes.
  function getPermanentRoot() {
    const root = (env.HASHSUCKER_PERMANENT_PATH ?? '').trim();
    return root || null;
  }

  // Promotion worker single-flight per process (vergelijk corpus
  // lifecycle): one instance, in-flight set inside. Injectable.
  let promotionWorkerInstance = dependencies.promotionWorker ?? null;
  function getPromotionWorker() {
    if (promotionWorkerInstance) return promotionWorkerInstance;
    const store = getPromotionStore();
    const root = getPermanentRoot();
    if (!store || !root) return null;
    promotionWorkerInstance = createPromotionWorker({
      promotionStore: store,
      dataPlaneBaseUrl: env.DATA_PLANE_URL ?? 'http://data-plane:3001',
      permanentRoot: root,
    });
    return promotionWorkerInstance;
  }

  // Generic download intents (download-intent tranche). Same getters
  // shape as promotion: store over control-plane.db, root-gated
  // worker. No library item required — media identity in, staged file
  // out. Injectable for tests via dependencies.downloadStore /
  // dependencies.downloadWorker.
  let downloadStoreInstance = dependencies.downloadStore ?? null;
  function getDownloadStore() {
    if (!downloadStoreInstance) {
      if (!controlPlaneStore?.db) return null;
      try {
        downloadStoreInstance = createDownloadStore({ db: controlPlaneStore.db, clock });
      } catch {
        return null;
      }
    }
    return downloadStoreInstance;
  }

  function getDownloadRoot() {
    const root = (env.HASHSUCKER_DOWNLOAD_PATH ?? '').trim();
    return root || null;
  }

  let downloadWorkerInstance = dependencies.downloadWorker ?? null;
  function getDownloadWorker() {
    if (downloadWorkerInstance) return downloadWorkerInstance;
    const store = getDownloadStore();
    const root = getDownloadRoot();
    if (!store || !root) return null;
    const resolver = createDownloadResolver({
      searchCache,
      controlPlaneStore,
      searchByMediaFn: searchByMedia,
      buildEnsureFns: async () => {
        const scoped = buildRequestScopedEnsureFn({
          fallbackFn: ensureTorBoxFileIdentityFn,
          explicitFn: hasExplicitEnsureFn,
          controlPlaneStore,
          torBoxProvider,
          apiKey: env.TORBOX_API_KEY,
          apiBase: env.TORBOX_API_URL,
          clock,
          scope: 'download-request',
        });
        return {
          ...(scoped ? { ensureTorBoxFileIdentity: scoped } : {}),
          ...rdEnsureForRequest({ rdClient, controlPlaneStore, clock }),
        };
      },
    });
    downloadWorkerInstance = createDownloadWorker({
      downloadStore: store,
      resolveFn: (params) => resolver.resolve(params),
      stagingRoot: root,
      dataPlaneBaseUrl: env.DATA_PLANE_URL ?? 'http://data-plane:3001',
    });
    return downloadWorkerInstance;
  }

  /**
   * Normalize a download-request identity body. No fuzzy title
   * matching: mediaId is required; TV demands exact S/E; movies must
   * not carry S/E. Title/year are descriptive-only (staging names).
   */
  function normalizeDownloadIdentity(body) {
    const mediaId = String(body?.mediaId ?? '').trim();
    if (!mediaId) return { error: 'mediaId is required' };
    const rawType = String(body?.mediaType ?? 'movie').trim().toLowerCase();
    const seasonRaw = body?.season ?? null;
    const episodeRaw = body?.episode ?? null;
    const season = seasonRaw == null || seasonRaw === '' ? null : parseInt(seasonRaw, 10);
    const episode = episodeRaw == null || episodeRaw === '' ? null : parseInt(episodeRaw, 10);
    if (rawType === 'movie') {
      if (season != null || episode != null) {
        return { error: 'movie download must not carry season/episode' };
      }
      return { mediaId, mediaType: 'movie', season: null, episode: null };
    }
    if (rawType === 'episode' || rawType === 'series' || rawType === 'tv' || rawType === 'show') {
      if (!Number.isSafeInteger(season) || season < 1
        || !Number.isSafeInteger(episode) || episode < 1) {
        return { error: 'TV download requires exact season and episode (>= 1)' };
      }
      return { mediaId, mediaType: 'episode', season, episode };
    }
    return { error: 'mediaType must be movie or episode (series/tv accepted with season+episode)' };
  }

  // Scheduler nudge hook (availability tranche). The process owner
  // (index.js) may inject a callback that pulls the next anticipation
  // tick forward; absent in tests and minimal embeddings.
  const schedulingNudge = typeof dependencies.schedulingNudge === 'function'
    ? dependencies.schedulingNudge
    : null;

  // Arr sync instance for the manual trigger. Same construction as the
  // index.js scheduler; sync operations are idempotent across instances.
  let arrSyncInstance = dependencies.arrSync ?? null;
  function getArrSync() {
    if (!arrSyncInstance) {
      const hasRadarr = !!(env.RADARR_URL && env.RADARR_API_KEY);
      const hasSonarr = !!(env.SONARR_URL && env.SONARR_API_KEY);
      if (!hasRadarr && !hasSonarr) return null;
      arrSyncInstance = createArrSync({
        db: searchCache.db,
        radarr: hasRadarr ? createArrClient({ baseUrl: env.RADARR_URL, apiKey: env.RADARR_API_KEY }) : null,
        sonarr: hasSonarr ? createArrClient({ baseUrl: env.SONARR_URL, apiKey: env.SONARR_API_KEY }) : null,
      });
    }
    return arrSyncInstance;
  }

  // Wire Plex refresh coalescer accounting into the live metrics
  // counters so /api/metrics surfaces the same numbers the notifier
  // tracks. The notifier emits a snapshot per change; we forward it
  // verbatim to the metrics module.
  bindPlexMetricsSink((snap) => {
    setPlexRefreshAccount(snap);
  });

  // Availability revalidator for playback-time TorBox checks
  // Configured via STREAM_AVAILABILITY_MAX_AGE_MS and STREAM_PROVIDER_CHECK_TIMEOUT_MS
  const terminalEvidenceTtlMs = env.STREAM_TERMINAL_EVIDENCE_TTL_MS
    ? parseInt(env.STREAM_TERMINAL_EVIDENCE_TTL_MS, 10)
    : 10 * 60 * 1000;
  const terminalEvidenceStore = dependencies.terminalEvidenceStore
    || createTerminalDeliveryEvidenceStore({
      controlPlaneStore,
      terminalTtlMs: terminalEvidenceTtlMs,
      now: clock,
    });
  const revalidator = dependencies.revalidator || createRevalidator({
    checkTorBoxCached,
    now: clock,
    maxAgeMs: env.STREAM_AVAILABILITY_MAX_AGE_MS
      ? parseInt(env.STREAM_AVAILABILITY_MAX_AGE_MS, 10)
      : 5 * 60 * 1000,
    checkTimeoutMs: env.STREAM_PROVIDER_CHECK_TIMEOUT_MS
      ? parseInt(env.STREAM_PROVIDER_CHECK_TIMEOUT_MS, 10)
      : 3000,
    apiKey: env.TORBOX_API_KEY,
    terminalEvidenceStore,
    placementLookup: (infoHash, fileIndex) => {
      const placement = controlPlaneStore.findPlacementByInfoHash('torbox', infoHash);
      if (!placement) return null;
      const files = controlPlaneStore.listProviderFiles(placement.id);
      const match = files.find((f) => Number(f.corpusFileIndex) === Number(fileIndex))
        || (files.length === 1 ? files[0] : null);
      if (!match) return null;
      return {
        provider: placement.provider,
        accountScope: placement.accountScope || 'default',
        placementId: placement.id,
        providerFileId: match.providerFileId,
      };
    },
  });

  // Real-Debrid client for preferred delivery (resolver-safe mode)
  // Only created if API key is configured; otherwise RD delivery is skipped.
  // Interactive resolver uses lower min interval (100ms) for faster playback
  // while still respecting 429/cooldown. Background probing keeps 500ms default.
  const rdClient = dependencies.rdClient || (env.REALDEBRID_API_KEY
    ? createRealDebridClient({ apiKey: env.REALDEBRID_API_KEY, minIntervalMs: 100 })
    : null);

  // Short-lived RD resolution cache to avoid repeated RD transactions for
  // media-server stream probing (multiple requests in <10s).
  const rdResolutionCache = dependencies.rdResolutionCache || getRdResolutionCache();

  // Alternate candidate fallback for when primary selection is unavailable.
  // Wire RD so the fallback chain can resolve via Real-Debrid when TorBox
  // returns UNCACHED/UNKNOWN or its cached delivery URL is stale.
  const alternateFallback = dependencies.alternateFallback || createAlternateFallback({
    searchCache,
    revalidator,
    now: clock,
    rdClient,
    rdResolutionCache,
  });

  // TorBox delivery owns placement creation and passive account-inventory recovery.
  const torBoxProvider = dependencies.torBoxProvider || createTorBoxProvider({
    apiKey: env.TORBOX_API_KEY,
  });
  const torBoxInventoryProvider = dependencies.torBoxInventoryProvider
    || (env.TORBOX_API_KEY ? createTorBoxInventoryProvider({
      apiKey: env.TORBOX_API_KEY,
      apiBase: env.TORBOX_API_URL,
      now: clock,
    }) : null);

  // Single entry point for TorBox delivery resolution (owns placement lifecycle)
  const resolveTorBoxDelivery = dependencies.resolveTorBoxDelivery || (async ({
    infoHash,
    fileIndex,
    releaseKey,
    filename,
  }) => ensureTorBoxDelivery({
    infoHash,
    fileIndex,
    releaseKey,
    filename,
    controlPlaneStore,
    torBoxProvider,
    torBoxInventoryProvider,
    now: clock,
  }));
  const torBoxDownloadUrlCache = wrapTorBoxDownloadUrlCacheWithAccounting(
    dependencies.torBoxDownloadUrlCache || getTorBoxDownloadUrlCache()
  );
  const resolveTorBoxDownloadUrlFn = dependencies.resolveTorBoxDownloadUrl || resolveTorBoxDownloadUrl;
  const isTorBoxDownloadUrlLive = dependencies.isTorBoxDownloadUrlLive || isUrlLive;

  // Authoritative TorBox delivery seam that owns the requestdl step and
  // the bounded stale-placement repair. The CDN URL cache is consulted
  // by this seam so recovery and non-recovery paths share the same
  // short-lived URL lifecycle.
  const resolveTorBoxDeliverySeam = dependencies.resolveTorBoxDeliverySeam || (async ({
    infoHash,
    fileIndex,
    releaseKey,
    filename,
  }) => resolveTorBoxDeliveryWithStaleRecovery({
    infoHash,
    fileIndex,
    releaseKey,
    filename,
    controlPlaneStore,
    torBoxProvider,
    torBoxInventoryProvider,
    torBoxDownloadUrlCache,
    resolveTorBoxDownloadUrl: resolveTorBoxDownloadUrlFn,
    isUrlLive: isTorBoxDownloadUrlLive,
    now: clock,
    terminalEvidenceStore,
  }));

  // Slice 1.75: pre-publication TorBox file identity binding seam. The
  // helper is only available when both the control plane and the TorBox
  // provider are configured; in that case the same factory is reused for
  // every ingress path so the seam has a single source of truth.
  const hasExplicitEnsureFn = dependencies.ensureTorBoxFileIdentity != null;
  const ensureTorBoxFileIdentityFn = dependencies.ensureTorBoxFileIdentity || (controlPlaneStore && torBoxProvider && torBoxInventoryProvider
    ? (params) => ensureTorBoxFileIdentity({
      ...params,
      controlPlaneStore,
      torBoxProvider,
      torBoxInventoryProvider,
      now: clock,
    })
    : null);

  // T10: playback-intent-triggered redundancy activation. Default OFF:
  // DATA_PLANE_PLAYBACK_REDUNDANCY=1 enables it (deprecated
  // HY4_PLAYBACK_REDUNDANCY also accepted). With the flag OFF the
  // controller is null and the VFS Range path is byte-identical to the
  // pre-T10 baseline (zero redundancy calls). With the flag ON, the first
  // qualifying foreground Range demand per TF schedules one bounded
  // T7 -> T6 chain (refresh/retry runs server-side inside the T5 Rust
  // prewarm endpoint); the Range request itself never awaits it.
  // Injectable via dependencies for deterministic tests.
  const playbackRedundancy = dependencies.playbackRedundancy !== undefined
    ? dependencies.playbackRedundancy
    : (() => {
      if (!isPlaybackRedundancyEnabled(env)) return null;
      if (!controlPlaneStore) return null;
      // T7 TorBox surface adapted from the existing provider stack
      // (cached-only creation semantics preserved; no new TorBox logic).
      const t7Torbox = (torBoxProvider && torBoxInventoryProvider) ? {
        createPlacement: (input) => torBoxProvider
          .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE).createPlacement(input),
        checkCached: (hashes) => checkTorBoxCached(hashes, { apiKey: env.TORBOX_API_KEY }),
        lookupPlacement: (input, ctx) => torBoxInventoryProvider
          .require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP).lookupPlacement(input, ctx),
        getFileInventory: (resource, ctx) => torBoxInventoryProvider
          .require(PROVIDER_CAPABILITIES.FILE_INVENTORY).getFileInventory(resource, ctx),
      } : null;
      // T7 Real-Debrid surface is the existing rdClient verbatim
      // (listTorrents/getTorrentInfo/addMagnet/selectFiles).
      const t7RealDebrid = rdClient ? {
        listTorrents: (args) => rdClient.listTorrents(args),
        getTorrentInfo: (id, opts) => rdClient.getTorrentInfo(id, opts),
        addMagnet: (magnet, opts) => rdClient.addMagnet(magnet, opts),
        selectFiles: (id, ids, opts) => rdClient.selectFiles(id, ids, opts),
      } : null;
      if (!t7Torbox && !t7RealDebrid) return null;
      const ensurer = createSecondPlacementEnsurer({
        store: controlPlaneStore,
        torbox: t7Torbox,
        realdebrid: t7RealDebrid,
        now: clock,
      });
      const prewarmCaller = createPrewarmCaller({
        store: controlPlaneStore,
        dataPlaneBaseUrl: env.DATA_PLANE_URL ?? 'http://data-plane:3001',
      });
      return createPlaybackRedundancy({
        store: controlPlaneStore,
        ensurer,
        prewarmCaller,
        now: clock,
        logger: (...args) => console.log(...args),
        enabled: true,
      });
    })();

  const handleMovieWebDav = createMovieWebDav({
    searchCache,
    controlPlaneStore,
    rdClient,
    rdResolutionCache,
    resolveTorBoxDeliverySeam,
    torBoxDownloadUrlCache,
    // P5: reuse the EXISTING persisted-candidate fallback seam in the VFS
    // (tfId-present class-D exhaustion → alternate TorrentFile → re-forward to Rust).
    alternateFallback,
    terminalEvidenceStore,
    // T10: playback-intent-triggered redundancy activation. Default OFF
    // (DATA_PLANE_PLAYBACK_REDUNDANCY=1 to enable; deprecated
    // HY4_PLAYBACK_REDUNDANCY also accepted); OFF means the controller is
    // null and byte serving is byte-identical to the pre-T10 baseline.
    playbackRedundancy,
    now: clock,
    // P4: forward VFS byte reads to the Rust data plane. Default is the
    // compose-network service name; override via DATA_PLANE_URL. No hardcoded
    // host IPs (P4 §9).
    dataPlaneBaseUrl: env.DATA_PLANE_URL ?? 'http://data-plane:3001',
  });
  const handleTvWebDav = createTvWebDav({
    searchCache,
    controlPlaneStore,
    rdClient,
    rdResolutionCache,
    resolveTorBoxDeliverySeam,
    torBoxDownloadUrlCache,
    // P5: reuse the EXISTING persisted-candidate fallback seam in the VFS
    // (tfId-present class-D exhaustion → alternate TorrentFile → re-forward to Rust).
    alternateFallback,
    terminalEvidenceStore,
    // T10: same controller instance as movies (per-TF flight map is shared).
    playbackRedundancy,
    now: clock,
    dataPlaneBaseUrl: env.DATA_PLANE_URL ?? 'http://data-plane:3001',
  });

  // Eager VFS metadata hydrators used by the request completion path so
  // that PROPFIND advertises the real file size before notifyPlex() fires.
  // Wired from the same VFS factories that serve the WebDAV endpoints so
  // they share the existing ensureMetadata/loadMetadata machinery and the
  // internal state map — no provider code duplication.
  const hydrateVfsForRequest = {
    hydrateMovie: (releaseKey) => handleMovieWebDav.hydrateVfsMovieEntry(releaseKey),
    hydrateTv: ({ mediaId, season, episode }) => handleTvWebDav.hydrateVfsTvEntry({ mediaId, season, episode }),
  };

  // Root VFS handler — lists Movies and TV collections
  async function handleVfsRoot(request, response, url) {
    const pathname = decodeURIComponent(url.pathname);
    if (pathname !== '/vfs' && pathname !== '/vfs/') return false;
    const method = request.method?.toUpperCase();
    if (method === 'OPTIONS') {
      response.writeHead(200, {
        allow: 'OPTIONS, PROPFIND, HEAD, GET',
        dav: '1',
        'content-length': '0',
      });
      response.end();
      return true;
    }
    if (method === 'PROPFIND') {
      const now = Date.now();
      const entries = [
        { path: '/vfs/Movies', name: 'Movies', type: 'collection' },
        { path: '/vfs/TV', name: 'TV', type: 'collection' },
      ];
      const body = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' +
        entries.map(e => '<d:response><d:href>' + e.path + '/</d:href><d:propstat><d:prop>' +
          '<d:displayname>' + e.name + '</d:displayname>' +
          '<d:resourcetype><d:collection/></d:resourcetype>' +
          '<d:getlastmodified>' + new Date(now).toUTCString() + '</d:getlastmodified>' +
          '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join('') +
        '</d:multistatus>';
      response.writeHead(207, {
        'content-type': 'application/xml; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        dav: '1',
        'cache-control': 'no-store',
      });
      response.end(body);
      return true;
    }
    return false;
  }

  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (await handleVfsRoot(request, response, url)) return;
      if (await handleMovieWebDav(request, response, url)) return;
      if (await handleTvWebDav(request, response, url)) return;
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, liveness());
      }
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        const ready = readiness({ env });
        return sendJson(response, ready.status === 'healthy' ? 200 : 503, ready);
      }
      // Stream resolver endpoint — answers "where should playback redirect?"
      // Route pattern: GET /stream/:type/:id (e.g., /stream/movie/tt1234567)
      // ID may be colon-separated (e.g., tt0944947:1:1 for series episodes)
      const streamMatch = request.method === 'GET' && url.pathname.match(/^\/stream\/(movie|series)\/([^/?]+)$/i);
      if (streamMatch) {
        const mediaType = streamMatch[1].toLowerCase();
        const rawId = streamMatch[2];
        const season = url.searchParams.get('season');
        const episode = url.searchParams.get('episode');
        const resolverStartTime = clock();
        let telemetryRecorded = false;
        const profiler = createResolverProfiler({ now: clock });
        profiler.start();

        /**
         * Record resolver telemetry for this attempt.
         * Fire-and-forget: errors are caught, never block resolution.
         */
        const recordTelemetry = (outcome, failureCode, redirectStatus, extra = {}) => {
          if (telemetryRecorded || !eventStore) return;
          telemetryRecorded = true;
          const resolverTelemetry = createResolverTelemetry({ eventStore, now: clock });
          resolverTelemetry.recordAttempt({
            mediaId: rawId,
            mediaType,
            infoHash: extra.infoHash ?? null,
            releaseKey: extra.releaseKey ?? null,
            provider: extra.provider ?? null,
            availabilitySource: extra.availabilitySource ?? null,
            providerCheckOccurred: extra.providerCheckOccurred ?? null,
            outcome,
            failureCode,
            redirectStatus,
            durationMs: clock() - resolverStartTime,
            // Preserve fallback telemetry fields if present
            ...(extra.fallbackUsed != null ? { fallbackUsed: extra.fallbackUsed } : {}),
            ...(extra.originalReleaseKey != null ? { originalReleaseKey: extra.originalReleaseKey } : {}),
            ...(extra.selectedReleaseKey != null ? { selectedReleaseKey: extra.selectedReleaseKey } : {}),
            ...(extra.fallbackRank != null ? { fallbackRank: extra.fallbackRank } : {}),
            ...(extra.reason != null ? { reason: extra.reason } : {}),
          });
        };

        try {
          const identity = parseMediaIdentity({
            mediaId: rawId,
            mediaType,
            season: season != null ? parseInt(season, 10) : null,
            episode: episode != null ? parseInt(episode, 10) : null,
          });

          /* FOREGROUND RESOLUTION LADDER
           * 0. Permanent local file (promotion tranche) — same URL, owned
           *    bytes, zero provider calls. STRM content never changes;
           *    only the backing does, so no republication, no duplicate
           *    consumer items, no refresh.
           * 1. Existing selection → if provider !== 'torbox' → 400
           * 2. RD warm capability (rdResolutionCache hit) → 307 RD
           * 3. RD stale capability → bounded attemptRdResolution → if resolved → 307 RD
           * 4. TorBox warm capability (delivery-seam cache hit) → 307 TorBox
           * 5. TorBox revalidation (fresh observation → 307; stale → bounded check)
           * 6. TorBox unusable → tryAlternateCandidateFallback
           *    a. Persisted ranked candidates (same infoHash, RD-usable) → 307 RD
           *    b. Persisted ranked candidates (other candidate) → TorBox seam → 307
           * 7. All fail → typed failure
           */
          try {
            const promoStore = getPromotionStore();
            if (promoStore) {
              const promoMediaType = mediaType === 'series' ? 'episode' : 'movie';
              const promo = promoStore.getByMedia({
                mediaId: rawId,
                mediaType: promoMediaType,
                season: identity.season ?? null,
                episode: identity.episode ?? null,
              });
              if (promo && promo.status === PROMOTION_STATUS.PERMANENT && promo.permanentPath) {
                const served = serveLocalFile(response, promo.permanentPath, request.headers?.range);
                if (served) {
                  recordTelemetry(RESOLVER_OUTCOME.REDIRECTED, null, response.statusCode, {
                    provider: 'permanent',
                    availabilitySource: 'owned-storage',
                    providerCheckOccurred: false,
                  });
                  profiler.mark('permanent-served');
                  return;
                }
                // Permanent row but bytes unreadable: fall through to the
                // provider ladder so playback survives storage trouble.
              }
            }
          } catch {
            // Promotion lookup never blocks provider-backed playback.
          }

          // 1. Check for existing persisted selection first
          // Series requests MUST be keyed on (mediaId, season, episode) because
          // each episode has its own playback_handoffs row. Using
          // getExistingSelection (mediaId-only) returns the latest handoff for
          // the media_id regardless of episode, which is the wrong episode.
          // Movies keep the mediaId-only lookup unchanged.
          let existingSelection;
          if (mediaType === 'series' && identity.season != null && identity.episode != null
              && typeof searchCache.getTvPlaybackHandoff === 'function') {
            const tvHandoff = searchCache.getTvPlaybackHandoff(
              rawId,
              identity.season,
              identity.episode,
            );
            existingSelection = tvHandoff ? adaptTvHandoffToSelection(tvHandoff) : null;
          } else {
            existingSelection = searchCache.getExistingSelection(rawId);
          }
          profiler.mark('handoff-loaded');
          // Accept both 'selected' and 'debug' status — 'debug' means the handoff exists
          // but provider state is not usable, which triggers revalidation and potential fallback
          if (existingSelection && (existingSelection.status === 'selected' || existingSelection.status === 'debug')) {
            // 1a. Selected candidate must be resolvable for redirect.
            // TorBox handoffs go through the TorBox sections below; RD
            // handoffs resolve via the RD block above (preferred delivery)
            // and must never enter TorBox revalidation/delivery. Anything
            // else is not resolvable by this route.
            if (existingSelection.provider !== 'torbox' && existingSelection.provider !== 'realdebrid') {
              recordTelemetry(RESOLVER_OUTCOME.FAILED, 'PROVIDER_NOT_TORBOX', null, {
                provider: existingSelection.provider,
              });
              return sendJson(response, 400, {
                error: `Provider '${existingSelection.provider}' is not resolvable via TorBox`,
                code: 'PROVIDER_NOT_TORBOX',
                mediaId: rawId,
                mediaType,
              });
            }
            // 1b. Attempt Real-Debrid as preferred delivery.
            // Ordering: rdResolutionCache hit → RD; miss → always attempt bounded
            // attemptRdResolution. RD observations (5min TTL) must not gate the
            // rdResolutionCache-miss path — the 30s RD resolution cache may be
            // stale while the underlying RD torrent is still resolvable. The
            // attemptRdResolution function handles stale/missing observations
            // internally (e.g. cross-provider add for previously-uncached).
            // RD must not require TorBox revalidation to fail before being attempted.
            if (rdClient && controlPlaneStore) {
              // Check short-lived RD resolution cache first
              const cachedRd = rdResolutionCache.get(existingSelection.selectedHash, existingSelection.fileIndex);
              if (cachedRd) {
                profiler.mark('rd-resolution-cache-hit');
                console.log('[resolver-profile] RD cache hit');
                recordTelemetry(RESOLVER_OUTCOME.REDIRECTED, null, 307, {
                  infoHash: existingSelection.selectedHash,
                  releaseKey: existingSelection.releaseKey,
                  provider: 'realdebrid',
                  availabilitySource: 'cache',
                  providerCheckOccurred: true,
                });
                profiler.mark('307-returned');
                response.writeHead(307, {
                  location: cachedRd.url,
                  'cache-control': 'no-store',
                  'x-torrent-id': cachedRd.torrentId,
                  'x-file-id': cachedRd.rdFileId,
                  'x-availability-source': 'cache',
                  'x-provider-check-occurred': 'true',
                  'x-url-live-checked': 'true',
                  'x-rd-resolution-cache': 'hit',
                  'x-resolver-profile': JSON.stringify(profiler.summary()),
                });
                response.end();
                return;
              }

              // RD resolution cache miss — always attempt bounded RD resolution.
              // The attemptRdResolution function itself handles stale/missing
              // observations correctly (e.g. uncached → resolve via cross-provider
              // add). The rdObsState guard previously here was incorrect: when
              // the cached RD URL expired (30s TTL) but the 5min RD observation
              // was still 'uncached', RD was wrongly skipped even though it
              // could resolve the same TorrentFile cross-provider.
              try {
                const candidate = searchCache.getCandidate(existingSelection.selectedHash, existingSelection.fileIndex);

                // Use in-flight coalescing for concurrent same-key requests
                const rdResult = await rdResolutionCache.getOrInFlight(
                  existingSelection.selectedHash,
                  existingSelection.fileIndex,
                  async () => attemptRdResolution(rdClient, searchCache, {
                    infoHash: existingSelection.selectedHash,
                    fileIndex: existingSelection.fileIndex,
                    filename: candidate?.filename ?? null,
                    size: candidate?.size ?? null,
                  }, { now: clock })
                );

                profiler.mark('rd-resolution-attempt');
                if (rdResult.timing) {
                  console.log('[resolver-profile] RD detail:', JSON.stringify(rdResult.timing));
                }

                if (rdResult.status === 'resolved') {
                  const playbackUrl = await getRdPlaybackUrl(rdClient, rdResult.torrentInfo, rdResult.rdFileId);
                  profiler.mark('rd-unrestrict');
                  // Liveness check: verify the RD URL returns bytes before committing to 307
                  const rdLive = await isUrlLive(playbackUrl);
                  profiler.mark('rd-liveness-check');
                  if (rdLive) {
                    // Cache the successful resolution
                    rdResolutionCache.set(
                      existingSelection.selectedHash,
                      existingSelection.fileIndex,
                      playbackUrl,
                      rdResult.torrentId,
                      rdResult.rdFileId,
                    );

                    recordTelemetry(RESOLVER_OUTCOME.REDIRECTED, null, 307, {
                      infoHash: existingSelection.selectedHash,
                      releaseKey: existingSelection.releaseKey,
                      provider: 'realdebrid',
                      availabilitySource: 'observation',
                      providerCheckOccurred: true,
                    });
                    profiler.mark('307-returned');
                    response.writeHead(307, {
                      location: playbackUrl,
                      'cache-control': 'no-store',
                      'x-torrent-id': rdResult.torrentId,
                      'x-file-id': rdResult.rdFileId,
                      'x-availability-source': 'observation',
                      'x-provider-check-occurred': 'true',
                      'x-url-live-checked': 'true',
                      'x-rd-resolution-cache': 'miss',
                      'x-resolver-profile': JSON.stringify(profiler.summary()),
                    });
                    response.end();
                    return;
                  }
                  // RD URL dead — fall through to TorBox
                }
                // RD did not resolve — fall through to TorBox
              } catch (rdError) {
                profiler.mark('rd-resolution-failed');
                // RD failure must never block TorBox fallback
              }
            }

            // 1b-RD terminal: an RD handoff whose RD resolution failed
            // above has no TorBox sections to fall into (wrong provider,
            // and TorBox calls would be noise). Typed failure, no TorBox
            // traffic. TorBox handoffs continue to 1c below unchanged.
            if (existingSelection.provider === 'realdebrid') {
              recordTelemetry(RESOLVER_OUTCOME.FAILED, 'RD_UNRESOLVABLE', null, {
                infoHash: existingSelection.selectedHash,
                releaseKey: existingSelection.releaseKey,
                provider: 'realdebrid',
              });
              return sendJson(response, 502, {
                error: 'Real-Debrid could not resolve a playable URL for this release',
                code: 'RD_UNRESOLVABLE',
                mediaId: rawId,
                mediaType,
              });
            }

            // 1c. Revalidate availability before redirect
            const revalidation = await revalidator.revalidateAvailability({
              cache: searchCache,
              infoHash: existingSelection.selectedHash,
              fileIndex: existingSelection.fileIndex,
              mediaId: rawId,
              releaseKey: existingSelection.releaseKey,
              provider: existingSelection.provider,
            });
            profiler.mark('torbox-revalidation');
            const httpOutcome = mapRevalidationToHttp(revalidation);
            if (!httpOutcome.shouldRedirect) {
              // Try alternate candidate fallback before returning typed failure.
              // The fallback path uses the SAME authoritative TorBox delivery
              // seam as the primary path: reuse / passively recover / cached-only
              // create placement, then establish the exact provider-file mapping.
              const fallbackAttempted = await tryAlternateCandidateFallback({
                searchCache,
                alternateFallback,
                revalidator,
                controlPlaneStore,
                resolveTorBoxDeliverySeam,
                existingSelection,
                primaryRevalidation: revalidation,
                rawId,
                mediaType,
                recordTelemetry,
                response,
                sendJson,
                clock,
              });
              if (fallbackAttempted) return;

              // No usable alternate — return original typed failure
              recordTelemetry(RESOLVER_OUTCOME.FAILED, httpOutcome.body.code, null, {
                infoHash: existingSelection.selectedHash,
                releaseKey: existingSelection.releaseKey,
                provider: existingSelection.provider,
                availabilitySource: revalidation.availabilitySource,
                providerCheckOccurred: revalidation.providerCheckOccurred,
              });
              return sendJson(response, httpOutcome.status, {
                ...httpOutcome.body,
                availabilitySource: revalidation.availabilitySource,
                providerCheckOccurred: revalidation.providerCheckOccurred,
                checkLatencyMs: revalidation.checkLatencyMs,
              });
            }

            // 1d. Resolve TorBox delivery through the authoritative seam when
            // the control plane is available. The seam owns the placement
            // lifecycle, the requestdl step, the short-lived CDN URL cache,
            // and the bounded stale-placement repair for a requestdl failure
            // that can represent a missing upstream resource.
            if (controlPlaneStore) {
              try {
                const delivery = await resolveTorBoxDeliverySeam({
                  infoHash: existingSelection.selectedHash,
                  fileIndex: existingSelection.fileIndex,
                  releaseKey: existingSelection.releaseKey,
                  filename: existingSelection.filename,
                });
                profiler.mark('torbox-delivery-resolved');
                if (delivery.recovered) profiler.mark('torbox-delivery-recovered');

                recordTelemetry(RESOLVER_OUTCOME.REDIRECTED, null, 307, {
                  infoHash: existingSelection.selectedHash,
                  releaseKey: existingSelection.releaseKey,
                  provider: existingSelection.provider,
                  availabilitySource: revalidation.availabilitySource,
                  providerCheckOccurred: revalidation.providerCheckOccurred,
                });
                profiler.mark('307-returned');
                response.writeHead(307, {
                  location: delivery.url,
                  'cache-control': 'no-store',
                  'x-torrent-id': delivery.placementId,
                  'x-file-id': delivery.providerFileId,
                  'x-availability-source': revalidation.availabilitySource,
                  'x-provider-check-occurred': revalidation.providerCheckOccurred ? 'true' : 'false',
                  'x-url-live-checked': 'true',
                  'x-resolver-profile': JSON.stringify(profiler.summary()),
                });
                response.end();
                return;
              } catch (deliveryErr) {
                if (deliveryErr instanceof TorBoxDeliveryError || deliveryErr instanceof TorBoxDownloadUrlError) {
                  recordTelemetry(RESOLVER_OUTCOME.FAILED, deliveryErr.code, null, {
                    infoHash: existingSelection.selectedHash,
                    releaseKey: existingSelection.releaseKey,
                    provider: existingSelection.provider,
                    availabilitySource: revalidation.availabilitySource,
                    providerCheckOccurred: revalidation.providerCheckOccurred,
                  });
                  return sendJson(response, deliveryErr.status, {
                    error: deliveryErr.message,
                    code: deliveryErr.code,
                    mediaId: rawId,
                    mediaType,
                  });
                }
                throw deliveryErr;
              }
            }
            // 1d. No control plane store — return selection JSON (legacy behavior)
            recordTelemetry(RESOLVER_OUTCOME.FAILED, 'NO_CONTROL_PLANE', null, {
              infoHash: existingSelection.selectedHash,
              releaseKey: existingSelection.releaseKey,
              provider: existingSelection.provider,
            });
            return sendJson(response, 200, existingSelection);
          }

          // 2. Fall back to resolver stub
          const result = await resolveStream(identity);
          if (result.status === 'not_implemented') {
            const failureCode = existingSelection ? 'SELECTION_NOT_USABLE' : 'NO_SELECTION';
            recordTelemetry(RESOLVER_OUTCOME.FAILED, failureCode, null, {
              infoHash: existingSelection?.selectedHash,
              releaseKey: existingSelection?.releaseKey,
              provider: existingSelection?.provider,
            });
            // Merge stored knowledge into debug response
            const debugResponse = existingSelection
              ? { ...existingSelection, resolverStatus: result.status, provider: null, redirectUrl: null }
              : {
                  status: 'debug',
                  mediaId: rawId,
                  mediaType,
                  resolverStatus: result.status,
                  provider: null,
                  redirectUrl: null,
                  candidates: [],
                  message: 'No stored knowledge found',
                };
            return sendJson(response, 501, debugResponse);
          }
          recordTelemetry(RESOLVER_OUTCOME.REDIRECTED, null, 200, {
            provider: result.provider,
          });
          return sendJson(response, 200, result);
        } catch (err) {
          if (err instanceof StreamResolverError) {
            recordTelemetry(RESOLVER_OUTCOME.FAILED, err.code, null);
            return sendJson(response, err.status, { error: err.message });
          }
          throw err;
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/metrics') {
        return sendJson(response, 200, getMetrics());
      }
      if (request.method === 'GET' && url.pathname === '/api/debug/enrichment') {
        const diagnostics = getEnrichmentDiagnostics(searchCache);
        const format = url.searchParams.get('format');
        if (format === 'text') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end(formatEnrichmentDiagnostics(diagnostics));
          return;
        }
        return sendJson(response, 200, diagnostics);
      }
      // Cache-intelligence diagnostics — read-only operator visibility
      // into provider observations, TorBox current state, and probe queue.
      if (request.method === 'GET' && url.pathname === '/api/debug/cache-intelligence') {
        return sendJson(response, 200, searchCache.getCacheIntelligence());
      }
      // Provider accounting — bounded in-process counters grouped by
      // provider and logical operation. Supports ?since=<epochMs> for
      // a delta snapshot and ?format=text for a concise terminal report.
      if (request.method === 'GET' && url.pathname === '/api/debug/provider-accounting') {
        return handleProviderAccountingDebug(response, url);
      }
      if (request.method === 'POST' && url.pathname === '/api/debug/provider-accounting/reset') {
        // Reset is an operator-grade action but not secret-bearing.
        // The reset call is bounded in scope: only zeros the in-memory
        // counter; the next call after reset observes a clean baseline.
        providerAccounting.reset();
        return sendJson(response, 200, { ok: true, resetAt: new Date().toISOString() });
      }
      if (request.method === 'GET' && url.pathname === '/api/debug/discovery-accounting') {
        return handleDiscoveryAccountingDebug(response, url);
      }
      if (request.method === 'POST' && url.pathname === '/api/debug/discovery-accounting/reset') {
        discoveryAccounting.reset();
        return sendJson(response, 200, { ok: true, resetAt: new Date().toISOString() });
      }
      const debugMatch = request.method === 'GET' && url.pathname.match(/^\/api\/debug\/request\/([0-9a-f-]{36})$/i);
      if (debugMatch) {
        const debug = await getRequestDebug(debugMatch[1], { env });
        // Support text output for terminal/console consumption
        const format = url.searchParams.get('format');
        if (format === 'text') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          if (!debug.found) {
            response.end(`REQUEST NOT FOUND\n\nRequest ID: ${debugMatch[1]}`);
            return;
          }
          // Check if this is a failed request - use failed formatter
          const timing = debug.timing || debug.request?.timing;
          if (timing?.failure || debug.finalState?.status === 'failed') {
            response.end(formatFailedRequest(debug));
            return;
          }
          response.end(formatRequestTiming(timing));
          return;
        }
        return sendJson(response, debug.found ? 200 : 404, debug);
      }
      if (request.method === 'GET' && url.pathname === '/api/debug/search-trace') {
        const startedAt = performance.now();
        const params = url.searchParams;
        const query = params.get('q') || '';
        if (!query || query.length < 2) {
          return sendJson(response, 400, { error: 'Query must be at least 2 characters' });
        }
        const mediaId = params.get('mediaId');
        const type = params.get('type');
        const intent = mediaId && type ? createRequestIntent({ type, mediaId }) : null;
        const trace = await searchTrace(searchCache, {
          query,
          year: params.get('year') ? parseInt(params.get('year'), 10) : undefined,
          season: intent?.season,
          episode: intent?.episodes?.[0],
          resolution: params.get('resolution') || undefined,
          source: params.get('source') || undefined,
          codec: params.get('codec') || undefined,
          hdr: params.get('hdr') === 'true' ? 1 : params.get('hdr') === 'false' ? 0 : undefined,
          audio: params.get('audio') || undefined,
          limit: params.get('limit') ? Math.min(parseInt(params.get('limit'), 10), 100) : 50,
          offset: params.get('offset') ? parseInt(params.get('offset'), 10) : 0,
          includeLive: true,
          mode: 'ui',
          mediaId: mediaId || null,
          liveDiscoveryFnWithCounts: mediaId
            ? async () => runLiveDiscoveryWithCounts(mediaId, {
                season: intent?.season,
                episode: intent?.episodes?.[0],
              })
            : null,
        });
        const output = {
          ...trace,
          timings: { totalMs: Math.round(performance.now() - startedAt) },
        };
        // Persist decision record (fire-and-forget, non-blocking)
        if (params.get('record') !== 'false') {
          try {
            const decision = decisionFromTrace(trace, mediaId);
            searchDecisionStore.recordDecision(decision);
          } catch (e) {
            // Decision storage failure must not break search
            emit(EVENTS.DISCOVERY_ERROR, { scope: 'search-decision', error: e.message });
          }
        }
        // Support text output for terminal/console consumption
        if (params.get('format') === 'text') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end(formatSearchTrace(output));
          return;
        }
        // Support timing-only output
        if (params.get('format') === 'timing') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end(formatSearchTiming(output.timing));
          return;
        }
        return sendJson(response, 200, output);
      }
      // Stored search decisions — for cache confidence model training
      if (request.method === 'GET' && url.pathname === '/api/debug/search-decisions') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
        const query = url.searchParams.get('q');
        const decisions = query
          ? searchDecisionStore.getDecisionsByQuery(query, limit)
          : searchDecisionStore.getRecentDecisions(limit);
        // Support timing comparison output
        if (url.searchParams.get('format') === 'timing') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf8', 'cache-control': 'no-store' });
          response.end(formatTimingComparison(decisions.map(d => d.timing || {})));
          return;
        }
        return sendJson(response, 200, {
          total: searchDecisionStore.countDecisions(),
          decisions,
        });
      }
      // Resolver telemetry — recent /stream/:type/:id resolution attempts
      if (request.method === 'GET' && url.pathname === '/api/debug/resolver-telemetry') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
        const records = getRecentResolverTelemetry(eventStore, { limit });
        return sendJson(response, 200, {
          total: records.length,
          records,
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/control-plane/health') {
        return sendJson(response, 200, controlPlaneHealth({ now: clock }));
      }
      // Product library listing: what is in the library and is it
      // published? Derived from library_items + handoffs + VFS rows +
      // TorrentFile + serving coordinates. See lib/library/listing.js.
      if (request.method === 'GET' && url.pathname === '/api/library') {
        requireControlPlaneStore(controlPlaneStore);
        const limit = parseBoundedLimit(url.searchParams.get('limit'));
        const mediaType = url.searchParams.get('mediaType');
        if (mediaType != null && mediaType !== 'movie' && mediaType !== 'episode') {
          return sendJson(response, 400, { error: 'mediaType must be movie or episode' });
        }
        try {
          const result = listLibrary({
            cache: searchCache,
            controlPlaneStore,
            promotionStore: getPromotionStore(),
            limit,
            mediaType,
          });
          return sendJson(response, 200, { generatedAt: clock(), ...result });
        } catch (err) {
          return sendJson(response, 400, { error: err.message });
        }
      }
      // Consumer reconciliation: record presence/absence/UNKNOWN of
      // published items in playback-consumer libraries and, only when the
      // retirement policy enables it (default OFF), retire ELIGIBLE items
      // via the existing safe-unpublish path. See lib/consumers/.
      if (request.method === 'POST' && url.pathname === '/api/library/reconcile') {
        requireControlPlaneStore(controlPlaneStore);
        try {
          const summary = await runReconcile({ cache: searchCache, controlPlaneStore });
          return sendJson(response, 200, summary);
        } catch (err) {
          return sendJson(response, 500, { error: err.message });
        }
      }
      // Retirement dry-run planner: eligibility per published item with
      // exact ineligibility reasons. Read-only; never retires.
      if (request.method === 'GET' && url.pathname === '/api/library/retirement') {
        requireControlPlaneStore(controlPlaneStore);
        try {
          const policy = readRetirementPolicy();
          const { items } = listLibrary({ cache: searchCache, controlPlaneStore, promotionStore: getPromotionStore(), limit: 500 });
          const now = clock();
          const evaluations = items
            .filter((item) => item.state === 'published')
            .map((item) => {
              const rows = controlPlaneStore.listConsumerObservations({
                mediaId: item.mediaId,
              }).filter((o) => (o.season ?? null) === (item.season ?? null)
                && (o.episode ?? null) === (item.episode ?? null));
              // Presence detail is computed with the gate lifted so the
              // dry-run stays informative while disabled; eligibility
              // itself still honors the real policy below.
              const detail = evaluateRetirement(
                item, rows, { ...policy, enabled: true }, now,
              );
              let evalResult = policy.enabled
                ? detail
                : { ...detail, eligible: false, reason: 'POLICY_DISABLED' };
              // Arr lifecycle guard (same rule as the executor path).
              try {
                if (evalResult.eligible && searchCache?.db && isWantedByArr(searchCache.db, {
                  mediaId: item.mediaId, season: item.season, episode: item.episode,
                })) {
                  evalResult = { ...evalResult, eligible: false, reason: 'ARR_MONITORED' };
                }
              } catch {
                // Guard failure must never enable retirement.
              }
              return {
                mediaId: item.mediaId,
                season: item.season,
                episode: item.episode,
                title: item.title,
                state: item.state,
                presence: evalResult.presence,
                absenceAgeMs: evalResult.absenceAgeMs,
                eligible: evalResult.eligible,
                reason: evalResult.reason,
              };
            });
          return sendJson(response, 200, {
            generatedAt: now,
            policy: {
              enabled: policy.enabled,
              absenceGraceMs: policy.absenceGraceMs,
              observationMaxAgeMs: policy.observationMaxAgeMs,
              requiredConsumers: policy.requiredConsumers,
            },
            evaluations,
          });
        } catch (err) {
          return sendJson(response, 400, { error: err.message });
        }
      }
      // Rollout readiness diagnostics: storage, data-plane, providers,
      // consumers, publication, lifecycle. Cheap checks only, no secrets.
      // See lib/diagnostics/readiness.js.
      if (request.method === 'GET' && url.pathname === '/api/diagnostics') {
        requireControlPlaneStore(controlPlaneStore);
        try {
          const diagnostics = await buildDiagnostics({
            cache: searchCache,
            controlPlaneStore,
            env,
            listLibraryFn: listLibrary,
            retirementPolicy: readRetirementPolicy(),
            realDebridClientFactory: (opts) => createRealDebridClient({ ...opts, minIntervalMs: 100 }),
          });
          return sendJson(response, 200, { generatedAt: clock(), ...diagnostics });
        } catch (err) {
          return sendJson(response, 500, { error: err.message });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/control-plane/items') {
        requireControlPlaneStore(controlPlaneStore);
        const mediaId = url.searchParams.get('mediaId');
        const limit = parseBoundedLimit(url.searchParams.get('limit'));
        const items = controlPlaneStore.listLibraryItems({ mediaId, limit });
        return sendJson(response, 200, {
          generatedAt: clock(),
          items: items.map((item) => toControlPlaneItemSummary({
            item,
            canonicalPath: controlPlaneStore.getActiveCanonicalPath(item.id),
            bindings: controlPlaneStore.listBindings(item.id),
            lifecycle: controlPlaneStore.getLifecycle(item.id),
          })),
        });
      }
      const controlPlaneItemMatch = request.method === 'GET'
        && url.pathname.match(/^\/api\/control-plane\/items\/(li_[a-z0-9_-]+)$/i);
      if (controlPlaneItemMatch) {
        requireControlPlaneStore(controlPlaneStore);
        const item = controlPlaneStore.getLibraryItem(controlPlaneItemMatch[1]);
        if (!item) return sendJson(response, 404, { error: 'Library item not found' });
        const generatedAt = clock();
        const release = parseOptionalReleaseIdentity(url.searchParams);
        const stage6Scope = parseOptionalStage6Scope(url.searchParams);
        if (stage6Scope && !release) {
          throw new Error('Stage 6 scope requires infoHash and fileIndex');
        }
        const lifecycle = controlPlaneStore.getLifecycle(item.id);
        let snapshot = null;
        let stage6 = null;
        let shadowPlan = null;
        let providerObservations = [];
        if (release) {
          snapshot = controlPlaneStore.getReconciliationSnapshot(item.id, release);
          shadowPlan = planReconciliation(snapshot, { destructive: false, now: generatedAt });
          providerObservations = searchCache.getProviderObservations(
            release.infoHash, release.fileIndex, { now: generatedAt },
          );
          if (stage6Scope) {
            stage6 = projectRdZurgLifecycle({
              snapshot, lifecycle, scope: stage6Scope, now: generatedAt,
            });
          }
        }
        return sendJson(response, 200, toControlPlaneItemDetail({
          generatedAt,
          item,
          canonicalPath: controlPlaneStore.getActiveCanonicalPath(item.id),
          bindings: controlPlaneStore.listBindings(item.id),
          lifecycle,
          release,
          providerObservations,
          snapshot,
          stage6,
          shadowPlan,
        }));
      }
      // ─── S-1: data-plane control contract (Rust south) ────────────────
      //
      // GET /api/data-plane/files/:tfId
      //
      // The durable-north-truth projection the Rust data plane fetches.
      // Rust owns MOTION, not TRUTH: it never opens host SQLite, never
      // discovers or ranks providers, and never substitutes a TorrentFile.
      // It reads this payload and selects the coordinate whose size matches
      // the authoritative TorrentFile size (ControlResponse::target_file_id).
      //
      // Wire contract -- see data-plane/src/control.rs:
      //   { schemaVersion,
      //     torrentFile { id, infoHash, canonicalInternalPath, size },
      //     providers[] { provider, accountScope, providerResourceId,
      //                   providerFileId, state, canonicalInternalPath,
      //                   size } }
      //
      // schemaVersion is stamped on EVERY response, including errors. Rust
      // rejects a missing or unsupported version before it looks at any
      // other field, so an unstamped error body is unreadable to it.
      //
      // 404 means exactly one thing to the client: "torrent file unknown to
      // Node". A KNOWN TorrentFile with no usable coordinates therefore
      // returns 200 with an empty providers[] -- Rust then reports
      // "zero provider coordinates", which is accurate. Returning 404 for
      // that case would make the client lie to the operator.
      //
      // Unauthenticated, matching the rest of /api/control-plane/*: these
      // routes sit on the internal network and the Rust client sends no
      // credentials. Adding auth here would break the client that this
      // endpoint exists to serve.
      const dataPlaneFileMatch = request.method === 'GET'
        && url.pathname.match(/^\/api\/data-plane\/files\/([^/]+)$/);
      if (dataPlaneFileMatch) {
        requireControlPlaneStore(controlPlaneStore);
        let torrentFileId = dataPlaneFileMatch[1];
        try {
          torrentFileId = decodeURIComponent(torrentFileId);
        } catch {
          // Malformed percent-encoding: fall through with the raw segment so
          // the store's own validation rejects it.
        }
        const torrentFile = controlPlaneStore.getTorrentFile(torrentFileId);
        if (!torrentFile) {
          return sendJson(response, 404, {
            schemaVersion: DATA_PLANE_SCHEMA_VERSION,
            error: { code: 'TORRENT_FILE_NOT_FOUND', torrentFileId },
          });
        }
        const dataPlaneCoords = controlPlaneStore
          .listDataPlaneCoordinates(torrentFileId);
        // A coordinate with no usable size can never satisfy
        // target_file_id(), and emitting `size: null` would fail Rust's
        // ControlResponse parse outright -- killing the entire control fetch
        // behind a type error instead of an accurate "nothing to acquire".
        // Drop them here, visibly, rather than silently inside SQL.
        const sizedCoords = dataPlaneCoords.filter(
          (coord) => Number.isSafeInteger(coord.size) && coord.size > 0,
        );
        return sendJson(response, 200, {
          schemaVersion: DATA_PLANE_SCHEMA_VERSION,
          torrentFile: {
            id: torrentFile.id,
            infoHash: torrentFile.infoHash,
            canonicalInternalPath: torrentFile.internalPath,
            size: torrentFile.size,
          },
          providers: sizedCoords.map((coord) => ({
            provider: coord.provider,
            accountScope: coord.account_scope,
            providerResourceId: coord.provider_resource_id,
            providerFileId: coord.provider_file_id,
            state: coord.placement_state,
            canonicalInternalPath: coord.provider_path,
            size: coord.size,
          })),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/search/stats') {
        return sendJson(response, 200, getSearchStats(searchCache));
      }
      // Internal DMM corpus search (ranked FTS5 pipeline)
      if (request.method === 'GET' && url.pathname === '/api/search/internal') {
        const startedAt = performance.now();
        const params = url.searchParams;
        const result = searchReleases(searchCache, {
          query: params.get('q') || '',
          year: params.get('year') ? parseInt(params.get('year'), 10) : undefined,
          season: params.get('season') ? parseInt(params.get('season'), 10) : undefined,
          episode: params.get('episode') ? parseInt(params.get('episode'), 10) : undefined,
          resolution: params.get('resolution') || undefined,
          source: params.get('source') || undefined,
          codec: params.get('codec') || undefined,
          hdr: params.get('hdr') === 'true' ? 1 : params.get('hdr') === 'false' ? 0 : undefined,
          audio: params.get('audio') || undefined,
          limit: params.get('limit') ? Math.min(parseInt(params.get('limit'), 10), 100) : 50,
          offset: params.get('offset') ? parseInt(params.get('offset'), 10) : 0,
          includeProviders: params.get('providers') === 'true',
          includeMedia: params.get('media') === 'true',
        });
        return sendJson(response, 200, {
          ...result,
          timings: { totalMs: Math.round(performance.now() - startedAt) },
          stats: getSearchStats(searchCache),
        });
      }
      // DMM ingestion endpoint (for triggering hashlist sync via API)
      if (request.method === 'POST' && url.pathname === '/api/ingest/dmm') {
        const body = await readBody(request);
        const maxFragments = body.maxFragments ? parseInt(body.maxFragments, 10) : 1;
        const ingestResult = await runDMMIngestion({
          cache: searchCache,
          maxFragments,
          batchSize: body.batchSize || 1000,
        });
        return sendJson(response, 200, ingestResult);
      }
      // Attribute parsing trigger (for reparsing or startup catch-up)
      if (request.method === 'POST' && url.pathname === '/api/attributes/run') {
        const body = await readBody(request);
        const stats = await runAttributeWorker(searchCache, {
          limit: body.limit ? parseInt(body.limit, 10) : undefined,
        });
        return sendJson(response, 200, stats);
      }
      // Corpus maintenance trigger (headless operator convention):
      // bootstrap when absent, otherwise cheap HEAD check + compare-based
      // delta. Never destroys the serving corpus; revision advances only
      // on fully successful updates.
      if (request.method === 'POST' && url.pathname === '/api/corpus/update') {
        const body = await readBody(request).catch(() => ({}));
        try {
          const lifecycle = getCorpusLifecycle();
          const state = lifecycle.getState();
          const result = !state.imported_revision
            ? await lifecycle.bootstrap({ maxFragments: body.maxFragments ?? null })
            : await lifecycle.updateOnce();
          return sendJson(response, 200, { state: lifecycle.getState(), result });
        } catch (err) {
          return sendJson(response, 500, { error: err?.message || String(err) });
        }
      }
      // Future-intent seeding (headless operator convention): durable
      // "expect this media later" records. Seeding creates no VFS, STRM,
      // library, or consumer state — it only authorizes the anticipatory
      // scheduler to prepare ahead of demand.
      if (request.method === 'POST' && url.pathname === '/api/future-intents') {
        const body = await readBody(request).catch(() => ({}));
        try {
          const store = getFutureIntentStore();
          const { intent, created } = store.seed({
            mediaType: body.mediaType || 'movie',
            mediaId: body.mediaId,
            season: body.season ?? null,
            episode: body.episode ?? null,
            source: body.source || 'operator',
            expectedAt: body.expectedAt ?? null,
          });
          return sendJson(response, 200, { intent, created });
        } catch (err) {
          return sendJson(response, 400, { error: err?.message || String(err) });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/future-intents') {
        try {
          const store = getFutureIntentStore();
          const state = url.searchParams.get('state');
          return sendJson(response, 200, {
            intents: store.list({ state: state || null }),
            counts: store.counts(),
            nextCheck: store.nextCheck(),
          });
        } catch (err) {
          return sendJson(response, 500, { error: err?.message || String(err) });
        }
      }
      // Arr sync trigger (headless operator convention): batch reconcile
      // Sonarr/Radarr monitored/upcoming into future intents. Idempotent;
      // failures leave existing intents intact.
      if (request.method === 'POST' && url.pathname === '/api/arr/sync') {
        try {
          const sync = getArrSync();
          if (!sync) {
            return sendJson(response, 200, { ok: false, reason: 'arr-disabled' });
          }
          const summary = await sync.syncOnce({ store: getFutureIntentStore() });
          return sendJson(response, 200, { ok: true, summary });
        } catch (err) {
          return sendJson(response, 500, { error: err?.message || String(err) });
        }
      }
      // Seerr ingress: webhook → durable intent → TMDB→IMDb translation →
      // existing single-intent discovery pipeline.
      if (request.method === 'POST' && url.pathname === '/api/ingress/seerr') {
        return handleSeerrIngress(request, response, searchCache, hydrateVfsForRequest, {
          controlPlaneStore,
          ensureTorBoxFileIdentityFn,
          torBoxProvider,
          torBoxApiKey: env.TORBOX_API_KEY,
          torBoxApiBase: env.TORBOX_API_URL,
          clock,
          hasExplicitEnsureFn,
          futureIntentStore: getFutureIntentStore(),
          availabilityWakeLog: getAvailabilityWakeLog(),
          schedulingNudge,
          rdClient,
        });
      }
      // Library unpublish: remove VFS/STRM presentation for an exact movie
      // or episode (or a whole season) without touching durable Release,
      // TorrentFile, placement, handoff, or history rows. Later re-request
      // cheaply republishes from retained truth. See lib/library/unpublish.js.
      if (request.method === 'POST' && url.pathname === '/api/library/unpublish') {
        const body = await readBody(request);
        try {
          const result = await unpublishMedia({
            cache: searchCache,
            controlPlaneStore,
            mediaId: body.mediaId,
            mediaType: body.mediaType,
            season: body.season ?? null,
            episode: body.episode ?? null,
          });
          return sendJson(response, 200, result);
        } catch (err) {
          return sendJson(response, 400, { error: err.message });
        }
      }
      // Permanent-storage promotion: one explicit human decision that
      // turns a provider-backed library item into owned bytes.
      // POST /api/library/:id/promote — :id is a library item id,
      // resolved to exactly one TorrentFile via the active binding.
      // Idempotent: permanent → no-op success; active → current
      // state; failed → reset to requested. No title matching, no
      // search, no ranking. See lib/promotion/.
      const promoteMatch = request.method === 'POST'
        && url.pathname.match(/^\/api\/library\/([^/]+)\/promote$/);
      if (promoteMatch) {
        requireControlPlaneStore(controlPlaneStore);
        const libraryItemId = promoteMatch[1];
        const store = getPromotionStore();
        if (!store) {
          return sendJson(response, 503, { error: 'promotion store unavailable' });
        }
        const root = getPermanentRoot();
        if (!root) {
          return sendJson(response, 409, {
            error: 'permanent storage not configured',
            code: 'PERMANENT_ROOT_UNSET',
            hint: 'Set HASHSUCKER_PERMANENT_PATH to an owned-storage root.',
          });
        }
        let resolved;
        try {
          resolved = resolvePromotionTarget(controlPlaneStore, libraryItemId);
        } catch (err) {
          return sendJson(response, 400, { error: err.message });
        }
        if (resolved.status !== 'ok') {
          const status = resolved.status === 'unknown-library-item' ? 404 : 409;
          return sendJson(response, status, { error: resolved.status, ...resolved });
        }
        const { item, torrentFile } = resolved;
        const episodeScoped = item.season != null && item.episode != null;
        let permanentPath;
        try {
          permanentPath = resolvePermanentTarget({
            root,
            mediaType: episodeScoped ? 'episode' : 'movie',
            title: item.title,
            year: item.year,
            season: item.season,
            episode: item.episode,
            internalPath: torrentFile.internalPath,
          });
        } catch (err) {
          return sendJson(response, 400, { error: err.message });
        }
        if (!isWithinRoot(root, permanentPath)) {
          return sendJson(response, 400, { error: 'permanent path escapes owned root' });
        }
        try {
          const { promotion, created, reset } = store.request({
            torrentFileId: torrentFile.id,
            libraryItemId: item.id,
            mediaId: item.mediaId,
            mediaType: episodeScoped ? 'episode' : 'movie',
            season: item.season ?? null,
            episode: item.episode ?? null,
            size: torrentFile.size,
            permanentPath,
          });
          // Nudge the worker so promotion starts without waiting for
          // the next tick; the tick remains the durability backstop.
          try { getPromotionWorker()?.tick().catch(() => {}); } catch { /* backstop covers */ }
          return sendJson(response, 200, {
            status: promotion.status,
            created: !!created,
            reset: !!reset,
            torrentFileId: promotion.torrentFileId,
            permanentPath: promotion.permanentPath,
            bytesComplete: promotion.bytesComplete,
            size: promotion.size,
            lastError: promotion.lastError,
          });
        } catch (err) {
          return sendJson(response, 400, { error: err.message });
        }
      }
      // Generic download intents (download-intent tranche). Any external
      // system (Requestrr, Discord, CLI, Home Assistant) names the media;
      // HashSucker resolves one exact TorrentFile (reuse or fresh
      // prepare) and stages verified bytes for an external importer.
      // No library item required — the caller never needs internal IDs.
      if (request.method === 'POST' && url.pathname === '/api/download-request') {
        const body = await readBody(request);
        const identity = normalizeDownloadIdentity(body);
        if (identity.error) {
          return sendJson(response, 400, { error: identity.error });
        }
        const store = getDownloadStore();
        if (!store) {
          return sendJson(response, 503, { error: 'download store unavailable' });
        }
        const root = getDownloadRoot();
        if (!root) {
          return sendJson(response, 409, {
            error: 'download staging not configured',
            code: 'DOWNLOAD_ROOT_UNSET',
            hint: 'Set HASHSUCKER_DOWNLOAD_PATH to a staging root.',
          });
        }
        const title = typeof body?.title === 'string' && body.title.trim()
          ? body.title.trim().slice(0, 300)
          : null;
        const year = Number.isSafeInteger(body?.year) && body.year > 0 ? body.year : null;
        try {
          const { download, created, reset } = store.request({
            mediaId: identity.mediaId,
            mediaType: identity.mediaType,
            season: identity.season,
            episode: identity.episode,
            title,
            year,
          });
          // Nudge the worker so staging starts without waiting for the
          // next tick; the tick remains the durability backstop.
          try { getDownloadWorker()?.tick().catch(() => {}); } catch { /* backstop covers */ }
          return sendJson(response, 200, {
            downloadRequestId: download.downloadRequestId,
            state: download.status,
            created: !!created,
            reset: !!reset,
            media: {
              mediaId: download.mediaId,
              mediaType: download.mediaType,
              season: download.season,
              episode: download.episode,
              title: download.title,
              year: download.year,
            },
            torrentFileId: download.torrentFileId,
            expectedSize: download.expectedSize,
            bytesComplete: download.bytesComplete,
            stagedPath: download.stagedPath,
            lastError: download.lastError,
          });
        } catch (err) {
          return sendJson(response, 400, { error: err.message });
        }
      }
      // Download intent status for thin clients. filePresent reports
      // whether the staged file is still where HashSucker left it; a
      // downstream importer may have moved it, which is tolerated and
      // never triggers re-creation.
      const downloadStatusMatch = request.method === 'GET'
        && url.pathname.match(/^\/api\/download-request\/([^/]+)$/);
      if (downloadStatusMatch) {
        const store = getDownloadStore();
        if (!store) {
          return sendJson(response, 503, { error: 'download store unavailable' });
        }
        let downloadId = downloadStatusMatch[1];
        try {
          downloadId = decodeURIComponent(downloadId);
        } catch {
          // Fall through with the raw segment; the lookup misses cleanly.
        }
        const download = store.get(downloadId);
        if (!download) {
          return sendJson(response, 404, { error: 'unknown download request' });
        }
        let filePresent = null;
        if (download.status === 'staged' && download.stagedPath) {
          try {
            const stat = await fs.stat(download.stagedPath);
            filePresent = stat.isFile() && stat.size === download.expectedSize;
          } catch {
            filePresent = false;
          }
        }
        return sendJson(response, 200, {
          downloadRequestId: download.downloadRequestId,
          state: download.status,
          media: {
            mediaId: download.mediaId,
            mediaType: download.mediaType,
            season: download.season,
            episode: download.episode,
            title: download.title,
            year: download.year,
          },
          torrentFileId: download.torrentFileId,
          expectedSize: download.expectedSize,
          bytesComplete: download.bytesComplete,
          stagedPath: download.stagedPath,
          filePresent,
          lastError: download.lastError,
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/search') {
        const startedAt = performance.now();
        const params = url.searchParams;
        const mediaId = params.get('mediaId');
        const type = params.get('type');

        // Unified release discovery path: DMM corpus + live discovery + ranking.
        // Routes through combinedSearch() for a single ranked result set.
        if (mediaId && type) {
          const intent = createRequestIntent({ type, mediaId });
          const result = await combinedSearchFn(searchCache, {
            query: params.get('q') || '',
            year: params.get('year') ? parseInt(params.get('year'), 10) : undefined,
            season: intent.season,
            episode: intent.episodes[0],
            resolution: params.get('resolution') || undefined,
            source: params.get('source') || undefined,
            codec: params.get('codec') || undefined,
            hdr: params.get('hdr') === 'true' ? 1 : params.get('hdr') === 'false' ? 0 : undefined,
            audio: params.get('audio') || undefined,
            limit: params.get('limit') ? Math.min(parseInt(params.get('limit'), 10), 100) : 50,
            offset: params.get('offset') ? parseInt(params.get('offset'), 10) : 0,
            includeProviders: true,
            includeLive: true,
            includeMedia: true,
            mode: 'ui',
            mediaId,
            liveDiscoveryFn: async () => runLiveDiscoveryWithCounts(mediaId, { season: intent.season, episode: intent.episodes[0] }),
          });
          // Expose debug output in the response
          const liveDebug = result.debug?.liveDiscovery || null;
          const pipelineDebug = result.debug?.pipeline || null;
          const rankingComposition = result.debug?.rankingComposition || null;
          const rankingExplanations = result.debug?.rankingExplanations || null;
          const identityTiers = result.debug?.identityTiers || null;
          const shadowRanking = result.debug?.shadowRanking || null;
          const identityDiagnostics = result.debug?.identityDiagnostics || null;
          // Instrument serialization boundary
          const beforeSerialization = result.results.length;
          let serializedResults = [];
          try {
            serializedResults = result.results.map(toPublicReleaseDto);
          } catch (serializationError) {
            pipelineDebug.serializationError = serializationError.message;
            serializedResults = [];
          }
          const responseBody = {
            intent,
            results: serializedResults,
            total: result.total,
            timings: { ...result.timings, totalMs: Math.round(performance.now() - startedAt) },
            stats: result.stats,
            debug: {
              rejections: result.debug?.rejections || [],
              liveDiscovery: liveDebug,
              pipeline: {
                ...pipelineDebug,
                beforeSerialization,
                serializedCandidates: serializedResults.length,
                responseCandidates: serializedResults.length,
              },
              rankingComposition,
              rankingExplanations,
              identityTiers,
              shadowRanking,
              identityDiagnostics,
            },
          };
          console.log('API_RESPONSE_PAYLOAD:', JSON.stringify({
            resultsLength: responseBody.results.length,
            total: responseBody.total,
            firstResult: responseBody.results[0] || null,
            pipeline: responseBody.debug?.pipeline
          }));
          return sendJson(response, 200, responseBody);
        }

        // Unified title search: provider-agnostic, cache-backed.
        const searchResult = await searchTitles(params.get('q'));
        return sendJson(response, 200, {
          results: searchResult.results,
          requestId: searchResult.requestId,
          fromCache: searchResult.fromCache,
          errors: searchResult.errors,
          timings: { totalMs: Math.round(performance.now() - startedAt) },
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/media') {
        const startedAt = performance.now();
        const media = await getMediaById(url.searchParams.get('type'), url.searchParams.get('id'));
        return media ? sendJson(response, 200, { media, timings: { totalMs: Math.round(performance.now() - startedAt) } }) : sendJson(response, 404, { error: 'Media not found' });
      }
      if (request.method === 'GET' && url.pathname === '/api/search/cache/metrics') {
        return sendJson(response, 200, getCacheMetrics() || { error: 'Cache not available' });
      }
      if (request.method === 'POST' && url.pathname === '/api/requests') {
        const body = await readBody(request);
        const timing = createRequestTiming('pending');

        try {
          timing.start('request.received', { mediaId: body.mediaId });
          timing.end('request.received');

          timing.start('identity.resolved');
          let intent, release, handlingMode;
          try {
            ({ intent, release, handlingMode } = validateSupportedRequest(body));
          } catch (err) {
            timing.fail('identity.resolved', err.message);
            throw err;
          }
          timing.end('identity.resolved', 'completed', {
            mediaId: intent.mediaId,
            releaseKey: `${release.infoHash}:${release.fileIndex ?? 'torrent'}`,
          });

          timing.start('handoff.created');
          const handoff = createHandoff({ intent, release, provider: 'torbox', handlingMode });
          // Update timing with actual requestId now that we have one
          timing.requestId = handoff.requestId;
          timing.end('handoff.created', 'completed', {
            requestId: handoff.requestId,
            provider: 'torbox',
            handlingMode,
          });

          let result;
          let finalStatus;
          if (handlingMode === 'stream') {
            timing.start('virtual-library.committed');
            const fulfillment = await virtualFulfillment({
              cache: searchCache,
              intent,
              release,
              ...(ensureTorBoxFileIdentityFn ? { ensureTorBoxFileIdentity: ensureTorBoxFileIdentityFn } : {}),
            });
            result = {
              requestId: handoff.requestId,
              status: 'completed',
              handlingMode,
              mediaRequestId: fulfillment.mediaRequestId,
              releaseKey: fulfillment.handoff.releaseKey,
              strmPath: fulfillment.strm.path,
            };
            finalStatus = 'completed';
            timing.end('virtual-library.committed', 'completed', {
              mediaRequestId: fulfillment.mediaRequestId,
              releaseKey: fulfillment.handoff.releaseKey,
              strmPath: fulfillment.strm.path,
            });
          } else {
            timing.start('request.queued');
            result = await importer.submitRequest(handoff, { timing: timing.summary() });
            finalStatus = 'queued';
            timing.end('request.queued', 'completed', {
              status: result.status,
              path: result.path,
            });
          }

          timing.complete();

          // Persist to event store
          try {
            eventStore.recordRequestRun({
              requestId: handoff.requestId,
              mediaId: intent.mediaId,
              releaseKey: handoff.release.releaseKey,
              provider: 'torbox',
              finalStatus,
              timingJson: timing.summary(),
            });
            eventStore.recordEvents(timing.getStages().map(s => ({
              requestId: handoff.requestId,
              stage: s.stage,
              status: s.status === 'failed' ? 'failed' : 'completed',
              durationMs: s.durationMs,
              timestamp: s.startedAt,
            })));
          } catch (e) {
            emit(EVENTS.DISCOVERY_ERROR, { scope: 'event-store', error: e.message });
          }

          return sendJson(response, 202, {
            ...result,
            timing: timing.summary(),
          });
        } catch (err) {
          timing.complete();
          throw err;
        }
      }
      const statusMatch = request.method === 'GET' && url.pathname.match(/^\/api\/requests\/([0-9a-f-]{36})$/i);
      if (statusMatch) {
        const status = await importer.getRequestStatus(statusMatch[1]);
        return status ? sendJson(response, 200, status) : sendJson(response, 404, { error: 'Request not found' });
      }
      // Media byte delivery — must come before static catch-all
      if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
        const handled = await handleMediaDelivery({
          request, response, controlPlaneStore, env,
        });
        if (handled) return;
      }
      if (request.method === 'GET' && staticRoot && !url.pathname.startsWith('/api/')) {
        const served = await sendStatic(response, url.pathname, staticRoot);
        if (served) return;
      }
      const mediaLookupMatch = request.method === 'GET'
        && url.pathname.match(/^\/media\/lookup\/([^/]+)\/([^/]+)$/);
      if (mediaLookupMatch) {
        requireControlPlaneStore(controlPlaneStore);
        try {
          const identity = parseIdentityFromParams(mediaLookupMatch[1], mediaLookupMatch[2]);
          const projection = resolveProjection({
            store: controlPlaneStore,
            infoHash: identity.infoHash,
            fileIndex: identity.fileIndex,
            env,
          });
          return sendJson(response, 200, projection);
        } catch (resolverError) {
          if (resolverError instanceof ResolverError) {
            return sendJson(response, resolverError.status, { error: resolverError.message });
          }
          throw resolverError;
        }
      }
      // Operator dashboard endpoints
      if (request.method === 'GET' && url.pathname === '/api/operator/requests') {
        const filter = url.searchParams.get('filter') || 'all';
        const validFilters = new Set(['all', 'queued', 'processing', 'done', 'failed']);
        if (!validFilters.has(filter)) {
          return sendJson(response, 400, { error: 'Invalid filter value' });
        }
        const all = await listAllRequests(operatorRoot);
        const filtered = filter === 'all' ? all : all.filter(r => r.status === filter);
        filtered.sort((a, b) => {
          const ta = a.request?.createdAt || a.request?.created_at || '';
          const tb = b.request?.createdAt || b.request?.created_at || '';
          return ta < tb ? 1 : ta > tb ? -1 : 0;
        });
        return sendJson(response, 200, {
          requests: filtered.map(r => ({
            requestId: r.requestId,
            status: r.status,
            createdAt: r.request?.createdAt || r.request?.created_at || null,
            handlingMode: r.request?.handlingMode || r.request?.handling_mode || null,
            mediaTitle: r.request?.media?.title || r.request?.mediaTitle || null,
            mediaId: r.request?.mediaId || r.request?.media_id || null,
            releaseTitle: r.request?.release?.title || r.request?.releaseTitle || null,
            provider: r.request?.provider || null,
            lastError: r.request?.lastError || r.request?.last_error || null,
          })),
          total: filtered.length,
        });
      }

      const operatorRequestDetail = request.method === 'GET'
        && url.pathname.match(/^\/api\/operator\/requests\/([0-9a-f-]{36})$/i);
      if (operatorRequestDetail) {
        const reqId = operatorRequestDetail[1];
        const found = await readRequest(reqId, operatorRoot);
        if (!found) return sendJson(response, 404, { error: 'Request not found' });
        return sendJson(response, 200, {
          requestId: found.requestId,
          status: found.status,
          request: found.request,
          trace: getTraceLog(found),
        });
      }
      const retryMatch = request.method === 'POST'
        && url.pathname.match(/^\/api\/operator\/requests\/([0-9a-f-]{36})\/retry$/i);
      if (retryMatch) {
        const reqId = retryMatch[1];
        const found = await readRequest(reqId, operatorRoot);
        if (!found) return sendJson(response, 404, { error: 'Request not found' });
        if (found.status !== 'failed' && found.status !== 'done') {
          return sendJson(response, 409, { error: `Cannot retry request in '${found.status}' state` });
        }
        await moveRequest(reqId, found.status, 'processing', operatorRoot);
        return sendJson(response, 200, { requestId: reqId, status: 'processing', action: 'retry' });
      }
      const resetMatch = request.method === 'POST'
        && url.pathname.match(/^\/api\/operator\/requests\/([0-9a-f-]{36})\/reset$/i);
      if (resetMatch) {
        const reqId = resetMatch[1];
        const found = await readRequest(reqId, operatorRoot);
        if (!found) return sendJson(response, 404, { error: 'Request not found' });
        await moveRequest(reqId, found.status, 'queued', operatorRoot);
        return sendJson(response, 200, { requestId: reqId, status: 'queued', action: 'reset' });
      }
      const operatorDeleteMatch = request.method === 'DELETE'
        && url.pathname.match(/^\/api\/operator\/requests\/([0-9a-f-]{36})$/i);
      if (operatorDeleteMatch) {
        const reqId = operatorDeleteMatch[1];
        await purgeRequest(reqId, operatorRoot);
        return sendJson(response, 200, { requestId: reqId, action: 'deleted' });
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/search-debug') {
        const query = url.searchParams.get('q') || '';
        if (!query || query.length < 2) {
          return sendJson(response, 400, { error: 'Query must be at least 2 characters' });
        }
        const limited = searchReleases(searchCache, {
          query,
          limit: 50,
          includeProviders: false,
          includeMedia: false,
        });
        return sendJson(response, 200, {
          query,
          total: limited.total,
          results: limited.results.slice(0, 20).map(r => ({
            title: r.title,
            score: r.score,
            components: r.components,
            source: r._source,
          })),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/logs') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
        const all = await listAllRequests(operatorRoot);
        const recent = all
          .filter(r => r.status === 'processing' || r.status === 'failed')
          .slice(0, limit)
          .map(r => ({
            requestId: r.requestId,
            status: r.status,
            lastError: r.request?.lastError || r.request?.last_error || null,
            updatedAt: r.request?.updatedAt || r.request?.updated_at || null,
          }));
        return sendJson(response, 200, { logs: recent });
      }
      // Media request: search candidates by known media identity
      if (request.method === 'POST' && url.pathname === '/api/media-request') {
        const startedAt = performance.now();
        const body = await readBody(request);
        try {
          // Server-side VFS hydrator is wired in-process; the client body
          // cannot override it. This keeps the request contract minimal
          // and prevents callers from disabling metadata hydration.
          // Slice 1.75: same for the identity-binding seam — server-side
          // and overridable only via the createApp dependency factory,
          // not via the client body.
          //
          // Request-scoped TorBox mylist memoization: one coordinator-owned
          // snapshot shared by every placement-lookup/inventory read inside
          // this request (placement creates invalidate it, so fresh
          // torrents are never missed). Without this, each selection
          // attempt re-downloads the full account list. Falls back to the
          // shared provider when request scoping is unavailable.
          const requestEnsureFn = buildRequestScopedEnsureFn({
            fallbackFn: ensureTorBoxFileIdentityFn,
            explicitFn: hasExplicitEnsureFn,
            controlPlaneStore,
            torBoxProvider,
            apiKey: env.TORBOX_API_KEY,
            apiBase: env.TORBOX_API_URL,
            clock,
            scope: 'media-request',
          });
          const result = await searchByMedia(searchCache, {
            ...body,
            hydrateVfs: hydrateVfsForRequest,
            controlPlaneStore,
            ...(requestEnsureFn ? { ensureTorBoxFileIdentity: requestEnsureFn } : {}),
            ...rdEnsureForRequest({ rdClient, controlPlaneStore, clock }),
          });
          return sendJson(response, 200, {
            ...result,
            timings: { totalMs: Math.round(performance.now() - startedAt) },
          });
        } catch (err) {
          return sendJson(response, 400, { error: err.message });
        }
      }
      // Media preparation: run discovery/ranking/selection/binding and
      // persist reusable durable truth WITHOUT presentation (no VFS, no
      // STRM, no consumer notification, no library desired-state change).
      // A later normal request recognizes the prepared state and proceeds
      // directly to publication with zero provider work. Idempotent:
      // preparing an already-prepared item is a local no-op.
      if (request.method === 'POST' && url.pathname === '/api/media-prepare') {
        const startedAt = performance.now();
        const body = await readBody(request);
        try {
          const requestEnsureFn = buildRequestScopedEnsureFn({
            fallbackFn: ensureTorBoxFileIdentityFn,
            explicitFn: hasExplicitEnsureFn,
            controlPlaneStore,
            torBoxProvider,
            apiKey: env.TORBOX_API_KEY,
            apiBase: env.TORBOX_API_URL,
            clock,
            scope: 'media-prepare',
          });
          const result = await searchByMedia(searchCache, {
            ...body,
            prepareOnly: true,
            source: body.source || 'prepare',
            sourceType: body.sourceType || 'operator',
            controlPlaneStore,
            ...(requestEnsureFn ? { ensureTorBoxFileIdentity: requestEnsureFn } : {}),
            ...rdEnsureForRequest({ rdClient, controlPlaneStore, clock }),
          });
          return sendJson(response, 200, {
            ...result,
            timings: { totalMs: Math.round(performance.now() - startedAt) },
          });
        } catch (err) {
          return sendJson(response, 400, { error: err.message });
        }
      }
      // Playback handoff: retrieve handoff by request ID
      const handoffMatch = request.method === 'GET'
        && url.pathname.match(/^\/api\/media-request\/(\d+)\/handoff$/);
      if (handoffMatch) {
        const requestId = parseInt(handoffMatch[1], 10);
        const row = searchCache.getPlaybackHandoffByRequestId(requestId);
        const handoff = searchCache.rowToPlaybackHandoff(row);
        return sendJson(response, handoff ? 200 : 404, handoff || { error: 'Handoff not found' });
      }
      // Worker visibility endpoint
      if (request.method === 'GET' && url.pathname === '/api/operator/workers') {
        const workerVisibility = createWorkerVisibility({ requestsRoot: operatorRoot, now: clock });
        const status = await workerVisibility.getStatus();
        // Support text output for terminal/console consumption
        if (url.searchParams.get('format') === 'text') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end(formatWorkerStatus(status));
          return;
        }
        return sendJson(response, 200, status);
      }
      // Event store endpoints — persistent lifecycle history
      if (request.method === 'GET' && url.pathname === '/api/operator/events/recent') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
        const runs = eventStore.getRecentRuns(limit);
        if (url.searchParams.get('format') === 'text') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end(formatRecentRuns(runs));
          return;
        }
        return sendJson(response, 200, { runs, total: eventStore.countRequestRuns() });
      }
      const eventRequestMatch = request.method === 'GET'
        && url.pathname.match(/^\/api\/operator\/events\/request\/([0-9a-f-]{36})$/i);
      if (eventRequestMatch) {
        const reqId = eventRequestMatch[1];
        const timeline = eventStore.getRequestTimeline(reqId);
        if (url.searchParams.get('format') === 'text') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end(formatRequestTimeline(timeline));
          return;
        }
        return sendJson(response, timeline ? 200 : 404, timeline || { error: 'Request not found' });
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/events/failed') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
        const runs = eventStore.getFailedRuns(limit);
        if (url.searchParams.get('format') === 'text') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end(formatFailedRuns(runs));
          return;
        }
        return sendJson(response, 200, { runs, total: runs.length });
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/events/stats') {
        return sendJson(response, 200, {
          totalRuns: eventStore.countRequestRuns(),
          totalEvents: eventStore.countLifecycleEvents(),
          byStatus: eventStore.countRunsByStatus(),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/diagnostics') {
        return sendJson(response, 200, { available: listDiagnostics() });
      }
      const diagRunMatch = request.method === 'POST'
        && url.pathname.match(/^\/api\/operator\/diagnostics\/run\/(.+)$/);
      if (diagRunMatch) {
        const diagId = diagRunMatch[1];
        const result = await runDiagnostic(diagId, { env });
        return sendJson(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/requests/health') {
        const result = await checkRequestLifecycleHealth({
          requestsRoot: operatorRoot,
          controlPlaneStore,
          now: clock,
        });
        return sendJson(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/health') {
        const health = await getSystemHealth({ env });
        return sendJson(response, health.status === 'healthy' ? 200 : 503, health);
      }
      if (request.method === 'POST' && url.pathname === '/api/operator/requests/retry') {
        const body = await readBody(request);
        const requestId = body?.requestId;
        if (!requestId) {
          return sendJson(response, 400, { error: 'requestId is required' });
        }
        const result = await retryFailedRequest({ requestId, requestsRoot: operatorRoot });
        return sendJson(response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/operator/requests/reset') {
        const body = await readBody(request);
        const requestId = body?.requestId;
        if (!requestId) {
          return sendJson(response, 400, { error: 'requestId is required' });
        }
        const result = await resetStuckRequest({ requestId, requestsRoot: operatorRoot });
        return sendJson(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/operator/requests/inspect') {
        const result = await inspectRequests();
        return sendJson(response, 200, result);
      }
      const inspectMatch = request.method === 'GET'
        && url.pathname.match(/^\/api\/operator\/requests\/([0-9a-f-]{36})\/inspect$/i);
      if (inspectMatch) {
        const result = await inspectRequests();
        return sendJson(response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/operator/requests/delete-orphan') {
        const body = await readBody(request);
        const requestId = body?.requestId;
        if (!requestId) {
          return sendJson(response, 400, { error: 'requestId is required' });
        }
        const result = await deleteOrphanedRequest({ requestId, requestsRoot: operatorRoot });
        return sendJson(response, 200, result);
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const isInput = /invalid|required|supported|valid JSON|too large|must be|between 1 and 100|2–120|infoHash|fileIndex|releaseKey/i.test(error.message);
      sendJson(response, isInput ? 400 : 502, { error: error.message });
    }
  };
}
