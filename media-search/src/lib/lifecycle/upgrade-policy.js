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

/**
 * Durability confidence (durability tranche): will this release still
 * be obtainable later, not just servable now? Derived ONLY from signals
 * with observed variance in this deployment:
 * - provider cache state / household placement (strong, fresh)
 * - sighting history spread first_seen..last_seen (medium)
 * Seeders, multi-source counts, and dual-provider placement are wired
 * as inputs but currently carry no data here (0 seeder rows, single
 * source per result, one RD placement) — they contribute nothing today
 * and activate automatically if those sources ever flow.
 */
export const DURABILITY = Object.freeze({
  STRONG: 'strong',
  MEDIUM: 'medium',
  FRAGILE: 'fragile',
});

export const VETO_MAX_TIER_DELTA = 10;

export function durabilityOf({
  cacheState = null, placement = false,
  firstSeen = null, lastSeen = null, sourceCount = 1, seeders = null,
  nowMs = Date.now(),
} = {}) {
  const reasons = [];
  const cached = cacheState === 'cached';
  if (cached) reasons.push('cached-now');
  if (placement) reasons.push('household-placement');
  if (cached || placement) return { level: DURABILITY.STRONG, reasons };
  if (seeders != null && seeders >= 100) return { level: DURABILITY.STRONG, reasons: ['deep-swarm'] };
  const medium = [];
  if (seeders != null && seeders >= 20) medium.push('healthy-swarm');
  if (firstSeen != null && lastSeen != null && (lastSeen - firstSeen) >= 7 * 86400 * 1000) {
    medium.push('seen-across-weeks');
  }
  if ((sourceCount | 0) >= 2) medium.push('multi-source');
  if (medium.length > 0) return { level: DURABILITY.MEDIUM, reasons: medium };
  const why = [];
  if (cacheState === 'uncached') why.push('uncached');
  if (firstSeen == null) why.push('never-sighted');
  else if ((nowMs - lastSeen) >= 0 && (lastSeen - firstSeen) < 7 * 86400 * 1000) why.push('fresh-single-sighting');
  if ((sourceCount | 0) < 2) why.push('single-source');
  return { level: DURABILITY.FRAGILE, reasons: why.length > 0 ? why : ['no-durability-evidence'] };
}

/**
 * Veto rule: a fragile winner replaces a strong current ONLY on a
 * large quality jump (CAM-era → home quality and the like). Marginal
 * improvements (same band, resolution-only bumps) require
 * equal-or-better durability — they park until the winner proves
 * itself (cached, placed, or seen over time). Null delta (unknown
 * current tier) never vetoes: the upgrade floor already gated it.
 */
export function shouldVetoUpgrade({ currentDur = null, winnerDur = null, tierDelta = null } = {}) {
  if (tierDelta == null) return { veto: false, reason: 'unknown-delta' };
  if (tierDelta < VETO_MAX_TIER_DELTA
    && winnerDur === DURABILITY.FRAGILE && currentDur === DURABILITY.STRONG) {
    return { veto: true, reason: 'fragile-winner-vs-durable-current' };
  }
  return { veto: false, reason: 'durability-ok' };
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
