import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import {
  addDeterministicCollisionSuffix,
  buildPreferredCanonicalPath,
} from '../control-plane/canonical-path.js';
import { attemptRdResolution, getRdPlaybackUrl } from '../providers/realdebrid/resolve.js';
import { isUrlLive } from '../resolver/liveness.js';

const DAV_ROOT = '/vfs';
const MOVIES_PATH = `${DAV_ROOT}/Movies`;
const CONTENT_TYPE = 'video/x-matroska';
const STALE_PROVIDER_STATUSES = new Set([401, 403, 404, 410]);

class VfsError extends Error {
  constructor(message, status = 502, code = 'VFS_ERROR') {
    super(message);
    this.name = 'VfsError';
    this.status = status;
    this.code = code;
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function encodeDavPath(pathname, collection = false) {
  const encoded = pathname.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return collection && !encoded.endsWith('/') ? `${encoded}/` : encoded;
}

function normalizePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new VfsError('Malformed WebDAV path', 400, 'MALFORMED_PATH');
  }
  if (decoded.length > 1 && decoded.endsWith('/')) return decoded.slice(0, -1);
  return decoded;
}

function httpDate(timestamp) {
  return new Date(timestamp).toUTCString();
}

function isoDate(timestamp) {
  return new Date(timestamp).toISOString();
}

function responseXml(entry, metadata) {
  const collection = entry.type === 'collection';
  const properties = collection
    ? '<d:resourcetype><d:collection/></d:resourcetype>'
    : [
        '<d:resourcetype/>',
        `<d:getcontentlength>${metadata.size}</d:getcontentlength>`,
        `<d:getcontenttype>${CONTENT_TYPE}</d:getcontenttype>`,
        `<d:getetag>${escapeXml(metadata.etag)}</d:getetag>`,
      ].join('');

  return [
    '<d:response>',
    `<d:href>${escapeXml(encodeDavPath(entry.path, collection))}</d:href>`,
    '<d:propstat><d:prop>',
    `<d:displayname>${escapeXml(entry.name)}</d:displayname>`,
    properties,
    `<d:getlastmodified>${escapeXml(httpDate(metadata.modifiedAt))}</d:getlastmodified>`,
    `<d:creationdate>${escapeXml(isoDate(metadata.modifiedAt))}</d:creationdate>`,
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>',
    '</d:response>',
  ].join('');
}

async function sendDavXml(response, entries, metadataForEntry) {
  const responses = [];
  for (const entry of entries) {
    responses.push(responseXml(entry, await metadataForEntry(entry)));
  }
  const body = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`;
  response.writeHead(207, {
    'content-type': 'application/xml; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    dav: '1',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendError(response, error) {
  const status = error instanceof VfsError ? error.status : 500;
  const code = error instanceof VfsError ? error.code : 'INTERNAL_ERROR';
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  const body = JSON.stringify({ error: error.message, code });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function parseContentRange(value) {
  const match = value?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  };
}

export function normalizeRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) throw new VfsError('Only one byte range is supported', 416, 'INVALID_RANGE');

  const [, startText, endText] = match;
  if (!startText && !endText) throw new VfsError('Malformed byte range', 416, 'INVALID_RANGE');

  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new VfsError('Malformed suffix range', 416, 'INVALID_RANGE');
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
    throw new VfsError('Byte range is outside the file', 416, 'RANGE_NOT_SATISFIABLE');
  }
  end = Math.min(end, size - 1);
  return { start, end, header: `bytes=${start}-${end}` };
}

function releaseKeyFor(handoff) {
  return `${handoff.infoHash.toLowerCase()}:${handoff.fileIndex == null ? 'torrent' : handoff.fileIndex}`;
}

function validateHandoff(handoff) {
  if (handoff.releaseKey !== releaseKeyFor(handoff)) {
    throw new VfsError(
      `Durable movie handoff identity is inconsistent for ${handoff.mediaId}`,
      500,
      'HANDOFF_INVALID',
    );
  }
}

function movieNameFromFilename(filename, mediaId) {
  const basename = path.posix.basename(String(filename || '').replaceAll('\\', '/'));
  const parsed = path.posix.parse(basename);
  const stem = parsed.name || basename || mediaId;
  const yearMatch = stem.match(/(?:^|[. _-])((?:19|20)\d{2})(?=$|[. _-])/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const titlePart = yearMatch ? stem.slice(0, yearMatch.index).trim() : stem.trim();
  const title = titlePart
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || mediaId;
  const extension = /^\.[a-z0-9]{1,10}$/i.test(parsed.ext) ? parsed.ext : '.mkv';
  return { title, year, extension };
}

function materializeMissingEntries(searchCache, now) {
  const handoffs = searchCache.listMoviePlaybackHandoffs();
  const existing = searchCache.listVfsMovieEntries();
  const byMediaId = new Map(existing.map((entry) => [entry.mediaId, entry]));
  const usedPaths = new Set(existing.map((entry) => entry.canonicalPath));

  for (const handoff of handoffs) {
    if (byMediaId.has(handoff.mediaId)) continue;
    validateHandoff(handoff);
    const movie = movieNameFromFilename(handoff.filename, handoff.mediaId);
    let canonicalPath = buildPreferredCanonicalPath({
      mediaType: 'movie',
      mediaId: handoff.mediaId,
      title: movie.title,
      year: movie.year,
    }, { extension: movie.extension });
    if (usedPaths.has(canonicalPath)) {
      canonicalPath = addDeterministicCollisionSuffix(canonicalPath, handoff.releaseKey);
    }
    const timestamp = now();
    const created = searchCache.createVfsMovieEntry({
      mediaId: handoff.mediaId,
      releaseKey: handoff.releaseKey,
      infoHash: handoff.infoHash,
      fileIndex: handoff.fileIndex,
      canonicalPath,
      size: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    byMediaId.set(created.mediaId, created);
    usedPaths.add(created.canonicalPath);
    console.log(`[vfs] materialized media=${created.mediaId} path="${created.canonicalPath}" release=${created.releaseKey}`);
  }
}

function buildTree(states) {
  const root = { path: DAV_ROOT, name: 'vfs', type: 'collection' };
  const entries = new Map([[DAV_ROOT, root]]);
  const children = new Map();

  function addChild(parentPath, child) {
    const siblings = children.get(parentPath) || [];
    if (!siblings.some((entry) => entry.path === child.path)) siblings.push(child);
    children.set(parentPath, siblings);
  }

  for (const state of states) {
    const segments = state.entry.canonicalPath.split('/');
    let parentPath = DAV_ROOT;
    segments.forEach((segment, index) => {
      const entryPath = `${parentPath}/${segment}`;
      const isFile = index === segments.length - 1;
      let treeEntry = entries.get(entryPath);
      if (!treeEntry) {
        treeEntry = {
          path: entryPath,
          name: segment,
          type: isFile ? 'file' : 'collection',
          ...(isFile ? { state } : {}),
        };
        entries.set(entryPath, treeEntry);
        addChild(parentPath, treeEntry);
      }
      parentPath = entryPath;
    });
  }

  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.name.localeCompare(right.name));
  }
  return { entries, children };
}

function getEntries(tree, pathname, depth) {
  const entry = tree.entries.get(pathname);
  if (!entry) return null;
  return depth === '0' ? [entry] : [entry, ...(tree.children.get(pathname) || [])];
}



function sizeFromRdResult(result) {
  const file = result.torrentInfo?.files?.find((item) => String(item.id) === String(result.rdFileId));
  return Number.isSafeInteger(file?.bytes) && file.bytes > 0 ? file.bytes : null;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed.
  }
}

function metadataFromState(state) {
  return {
    size: state.entry.size,
    modifiedAt: state.handoff.selectedAt,
    etag: `"${state.entry.releaseKey}-${state.entry.size}"`,
  };
}

export function createMovieWebDav({
  searchCache,
  controlPlaneStore,
  rdClient,
  rdResolutionCache,
  resolveTorBoxDelivery,
  now = () => Date.now(),
  fetchFn = fetch,
}) {
  const states = new Map();

  function getCatalog() {
    materializeMissingEntries(searchCache, now);
    const nextStates = [];
    for (const entry of searchCache.listVfsMovieEntries()) {
      let state = states.get(entry.releaseKey);
      if (!state) {
        const handoff = searchCache.getPlaybackHandoffByReleaseKey(entry.mediaId, entry.releaseKey);
        if (!handoff) {
          throw new VfsError(
            `Durable handoff is missing for VFS movie ${entry.mediaId}`,
            503,
            'HANDOFF_MISSING',
          );
        }
        validateHandoff(handoff);
        state = { entry, handoff, metadataPromise: null };
        states.set(entry.releaseKey, state);
        console.log(`[vfs] bound media=${entry.mediaId} release=${entry.releaseKey}`);
      } else if (state.entry.size == null && entry.size != null) {
        state.entry = entry;
      }
      nextStates.push(state);
    }
    return buildTree(nextStates);
  }

  async function resolveBacking(state, { forceFresh = false } = {}) {
    const { handoff } = state;
    if (forceFresh) rdResolutionCache.delete(handoff.infoHash, handoff.fileIndex);

    if (rdClient) {
      const cached = forceFresh ? null : rdResolutionCache.get(handoff.infoHash, handoff.fileIndex);
      if (cached) {
        return { provider: 'realdebrid', url: cached.url, size: null, resolution: 'cache' };
      }

      const result = await rdResolutionCache.getOrInFlight(
        handoff.infoHash,
        handoff.fileIndex,
        () => attemptRdResolution(rdClient, searchCache, {
          infoHash: handoff.infoHash,
          fileIndex: handoff.fileIndex,
          filename: handoff.filename,
          size: state.entry.size,
        }, { now }),
      );

      if (result.status === 'resolved') {
        const url = await getRdPlaybackUrl(rdClient, result.torrentInfo, result.rdFileId);
        if (await isUrlLive(url, { fetchFn })) {
          rdResolutionCache.set(handoff.infoHash, handoff.fileIndex, url, result.torrentId, result.rdFileId);
          return {
            provider: 'realdebrid',
            url,
            size: sizeFromRdResult(result),
            resolution: 'fresh',
          };
        }
        console.warn(`[vfs] provider=realdebrid resolution=fresh failure=dead-url release=${handoff.releaseKey}`);
      } else {
        const reason = result.error?.code || result.reason || 'unavailable';
        console.warn(`[vfs] provider=realdebrid resolution=failed failure=${reason} release=${handoff.releaseKey}`);
      }
    }

    if (!resolveTorBoxDelivery) {
      throw new VfsError('No TorBox delivery resolver is available', 503, 'TORBOX_DELIVERY_UNAVAILABLE');
    }
    const delivery = await resolveTorBoxDelivery({
      infoHash: handoff.infoHash,
      fileIndex: handoff.fileIndex,
      releaseKey: handoff.releaseKey,
      filename: handoff.filename,
    });
    return {
      provider: 'torbox',
      url: delivery.url,
      size: delivery.size,
      resolution: forceFresh ? 'remapped' : 'mapped',
    };
  }

  async function fetchProvider(backing, rangeHeader) {
    return fetchFn(backing.url, {
      method: 'GET',
      headers: rangeHeader ? { range: rangeHeader } : {},
      redirect: 'follow',
    });
  }

  async function openValidatedProviderRead(state, rangeHeader, validate) {
    let firstFailure = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const forceFresh = attempt === 1;
      const backing = await resolveBacking(state, { forceFresh });
      let upstream;
      try {
        upstream = await fetchProvider(backing, rangeHeader);
      } catch (error) {
        firstFailure ||= error;
        if (!forceFresh) continue;
        throw new VfsError('Provider read failed after fresh resolution', 502, 'PROVIDER_READ_FAILED');
      }

      const validationError = validate(upstream);
      if (!validationError) return { backing, upstream };
      await cancelBody(upstream);
      firstFailure ||= validationError;
      if (!forceFresh) {
        const readFailure = upstream.status === 429
          ? 'rate-limited'
          : STALE_PROVIDER_STATUSES.has(upstream.status) ? 'stale' : 'invalid';
        console.warn(`[vfs] provider=${backing.provider} read=${readFailure} status=${upstream.status} release=${state.entry.releaseKey}`);
        if (upstream.status !== 429) continue;
      }
      throw validationError;
    }
    throw firstFailure || new VfsError('Provider read failed', 502, 'PROVIDER_READ_FAILED');
  }

  async function loadMetadata(state) {
    if (state.entry.size != null) return metadataFromState(state);

    let backing = await resolveBacking(state);
    let size = backing.size;
    if (size == null) {
      const opened = await openValidatedProviderRead(state, 'bytes=0-0', (probe) => {
        const contentRange = parseContentRange(probe.headers.get('content-range'));
        return probe.status === 206
          && contentRange?.start === 0
          && contentRange.end === 0
          && Number.isSafeInteger(contentRange.total)
          && contentRange.total > 0
          ? null
          : new VfsError(
              'Provider did not supply usable byte-range size metadata',
              502,
              'PROVIDER_SIZE_UNAVAILABLE',
            );
      });
      const contentRange = parseContentRange(opened.upstream.headers.get('content-range'));
      size = contentRange.total;
      await cancelBody(opened.upstream);
      backing = opened.backing;
    }

    const persisted = searchCache.setVfsMovieEntrySize(
      state.entry.mediaId,
      state.entry.releaseKey,
      size,
      now(),
    );
    if (!persisted || persisted.releaseKey !== state.entry.releaseKey || persisted.size !== size) {
      throw new VfsError('Durable VFS size conflicts with provider metadata', 502, 'PROVIDER_SIZE_MISMATCH');
    }
    state.entry = persisted;
    console.log(`[vfs] stat path="${DAV_ROOT}/${state.entry.canonicalPath}" size=${size} release=${state.entry.releaseKey} provider=${backing.provider}`);
    return metadataFromState(state);
  }

  // Return durable metadata only — no provider resolution.
  // Used by PROPFIND/listing where Plex scans should not depend on provider availability.
  function getDurableMetadata(state) {
    return metadataFromState(state);
  }

  // Resolve and persist size via provider. Only called on actual media reads (GET).
  async function ensureMetadata(state) {
    if (state.entry.size != null) return metadataFromState(state);
    if (state.metadataPromise) return state.metadataPromise;
    state.metadataPromise = loadMetadata(state);
    try {
      return await state.metadataPromise;
    } finally {
      state.metadataPromise = null;
    }
  }

  async function streamFile(request, response, state, metadata) {
    const requestedRange = normalizeRange(request.headers.range, metadata.size);
    const opened = await openValidatedProviderRead(
      state,
      requestedRange?.header,
      (upstream) => {
        if (requestedRange) {
          const upstreamRange = parseContentRange(upstream.headers.get('content-range'));
          if (upstream.status !== 206) {
            return new VfsError('Provider did not honor the requested byte range', 502, 'PROVIDER_RANGE_FAILED');
          }
          if (!upstreamRange
            || upstreamRange.start !== requestedRange.start
            || upstreamRange.end !== requestedRange.end
            || upstreamRange.total !== metadata.size) {
            return new VfsError('Provider returned inconsistent range metadata', 502, 'PROVIDER_RANGE_MISMATCH');
          }
        } else if (upstream.status !== 200) {
          return new VfsError(`Provider returned HTTP ${upstream.status}`, 502, 'PROVIDER_READ_FAILED');
        }
        return upstream.body
          ? null
          : new VfsError('Provider response had no body', 502, 'PROVIDER_EMPTY_BODY');
      },
    );
    const { backing, upstream } = opened;

    const contentLength = requestedRange
      ? requestedRange.end - requestedRange.start + 1
      : metadata.size;
    const headers = {
      'content-type': CONTENT_TYPE,
      'content-length': String(contentLength),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      etag: metadata.etag,
      'last-modified': httpDate(metadata.modifiedAt),
    };
    if (requestedRange) {
      headers['content-range'] = `bytes ${requestedRange.start}-${requestedRange.end}/${metadata.size}`;
    }

    const filePath = `${DAV_ROOT}/${state.entry.canonicalPath}`;
    console.log(`[vfs] open path="${filePath}" range=${requestedRange?.header || 'full'} length=${contentLength} provider=${backing.provider} resolution=${backing.resolution}`);
    response.writeHead(requestedRange ? 206 : 200, headers);

    if (!upstream.body) {
      throw new VfsError('Provider response had no body', 502, 'PROVIDER_EMPTY_BODY');
    }
    const stream = Readable.fromWeb(upstream.body);
    const abort = () => stream.destroy();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      stream.pipe(response);
      await finished(stream);
    } finally {
      request.removeListener('aborted', abort);
      response.removeListener('close', abort);
    }
  }

  return async function handleMovieWebDav(request, response, url) {
    if (!url.pathname.startsWith(`${DAV_ROOT}/Movies`)) return false;

    try {
      const pathname = normalizePath(url.pathname);
      const method = request.method?.toUpperCase();

      if (method === 'OPTIONS') {
        response.writeHead(200, {
          allow: 'OPTIONS, PROPFIND, HEAD, GET',
          dav: '1',
          'ms-author-via': 'DAV',
          'content-length': '0',
        });
        response.end();
        return true;
      }

      const tree = getCatalog();
      if (method === 'PROPFIND') {
        const depth = request.headers.depth ?? '1';
        if (depth !== '0' && depth !== '1') {
          throw new VfsError('Only WebDAV Depth 0 and 1 are supported', 403, 'UNSUPPORTED_DEPTH');
        }
        const entries = getEntries(tree, pathname, depth);
        if (!entries) throw new VfsError('WebDAV path not found', 404, 'PATH_NOT_FOUND');
        const collectionModifiedAt = Math.max(
          0,
          ...Array.from(tree.entries.values())
            .filter((entry) => entry.type === 'file')
            .map((entry) => entry.state.handoff.selectedAt),
        );
        await sendDavXml(response, entries, (entry) => entry.type === 'file'
          ? getDurableMetadata(entry.state)
          : { size: 0, modifiedAt: collectionModifiedAt, etag: '"collection"' });
        return true;
      }

      const entry = tree.entries.get(pathname);
      if (!entry) throw new VfsError('WebDAV path not found', 404, 'PATH_NOT_FOUND');
      if (entry.type !== 'file') {
        throw new VfsError('Collections are read-only', 405, 'COLLECTION_READ_ONLY');
      }

      const metadata = await ensureMetadata(entry.state);
      if (method === 'HEAD') {
        console.log(`[vfs] stat path="${entry.path}" size=${metadata.size} release=${entry.state.entry.releaseKey}`);
        response.writeHead(200, {
          'content-type': CONTENT_TYPE,
          'content-length': String(metadata.size),
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          etag: metadata.etag,
          'last-modified': httpDate(metadata.modifiedAt),
        });
        response.end();
        return true;
      }
      if (method === 'GET') {
        await streamFile(request, response, entry.state, metadata);
        return true;
      }

      response.writeHead(405, {
        allow: 'OPTIONS, PROPFIND, HEAD, GET',
        'content-length': '0',
      });
      response.end();
      return true;
    } catch (error) {
      console.error(`[vfs] failure method=${request.method} path="${url.pathname}" code=${error.code || 'INTERNAL_ERROR'} message=${error.message}`);
      sendError(response, error);
      return true;
    }
  };
}

export const MOVIE_VFS_ROOT = MOVIES_PATH;
