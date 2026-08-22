/**
 * Canonical Candidate Normalization
 *
 * Converts local corpus results and live discovery results into a single
 * provider-independent evidence shape for unified ranking.
 *
 * This module is pure — it does NOT:
 * - Perform I/O
 * - Mutate storage
 * - Depend on provider state
 *
 * Architectural position:
 *   Local corpus (ranked by FTS5)
 *     → toCanonicalLocal()  → canonical evidence
 *   Live discovery (Torrentio/Comet/Torznab)
 *     → toCanonicalLive()   → canonical evidence
 *     → mergeDuplicates()   → exact dedup
 *     → rankHits()          → one global deterministic rank
 */

import { createReleaseIdentity, createReleaseKey } from '../../api/release-contract.js';

/**
 * Canonical candidate evidence shape.
 *
 * This is the smallest shared internal candidate that allows rankHits()/
 * rankHit() to evaluate both local and live candidates consistently.
 *
 * @typedef {Object} CanonicalCandidate
 * @property {string} hash - Normalized infoHash
 * @property {number|null} fileIndex - File index (null = torrent-level)
 * @property {string} releaseKey - `${hash}:${fileIndex ?? 'torrent'}`
 * @property {string} filename - Release filename
 * @property {number} relevance - Title relevance (0.0-1.0)
 * @property {Object} releaseAttributes - Parsed release attributes
 * @property {number} parserConfidence - Parser confidence (0.0-1.0)
 * @property {Array<Object>} mediaAssociations - Media associations (may be empty)
 * @property {Array<Object>} providerObservations - Fresh authoritative rank evidence only
 * @property {Array<Object>} providerEvidence - Complete current typed provider evidence
 * @property {Array<Object>} sources - Provenance sources for evidence
 *   Each source: { origin, evidence, confidence, evidenceType }
 */

/**
 * Convert a local corpus search result to canonical evidence shape.
 *
 * Preserves:
 * - exact identity (infoHash, fileIndex)
 * - release attributes
 * - parser confidence
 * - selected-media association/confidence
 * - provider observations
 * - Stage 2 episode eligibility (caller must still apply this)
 *
 * @param {Object} row - Local search result from searchReleases()
 * @returns {CanonicalCandidate} Normalized candidate
 */
export function toCanonicalLocal(row) {
  const hash = row.hash;
  const fileIndex = row.fileIndex ?? null;
  const releaseKey = row.releaseKey || createReleaseKey(hash, fileIndex);

  return {
    hash,
    fileIndex,
    releaseKey,
    filename: row.filename,
    relevance: row.relevance ?? row.components?.relevance ?? 0,
    releaseAttributes: normalizeReleaseAttributes(row.parsed || row.releaseAttributes || {}),
    parserConfidence: row.confidence ?? row.components?.releaseConfidence ?? 0.5,
    mediaAssociations: normalizeMediaAssociations(row.media),
    providerObservations: normalizeProviderObservations(row.providerObservations ?? row.providers)
      .filter(isRankEligibleProviderObservation),
    providerEvidence: normalizeProviderObservations(row.providerEvidence ?? row.providers),
    sources: [
      {
        origin: 'corpus',
        evidence: row.evidence || [],
        confidence: row.confidence ?? 0.5,
        evidenceType: 'fts5-ranked',
      },
    ],
  };
}

/**
 * Convert a live discovery result to canonical evidence shape.
 *
 * Normalizes Torrentio/Comet/Torznab results into the SAME ranking input
 * as far as evidence allows.
 *
 * Missing evidence remains unknown/neutral rather than receiving arbitrary
 * bonuses or penalties.
 *
 * Does NOT:
 * - Manufacture candidate_media associations from live source hints
 * - Create authoritative provider observations from cache hints
 *
 * @param {Object} raw - Raw live discovery result from runLiveDiscovery()
 * @param {Object} [options] - Normalization options
 * @param {string|null} [options.selectedMediaId] - Selected media ID that scoped
 *   this live discovery. Preserved as intent provenance, NOT as persisted identity.
 * @returns {CanonicalCandidate} Normalized candidate
 */
export function toCanonicalLive(raw, options = {}) {
  const { selectedMediaId = null } = options;
  const hash = raw.infoHash;
  const fileIndex = raw.fileIndex ?? null;
  const releaseKey = raw.releaseKey || createReleaseKey(hash, fileIndex);

  // Release attributes from live source — only what's actually known
  const releaseAttributes = normalizeReleaseAttributes({
    title: raw.title,
    year: raw.year,
    season: raw.season,
    episode: raw.episode,
    resolution: raw.resolution,
    sourceType: raw.source,
    codec: raw.codec,
    hdr: raw.hdr,
    audio: raw.audio,
    releaseGroup: raw.releaseGroup,
  });

  // Provider hints from Torrentio/Comet remain evidence only.
  // They do NOT become authoritative provider observations.
  // Cache hints are transient and not persisted as ground truth.
  const providerObservations = [];

  // Provenance: track where evidence came from
  const sources = [];

  // Preserve provider cache hints as non-authoritative source/provenance evidence.
  // This ensures source/provider hints survive as evidence without becoming
  // authoritative provider_observations.
  if (raw.providers && typeof raw.providers === 'object') {
    for (const [providerName, hint] of Object.entries(raw.providers)) {
      if (hint && typeof hint === 'object') {
        sources.push({
          origin: 'live',
          evidence: hint.evidence || [],
          confidence: raw.confidence ?? 0.5,
          evidenceType: `provider-hint:${providerName}`,
          addonId: providerName,
          addonName: providerName,
          providerHint: {
            cached: hint.cached ?? null,
            evidence: hint.evidence || [],
          },
        });
      }
    }
  }

  if (raw.sources && Array.isArray(raw.sources)) {
    for (const src of raw.sources) {
      sources.push({
        origin: 'live',
        evidence: [],
        confidence: raw.confidence ?? 0.5,
        evidenceType: src?.addonId || src?.kind || 'live-discovery',
        addonId: src?.addonId || null,
        addonName: src?.addonName || null,
      });
    }
  } else {
    sources.push({
      origin: 'live',
      evidence: [],
      confidence: raw.confidence ?? 0.5,
      evidenceType: 'live-discovery',
    });
  }

  return {
    hash,
    fileIndex,
    releaseKey,
    filename: raw.filename || raw.title || '',
    // Live results have no query relevance — they are ID-matched, not text-matched.
    // NEUTRAL (0.5) is a neutral multiplier for the relevance component,
    // NOT a penalty or bonus.
    relevance: 0.5,
    releaseAttributes,
    parserConfidence: raw.confidence ?? 0.5,
    // Live candidates never have candidate_media associations.
    // Association requires explicit enrichment/persistence.
    mediaAssociations: [],
    providerObservations,
    providerEvidence: providerObservations,
    sources,
    // Selected-media intent provenance: preserved to show live discovery
    // was already scoped by the selected media. This is NOT persisted identity
    // evidence — it does not create a candidate_media row or contribute to
    // identity confidence. It simply records that the live source was already
    // filtered to the selected media before reaching the global ranker.
    selectedMediaId,
  };
}

/**
 * Merge exact duplicate releaseKeys BEFORE final ranking.
 *
 * Rules:
 * - Preserve all useful provenance (sources set-union)
 * - Preserve stronger/non-null compatible evidence where safe
 * - Do NOT fuzzy merge different releases
 * - Never merge same hash with different fileIndex
 * - Null index remains distinct from zero
 * - If local and live evidence conflict, don't silently overwrite
 *   high-confidence persisted evidence with weaker transient evidence
 *
 * Precedence rule (deterministic, smallest):
 * 1. Parser confidence: higher wins for release attributes
 * 2. Media associations: union (both sources contribute)
 * 3. Provider observations: union (both sources contribute)
 * 4. Sources: set-union by evidenceType+origin
 *
 * @param {CanonicalCandidate} existing - First-seen candidate
 * @param {CanonicalCandidate} incoming - Duplicate from other source
 * @returns {CanonicalCandidate} Merged candidate
 */
export function mergeExactDuplicates(existing, incoming) {
  // Identity invariants — these MUST match for this function to be called
  if (existing.releaseKey !== incoming.releaseKey) {
    throw new Error(
      `Cannot merge different releaseKeys: ${existing.releaseKey} vs ${incoming.releaseKey}`
    );
  }
  if (existing.hash !== incoming.hash) {
    throw new Error(
      `Cannot merge different hashes: ${existing.hash} vs ${incoming.hash}`
    );
  }
  if (existing.fileIndex !== incoming.fileIndex) {
    throw new Error(
      `Cannot merge different fileIndices: ${existing.fileIndex} vs ${incoming.fileIndex}`
    );
  }

  // Determine which candidate has stronger evidence
  const existingConf = existing.parserConfidence ?? 0;
  const incomingConf = incoming.parserConfidence ?? 0;
  const stronger = existingConf >= incomingConf ? existing : incoming;
  const weaker = stronger === existing ? incoming : existing;

  // Merge release attributes: stronger confidence wins per-field
  const mergedAttributes = { ...weaker.releaseAttributes };
  for (const [key, value] of Object.entries(stronger.releaseAttributes)) {
    if (value != null) {
      mergedAttributes[key] = value;
    }
  }

  // Merge media associations: set-union by mediaId
  const mediaById = new Map();
  for (const assoc of [...existing.mediaAssociations, ...incoming.mediaAssociations]) {
    const id = assoc.mediaId;
    const existing_assoc = mediaById.get(id);
    if (!existing_assoc || (assoc.confidence ?? 0) > (existing_assoc.confidence ?? 0)) {
      mediaById.set(id, assoc);
    }
  }
  const mergedMediaAssociations = Array.from(mediaById.values());

  // Merge provider evidence only for the same semantic observation identity.
  // Newest evidence wins; provider/account/scope/subject/kind never collapse.
  const mergedProviderEvidence = mergeProviderEvidence([
    ...(existing.providerEvidence ?? existing.providerObservations),
    ...(incoming.providerEvidence ?? incoming.providerObservations),
  ]);
  const mergedProviderObservations = mergedProviderEvidence.filter(isRankEligibleProviderObservation);

  // Merge sources: set-union by evidenceType+origin
  const sourceKey = (s) => `${s.origin}::${s.evidenceType}`;
  const sourcesById = new Map();
  for (const src of [...existing.sources, ...incoming.sources]) {
    const key = sourceKey(src);
    if (!sourcesById.has(key)) {
      sourcesById.set(key, src);
    }
  }
  const mergedSources = Array.from(sourcesById.values());

  // Merge selectedMediaId provenance:
  // - Preserve non-null selectedMediaId from whichever input has it
  // - If both inputs have non-null conflicting selectedMediaIds, throw
  //   (deterministic failure rather than silent pick-one)
  // - selectedMediaId is intent provenance, NOT identity evidence — it must
  //   NOT be added to mediaAssociations
  const existingSelected = existing.selectedMediaId ?? null;
  const incomingSelected = incoming.selectedMediaId ?? null;
  let mergedSelectedMediaId = null;
  if (existingSelected !== null && incomingSelected !== null) {
    if (existingSelected !== incomingSelected) {
      throw new Error(
        `Cannot merge conflicting selectedMediaIds: ${existingSelected} vs ${incomingSelected}`
      );
    }
    mergedSelectedMediaId = existingSelected;
  } else {
    mergedSelectedMediaId = existingSelected ?? incomingSelected;
  }

  return {
    hash: existing.hash,
    fileIndex: existing.fileIndex,
    releaseKey: existing.releaseKey,
    filename: stronger.filename || weaker.filename,
    relevance: Math.max(existing.relevance ?? 0, incoming.relevance ?? 0),
    releaseAttributes: mergedAttributes,
    parserConfidence: Math.max(existingConf, incomingConf),
    mediaAssociations: mergedMediaAssociations,
    providerObservations: mergedProviderObservations,
    providerEvidence: mergedProviderEvidence,
    sources: mergedSources,
    selectedMediaId: mergedSelectedMediaId,
  };
}

/**
 * Deduplicate candidates by exact releaseKey.
 *
 * For each releaseKey, keeps the first occurrence and merges subsequent
 * duplicates using mergeExactDuplicates().
 *
 * @param {CanonicalCandidate[]} candidates - Mixed local + live candidates
 * @returns {CanonicalCandidate[]} Deduplicated candidates
 */
export function deduplicateByReleaseKey(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = candidate.releaseKey;
    if (byKey.has(key)) {
      byKey.set(key, mergeExactDuplicates(byKey.get(key), candidate));
    } else {
      byKey.set(key, candidate);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Normalize release attributes to ensure consistent shape.
 *
 * @param {Object} attrs - Raw release attributes
 * @returns {Object} Normalized attributes
 */
function normalizeReleaseAttributes(attrs = {}) {
  if (!attrs || typeof attrs !== 'object') return {};
  return {
    title: attrs.title ?? null,
    year: attrs.year ?? null,
    season: attrs.season ?? null,
    episode: attrs.episode ?? null,
    episodeRange: attrs.episodeRange ?? null,
    seasonOnly: attrs.seasonOnly ?? false,
    resolution: attrs.resolution ?? null,
    sourceType: attrs.sourceType ?? null,
    codec: attrs.codec ?? null,
    hdr: attrs.hdr ?? false,
    audio: attrs.audio ?? null,
    releaseGroup: attrs.releaseGroup ?? null,
    mediaType: attrs.mediaType ?? null,
  };
}

/**
 * Normalize media associations to consistent shape.
 *
 * @param {Array<Object>|undefined} media - Raw media associations
 * @returns {Array<Object>} Normalized associations
 */
function normalizeMediaAssociations(media) {
  if (!Array.isArray(media)) return [];
  return media.map((m) => ({
    mediaId: m.mediaId,
    source: m.source ?? 'unknown',
    confidence: m.confidence ?? 0.5,
    evidence: m.evidence ?? null,
    associatedAt: m.associatedAt ?? null,
  }));
}

/**
 * Normalize provider observations to consistent shape.
 *
 * @param {Array<Object>|Object|undefined} providers - Raw provider observations
 * @returns {Array<Object>} Normalized observations
 */
function normalizeProviderObservations(providers) {
  if (!providers) return [];
  const entries = Array.isArray(providers)
    ? providers.map((observation) => [observation?.provider ?? 'unknown', observation])
    : Object.entries(providers);
  return entries.map(([name, raw]) => {
    const observation = raw ?? {};
    const cached = observation.cached ?? null;
    return {
      provider: name,
      accountScope: observation.accountScope ?? 'default',
      scope: observation.scope ?? 'candidate',
      subjectType: observation.subjectType ?? 'candidate',
      subjectKey: observation.subjectKey ?? null,
      kind: observation.kind ?? 'inferred',
      state: observation.state ?? (cached === true ? 'cached' : cached === false ? 'uncached' : 'unknown'),
      cached,
      observedAt: observation.observedAt ?? observation.checkedAt ?? null,
      checkedAt: observation.observedAt ?? observation.checkedAt ?? null,
      expiresAt: observation.expiresAt ?? null,
      freshness: observation.freshness ?? 'unbounded',
      fresh: observation.fresh ?? null,
      ageMs: observation.ageMs ?? null,
      expiresInMs: observation.expiresInMs ?? null,
      source: observation.source ?? 'legacy-provider-evidence',
      evidence: observation.evidence ?? null,
      errorCategory: observation.errorCategory ?? null,
      retryable: observation.retryable ?? null,
      retryAfterMs: observation.retryAfterMs ?? null,
    };
  });
}

function mergeProviderEvidence(observations) {
  const byIdentity = new Map();
  for (const observation of normalizeProviderObservations(observations)) {
    const key = [
      observation.provider, observation.accountScope, observation.scope,
      observation.subjectType, observation.subjectKey ?? '', observation.kind,
    ].join('\0');
    const existing = byIdentity.get(key);
    if (!existing || (observation.observedAt ?? -1) > (existing.observedAt ?? -1)) {
      byIdentity.set(key, observation);
    }
  }
  return [...byIdentity.values()].sort((a, b) =>
    `${a.provider}\0${a.accountScope}\0${a.scope}\0${a.subjectKey ?? ''}\0${a.kind}`
      .localeCompare(`${b.provider}\0${b.accountScope}\0${b.scope}\0${b.subjectKey ?? ''}\0${b.kind}`),
  );
}

function isRankEligibleProviderObservation(observation) {
  return observation.kind === 'authoritative'
    && observation.freshness === 'fresh'
    && observation.fresh === true;
}

/**
 * Map a canonical candidate back to a ranking-compatible hit shape.
 *
 * Preserves provenance (sources, selectedMediaId) through the ranking boundary
 * so that merged local/live evidence survives into the final ranked result.
 *
 * @param {CanonicalCandidate} candidate - Canonical candidate
 * @returns {Object} Ranking input shape for rankHit()
 */
export function toRankingInput(candidate) {
  return {
    hash: candidate.hash,
    fileIndex: candidate.fileIndex,
    filename: candidate.filename,
    relevance: candidate.relevance,
    releaseAttributes: candidate.releaseAttributes,
    parserConfidence: candidate.parserConfidence,
    mediaAssociations: candidate.mediaAssociations,
    providerObservations: candidate.providerObservations,
    providerEvidence: candidate.providerEvidence ?? candidate.providerObservations,
    sources: candidate.sources || [],
    selectedMediaId: candidate.selectedMediaId || null,
  };
}
