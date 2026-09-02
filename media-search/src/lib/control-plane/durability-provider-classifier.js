/**
 * Background Durability V1 — provider safety classifier.
 *
 * The background durability executor (worker B) must NEVER poll
 * requestdl/Real-Debrid unrestricted URLs, add magnets, select files, create
 * placements speculatively, inventory-scan healthy items, rediscover, rerank,
 * or refresh Plex. It only validates that an existing persisted placement
 * still exists upstream. The safety contract is provider-dependent:
 *
 *   - BACKGROUND_SAFE  : one cheap authoritative provider/account-scope fetch
 *                        can validate multiple due placements in a single
 *                        call. Eligibility is decided solely by the provider
 *                        adapter's capability surface, not by live API state.
 *                        The TorBox mylist (per account) is the canonical
 *                        example: one snapshot answers every due placement.
 *
 *   - ON_DEMAND_ONLY   : no batch fetch is exposed. Per-infoHash work would
 *                        mean N provider calls for N due placements, which is
 *                        exactly the pattern background must not perform.
 *                        Real-Debrid's gateway is per-(infoHash, resourceId)
 *                        and is therefore on-demand only. These providers
 *                        are intentionally absent from the BACKGROUND_SAFE
 *                        set; the executor must refuse to schedule them.
 *
 * Classification is a pure function of the provider identifier. It does not
 * inspect the live API, does not call out, and does not branch on transient
 * state. The class is therefore:
 *   - deterministic
 *   - testable without a network
 *   - safe to log or audit as evidence
 *
 * Adding a new BACKGROUND_SAFE provider requires a new capability entry
 * (PROVIDER_CAPABILITIES.MYLIST_SNAPSHOT) and an adapter that implements it.
 * Misclassifying a provider is a fail-closed: the executor treats the item as
 * ON_DEMAND_ONLY and refuses to do background work for it.
 */

import { PROVIDER_CAPABILITIES } from '../providers/capabilities.js';

export const PROVIDER_DURABILITY_CLASS = Object.freeze({
  BACKGROUND_SAFE: 'background-safe',
  ON_DEMAND_ONLY: 'on-demand-only',
});

const BACKGROUND_SAFE_PROVIDERS = Object.freeze(new Set(['torbox']));

/**
 * Classify a single provider identifier. Pure function; no side effects.
 *
 * @param {string} provider - Provider identifier (e.g. 'torbox', 'realdebrid')
 * @returns {'background-safe'|'on-demand-only'}
 */
export function classifyProviderDurability(provider) {
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    return PROVIDER_DURABILITY_CLASS.ON_DEMAND_ONLY;
  }
  const normalized = provider.trim().toLowerCase();
  if (BACKGROUND_SAFE_PROVIDERS.has(normalized)) {
    return PROVIDER_DURABILITY_CLASS.BACKGROUND_SAFE;
  }
  return PROVIDER_DURABILITY_CLASS.ON_DEMAND_ONLY;
}

/**
 * Decide whether a provider adapter is eligible for the background durability
 * executor. The adapter must both be classified BACKGROUND_SAFE and expose the
 * MYLIST_SNAPSHOT capability. Either gate failing yields a structured refusal
 * so callers (and tests) can branch on the cause.
 *
 * @param {Object} providerAdapter - A provider adapter created by
 *   createProviderAdapter.
 * @returns {{
 *   eligible: boolean,
 *   class: 'background-safe'|'on-demand-only',
 *   reason?: string,
 * }}
 */
export function evaluateProviderForBackground(providerAdapter) {
  if (!providerAdapter || typeof providerAdapter !== 'object') {
    return {
      eligible: false,
      class: PROVIDER_DURABILITY_CLASS.ON_DEMAND_ONLY,
      reason: 'provider adapter is missing',
    };
  }
  const provider = String(providerAdapter.provider ?? '').trim().toLowerCase();
  const klass = classifyProviderDurability(provider);
  if (klass !== PROVIDER_DURABILITY_CLASS.BACKGROUND_SAFE) {
    return {
      eligible: false,
      class: klass,
      reason: `${provider || 'unknown'} has no batch snapshot seam; on-demand only`,
    };
  }
  if (typeof providerAdapter.supports === 'function'
    && providerAdapter.supports(PROVIDER_CAPABILITIES.MYLIST_SNAPSHOT) !== true) {
    return {
      eligible: false,
      class: klass,
      reason: `${provider} is classified background-safe but the adapter does not expose MYLIST_SNAPSHOT`,
    };
  }
  return { eligible: true, class: klass };
}

/**
 * Partition a list of due items by durability class. Each item is expected to
 * carry a `provider` field. Items that are not eligible for background work
 * are returned separately so the caller (worker A or a parent orchestrator)
 * can reschedule or route them.
 *
 * @param {Iterable<{provider: string}>} dueItems
 * @returns {{
 *   backgroundSafe: Array<{item: object, provider: string, class: 'background-safe'}>,
 *   onDemandOnly: Array<{item: object, provider: string, class: 'on-demand-only', reason: string}>,
 * }}
 */
export function partitionDueItemsByClass(dueItems) {
  const backgroundSafe = [];
  const onDemandOnly = [];
  if (dueItems == null) return { backgroundSafe, onDemandOnly };
  for (const item of dueItems) {
    const provider = String(item?.provider ?? '').trim().toLowerCase();
    const klass = classifyProviderDurability(provider);
    if (klass === PROVIDER_DURABILITY_CLASS.BACKGROUND_SAFE) {
      backgroundSafe.push({ item, provider, class: klass });
    } else {
      onDemandOnly.push({
        item, provider, class: klass,
        reason: `${provider || 'unknown'} has no batch snapshot seam; on-demand only`,
      });
    }
  }
  return { backgroundSafe, onDemandOnly };
}
