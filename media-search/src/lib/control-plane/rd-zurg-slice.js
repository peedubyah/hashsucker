import { validateReleaseIdentity } from '../../api/release-contract.js';
import { PROVIDER_CAPABILITIES } from '../providers/capabilities.js';
import { chooseExactProviderFile } from './reconciler.js';

/**
 * Ingest independently observed Real-Debrid/Zurg facts into the control plane.
 *
 * This coordinator never infers one fact from another. Callers choose which
 * observations to collect, provide explicit account/instance paths, and decide
 * whether an exact provider-file mapping is justified by authoritative corpus
 * evidence. Observation methods are passive; exact mapping and binding methods
 * are explicit reconciliation operations. Provider repair execution is kept in
 * a separately authorized executor. No deletion, catalog, or playback operation
 * is performed here.
 */
export function createRdZurgControlPlaneSlice({
  store,
  realDebrid,
  zurgMetadata = null,
  exposure = null,
} = {}) {
  requireStore(store);
  requireRealDebrid(realDebrid);
  assertMatchingScope(realDebrid, exposure, 'exposure');

  async function observePlacement(release, context = {}) {
    const identity = validateReleaseIdentity(release);
    const capability = realDebrid.require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP);
    const observation = await capability.lookupPlacement(identity, context);
    const observedAt = observation?.observedAt ?? requireObservedAt(context);
    const expiresAt = observation?.expiresAt ?? requireExpiresAt(context, observedAt);
    if (observation == null) {
      store.recordPlacementLookupObservation({
        provider: 'realdebrid', accountScope: realDebrid.accountScope,
        infoHash: identity.infoHash, observationState: 'missing',
        observedAt, expiresAt, source: 'realdebrid-gateway:lookup-placement',
      });
      return null;
    }
    const placement = store.recordPlacement(observation);
    store.recordPlacementLookupObservation({
      provider: placement.provider, accountScope: placement.accountScope,
      infoHash: placement.infoHash, observationState: 'present', placementId: placement.id,
      observedAt, expiresAt, source: observation.provenance,
      failureCategory: observation.failureCategory, retryable: observation.retryable,
    });
    return placement;
  }

  async function observeReadiness(release, resource, context = {}) {
    const identity = validateReleaseIdentity(release);
    assertResourceIdentity(resource, identity);
    assertResourceScope(resource, realDebrid);
    const stored = requireStoredPlacement(resource);
    const capability = realDebrid.require(PROVIDER_CAPABILITIES.RESOURCE_READINESS);
    const observation = await capability.observeReadiness({
      ...identity,
      providerResourceId: resource.providerResourceId,
      ownership: stored.ownership,
      ownerKey: stored.ownerKey,
    }, context);
    assertPlacementObservationScope(observation, stored);
    store.recordReadinessObservation({
      placementId: stored.id,
      state: observation.state,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      source: observation.provenance,
      failureCategory: observation.failureCategory,
      retryable: observation.retryable,
    });
    return stored;
  }

  async function observeInventory(resource, context = {}) {
    assertResourceScope(resource, realDebrid);
    const placement = requireStoredPlacement(resource);
    const capability = realDebrid.require(PROVIDER_CAPABILITIES.FILE_INVENTORY);
    const observation = await capability.getFileInventory({
      providerResourceId: placement.providerResourceId,
    }, context);
    assertInventoryScope(observation, placement);
    if (observation.authoritative !== true || observation.complete !== true) {
      throw new Error('Control-plane inventory ingestion requires an authoritative complete snapshot');
    }
    store.replaceProviderFileInventory(placement.id, observation.files, {
      authoritative: observation.authoritative,
      complete: observation.complete,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      evidence: observation.evidence,
      enforceObservationOrder: true,
    });
    return store.getProviderInventorySnapshot(placement.id);
  }

  async function observeZurgMetadata(release, metadataPath, context = {}) {
    if (!zurgMetadata || typeof zurgMetadata.observeMetadata !== 'function') {
      throw new TypeError('Zurg metadata observer is not configured');
    }
    const identity = validateReleaseIdentity(release);
    const observation = await zurgMetadata.observeMetadata({
      infoHash: identity.infoHash,
      metadataPath,
    }, context);
    if (observation.provider !== realDebrid.provider
      || observation.accountScope !== realDebrid.accountScope
      || observation.infoHash !== identity.infoHash) {
      throw new Error('Zurg metadata scope does not match the canonical RD release');
    }
    return store.recordZurgMetadataObservation(observation);
  }

  async function observeExposure(release, resource, file, relativePath, context = {}) {
    if (!exposure) throw new TypeError('Zurg filesystem exposure observer is not configured');
    const identity = validateReleaseIdentity(release);
    assertResourceIdentity(resource, identity);
    assertResourceScope(resource, realDebrid);
    const placement = requireStoredPlacement(resource);
    const providerFile = requireStoredProviderFile(placement.id, file.providerFileId);
    const observation = await exposure.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure({
      providerResourceId: placement.providerResourceId,
      providerFileId: providerFile.providerFileId,
      relativePath,
    }, context);
    assertExposureScope(observation, placement);
    return store.recordExposure({ ...observation, placementId: placement.id });
  }

  function mapExactFile(release, resource, providerFileId, options = {}) {
    const identity = validateReleaseIdentity(release);
    assertResourceIdentity(resource, identity);
    assertResourceScope(resource, realDebrid);
    const placement = requireStoredPlacement(resource);
    const snapshot = store.getProviderInventorySnapshot(placement.id);
    if (!snapshot || snapshot.authoritative !== true || snapshot.complete !== true) {
      throw new Error('Exact file mapping requires an authoritative complete inventory snapshot');
    }
    const at = options.now ?? Date.now();
    if (!isFresh(snapshot, at)) {
      throw new Error('Exact file mapping requires a fresh bounded inventory snapshot');
    }
    const inventory = store.listProviderFiles(placement.id);
    const result = chooseExactProviderFile(identity, inventory);
    if (result.status !== 'mapped' || result.providerFile.providerFileId !== providerFileId) {
      throw new Error(`Provider file does not uniquely match canonical fileIndex: ${result.failureCategory ?? 'provider-file-mismatch'}`);
    }
    return store.recordFileMapping({
      ...identity,
      placementId: placement.id,
      providerFileId,
      state: 'mapped',
      method: 'provider-confirmed-corpus-index',
      authoritative: true,
      evidence: result.evidence,
      mappedAt: options.mappedAt,
    });
  }

  function activateBinding(input) {
    const identity = validateReleaseIdentity(input.release);
    assertResourceIdentity(input.resource, identity);
    assertResourceScope(input.resource, realDebrid);
    const placement = requireStoredPlacement(input.resource);
    requireStoredProviderFile(placement.id, input.providerFileId);
    return store.activateBinding({
      libraryItemId: input.libraryItemId,
      libraryPathId: input.libraryPathId,
      ...identity,
      placementId: placement.id,
      providerFileId: input.providerFileId,
      exposureId: input.exposureId,
      expectedBindingVersion: input.expectedBindingVersion,
      reason: requireString(input.reason, 'reason'),
    });
  }

  function getState(libraryItemId, release) {
    const identity = validateReleaseIdentity(release);
    return store.getReconciliationSnapshot(libraryItemId, identity);
  }

  function projectLifecycle(libraryItemId, release, scope = {}) {
    const identity = validateReleaseIdentity(release);
    return projectRdZurgLifecycle({
      snapshot: getState(libraryItemId, identity),
      lifecycle: store.getLifecycle(libraryItemId),
      scope: { ...scope, provider: 'realdebrid', accountScope: realDebrid.accountScope },
      now: scope.now ?? Date.now(),
    });
  }

  function requireStoredPlacement(resource) {
    const placement = store.findPlacement(
      'realdebrid', realDebrid.accountScope, resource.providerResourceId,
    );
    if (!placement) throw new Error('Real-Debrid placement has not been ingested');
    return placement;
  }

  function requireStoredProviderFile(placementId, providerFileId) {
    const file = store.listProviderFiles(placementId)
      .find((candidate) => candidate.providerFileId === providerFileId);
    if (!file) throw new Error('Provider file is not present in authoritative placement inventory');
    return file;
  }

  return Object.freeze({
    observePlacement,
    observeReadiness,
    observeInventory,
    observeZurgMetadata,
    observeExposure,
    mapExactFile,
    activateBinding,
    getState,
    projectLifecycle,
  });
}

export function projectRdZurgLifecycle({ snapshot, lifecycle, scope, now = Date.now() } = {}) {
  if (!snapshot || !lifecycle || !scope) {
    throw new TypeError('Stage 6 projection requires snapshot, lifecycle, and explicit scope');
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Stage 6 projection requires a valid now timestamp');
  const normalizedScope = normalizeScope(scope);
  if (!normalizedScope.accountScope || !normalizedScope.instanceScope || !normalizedScope.mountScope) {
    throw new TypeError('Stage 6 projection requires accountScope, instanceScope, and mountScope');
  }
  const identity = validateReleaseIdentity(snapshot.desired);
  const filtered = filterSnapshot(snapshot, normalizedScope);
  return Object.freeze({
    release: identity,
    scope: Object.freeze(normalizedScope),
    facts: Object.freeze({
      placement: projectPlacement(filtered.placementObservations, now),
      readiness: projectReadiness(filtered.readinessObservations, now),
      inventory: projectInventory(filtered.inventorySnapshots, now),
      zurgMetadata: projectZurgMetadata(filtered.zurgMetadata, now),
      exposure: projectExposure(filtered.exposures, now),
      exactFileMapping: projectExactMapping(filtered.mappings),
      binding: projectBinding(snapshot.currentBinding, identity, filtered),
      cataloging: projectItemMilestone(lifecycle, 'cataloged'),
      playback: projectItemMilestone(lifecycle, 'playable'),
    }),
  });
}

function filterSnapshot(snapshot, scope) {
  const normalized = normalizeScope(scope);
  const placements = snapshot.placements.filter((placement) =>
    placement.provider === normalized.provider
    && placement.accountScope === normalized.accountScope);
  const placementIds = new Set(placements.map((placement) => placement.id));
  return {
    placements,
    placementObservations: (snapshot.placementObservations ?? []).filter((fact) =>
      fact.provider === normalized.provider && fact.accountScope === normalized.accountScope),
    readinessObservations: (snapshot.readinessObservations ?? []).filter((fact) =>
      placementIds.has(fact.placementId)),
    inventorySnapshots: snapshot.inventorySnapshots.filter((fact) => placementIds.has(fact.placementId)),
    mappings: snapshot.mappings.filter((fact) => placementIds.has(fact.placementId)),
    exposures: snapshot.exposures.filter((fact) =>
      placementIds.has(fact.placementId)
      && fact.accountScope === normalized.accountScope
      && (normalized.mountScope == null || fact.mountScope === normalized.mountScope)),
    zurgMetadata: snapshot.zurgMetadata.filter((fact) =>
      fact.provider === normalized.provider
      && fact.accountScope === normalized.accountScope
      && (normalized.instanceScope == null || fact.instanceScope === normalized.instanceScope)),
  };
}

function projectPlacement(observations, now) {
  if (observations.length === 0) return fact('unknown', null);
  const current = newest(observations);
  return fact(effectiveState(current.observationState, current, now), current, {
    observedState: current.observationState,
    freshness: freshness(current, now),
    observedAt: current.observedAt,
    expiresAt: current.expiresAt,
    failureCategory: current.failureCategory,
    retryable: current.retryable,
  });
}

function projectReadiness(observations, now) {
  if (observations.length === 0) return fact('unknown', null);
  const current = newest(observations);
  return fact(effectiveState(current.state, current, now), current, {
    observedState: current.state,
    freshness: freshness(current, now),
    observedAt: current.observedAt,
    expiresAt: current.expiresAt,
    failureCategory: current.failureCategory,
    retryable: current.retryable,
  });
}

function projectInventory(snapshots, now) {
  if (snapshots.length === 0) return fact('unknown', null);
  const current = newest(snapshots);
  const observedState = current.authoritative && current.complete ? 'present' : 'unknown';
  return fact(effectiveState(observedState, current, now), current, {
    observedState,
    freshness: freshness(current, now),
    authoritative: current.authoritative,
    complete: current.complete,
    fileCount: current.fileCount,
    observedAt: current.observedAt,
    expiresAt: current.expiresAt,
  });
}

function projectZurgMetadata(observations, now) {
  if (observations.length === 0) return fact('unobserved', null);
  const current = newest(observations);
  return fact(effectiveState(current.observationState, current, now), current, {
    observedState: current.observationState,
    freshness: freshness(current, now),
    instanceScope: current.instanceScope,
    metadataPath: current.metadataPath,
    zurgState: current.zurgState,
    zurgStateWhen: current.zurgStateWhen,
    observedAt: current.observedAt,
    expiresAt: current.expiresAt,
    failureCategory: current.failureCategory,
    retryable: current.retryable,
  });
}

function projectExposure(exposures, now) {
  if (exposures.length === 0) return fact('unobserved', null);
  const current = newest(exposures);
  return fact(effectiveState(current.state, current, now), current, {
    observedState: current.state,
    freshness: freshness(current, now),
    accountScope: current.accountScope,
    mountScope: current.mountScope,
    transport: current.transport,
    readOnly: current.readOnly,
    observedAt: current.observedAt,
    expiresAt: current.expiresAt,
    failureCategory: current.failureCategory,
    retryable: current.retryable,
  });
}

function projectExactMapping(mappings) {
  if (mappings.length === 0) return fact('unmapped', null);
  const current = newest(mappings, 'mappedAt');
  return fact(current.state, current, {
    authoritative: current.authoritative,
    mappedAt: current.mappedAt,
    failureCategory: current.failureCategory,
  });
}

function projectBinding(binding, identity, filtered) {
  if (!binding || binding.releaseKey !== identity.releaseKey) return fact('unbound', null);
  const placement = filtered.placements.find((candidate) => candidate.id === binding.placementId);
  const exposure = filtered.exposures.find((candidate) => candidate.id === binding.exposureId);
  if (!placement || !exposure || exposure.providerFileId !== binding.providerFileId) {
    return fact('unbound', null);
  }
  const newerTarget = filtered.exposures.find((candidate) =>
    candidate.id !== exposure.id
      && candidate.transport === exposure.transport
      && candidate.exposureKey === exposure.exposureKey
      && candidate.observedAt > exposure.observedAt);
  if (newerTarget) {
    return fact('degraded', binding, {
      version: binding.version,
      validFrom: binding.validFrom,
      reconciledAt: binding.reconciledAt,
      failureCategory: 'exposure-target-changed',
    });
  }
  const currentPlacement = newest(filtered.placementObservations);
  if (currentPlacement?.observationState === 'present'
    && currentPlacement.placementId !== binding.placementId) {
    return fact('degraded', binding, {
      version: binding.version,
      validFrom: binding.validFrom,
      reconciledAt: binding.reconciledAt,
      failureCategory: 'provider-placement-target-changed',
    });
  }
  return fact(binding.status, binding, {
    version: binding.version,
    validFrom: binding.validFrom,
    reconciledAt: binding.reconciledAt,
    failureCategory: binding.failureCategory,
  });
}

function projectItemMilestone(lifecycle, milestone) {
  const event = lifecycle.milestones[milestone];
  if (!event) return Object.freeze({ state: 'unknown', scope: 'library-item' });
  return Object.freeze({
    state: event.status,
    scope: 'library-item',
    occurredAt: event.occurredAt,
    failureCategory: event.failureCategory,
    retryable: event.retryable,
    reason: event.reason,
  });
}

function fact(state, source, details = {}) {
  return Object.freeze({ state, ...details, sourceId: source?.id ?? null });
}

function freshness(observation, now) {
  if (!Number.isSafeInteger(observation.expiresAt)) return 'unbounded';
  return observation.expiresAt > now ? 'fresh' : 'stale';
}

function effectiveState(state, observation, now) {
  return freshness(observation, now) === 'fresh' ? state : 'unknown';
}

function isFresh(observation, now) {
  return freshness(observation, now) === 'fresh';
}

function newest(items, field = 'observedAt') {
  return [...items].sort((left, right) =>
    (right[field] ?? 0) - (left[field] ?? 0)
    || String(right.id ?? '').localeCompare(String(left.id ?? '')))[0];
}

function normalizeScope(scope) {
  return {
    provider: normalizeIdentifier(scope.provider ?? 'realdebrid', 'provider'),
    accountScope: normalizeIdentifier(scope.accountScope ?? 'default', 'accountScope'),
    instanceScope: scope.instanceScope == null
      ? null
      : normalizeIdentifier(scope.instanceScope, 'instanceScope'),
    mountScope: scope.mountScope == null
      ? null
      : normalizeIdentifier(scope.mountScope, 'mountScope'),
  };
}

function assertResourceIdentity(resource, identity) {
  if (resource.infoHash != null && resource.infoHash.toLowerCase() !== identity.infoHash) {
    throw new Error('Real-Debrid resource hash does not match canonical release hash');
  }
}

function assertResourceScope(resource, adapter) {
  if (resource.provider != null && resource.provider !== adapter.provider) {
    throw new Error('Provider resource belongs to a different provider');
  }
  if (resource.accountScope != null && resource.accountScope !== adapter.accountScope) {
    throw new Error('Provider resource belongs to a different account scope');
  }
  requireString(resource.providerResourceId, 'providerResourceId');
}

function assertPlacementObservationScope(observation, placement) {
  if (observation.provider !== placement.provider
    || observation.accountScope !== placement.accountScope
    || observation.infoHash !== placement.infoHash
    || observation.providerResourceId !== placement.providerResourceId) {
    throw new Error('Readiness observation scope does not match its placement');
  }
}

function assertInventoryScope(inventory, placement) {
  if (inventory.provider !== placement.provider
    || inventory.accountScope !== placement.accountScope
    || inventory.providerResourceId !== placement.providerResourceId) {
    throw new Error('Provider inventory scope does not match its placement');
  }
}

function assertExposureScope(observation, placement) {
  if (observation.provider !== placement.provider
    || observation.accountScope !== placement.accountScope
    || observation.providerResourceId !== placement.providerResourceId) {
    throw new Error('Exposure scope does not match its provider placement');
  }
}

function assertMatchingScope(provider, observer, name) {
  if (!observer) return;
  if (observer.provider !== provider.provider || observer.accountScope !== provider.accountScope) {
    throw new TypeError(`${name} observer must use the same provider and account scope`);
  }
}

function requireObservedAt(context) {
  if (!Number.isSafeInteger(context.observedAt) || context.observedAt < 0) {
    throw new TypeError('Missing placement observation requires context.observedAt');
  }
  return context.observedAt;
}

function requireExpiresAt(context, observedAt) {
  if (!Number.isSafeInteger(context.expiresAt) || context.expiresAt <= observedAt) {
    throw new TypeError('Missing placement observation requires a future context.expiresAt');
  }
  return context.expiresAt;
}

function requireStore(store) {
  for (const method of [
    'recordPlacement', 'findPlacement', 'recordPlacementLookupObservation',
    'recordReadinessObservation', 'replaceProviderFileInventory',
    'recordZurgMetadataObservation', 'recordExposure', 'recordFileMapping',
    'getReconciliationSnapshot', 'getLifecycle',
  ]) {
    if (!store || typeof store[method] !== 'function') {
      throw new TypeError(`Control-plane store requires ${method}()`);
    }
  }
}

function requireRealDebrid(adapter) {
  if (!adapter || adapter.provider !== 'realdebrid') {
    throw new TypeError('A Real-Debrid provider adapter is required');
  }
}

function normalizeIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.trim())) {
    throw new TypeError(`${field} must be a non-empty provider-safe identifier`);
  }
  return value.trim().toLowerCase();
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1000) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}
