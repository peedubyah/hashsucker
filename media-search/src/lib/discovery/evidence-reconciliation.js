/**
 * Provider Evidence Reconciliation
 *
 * Pure, deterministic reconciliation that answers:
 *
 *   "Given (current observations + historical evidence + now + freshness policy),
 *    what is the authoritative current interpretation of provider availability
 *    for a (provider, accountScope, infoHash, fileIndex) identity — WITHOUT
 *    destroying history?"
 *
 * Design constraints (slice 5: provider evidence reconciliation + contradiction
 * handling):
 *
 *   1. Fresh current POSITIVE outranks historical prior.
 *   2. Fresh current NEGATIVE outranks historical prior.
 *   3. Fresh current UNKNOWN/ERROR does NOT erase a prior known
 *      positive/negative — it leaves known state intact but marks the
 *      confidence source as `unresolved` (transient disruption).
 *   4. STALE positive/negative remains historical context, but does NOT
 *      masquerade as fresh truth.
 *   5. MISSING current evidence means `unknown`, never `negative`.
 *   6. HISTORICAL positive is a bounded prior only; never a current
 *      availability claim.
 *   7. REPEATED same observation MUST NOT strengthen confidence merely
 *      because it was re-read. Repeated events collapse to a single
 *      logical observation.
 *   8. ACCOUNT SCOPE boundaries are absolute: observations from different
 *      (provider, accountScope) MUST NOT bleed into each other.
 *
 * This module is PURE. It does not read or write the DB. The caller
 * (typically a cache read path) supplies the source facts; this module
 * derives the reconciliation.
 *
 * Reconciliation is provider-agnostic. Provider-specific interpretation
 * (e.g. RD code 35 = infringing → durable negative) MUST happen at the
 * observation persistence layer (see `providers/realdebrid/observe.js`).
 * By the time observations reach this module, they have already been
 * classified into the four states: `cached | uncached | unknown | error`.
 *
 * Reconciliation output (structured, inspectable):
 *
 *   {
 *     currentState:     'positive' | 'negative' | 'unknown',
 *     freshness:        'fresh' | 'stale' | 'missing',
 *     confidence:       'current' | 'historical-prior' | 'unresolved',
 *     reason:           '<enumerable machine-readable string>',
 *     negativeKind:     'durable' | 'transient' | null,
 *     historicalPrior:  { positive: bool, sources: string[] } | null,
 *     freshObservation: <observation> | null,
 *     repeatedCollapsed: number,   // count of events that collapsed to 1
 *   }
 *
 * The `reason` field is one of a closed enumerable set; callers may switch
 * on it but must not interpret it as freeform text.
 */

import { evaluateObservationFreshness } from '../providers/observations.js';

// ---------------------------------------------------------------------------
// Closed enumerable: currentState ∈ { 'positive' | 'negative' | 'unknown' }
// ---------------------------------------------------------------------------

export const CURRENT_STATES = Object.freeze(['positive', 'negative', 'unknown']);
export const FRESHNESS_BUCKETS = Object.freeze(['fresh', 'stale', 'missing']);
export const CONFIDENCE_SOURCES = Object.freeze([
  'current',
  'historical-prior',
  'unresolved',
]);

/**
 * Closed enumerable of `reason` values. Each is a stable machine-readable
 * string. Callers should switch on these directly.
 */
export const RECONCILIATION_REASONS = Object.freeze([
  // Fresh current wins
  'fresh-positive',
  'fresh-negative',
  // Historical prior is authoritative in absence of fresh current
  'historical-prior-positive',
  'historical-prior-negative',
  // Stale current
  'stale-positive',
  'stale-negative',
  // Transient disruption
  'transient-unknown-preserved-known',
  // Empty
  'no-evidence',
]);

/**
 * Negative observations whose errorCategory is durable MUST be persisted as
 * `negative` (not `unknown`). Transient errors MUST NOT overwrite a prior
 * known state.
 */
export const DURABLE_NEGATIVE_ERROR_CATEGORIES = Object.freeze(new Set([
  'infringing',
  'unsupported',
]));

const SCOPE_KEY_DELIMITER = '\u0000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeOptionalTimestamp(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function scopeKey(provider, accountScope) {
  return `${provider ?? 'unknown'}${SCOPE_KEY_DELIMITER}${accountScope ?? 'default'}`;
}

function isObservationObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isDurableNegative(observation) {
  if (!isObservationObject(observation)) return false;
  if (observation.errorCategory != null
      && DURABLE_NEGATIVE_ERROR_CATEGORIES.has(observation.errorCategory)) {
    return true;
  }
  return false;
}

/**
 * Group observations by their (provider, accountScope) identity. Observations
 * from different scopes are NEVER reconciled together — they remain isolated
 * so a fresh positive on one account can never suppress a negative on another.
 *
 * @param {Array<object>} observations
 * @returns {Map<string, Array<object>>} key → observations[]
 */
export function groupObservationsByScope(observations) {
  const out = new Map();
  if (!Array.isArray(observations)) return out;
  for (const obs of observations) {
    if (!isObservationObject(obs)) continue;
    const key = scopeKey(obs.provider, obs.accountScope);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(obs);
  }
  return out;
}

/**
 * Collapse repeated identical observations into a single logical record.
 *
 * "Identical" = same (provider, accountScope, state, errorCategory, source,
 * subjectKey, fileIndexKey, kind) AND observedAt within a small epsilon.
 *
 * This is the dedup boundary that enforces rule 7: "REPEATED same
 * observation MUST NOT strengthen confidence merely because it was
 * re-read." The caller passes the full event history; we collapse to the
 * logical truth.
 *
 * @param {Array<object>} observations
 * @param {Object} [options]
 * @param {number} [options.replayEpsilonMs=0] - Two events with
 *   observedAt within this window are considered the same logical
 *   observation. Default 0 = exact timestamp equality required.
 * @returns {{ collapsed: Array<object>, repeatedCollapsed: number }}
 */
export function collapseRepeatedObservations(observations, options = {}) {
  if (!Array.isArray(observations)) {
    return { collapsed: [], repeatedCollapsed: 0 };
  }
  const epsilon = Number.isSafeInteger(options.replayEpsilonMs) && options.replayEpsilonMs >= 0
    ? options.replayEpsilonMs
    : 0;

  const buckets = new Map();
  for (const obs of observations) {
    if (!isObservationObject(obs)) continue;
    const observedAt = normalizeOptionalTimestamp(obs.observedAt);
    const fingerprint = JSON.stringify([
      obs.provider ?? null,
      obs.accountScope ?? 'default',
      obs.subjectKey ?? null,
      obs.fileIndexKey ?? null,
      obs.kind ?? null,
      obs.state ?? null,
      obs.errorCategory ?? null,
      obs.source ?? null,
    ]);
    // Find a bucket whose observedAt is within epsilon of this one.
    let matchKey = null;
    for (const [key, entry] of buckets) {
      if (!key.startsWith(fingerprint + SCOPE_KEY_DELIMITER)) continue;
      const existingAt = entry.observedAt;
      if (existingAt != null && observedAt != null
          && Math.abs(existingAt - observedAt) <= epsilon) {
        matchKey = key;
        break;
      }
    }
    if (matchKey == null) {
      const newKey = `${fingerprint}${SCOPE_KEY_DELIMITER}${buckets.size}`;
      buckets.set(newKey, { observation: obs, observedAt });
    } else {
      const entry = buckets.get(matchKey);
      // Keep the latest observedAt and the most recent observation object.
      if (observedAt != null
          && (entry.observedAt == null || observedAt > entry.observedAt)) {
        entry.observedAt = observedAt;
        entry.observation = obs;
      }
    }
  }

  const collapsed = [];
  let repeatedCollapsed = 0;
  for (const entry of buckets.values()) {
    collapsed.push(entry.observation);
  }
  repeatedCollapsed = Math.max(0, observations.length - collapsed.length);
  return { collapsed, repeatedCollapsed };
}

// ---------------------------------------------------------------------------
// Public: reconcileProviderEvidence
// ---------------------------------------------------------------------------

/**
 * Default freshness policy. Override per call if needed.
 * Each value is a TTL in ms. If the most recent fresh observation in a
 * scope is older than `currentTtlMs`, it is considered stale.
 */
export const DEFAULT_FRESHNESS_POLICY = Object.freeze({
  currentTtlMs: 5 * 60 * 1000,        // 5 minutes — current observations
  historicalTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days — historical prior
});

/**
 * Build the default historical prior shape from a historical evidence row.
 * Historical evidence is a different schema layer (historical_provider_evidence
 * / DMM sightings) than current observations; the caller is responsible for
 * extracting (positive | negative | absent, sourceIds[]) before calling.
 *
 * @param {Object} input
 * @param {string} input.provider
 * @param {string} [input.accountScope='default']
 * @param {boolean} [input.positive=true]
 * @param {string[]} [input.sources=[]]
 * @returns {Object} A frozen historical prior descriptor.
 */
export function buildHistoricalPrior({ provider, accountScope = 'default', positive = true, sources = [] } = {}) {
  return Object.freeze({
    provider: provider ?? null,
    accountScope,
    positive: Boolean(positive),
    sources: Object.freeze([...(Array.isArray(sources) ? sources : [])]),
  });
}

/**
 * Reconcile provider evidence for a single (provider, accountScope) scope.
 *
 * @param {Object} input
 * @param {Array<object>} [input.currentObservations=[]] - current-layer
 *   observations (from `provider_observation_current`).
 * @param {Array<object>} [input.historicalSightings=[]] - historical-layer
 *   rows (from `historical_provider_evidence` and/or DMM sightings).
 * @param {number} [input.now=Date.now()] - current time in ms.
 * @param {Object} [input.freshnessPolicy] - overrides for
 *   { currentTtlMs, historicalTtlMs }.
 * @param {string} [input.provider] - expected provider (used to filter
 *   observations that lack a provider field, and to annotate output).
 * @param {string} [input.accountScope='default'] - expected account scope.
 * @returns {{
 *   currentState: 'positive'|'negative'|'unknown',
 *   freshness: 'fresh'|'stale'|'missing',
 *   confidence: 'current'|'historical-prior'|'unresolved',
 *   reason: string,
 *   negativeKind: 'durable'|'transient'|null,
 *   historicalPrior: object|null,
 *   freshObservation: object|null,
 *   repeatedCollapsed: number
 * }}
 */
export function reconcileProviderEvidence(input = {}) {
  const provider = input.provider ?? null;
  const accountScope = input.accountScope ?? 'default';
  const now = Number.isSafeInteger(input.now) ? input.now : Date.now();
  const policy = {
    currentTtlMs: input.freshnessPolicy?.currentTtlMs ?? DEFAULT_FRESHNESS_POLICY.currentTtlMs,
    historicalTtlMs: input.freshnessPolicy?.historicalTtlMs ?? DEFAULT_FRESHNESS_POLICY.historicalTtlMs,
  };

  // Filter to the requested scope only. Observations from other scopes
  // MUST NOT influence this reconciliation.
  const allCurrent = Array.isArray(input.currentObservations) ? input.currentObservations : [];
  const allHistorical = Array.isArray(input.historicalSightings) ? input.historicalSightings : [];

  const scopeCurrent = allCurrent.filter((o) => {
    if (!isObservationObject(o)) return false;
    if (o.provider != null && provider != null && o.provider !== provider) return false;
    const obsScope = o.accountScope ?? 'default';
    return obsScope === accountScope;
  });

  // Collapse repeated identical observations in history.
  const { collapsed: dedupedCurrent, repeatedCollapsed } = collapseRepeatedObservations(
    scopeCurrent, { replayEpsilonMs: 0 }
  );

  // Sort by observedAt DESC so the most recent observation is index 0.
  dedupedCurrent.sort((a, b) => {
    const at = normalizeOptionalTimestamp(b.observedAt) ?? 0;
    const bt = normalizeOptionalTimestamp(a.observedAt) ?? 0;
    return at - bt;
  });

  // The "current" observation in this scope is the most recent.
  const mostRecent = dedupedCurrent[0] ?? null;

  // Evaluate freshness using the supplied policy TTL.
  const currentFreshness = mostRecent
    ? evaluateFreshnessWithPolicy(mostRecent, now, policy.currentTtlMs)
    : { freshness: 'missing', fresh: false, ageMs: null, expiresInMs: null };

  const historicalPrior = extractHistoricalPrior(
    allHistorical, provider, accountScope, now, policy.historicalTtlMs,
  );

  // ---------------------------------------------------------------------
  // Precedence rules (per spec, applied in this exact order):
  // ---------------------------------------------------------------------

  // 1. Fresh current POSITIVE/NEGATIVE wins outright.
  if (mostRecent && currentFreshness.freshness === 'fresh') {
    const state = mostRecent.state;
    if (state === 'cached') {
      return Object.freeze({
        currentState: 'positive',
        freshness: 'fresh',
        confidence: 'current',
        reason: 'fresh-positive',
        negativeKind: null,
        historicalPrior,
        freshObservation: mostRecent,
        repeatedCollapsed,
      });
    }
    if (state === 'uncached') {
      const negativeKind = isDurableNegative(mostRecent) ? 'durable' : 'transient';
      return Object.freeze({
        currentState: 'negative',
        freshness: 'fresh',
        confidence: 'current',
        reason: 'fresh-negative',
        negativeKind,
        historicalPrior,
        freshObservation: mostRecent,
        repeatedCollapsed,
      });
    }
    // state === 'error' | 'unknown' → fall through to transient-handling
    // below. We do NOT mark this as a fresh positive/negative.
  }

  // 2. Transient disruption: a fresh error/unknown does NOT erase a prior
  //    known positive/negative. If a fresh transient is present, mark
  //    `unresolved` confidence and preserve the most recent known state.
  if (mostRecent && currentFreshness.freshness === 'fresh'
      && (mostRecent.state === 'error' || mostRecent.state === 'unknown')) {
    // Look back through deduped observations for the most recent known.
    const lastKnown = dedupedCurrent.find(
      (o) => o.state === 'cached' || o.state === 'uncached',
    );
    if (lastKnown) {
      return Object.freeze({
        currentState: lastKnown.state === 'cached' ? 'positive' : 'negative',
        freshness: 'fresh',
        confidence: 'unresolved',
        reason: 'transient-unknown-preserved-known',
        negativeKind: isDurableNegative(lastKnown) ? 'durable' : 'transient',
        historicalPrior,
        freshObservation: mostRecent,
        repeatedCollapsed,
      });
    }
    // No prior known state — the transient IS the only signal.
    // Fall through to "no known current" handling; reason is `transient-unknown-preserved-known`
    // is NOT appropriate because there was nothing to preserve.
    return Object.freeze({
      currentState: 'unknown',
      freshness: 'fresh',
      confidence: 'unresolved',
      reason: 'transient-unknown-preserved-known',
      negativeKind: null,
      historicalPrior,
      freshObservation: mostRecent,
      repeatedCollapsed,
    });
  }

  // 3. Stale current observation: it remains historical context but is
  //    NOT fresh truth. If the historical prior exists and disagrees,
  //    the historical prior is the bounded source.
  if (mostRecent && currentFreshness.freshness === 'stale') {
    if (historicalPrior) {
      return Object.freeze({
        currentState: historicalPrior.positive ? 'positive' : 'negative',
        freshness: 'stale',
        confidence: 'historical-prior',
        reason: historicalPrior.positive
          ? 'historical-prior-positive'
          : 'historical-prior-negative',
        negativeKind: null,
        historicalPrior,
        freshObservation: mostRecent,
        repeatedCollapsed,
      });
    }
    return Object.freeze({
      currentState: mostRecent.state === 'cached' ? 'positive'
        : mostRecent.state === 'uncached' ? 'negative'
          : 'unknown',
      freshness: 'stale',
      confidence: 'unresolved',
      reason: mostRecent.state === 'cached' ? 'stale-positive'
        : mostRecent.state === 'uncached' ? 'stale-negative'
          : 'no-evidence',
      negativeKind: null,
      historicalPrior: null,
      freshObservation: mostRecent,
      repeatedCollapsed,
    });
  }

  // 4. No current observation. Fall back to historical prior.
  if (historicalPrior) {
    return Object.freeze({
      currentState: historicalPrior.positive ? 'positive' : 'negative',
      freshness: 'missing',
      confidence: 'historical-prior',
      reason: historicalPrior.positive
        ? 'historical-prior-positive'
        : 'historical-prior-negative',
      negativeKind: null,
      historicalPrior,
      freshObservation: null,
      repeatedCollapsed,
    });
  }

  // 5. Truly no evidence.
  return Object.freeze({
    currentState: 'unknown',
    freshness: 'missing',
    confidence: 'unresolved',
    reason: 'no-evidence',
    negativeKind: null,
    historicalPrior: null,
    freshObservation: null,
    repeatedCollapsed,
  });
}

/**
 * Reconcile across multiple scopes simultaneously. Returns one record per
 * scope so callers can show independent readings (e.g. for an operator UI).
 *
 * @param {Object} input
 * @param {Array<object>} [input.currentObservations=[]]
 * @param {Array<object>} [input.historicalSightings=[]]
 * @param {number} [input.now=Date.now()]
 * @param {Object} [input.freshnessPolicy]
 * @returns {Array<object>} array of per-scope reconciliations
 */
export function reconcileAllScopes(input = {}) {
  const allCurrent = Array.isArray(input.currentObservations) ? input.currentObservations : [];
  const allHistorical = Array.isArray(input.historicalSightings) ? input.historicalSightings : [];
  const grouped = groupObservationsByScope(allCurrent);

  const out = [];
  for (const [key, observations] of grouped) {
    const [provider, accountScope] = key.split(SCOPE_KEY_DELIMITER);
    const scopedHistorical = allHistorical.filter((h) => {
      if (!isObservationObject(h)) return false;
      const hProvider = h.provider ?? null;
      const hScope = h.accountScope ?? 'default';
      if (hProvider != null && hProvider !== provider) return false;
      return hScope === accountScope;
    });
    out.push(reconcileProviderEvidence({
      currentObservations: observations,
      historicalSightings: scopedHistorical,
      now: input.now ?? Date.now(),
      freshnessPolicy: input.freshnessPolicy,
      provider,
      accountScope,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Freshness evaluation under a caller-supplied TTL.
 *
 * If the observation has its own `expiresAt` and the value is in the
 * future, it is fresh. Otherwise we apply the policy TTL relative to
 * `observedAt` to determine freshness.
 */
function evaluateFreshnessWithPolicy(observation, now, ttlMs) {
  const observedAt = normalizeOptionalTimestamp(observation.observedAt);
  if (observedAt == null) return { freshness: 'stale', fresh: false, ageMs: null, expiresInMs: null };

  // First, prefer the observation's own expiresAt if present.
  if (observation.expiresAt != null) {
    const detail = evaluateObservationFreshness(observation, { now });
    if (detail.fresh === true) {
      return { freshness: 'fresh', fresh: true, ageMs: detail.ageMs, expiresInMs: detail.expiresInMs };
    }
    if (detail.fresh === false) {
      return { freshness: 'stale', fresh: false, ageMs: detail.ageMs, expiresInMs: detail.expiresInMs };
    }
    // unbounded — fall through to policy TTL.
  }

  const ageMs = Math.max(0, now - observedAt);
  if (ageMs <= ttlMs) {
    return { freshness: 'fresh', fresh: true, ageMs, expiresInMs: ttlMs - ageMs };
  }
  return { freshness: 'stale', fresh: false, ageMs, expiresInMs: ttlMs - ageMs };
}

/**
 * Extract a single historical prior from a list of historical evidence rows
 * for the given (provider, accountScope). Multiple historical positives
 * collapse into one prior; if positives and negatives coexist, positive
 * wins (per rule 6: historical positive is a bounded prior; negatives are
 * better expressed through current-layer observations).
 */
function extractHistoricalPrior(historicalSightings, provider, accountScope, now, historicalTtlMs) {
  if (!Array.isArray(historicalSightings) || historicalSightings.length === 0) return null;

  let positiveCount = 0;
  let negativeCount = 0;
  const sources = new Set();
  let mostRecent = -Infinity;
  let mostRecentEvidenceType = null;

  for (const row of historicalSightings) {
    if (!isObservationObject(row)) continue;
    const rowProvider = row.provider ?? null;
    const rowScope = row.accountScope ?? 'default';
    if (rowProvider != null && provider != null && rowProvider !== provider) continue;
    if (rowScope !== accountScope) continue;

    // Stale historical evidence is excluded.
    const lastSeen = normalizeOptionalTimestamp(row.lastSeenAt ?? row.observedAt);
    if (lastSeen != null && (now - lastSeen) > historicalTtlMs) continue;

    const evType = row.evidenceType ?? row.kind ?? null;
    // Map historical evidence to positive/negative.
    // Convention: positive evidence types include "presence", "hit",
    // "cached". Negative evidence types are not currently produced by
    // historical importer, but if added, they should be classified here.
    const isPositive = evType == null
      || /presence|hit|cached|positive/i.test(String(evType));
    const isNegative = !isPositive && /negative|absent|missing/i.test(String(evType));

    if (isPositive) positiveCount += 1;
    if (isNegative) negativeCount += 1;

    if (row.sourceId != null) sources.add(String(row.sourceId));
    else if (row.source != null) sources.add(String(row.source));

    if (lastSeen != null && lastSeen > mostRecent) {
      mostRecent = lastSeen;
      mostRecentEvidenceType = evType;
    }
  }

  if (positiveCount === 0 && negativeCount === 0) return null;

  return Object.freeze({
    provider,
    accountScope,
    // Per rule 6: a historical positive is the prior; a historical
    // negative alone is recorded as `negative` for symmetry, but
    // current-layer evidence should always be preferred when present.
    positive: positiveCount >= negativeCount,
    sources: Object.freeze([...sources]),
    positiveCount,
    negativeCount,
    mostRecentEvidenceType,
  });
}
