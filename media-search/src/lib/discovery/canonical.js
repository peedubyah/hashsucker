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
 * @property {Array<Object>} providerObservations - Provider observations (may be empty)
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
    providerObservations: normalizeProviderObservations(row.providers),
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
 * @returns {CanonicalCandidate} Normalized candidate
 */
export function toCanonicalLive(raw) {
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
    sources,
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

  // Merge provider observations: set-union by provider
  const obsByProvider = new Map();
  for (const obs of [...existing.providerObservations, ...incoming.providerObservations]) {
    obsByProvider.set(obs.provider, obs);
  }
  const mergedProviderObservations = Array.from(obsByProvider.values());

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
    sources: mergedSources,
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
  if (Array.isArray(providers)) {
    return providers.map((p) => ({
      provider: p.provider ?? 'unknown',
      cached: p.cached ?? null,
      evidence: p.evidence ?? null,
      checkedAt: p.checkedAt ?? null,
    }));
  }
  // Object form: { providerName: { cached, evidence } }
  return Object.entries(providers).map(([name, obs]) => ({
    provider: name,
    cached: obs?.cached ?? null,
    evidence: obs?.evidence ?? null,
    checkedAt: obs?.checkedAt ?? null,
  }));
}

/**
 * Map a canonical candidate back to a ranking-compatible hit shape.
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
  };
}
