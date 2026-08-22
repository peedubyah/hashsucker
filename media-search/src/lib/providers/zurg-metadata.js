import { lstat as defaultLstat, readFile as defaultReadFile } from 'node:fs/promises';
import path from 'node:path';

import { createReleaseIdentity } from '../../api/release-contract.js';
import { classifyProviderError, ProviderOperationError } from './errors.js';

const DEFAULT_OBSERVATION_TTL_MS = 30_000;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

/**
 * Read one explicitly identified `.zurgtorrent` file from a read-only view of
 * Zurg's data directory.
 *
 * This is torrent-level Zurg metadata evidence, not Real-Debrid placement or
 * file-inventory authority and not proof that a path is currently exposed by
 * WebDAV/rclone. Raw links and Zurg's provider-resource tracking sets are never
 * returned.
 */
export function createZurgTorrentMetadataObserver(options = {}) {
  const {
    accountScope = 'default',
    instanceScope = 'default',
    dataPath,
    readOnly = false,
    lstatFn = defaultLstat,
    readFileFn = defaultReadFile,
    now = () => Date.now(),
    observationTtlMs = DEFAULT_OBSERVATION_TTL_MS,
    maxMetadataBytes = MAX_METADATA_BYTES,
  } = options;
  const normalizedAccountScope = requireIdentifier(accountScope, 'accountScope');
  const normalizedInstanceScope = requireIdentifier(instanceScope, 'instanceScope');
  const root = requireAbsolutePath(dataPath, 'dataPath');
  if (readOnly !== true) {
    throw new TypeError('Zurg metadata observer requires an explicitly read-only data path');
  }
  validateNonNegativeInteger(observationTtlMs, 'observationTtlMs');
  validateNonNegativeInteger(maxMetadataBytes, 'maxMetadataBytes');

  return Object.freeze({
    async observeMetadata(subject, context = {}) {
      const identity = createReleaseIdentity(subject?.infoHash, null);
      const metadataPath = normalizeMetadataPath(subject?.metadataPath);
      const absolutePath = path.resolve(root, metadataPath);
      if (!isContained(root, absolutePath)) {
        throw new TypeError('metadataPath must remain under dataPath');
      }

      const observedAt = now();
      const base = {
        provider: 'realdebrid',
        accountScope: normalizedAccountScope,
        instanceScope: normalizedInstanceScope,
        source: 'zurg-zurgtorrent-v1',
        ...identity,
        metadataPath,
        observedAt,
        expiresAt: observedAt + observationTtlMs,
      };

      try {
        const stat = await lstatFn(absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink?.()) {
          throw invalidMetadata('Zurg metadata path must identify a regular, non-symbolic-link file');
        }
        if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxMetadataBytes) {
          throw invalidMetadata(`Zurg metadata file exceeds the ${maxMetadataBytes}-byte read limit`);
        }

        const text = await readFileFn(absolutePath, { encoding: 'utf8', signal: context.signal });
        const metadata = parseMetadata(text, identity.infoHash);
        return freezeObservation({
          ...base,
          observationState: 'present',
          zurgState: metadata.zurgState,
          zurgStateWhen: metadata.zurgStateWhen,
          failureCategory: null,
          retryable: null,
          evidence: metadata.evidence,
        });
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return freezeObservation({
            ...base,
            observationState: 'missing',
            zurgState: null,
            zurgStateWhen: null,
            failureCategory: null,
            retryable: null,
            evidence: null,
          });
        }

        const providerError = classifyFilesystemError(error, {
          provider: 'realdebrid', operation: 'observe-zurg-metadata',
        });
        return freezeObservation({
          ...base,
          observationState: 'error',
          zurgState: null,
          zurgStateWhen: null,
          failureCategory: providerError.category,
          retryable: providerError.retryable,
          evidence: null,
        });
      }
    },
  });
}

function parseMetadata(text, expectedHash) {
  if (typeof text !== 'string') {
    throw invalidMetadata('Zurg metadata reader must return UTF-8 text');
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalidMetadata('Cannot decode Zurg metadata JSON', error);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidMetadata('Zurg metadata must be a JSON object');
  }

  let observedHash;
  try {
    observedHash = createReleaseIdentity(value.Hash, null).infoHash;
  } catch (error) {
    throw invalidMetadata('Zurg metadata Hash must be 40 hexadecimal characters', error);
  }
  if (observedHash !== expectedHash) {
    throw invalidMetadata('Zurg metadata Hash does not match the requested torrent');
  }

  const selectedFiles = value.SelectedFiles;
  if (!selectedFiles || typeof selectedFiles !== 'object' || Array.isArray(selectedFiles)) {
    throw invalidMetadata('Zurg metadata SelectedFiles must be an object');
  }

  const files = Object.entries(selectedFiles).map(([zurgFileKey, file]) => ({
    zurgFileKey,
    file: normalizeFile(zurgFileKey, file),
  }));
  files.sort((left, right) => left.zurgFileKey.localeCompare(right.zurgFileKey));

  return {
    zurgState: optionalString(value.State, 'State', 128),
    zurgStateWhen: optionalNonNegativeInteger(value.StateWhen, 'StateWhen'),
    evidence: Object.freeze({
      version: optionalString(value.Version, 'Version', 128),
      name: optionalString(value.Name, 'Name', 2000),
      originalName: optionalString(value.OriginalName, 'OriginalName', 2000),
      rename: optionalString(value.Rename, 'Rename', 2000),
      unrepairableReason: optionalString(value.Unfixable, 'Unfixable', 4000),
      fileCount: files.length,
      files: Object.freeze(files.map((entry) => entry.file)),
    }),
  };
}

function normalizeFile(zurgFileKey, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidMetadata(`Zurg SelectedFiles entry ${zurgFileKey} must be an object`);
  }
  const providerFile = value.File;
  if (!providerFile || typeof providerFile !== 'object' || Array.isArray(providerFile)) {
    throw invalidMetadata(`Zurg SelectedFiles entry ${zurgFileKey} must contain File metadata`);
  }

  const bytes = optionalNonNegativeInteger(providerFile.bytes, 'File.bytes');
  const selectedValue = optionalNonNegativeInteger(providerFile.selected, 'File.selected');
  if (selectedValue != null && selectedValue !== 0 && selectedValue !== 1) {
    throw invalidMetadata('File.selected must be 0 or 1');
  }
  if (value.Link != null && typeof value.Link !== 'string') {
    throw invalidMetadata('Zurg saved link must be a string when present');
  }

  return Object.freeze({
    zurgFileId: normalizeOpaqueFileId(providerFile.id),
    recordedFilePath: optionalString(providerFile.path, 'File.path', 4000),
    size: bytes,
    selected: selectedValue == null ? null : selectedValue === 1,
    state: optionalString(value.State, 'file State', 128),
    rename: optionalString(value.Rename, 'file Rename', 2000),
    savedLinkPresent: typeof value.Link === 'string' && value.Link.length > 0,
  });
}

function freezeObservation(value) {
  return Object.freeze(value);
}

function invalidMetadata(message, cause) {
  return new ProviderOperationError(message, {
    provider: 'realdebrid',
    operation: 'observe-zurg-metadata',
    category: 'invalid-response',
    retryable: false,
    cause,
  });
}

function requireAbsolutePath(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  return path.resolve(value);
}

function normalizeMetadataPath(value) {
  const normalized = requireInputString(value, 'metadataPath', 4000).replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized)) throw new TypeError('metadataPath must be relative');
  const result = path.posix.normalize(normalized);
  if (result === '..' || result.startsWith('../')) {
    throw new TypeError('metadataPath cannot traverse parent directories');
  }
  if (!result.toLowerCase().endsWith('.zurgtorrent')) {
    throw new TypeError('metadataPath must identify a .zurgtorrent file');
  }
  return result.replace(/^\.\//, '');
}

function isContained(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function requireInputString(value, field, max) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function requireIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.trim())) {
    throw new TypeError(`${field} must be a non-empty provider-safe identifier`);
  }
  return value.trim().toLowerCase();
}

function requireString(value, field, max) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw invalidMetadata(`${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function optionalString(value, field, max) {
  if (value == null || value === '') return null;
  return requireString(value, field, max);
}

function optionalNonNegativeInteger(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidMetadata(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeOpaqueFileId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim().length > 0 && value.length <= 256) {
    return value.trim();
  }
  throw invalidMetadata('Zurg file id must be an opaque string or non-negative safe integer');
}

function validateNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
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
