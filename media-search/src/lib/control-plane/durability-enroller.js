/**
 * Background Durability V1 — durable-enrollment registry.
 *
 * The runtime seam (durability-runtime.js) registers a scheduler with
 * this module when the BACKGROUND_DURABILITY_MODE flag requests
 * 'observe' or 'execute'. Existing fulfillment/repair seams
 * (reconciler, torbox-delivery) call into this module when an
 * authoritative binding is activated or a stale-placement-repaired
 * repair event is recorded. Calls are no-ops when the scheduler is
 * not registered (default-disabled mode), so the existing seams
 * remain safe and side-effect-free at disabled startup.
 *
 * The registry never invents playback tracking: enrollment keys are
 * derived from the persisted binding id+version or repair event
 * (infoHash, occurredAt), both of which already exist in the
 * control-plane store.
 */
import { REPAIR_FAILURE_CATEGORIES } from './repair-events.js';

const REPAIR_ENROLL_CATEGORIES = Object.freeze(new Set([
  REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED,
]));

let registeredScheduler = null;

export function registerDurabilityScheduler(scheduler) {
  registeredScheduler = scheduler ?? null;
}

export function clearDurabilityScheduler() {
  registeredScheduler = null;
}

export function getDurabilityScheduler() {
  return registeredScheduler;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeInfoHash(value) {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) {
    throw new TypeError('infoHash must be a 40-character lowercase hex string');
  }
  return hash;
}

export function notifyBindingActivated(input) {
  if (!registeredScheduler || typeof registeredScheduler.enrollNewlyFulfilled !== 'function') {
    return null;
  }
  const libraryItemId = requireString(input?.libraryItemId, 'libraryItemId');
  const binding = input?.binding;
  if (!binding || !binding.id || binding.version == null) {
    return { enrolled: false, reason: 'binding-missing-id' };
  }
  return registeredScheduler.enrollNewlyFulfilled({
    libraryItemId,
    enrollmentKey: `binding:${binding.id}:${binding.version}`,
    observedAt: input?.observedAt ?? Date.now(),
  });
}

export function notifyStalePlacementRepaired(input) {
  if (!registeredScheduler || typeof registeredScheduler.enrollRecentlyRepaired !== 'function') {
    return null;
  }
  const libraryItemId = requireString(input?.libraryItemId, 'libraryItemId');
  if (!REPAIR_ENROLL_CATEGORIES.has(input?.failureCategory)) {
    return { enrolled: false, reason: 'not-stale-placement-repaired' };
  }
  const infoHash = normalizeInfoHash(input?.infoHash);
  return registeredScheduler.enrollRecentlyRepaired({
    libraryItemId,
    infoHash,
    occurredAt: input?.occurredAt ?? Date.now(),
  });
}

export default {
  registerDurabilityScheduler,
  clearDurabilityScheduler,
  getDurabilityScheduler,
  notifyBindingActivated,
  notifyStalePlacementRepaired,
};
