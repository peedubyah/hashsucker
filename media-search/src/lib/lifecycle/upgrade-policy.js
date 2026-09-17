/**
 * Quality-tier upgrade policy (quality-upgrade tranche).
 *
 * Pure functions over the pipeline's EXISTING parsed quality truth
 * (release_attributes.source_type/resolution/hdr — same vocabulary as
 * the ranker and the anticipation quality floor). No second parser, no
 * second model: this module only ORDERS what the pipeline already
 * extracts so the upgrade loop can distinguish a meaningful
 * quality-class improvement from lateral churn.
 *
 * Tier = class base + resolution step. HDR/DV never moves the tier
 * (tie-break only, honored by the ranker at selection time).
 *
 * Upgrade rule (conservative by design):
 * - target tier unknown        → never (cannot prove improvement)
 * - current unknown            → only to clearly-home quality (>= 30)
 * - target > current           → upgrade
 * - target == current          → same-tier, never churn
 * - target < current           → downgrade, refused
 */
export const UPGRADE_FLOOR_FROM_UNKNOWN = 30;
export const TERMINAL_TIER = 53;

const CLASS_BASE = [
  { base: 50, tokens: ['remux', 'bdremux'] },
  { base: 40, tokens: ['bluray', 'blu-ray', 'bdrip', 'brrip'] },
  { base: 30, tokens: ['webdl', 'web-dl', 'web'] },
  { base: 25, tokens: ['webrip'] },
  { base: 20, tokens: ['hdtv', 'hdtvrip'] },
  // Hygiene markers (Proper/Repack/RERiP/Internal) describe release
  // correctness, not class: halfway between SD and HD, never terminal.
  { base: 15, tokens: ['proper', 'repack', 'rerip', 'rerepack', 'internal'] },
  { base: 10, tokens: ['dvd', 'dvdrip', 'tvrip', 'pdtv', 'dsrip', 'vhs', 'satrip', 'dthrip'] },
  { base: 0, tokens: ['cam', 'tcam', 'ts', 'tc', 'telesync', 'telecine', 'scr', 'screener', 'dvdscr', 'r5', 'camrip', 'hdcam'] },
];

function normToken(v) {
  return String(v ?? '').trim().toLowerCase().replace(/[\s._]+/g, '-');
}

function classBase(sourceType) {
  const t = normToken(sourceType);
  if (!t) return null;
  for (const { base, tokens } of CLASS_BASE) {
    if (tokens.includes(t) || tokens.includes(t.replace(/-/g, ''))) return base;
  }
  return null;
}

function resolutionStep(resolution) {
  const r = String(resolution ?? '').trim().toLowerCase();
  if (!r) return 0;
  if (/8k|4320p/.test(r)) return 4;
  if (/2160p|4k|uhd/.test(r)) return 3;
  if (/1080p|1080i|fhd/.test(r)) return 2;
  if (/720p|hd(?!tv)/.test(r)) return 1;
  return 0;
}

/**
 * Tier for parsed attributes. Returns { tier, label } with tier null
 * when the source class is unrecognized (resolution alone never
 * implies class — an unknown 1080p is not provably better than
 * anything, see the from-unknown floor in compareUpgrade).
 */
export function tierOf({ sourceType = null, resolution = null, hdr = null } = {}) {
  const base = classBase(sourceType);
  if (base == null) {
    return { tier: null, label: `unknown${resolution ? `/${resolution}` : ''}`, hdr: hdr ?? null };
  }
  // Capture classes are tier 0 regardless of claimed resolution.
  const step = base === 0 ? 0 : resolutionStep(resolution);
  const tier = base + step;
  const label = `${normToken(sourceType)}${resolution ? `/${String(resolution).trim()}` : ''}`;
  return { tier, label, hdr: hdr ?? null };
}

export function isTerminalTier(tier) {
  return tier != null && tier >= TERMINAL_TIER;
}

export function compareUpgrade(current, candidate) {
  const c = current?.tier ?? null;
  const n = candidate?.tier ?? null;
  if (n == null) return { upgrade: false, reason: 'candidate-tier-unknown' };
  if (c == null) {
    return n >= UPGRADE_FLOOR_FROM_UNKNOWN
      ? { upgrade: true, reason: `unknown-to-home-quality (${candidate.label})` }
      : { upgrade: false, reason: 'below-upgrade-floor' };
  }
  if (n > c) return { upgrade: true, reason: `tier-up ${c}->${n} (${current.label} -> ${candidate.label})` };
  if (n === c) return { upgrade: false, reason: 'same-tier' };
  return { upgrade: false, reason: 'downgrade' };
}
