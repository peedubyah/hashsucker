import { createHash } from 'node:crypto';
import { lstat as defaultLstat } from 'node:fs/promises';
import path from 'node:path';

import { PROVIDER_CAPABILITIES, createProviderAdapter } from './capabilities.js';
import { classifyProviderError, ProviderOperationError } from './errors.js';
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
    mountScope = 'default',
    rootPath,
    transport,
    readOnly = false,
    lstatFn = defaultLstat,
    now = () => Date.now(),
    exposureTtlMs = DEFAULT_EXPOSURE_TTL_MS,
  } = options;
  const normalizedProvider = requireIdentifier(provider, 'provider');
  const normalizedAccountScope = requireIdentifier(accountScope, 'accountScope');
  const normalizedMountScope = requireIdentifier(mountScope, 'mountScope');
  const normalizedTransport = requireIdentifier(transport, 'transport');
  const root = requireAbsolutePath(rootPath, 'rootPath');
  if (readOnly !== true) throw new TypeError('Filesystem exposure provider requires an explicitly read-only transport');
  if (!Number.isSafeInteger(exposureTtlMs) || exposureTtlMs < 0) {
    throw new TypeError('exposureTtlMs must be a non-negative safe integer');
  }

  return createProviderAdapter({
    provider: normalizedProvider,
    accountScope: normalizedAccountScope,
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
            state = stat.isFile() ? 'visible' : 'missing';
            evidence = {
              kind: stat.isSymbolicLink() ? 'symbolic-link' : stat.isFile() ? 'file' : 'other',
              size: Number.isSafeInteger(stat.size) ? stat.size : null,
            };
          } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
              state = 'missing';
            } else {
              const providerError = classifyFilesystemError(error, {
                provider: normalizedProvider, operation: 'observe-exposure',
              });
              state = 'error';
              failureCategory = providerError.category;
              retryable = providerError.retryable;
            }
          }

          return createExposureObservation({
            provider: normalizedProvider,
            accountScope: normalizedAccountScope,
            providerResourceId,
            providerFileId,
            transport: normalizedTransport,
            exposureKey: createPathExposureKey({
              provider: normalizedProvider,
              accountScope: normalizedAccountScope,
              mountScope: normalizedMountScope,
              transport: normalizedTransport,
              relativePath,
            }),
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

/**
 * Real-Debrid file exposure seam for an externally managed Zurg/rclone mount.
 *
 * Zurg repair can persist a working link in `.zurgtorrent` metadata while
 * deleting the temporary Real-Debrid resource, so `providerResourceId` is only
 * placement context. Exact visibility remains the explicit mapped mount path;
 * metadata/lifecycle evidence belongs in the separate Zurg metadata observer.
 */
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

function requireIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.trim())) {
    throw new TypeError(`${field} must be a non-empty provider-safe identifier`);
  }
  return value.trim().toLowerCase();
}

function createPathExposureKey(scope) {
  const tuple = JSON.stringify([
    scope.provider,
    scope.accountScope,
    scope.mountScope,
    scope.transport,
    scope.relativePath,
  ]);
  return `path-sha256:${createHash('sha256').update(tuple).digest('hex')}`;
}

function classifyFilesystemError(error, context) {
  const code = String(error?.code || '').toUpperCase();
  if (code === 'EACCES' || code === 'EPERM') {
    return new ProviderOperationError(error?.message || 'Filesystem access denied', {
      ...context, category: 'authorization', retryable: false, cause: error,
    });
  }
  if (['EIO', 'ESTALE', 'ENOTCONN', 'EHOSTUNREACH'].includes(code)) {
    return new ProviderOperationError(error?.message || 'Filesystem transport unavailable', {
      ...context, category: 'temporarily-unavailable', retryable: true, cause: error,
    });
  }
  return classifyProviderError(error, context);
}
