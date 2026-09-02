/**
 * Warm playback budget — canary assertion helper.
 *
 * Slice 2.8 — Provider work accounting.
 *
 * Encodes the warm-playback budget the task defines and exposes a
 * deterministic assertion function that compares a delta snapshot to
 * the budget. Used by the canary tooling and the new tests.
 *
 * Budget:
 *   For ALREADY-FULFILLED healthy media, a single playback session
 *   (open + close) must produce:
 *
 *     availability_checkcached: 0
 *     placement_lookup_mylist:  0
 *     placement_create:         0
 *     inventory_fetch:          0
 *     requestdl_resolution:    <=1 (only on cold-capability first read)
 *     requestdl_cache_hit:     >= requestdl_resolution (subsequent reads reuse)
 *     requestdl_rate_limited_429: 0
 *     requestdl_upstream_5xx:     0
 *
 *   Ten seeks must not produce ten requestdl resolutions. The ten
 *   subsequent reads must all be `requestdl_cache_hit` or
 *   `requestdl_single_flight_reuse`. The budget is per playback
 *   session, not per process.
 */

import { providerAccounting } from './provider-accounting.js';

export const WARM_PLAYBACK_BUDGET = Object.freeze({
  availability_checkcached: { max: 0 },
  placement_lookup_mylist: { max: 0 },
  placement_create: { max: 0 },
  inventory_fetch: { max: 0 },
  requestdl_resolution: { max: 1 },
  requestdl_rate_limited_429: { max: 0 },
  requestdl_upstream_5xx: { max: 0 },
  requestdl_capability_invalidate: { max: 0 },
});

/**
 * Assert that a delta snapshot respects the warm playback budget.
 *
 * @param {Object} delta  A snapshot returned by `providerAccounting.delta(before)`.
 * @param {Object} [budget]  Optional override of WARM_PLAYBACK_BUDGET.
 * @returns {{ ok: boolean, violations: Array<{category: string, actual: number, max: number}> }}
 */
export function assertWarmPlaybackBudget(delta, budget = WARM_PLAYBACK_BUDGET) {
  if (!delta || !delta.providers || !delta.providers.torbox) {
    return { ok: false, violations: [{ category: '<no torbox provider>', actual: 0, max: 0 }] };
  }
  const torbox = delta.providers.torbox.perCategory;
  const violations = [];
  for (const [category, rule] of Object.entries(budget)) {
    const actual = torbox[category] ?? 0;
    if (typeof rule.max === 'number' && actual > rule.max) {
      violations.push({ category, actual, max: rule.max });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Convenience: capture a baseline snapshot, run a callback, and return
 * the delta. The baseline is a value to pass into
 * `providerAccounting.delta()` so canary scripts do not need to know
 * the registry internals.
 */
export function captureBaseline() {
  return providerAccounting.snapshot();
}

export function computeDelta(baseline) {
  return providerAccounting.delta(baseline);
}
