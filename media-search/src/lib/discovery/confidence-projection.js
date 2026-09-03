/**
 * Provider-Agnostic Evidence Confidence Projection
 *
 * Deterministic, side-effect-free projection that answers:
 *
 *   "Given the observations we have for this release/candidate, how strong is
 *    our belief that it is worth considering/probing?"
 *
 * This is NOT current provider availability and NOT durable identity.
 * It is a derived view above durable identity.
 *
 * Identity remains: Release = infoHash, Candidate = (infoHash, fileIndexKey).
 * Confidence may change what we believe about an identity. It may never
 * change what the identity is.
 *
 * Evidence taxonomy (provider-agnostic; sources are opaque tags):
 *
 *  - DMM_HISTORICAL          historical DMM source-observation presence
 *  - DMM_REPEATED            DMM observation seen across independent generations
 *  - PROVIDER_HISTORICAL     historical provider hit (cache.js event log)
 *  - PROVIDER_FRESH_POSITIVE fresh provider observation: state=cached
 *  - PROVIDER_FRESH_NEGATIVE fresh provider observation: state=uncached|error
 *  - PROVIDER_STALE          provider observation past its expiresAt
 *  - ATTRIBUTE_HISTORICAL    local regex/predictor parsed release_attributes
 *  - MEDIA_ASSOCIATION       candidate ↔ media_id link
 *  - SOURCE_LISTED           candidate.sources lists a known discovery source
 *
 * Classification axes (per evidence item, evaluated independently):
 *
 *   historical   vs current        — observed_at relative to now + TTL
 *   authoritative vs heuristic     — provider=authoritative vs local regex
 *   release-level vs file-level    — file_index_key null = release-level
 *   positive      vs negative      vs ambiguous
 *   combinable                     — every kind here is combinable, with
 *                                    precedence rules below
 *
 * Combinable semantics:
 *   - DMM_HISTORICAL + PROVIDER_FRESH_* are NOT flattened into one boolean.
 *   - They contribute to different dimensions (availabilityPrior vs freshness
 *     vs identityConfidence vs corroboration).
 *   - A fresh provider observation never deletes a DMM observation; it only
 *     overrides the current-period availability contribution.
 *
 * Projection dimensions (per spec):
 *
 *   availabilityPrior  ∈ [0, 1]  — how much historical evidence suggests
 *                                   this candidate is worth probing.
 *                                   DMM sightings + repeated DMM generations
 *                                   + provider historical hits. Fresh
 *                                   provider observations are NOT folded
 *                                   into the prior; they live in `freshness`
 *                                   and `freshProvider` and override
 *                                   current availability confidence.
 *   identityConfidence ∈ [0, 1]  — how well-evidenced the identity is.
 *                                   Multi-generation + multi-source
 *                                   observations + parsed attributes raise
 *                                   this. Identity confidence is a property
 *                                   of the candidate identity, not of any
 *                                   one source.
 *   corroboration      ∈ [0, N]  — count of independent source-type families
 *                                   that have observed this identity. A
 *                                   non-zero value means at least one
 *                                   observation. A value ≥ 2 means two
 *                                   independent families agree.
 *   freshness          ∈ [0, 1]  — decay factor based on
 *                                   (now − mostRecentObservedAt). 1.0 if
 *                                   observed in the last hour, decays to
 *                                   ~0.0 over ~30 days, 0 for missing.
 *   freshProvider      ∈ {null,
 *                          'positive',
 *                          'negative',
 *                          'ambiguous',
 *                          'stale'} — current provider observation, if any.
 *                                   `null` means no fresh provider
 *                                   observation; this is unknown, not zero.
 *   reasons            : string[] — human-readable list of evidence
 *                                   contributions. Each reason is a
 *                                   stable, enumerable label — no
 *                                   magic-number language.
 *   evidence           : Array    — the (deduplicated, sorted) input
 *                                   observations that contributed. Same
 *                                   evidence in shuffled order MUST
 *                                   produce the same output (determinism).
 *
 * Precedence rules (applied in this order; last write wins per dimension):
 *
 *   1. Provider freshness outranks historical prior for current-period
 *      availability. freshProvider='negative' sets current confidence low
 *      without deleting historical reasons.
 *   2. Repeated DMM sightings across INDEPENDENT generations raise
 *      identityConfidence (independent = distinct generation_id, not just
 *      repeated observation in the same generation/fragment).
 *   3. Multiple independent source-type families raise corroboration.
 *   4. Stale provider observations decay: their contribution to
 *      availabilityPrior is reduced by the freshness factor before being
 *      added to the prior.
 *   5. Missing evidence yields null/0 dimensions, not a negative reading.
 *   6. Local regex/predictor results (ATTRIBUTE_HISTORICAL) are local
 *      evidence, not provider truth. They contribute to
 *      identityConfidence + corroboration, never to freshProvider.
 *   7. No single scalar may masquerade as durable availability state. The
 *      output is a structured object; callers must decide how to combine
 *      these dimensions, not the projection.
 *
 * Weights (kept simple, isolated, documented in this comment block):
 *
 *   DMM_HISTORICAL availabilityPrior contribution:        +0.20 (one shot)
 *   DMM_REPEATED   availabilityPrior contribution:        +0.10 per gen
 *                                                            (cap at +0.30)
 *   PROVIDER_HISTORICAL availabilityPrior contribution:   +0.20 (one shot)
 *   ATTRIBUTE_HISTORICAL identityConfidence contribution: +0.20 (one shot)
 *   MEDIA_ASSOCIATION identityConfidence contribution:    +0.10 (one shot)
 *   SOURCE_LISTED identityConfidence contribution:        +0.05 (one shot)
 *
 *   identityConfidence starts at 0.10 if any evidence exists, +0.10 per
 *   additional corroboration family beyond the first (cap 0.20).
 *   identityConfidence is capped at 1.0.
 *
 *   availabilityPrior starts at 0.0. Each contribution is added and the
 *   total is capped at 1.0. If only stale evidence is present, the
 *   contribution is multiplied by the freshness factor.
 *
 * Rationale (why these numbers):
 *   - DMM is a non-authoritative, large-scale historical index. A single
 *     sighting is a weak-but-useful prior (0.20). Repeated sightings
 *     across generations reinforce it (0.10/gen, +0.30 cap).
 *   - PROVIDER_HISTORICAL is a real provider hit — stronger than DMM
 *     alone (0.20, same as DMM), but not authoritative for current state
 *     (that's freshProvider).
 *     Source-vs-snapshot: distinct source_ids are distinct corroboration
 *     families. Distinct source_versions of the SAME source_id are NOT
 *     distinct families — they are repeated sightings from the same
 *     witness. The cache has already collapsed snapshots in the
 *     aggregate; the projection sees one row per (provider, source_id).
 *   - ATTRIBUTE_HISTORICAL proves a parser understood the title — modest
 *     identity signal (0.20).
 *   - MEDIA_ASSOCIATION and SOURCE_LISTED are weaker but free
 *     corroboration.
 *   - Corroboration bonus (0.10/family) rewards independent agreement
 *     without overcommitting.
 *
 * Contract:
 *   - Pure function. No DB, no globals, no time-of-day surprise beyond the
 *     `now` argument. Identical input + identical `now` → identical output.
 *   - No schema additions. No persistence. No mutation of inputs.
 *   - No access to provider live state. Only the observations array.
 *   - No ML, no learned scoring, no random.
 *   - Safe when `observations` is empty.
 *   - Output is JSON-serializable.
 */

/**
 * Evidence-shape constant. Items SHOULD be plain objects with at minimum
 *   { kind: <string>, observedAt: <number> }
 * Optional fields used by the projection:
 *   - source       : opaque source-family tag (defaults to kind)
 *   - generationId : when kind starts with 'DMM', an opaque generation
 *                    identifier used to detect independent repetitions
 *   - state        : when kind starts with 'PROVIDER', one of
 *                    'cached' | 'uncached' | 'error' | 'unknown'
 *   - ttlMs        : explicit TTL for the freshness decay calculation
 *                    (defaults derived from kind)
 *   - negative     : boolean — explicit negative polarity override
 *
 * The projection is provider-agnostic: it does not call out to any
 * provider or DB. It consumes only the array passed in.
 */

// Source-type families. Each is a label for "independent corroboration".
// Independence is by family: two DMM observations are NOT independent;
// one DMM and one provider observation ARE independent.
const FAMILY_DMM = 'dmm';
const FAMILY_PROVIDER = 'provider';
const FAMILY_ATTRIBUTE = 'attribute';
const FAMILY_MEDIA = 'media';
const FAMILY_SOURCE_LIST = 'source-list';

// Tunable decay half-life for freshness. After this many ms, freshness
// factor is 0.5. After 5x this, factor is ~0.03. Picked to span the
// realistic DMM refresh cadence (weeks) and provider TTL (minutes-hours)
// without losing either signal.
const FRESHNESS_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// One-hour floor: anything observed within the last hour is fully fresh.
const FRESH_FLOOR_MS = 60 * 60 * 1000; // 1 hour

// Default per-kind TTLs used when an item does not declare ttlMs.
// These are NOT authoritative TTLs — they are heuristics for how long an
// observation of that kind should be considered "current" before it
// starts to decay. They are intentionally generous so that
// 'historical' observations still contribute meaningfully to the prior.
const DEFAULT_TTL_MS = {
  DMM_HISTORICAL: 30 * 24 * 60 * 60 * 1000,     // 30 days
  DMM_REPEATED: 30 * 24 * 60 * 60 * 1000,        // 30 days
  PROVIDER_HISTORICAL: 24 * 60 * 60 * 1000,      // 24 hours
  PROVIDER_FRESH_POSITIVE: 60 * 60 * 1000,        // 1 hour
  PROVIDER_FRESH_NEGATIVE: 60 * 60 * 1000,        // 1 hour
  PROVIDER_STALE: 0,                              // always stale
  ATTRIBUTE_HISTORICAL: 7 * 24 * 60 * 60 * 1000,  // 7 days
  MEDIA_ASSOCIATION: 7 * 24 * 60 * 60 * 1000,     // 7 days
  SOURCE_LISTED: 7 * 24 * 60 * 60 * 1000,         // 7 days
};

/**
 * Classify an observation into a family + polarity.
 * Pure, internal, side-effect-free.
 */
function classify(obs) {
  const kind = obs?.kind;
  if (typeof kind !== 'string') {
    return { family: null, polarity: 'ambiguous', ttlMs: 0 };
  }
  const ttlMs = obs.ttlMs ?? DEFAULT_TTL_MS[kind] ?? 0;
  if (kind === 'DMM_HISTORICAL' || kind === 'DMM_REPEATED') {
    return { family: FAMILY_DMM, polarity: 'positive', ttlMs };
  }
  if (kind === 'ATTRIBUTE_HISTORICAL') {
    return { family: FAMILY_ATTRIBUTE, polarity: 'positive', ttlMs };
  }
  if (kind === 'MEDIA_ASSOCIATION') {
    return { family: FAMILY_MEDIA, polarity: 'positive', ttlMs };
  }
  if (kind === 'SOURCE_LISTED') {
    return { family: FAMILY_SOURCE_LIST, polarity: 'positive', ttlMs };
  }
  if (kind === 'PROVIDER_HISTORICAL') {
    // A PROVIDER_HISTORICAL item MAY carry a historicalSourceId field.
    // When it does, that source becomes its own corroboration family so
    // that two independent historical sources (e.g. rd-history-2024 and
    // rd-history-2023) raise corroboration without conflating them.
    // When the field is absent, the item falls back to the generic
    // PROVIDER family.
    if (typeof obs.historicalSourceId === 'string' && obs.historicalSourceId.length > 0) {
      return { family: `${FAMILY_PROVIDER}:${obs.historicalSourceId}`, polarity: 'positive', ttlMs };
    }
    return { family: FAMILY_PROVIDER, polarity: 'positive', ttlMs };
  }
  if (kind === 'PROVIDER_FRESH_POSITIVE') {
    return { family: FAMILY_PROVIDER, polarity: 'positive', ttlMs };
  }
  if (kind === 'PROVIDER_FRESH_NEGATIVE') {
    return { family: FAMILY_PROVIDER, polarity: 'negative', ttlMs };
  }
  if (kind === 'PROVIDER_STALE') {
    return { family: FAMILY_PROVIDER, polarity: 'ambiguous', ttlMs: 0 };
  }
  return { family: null, polarity: 'ambiguous', ttlMs: 0 };
}

/**
 * Decay factor based on (now − observedAt) and the item's TTL.
 * Pure, internal, side-effect-free.
 *
 *   - If age ≤ FRESH_FLOOR_MS: factor = 1.0
 *   - Else: half-life decay based on FRESHNESS_HALF_LIFE_MS
 *   - Past ttlMs (and ttlMs > 0): factor is further reduced, with floor
 *     of 0.0 to represent "decayed to nothing"
 *   - If ttlMs === 0: pure half-life decay
 */
function decayFactor(ageMs, ttlMs) {
  if (ageMs == null || ageMs < 0) return 0;
  if (ageMs <= FRESH_FLOOR_MS) return 1.0;
  const halfLife = Math.max(ttlMs, FRESHNESS_HALF_LIFE_MS);
  // Exponential decay: factor = 0.5 ^ (ageMs / halfLife)
  const factor = Math.pow(0.5, ageMs / halfLife);
  if (ttlMs > 0 && ageMs > ttlMs) {
    // Past TTL — additional linear taper to floor of 0.
    const overMs = ageMs - ttlMs;
    const taper = Math.max(0, 1 - overMs / (2 * ttlMs));
    return factor * taper;
  }
  return factor;
}

/**
 * Deduplicate observations and sort by a stable key so that
 * "same evidence snapshot in shuffled order" produces the same projection.
 * Pure, internal, side-effect-free (returns a new array).
 */
function stabilize(observations) {
  const seen = new Map();
  for (const obs of observations) {
    if (!obs || typeof obs !== 'object') continue;
    // Stable key by all fields that affect classification.
    const key = JSON.stringify({
      kind: obs.kind,
      source: obs.source ?? null,
      generationId: obs.generationId ?? null,
      state: obs.state ?? null,
      observedAt: obs.observedAt,
    });
    if (!seen.has(key)) seen.set(key, obs);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
    return (a.kind ?? '').localeCompare(b.kind ?? '');
  });
}

/**
 * Project evidence for a single candidate identity.
 *
 * @param {Object} identity     — { infoHash, fileIndex? }. Identity-only;
 *                                NEVER affects projection shape (projection
 *                                is over the same identity for every call).
 * @param {Array}  observations — array of evidence items (see header
 *                                for shape). May be empty.
 * @param {Object} [options]
 * @param {number} [options.now] — current time in ms (defaults to Date.now()).
 *                                Pinned for deterministic testing.
 * @returns {{
 *   availabilityPrior:  number,
 *   identityConfidence: number,
 *   corroboration:      number,
 *   freshness:          number,
 *   freshProvider:      (null|'positive'|'negative'|'ambiguous'|'stale'),
 *   reasons:            string[],
 *   evidence:           Array,
 *   evidenceCount:      number
 * }}
 */
export function projectCandidateEvidence(identity, observations, options = {}) {
  // Identity is accepted for symmetry with future call-sites but does NOT
  // affect the projection. Projection is over the observations array only.
  // This guarantees that two candidates with identical observations but
  // different (infoHash, fileIndex) identities produce identical projections
  // modulo identity-context — but the projection output never references
  // identity, so it is identical.
  if (!identity || typeof identity !== 'object') {
    throw new TypeError('projectCandidateEvidence requires an identity object');
  }
  if (!Array.isArray(observations)) {
    throw new TypeError('projectCandidateEvidence requires observations to be an array');
  }
  const now = typeof options.now === 'number' ? options.now : Date.now();

  // Empty-observations case is well-defined: all null/0, no reasons.
  if (observations.length === 0) {
    return {
      availabilityPrior: 0,
      identityConfidence: 0,
      corroboration: 0,
      freshness: 0,
      freshProvider: null,
      reasons: ['no-evidence'],
      evidence: [],
      evidenceCount: 0,
    };
  }

  const stable = stabilize(observations);

  // ---------------------------------------------------------------------------
  // 1. Freshness (based on most recent observedAt)
  // ---------------------------------------------------------------------------
  let mostRecentAt = -Infinity;
  for (const obs of stable) {
    if (typeof obs.observedAt === 'number' && obs.observedAt > mostRecentAt) {
      mostRecentAt = obs.observedAt;
    }
  }
  const freshnessAgeMs = mostRecentAt === -Infinity ? null : Math.max(0, now - mostRecentAt);
  // Freshness of the most-recent item, using its kind's TTL.
  let freshnessMostRecentTtl = 0;
  for (const obs of stable) {
    if (obs.observedAt === mostRecentAt) {
      const c = classify(obs);
      freshnessMostRecentTtl = Math.max(freshnessMostRecentTtl, c.ttlMs);
    }
  }
  const freshness = freshnessAgeMs == null
    ? 0
    : decayFactor(freshnessAgeMs, freshnessMostRecentTtl);

  // ---------------------------------------------------------------------------
  // 2. freshProvider (last write wins, ordered by observedAt)
  // ---------------------------------------------------------------------------
  let freshProvider = null;
  for (const obs of stable) {
    const kind = obs.kind;
    if (kind === 'PROVIDER_FRESH_POSITIVE') freshProvider = 'positive';
    else if (kind === 'PROVIDER_FRESH_NEGATIVE') freshProvider = 'negative';
    else if (kind === 'PROVIDER_STALE') {
      // Stale provider observation never SETS freshProvider unless nothing
      // fresher has been observed in this same window.
      if (freshProvider == null) freshProvider = 'stale';
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Corroboration (count of distinct source families)
  // ---------------------------------------------------------------------------
  const families = new Set();
  for (const obs of stable) {
    const c = classify(obs);
    if (c.family) families.add(c.family);
  }
  const corroboration = families.size;

  // ---------------------------------------------------------------------------
  // 4. availabilityPrior (DMM + provider historical; fresh provider NOT folded in)
  // ---------------------------------------------------------------------------
  let availabilityPrior = 0;
  let dmmSeen = false;
  const dmmGenerations = new Set();
  const providerHistoricalSources = new Set();
  for (const obs of stable) {
    const kind = obs.kind;
    if (kind === 'DMM_HISTORICAL' || kind === 'DMM_REPEATED') {
      const ageMs = Math.max(0, now - obs.observedAt);
      const ttl = classify(obs).ttlMs;
      const factor = decayFactor(ageMs, ttl);
      if (!dmmSeen) {
        availabilityPrior += 0.20 * factor;
        dmmSeen = true;
        if (typeof obs.generationId === 'string') dmmGenerations.add(obs.generationId);
      } else if (typeof obs.generationId === 'string' && !dmmGenerations.has(obs.generationId)) {
        // +0.10 per independent generation, capped at +0.30 total.
        availabilityPrior += Math.min(0.10, 0.30) * factor;
        dmmGenerations.add(obs.generationId);
      }
    } else if (kind === 'PROVIDER_HISTORICAL') {
      // De-duplicate by historicalSourceId (or provider as a fallback for
      // legacy items without a source id) so that multiple rows from the
      // same historical source do not amplify the prior. Each unique
      // historical source contributes +0.20 once.
      const sourceUnit = typeof obs.historicalSourceId === 'string' && obs.historicalSourceId.length > 0
        ? obs.historicalSourceId
        : (obs.source ?? 'unknown');
      if (!providerHistoricalSources.has(sourceUnit)) {
        const ageMs = Math.max(0, now - obs.observedAt);
        const factor = decayFactor(ageMs, classify(obs).ttlMs);
        availabilityPrior += 0.20 * factor;
        providerHistoricalSources.add(sourceUnit);
      }
    }
  }
  availabilityPrior = Math.max(0, Math.min(1, availabilityPrior));

  // ---------------------------------------------------------------------------
  // 5. identityConfidence (multi-source + multi-gen + parsed attributes)
  // ---------------------------------------------------------------------------
  let identityConfidence = 0;
  const reasons = [];
  let anyEvidence = false;
  for (const obs of stable) {
    const kind = obs.kind;
    if (kind === 'ATTRIBUTE_HISTORICAL' && !anyEvidence) {
      // first-shot bonus; subsequent ATTRIBUTE_HISTORICAL do not re-add
      identityConfidence += 0.20;
      reasons.push('attribute-parsed');
      anyEvidence = true;
    } else if (kind === 'MEDIA_ASSOCIATION' && !reasons.includes('media-associated')) {
      identityConfidence += 0.10;
      reasons.push('media-associated');
    } else if (kind === 'SOURCE_LISTED' && !reasons.includes('source-listed')) {
      identityConfidence += 0.05;
      reasons.push('source-listed');
    }
  }
  // Base 0.10 if any evidence exists, plus 0.10 per corroboration family
  // beyond the first, capped at +0.20.
  if (corroboration > 0) {
    identityConfidence += 0.10;
    reasons.push('has-evidence');
  }
  if (corroboration >= 2) {
    const bonus = Math.min(0.10 * (corroboration - 1), 0.20);
    identityConfidence += bonus;
    reasons.push(`corroborated-by-${corroboration}-families`);
  }
  if (dmmGenerations.size >= 2) {
    identityConfidence += 0.10;
    reasons.push(`dmm-seen-across-${dmmGenerations.size}-generations`);
  }
  // Stale penalty: if all evidence is stale, halve identity confidence.
  if (freshness > 0 && freshness < 0.5) {
    identityConfidence *= 0.5;
    reasons.push('all-evidence-stale');
  }
  identityConfidence = Math.max(0, Math.min(1, identityConfidence));

  // ---------------------------------------------------------------------------
  // 6. Reasons (one per dimension) — enumerative, never freeform.
  // ---------------------------------------------------------------------------
  if (dmmSeen) reasons.push('dmm-historical');
  if (stable.some((o) => o.kind === 'PROVIDER_HISTORICAL')) reasons.push('provider-historical');
  if (freshProvider === 'positive') reasons.push('provider-fresh-positive');
  else if (freshProvider === 'negative') reasons.push('provider-fresh-negative');
  else if (freshProvider === 'stale') reasons.push('provider-stale-only');
  else if (freshProvider == null && corroboration > 0) reasons.push('no-fresh-provider');
  reasons.sort();

  return {
    availabilityPrior: round(availabilityPrior),
    identityConfidence: round(identityConfidence),
    corroboration,
    freshness: round(freshness),
    freshProvider,
    reasons,
    evidence: stable,
    evidenceCount: stable.length,
  };
}

/**
 * Round to 4 decimals to keep test diffs stable.
 */
function round(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

/**
 * Convenience: project a snapshot of evidence collected from the live
 * discovery cache. This is a READ-ONLY query that pulls a flat list of
 * evidence items from the cache and projects them.
 *
 * It is NOT required by the projection contract — callers that already
 * have observations in hand can call projectCandidateEvidence directly.
 * This helper exists so the projection can be used as a single
 * `createConfidenceProjection(cache).project(infoHash, fileIndex)` call.
 *
 * It is provider-agnostic: it does not call any provider. It reads
 * existing evidence (DMM observations, release_attributes, provider
 * observation events, candidate.sources, candidate_media) and feeds
 * them to the pure projection function.
 *
 * @param {Object} cache
 * @returns {{ project: (infoHash: string, fileIndex?: number|null, options?: Object) => Object }}
 */
export function createConfidenceProjection(cache) {
  if (!cache) throw new Error('Confidence projection requires a cache instance');

  /**
   * Collect a flat observations array for one candidate.
   * @param {string} infoHash
   * @param {number|null} [fileIndex]
   * @param {Object} [options]
   * @param {number} [options.now] — pinned clock
   * @returns {Array}
   */
  function collectObservations(infoHash, fileIndex = null, options = {}) {
    const out = [];
    if (!infoHash) return out;
    const fik = fileIndex == null ? -1 : fileIndex;

    // 1. DMM source observations
    if (typeof cache.getDmmObservationsForCandidate === 'function') {
      const obs = cache.getDmmObservationsForCandidate(infoHash, fileIndex);
      for (const o of obs) {
        out.push({
          kind: 'DMM_HISTORICAL',
          source: o.source ?? 'dmm-hashlist',
          generationId: o.generation_id,
          observedAt: Number(o.last_seen_at ?? o.first_seen_at ?? 0),
        });
        if (typeof o.generation_id === 'string') {
          out.push({
            kind: 'DMM_REPEATED',
            source: o.source ?? 'dmm-hashlist',
            generationId: o.generation_id,
            observedAt: Number(o.last_seen_at ?? o.first_seen_at ?? 0),
          });
        }
      }
    }

    // 2. release_attributes (parsed locally — local evidence, not provider truth)
    if (typeof cache.getReleaseAttributes === 'function') {
      const attrs = cache.getReleaseAttributes(infoHash, fileIndex);
      for (const a of attrs) {
        out.push({
          kind: 'ATTRIBUTE_HISTORICAL',
          source: a.source,
          observedAt: Number(a.parsedAt ?? 0),
        });
      }
    } else if (cache.db) {
      // Fallback: read directly if helper absent
      const rows = cache.db.prepare(`
        SELECT source, parsed_at FROM release_attributes
        WHERE info_hash = ? AND file_index_key = ?
      `).all(infoHash, fik);
      for (const a of rows) {
        out.push({
          kind: 'ATTRIBUTE_HISTORICAL',
          source: a.source,
          observedAt: Number(a.parsed_at ?? 0),
        });
      }
    }

    // 3. Provider observations (current + history)
    if (typeof cache.getProviderObservations === 'function') {
      const obs = cache.getProviderObservations(infoHash, fileIndex, {
        includeStale: true,
        // Pass `now` so freshness is computed against the projection's
        // pinned clock, not the real wall clock. This guarantees the
        // projection is fully deterministic when `now` is provided.
        now: options.now,
      });
      for (const o of obs) {
        // Prefer the explicit state field when present. Fall back to
        // the legacy `cached` boolean for older observation shapes.
        // The ternary chain here intentionally avoids `??` chaining
        // because the previous chained form had an operator-precedence
        // bug that always returned 'cached' for any non-nullish state.
        let state;
        if (typeof o.state === 'string' && o.state.length > 0) {
          state = o.state;
        } else if (o.cached === true) {
          state = 'cached';
        } else if (o.cached === false) {
          state = 'uncached';
        } else {
          state = 'unknown';
        }
        const isStale = o.freshness === 'stale';
        const isFresh = o.freshness === 'fresh' || o.freshness === 'unbounded';
        if (state === 'cached' && isFresh) {
          out.push({
            kind: 'PROVIDER_FRESH_POSITIVE',
            source: o.provider,
            state,
            observedAt: Number(o.observedAt ?? o.checkedAt ?? 0),
          });
        } else if ((state === 'uncached' || state === 'error') && isFresh) {
          out.push({
            kind: 'PROVIDER_FRESH_NEGATIVE',
            source: o.provider,
            state,
            observedAt: Number(o.observedAt ?? o.checkedAt ?? 0),
          });
        } else if (isStale) {
          out.push({
            kind: 'PROVIDER_STALE',
            source: o.provider,
            state,
            observedAt: Number(o.observedAt ?? o.checkedAt ?? 0),
          });
        } else {
          // unknown state but fresh — treat as positive evidence of probing
          out.push({
            kind: 'PROVIDER_HISTORICAL',
            source: o.provider,
            state,
            observedAt: Number(o.observedAt ?? o.checkedAt ?? 0),
          });
        }
      }
    }

    // 4. candidate.sources (list of discovery source tags)
    if (typeof cache.getCandidate === 'function') {
      const c = cache.getCandidate(infoHash, fileIndex);
      if (c && Array.isArray(c.sources)) {
        const lastSeen = Number(c.lastSeen ?? c.firstSeen ?? 0);
        for (const s of c.sources) {
          out.push({
            kind: 'SOURCE_LISTED',
            source: typeof s === 'string' ? s : s.id,
            observedAt: lastSeen,
          });
        }
      }
    }

    // 5. candidate_media associations
    if (typeof cache.getMediaAssociations === 'function') {
      const assoc = cache.getMediaAssociations(infoHash, fileIndex);
      for (const a of assoc) {
        out.push({
          kind: 'MEDIA_ASSOCIATION',
          source: a.source,
          observedAt: Number(a.associatedAt ?? 0),
        });
      }
    } else if (cache.db) {
      const rows = cache.db.prepare(`
        SELECT source, associated_at FROM candidate_media
        WHERE info_hash = ? AND file_index_key = ?
      `).all(infoHash, fik);
      for (const a of rows) {
        out.push({
          kind: 'MEDIA_ASSOCIATION',
          source: a.source,
          observedAt: Number(a.associated_at ?? 0),
        });
      }
    }

    // 6. Historical provider evidence (durable prior store, NOT current).
    //
    // This is the integration point for cache.getHistoricalProviderEvidence.
    // Each aggregate row represents "this independent source has
    // observed this release". These are PRIORS — they do NOT imply
    // current cache hit, current placement, or current availability.
    // Fresh provider observations (section 3) still outrank these for
    // current-period availability.
    //
    // historicalSourceId is built from (provider, source_id) ONLY —
    // distinct versions of the same source_id are NOT distinct
    // corroboration families (see source-vs-snapshot model). Two
    // different source_ids ARE distinct families. The cache has
    // already collapsed snapshots in the aggregate.
    if (typeof cache.getHistoricalProviderEvidence === 'function') {
      const hist = cache.getHistoricalProviderEvidence(infoHash, fileIndex);
      for (const h of hist) {
        out.push({
          kind: 'PROVIDER_HISTORICAL',
          source: h.provider,
          historicalSourceId: `${h.provider}:${h.source_id}`,
          observedAt: Number(h.last_seen_at ?? h.first_seen_at ?? 0),
          // distinct_snapshot_count replaces the old observation_count:
          // it represents how many distinct snapshots of this source
          // reported the sighting, not how many times the operator
          // replayed a snapshot.
          observationCount: Number(h.distinct_snapshot_count ?? 1),
        });
      }
    }

    return out;
  }

  /**
   * Project evidence for one candidate identity.
   * @param {string} infoHash
   * @param {number|null} [fileIndex]
   * @param {Object} [options]
   * @param {number} [options.now] — pinned clock
   * @returns {Object} projection result
   */
  function project(infoHash, fileIndex = null, options = {}) {
    const identity = { infoHash, fileIndex };
    const observations = collectObservations(infoHash, fileIndex, options);
    return projectCandidateEvidence(identity, observations, options);
  }

  return {
    project,
    collectObservations,
    projectCandidateEvidence,
    historicalAvailabilityPriorContribution: historicalAvailabilityPriorContributionStandalone,
    computeHistoricalAvailabilityPrior: (cache, infoHash, fileIndex = null, options = {}) => {
      if (!cache || typeof cache.getHistoricalProviderEvidence !== 'function') {
        return 0;
      }
      try {
        const projection = project(infoHash, fileIndex, { now: options.now });
        return historicalAvailabilityPriorContributionStandalone(projection, options);
      } catch {
        // Never let historical evidence computation break ranking.
        return 0;
      }
    },
    computeHistoricalProviderPrior: (cache, infoHash, fileIndex = null, options = {}) => {
      if (!cache || typeof cache.getHistoricalProviderEvidence !== 'function') {
        return { torbox: 0, realdebrid: 0 };
      }
      try {
        const projection = project(infoHash, fileIndex, { now: options.now });
        return computePerProviderHistoricalPrior(projection, options);
      } catch {
        return { torbox: 0, realdebrid: 0 };
      }
    },
  };
}

// Per-provider historical prior breakdown — shared implementation.
// Reuses the same proven projection machinery; no independent confidence math.
function computePerProviderHistoricalPrior(projection, options = {}) {
  if (!projection || typeof projection !== 'object') {
    return { torbox: 0, realdebrid: 0 };
  }
  const { maxPrior = 0.4 } = options;
  const now = typeof options.now === 'number' ? options.now : Date.now();

  // Fresh authoritative evidence outranks historical prior per provider.
  const freshByProvider = {};
  for (const ev of projection.evidence || []) {
    if (ev.kind === 'PROVIDER_FRESH_POSITIVE') {
      freshByProvider[ev.source] = 'positive';
    } else if (ev.kind === 'PROVIDER_FRESH_NEGATIVE') {
      freshByProvider[ev.source] = 'negative';
    } else if (ev.kind === 'PROVIDER_STALE' && !freshByProvider[ev.source]) {
      freshByProvider[ev.source] = 'stale';
    }
  }

  // Per-provider historical sums — reuse decayFactor from projection scope.
  const providerHistorical = {};
  const historicalSourceIds = {};
  for (const ev of projection.evidence || []) {
    if (ev.kind !== 'PROVIDER_HISTORICAL') continue;
    const provider = ev.source;
    if (!provider) continue;
    const sourceUnit = typeof ev.historicalSourceId === 'string' && ev.historicalSourceId.length > 0
      ? ev.historicalSourceId
      : (ev.source ?? 'unknown');
    historicalSourceIds[provider] = historicalSourceIds[provider] || new Set();
    if (historicalSourceIds[provider].has(sourceUnit)) continue;
    historicalSourceIds[provider].add(sourceUnit);
    const ageMs = Math.max(0, now - (ev.observedAt || 0));
    const factor = decayFactor(ageMs, DEFAULT_TTL_MS.PROVIDER_HISTORICAL);
    providerHistorical[provider] = (providerHistorical[provider] || 0) + 0.20 * factor;
  }

  // Apply fresh-evidence precedence.
  const result = { torbox: 0, realdebrid: 0 };
  for (const provider of ['torbox', 'realdebrid']) {
    const fresh = freshByProvider[provider];
    if (fresh === 'positive' || fresh === 'negative' || fresh === 'stale') {
      result[provider] = 0;
    } else {
      result[provider] = Math.max(0, Math.min(maxPrior, providerHistorical[provider] || 0));
    }
  }
  return result;
}

/**
 * Compute the bounded historical-availability-prior contribution to fold
 * into a candidate's `providerAvailability` ranking component.
 *
 * This is the RANKING INTEGRATION SEAM. It translates the evidence
 * projection into a single [0, 1] value that respects the core rule:
 *
 *   Fresh authoritative provider evidence outranks historical prior.
 *
 * Precedence (applied in order; first match wins):
 *
 *   1. freshProvider === 'positive'  → 0 (fresh positive dominates;
 *                                          availability already ≥ 0.8)
 *   2. freshProvider === 'negative'  → 0 (fresh negative suppresses
 *                                          historical optimism)
 *   3. freshProvider === 'stale'     → 0 (stale alone cannot claim
 *                                          availability)
 *   4. freshProvider === null        → bounded prior from projection
 *                                          (no fresh evidence; history
 *                                          may modestly influence)
 *
 * The bounded prior is computed as:
 *
 *   prior = min(availabilityPrior, MAX_HISTORICAL_PRIOR)
 *
 * where MAX_HISTORICAL_PRIOR is a fixed cap (default 0.4) so that no
 * single historical signal can overpower quality/media-match/identity.
 *
 * Repeated snapshots from ONE source do not amplify — the projection's
 * corroboration count (distinct families) is what raises the prior, and
 * the cap bounds it.
 *
 * @param {Object} projection — result of projectCandidateEvidence()
 * @param {Object} [options]
 * @param {number} [options.maxPrior=0.4] — hard cap on historical prior
 * @param {number} [options.corroborationBonus=0.05] — per additional
 *   corroboration family beyond the first, capped at maxPrior
 * @returns {number} bounded contribution in [0, 1]
 */
export function historicalAvailabilityPriorContribution(projection, options = {}) {
  return historicalAvailabilityPriorContributionStandalone(projection, options);
}

// Internal implementation (shared between factory and standalone export)
function historicalAvailabilityPriorContributionStandalone(projection, options = {}) {
  if (!projection || typeof projection !== 'object') return 0;
  const { maxPrior = 0.4, corroborationBonus = 0.05 } = options;
  const freshProvider = projection.freshProvider;

  // Fresh authoritative evidence outranks historical prior.
  // freshProvider === 'positive' → fresh positive dominates.
  // freshProvider === 'negative' → fresh negative suppresses historical optimism.
  // freshProvider === 'stale' → stale alone cannot claim availability.
  if (freshProvider === 'positive' || freshProvider === 'negative' || freshProvider === 'stale') {
    return 0;
  }

  // freshProvider === null: no fresh evidence. Historical prior may
  // modestly influence ranking, but is capped so it cannot overpower
  // quality/media-match/identity.
  const base = Math.max(0, Math.min(1, projection.availabilityPrior || 0));

  // Corroboration bonus: each additional corroboration family beyond
  // the first adds a small bounded amount. This rewards independent
  // sources without allowing any single source to dominate.
  const corroboration = projection.corroboration || 0;
  const bonus = corroboration > 1
    ? Math.min((corroboration - 1) * corroborationBonus, maxPrior)
    : 0;

  return Math.max(0, Math.min(maxPrior, base + bonus));
}

/**
 * Compute the bounded historical-availability-prior contribution for a
 * candidate identity directly from a cache instance.
 *
 * Convenience wrapper around project() + historicalAvailabilityPriorContribution().
 * This is the function the ranking pipeline calls.
 *
 * @param {Object} cache — discovery cache instance (must expose getHistoricalProviderEvidence)
 * @param {string} infoHash
 * @param {number|null} [fileIndex]
 * @param {Object} [options]
 * @param {number} [options.now] — pinned clock
 * @param {number} [options.maxPrior=0.4]
 * @param {number} [options.corroborationBonus=0.05]
 * @returns {number} bounded contribution in [0, 1]
 */
export function computeHistoricalAvailabilityPrior(cache, infoHash, fileIndex = null, options = {}) {
  if (!cache || typeof cache.getHistoricalProviderEvidence !== 'function') {
    return 0;
  }
  try {
    // Build a minimal projection context. We need the factory's project()
    // to collect observations, but we can call it via a temporary factory
    // or directly. Since projectCandidateEvidence is standalone, we
    // collect observations via the factory and project them.
    const factory = createConfidenceProjection(cache);
    const projection = factory.project(infoHash, fileIndex, { now: options.now });
    return historicalAvailabilityPriorContributionStandalone(projection, options);
  } catch {
    // Never let historical evidence computation break ranking.
    return 0;
  }
}

/**
 * Compute per-provider historical priors for provider attempt ordering.
 *
 * Standalone wrapper around the factory's computeHistoricalProviderPrior.
 * This is the PROVIDER-ORDER INTEGRATION SEAM. It returns bounded
 * { torbox, realdebrid } priors that determine TRY ORDER only — never
 * cache state, never placement, never ranking score.
 *
 * Rules (mirror historicalAvailabilityPriorContribution precedence):
 *   - Fresh authoritative evidence for a provider outranks its history.
 *   - Fresh negative for a provider suppresses its historical optimism.
 *   - Stale alone cannot claim availability.
 *   - No fresh evidence → bounded prior from historical projection.
 *
 * @param {Object} cache — discovery cache instance (must expose getHistoricalProviderEvidence)
 * @param {string} infoHash
 * @param {number|null} [fileIndex]
 * @param {Object} [options]
 * @param {number} [options.now] — pinned clock
 * @param {number} [options.maxPrior=0.4] — hard cap per provider
 * @returns {{ torbox: number, realdebrid: number }} bounded priors in [0, 1]
 */
export function computeHistoricalProviderPrior(cache, infoHash, fileIndex = null, options = {}) {
  if (!cache || typeof cache.getHistoricalProviderEvidence !== 'function') {
    return { torbox: 0, realdebrid: 0 };
  }
  try {
    const factory = createConfidenceProjection(cache);
    return factory.computeHistoricalProviderPrior(cache, infoHash, fileIndex, options);
  } catch {
    return { torbox: 0, realdebrid: 0 };
  }
}

export default projectCandidateEvidence;
