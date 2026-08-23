/**
 * Media Source Projection — Phase 1.5.
 *
 * Consumes the resolver projection and produces an immutable MediaSource:
 *
 *   Resolver Projection
 *     ↓
 *   Transport resolution
 *   Mount resolution
 *   Path construction + validation
 *     ↓
 *   MediaSource (or error)
 *
 * Answers: "Where are the bytes, how should they be served, and what metadata is known?"
 * WITHOUT opening the file.
 *
 * No filesystem reads. No fs.stat(). No streams. No provider calls. No writes.
 */

import path from 'node:path';

import { resolveMountRoot } from './mounts.js';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.mkv', 'video/x-matroska'],
  ['.mp4', 'video/mp4'],
  ['.avi', 'video/x-msvideo'],
  ['.mov', 'video/quicktime'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.flv', 'video/x-flv'],
  ['.webm', 'video/webm'],
  ['.m4v', 'video/x-m4v'],
  ['.mp3', 'audio/mpeg'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
]);

export class SourceError extends Error {
  constructor(message, code, reason) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.reason = reason;
  }
}

/**
 * Extract filename from a filesystem path.
 */
function extractFilename(absolutePath) {
  const base = path.basename(absolutePath);
  return base || null;
}

/**
 * Derive content type from file extension.
 */
function deriveContentType(filename) {
  if (!filename) return 'application/octet-stream';
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES.get(ext) || 'application/octet-stream';
}

/**
 * Validate that an absolute path remains within the configured mount root.
 * Rejects path traversal attempts.
 */
function validatePathContainment(absolutePath, mountRoot) {
  const relative = path.relative(mountRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SourceError(
      'Path traversal detected — resolved path escapes mount root',
      'path-traversal',
      'invalid-path',
    );
  }
  return relative;
}

/**
 * Construct and validate absolute filesystem path from mount root + relative_path.
 */
function constructAbsolutePath({ mountRoot, relativePath }) {
  const absolutePath = path.resolve(mountRoot, relativePath);
  validatePathContainment(absolutePath, mountRoot);
  return absolutePath;
}

/**
 * Build a MediaSource from a resolver projection.
 *
 * @param {Object} options
 * @param {Object} options.projection - Resolver projection from resolveProjection()
 * @param {Object} [options.env] - Environment variables (defaults to process.env)
 * @returns {Object} MediaSource object
 * @throws {SourceError} If source cannot be constructed
 */
export function buildMediaSource({ projection, env = process.env }) {
  const { identity, binding, exposure, mount, providerFile } = projection;

  if (!binding) {
    throw new SourceError('No active binding for identity', 'no-binding', 'unavailable');
  }

  if (!exposure) {
    throw new SourceError('No exposure for binding', 'no-exposure', 'unavailable');
  }

  if (exposure.relativePath == null) {
    throw new SourceError(
      'Exposure has NULL relative_path',
      'null-relative-path',
      'unavailable',
    );
  }

  if (!mount.configured) {
    throw new SourceError(
      `Mount scope "${mount.mountScope}" is not configured`,
      'mount-not-configured',
      'unavailable',
    );
  }

  const absolutePath = constructAbsolutePath({
    mountRoot: mount.root,
    relativePath: exposure.relativePath,
  });

  const filename = providerFile?.name || extractFilename(absolutePath);
  const contentType = deriveContentType(filename);

  return Object.freeze({
    identity: Object.freeze({
      infoHash: identity.infoHash,
      fileIndex: identity.fileIndex,
      releaseKey: identity.releaseKey,
    }),
    transport: exposure.transport,
    absolutePath,
    relativePath: exposure.relativePath,
    size: providerFile?.size ?? null,
    filename,
    contentType,
    exposureId: exposure.id,
    bindingId: binding.id,
  });
}

/**
 * Check whether a projection can produce a valid MediaSource.
 * Returns { valid: true } or { valid: false, reason }.
 */
export function canBuildSource(projection) {
  const { binding, exposure, mount } = projection;

  if (!binding) {
    return { valid: false, reason: 'no-binding' };
  }
  if (!exposure) {
    return { valid: false, reason: 'no-exposure' };
  }
  if (exposure.relativePath == null) {
    return { valid: false, reason: 'null-relative-path' };
  }
  if (!mount?.configured) {
    return { valid: false, reason: 'mount-not-configured' };
  }
  return { valid: true };
}
