/**
 * Intent quality profiles (quality-profile tranche).
 *
 * Three named policies bounding selection and autonomous upgrades —
 * not a DSL. Profiles answer "what quality is good enough for THIS
 * intent" using the existing tier ladder (upgrade-policy.js):
 *
 *   balanced (default) — today's behavior exactly: no selection cap,
 *     upgrades run to the global terminal (Remux 2160p), durability
 *     veto at marginal deltas (<10 tiers).
 *   hd — 1080p-class is terminal: initial selection never takes
 *     anything above BluRay-1080p class, upgrades park there. Same
 *     veto as balanced.
 *   max — terminal equals balanced, but the durability veto never
 *     fires: accept fragility for quality. Byte-readiness still gates
 *     every switch (unservable never replaces healthy).
 *
 * Unknown profile names are rejected by normalizeQualityProfile
 * (never silently reinterpreted). Omitted profile = no constraint
 * anywhere (ranker, row, and loop behave exactly as before).
 */
import { TERMINAL_TIER, VETO_MAX_TIER_DELTA } from './upgrade-policy.js';

export const QUALITY_PROFILES = Object.freeze({
  balanced: Object.freeze({ terminalTier: TERMINAL_TIER, maxTier: null, vetoDelta: VETO_MAX_TIER_DELTA }),
  hd: Object.freeze({ terminalTier: 42, maxTier: 42, vetoDelta: VETO_MAX_TIER_DELTA }),
  max: Object.freeze({ terminalTier: TERMINAL_TIER, maxTier: null, vetoDelta: 0 }),
});

export const DEFAULT_QUALITY_PROFILE = 'balanced';

export function normalizeQualityProfile(value) {
  if (value == null || value === '') return { ok: true, profile: null };
  const name = String(value).trim().toLowerCase();
  if (Object.hasOwn(QUALITY_PROFILES, name)) return { ok: true, profile: name };
  return {
    ok: false,
    error: `unknown qualityProfile '${String(value).slice(0, 40)}' (expected one of: ${Object.keys(QUALITY_PROFILES).join(', ')})`,
  };
}

export function profilePolicy(name) {
  if (name == null) return QUALITY_PROFILES[DEFAULT_QUALITY_PROFILE];
  return QUALITY_PROFILES[name] ?? QUALITY_PROFILES[DEFAULT_QUALITY_PROFILE];
}

/** Selection cap for a profile (null = uncapped, today's behavior). */
export function selectionMaxTier(name) {
  if (name == null) return null;
  return profilePolicy(name).maxTier;
}
