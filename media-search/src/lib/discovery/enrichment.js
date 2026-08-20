/**
 * Metadata Enrichment Boundary
 *
 * Enriches candidates with media identity associations derived from
 * filename/title parsing. This boundary is separate from ingestion:
 *
 *   Candidate (from ingestion)
 *      |
 *      v
 *   Enrichment worker
 *      |
 *      v
 *   candidate_media associations
 *
 * Guarantees:
 * - Does NOT mutate candidate identity (infoHash, fileIndex)
 * - Does NOT create provider observations
 * - Only creates candidate_media associations
 * - Unknown matches remain unknown (no forced associations)
 * - Confidence is always explicit
 * - Existing associations are preserved (additive)
 *
 * Compatibility with research/ingestion-contract:
 * - Source/confidence/evidence concepts preserved
 * - candidate_media table is the association store
 * - Merge rules: higher confidence wins, equal → latest wins
 */

/**
 * Enrich a candidate by parsing its filename for media identity.
 * Only creates candidate_media associations — never mutates the candidate.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} enrichment - Enrichment result from a parser
 * @param {string} enrichment.infoHash - Candidate infoHash
 * @param {number|null} enrichment.fileIndex - Candidate fileIndex
 * @param {Array<Object>} enrichment.matches - Parsed media matches
 * @param {string} enrichment.matches[].mediaId - Media identifier
 * @param {number} enrichment.matches[].confidence - 0.0–1.0
 * @param {string} enrichment.source - Source of enrichment (e.g., 'filename-parser')
 * @param {Array<string>} enrichment.evidence - Evidence tags (e.g., ['title_exact_match', 'year_match'])
 * @returns {{ associated: number, skipped: number }} Counts
 */
export function enrichCandidate(cache, enrichment) {
  if (!cache || !enrichment) return { associated: 0, skipped: 0 };

  const { infoHash, fileIndex = null, matches = [], source, evidence = [] } = enrichment;

  let associated = 0;
  let skipped = 0;

  if (!matches) return { associated, skipped };

  // Normalize evidence to array
  const evidenceArr = Array.isArray(evidence) ? evidence : (evidence ? [evidence] : []);

  for (const match of matches) {
    if (!match || !match.mediaId) {
      skipped++;
      continue;
    }

    const confidence = match.confidence != null ? match.confidence : 0.5;

    // Check for existing association
    const existing = cache.getMediaAssociations(infoHash, fileIndex);
    const existingMatch = existing.find((a) => a.mediaId === match.mediaId);

    if (existingMatch) {
      // Update only if new confidence is higher or equal (latest wins)
      if (confidence >= existingMatch.confidence) {
        cache.associateMedia(infoHash, fileIndex, match.mediaId, {
          source: source || existingMatch.source,
          confidence,
          evidence: evidenceArr,
          associatedAt: Date.now(),
        });
        associated++;
      } else {
        skipped++;
      }
    } else {
      // New association
      cache.associateMedia(infoHash, fileIndex, match.mediaId, {
        source: source || 'enrichment',
        confidence,
        evidence: evidenceArr,
        associatedAt: Date.now(),
      });
      associated++;
    }
  }

  return { associated, skipped };
}

/**
 * Enrich multiple candidates in batch.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Array<Object>} enrichments - Array of enrichment results
 * @returns {{ associated: number, skipped: number }} Total counts
 */
export function enrichCandidates(cache, enrichments) {
  let totalAssociated = 0;
  let totalSkipped = 0;

  for (const enrichment of enrichments) {
    const result = enrichCandidate(cache, enrichment);
    totalAssociated += result.associated;
    totalSkipped += result.skipped;
  }

  return { associated: totalAssociated, skipped: totalSkipped };
}

/**
 * Query candidates that have no media associations (unknown identity).
 * These are candidates that ingestion created but enrichment hasn't resolved.
 *
 * @param {Object} cache - Discovery cache instance
 * @returns {Array<Object>} Candidates with no media associations
 */
export function getUnenrichedCandidates(cache) {
  if (!cache) return [];
  const allCandidates = cache.queryCachedCandidates();
  return allCandidates.filter((c) => {
    const associations = cache.getMediaAssociations(c.infoHash, c.fileIndex);
    return associations.length === 0;
  });
}
