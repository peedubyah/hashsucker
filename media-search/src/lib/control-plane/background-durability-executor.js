/**
 * Background Durability V1 — Provider evidence and existing-repair executor.
 *
 * Owns the read-only confirmation of existing persisted placements for
 * BACKGROUND_SAFE providers (currently TorBox). Worker A supplies a batch of
 * due items; this executor:
 *
 *   1. Filters by provider durability class (BACKGROUND_SAFE only).
 *   2. Groups by (provider, accountScope).
 *   3. Fetches ONE provider-scope snapshot per group (single mylist).
 *   4. Evaluates each due placement locally against the shared snapshot:
 *        - present         → HEALTHY            (no side effects, accounting++)
 *        - absent + unique → STALE_CONFIRMED    (invoke existing repair seam
 *                                                exactly once: markPlacementRemoved
 *                                                + recordRepairEvent)
 *        - absent + multi  → AMBIGUOUS          (fail-closed: no repair, no mark)
 *   5. Surfaces a persistent rate-limit/provider-scope backoff signal so
 *      Worker A's scheduler can reschedule every remaining item in that
 *      (provider, accountScope) group, not just the current one.
 *   6. Surfaces transient (network/5xx-non-rate-limit/timeout) outcomes
 *      distinctly so Worker A can apply transient backoff without ever
 *      marking anything stale.
 *
 * The executor never:
 *   - polls requestdl or Real-Debrid unrestricted URLs
 *   - adds magnets or creates new placements
 *   - selects files, rediscover, rerank, or refreshes Plex
 *   - inventory-scans healthy items
 *   - touches torrent_files (the same-TorrentFile durability grain)
 *
 * The existing on-demand `resolveTorBoxDeliveryWithStaleRecovery` is the
 * single source of truth for placement recreation; this executor only
 * surfaces STALE_CONFIRMED evidence and demotes candidate mappings via the
 * same store primitives (`markPlacementRemoved`) that the on-demand path
 * uses. The next on-demand resolution will then re-enter the existing
 * bounded same-TorrentFile repair path exactly once.
 */

import {
  classifyProviderDurability,
  evaluateProviderForBackground,
  PROVIDER_DURABILITY_CLASS,
} from './durability-provider-classifier.js';
import { PROVIDER_CAPABILITIES } from '../providers/capabilities.js';
import { REPAIR_FAILURE_CATEGORIES, recordRepairEvent } from './repair-events.js';
import { providerAccounting } from '../providers/provider-accounting.js';

export const BACKGROUND_OUTCOME = Object.freeze({
  HEALTHY: 'healthy',
  STALE_CONFIRMED: 'stale-confirmed',
  AMBIGUOUS: 'ambiguous',
  TRANSIENT: 'transient',
  RATE_LIMITED: 'rate-limited',
  ON_DEMAND_ONLY: 'on-demand-only',
  NOT_FOUND: 'not-found',
  INVALID: 'invalid',
});

const REPAIR_PROVENANCE = 'background-durability-v1';

function requireStore(store) {
  if (!store || typeof store !== 'object' || typeof store.db !== 'object') {
    throw new TypeError('controlPlaneStore is required');
  }
  return store;
}

function requireProvider(provider) {
  if (!provider || typeof provider !== 'object' || typeof provider.require !== 'function') {
    throw new TypeError('providerAdapter is required');
  }
  return provider;
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

function isTransientError(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return true;
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED'
    || error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return true;
  if (typeof error.message === 'string' && /timeout|timed out|network|fetch failed|socket hang up/i.test(error.message)) {
    return true;
  }
  if (Number.isInteger(error.status)) {
    const status = error.status;
    // Temporary upstream 5xx is transient (5xx-other than 429 is retriable later
    // but never evidence of absence).
    if (status >= 500 && status < 600) return true;
  }
  if (typeof error.category === 'string') {
    if (error.category === 'rate-limit' || error.category === 'authentication') return false;
    if (error.category === 'transient' || error.category === 'timeout' || error.category === 'network') return true;
  }
  return false;
}

function isRateLimitError(error) {
  if (!error) return false;
  if (Number.isInteger(error.status) && error.status === 429) return true;
  if (error.category === 'rate-limit') return true;
  return false;
}

/**
 * Validate a single due item shape. The executor never re-derives the
 * placement identity from anything other than what Worker A supplied.
 * @param {object} item
 */
function validateDueItem(item) {
  if (!item || typeof item !== 'object') {
    throw new TypeError('due item must be an object');
  }
  const placementId = requireString(item.placementId, 'placementId');
  const provider = requireString(item.provider, 'provider');
  const accountScope = requireString(item.accountScope ?? 'default', 'accountScope');
  const infoHash = normalizeInfoHash(item.infoHash);
  const torrentFileId = requireString(item.torrentFileId, 'torrentFileId');
  return { placementId, provider: provider.toLowerCase(), accountScope: accountScope.toLowerCase(), infoHash, torrentFileId };
}

/**
 * Group an array of validated due items by (provider, accountScope).
 */
function groupByScope(items) {
  const groups = new Map();
  for (const entry of items) {
    const key = `${entry.provider}:${entry.accountScope}`;
    let group = groups.get(key);
    if (!group) {
      group = { provider: entry.provider, accountScope: entry.accountScope, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

/**
 * Index a snapshot's resources by infoHash and detect collisions.
 * Returns a Map<infoHash, Array<{providerResourceId}>>.
 */
function indexSnapshotByHash(snapshot) {
  const byHash = new Map();
  const resources = Array.isArray(snapshot?.resources) ? snapshot.resources : [];
  for (const resource of resources) {
    const infoHash = resource?.infoHash;
    if (!infoHash) continue;
    let bucket = byHash.get(infoHash);
    if (!bucket) {
      bucket = [];
      byHash.set(infoHash, bucket);
    }
    bucket.push({ providerResourceId: resource.providerResourceId });
  }
  return byHash;
}

/**
 * Classify a single placement against a snapshot index. Pure function.
 *
 *   - present:         snapshot contains exactly one resource for the hash
 *   - ambiguous:       snapshot contains 2+ resources for the hash
 *   - stale:           snapshot contains no resources for the hash
 */
function classifyPlacementAgainstIndex({ entry, index }) {
  const bucket = index.get(entry.infoHash);
  if (!bucket || bucket.length === 0) {
    return { state: 'stale', reason: 'no-snapshot-match' };
  }
  if (bucket.length > 1) {
    return { state: 'ambiguous', reason: `snapshot has ${bucket.length} resources for ${entry.infoHash}` };
  }
  return { state: 'present', providerResourceId: bucket[0].providerResourceId };
}

function itemOutcome(entry, outcome, extras = {}) {
  return Object.freeze({
    placementId: entry.placementId,
    provider: entry.provider,
    accountScope: entry.accountScope,
    infoHash: entry.infoHash,
    torrentFileId: entry.torrentFileId,
    outcome,
    ...extras,
  });
}

/**
 * Invoke the existing bounded same-TorrentFile repair seam exactly once for a
 * single STALE_CONFIRMED placement. Reuses the same store primitive
 * (`markPlacementRemoved`) and the same repair event recorder that the
 * on-demand `resolveTorBoxDeliveryWithStaleRecovery` path uses. The next
 * on-demand resolution will then re-enter the existing recreate-once path.
 *
 * @returns {Promise<{invoked: true, recorded: boolean, reason: string}>}
 */
async function invokeRepairSeamOnce({ store, entry, observedAt, now, reason, accounting }) {
  // Resolve the placement by (provider, infoHash) and confirm it matches the
  // placementId Worker A supplied. markPlacementRemoved operates on the
  // placement's primary id, so we cross-check rather than blindly trust
  // Worker A's id.
  const persisted = typeof store.findPlacementByInfoHash === 'function'
    ? store.findPlacementByInfoHash(entry.provider, entry.infoHash)
    : null;
  if (!persisted || persisted.id !== entry.placementId) {
    // Defensive: the placement is not where Worker A said it is. Skip rather
    // than invent state.
    return { invoked: false, recorded: false, reason: 'placement-not-found' };
  }
  if (persisted.state === 'removed') {
    return { invoked: false, recorded: true, reason: 'already-removed' };
  }
  const removed = typeof store.markPlacementRemoved === 'function'
    ? store.markPlacementRemoved(entry.placementId, { reason: 'stale-resource', observedAt })
    : null;
  if (removed) {
    const account = accounting ?? providerAccounting;
    account?.increment?.(entry.provider, 'background_repair_seam_invoke');
  }
  // Record a repair event for observability. This is the same recorder the
  // on-demand path uses, so the audit trail is consistent.
  recordRepairEvent(store, {
    failureCategory: REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_UNRECOVERABLE,
    infoHash: entry.infoHash,
    status: 'degraded',
    retryable: 0,
    reason: reason ?? 'background-durability-stale-confirmed',
    evidence: {
      provenance: REPAIR_PROVENANCE,
      placementId: entry.placementId,
      torrentFileId: entry.torrentFileId,
      provider: entry.provider,
      accountScope: entry.accountScope,
      observedAt,
    },
    observedAt,
    now,
  });
  return { invoked: true, recorded: true, reason: 'stale-resource' };
}

/**
 * Background durability executor factory.
 *
 * @param {Object} options
 * @param {Object} options.controlPlaneStore  - createControlPlaneStore instance
 * @param {Object} options.providerAdapters   - { [provider]: adapter } map
 * @param {Function} [options.now]            - clock
 * @param {Function} [options.providerAccounting] - inject accounting for tests
 * @param {Object}   [options.signals]        - optional { abort }
 */
export function createBackgroundDurabilityExecutor(options = {}) {
  const store = requireStore(options.controlPlaneStore);
  const adapters = options.providerAdapters && typeof options.providerAdapters === 'object'
    ? options.providerAdapters
    : {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const accounting = options.providerAccounting ?? providerAccounting;

  /**
   * Process a batch of due items from Worker A. Returns a per-item outcome
   * array plus per-scope summary records (backoff/transient/snapshot-call
   * count).
   *
   * @param {Array<object>} dueItems
   * @returns {Promise<{
   *   outcomes: Array<object>,
   *   scopes: Array<{
   *     provider: string,
   *     accountScope: string,
   *     backgroundSafe: boolean,
   *     itemsConsidered: number,
   *     snapshotCalls: number,
   *     backoff: boolean,
   *     backoffReason?: string,
   *     reason?: string,
   *   }>,
   *   onDemandOnly: Array<{placementId: string, reason: string}>,
   * }>}
   */
  async function runBatch(dueItems) {
    const items = Array.isArray(dueItems) ? dueItems : [];
    const validated = [];
    const onDemandOnly = [];

    // 1) Validate and pre-classify.
    for (const raw of items) {
      let entry;
      try {
        entry = validateDueItem(raw);
      } catch (error) {
        onDemandOnly.push({ placementId: raw?.placementId ?? null, reason: `invalid:${error.message}` });
        continue;
      }
      const klass = classifyProviderDurability(entry.provider);
      if (klass !== PROVIDER_DURABILITY_CLASS.BACKGROUND_SAFE) {
        onDemandOnly.push({
          placementId: entry.placementId,
          reason: `${entry.provider} has no batch snapshot seam; on-demand only`,
        });
        continue;
      }
      const adapter = adapters[entry.provider];
      const verdict = evaluateProviderForBackground(adapter);
      if (!verdict.eligible) {
        onDemandOnly.push({
          placementId: entry.placementId,
          reason: verdict.reason ?? 'provider-not-eligible',
        });
        continue;
      }
      validated.push(entry);
    }

    // 2) Group by (provider, accountScope) and evaluate each scope.
    const groups = groupByScope(validated);
    const outcomes = [];
    const scopeSummaries = [];

    for (const group of groups) {
      const summary = {
        provider: group.provider,
        accountScope: group.accountScope,
        backgroundSafe: true,
        itemsConsidered: group.entries.length,
        snapshotCalls: 0,
        backoff: false,
      };
      const adapter = adapters[group.provider];
      let snapshot = null;
      let snapshotError = null;
      const observedAt = now();
      try {
        summary.snapshotCalls = 1; // attempt registered before fetch so 429/transient also count
        const snapshotCapability = adapter.require(PROVIDER_CAPABILITIES.MYLIST_SNAPSHOT);
        snapshot = await snapshotCapability.getMylistSnapshot({});
        accounting?.increment?.(group.provider, 'background_snapshot_fetch');
      } catch (error) {
        snapshotError = error;
      }

      if (snapshotError) {
        if (isRateLimitError(snapshotError)) {
          summary.backoff = true;
          summary.backoffReason = 'rate-limited';
          accounting?.increment?.(group.provider, 'background_rate_limited');
          for (const entry of group.entries) {
            outcomes.push(itemOutcome(entry, BACKGROUND_OUTCOME.RATE_LIMITED, {
              observedAt,
              reason: snapshotError.message ?? 'rate-limited',
            }));
          }
          scopeSummaries.push(summary);
          continue;
        }
        if (isTransientError(snapshotError)) {
          summary.backoff = true;
          summary.backoffReason = 'transient';
          accounting?.increment?.(group.provider, 'background_transient');
          for (const entry of group.entries) {
            outcomes.push(itemOutcome(entry, BACKGROUND_OUTCOME.TRANSIENT, {
              observedAt,
              reason: snapshotError.message ?? 'transient',
            }));
          }
          scopeSummaries.push(summary);
          continue;
        }
        // Non-transient, non-rate-limit error: surface as TRANSIENT and let
        // Worker A's scheduler treat it as a transient outcome (never as
        // evidence of absence).
        summary.backoff = true;
        summary.backoffReason = 'snapshot-failed';
        accounting?.increment?.(group.provider, 'background_transient');
        for (const entry of group.entries) {
          outcomes.push(itemOutcome(entry, BACKGROUND_OUTCOME.TRANSIENT, {
            observedAt,
            reason: snapshotError.message ?? 'snapshot-failed',
          }));
        }
        scopeSummaries.push(summary);
        continue;
      }

      const index = indexSnapshotByHash(snapshot);
      const snapshotProviderResourceId = new Map();
      for (const [hash, bucket] of index.entries()) {
        if (bucket.length === 1) snapshotProviderResourceId.set(hash, bucket[0].providerResourceId);
      }

      // Placement rows we have already marked 'removed' inside this batch.
      // findPlacementByInfoHash deliberately filters out removed rows so the
      // on-demand delivery path can never reuse them; the background must
      // therefore remember the in-batch transition so a second due item for
      // the same (provider, infoHash) is still classified as STALE_CONFIRMED
      // and recorded as a repair event, even if it appears "absent" in the
      // post-mark-removed store view.
      const removedInBatch = new Set();

      for (const entry of group.entries) {
        // Cross-check: the persisted placement's provider_resource_id must
        // still match the snapshot's provider_resource_id. If it does not
        // (provider ID churned without state==removed), the placement is
        // ambiguous from the background's perspective and we fail-closed.
        const placement = typeof store.findPlacementByInfoHash === 'function'
          ? store.findPlacementByInfoHash(entry.provider, entry.infoHash)
          : null;
        if (!placement || placement.id !== entry.placementId) {
          if (removedInBatch.has(entry.placementId)) {
            // We marked this placement removed earlier in the same batch.
            // Treat it as STALE_CONFIRMED with repair-already-invoked; do
            // NOT re-enter the seam (bounded-once contract).
            outcomes.push(itemOutcome(entry, BACKGROUND_OUTCOME.STALE_CONFIRMED, {
              observedAt,
              reason: 'already-removed-in-batch',
              repairInvoked: false,
            }));
            continue;
          }
          outcomes.push(itemOutcome(entry, BACKGROUND_OUTCOME.NOT_FOUND, {
            observedAt,
            reason: 'placement-missing-in-control-plane',
          }));
          continue;
        }
        const persistedResourceId = placement.providerResourceId;
        const localResourceId = snapshotProviderResourceId.get(entry.infoHash) ?? null;
        if (localResourceId && persistedResourceId && localResourceId !== persistedResourceId) {
          outcomes.push(itemOutcome(entry, BACKGROUND_OUTCOME.AMBIGUOUS, {
            observedAt,
            reason: 'provider-resource-id-churned',
          }));
          accounting?.increment?.(entry.provider, 'background_ambiguous');
          continue;
        }
        const classification = classifyPlacementAgainstIndex({ entry, index });
        if (classification.state === 'present') {
          accounting?.increment?.(entry.provider, 'background_healthy');
          outcomes.push(itemOutcome(entry, BACKGROUND_OUTCOME.HEALTHY, {
            observedAt,
            providerResourceId: classification.providerResourceId,
          }));
          continue;
        }
        if (classification.state === 'ambiguous') {
          outcomes.push(itemOutcome(entry, BACKGROUND_OUTCOME.AMBIGUOUS, {
            observedAt,
            reason: classification.reason,
          }));
          accounting?.increment?.(entry.provider, 'background_ambiguous');
          continue;
        }
        // STALE_CONFIRMED: invoke the existing same-TorrentFile repair seam
        // exactly once. The seam uses the persisted placementId Worker A
        // supplied and the same store primitives as the on-demand path.
        const repair = await invokeRepairSeamOnce({
          store, entry, observedAt, now, accounting,
          reason: 'background-durability-stale-confirmed',
        });
        if (repair.invoked) {
          accounting?.increment?.(entry.provider, 'background_stale_confirmed');
          removedInBatch.add(entry.placementId);
        }
        outcomes.push(itemOutcome(entry, BACKGROUND_OUTCOME.STALE_CONFIRMED, {
          observedAt,
          reason: repair.reason,
          repairInvoked: repair.invoked === true,
        }));
      }
      scopeSummaries.push(summary);
    }

    return Object.freeze({
      outcomes: Object.freeze(outcomes),
      scopes: Object.freeze(scopeSummaries),
      onDemandOnly: Object.freeze(onDemandOnly),
    });
  }

  return Object.freeze({ runBatch });
}

export const _internal = Object.freeze({
  classifyPlacementAgainstIndex,
  indexSnapshotByHash,
  groupByScope,
  isRateLimitError,
  isTransientError,
  invokeRepairSeamOnce,
  validateDueItem,
});
