import { lstat as defaultLstat } from 'node:fs/promises';
import path from 'node:path';

import { PROVIDER_CAPABILITIES, createProviderAdapter } from './capabilities.js';
import { classifyProviderError } from './errors.js';
import { createExposureObservation } from './resources.js';

const DEFAULT_EXPOSURE_TTL_MS = 30_000;

/**
 * Observe one explicitly mapped provider file under an externally managed,
 * read-only filesystem transport. No Zurg/WebDAV HTTP behavior is assumed.
 */
export function createFilesystemExposureProvider(options = {}) {
  const {
    provider,
    accountScope = 'default',
    rootPath,
    transport,
    readOnly = false,
    lstatFn = defaultLstat,
    now = () => Date.now(),
    exposureTtlMs = DEFAULT_EXPOSURE_TTL_MS,
  } = options;
  const root = requireAbsolutePath(rootPath, 'rootPath');
  if (readOnly !== true) throw new TypeError('Filesystem exposure provider requires an explicitly read-only transport');
  if (!Number.isSafeInteger(exposureTtlMs) || exposureTtlMs < 0) {
    throw new TypeError('exposureTtlMs must be a non-negative safe integer');
  }

  return createProviderAdapter({
    provider,
    accountScope,
    capabilities: {
      [PROVIDER_CAPABILITIES.EXPOSURE]: {
        async observeExposure(file, context = {}) {
          const providerResourceId = requireString(file?.providerResourceId, 'providerResourceId');
          const providerFileId = requireString(file?.providerFileId, 'providerFileId');
          const relativePath = normalizeRelativePath(file?.relativePath);
          const observedAt = now();
          const absolutePath = path.resolve(root, relativePath);
          if (!isContained(root, absolutePath)) throw new TypeError('relativePath must remain under rootPath');

          let state = 'unknown';
          let failureCategory = null;
          let retryable = null;
          let evidence = null;
          try {
            const stat = await lstatFn(absolutePath, { signal: context.signal });
            state = stat.isFile() || stat.isSymbolicLink() ? 'visible' : 'missing';
            evidence = {
              kind: stat.isSymbolicLink() ? 'symbolic-link' : stat.isFile() ? 'file' : 'other',
              size: Number.isSafeInteger(stat.size) ? stat.size : null,
            };
          } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
              state = 'missing';
            } else {
              const providerError = classifyProviderError(error, {
                provider, operation: 'observe-exposure',
              });
              state = 'error';
              failureCategory = providerError.category;
              retryable = providerError.retryable;
            }
          }

          return createExposureObservation({
            provider,
            accountScope,
            providerResourceId,
            providerFileId,
            transport,
            exposureKey: `${transport}:${providerResourceId}:${providerFileId}`,
            relativePath,
            state,
            readOnly: true,
            observedAt,
            ttlMs: exposureTtlMs,
            failureCategory,
            retryable,
            evidence,
          });
        },
      },
    },
  });
}

/** Real-Debrid exposure seam for an externally managed Zurg/rclone mount. */
export function createZurgExposureProvider(options = {}) {
  return createFilesystemExposureProvider({
    ...options,
    provider: 'realdebrid',
    transport: options.transport ?? 'zurg-rclone',
  });
}

/** TorBox exposure seam for an explicitly configured native-WebDAV mount. */
export function createTorBoxNativeWebDavExposureProvider(options = {}) {
  return createFilesystemExposureProvider({
    ...options,
    provider: 'torbox',
    transport: options.transport ?? 'torbox-native-webdav',
  });
}

function requireAbsolutePath(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  return path.resolve(value);
}

function normalizeRelativePath(value) {
  const normalized = requireString(value, 'relativePath').replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized)) throw new TypeError('relativePath must be relative');
  const result = path.posix.normalize(normalized);
  if (result === '..' || result.startsWith('../')) throw new TypeError('relativePath cannot traverse parent directories');
  return result.replace(/^\.\//, '');
}

function isContained(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2000) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}
