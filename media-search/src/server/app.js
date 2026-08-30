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
import { createRevalidator, mapRevalidationToHttp, REVALIDATION_SOURCE, REVALIDATION_OUTCOME } from '../lib/resolver/availability-revalidation.js';
import { checkTorBoxCached } from '../lib/providers/torbox.js';
import { createResolverTelemetry, getRecentResolverTelemetry, RESOLVER_OUTCOME } from '../lib/resolver/telemetry.js';
import { createResolverProfiler } from '../lib/resolver/profiler.js';
import { createTorBoxProvider } from '../lib/providers/torbox.js';
import { createTorBoxInventoryProvider } from '../lib/providers/torbox-inventory.js';
import { ensureTorBoxDelivery } from '../lib/resolver/torbox-delivery.js';
import { isUrlLive } from '../lib/resolver/liveness.js';
import { createRealDebridClient, RdCooldownError } from '../lib/providers/realdebrid/client.js';
import { attemptRdResolution, getRdObservationState, getRdPlaybackUrl } from '../lib/providers/realdebrid/resolve.js';
import { getRdResolutionCache } from '../lib/providers/realdebrid/rd-resolution-cache.js';
import { createMovieWebDav } from '../lib/vfs/movie-webdav.js';
import { createTvWebDav } from '../lib/vfs/tv-webdav.js';

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

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
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
  existingSelection,
  primaryRevalidation,
  rawId,
  mediaType,
  recordTelemetry,
  response,
  sendJson,
  clock,
}) {
  // Load persisted request to get expected scope and results
  const persistedRequest = searchCache.getMediaRequestsByMediaId(rawId);
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

  const { candidate, revalidation } = fallback;

  // Build a pseudo-selection object for redirect resolution
  const fallbackSelection = {
    status: 'selected',
    mediaId: rawId,
    releaseKey: candidate.releaseKey,
    selectedHash: candidate.info_hash,
    fileIndex: candidate.fileIndex,
    provider: 'torbox',
  };

  // Attempt TorBox redirect resolution
  if (!controlPlaneStore) return false;

  try {
    const redirect = resolveTorBoxRedirect(fallbackSelection, controlPlaneStore);
    const fallbackTelemetry = alternateFallback.buildFallbackTelemetry({
      originalReleaseKey: existingSelection.releaseKey,
      selectedReleaseKey: candidate.releaseKey,
      fallbackRank: candidate.rank,
      reason: primaryRevalidation.cacheState === REVALIDATION_OUTCOME.UNCACHED
        ? FALLBACK_REASON.PRIMARY_UNAVAILABLE
        : FALLBACK_REASON.PRIMARY_PROVIDER_ERROR,
    });
    recordTelemetry(RESOLVER_OUTCOME.REDIRECTED, null, 307, {
      infoHash: candidate.info_hash,
      releaseKey: candidate.releaseKey,
      provider: 'torbox',
      availabilitySource: revalidation.availabilitySource,
      providerCheckOccurred: revalidation.providerCheckOccurred,
      ...fallbackTelemetry,
    });
    response.writeHead(307, {
      location: redirect.redirectUrl,
      'cache-control': 'no-store',
      'x-torrent-id': redirect.torrentId,
      'x-file-id': redirect.providerFileId,
      'x-availability-source': revalidation.availabilitySource,
      'x-provider-check-occurred': revalidation.providerCheckOccurred ? 'true' : 'false',
      'x-fallback-used': 'true',
      'x-fallback-rank': String(candidate.rank),
      'x-fallback-original-release-key': existingSelection.releaseKey,
      'x-fallback-selected-release-key': candidate.releaseKey,
    });
    response.end();
    return true;
  } catch (redirectErr) {
    if (redirectErr instanceof RedirectResolutionError) {
      recordTelemetry(RESOLVER_OUTCOME.FAILED, redirectErr.code, null, {
        infoHash: candidate.info_hash,
        releaseKey: candidate.releaseKey,
        provider: 'torbox',
        availabilitySource: revalidation.availabilitySource,
        providerCheckOccurred: revalidation.providerCheckOccurred,
      });
      sendJson(response, redirectErr.status, {
        error: redirectErr.message,
        code: redirectErr.code,
        mediaId: rawId,
        mediaType,
      });
      return true;
    }
    throw redirectErr;
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

  // Availability revalidator for playback-time TorBox checks
  // Configured via STREAM_AVAILABILITY_MAX_AGE_MS and STREAM_PROVIDER_CHECK_TIMEOUT_MS
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
  });

  // Alternate candidate fallback for when primary selection is unavailable
  const alternateFallback = dependencies.alternateFallback || createAlternateFallback({
    searchCache,
    revalidator,
    now: clock,
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
  const rdResolutionCache = getRdResolutionCache();

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
  async function resolveTorBoxDelivery({ infoHash, fileIndex, releaseKey, filename }) {
    return ensureTorBoxDelivery({
      infoHash,
      fileIndex,
      releaseKey,
      filename,
      controlPlaneStore,
      torBoxProvider,
      torBoxInventoryProvider,
      now: clock,
    });
  }

  const handleMovieWebDav = createMovieWebDav({
    searchCache,
    controlPlaneStore,
    rdClient,
    rdResolutionCache,
    resolveTorBoxDelivery,
    now: clock,
  });
  const handleTvWebDav = createTvWebDav({
    searchCache,
    controlPlaneStore,
    rdClient,
    rdResolutionCache,
    resolveTorBoxDelivery,
    now: clock,
  });

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

          // 1. Check for existing persisted selection first
          const existingSelection = searchCache.getExistingSelection(rawId);
          profiler.mark('handoff-loaded');
          // Accept both 'selected' and 'debug' status — 'debug' means the handoff exists
          // but provider state is not usable, which triggers revalidation and potential fallback
          if (existingSelection && (existingSelection.status === 'selected' || existingSelection.status === 'debug')) {
            // 1a. Selected candidate must be TorBox-resolvable for redirect
            if (existingSelection.provider !== 'torbox') {
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
            // 1b. Attempt Real-Debrid as preferred delivery
            // Ordering: fresh RD cached → RD; missing/stale RD → one bounded RD attempt
            // RD must not require TorBox revalidation to fail before being attempted.
            if (rdClient && controlPlaneStore) {
              const rdObsState = getRdObservationState(searchCache, existingSelection.selectedHash, existingSelection.fileIndex, clock());
              profiler.mark('rd-observation-lookup');

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

              if (rdObsState === 'cached' || rdObsState === 'missing') {
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
              // Missing/stale RD observation — skip RD, go straight to TorBox
              // Fresh RD infringing/uncached/unavailable → skip RD, use TorBox
            }

            // 1c. Revalidate availability before redirect
            const revalidation = await revalidator.revalidateAvailability({
              cache: searchCache,
              infoHash: existingSelection.selectedHash,
              mediaId: rawId,
              releaseKey: existingSelection.releaseKey,
              provider: existingSelection.provider,
            });
            profiler.mark('torbox-revalidation');
            const httpOutcome = mapRevalidationToHttp(revalidation);
            if (!httpOutcome.shouldRedirect) {
              // Try alternate candidate fallback before returning typed failure
              const fallbackAttempted = await tryAlternateCandidateFallback({
                searchCache,
                alternateFallback,
                revalidator,
                controlPlaneStore,
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

            // 1d. Attempt TorBox redirect resolution when control plane is available
            if (controlPlaneStore) {
              try {
                const redirect = resolveTorBoxRedirect(existingSelection, controlPlaneStore);
                profiler.mark('torbox-redirect-resolved');

                // TorBox requestdl with redirect=true is the documented consumer permalink.
                // Jellyfin follows the 307 to TorBox API; TorBox 302/307 redirects to CDN.
                // This avoids minting fresh CDN URLs on every reconnect.
                recordTelemetry(RESOLVER_OUTCOME.REDIRECTED, null, 307, {
                  infoHash: existingSelection.selectedHash,
                  releaseKey: existingSelection.releaseKey,
                  provider: existingSelection.provider,
                  availabilitySource: revalidation.availabilitySource,
                  providerCheckOccurred: revalidation.providerCheckOccurred,
                });
                profiler.mark('307-returned');
                // HTTP 307 — Temporary Redirect to TorBox API (documented permalink)
                response.writeHead(307, {
                  location: redirect.redirectUrl,
                  'cache-control': 'no-store',
                  'x-torrent-id': redirect.torrentId,
                  'x-file-id': redirect.providerFileId,
                  'x-availability-source': revalidation.availabilitySource,
                  'x-provider-check-occurred': revalidation.providerCheckOccurred ? 'true' : 'false',
                  'x-url-live-checked': 'true',
                  'x-resolver-profile': JSON.stringify(profiler.summary()),
                });
                response.end();
                return;
              } catch (redirectErr) {
                // Map redirect failures to clear non-redirect responses
                if (redirectErr instanceof RedirectResolutionError) {
                  recordTelemetry(RESOLVER_OUTCOME.FAILED, redirectErr.code, null, {
                    infoHash: existingSelection.selectedHash,
                    releaseKey: existingSelection.releaseKey,
                    provider: existingSelection.provider,
                    availabilitySource: revalidation.availabilitySource,
                    providerCheckOccurred: revalidation.providerCheckOccurred,
                  });
                  return sendJson(response, redirectErr.status, {
                    error: redirectErr.message,
                    code: redirectErr.code,
                    mediaId: rawId,
                    mediaType,
                  });
                }
                throw redirectErr;
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

          timing.start('request.queued');
          const result = await importer.submitRequest(handoff, { timing: timing.summary() });
          timing.end('request.queued', 'completed', {
            status: result.status,
            path: result.path,
          });

          timing.complete();

          // Persist to event store
          try {
            eventStore.recordRequestRun({
              requestId: handoff.requestId,
              mediaId: intent.mediaId,
              releaseKey: handoff.release.releaseKey,
              provider: 'torbox',
              finalStatus: 'queued',
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
          const result = await searchByMedia(searchCache, body);
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
