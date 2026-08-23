import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { toControlPlaneItemDetail, toControlPlaneItemSummary } from '../api/control-plane-dto.js';
import { createReleaseIdentity, toPublicReleaseDto, validateReleaseIdentity } from '../api/release-contract.js';
import { getControlPlaneHealth } from '../lib/control-plane/health.js';
import { planReconciliation } from '../lib/control-plane/reconciler.js';
import { projectRdZurgLifecycle } from '../lib/control-plane/rd-zurg-slice.js';
import { QueueImporterClient } from '../lib/importer/queue-client.js';
import { getMedia, searchCatalog } from '../lib/metadata/cinemeta.js';
import { searchTitles, getMediaById, getCacheMetrics } from '../lib/metadata/unified-search.js';
import { createHandoff } from '../lib/requests/handoff.js';
import { createRequestIntent } from '../lib/requests/intent.js';
import { searchReleases, combinedSearch, getSearchStats } from '../lib/discovery/search-engine.js';
import { runLiveDiscovery } from '../lib/discovery/live-bridge.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { runDMMIngestion } from '../lib/discovery/dmm-ingestion-runner.js';
import { runAttributeWorker } from '../lib/discovery/attribute-worker.js';
import { resolveProjection, parseIdentityFromParams, ResolverError } from '../lib/resolver/resolver.js';
import { buildMediaSource, SourceError } from '../lib/resolver/source.js';
import { createMediaStream, canTransport, TransportError } from '../lib/resolver/transport.js';

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
  return { intent, release };
}

export function createApp(dependencies = {}) {
  return http.createServer(createRequestHandler(dependencies));
}

export function createRequestHandler(dependencies = {}) {
  const importer = dependencies.importer || new QueueImporterClient();
  const catalogSearch = dependencies.searchCatalog || searchCatalog;
  const mediaLookup = dependencies.getMedia || getMedia;
  const combinedSearchFn = dependencies.combinedSearch || combinedSearch;
  // Internal search uses a persistent discovery cache.
  // dbPath can be injected via dependencies or DISCOVERY_DB env var.
  // Defaults to in-memory for testing (when no dbPath provided).
  const dbPath = dependencies.dbPath || process.env.DISCOVERY_DB;
  const searchCache = dependencies.searchCache || dependencies.discoveryCache || createDiscoveryCache(dbPath ? { dbPath } : {});
  const controlPlaneStore = dependencies.controlPlaneStore ?? null;
  const controlPlaneHealth = dependencies.getControlPlaneHealth || getControlPlaneHealth;
  const clock = dependencies.now || (() => Date.now());
  const staticRoot = dependencies.staticRoot === undefined ? process.env.STATIC_ROOT : dependencies.staticRoot;
  const env = dependencies.env ?? process.env;

  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { ok: true });
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
            liveDiscoveryFn: async () => runLiveDiscovery(mediaId, { season: intent.season, episode: intent.episodes[0] }),
          });
          return sendJson(response, 200, {
            intent,
            results: result.results.map(toPublicReleaseDto),
            total: result.total,
            timings: { ...result.timings, totalMs: Math.round(performance.now() - startedAt) },
            stats: result.stats,
          });
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
        const { intent, release } = validateSupportedRequest(body);
        const handoff = createHandoff({ intent, release, provider: 'torbox' });
        return sendJson(response, 202, await importer.submitRequest(handoff));
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
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const isInput = /invalid|required|supported|valid JSON|too large|must be|between 1 and 100|2–120|infoHash|fileIndex|releaseKey/i.test(error.message);
      sendJson(response, isInput ? 400 : 502, { error: error.message });
    }
  };
}
