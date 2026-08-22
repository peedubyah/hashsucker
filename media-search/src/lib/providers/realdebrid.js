import { createReleaseIdentity } from '../../api/release-contract.js';
import { PROVIDER_CAPABILITIES, createProviderAdapter } from './capabilities.js';
import { classifyProviderError, ProviderOperationError } from './errors.js';
import { createPlacementObservation, createProviderFileInventory } from './resources.js';

const DEFAULT_OBSERVATION_TTL_MS = 60_000;

/**
 * Real-Debrid control-plane adapter over an injected gateway.
 *
 * The gateway is the intentionally narrow boundary for a fixture-verified direct
 * API implementation. This module encodes no endpoint, authorization, pagination,
 * status-vocabulary, or file-selection assumptions. Each independently supplied
 * gateway operation enables only its matching provider capability.
 */
export function createRealDebridProvider(options = {}) {
  const {
    accountScope = 'default',
    gateway = {},
    now = () => Date.now(),
    observationTtlMs = DEFAULT_OBSERVATION_TTL_MS,
  } = options;
  validateTtl(observationTtlMs);

  const capabilities = {};
  if (typeof gateway.lookupPlacement === 'function') {
    capabilities[PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP] = {
      async lookupPlacement(subject, context = {}) {
        const identity = normalizeTorrentSubject(subject);
        const result = await callGateway('lookup-placement', () => gateway.lookupPlacement({
          ...identity, accountScope, signal: context.signal,
        }));
        if (result == null) return null;
        return placementFromGateway(result, identity, {
          accountScope, now, observationTtlMs, defaultOwnership: 'external',
          provenance: 'realdebrid-gateway:lookup-placement',
        });
      },
    };
  }

  if (typeof gateway.createPlacement === 'function') {
    capabilities[PROVIDER_CAPABILITIES.PLACEMENT_CREATE] = {
      async createPlacement(request, context = {}) {
        const identity = normalizeTorrentSubject(request);
        const ownerKey = requireString(request.ownerKey, 'ownerKey');
        const idempotencyKey = requireString(request.idempotencyKey, 'idempotencyKey');
        const result = await callGateway('create-placement', () => gateway.createPlacement({
          ...identity,
          magnetUri: `magnet:?xt=urn:btih:${identity.infoHash}`,
          accountScope,
          ownerKey,
          idempotencyKey,
          signal: context.signal,
        }));
        if (!result || typeof result.created !== 'boolean') {
          throw invalidResponse('Real-Debrid create gateway must report created as a boolean', 'create-placement');
        }
        return placementFromGateway(result, identity, {
          accountScope,
          now,
          observationTtlMs,
          defaultOwnership: result.created ? 'owned' : 'reused',
          ownerKey: result.created ? ownerKey : null,
          idempotencyKey,
          provenance: 'realdebrid-gateway:create-placement',
        });
      },
    };
  }

  if (typeof gateway.observeReadiness === 'function') {
    capabilities[PROVIDER_CAPABILITIES.RESOURCE_READINESS] = {
      async observeReadiness(resource, context = {}) {
        const identity = normalizeTorrentSubject(resource);
        const providerResourceId = requireString(resource.providerResourceId, 'providerResourceId');
        const result = await callGateway('observe-readiness', () => gateway.observeReadiness({
          ...identity, providerResourceId, accountScope, signal: context.signal,
        }));
        return placementFromGateway({ ...result, providerResourceId }, identity, {
          accountScope, now, observationTtlMs,
          defaultOwnership: resource.ownership ?? 'unknown',
          ownerKey: resource.ownerKey ?? null,
          provenance: 'realdebrid-gateway:observe-readiness',
        });
      },
    };
  }

  if (typeof gateway.getFileInventory === 'function') {
    capabilities[PROVIDER_CAPABILITIES.FILE_INVENTORY] = {
      async getFileInventory(resource, context = {}) {
        const providerResourceId = requireString(resource.providerResourceId, 'providerResourceId');
        const result = await callGateway('file-inventory', () => gateway.getFileInventory({
          providerResourceId, accountScope, signal: context.signal,
        }));
        if (!result || !Array.isArray(result.files)) {
          throw invalidResponse('Real-Debrid inventory gateway must return files', 'file-inventory');
        }
        return createProviderFileInventory({
          provider: 'realdebrid',
          accountScope,
          providerResourceId,
          authoritative: result.authoritative === true,
          complete: result.complete === true,
          observedAt: result.observedAt ?? now(),
          expiresAt: result.expiresAt,
          ttlMs: result.expiresAt == null ? (result.ttlMs ?? observationTtlMs) : undefined,
          files: result.files,
          evidence: result.evidence ?? null,
        });
      },
    };
  }

  return createProviderAdapter({ provider: 'realdebrid', accountScope, capabilities });
}

function placementFromGateway(result, identity, options) {
  if (!result || typeof result !== 'object') {
    throw invalidResponse('Real-Debrid gateway returned no placement resource', 'placement');
  }
  const observedAt = result.observedAt ?? options.now();
  return createPlacementObservation({
    provider: 'realdebrid',
    accountScope: options.accountScope,
    infoHash: identity.infoHash,
    providerResourceId: result.providerResourceId,
    state: result.state ?? 'unknown',
    ownership: result.ownership ?? options.defaultOwnership,
    ownerKey: result.ownerKey ?? options.ownerKey ?? null,
    provenance: result.provenance ?? options.provenance,
    idempotencyKey: result.idempotencyKey ?? options.idempotencyKey ?? null,
    observedAt,
    expiresAt: result.expiresAt,
    ttlMs: result.expiresAt == null ? (result.ttlMs ?? options.observationTtlMs) : undefined,
    failureCategory: result.failureCategory ?? null,
    retryable: result.retryable ?? null,
    evidence: result.evidence ?? null,
  });
}

async function callGateway(operation, callback) {
  try {
    return await callback();
  } catch (error) {
    throw classifyProviderError(error, { provider: 'realdebrid', operation });
  }
}

function normalizeTorrentSubject(subject) {
  if (!subject || typeof subject !== 'object') throw new TypeError('Real-Debrid subject must be an object');
  return createReleaseIdentity(subject.infoHash, null);
}

function invalidResponse(message, operation) {
  return new ProviderOperationError(message, {
    provider: 'realdebrid', operation, category: 'invalid-response', retryable: false,
  });
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1000) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateTtl(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('observationTtlMs must be a non-negative safe integer');
  }
}
