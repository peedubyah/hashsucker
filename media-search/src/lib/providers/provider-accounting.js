/**
 * Provider Accounting Registry — bounded, secret-free, in-process.
 *
 * Slice 2.8 — Provider work accounting exposure.
 *
 * Purpose:
 *   Aggregate per-event provider work into a single, stable operator/debug
 *   surface so a canary can assert the warm-playback budget and prove that
 *   ten seeks do not multiply into ten requestdl resolutions.
 *
 * Design:
 *   - Process-wide singleton. The aggregate counter survives across
 *     requests, playback sessions, canary runs, and operator inspections.
 *   - Bounded in-process. No external services. No persistence. No log
 *     output of the counter values.
 *   - secret-free: counter values only. Never record the API key, the
 *     resolved requestdl URL, the authorization header, the magnet, the
 *     torrent file payload, the control-plane row id, or any other
 *     sensitive payload.
 *   - `reset()` returns the registry to zero. No process restart required.
 *
 * Categories (all grouped by provider, default 'torbox'):
 *   - availability_checkcached       (GET /torrents/checkcached)
 *   - placement_lookup_mylist        (GET /torrents/mylist for placement lookup)
 *   - placement_create               (POST /torrents/createtorrent)
 *   - inventory_fetch                (GET /torrents/mylist for file inventory)
 *   - requestdl_resolution           (GET /torrents/requestdl)
 *   - requestdl_cache_hit            (capability cache hit, no upstream call)
 *   - requestdl_single_flight_reuse  (capability inflight reused, no second upstream)
 *   - requestdl_capability_invalidate (explicit 401/403/404 from upstream)
 *   - requestdl_capability_expired   (capability_expired event)
 *   - requestdl_preserved_after_cancel (client cancelled, capability NOT invalidated)
 *   - requestdl_rate_limited_429     (upstream 429)
 *   - requestdl_upstream_5xx         (upstream 5xx)
 *   - requestdl_retry                (retry attempt by requestdl resolver)
 *   - upstream_retry                 (retry attempt by the call coordinator)
 *   - provider_error_other           (other classified provider errors)
 *
 * Use:
 *   import { providerAccounting } from './provider-accounting.js';
 *   providerAccounting.increment('torbox', 'requestdl_resolution');
 *   const snap = providerAccounting.snapshot();
 *   const delta = providerAccounting.delta(snap);
 *   providerAccounting.reset();
 */

const CATEGORIES = Object.freeze([
  'availability_checkcached',
  'placement_lookup_mylist',
  'placement_create',
  'inventory_fetch',
  'requestdl_resolution',
  'requestdl_cache_hit',
  'requestdl_single_flight_reuse',
  'requestdl_capability_invalidate',
  'requestdl_capability_expired',
  'requestdl_preserved_after_cancel',
  'requestdl_rate_limited_429',
  'requestdl_upstream_5xx',
  'requestdl_retry',
  'upstream_retry',
  'provider_error_other',
  // Background Durability V1 (Worker B): read-only mylist snapshot evaluation
  // and existing-repair seam invoke. These are provider-accounted because the
  // background path shares the same TorBox upstream budget and may surface
  // in the same canary / rate-limit panels as on-demand accounting.
  'background_snapshot_fetch',
  'background_healthy',
  'background_stale_confirmed',
  'background_ambiguous',
  'background_transient',
  'background_rate_limited',
  'background_repair_seam_invoke',
  // Real-Debrid same-TorrentFile fallback (Worker B). These are
  // provider-accounted under the 'realdebrid' bucket so the canary
  // can assert the RD fallback is observably narrow and never
  // mutates VFS/TorrentFile identity.
  // - realdebrid_fallback_attempted: attemptRdResolution entry
  // - realdebrid_fallback_resolved: attemptRdResolution returned status='resolved'
  // - realdebrid_fallback_failed:   attemptRdResolution returned status='failed' or 'skipped'
  // - realdebrid_file_match:        mapCandidateToRdFile returned exactly one RD file id
  // - realdebrid_file_ambiguous:    mapCandidateToRdFile returned null with multiple size matches
  // - realdebrid_file_absent:       mapCandidateToRdFile returned null with zero size matches
  'realdebrid_fallback_attempted',
  'realdebrid_fallback_resolved',
  'realdebrid_fallback_failed',
  'realdebrid_file_match',
  'realdebrid_file_ambiguous',
  'realdebrid_file_absent',
]);

const CATEGORY_SET = new Set(CATEGORIES);

const PROVIDERS = Object.freeze(['torbox', 'realdebrid', 'other']);

function emptyProvider(provider) {
  const perCategory = {};
  for (const cat of CATEGORIES) perCategory[cat] = 0;
  return Object.freeze({
    provider,
    perCategory: Object.freeze(perCategory),
  });
}

function emptySnapshot() {
  const providers = {};
  for (const p of PROVIDERS) providers[p] = emptyProvider(p);
  return Object.freeze({
    timestamp: Date.now(),
    providers: Object.freeze(providers),
  });
}

function safeCopy(snapshot) {
  // Defensive: callers may hold a frozen snapshot but we re-emit a new
  // mutable per-provider object so canaries can re-format without
  // mutating the canonical state. Counters are integers.
  const providers = {};
  for (const provider of PROVIDERS) {
    const src = snapshot.providers[provider];
    const perCategory = {};
    for (const cat of CATEGORIES) perCategory[cat] = src.perCategory[cat];
    providers[provider] = Object.freeze({
      provider,
      perCategory: Object.freeze(perCategory),
    });
  }
  return Object.freeze({
    timestamp: snapshot.timestamp,
    providers: Object.freeze(providers),
  });
}

class ProviderAccounting {
  constructor() {
    this._state = emptySnapshot();
  }

  /**
   * Increment one (provider, category) counter by 1. Unknown providers are
   * bucketed under 'other'. Unknown categories throw so we never silently
   * lose a counter due to typo.
   */
  increment(provider, category, by = 1) {
    if (!Number.isInteger(by) || by < 0) {
      throw new TypeError('increment by must be a non-negative integer');
    }
    const normalizedProvider = PROVIDERS.includes(provider) ? provider : 'other';
    if (!CATEGORY_SET.has(category)) {
      throw new TypeError(`Unknown provider-accounting category: ${category}`);
    }
    const current = this._state.providers[normalizedProvider].perCategory[category];
    if (current === undefined) {
      // Defensive: the perCategory map is frozen, so we must rebuild.
      const next = {};
      for (const cat of CATEGORIES) {
        const src = this._state.providers[normalizedProvider].perCategory;
        next[cat] = cat === category ? by : (src[cat] || 0);
      }
      this._replaceProvider(normalizedProvider, next);
      return;
    }
    const next = { ...this._state.providers[normalizedProvider].perCategory };
    next[category] = current + by;
    this._replaceProvider(normalizedProvider, next);
  }

  _replaceProvider(provider, perCategory) {
    const providers = { ...this._state.providers };
    providers[provider] = Object.freeze({
      provider,
      perCategory: Object.freeze(perCategory),
    });
    this._state = Object.freeze({
      timestamp: Date.now(),
      providers: Object.freeze(providers),
    });
  }

  /**
   * Read-only snapshot. Always includes every known (provider, category)
   * pair, even when zero, so canary assertions are stable.
   */
  snapshot() {
    return safeCopy(this._state);
  }

  /**
   * Compute the per-category delta between `current` and `before`.
   *   delta = current - before
   * Negative deltas are clamped to zero (counters are monotonically
   * non-decreasing except across `reset()`).
   */
  delta(before) {
    if (!before || typeof before !== 'object') {
      throw new TypeError('delta requires a prior snapshot');
    }
    const beforeByProvider = before.providers || {};
    const providers = {};
    for (const provider of PROVIDERS) {
      const perCategory = {};
      const beforeCat = (beforeByProvider[provider]?.perCategory) || {};
      const currentCat = this._state.providers[provider].perCategory;
      for (const cat of CATEGORIES) {
        const b = Number.isInteger(beforeCat[cat]) ? beforeCat[cat] : 0;
        const c = currentCat[cat];
        perCategory[cat] = Math.max(0, c - b);
      }
      providers[provider] = Object.freeze({
        provider,
        perCategory: Object.freeze(perCategory),
      });
    }
    return Object.freeze({
      timestamp: this._state.timestamp,
      providers: Object.freeze(providers),
    });
  }

  /**
   * Zero the registry. Returns the previous snapshot (for caller-side
   * assertion bookkeeping) and re-buckets the timestamp to now.
   */
  reset() {
    const previous = safeCopy(this._state);
    this._state = emptySnapshot();
    return previous;
  }

  /**
   * Returns the canonical category list. Operators may want this when
   * rendering the registry.
   */
  categories() {
    return CATEGORIES.slice();
  }

  providers() {
    return PROVIDERS.slice();
  }
}

// Module-level singleton. Every import in the process shares the same
// accounting state. Tests that need isolation can call `.reset()` in
// setup/teardown.
export const providerAccounting = new ProviderAccounting();

export const PROVIDER_ACCOUNTING_CATEGORIES = CATEGORIES;
export const PROVIDER_ACCOUNTING_PROVIDERS = PROVIDERS;

/**
 * Format a snapshot for terminal/canary output. The output is
 * intentionally compact and secret-free. It exposes ONLY category names
 * and integer counters. No URLs, no hashes, no provider ids.
 *
 * @param {Object} snapshot
 * @param {Object} [options]
 * @param {string} [options.title]  e.g. "TorBox delta"
 * @param {string} [options.provider='torbox']
 */
export function formatProviderAccounting(snapshot, { title, provider = 'torbox' } = {}) {
  if (!snapshot || !snapshot.providers || !snapshot.providers[provider]) {
    return `${title || 'Provider Accounting'}:\n  (no data)\n`;
  }
  const block = snapshot.providers[provider];
  const lines = [];
  lines.push(`${title || `${provider} accounting`}:`);
  for (const cat of CATEGORIES) {
    const value = block.perCategory[cat] ?? 0;
    // Skip zero lines to keep reports tight, but always include the
    // explicit categories listed in the task budget so the report reads
    // consistently.
    const alwaysRender = [
      'availability_checkcached',
      'placement_lookup_mylist',
      'placement_create',
      'inventory_fetch',
      'requestdl_resolution',
      'requestdl_rate_limited_429',
      'realdebrid_fallback_attempted',
      'realdebrid_fallback_resolved',
      'realdebrid_fallback_failed',
      'realdebrid_file_match',
      'realdebrid_file_ambiguous',
      'realdebrid_file_absent',
    ];
    if (value === 0 && !alwaysRender.includes(cat)) continue;
    const label = cat.replaceAll('_', ' ');
    lines.push(`  ${label}: ${value}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Secret-stripping guard. The accounting registry never holds secrets,
 * but operators may want to assert this property on a returned object.
 * Returns `true` if the input contains only primitives and integers,
 * false otherwise.
 */
export function isSecretFreeAccountingValue(value) {
  if (value == null) return true;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (typeof value === 'string') {
    // Counter labels are bounded identifiers. If the string contains
    // anything other than [a-z0-9_] we treat it as suspicious.
    return /^[a-z0-9_]{0,64}$/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.every(isSecretFreeAccountingValue);
  }
  if (typeof value === 'object') {
    return Object.values(value).every(isSecretFreeAccountingValue);
  }
  return false;
}
