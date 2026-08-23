import { createHash } from 'node:crypto';

import { evaluateObservationFreshness } from '../lib/providers/observations.js';

export function toControlPlaneItemSummary({ item, canonicalPath, bindings, lifecycle }) {
  return {
    item: publicItem(item),
    canonicalPath: canonicalPath ? {
      id: canonicalPath.id,
      path: canonicalPath.canonicalPath,
      active: canonicalPath.active,
    } : null,
    activeBinding: publicBinding(bindings.find((binding) => binding.status === 'active') ?? null),
    lifecycle: publicLifecycle(lifecycle),
  };
}

export function toControlPlaneItemDetail({
  generatedAt,
  item,
  canonicalPath,
  bindings,
  lifecycle,
  release = null,
  providerObservations = [],
  snapshot = null,
  stage6 = null,
  shadowPlan = null,
}) {
  return {
    generatedAt,
    ...toControlPlaneItemSummary({ item, canonicalPath, bindings, lifecycle }),
    bindingHistory: bindings.map(publicBinding),
    release,
    providerObservations: providerObservations.map((observation) => publicObservation(observation, generatedAt)),
    resources: snapshot ? publicResources(snapshot) : null,
    stage6: stage6 ? publicStage6(stage6) : null,
    shadowPlan: shadowPlan ? publicShadowPlan(shadowPlan) : null,
  };
}

function publicItem(item) {
  return {
    id: item.id,
    mediaType: item.mediaType,
    mediaId: item.mediaId,
    editionKey: item.editionKey,
    title: item.title,
    year: item.year,
    season: item.season,
    episode: item.episode,
    desiredState: item.desiredState,
  };
}
function publicBinding(binding) {
  if (!binding) return null;
  return {
    id: binding.id,
    releaseKey: binding.releaseKey,
    providerFileRef: opaqueRef(binding.placementId, binding.providerFileId),
    version: binding.version,
    status: binding.status,
    reason: binding.reason,
    validFrom: binding.validFrom,
    supersededAt: binding.supersededAt,
    reconciledAt: binding.reconciledAt,
    failureCategory: binding.failureCategory,
  };
}
function publicLifecycle(lifecycle) {
  return Object.fromEntries(Object.entries(lifecycle.milestones).map(([milestone, event]) => [
    milestone,
    event ? {
      status: event.status,
      occurredAt: event.occurredAt,
      failureCategory: event.failureCategory,
      retryable: event.retryable,
      retryAfterMs: event.retryAfterMs,
      source: event.source,
      reason: event.reason,
    } : null,
  ]));
}
function publicObservation(observation, now) {
  const freshness = observation.freshness
    ? observation
    : { ...observation, ...evaluateObservationFreshness(observation, { now }) };
  return {
    provider: observation.provider,
    accountScope: observation.accountScope,
    scope: observation.scope,
    kind: observation.kind,
    state: observation.state,
    observedAt: observation.observedAt,
    expiresAt: observation.expiresAt,
    freshness: freshness.freshness,
    fresh: freshness.fresh,
    ageMs: freshness.ageMs,
    expiresInMs: freshness.expiresInMs,
    source: observation.source,
    errorCategory: observation.errorCategory,
    retryable: observation.retryable,
    retryAfterMs: observation.retryAfterMs,
  };
}
function publicResources(snapshot) {
  return {
    placements: snapshot.placements.map((placement) => ({
      provider: placement.provider,
      accountScope: placement.accountScope,
      state: placement.state,
      ownership: placement.ownership,
      observedAt: placement.observedAt,
      expiresAt: placement.expiresAt,
      failureCategory: placement.failureCategory,
      retryable: placement.retryable,
      dependentBindingCount: placement.dependentBindingCount,
    })),
    placementObservations: (snapshot.placementObservations ?? []).map((observation) => ({
      provider: observation.provider,
      accountScope: observation.accountScope,
      observationState: observation.observationState,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      failureCategory: observation.failureCategory,
      retryable: observation.retryable,
    })),
    readiness: (snapshot.readinessObservations ?? []).map((observation) => ({
      placementRef: opaqueRef(observation.placementId, 'readiness'),
      state: observation.state,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      failureCategory: observation.failureCategory,
      retryable: observation.retryable,
    })),
    inventories: (snapshot.inventorySnapshots ?? []).map((inventory) => ({
      placementRef: opaqueRef(inventory.placementId, 'inventory'),
      authoritative: inventory.authoritative,
      complete: inventory.complete,
      fileCount: inventory.fileCount,
      observedAt: inventory.observedAt,
      expiresAt: inventory.expiresAt,
    })),
    files: snapshot.providerFiles.map((file) => ({
      providerFileRef: opaqueRef(file.placementId, file.providerFileId),
      corpusFileIndex: file.corpusFileIndex,
      size: file.size,
      selected: file.selected,
      present: file.present,
      inventoryObservedAt: file.inventoryObservedAt,
      inventoryExpiresAt: file.inventoryExpiresAt,
    })),
    mappings: snapshot.mappings.map((mapping) => ({
      releaseKey: mapping.releaseKey,
      providerFileRef: opaqueRef(mapping.placementId, mapping.providerFileId),
      state: mapping.state,
      method: mapping.method,
      authoritative: mapping.authoritative,
      mappedAt: mapping.mappedAt,
      failureCategory: mapping.failureCategory,
    })),
    exposures: snapshot.exposures.map((exposure) => ({
      providerFileRef: opaqueRef(exposure.placementId, exposure.providerFileId),
      accountScope: exposure.accountScope,
      mountScope: exposure.mountScope,
      transport: exposure.transport,
      state: exposure.state,
      readOnly: exposure.readOnly,
      observedAt: exposure.observedAt,
      expiresAt: exposure.expiresAt,
      failureCategory: exposure.failureCategory,
      retryable: exposure.retryable,
    })),
    zurgMetadata: (snapshot.zurgMetadata ?? []).map((observation) => ({
      provider: observation.provider,
      accountScope: observation.accountScope,
      instanceScope: observation.instanceScope,
      observationState: observation.observationState,
      zurgState: observation.zurgState,
      zurgStateWhen: observation.zurgStateWhen,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      failureCategory: observation.failureCategory,
      retryable: observation.retryable,
    })),
  };
}
function publicStage6(stage6) {
  const allowedFactFields = [
    'state', 'observedState', 'freshness', 'providerState', 'authoritative', 'complete',
    'fileCount', 'instanceScope', 'zurgState', 'zurgStateWhen', 'accountScope',
    'mountScope', 'transport', 'readOnly', 'observedAt', 'expiresAt', 'mappedAt',
    'version', 'validFrom', 'reconciledAt', 'occurredAt', 'failureCategory',
    'retryable', 'reason', 'scope',
  ];
  return {
    release: stage6.release,
    scope: stage6.scope,
    facts: Object.fromEntries(Object.entries(stage6.facts).map(([name, fact]) => [
      name,
      Object.fromEntries(allowedFactFields
        .filter((field) => Object.hasOwn(fact, field))
        .map((field) => [field, fact[field]])),
    ])),
  };
}
function publicShadowPlan(plan) {
  return {
    mode: plan.mode,
    executed: false,
    actions: plan.actions.map((action) => ({
      action: action.action,
      reason: action.reason,
      target: action.target ?? null,
      providerPreferences: action.providerPreferences ?? null,
      attempt: action.attempt ?? null,
      notBefore: action.notBefore ?? null,
      retryable: action.retryable ?? null,
      safety: action.safety ?? null,
    })),
    failures: plan.failures.map((failure) => ({
      category: failure.category,
      retryable: failure.retryable,
    })),
    destructiveActionCount: plan.destructiveActionCount,
  };
}
function opaqueRef(placementId, providerFileId) {
  return `resource-sha256:${createHash('sha256')
    .update(JSON.stringify([placementId, providerFileId]))
    .digest('hex')}`;
}
