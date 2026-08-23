import { validateReleaseIdentity } from '../../api/release-contract.js';

export const RECONCILIATION_ACTIONS = Object.freeze([
  'no-op',
  'observe-again',
  'create-or-reuse-placement',
  'wait-provider-readiness',
  'map-exact-file',
  'observe-exposure',
  'bind',
  'rebind',
  'mark-degraded',
  'remove-stale-owned-resource',
]);

const ACTION_ORDER = new Map(RECONCILIATION_ACTIONS.map((action, index) => [action, index]));

export function planReconciliation(input, options = {}) {
  const now = options.now ?? Date.now();
  const maxObservationAttempts = options.maxObservationAttempts ?? 3;
  const reobserveAfterMs = options.reobserveAfterMs ?? 30_000;
  const destructive = options.destructive === true;
  const desired = normalizeDesired(input.desired);
  const placements = filterPlacementsByScope(
    [...(input.placements ?? [])], desired,
  ).sort(comparePlacements);
  const currentBinding = input.currentBinding ?? null;
  const actions = [];
  const failures = [];

  if (desired.desiredState === 'absent') {
    return planAbsent({ desired, placements, currentBinding, destructive, now });
  }

  if (currentBinding && bindingSatisfies(currentBinding, desired)) {
    const boundPlacement = placements.find((placement) => placement.id === currentBinding.placementId);
    const boundExposure = findExposure(input.exposures, currentBinding.exposureId);
    if (isFreshReadyPlacement(boundPlacement, now) && isFreshVisibleExposure(boundExposure, now)) {
      return finishPlan(desired, [{
        action: 'no-op',
        reason: 'active-binding-is-current',
        libraryItemId: desired.libraryItemId,
        placementId: boundPlacement.id,
        bindingId: currentBinding.id,
      }], failures);
    }
  }

  const candidates = placements.filter((placement) => placement.infoHash === desired.infoHash);
  if (candidates.length === 0) {
    actions.push({
      action: 'create-or-reuse-placement',
      reason: 'no-placement-for-exact-release',
      libraryItemId: desired.libraryItemId,
      providerPreferences: desired.providerPreferences,
      releaseKey: desired.releaseKey,
      idempotencyKey: desired.placementIdempotencyKey,
    });
    return finishPlan(desired, actions, failures);
  }

  for (const placement of orderByProviderPreference(candidates, desired.providerPreferences)) {
    const freshness = evaluateExpiry(placement.observedAt, placement.expiresAt, now);
    if (freshness === 'stale' || freshness === 'unbounded') {
      const retry = boundedRetry(placement.observationAttempts ?? 0, maxObservationAttempts, reobserveAfterMs);
      if (retry.allowed) {
        actions.push({
          action: 'observe-again',
          target: 'placement',
          reason: freshness === 'stale' ? 'placement-observation-stale' : 'placement-freshness-unbounded',
          placementId: placement.id,
          attempt: retry.attempt,
          notBefore: now + retry.delayMs,
        });
      } else {
        failures.push(failure('placement-observation-exhausted', true, placement.id));
      }
      continue;
    }

    const readiness = findReadinessObservation(input.readinessObservations, placement.id);
    const readinessState = readiness?.state ?? placement.state;
    const readinessFreshness = readiness
      ? evaluateExpiry(readiness.observedAt, readiness.expiresAt, now)
      : 'legacy';
    if (readinessFreshness !== 'legacy' && readinessFreshness !== 'fresh') {
      actions.push({
        action: 'observe-again', target: 'readiness',
        reason: readinessFreshness === 'stale' ? 'readiness-observation-stale' : 'readiness-freshness-unbounded',
        placementId: placement.id,
      });
      continue;
    }
    if (readinessState !== 'ready') {
      if (['pending', 'unknown', 'degraded'].includes(readinessState)) {
        actions.push({
          action: 'wait-provider-readiness',
          reason: `placement-${readinessState}`,
          placementId: placement.id,
          retryable: true,
        });
      } else {
        failures.push(failure('placement-not-ready', readiness?.retryable === true, placement.id));
      }
      continue;
    }

    const inventory = inventoryForPlacement(input.providerFiles, placement.id);
    const inventorySnapshot = findInventorySnapshot(input.inventorySnapshots, placement.id);
    const inventoryFreshness = evaluateInventoryFreshness(inventory, inventorySnapshot, now);
    if (inventory.length === 0 || inventoryFreshness !== 'fresh') {
      const retry = boundedRetry(placement.inventoryAttempts ?? 0, maxObservationAttempts, reobserveAfterMs);
      if (retry.allowed) {
        actions.push({
          action: 'observe-again',
          target: 'provider-file-inventory',
          reason: inventory.length === 0
            ? 'provider-inventory-missing'
            : inventoryFreshness === 'untrusted'
              ? 'provider-inventory-not-authoritative-complete'
              : 'provider-inventory-stale',
          placementId: placement.id,
          attempt: retry.attempt,
          notBefore: now + retry.delayMs,
        });
      } else {
        failures.push(failure('provider-inventory-observation-exhausted', true, placement.id));
      }
      continue;
    }

    const mapping = findMapping(input.mappings, desired.releaseKey, placement.id);
    if (!mapping || mapping.state !== 'mapped' || mapping.authoritative !== true) {
      const mapResult = chooseExactProviderFile(desired, inventory, mapping);
      if (mapResult.status === 'mapped') {
        actions.push({
          action: 'map-exact-file',
          reason: mapResult.reason,
          placementId: placement.id,
          providerFileId: mapResult.providerFile.providerFileId,
          releaseKey: desired.releaseKey,
          evidence: mapResult.evidence,
        });
      } else {
        failures.push(failure(mapResult.failureCategory, false, placement.id, mapResult.evidence));
        actions.push({
          action: 'mark-degraded',
          reason: mapResult.failureCategory,
          placementId: placement.id,
          libraryItemId: desired.libraryItemId,
        });
      }
      continue;
    }

    const providerFile = inventory.find((file) => file.providerFileId === mapping.providerFileId);
    if (!providerFile) {
      failures.push(failure('mapped-provider-file-missing', false, placement.id));
      actions.push({
        action: 'mark-degraded',
        reason: 'mapped-provider-file-missing',
        placementId: placement.id,
        libraryItemId: desired.libraryItemId,
      });
      continue;
    }

    const exposure = findExposureForFile(
      input.exposures, placement.id, providerFile.providerFileId, desired,
    );
    if (!exposure || evaluateExpiry(exposure.observedAt, exposure.expiresAt, now) !== 'fresh') {
      actions.push({
        action: 'observe-exposure',
        reason: exposure ? 'exposure-observation-stale' : 'exposure-not-observed',
        placementId: placement.id,
        providerFileId: providerFile.providerFileId,
      });
      continue;
    }
    if (exposure.state !== 'visible' || exposure.readOnly !== true) {
      failures.push(failure(
        exposure.readOnly === false ? 'exposure-not-read-only' : 'exposure-not-visible',
        exposure.retryable === true,
        placement.id,
      ));
      actions.push({
        action: 'mark-degraded',
        reason: exposure.readOnly === false ? 'exposure-not-read-only' : 'exposure-not-visible',
        placementId: placement.id,
        libraryItemId: desired.libraryItemId,
      });
      continue;
    }

    // When current binding is degraded, we're recovering - create a new binding
    const isRecovery = currentBinding && currentBinding.status === 'degraded';
    actions.push({
      action: currentBinding && !isRecovery ? 'rebind' : 'bind',
      reason: currentBinding && !isRecovery ? 'preferred-usable-placement-changed' : (isRecovery ? 'recovery-from-degraded' : 'exact-file-is-usable'),
      libraryItemId: desired.libraryItemId,
      libraryPathId: desired.libraryPathId,
      releaseKey: desired.releaseKey,
      infoHash: desired.infoHash,
      fileIndex: desired.fileIndex,
      placementId: placement.id,
      providerFileId: providerFile.providerFileId,
      exposureId: exposure.id,
      expectedBindingVersion: currentBinding?.version ?? 0,
    });
    return finishPlan(desired, actions, failures);
  }

  if (actions.length === 0 && failures.length > 0) {
    actions.push({
      action: 'mark-degraded',
      reason: failures[0].category,
      libraryItemId: desired.libraryItemId,
    });
  }
  return finishPlan(desired, actions, failures);
}

export function chooseExactProviderFile(desired, inventory, existingMapping = null) {
  if (existingMapping?.providerFileId) {
    const exact = inventory.filter((file) => file.providerFileId === existingMapping.providerFileId);
    if (exact.length === 1) {
      return {
        status: 'mapped', reason: 'existing-authoritative-provider-file-id',
        providerFile: exact[0], evidence: { providerFileId: exact[0].providerFileId },
      };
    }
  }

  const explicitProviderFileId = desired.providerFileId ?? null;
  if (explicitProviderFileId) {
    const exact = inventory.filter((file) => file.providerFileId === explicitProviderFileId);
    if (exact.length === 1) {
      return {
        status: 'mapped', reason: 'desired-provider-file-id', providerFile: exact[0],
        evidence: { providerFileId: exact[0].providerFileId },
      };
    }
    return {
      status: 'failed', failureCategory: 'provider-file-missing',
      evidence: { providerFileId: explicitProviderFileId },
    };
  }

  const candidateIndexMatches = inventory.filter((file) =>
    Number.isSafeInteger(file.corpusFileIndex) && file.corpusFileIndex === desired.fileIndex,
  );
  if (candidateIndexMatches.length === 1) {
    return {
      status: 'mapped', reason: 'provider-confirmed-corpus-index-evidence',
      providerFile: candidateIndexMatches[0],
      evidence: { corpusFileIndex: desired.fileIndex, providerFileId: candidateIndexMatches[0].providerFileId },
    };
  }
  if (candidateIndexMatches.length > 1) {
    return {
      status: 'failed', failureCategory: 'provider-file-ambiguous',
      evidence: { corpusFileIndex: desired.fileIndex, matches: candidateIndexMatches.map((file) => file.providerFileId) },
    };
  }

  // Basename/path equality alone is deliberately insufficient. Provider IDs
  // and provider-authoritative inventory must establish exact mapping.
  return {
    status: 'failed', failureCategory: inventory.length === 0 ? 'provider-file-missing' : 'provider-file-ambiguous',
    evidence: { inventoryCount: inventory.length, releaseKey: desired.releaseKey },
  };
}

function planAbsent({ desired, placements, currentBinding, destructive, now }) {
  const actions = [];
  const failures = [];
  if (currentBinding) {
    actions.push({
      action: 'mark-degraded',
      reason: 'desired-absent-binding-removal-not-yet-active',
      libraryItemId: desired.libraryItemId,
      bindingId: currentBinding.id,
    });
  }
  for (const placement of placements) {
    const owned = placement.ownership === 'owned'
      && placement.ownerKey === desired.libraryItemId
      && placement.infoHash === desired.infoHash;
    const fresh = evaluateExpiry(placement.observedAt, placement.expiresAt, now) === 'fresh';
    const noDependents = placement.dependentBindingCount === 0;
    if (destructive && owned && fresh && noDependents) {
      actions.push({
        action: 'remove-stale-owned-resource',
        reason: 'desired-absent-proven-owned-unused-placement',
        placementId: placement.id,
        providerResourceId: placement.providerResourceId,
        safety: { ownershipProven: true, freshObservation: true, noDependents: true },
      });
    } else if (placement.state !== 'removed') {
      failures.push(failure(
        destructive ? 'resource-removal-not-proven-safe' : 'destructive-actions-disabled',
        false,
        placement.id,
        { owned, fresh, noDependents },
      ));
    }
  }
  if (actions.length === 0) actions.push({ action: 'no-op', reason: 'desired-absent-no-safe-action' });
  return finishPlan(desired, actions, failures);
}

function normalizeDesired(desired) {
  if (!desired || typeof desired !== 'object') throw new TypeError('desired state is required');
  const identity = validateReleaseIdentity(desired);
  return {
    ...desired,
    ...identity,
    desiredState: desired.desiredState ?? 'present',
    providerPreferences: [...(desired.providerPreferences ?? [])],
    providerScope: normalizeOptionalScope(desired.providerScope, ['provider', 'accountScope']),
    exposureScope: normalizeOptionalScope(desired.exposureScope, ['transport', 'mountScope']),
    placementIdempotencyKey: desired.placementIdempotencyKey
      ?? `virtual:${desired.libraryItemId}:${identity.infoHash}`,
  };
}

/**
 * Apply a reconciliation plan to the store. Pure planning entrypoint is
 * planReconciliation(); this is the sole materialization entrypoint for
 * routine bind/rebind/degrade. Returns the resulting binding state.
 *
 * Only bind/rebind/mark-degraded/no-op are materialized here; observation and
 * acquisition actions are emitted by the plan but applied by their respective
 * layers (observe-again, create-or-reuse-placement, etc.).
 */
export function executeReconciliation(plan, store, options = {}) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('executeReconciliation requires a plan');
  }
  if (!store || typeof store !== 'object') {
    throw new TypeError('executeReconciliation requires a store');
  }
  for (const action of plan.actions) {
    switch (action.action) {
      case 'no-op':
        // Active binding is current; nothing to materialize.
        break;
      case 'bind': {
        store.activateBinding({
          libraryItemId: action.libraryItemId,
          libraryPathId: action.libraryPathId,
          releaseKey: action.releaseKey,
          infoHash: action.infoHash,
          fileIndex: action.fileIndex,
          placementId: action.placementId,
          providerFileId: action.providerFileId,
          exposureId: action.exposureId,
          reason: action.reason,
        });
        break;
      }
      case 'rebind': {
        store.activateBinding({
          libraryItemId: action.libraryItemId,
          libraryPathId: action.libraryPathId,
          releaseKey: action.releaseKey,
          infoHash: action.infoHash,
          fileIndex: action.fileIndex,
          placementId: action.placementId,
          providerFileId: action.providerFileId,
          exposureId: action.exposureId,
          reason: action.reason,
          expectedBindingVersion: action.expectedBindingVersion,
        });
        break;
      }
      case 'mark-degraded': {
        store.markBindingDegraded({
          libraryItemId: action.libraryItemId,
          failureCategory: action.reason,
          expectedBindingVersion: action.bindingId
            ? undefined // version check is callers responsibility for explicit binding refs
            : undefined,
        });
        break;
      }
      // observe-again, create-or-reuse-placement, wait-provider-readiness,
      // map-exact-file, observe-exposure, remove-stale-owned-resource
      // are handled by observation/acquisition layers, not reconciliation.
      default:
        break;
    }
  }
  // Return the active binding after applying actions
  const bindings = store.listBindings(plan.libraryItemId);
  return bindings.find((b) => b.status === 'active')
    ?? bindings.find((b) => b.status === 'degraded')
    ?? null;
}

function finishPlan(desired, actions, failures) {
  const deduplicated = deduplicateActions(actions).sort(compareActions);
  return Object.freeze({
    mode: 'shadow',
    planKey: `${desired.libraryItemId}:${desired.releaseKey}:${desired.desiredState}`,
    libraryItemId: desired.libraryItemId,
    releaseKey: desired.releaseKey,
    actions: deduplicated,
    failures,
    destructiveActionCount: deduplicated.filter((action) => action.action === 'remove-stale-owned-resource').length,
  });
}

function deduplicateActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = JSON.stringify(action, Object.keys(action).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareActions(a, b) {
  const order = ACTION_ORDER.get(a.action) - ACTION_ORDER.get(b.action);
  if (order !== 0) return order;
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}
function comparePlacements(a, b) {
  return `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`);
}
function orderByProviderPreference(placements, preferences) {
  const rank = new Map(preferences.map((provider, index) => [provider, index]));
  return [...placements].sort((a, b) => {
    const ar = rank.get(a.provider) ?? Number.MAX_SAFE_INTEGER;
    const br = rank.get(b.provider) ?? Number.MAX_SAFE_INTEGER;
    return ar - br || comparePlacements(a, b);
  });
}
function bindingSatisfies(binding, desired) {
  return binding.status === 'active'
    && binding.libraryItemId === desired.libraryItemId
    && binding.libraryPathId === desired.libraryPathId
    && binding.releaseKey === desired.releaseKey;
}
function isFreshReadyPlacement(placement, now) {
  return placement?.state === 'ready' && evaluateExpiry(placement.observedAt, placement.expiresAt, now) === 'fresh';
}
function isFreshVisibleExposure(exposure, now) {
  return exposure?.state === 'visible' && exposure.readOnly === true
    && evaluateExpiry(exposure.observedAt, exposure.expiresAt, now) === 'fresh';
}
function evaluateExpiry(observedAt, expiresAt, now) {
  if (!Number.isSafeInteger(observedAt)) return 'missing';
  if (!Number.isSafeInteger(expiresAt)) return 'unbounded';
  return expiresAt > now ? 'fresh' : 'stale';
}
function evaluateInventoryFreshness(inventory, snapshot, now) {
  if (inventory.length === 0) return 'missing';
  if (snapshot && (snapshot.authoritative !== true || snapshot.complete !== true)) return 'untrusted';
  if (snapshot && evaluateExpiry(snapshot.observedAt, snapshot.expiresAt, now) !== 'fresh') return 'stale';
  return inventory.every((file) => Number.isSafeInteger(file.inventoryExpiresAt) && file.inventoryExpiresAt > now)
    ? 'fresh' : 'stale';
}
function inventoryForPlacement(files = [], placementId) {
  return files.filter((file) => file.placementId === placementId)
    .sort((a, b) => a.providerFileId.localeCompare(b.providerFileId));
}
function findInventorySnapshot(snapshots = [], placementId) {
  return snapshots.find((snapshot) => snapshot.placementId === placementId) ?? null;
}
function findReadinessObservation(observations = [], placementId) {
  return observations.find((observation) => observation.placementId === placementId) ?? null;
}
function findMapping(mappings = [], releaseKey, placementId) {
  return mappings.find((mapping) => mapping.releaseKey === releaseKey && mapping.placementId === placementId) ?? null;
}
function findExposure(exposures = [], exposureId) {
  return exposures.find((exposure) => exposure.id === exposureId) ?? null;
}
function findExposureForFile(exposures = [], placementId, providerFileId, desired = {}) {
  return exposures.filter((exposure) =>
    exposure.placementId === placementId
      && exposure.providerFileId === providerFileId
      && (!desired.exposureScope?.transport || exposure.transport === desired.exposureScope.transport)
      && (!desired.exposureScope?.mountScope || exposure.mountScope === desired.exposureScope.mountScope),
  ).sort((left, right) =>
    `${left.transport ?? ''}:${left.mountScope ?? ''}:${left.id ?? ''}`
      .localeCompare(`${right.transport ?? ''}:${right.mountScope ?? ''}:${right.id ?? ''}`),
  )[0] ?? null;
}
function filterPlacementsByScope(placements, desired) {
  if (!desired.providerScope) return placements;
  return placements.filter((placement) =>
    (!desired.providerScope.provider || placement.provider === desired.providerScope.provider)
      && (!desired.providerScope.accountScope || placement.accountScope === desired.providerScope.accountScope));
}
function normalizeOptionalScope(value, fields) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('scope must be an object');
  }
  const normalized = {};
  for (const field of fields) {
    if (value[field] == null) continue;
    if (typeof value[field] !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value[field].trim())) {
      throw new TypeError(`${field} scope is invalid`);
    }
    normalized[field] = value[field].trim().toLowerCase();
  }
  return normalized;
}
function boundedRetry(attempts, maxAttempts, baseDelayMs) {
  const attempt = attempts + 1;
  return {
    allowed: attempt <= maxAttempts,
    attempt,
    delayMs: Math.min(baseDelayMs * (2 ** Math.max(0, attempts)), 15 * 60 * 1000),
  };
}
function failure(category, retryable, placementId = null, evidence = null) {
  return { category, retryable, placementId, evidence };
}
