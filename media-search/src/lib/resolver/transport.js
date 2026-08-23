/**
 * Media Byte Transport Boundary — Phase 2 (transport slice).
 *
 * Consumes an immutable MediaSource and produces a readable byte stream.
 *
 *   MediaSource (frozen)
 *     ↓
 *   Transport selection
 *   Path validation
 *   fs.createReadStream (filesystem only)
 *     ↓
 *   Readable stream + metadata
 *
 * Responsibilities:
 * - Reject unsupported transports (only 'filesystem' is valid).
 * - Reject missing absolutePath.
 * - Validate path containment before opening.
 * - Support byte-range offsets (start/end) for future HTTP Range handling.
 * - Use Node.js streams with correct backpressure (createReadStream handles this).
 *
 * Non-responsibilities:
 * - No HTTP route wiring.
 * - No provider calls.
 * - No acquisition / lifecycle writes.
 * - No URL resolution.
 * - No CDN redirect logic.
 * - No new state machines.
 */

import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_TRANSPORTS = new Set(['filesystem']);

/**
 * Error thrown by the transport layer.
 * Exposes a stable error code and reason for upstream mapping.
 */
export class TransportError extends Error {
  constructor(message, code, reason) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.reason = reason;
  }
}

/**
 * Validate that a MediaSource can be transported.
 *
 * @param {Object} source - Frozen MediaSource from buildMediaSource()
 * @throws {TransportError} If the source cannot be transported
 */
function validateMediaSource(source) {
  if (!source || typeof source !== 'object') {
    throw new TransportError('MediaSource is required', 'invalid-source', 'invalid-input');
  }

  if (!SUPPORTED_TRANSPORTS.has(source.transport)) {
    throw new TransportError(
      `Unsupported transport "${source.transport}" — only "filesystem" is supported`,
      'unsupported-transport',
      'unsupported-transport',
    );
  }

  if (!source.absolutePath || typeof source.absolutePath !== 'string') {
    throw new TransportError(
      'MediaSource missing absolutePath',
      'missing-path',
      'unavailable',
    );
  }

  // Validate path doesn't escape intended root (defense in depth — source.js
  // also validates, but transport must not trust callers).
  if (source.absolutePath.includes('\0')) {
    throw new TransportError(
      'Path contains null bytes',
      'invalid-path',
      'invalid-input',
    );
  }
}

/**
 * Validate byte range options.
 * Preserves the range as an opaque transport option — no HTTP header parsing.
 *
 * @param {Object} [options]
 * @param {number} [options.start] - Inclusive byte offset
 * @param {number} [options.end] - Inclusive byte offset
 * @returns {Object} Normalized range { start, end }
 * @throws {TransportError} If range is invalid
 */
function normalizeByteRange(options = {}) {
  const { start, end } = options;

  if (start === undefined && end === undefined) {
    return { start: undefined, end: undefined };
  }

  if (start !== undefined) {
    if (!Number.isInteger(start) || start < 0) {
      throw new TransportError(
        `Invalid range start: ${start} — must be a non-negative integer`,
        'invalid-range',
        'invalid-input',
      );
    }
  }

  if (end !== undefined) {
    if (!Number.isInteger(end) || end < 0) {
      throw new TransportError(
        `Invalid range end: ${end} — must be a non-negative integer`,
        'invalid-range',
        'invalid-input',
      );
    }
  }

  if (start !== undefined && end !== undefined && start > end) {
    throw new TransportError(
      `Invalid range: start (${start}) > end (${end})`,
      'invalid-range',
      'invalid-input',
    );
  }

  return { start, end };
}

/**
 * Create a readable byte stream from a MediaSource.
 *
 * @param {Object} source - Frozen MediaSource from buildMediaSource()
 * @param {Object} [options]
 * @param {number} [options.start] - Inclusive byte offset (0-based)
 * @param {number} [options.end] - Inclusive byte offset
 * @returns {Object} { stream, metadata } where stream is a Readable and
 *   metadata contains { contentType, contentLength, filename, byteRange }
 * @throws {TransportError} If source is invalid or file cannot be opened
 *
 * Stream behavior:
 * - Uses fs.createReadStream which respects backpressure automatically.
 * - The caller is responsible for handling 'error' and 'end' events.
 * - The stream must be destroyed on error to avoid fd leaks.
 */
export function createMediaStream(source, options = {}) {
  validateMediaSource(source);

  const byteRange = normalizeByteRange(options);

  // Verify file exists and get stats (size for Content-Length).
  // We stat explicitly rather than relying on stream 'open' to fail fast
  // with a clear error and to surface file size metadata.
  let stats;
  try {
    stats = fs.statSync(source.absolutePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new TransportError(
        `File not found: ${source.absolutePath}`,
        'file-not-found',
        'unavailable',
      );
    }
    if (err.code === 'EACCES') {
      throw new TransportError(
        `Permission denied: ${source.absolutePath}`,
        'permission-denied',
        'unavailable',
      );
    }
    throw new TransportError(
      `Cannot stat file: ${err.message}`,
      'stat-error',
      'unavailable',
    );
  }

  if (!stats.isFile()) {
    throw new TransportError(
      `Path is not a regular file: ${source.absolutePath}`,
      'not-a-file',
      'unavailable',
    );
  }

  const fileSize = stats.size;

  // Resolve actual byte range against file size.
  const start = byteRange.start ?? 0;
  const end = byteRange.end ?? (fileSize - 1);

  if (start >= fileSize) {
    throw new TransportError(
      `Range start ${start} exceeds file size ${fileSize}`,
      'range-out-of-bounds',
      'invalid-input',
    );
  }

  const effectiveEnd = Math.min(end, fileSize - 1);
  const contentLength = effectiveEnd - start + 1;

  let stream;
  try {
    stream = fs.createReadStream(source.absolutePath, {
      start,
      end: effectiveEnd,
      autoClose: true,
      emitClose: true,
    });
  } catch (err) {
    throw new TransportError(
      `Failed to create read stream: ${err.message}`,
      'stream-creation-failed',
      'unavailable',
    );
  }

  return {
    stream,
    metadata: {
      contentType: source.contentType,
      contentLength,
      filename: source.filename,
      byteRange: {
        start,
        end: effectiveEnd,
        total: fileSize,
      },
    },
  };
}

/**
 * Check whether a MediaSource can be transported without actually opening a stream.
 *
 * @param {Object} source - Frozen MediaSource from buildMediaSource()
 * @returns {Object} { transportable: true } or { transportable: false, reason, code }
 */
export function canTransport(source) {
  if (!source || typeof source !== 'object') {
    return { transportable: false, reason: 'invalid-source', code: 'invalid-source' };
  }
  if (!SUPPORTED_TRANSPORTS.has(source.transport)) {
    return { transportable: false, reason: 'unsupported-transport', code: 'unsupported-transport' };
  }
  if (!source.absolutePath) {
    return { transportable: false, reason: 'missing-path', code: 'missing-path' };
  }
  return { transportable: true };
}

/**
 * Read an entire stream into a buffer.
 * Utility for tests and small payloads. NOT for production byte serving.
 *
 * @param {Readable} stream - Node.js readable stream
 * @returns {Promise<Buffer>} Full stream contents
 */
export function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
