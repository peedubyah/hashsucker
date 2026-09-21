/**
 * Durable request-intent policy (intent tranche).
 *
 * The request tells HashSucker what outcome the human wants, not how to
 * execute it. Three named library intents plus the download endpoint:
 *
 *   library   — permanent publication, normal upgrades, no retirement.
 *   watch     — temporary publication (default 7d TTL, ttlHours override),
 *               consumption-aware retirement, no upgrade chasing.
 *   immediate — permanent publication (no retirement) but no upgrade
 *               chasing either: best viable release now, then hold.
 *   download  — not a library intent; the /download-request endpoint IS
 *               the intent (stage for importer, no publication lifecycle).
 *
 * Compatibility: omitted intent preserves legacy behavior exactly
 * (temporary flag → watch, otherwise library). Explicit intent overrides
 * the legacy booleans. Unknown names are a clear 400, never silent.
 * Requestrr/Seerr/Arr payloads (no intent field) behave exactly as before.
 */
export const INTENTS = Object.freeze(['library', 'watch', 'immediate']);

export const DEFAULT_TEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeRequestIntent(body) {
  const raw = body?.intent;
  if (raw == null || raw === '') {
    // Legacy shape: the temporary flag selects watch, absence selects library.
    if (body?.temporary === true) {
      return { ok: true, intent: 'watch', fromLegacy: true };
    }
    return { ok: true, intent: 'library', fromLegacy: true };
  }
  const name = String(raw).trim().toLowerCase();
  if (name === 'download') {
    return {
      ok: false,
      error: "intent 'download' belongs on POST /api/download-request (this endpoint publishes to the library)",
    };
  }
  if (!INTENTS.includes(name)) {
    return {
      ok: false,
      error: `unknown intent '${String(raw).slice(0, 40)}' (expected one of: ${INTENTS.join(', ')})`,
    };
  }
  return { ok: true, intent: name, fromLegacy: false };
}

/** TTL for a watch intent: explicit ttlHours wins, else the 7d default. */
export function intentTtlMs(body, defaultMs = DEFAULT_TEMP_TTL_MS) {
  const ttlHours = Number(body?.ttlHours);
  if (Number.isFinite(ttlHours) && ttlHours > 0) return ttlHours * 3600 * 1000;
  return defaultMs;
}

/** Upgrade chasing applies unless the intent says otherwise. */
export function upgradesAllowed(item) {
  const mode = item?.publicationMode ?? item?.publication_mode ?? 'permanent';
  if (mode === 'temporary') return false;
  const policy = item?.upgradePolicy ?? item?.upgrade_policy ?? 'auto';
  return policy !== 'off';
}

/** Intent label for display (TUI/web), derived from durable columns. */
export function displayIntent(item) {
  const mode = item?.publicationMode ?? item?.publication_mode ?? 'permanent';
  if (mode === 'temporary') return 'watch';
  const policy = item?.upgradePolicy ?? item?.upgrade_policy ?? 'auto';
  if (policy !== 'auto') return 'immediate';
  return item?.intent ?? item?.intent_name ?? 'library';
}
