/**
 * Local permanent-file serving for the /stream transition (Phase 7).
 *
 * Once a promotion is permanent, the SAME logical library item (same
 * STRM, same resolver URL) is served from owned bytes instead of a
 * provider redirect. No republication, no duplicate consumer items,
 * no refresh required: the URL contract is unchanged, only the
 * backing changes.
 *
 * Full HTTP Range support (200 / 206 / 416) so direct play behaves
 * exactly like provider-backed delivery from the consumer's view.
 */

import fs from 'node:fs';

const CONTENT_TYPES = new Map([
  ['.mkv', 'video/x-matroska'],
  ['.mp4', 'video/mp4'],
  ['.avi', 'video/x-msvideo'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.m4v', 'video/x-m4v'],
  ['.ts', 'video/mp2t'],
  ['.m2ts', 'video/mp2t'],
]);

function contentTypeFor(filePath) {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  return CONTENT_TYPES.get(ext) ?? 'application/octet-stream';
}

function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  let start; let end;
  if (startStr === '' && endStr === '') return null;
  if (startStr === '') {
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0) return null;
    end = endStr === '' ? size - 1 : Number(endStr);
    if (!Number.isSafeInteger(end) || end < start) return null;
    end = Math.min(end, size - 1);
  }
  if (start >= size) return null;
  return { start, end };
}

/** Serve a permanent file with Range support. Returns true when served. */
export function serveLocalFile(response, filePath, rangeHeader) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size <= 0) return false;
  const size = stat.size;
  const range = parseRange(rangeHeader, size);
  if (!range) {
    response.writeHead(416, {
      'content-range': `bytes */${size}`,
      'accept-ranges': 'bytes',
    });
    response.end();
    return true;
  }
  const { start, end } = range;
  const chunkSize = end - start + 1;
  const partial = start !== 0 || end !== size - 1;
  response.writeHead(partial ? 206 : 200, {
    'content-type': contentTypeFor(filePath),
    'content-length': chunkSize,
    'accept-ranges': 'bytes',
    ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    'cache-control': 'no-store',
    'x-storage': 'permanent',
  });
  fs.createReadStream(filePath, { start, end }).pipe(response);
  return true;
}
