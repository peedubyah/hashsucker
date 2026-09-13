/**
 * Environment numeric parsing (anticipation policy hardening tranche).
 *
 * Compose files commonly inject `${VAR:-}`, which arrives as an EMPTY
 * STRING when the operator leaves the variable unset — and
 * `Number('')` is 0, silently converting "use the default" into an
 * explicit zero. This helper makes blank mean unset:
 *
 *   absent / null / undefined → fallback
 *   '' / whitespace-only      → fallback
 *   non-numeric               → fallback
 *   below min                 → fallback
 *   explicit "0"              → 0, but only when min <= 0 (zero must be
 *                               a supported value to survive)
 *   valid number >= min       → the number
 */

export function envNumber(env, key, { fallback, min = -Infinity } = {}) {
  if (fallback == null || !Number.isFinite(fallback)) {
    throw new Error('envNumber requires a finite fallback');
  }
  const raw = env?.[key];
  if (raw == null) return fallback;
  const text = String(raw).trim();
  if (text === '') return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}
