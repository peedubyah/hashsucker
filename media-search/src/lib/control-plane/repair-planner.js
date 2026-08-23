import { createHash } from 'node:crypto';

import { validateReleaseIdentity } from '../../api/release-contract.js';
import { projectRdZurgLifecycle } from './rd-zurg-slice.js';

export const REPAIR_ACTIONS = Object.freeze({
  REOBSERVE_PROVIDER: 'reobserve-provider-state',
  REPLACE_PLACEMENT_OBSERVATION: 'replace-placement-observation',
  RESELECT_KNOWN_FILES: 'reselect-known-files',
  REQUEST_PROVIDER_REPAIR: 'request-provider-repair',
  REOBSERVE_ZURG_METADATA: 'reobserve-zurg-metadata',
  REOBSERVE_FILESYSTEM_EXPOSURE: 'reobserve-filesystem-exposure',
  RECONCILE_BINDING: 'reconcile-exact-binding',
});

const BROKEN_ZURG_STATES = new Set([
  'broken_torrent',
  'under_repair_torrent',
]);

/**
 * Build a deterministic, side-effect-free repair proposal for one exact
 * canonical release. Provider identifiers and filesystem paths are evidence;
 * they never replace the `(infoHash,fileIndex)` desired identity.
 */
export function planRdZurgRepair({ snapshot, lifecycle, scope, now = Date.now() } = {}) {
  if (!snapshot || !lifecycle || !scope) {
    throw new TypeError('Repair planning requires snapshot, lifecycle, and explicit scope');
  }
  const desiredIdentity = validateReleaseIdentity(snapshot.desired);
  const projection = projectRdZurgLifecycle({ snapshot, lifecycle, scope, now });
  const binding = snapshot.currentBinding?.releaseKey === desiredIdentity.releaseKey
    ? snapshot.currentBinding
    : null;

  if (!binding) {
    return freezePlan({
      status: 'not-applicable',
      reason: 'no-active-canonical-binding',
      desiredIdentity,
      evaluatedAt: now,
      scope: projection.scope,
      triggers: [],
      permittedActions: [],
      actionSequence: [],
      currentObservations: summarizeObservations(projection.facts),
      expectedPostconditions: expectedPostconditions(desiredIdentity),
    });
  }

  const triggers = detectTriggers(projection.facts, snapshot, binding, now);
  if (triggers.length === 0) {
    return freezePlan({
      status: 'healthy',
      reason: 'binding-evidence-is-current',
      evaluatedAt: now,
      desiredIdentity,
      scope: projection.scope,
      triggers,
      permittedActions: [],
      actionSequence: [],
      currentObservations: summarizeObservations(projection.facts),
      expectedPostconditions: expectedPostconditions(desiredIdentity),
    });
  }

  const permittedActions = permittedActionsFor(triggers, snapshot, binding);
  const actionSequence = orderedActions(permittedActions);
  const currentObservations = summarizeObservations(projection.facts);
  const repairFingerprint = stableDigest({
    desiredIdentity,
    scope: projection.scope,
    bindingVersion: binding.version,
    triggers,
    permittedActions,
    actionSequence,
    currentObservations,
  });
  return freezePlan({
    status: 'repair-required',
    reason: triggers[0].category,
    planKey: `repair:${desiredIdentity.releaseKey}:${repairFingerprint}`,
    evaluatedAt: now,
    desiredIdentity,
    scope: projection.scope,
    binding: {
      id: binding.id,
      version: binding.version,
      placementId: binding.placementId,
      providerFileId: binding.providerFileId,
      exposureId: binding.exposureId,
    },
    triggers,
    permittedActions,
    actionSequence,
    currentObservations,
    expectedPostconditions: expectedPostconditions(desiredIdentity),
  });
}

function detectTriggers(facts, snapshot, binding, now) {
  const triggers = [];
  if (facts.placement.state === 'missing') {
    triggers.push(trigger('missing-provider-placement', facts.placement));
  } else if (facts.placement.state !== 'present' || facts.readiness.state !== 'ready') {
    triggers.push(trigger('broken-provider-observation', {
      placement: facts.placement,
      readiness: facts.readiness,
    }));
  }

  const boundFile = snapshot.providerFiles.find((file) =>
    file.placementId === binding.placementId && file.providerFileId === binding.providerFileId);
  const boundInventory = snapshot.inventorySnapshots.find((entry) =>
    entry.placementId === binding.placementId);
  const boundInventoryIsHealthy = boundInventory?.authoritative === true
    && boundInventory.complete === true
    && Number.isSafeInteger(boundInventory.expiresAt)
    && boundInventory.expiresAt > now;
  if (!boundFile || !boundInventoryIsHealthy) {
    triggers.push(trigger('provider-inventory-degraded', facts.inventory));
  } else if (boundFile.selected === false) {
    triggers.push(trigger('known-file-selection-lost', {
      placementId: binding.placementId,
      providerFileId: binding.providerFileId,
    }));
  }

  const boundMapping = snapshot.mappings.find((entry) =>
    entry.releaseKey === binding.releaseKey
      && entry.placementId === binding.placementId
      && entry.providerFileId === binding.providerFileId);
  if (boundMapping?.state !== 'mapped' || boundMapping.authoritative !== true) {
    triggers.push(trigger('exact-file-mapping-degraded', facts.exactFileMapping));
  }

  const boundExposure = snapshot.exposures.find((entry) => entry.id === binding.exposureId);
  if (boundExposure?.state !== 'visible' || boundExposure.readOnly !== true
    || !Number.isSafeInteger(boundExposure.expiresAt) || boundExposure.expiresAt <= now) {
    triggers.push(trigger('missing-filesystem-exposure', facts.exposure));
  }

  const zurgIsStale = facts.zurgMetadata.freshness === 'stale';
  const zurgIsBroken = BROKEN_ZURG_STATES.has(facts.zurgMetadata.zurgState);
  if (facts.zurgMetadata.state !== 'present' || zurgIsStale || zurgIsBroken) {
    triggers.push(trigger('stale-zurg-metadata-state', facts.zurgMetadata));
  }

  if (facts.binding.state !== 'active') {
    triggers.push(trigger('canonical-binding-degraded', facts.binding));
  }

  return triggers.sort((left, right) => left.category.localeCompare(right.category));
}

function permittedActionsFor(triggers, snapshot, binding) {
  const categories = new Set(triggers.map((entry) => entry.category));
  const actions = new Set();

  if (categories.has('missing-provider-placement') || categories.has('broken-provider-observation')) {
    actions.add(REPAIR_ACTIONS.REOBSERVE_PROVIDER);
    actions.add(REPAIR_ACTIONS.REPLACE_PLACEMENT_OBSERVATION);
    actions.add(REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR);
  }
  if (categories.has('known-file-selection-lost')) {
    const known = snapshot.providerFiles.some((file) =>
      file.placementId === binding.placementId && file.providerFileId === binding.providerFileId);
    if (known) {
      actions.add(REPAIR_ACTIONS.RESELECT_KNOWN_FILES);
      actions.add(REPAIR_ACTIONS.REOBSERVE_PROVIDER);
    }
  }
  if (categories.has('provider-inventory-degraded')) {
    actions.add(REPAIR_ACTIONS.REOBSERVE_PROVIDER);
  }
  if (categories.has('missing-filesystem-exposure')) {
    // A mount miss is not evidence that the provider resource is gone. It only
    // permits another scoped filesystem observation.
    actions.add(REPAIR_ACTIONS.REOBSERVE_FILESYSTEM_EXPOSURE);
  }
  if (categories.has('stale-zurg-metadata-state')) {
    actions.add(REPAIR_ACTIONS.REOBSERVE_ZURG_METADATA);
  }
  const requiresReconciliation = categories.has('missing-provider-placement')
    || categories.has('broken-provider-observation')
    || categories.has('provider-inventory-degraded')
    || categories.has('known-file-selection-lost')
    || categories.has('exact-file-mapping-degraded')
    || categories.has('canonical-binding-degraded');
  if (requiresReconciliation) actions.add(REPAIR_ACTIONS.RECONCILE_BINDING);
  return [...actions];
}

function orderedActions(actions) {
  const order = [
    REPAIR_ACTIONS.REPLACE_PLACEMENT_OBSERVATION,
    REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR,
    REPAIR_ACTIONS.RESELECT_KNOWN_FILES,
    REPAIR_ACTIONS.REOBSERVE_PROVIDER,
    REPAIR_ACTIONS.REOBSERVE_ZURG_METADATA,
    REPAIR_ACTIONS.REOBSERVE_FILESYSTEM_EXPOSURE,
    REPAIR_ACTIONS.RECONCILE_BINDING,
  ];
  return order.filter((action) => actions.includes(action));
}

function summarizeObservations(facts) {
  return Object.freeze({
    placement: summarizeFact(facts.placement),
    readiness: summarizeFact(facts.readiness),
    inventory: summarizeFact(facts.inventory),
    zurgMetadata: summarizeFact(facts.zurgMetadata),
    exposure: summarizeFact(facts.exposure),
    exactFileMapping: summarizeFact(facts.exactFileMapping),
    binding: summarizeFact(facts.binding),
    cataloging: summarizeFact(facts.cataloging),
    playback: summarizeFact(facts.playback),
  });
}

function summarizeFact(value) {
  if (!value) return null;
  const allowed = [
    'state', 'observedState', 'freshness', 'observedAt', 'expiresAt',
    'failureCategory', 'retryable', 'sourceId', 'zurgState', 'zurgStateWhen',
    'authoritative', 'complete', 'fileCount', 'readOnly', 'version',
    'validFrom', 'reconciledAt', 'occurredAt', 'reason',
  ];
  return Object.freeze(Object.fromEntries(
    allowed.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]),
  ));
}

function expectedPostconditions(identity) {
  return Object.freeze({
    canonicalIdentity: Object.freeze({ ...identity }),
    placement: 'present',
    readiness: 'ready',
    inventory: 'present-fresh-authoritative-complete',
    zurgMetadata: 'present-fresh-not-broken',
    exposure: 'visible-fresh-read-only',
    exactFileMapping: 'mapped-authoritative',
    binding: 'active-for-canonical-identity',
    catalogAndPlaybackMutationPermitted: false,
  });
}

function trigger(category, evidence) {
  return Object.freeze({ category, evidence: sanitize(evidence) });
}

function sanitize(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const blocked = new Set(['metadataPath', 'relativePath', 'providerResourceId', 'providerFileId']);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.has(key))
    .map(([key, entry]) => [key, sanitize(entry)]));
}

function freezePlan(plan) {
  return Object.freeze({
    mode: 'repair-plan',
    executed: false,
    ...plan,
  });
}

function stableDigest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
