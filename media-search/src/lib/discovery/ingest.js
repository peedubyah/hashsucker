/**
 * Ingestion Boundary
 *
 * Minimal contract for external ingestion sources to feed the candidate cache.
 * This boundary ensures all ingestion goes through the cache APIs, preserving:
 * - Candidate identity (infoHash, fileIndex)
 * - Source provenance (sources array)
 * - Media associations (candidate_media table)
 * - Provider observation separation (only when explicitly supplied)
 *
 * Future ingestion sources (DMM hashlists, scrapers, catalogs) call this
 * boundary. They do NOT depend on Stremio/Torznab and do NOT bypass cache APIs.
 */

const DEFAULT_SOURCE = 'unknown';

/**
 * Ingest candidates from an external source.
 *
 * @param {Object} cache - Discovery cache instance (createDiscoveryCache)
 * @param {Object} options
 * @param {string} options.source - Ingestion source identifier (e.g., 'dmm-hashlist', 'scraper')
 * @param {Array<Object>} options.entries - Ingested candidate entries
 * @param {Array<Object>[options.providerObservations] - Optional provider observations
 * @returns {{ inserted: number, updated: number, associated: number }} Counts
 */
export function ingestCandidates(cache, { source = DEFAULT_SOURCE, entries = [], providerObservations = [], generationId = null, fragmentName = null } = {}) {
  let inserted = 0;
  let updated = 0;
  let associated = 0;

  for (const entry of entries) {
    const result = ingestEntry(cache, source, entry);
    if (result.inserted) inserted++;
    if (result.updated) updated++;
    associated += result.associated;
  }

  // Record provider observations only if explicitly supplied. Ingestion must
  // declare whether evidence is authoritative, inferred, or predicted; legacy
  // payloads remain authoritative for compatibility but never gain an implicit TTL.
  for (const observation of providerObservations) {
    cache.appendProviderObservation({
      ...observation,
      kind: observation.kind ?? 'authoritative',
      source: observation.source ?? source,
    });
  }

  // DMM source provenance: record (candidate, source, fragment, generation)
  // observations. Idempotent — re-processing the same fragment in the same
  // generation does not amplify rows. Safe to call without generationId or
  // fragmentName (no-op) so existing callers that don't supply provenance
  // remain unchanged.
  if (generationId && fragmentName && cache.recordDmmSourceObservations) {
    cache.recordDmmSourceObservations({
      source,
      fragmentName,
      generationId,
      entries,
    });
  }

  return { inserted, updated, associated };
}

function ingestEntry(cache, source, entry) {
  const { mediaAssociations = [], providerObservations = [], ...candidateFields } = entry;

  // Preserve source provenance — tag sources with ingestion source
  const sources = (candidateFields.sources || []).map((s) => ({
    ...s,
    source,
  }));

  // Add ingestion source if no sources provided
  if (sources.length === 0) {
    sources.push({ id: source, kind: 'ingestion' });
  }

  const candidate = {
    ...candidateFields,
    sources,
  };

  // Check if candidate already exists
  const existing = cache.getCandidate(candidate.infoHash, candidate.fileIndex);

  // Upsert candidate through cache API (preserves identity, merges fields)
  cache.upsertCandidate(candidate);

  const inserted = !existing;
  const updated = !!existing;

  // Associate media identifiers
  let associated = 0;
  for (const mediaAssoc of mediaAssociations) {
    const before = cache.getMediaAssociations(candidate.infoHash, candidate.fileIndex);
    cache.associateMedia(candidate.infoHash, candidate.fileIndex, mediaAssoc.mediaId, {
      source,
      confidence: mediaAssoc.confidence ?? 1.0,
    });
    const after = cache.getMediaAssociations(candidate.infoHash, candidate.fileIndex);
    if (after.length > before.length) associated++;
  }

  return { inserted, updated, associated };
}
