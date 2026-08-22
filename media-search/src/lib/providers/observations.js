import { createReleaseIdentity } from '../../api/release-contract.js';
import { isProviderErrorCategory } from './errors.js';

export const OBSERVATION_SCOPES = Object.freeze([
  'candidate',
  'torrent',
  'provider-resource',
  'provider-file',
  'exposure',
  'mount',
]);

export const OBSERVATION_KINDS = Object.freeze([
  'authoritative',
  'inferred',
  'predicted',
]);

export const CACHE_OBSERVATION_STATES = Object.freeze([
  'cached',
  'uncached',
  'unknown',
  'error',
]);

const SCOPE_SET = new Set(OBSERVATION_SCOPES);
const KIND_SET = new Set(OBSERVATION_KINDS);
const STATE_SET = new Set(CACHE_OBSERVATION_STATES);

export function createCacheObservation(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Provider observation must be an object');
  }

  const provider = normalizeIdentifier(input.provider, 'provider');
  const accountScope = normalizeIdentifier(input.accountScope ?? 'default', 'accountScope');
  const scope = input.scope ?? 'candidate';
  const kind = input.kind ?? 'authoritative';
  const state = normalizeCacheState(input);
  const observedAt = normalizeTimestamp(input.observedAt ?? input.checkedAt ?? now, 'observedAt');
  const expiresAt = normalizeExpiry(input.expiresAt, input.ttlMs, observedAt);
  const errorCategory = input.errorCategory ?? null;

  if (!SCOPE_SET.has(scope)) throw new TypeError(`Unsupported observation scope: ${scope}`);
  if (!KIND_SET.has(kind)) throw new TypeError(`Unsupported observation kind: ${kind}`);
  if (!STATE_SET.has(state)) throw new TypeError(`Unsupported cache observation state: ${state}`);
  if (errorCategory != null && !isProviderErrorCategory(errorCategory)) {
    throw new TypeError(`Unsupported provider error category: ${errorCategory}`);
  }
  if (state === 'error' && errorCategory == null) {
    throw new TypeError('Error observations require errorCategory');
  }
  if (kind === 'predicted' && state === 'error') {
    throw new TypeError('Predicted observations cannot represent provider errors');
  }

  const subject = normalizeSubject(input.subject, input.infoHash, input.fileIndex, scope);

  return Object.freeze({
    provider,
    accountScope,
    scope,
    subjectType: subject.type,
    subjectKey: subject.key,
    infoHash: subject.infoHash,
    fileIndex: subject.fileIndex,
    kind,
    state,
    observedAt,
    expiresAt,
    source: normalizeSource(input.source, kind),
    evidence: input.evidence ?? null,
    errorCategory,
    retryable: input.retryable == null ? null : Boolean(input.retryable),
    retryAfterMs: normalizeOptionalInteger(input.retryAfterMs, 'retryAfterMs'),
    latencyMs: normalizeOptionalInteger(input.latencyMs, 'latencyMs'),
    correlationId: normalizeOptionalString(input.correlationId, 'correlationId'),
  });
}

export function evaluateObservationFreshness(observation, { now = Date.now() } = {}) {
  if (!observation || typeof observation !== 'object') {
    throw new TypeError('observation is required');
  }

  const observedAt = normalizeTimestamp(observation.observedAt, 'observedAt');
  const expiresAt = observation.expiresAt == null
    ? null
    : normalizeTimestamp(observation.expiresAt, 'expiresAt');
  const ageMs = Math.max(0, now - observedAt);

  if (expiresAt == null) {
    return Object.freeze({ freshness: 'unbounded', fresh: null, ageMs, expiresInMs: null });
  }

  const expiresInMs = expiresAt - now;
  return Object.freeze({
    freshness: expiresInMs > 0 ? 'fresh' : 'stale',
    fresh: expiresInMs > 0,
    ageMs,
    expiresInMs,
  });
}

export function toLegacyCachedState(state) {
  if (state === 'cached') return true;
  if (state === 'uncached') return false;
  return null;
}

export function legacyObservationInput(infoHash, fileIndex, provider, observation = {}) {
  const checkedAt = observation.checkedAt ?? observation.observedAt ?? Date.now();
  const state = observation.state ?? (
    observation.cached === true ? 'cached' : observation.cached === false ? 'uncached' :
      observation.errorCategory ? 'error' : 'unknown'
  );

  return {
    ...observation,
    provider,
    infoHash,
    fileIndex,
    scope: observation.scope ?? (fileIndex == null ? 'torrent' : 'candidate'),
    kind: observation.kind ?? 'authoritative',
    state,
    observedAt: checkedAt,
    source: observation.source ?? 'legacy-cache-api',
  };
}

function normalizeSubject(subject, infoHash, fileIndex, scope) {
  if (subject != null) {
    if (typeof subject !== 'object' || Array.isArray(subject)) {
      throw new TypeError('subject must be an object');
    }
    const type = normalizeIdentifier(subject.type, 'subject.type');
    const key = normalizeSubjectKey(subject.key);
    return { type, key, infoHash: subject.infoHash ?? null, fileIndex: subject.fileIndex ?? null };
  }

  if (infoHash != null) {
    const identity = createReleaseIdentity(infoHash, fileIndex ?? null);
    return {
      type: scope === 'torrent' ? 'torrent' : 'candidate',
      key: scope === 'torrent' ? identity.infoHash : identity.releaseKey,
      infoHash: identity.infoHash,
      fileIndex: identity.fileIndex,
    };
  }

  throw new TypeError('Provider observation requires a subject or exact release identity');
}

function normalizeCacheState(input) {
  if (input.state != null) return input.state;
  if (input.cached === true) return 'cached';
  if (input.cached === false) return 'uncached';
  return input.errorCategory ? 'error' : 'unknown';
}

function normalizeExpiry(expiresAt, ttlMs, observedAt) {
  if (expiresAt != null && ttlMs != null) {
    throw new TypeError('Specify either expiresAt or ttlMs, not both');
  }
  if (ttlMs != null) {
    const ttl = normalizeOptionalInteger(ttlMs, 'ttlMs');
    return observedAt + ttl;
  }
  return expiresAt == null ? null : normalizeTimestamp(expiresAt, 'expiresAt');
}

function normalizeTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative millisecond timestamp`);
  }
  return value;
}

function normalizeOptionalInteger(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer or null`);
  }
  return value;
}

function normalizeIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.trim())) {
    throw new TypeError(`${field} must be a non-empty safe identifier`);
  }
  return value.trim().toLowerCase();
}

function normalizeSubjectKey(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw new TypeError('subject.key must be a non-empty string up to 512 characters');
  }
  return value.trim();
}

function normalizeSource(value, kind) {
  return normalizeOptionalString(value ?? kind, 'source');
}

function normalizeOptionalString(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be a non-empty string up to 256 characters or null`);
  }
  return value.trim();
}
