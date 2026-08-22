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
  const placements = [...(input.placements ?? [])].sort(comparePlacements);
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

    if (placement.state !== 'ready') {
      if (['pending', 'unknown', 'degraded'].includes(placement.state)) {
        actions.push({
          action: 'wait-provider-readiness',
          reason: `placement-${placement.state}`,
          placementId: placement.id,
          retryable: true,
        });
      } else {
        failures.push(failure('placement-not-ready', placement.retryable === true, placement.id));
      }
      continue;
    }

    const inventory = inventoryForPlacement(input.providerFiles, placement.id);
    const inventoryFreshness = evaluateInventoryFreshness(inventory, now);
    if (inventory.length === 0 || inventoryFreshness !== 'fresh') {
      const retry = boundedRetry(placement.inventoryAttempts ?? 0, maxObservationAttempts, reobserveAfterMs);
      if (retry.allowed) {
        actions.push({
          action: 'observe-again',
          target: 'provider-file-inventory',
          reason: inventory.length === 0 ? 'provider-inventory-missing' : 'provider-inventory-stale',
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

    const exposure = findExposureForFile(input.exposures, placement.id, providerFile.providerFileId);
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

    actions.push({
      action: currentBinding ? 'rebind' : 'bind',
      reason: currentBinding ? 'preferred-usable-placement-changed' : 'exact-file-is-usable',
      libraryItemId: desired.libraryItemId,
      libraryPathId: desired.libraryPathId,
      releaseKey: desired.releaseKey,
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
    placementIdempotencyKey: desired.placementIdempotencyKey
      ?? `virtual:${desired.libraryItemId}:${identity.infoHash}`,
  };
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
function evaluateInventoryFreshness(inventory, now) {
  if (inventory.length === 0) return 'missing';
  return inventory.every((file) => Number.isSafeInteger(file.inventoryExpiresAt) && file.inventoryExpiresAt > now)
    ? 'fresh' : 'stale';
}
function inventoryForPlacement(files = [], placementId) {
  return files.filter((file) => file.placementId === placementId)
    .sort((a, b) => a.providerFileId.localeCompare(b.providerFileId));
}
function findMapping(mappings = [], releaseKey, placementId) {
  return mappings.find((mapping) => mapping.releaseKey === releaseKey && mapping.placementId === placementId) ?? null;
}
function findExposure(exposures = [], exposureId) {
  return exposures.find((exposure) => exposure.id === exposureId) ?? null;
}
function findExposureForFile(exposures = [], placementId, providerFileId) {
  return exposures.find((exposure) =>
    exposure.placementId === placementId && exposure.providerFileId === providerFileId,
  ) ?? null;
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
