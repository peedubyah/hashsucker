import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

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

const HASH_PATTERN = /^[a-f0-9]{40}$/i;
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

function validateSupportedRequest(body) {
  const intent = createRequestIntent({ type: body.type || 'series', mediaId: body.mediaId });
  const singleEpisode = intent.mediaType === 'tv' && intent.scope === 'episode' && intent.episodes.length === 1;
  const movie = intent.mediaType === 'movie' && intent.scope === 'movie' && intent.season === null && intent.episodes.length === 0;
  if (!singleEpisode && !movie) {
    throw new Error('Only explicit movies and single TV episode requests are supported');
  }
  if (!HASH_PATTERN.test(String(body.release?.infoHash || ''))) {
    throw new Error('Selected release must have a valid infoHash');
  }
  const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) || null : null;
  const release = {
    infoHash: body.release.infoHash.toLowerCase(),
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
  const staticRoot = dependencies.staticRoot === undefined ? process.env.STATIC_ROOT : dependencies.staticRoot;

  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { ok: true });
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
        const body = await readBody(request).catch(() => ({}));
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
        const body = await readBody(request).catch(() => ({}));
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
            mode: 'ui',
            liveDiscoveryFn: async () => runLiveDiscovery(mediaId, { season: intent.season, episode: intent.episodes[0] }),
          });
          return sendJson(response, 200, {
            intent,
            results: result.results,
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
      if (request.method === 'GET' && staticRoot && !url.pathname.startsWith('/api/')) {
        const served = await sendStatic(response, url.pathname, staticRoot);
        if (served) return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const isInput = /invalid|required|supported|valid JSON|too large|2–120|infoHash/i.test(error.message);
      sendJson(response, isInput ? 400 : 502, { error: error.message });
    }
  };
}
