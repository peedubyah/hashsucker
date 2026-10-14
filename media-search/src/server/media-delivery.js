/**
 * Media byte delivery — GET /media/{info_hash}/{file_index}.
 *
 * Wires identity → control-plane projection → byte source → transport →
 * HTTP response, and owns the error→status mapping for the resolver,
 * source, and transport layers. Transport mechanics (Range parsing, byte
 * streaming with backpressure/fd hygiene) live with the delivery route
 * that uses them.
 */

import { resolveProjection, parseIdentityFromParams, ResolverError } from '../lib/resolver/resolver.js';
import { buildMediaSource, SourceError } from '../lib/resolver/source.js';
import { createMediaStream, TransportError } from '../lib/resolver/transport.js';
import { requireControlPlaneStore } from './route-helpers.js';

/**
 * Parse HTTP Range header into transport byte options.
 * Supports: bytes=start-end, bytes=start-, bytes=-suffix
 * Returns null if no valid range header present.
 * Throws on malformed ranges.
 */
export function parseByteRange(rangeHeader, fileSize) {
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
export function sendMediaStream(response, { stream, metadata, status, isRange }) {
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
export function mapMediaError(error) {
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
export async function handleMediaDelivery({ request, response, controlPlaneStore, env }) {
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
