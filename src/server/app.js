import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QueueImporterClient } from '../lib/importer/queue-client.js';
import { getMedia, searchCatalog } from '../lib/metadata/cinemeta.js';
import { createHandoff } from '../lib/requests/handoff.js';
import { createRequestIntent } from '../lib/requests/intent.js';
import { searchMedia } from '../lib/search.js';

const UI_ROOT = fileURLToPath(new URL('../ui/', import.meta.url));
const HASH_PATTERN = /^[a-f0-9]{40}$/i;

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function publicRelease(release) {
  return {
    key: release.key,
    title: release.title,
    filename: release.filename,
    size: release.size,
    resolution: release.resolution,
    quality: release.quality,
    codec: release.codec,
    hdr: release.hdr,
    audio: release.audio,
    language: release.language,
    infoHash: release.infoHash,
    sources: release.sources,
    providers: release.providers,
  };
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

async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'release-model.js', 'styles.css'].includes(relative)) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const body = await fs.readFile(path.join(UI_ROOT, relative));
  response.writeHead(200, {
    'content-type': types[path.extname(relative)],
    // Assets use stable filenames (no content hashes), so every navigation must
    // revalidate them to avoid mixing HTML/JS/CSS from different deployments.
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  });
  response.end(body);
  return true;
}

export function createApp(dependencies = {}) {
  return http.createServer(createRequestHandler(dependencies));
}

export function createRequestHandler(dependencies = {}) {
  const importer = dependencies.importer || new QueueImporterClient();
  const catalogSearch = dependencies.searchCatalog || searchCatalog;
  const mediaLookup = dependencies.getMedia || getMedia;
  const releaseSearch = dependencies.searchMedia || searchMedia;

  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/search') {
        const startedAt = performance.now();
        const results = await catalogSearch(url.searchParams.get('q'));
        return sendJson(response, 200, { results, timings: { totalMs: Math.round(performance.now() - startedAt) } });
      }
      if (request.method === 'GET' && url.pathname === '/api/media') {
        const startedAt = performance.now();
        const media = await mediaLookup(url.searchParams.get('type'), url.searchParams.get('id'));
        return media ? sendJson(response, 200, { media, timings: { totalMs: Math.round(performance.now() - startedAt) } }) : sendJson(response, 404, { error: 'Media not found' });
      }
      if (request.method === 'GET' && url.pathname === '/api/releases') {
        const intent = createRequestIntent({ type: url.searchParams.get('type'), mediaId: url.searchParams.get('mediaId') });
        const result = await releaseSearch(intent);
        return sendJson(response, 200, {
          intent: result.intent,
          providerStatus: result.providerStatus,
          timings: result.timings,
          results: result.results.filter((release) => release.infoHash).map(publicRelease),
        });
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
      if (request.method === 'GET' && await serveStatic(url.pathname, response)) return;
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const isInput = /invalid|required|supported|valid JSON|too large|2–120|infoHash/i.test(error.message);
      sendJson(response, isInput ? 400 : 502, { error: error.message });
    }
  };
}
