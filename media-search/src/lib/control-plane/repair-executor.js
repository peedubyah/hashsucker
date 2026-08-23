import { validateReleaseIdentity } from '../../api/release-contract.js';
import { PROVIDER_CAPABILITIES } from '../providers/capabilities.js';
import { REPAIR_ACTIONS, planRdZurgRepair } from './repair-planner.js';

/**
 * Explicitly authorized repair executor over injected provider/observer seams.
 * No live gateway is constructed here. Every provider mutation must be exposed
 * by the injected adapter and every action is durably audited before execution.
 */
export function createRdZurgRepairExecutor({ store, slice, realDebrid } = {}) {
  requireDependencies(store, slice, realDebrid);

  function persistPlan(libraryItemId, plan) {
    if (plan?.status !== 'repair-required') {
      throw new TypeError('Only repair-required plans can become transactions');
    }
    const snapshot = slice.getState(libraryItemId, plan.desiredIdentity);
    const lifecycle = store.getLifecycle(libraryItemId);
    const trusted = planRdZurgRepair({
      snapshot,
      lifecycle,
      scope: plan.scope,
      now: plan.evaluatedAt,
    });
    if (trusted.planKey !== plan.planKey) {
      throw new Error('Repair plan does not match trusted control-plane evidence');
    }
    return store.createRepairTransaction({
      libraryItemId,
      planKey: plan.planKey,
      desiredIdentity: plan.desiredIdentity,
      scope: plan.scope,
      expectedBindingVersion: plan.binding.version,
      plan,
    });
  }

  function authorize(transactionId, { actions, authorizedBy } = {}) {
    const repair = store.getRepairTransaction(transactionId);
    if (!repair) throw new Error(`Unknown repair transaction: ${transactionId}`);
    assertTrustedPlan(repair, repair.plan.evaluatedAt);
    requireActionDependencies(actions);
    return store.authorizeRepairTransaction(transactionId, { actions, authorizedBy });
  }

  async function execute(transactionId, context = {}) {
    let repair = store.getRepairTransaction(transactionId);
    if (!repair) throw new Error(`Unknown repair transaction: ${transactionId}`);
    if (repair.status === 'failed' && context.resume === true) {
      repair = store.resumeRepairTransaction(repair.id);
    }
    if (!['authorized', 'executing'].includes(repair.status)) {
      throw new Error(`Repair transaction cannot execute from ${repair.status}`);
    }
    const identity = validateReleaseIdentity(repair.desiredIdentity);
    assertCurrentBinding(repair, identity);
    const ambiguous = repair.steps.find((step) => step.status === 'running');
    if (ambiguous) {
      throw repairError(
        `Repair step ${ambiguous.action} has an ambiguous running operation requiring manual resolution`,
        'repair-operation-outcome-unknown',
      );
    }
    const alreadySucceeded = new Set(
      repair.steps.filter((step) => step.status === 'succeeded').map((step) => step.action),
    );
    const sequence = repair.plan.actionSequence ?? [];
    const actions = sequence.filter((action) => repair.authorizedActions.includes(action));
    if (actions.length !== repair.authorizedActions.length) {
      throw repairError('Persisted repair authorization does not match the plan sequence', 'repair-plan-invalid');
    }

    for (const action of actions) {
      if (alreadySucceeded.has(action)) continue;
      assertCurrentBinding(repair, identity);
      const request = requestAudit(action, context);
      const step = store.startRepairStep(repair.id, action, request);
      if (step.status === 'succeeded') continue;
      if (step.status === 'running'
        && repair.steps.some((candidate) => candidate.id === step.id)) {
        throw repairError(
          `Repair step ${action} has an ambiguous running operation requiring manual resolution`,
          'repair-operation-outcome-unknown',
        );
      }
      try {
        const result = await executeAction(action, repair, identity, context, step);
        store.completeRepairStep(step.id, auditResult(result));
      } catch (error) {
        if (isProviderMutation(action)
          && error?.category !== 'temporarily-unavailable'
          && error?.category !== 'rate-limit'
          && error?.category !== 'authentication'
          && error?.category !== 'authorization'
          && error?.category !== 'invalid-request'
          && error?.category !== 'unsupported'
          && error?.category !== 'unsafe-operation') {
          store.failRepairTransaction(repair.id, {
            failureCategory: 'repair-operation-outcome-unknown',
          });
          throw repairError(
            `Provider mutation outcome is unknown for ${action}; manual resolution is required`,
            'repair-operation-outcome-unknown',
          );
        }
        store.failRepairStep(step.id, safeFailure(error));
        throw error;
      }
    }

    try {
      assertPostconditions(repair, identity, context);
    } catch (error) {
      store.failRepairTransaction(repair.id, {
        failureCategory: error?.category ?? 'repair-postcondition-failed',
      });
      throw error;
    }
    return store.completeRepairTransaction(repair.id);
  }

  async function executeAction(action, repair, identity, context, step) {
    switch (action) {
      case REPAIR_ACTIONS.REPLACE_PLACEMENT_OBSERVATION:
        return slice.observePlacement(identity, observationContext(context));
      case REPAIR_ACTIONS.REOBSERVE_PROVIDER:
        return reobserveProvider(repair, identity, context);
      case REPAIR_ACTIONS.RESELECT_KNOWN_FILES:
        return reselectKnownFile(repair, identity, context, step);
      case REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR:
        return requestProviderRepair(repair, identity, context, step);
      case REPAIR_ACTIONS.REOBSERVE_ZURG_METADATA:
        return slice.observeZurgMetadata(
          identity, requireString(context.metadataPath, 'metadataPath'), context,
        );
      case REPAIR_ACTIONS.REOBSERVE_FILESYSTEM_EXPOSURE:
        return reobserveExposure(repair, identity, context);
      case REPAIR_ACTIONS.RECONCILE_BINDING:
        return reconcileExactBinding(repair, identity, context);
      default:
        throw new TypeError(`Unsupported repair action: ${action}`);
    }
  }

  async function reobserveProvider(repair, identity, context) {
    const placement = await slice.observePlacement(identity, observationContext(context));
    if (!placement) return null;
    await slice.observeReadiness(identity, placement, context);
    await slice.observeInventory(placement, context);
    return { placementId: placement.id, observed: ['placement', 'readiness', 'inventory'] };
  }

  async function reselectKnownFile(repair, identity, context, step) {
    const { binding, placement, providerFile } = boundTarget(repair, identity);
    const snapshot = slice.getState(repair.libraryItemId, identity);
    const activeBindings = store.listActiveBindingsForPlacement(placement.id);
    const requiredIds = new Set(activeBindings.map((entry) => entry.providerFileId));
    requiredIds.add(providerFile.providerFileId);
    const selectedIds = snapshot.providerFiles
      .filter((file) => file.placementId === placement.id
        && (file.selected === true || requiredIds.has(file.providerFileId)))
      .map((file) => file.providerFileId)
      .sort();
    const observedIds = new Set(selectedIds);
    if ([...requiredIds].some((providerFileId) => !observedIds.has(providerFileId))) {
      throw repairError('Shared placement selection would omit an active exact binding', 'unsafe-operation');
    }
    const capability = realDebrid.require(PROVIDER_CAPABILITIES.FILE_SELECTION);
    return capability.selectKnownFiles({
      ...identity,
      providerResourceId: placement.providerResourceId,
    }, selectedIds, {
      ...context,
      idempotencyKey: `${repair.id}:${step.action}:${step.attempt}`,
    });
  }

  async function requestProviderRepair(repair, identity, context, step) {
    const placement = boundTarget(repair, identity).placement;
    return realDebrid.require(PROVIDER_CAPABILITIES.REPAIR_REQUEST).requestRepair({
      ...identity,
      providerResourceId: placement.providerResourceId,
    }, {
      ...context,
      idempotencyKey: `${repair.id}:${step.action}:${step.attempt}`,
      reason: repair.plan.reason,
    });
  }

  async function reobserveExposure(repair, identity, context) {
    const { placement, providerFile } = boundTarget(repair, identity);
    return slice.observeExposure(
      identity,
      placement,
      providerFile,
      requireString(context.relativePath, 'relativePath'),
      context,
    );
  }

  async function reconcileExactBinding(repair, identity, context) {
    const snapshot = slice.getState(repair.libraryItemId, identity);
    const placement = newestUsablePlacement(snapshot, repair.scope.accountScope);
    if (!placement) throw new Error('Reconciliation requires a freshly observed provider placement');
    const inventory = snapshot.providerFiles.filter((file) => file.placementId === placement.id);
    const exact = inventory.filter((file) => file.corpusFileIndex === identity.fileIndex);
    if (exact.length !== 1) throw new Error('Reconciliation requires one exact canonical provider file');
    const providerFile = exact[0];
    slice.mapExactFile(identity, placement, providerFile.providerFileId, { now: context.now ?? Date.now() });
    const exposure = await slice.observeExposure(
      identity,
      placement,
      providerFile,
      requireString(context.relativePath, 'relativePath'),
      context,
    );
    return slice.activateBinding({
      libraryItemId: repair.libraryItemId,
      libraryPathId: snapshot.desired.libraryPathId,
      release: identity,
      resource: placement,
      providerFileId: providerFile.providerFileId,
      exposureId: exposure.id,
      expectedBindingVersion: repair.expectedBindingVersion,
      reason: `repair-transaction:${repair.id}`,
    });
  }

  function assertPostconditions(repair, identity, context) {
    const snapshot = slice.getState(repair.libraryItemId, identity);
    const lifecycle = store.getLifecycle(repair.libraryItemId);
    const plan = planRdZurgRepair({
      snapshot,
      lifecycle,
      scope: repair.scope,
      now: context.now ?? Date.now(),
    });
    if (plan.status !== 'healthy') {
      const error = new Error(`Repair postconditions not met: ${plan.reason}`);
      error.category = 'repair-postcondition-failed';
      throw error;
    }
    const binding = snapshot.currentBinding;
    const mapping = snapshot.mappings.find((entry) =>
      entry.releaseKey === identity.releaseKey
        && entry.placementId === binding?.placementId
        && entry.providerFileId === binding?.providerFileId
        && entry.state === 'mapped'
        && entry.authoritative === true);
    const exposure = snapshot.exposures.find((entry) =>
      entry.id === binding?.exposureId
        && entry.placementId === binding?.placementId
        && entry.providerFileId === binding?.providerFileId
        && entry.state === 'visible'
        && entry.readOnly === true);
    if (binding?.releaseKey !== identity.releaseKey || !mapping || !exposure) {
      throw repairError(
        'Repair postconditions do not prove an exact active binding target',
        'repair-postcondition-failed',
      );
    }
  }

  function assertTrustedPlan(repair, now) {
    const trusted = planRdZurgRepair({
      snapshot: slice.getState(repair.libraryItemId, repair.desiredIdentity),
      lifecycle: store.getLifecycle(repair.libraryItemId),
      scope: repair.scope,
      now,
    });
    if (trusted.planKey !== repair.planKey) {
      throw repairError('Persisted repair plan does not match trusted control-plane evidence', 'repair-plan-invalid');
    }
  }

  function assertCurrentBinding(repair, identity) {
    boundTarget(repair, identity);
  }

  function boundTarget(repair, identity) {
    const snapshot = slice.getState(repair.libraryItemId, identity);
    const binding = snapshot.currentBinding;
    if (!binding || binding.version !== repair.expectedBindingVersion
      || binding.releaseKey !== identity.releaseKey) {
      throw new Error('Repair binding version is no longer current');
    }
    const placement = snapshot.placements.find((entry) => entry.id === binding.placementId);
    const providerFile = snapshot.providerFiles.find((entry) =>
      entry.placementId === binding.placementId && entry.providerFileId === binding.providerFileId);
    if (!placement || !providerFile) throw new Error('Bound provider target is no longer observed');
    return { binding, placement, providerFile };
  }

  return Object.freeze({ persistPlan, authorize, execute });
}

function newestUsablePlacement(snapshot, accountScope) {
  const observations = snapshot.placementObservations
    .filter((entry) => entry.provider === 'realdebrid'
      && entry.accountScope === accountScope && entry.observationState === 'present')
    .sort((left, right) => right.observedAt - left.observedAt);
  for (const observation of observations) {
    const placement = snapshot.placements.find((entry) => entry.id === observation.placementId);
    const readiness = snapshot.readinessObservations.find((entry) => entry.placementId === placement?.id);
    const inventory = snapshot.inventorySnapshots.find((entry) => entry.placementId === placement?.id);
    if (placement && readiness?.state === 'ready'
      && inventory?.authoritative === true && inventory?.complete === true) return placement;
  }
  return null;
}

function observationContext(context) {
  return {
    signal: context.signal,
    observedAt: context.observedAt ?? context.now,
    expiresAt: context.expiresAt,
  };
}

function requestAudit(action, context) {
  return {
    action,
    metadataPathSupplied: typeof context.metadataPath === 'string',
    relativePathSupplied: typeof context.relativePath === 'string',
  };
}

function auditResult(result) {
  if (result == null) return { observed: 'missing' };
  return {
    accepted: result.accepted,
    idempotencyGuaranteed: result.idempotencyGuaranteed,
    state: result.state ?? result.observationState,
    placementId: result.id ?? result.placementId,
    bindingVersion: result.version,
    operationId: result.operationId,
  };
}

function safeFailure(error) {
  return {
    failureCategory: safeCategory(error?.category),
    retryable: error?.retryable === true,
    result: { name: safeErrorName(error?.name) },
  };
}

function safeCategory(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
    ? value
    : 'repair-operation-failed';
}

function safeErrorName(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value)
    ? value
    : 'Error';
}

function isProviderMutation(action) {
  return action === REPAIR_ACTIONS.RESELECT_KNOWN_FILES
    || action === REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR;
}

function requireActionDependencies(actions) {
  if (!Array.isArray(actions)) return;
  const authorized = new Set(actions);
  if (authorized.has(REPAIR_ACTIONS.REQUEST_PROVIDER_REPAIR)
    && !authorized.has(REPAIR_ACTIONS.REOBSERVE_PROVIDER)) {
    throw new Error('Provider repair authorization requires provider re-observation');
  }
  if (authorized.has(REPAIR_ACTIONS.RESELECT_KNOWN_FILES)
    && !authorized.has(REPAIR_ACTIONS.REOBSERVE_PROVIDER)) {
    throw new Error('Known-file selection authorization requires provider re-observation');
  }
}

function repairError(message, category) {
  const error = new Error(message);
  error.category = category;
  error.retryable = false;
  return error;
}

function requireDependencies(store, slice, realDebrid) {
  for (const method of [
    'createRepairTransaction', 'authorizeRepairTransaction', 'startRepairStep',
    'completeRepairStep', 'failRepairStep', 'failRepairTransaction', 'resumeRepairTransaction',
    'completeRepairTransaction', 'getRepairTransaction', 'getLifecycle',
    'listActiveBindingsForPlacement',
  ]) {
    if (!store || typeof store[method] !== 'function') {
      throw new TypeError(`Repair executor requires store.${method}()`);
    }
  }
  for (const method of [
    'observePlacement', 'observeReadiness', 'observeInventory', 'observeZurgMetadata',
    'observeExposure', 'mapExactFile', 'activateBinding', 'getState',
  ]) {
    if (!slice || typeof slice[method] !== 'function') {
      throw new TypeError(`Repair executor requires slice.${method}()`);
    }
  }
  if (!realDebrid || realDebrid.provider !== 'realdebrid') {
    throw new TypeError('Repair executor requires a Real-Debrid adapter');
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1000) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}
