import { createReleaseIdentity } from '../../api/release-contract.js';

export const PLACEMENT_STATES = Object.freeze([
  'pending', 'ready', 'degraded', 'error', 'removed', 'unknown',
]);
export const PLACEMENT_OWNERSHIP = Object.freeze([
  'owned', 'reused', 'external', 'unknown',
]);
export const EXPOSURE_STATES = Object.freeze([
  'pending', 'visible', 'missing', 'degraded', 'error', 'unknown',
]);

const placementStates = new Set(PLACEMENT_STATES);
const placementOwnership = new Set(PLACEMENT_OWNERSHIP);
const exposureStates = new Set(EXPOSURE_STATES);

/** Normalize a provider-authoritative placement/readiness observation. */
export function createPlacementObservation(input) {
  const identity = createReleaseIdentity(input.infoHash, null);
  const observedAt = requireTimestamp(input.observedAt, 'observedAt');
  const expiresAt = normalizeExpiry(input.expiresAt, input.ttlMs, observedAt);
  const state = requireEnum(input.state ?? 'unknown', placementStates, 'placement state');
  const ownership = requireEnum(input.ownership ?? 'unknown', placementOwnership, 'placement ownership');
  if (ownership === 'owned' && !input.ownerKey) {
    throw new TypeError('Owned placement observation requires ownerKey');
  }
  return Object.freeze({
    provider: normalizeIdentifier(input.provider, 'provider'),
    accountScope: normalizeIdentifier(input.accountScope ?? 'default', 'accountScope'),
    ...identity,
    providerResourceId: requireString(input.providerResourceId, 'providerResourceId'),
    state,
    ownership,
    ownerKey: input.ownerKey ?? null,
    provenance: requireString(input.provenance, 'provenance'),
    idempotencyKey: input.idempotencyKey ?? null,
    observedAt,
    expiresAt,
    failureCategory: input.failureCategory ?? null,
    retryable: input.retryable ?? null,
    evidence: input.evidence ?? null,
  });
}

/** Normalize one provider-authoritative file inventory snapshot. */
export function createProviderFileInventory(input) {
  const observedAt = requireTimestamp(input.observedAt, 'observedAt');
  const expiresAt = normalizeExpiry(input.expiresAt, input.ttlMs, observedAt);
  if (!Array.isArray(input.files)) throw new TypeError('files must be an array');
  const seen = new Set();
  const files = input.files.map((file) => {
    const providerFileId = requireString(file.providerFileId, 'providerFileId');
    if (seen.has(providerFileId)) throw new TypeError(`Duplicate providerFileId: ${providerFileId}`);
    seen.add(providerFileId);
    const corpusFileIndex = normalizeOptionalFileIndex(file.corpusFileIndex);
    return Object.freeze({
      providerFileId,
      path: requireString(file.path, 'path', 2000),
      name: requireString(file.name, 'name', 1000),
      size: normalizeOptionalSize(file.size),
      selected: file.selected == null ? null : file.selected === true,
      mediaHint: file.mediaHint ?? null,
      corpusFileIndex,
      evidence: file.evidence ?? null,
      inventoryObservedAt: observedAt,
      inventoryExpiresAt: expiresAt,
    });
  });
  return Object.freeze({
    provider: normalizeIdentifier(input.provider, 'provider'),
    accountScope: normalizeIdentifier(input.accountScope ?? 'default', 'accountScope'),
    providerResourceId: requireString(input.providerResourceId, 'providerResourceId'),
    authoritative: input.authoritative === true,
    complete: input.complete === true,
    observedAt,
    expiresAt,
    files: Object.freeze(files),
    evidence: input.evidence ?? null,
  });
}

/** Normalize a transport/mount observation without claiming provider authority. */
export function createExposureObservation(input) {
  const observedAt = requireTimestamp(input.observedAt, 'observedAt');
  const expiresAt = normalizeExpiry(input.expiresAt, input.ttlMs, observedAt);
  return Object.freeze({
    provider: normalizeIdentifier(input.provider, 'provider'),
    accountScope: normalizeIdentifier(input.accountScope ?? 'default', 'accountScope'),
    mountScope: normalizeIdentifier(input.mountScope ?? 'default', 'mountScope'),
    providerResourceId: requireString(input.providerResourceId, 'providerResourceId'),
    providerFileId: requireString(input.providerFileId, 'providerFileId'),
    transport: normalizeIdentifier(input.transport, 'transport'),
    exposureKey: requireString(input.exposureKey, 'exposureKey', 1000),
    relativePath: input.relativePath == null ? null : requireString(input.relativePath, 'relativePath', 2000),
    state: requireEnum(input.state ?? 'unknown', exposureStates, 'exposure state'),
    readOnly: input.readOnly === true,
    observedAt,
    expiresAt,
    failureCategory: input.failureCategory ?? null,
    retryable: input.retryable ?? null,
    evidence: input.evidence ?? null,
  });
}

function normalizeIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.trim())) {
    throw new TypeError(`${field} must be a non-empty provider-safe identifier`);
  }
  return value.trim().toLowerCase();
}
function requireString(value, field, max = 256) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}
function requireTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return value;
}
function normalizeExpiry(expiresAt, ttlMs, observedAt) {
  if (expiresAt != null && ttlMs != null) throw new TypeError('Specify expiresAt or ttlMs, not both');
  if (ttlMs != null) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new TypeError('ttlMs must be a non-negative safe integer');
    return observedAt + ttlMs;
  }
  if (expiresAt == null) return null;
  const normalized = requireTimestamp(expiresAt, 'expiresAt');
  if (normalized < observedAt) throw new TypeError('expiresAt cannot precede observedAt');
  return normalized;
}
function requireEnum(value, allowed, field) {
  if (!allowed.has(value)) throw new TypeError(`Invalid ${field}: ${value}`);
  return value;
}
function normalizeOptionalFileIndex(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('corpusFileIndex must be null or a non-negative safe integer');
  }
  return value;
}
function normalizeOptionalSize(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('size must be a non-negative safe integer');
  return value;
}
