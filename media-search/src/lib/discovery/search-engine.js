/**
 * Internal Search Engine
 *
 * HashSucker's core search capability — FTS5-backed full-text search
 * over the DMM-derived release corpus.
 *
 * Pipeline:
 *   Query text + filters
 *     → FTS5 full-text match (retrieval window)
 *     → Structured attribute filtering (year, season, resolution, etc.)
 *     → Rank by composite score using the pure ranking module
 *     → Return ranked candidates with parsed attributes + component scores
 *
 * The FTS5 index is maintained automatically by triggers on the
 * release_attributes table. No manual index management needed.
 *
 * Retrieval window contract:
 *   The retrieval window (how many candidate rows Stage 1 fetches before
 *   global ranking) is FIXED and INDEPENDENT of public pagination
 *   (limit/offset). This ensures:
 *     - Public page size cannot determine recall.
 *     - A stronger candidate cannot be silently hidden by a small LIMIT.
 *     - Pagination occurs only AFTER global desirability ranking.
 *
 *   Default retrieval window: 2000 rows (PROVISIONAL).
 *
 *   Empirical status:
 *     - The corrected synthetic fixture showed same-title documents receiving
 *       effectively identical BM25 scores, leaving rowid/insertion order as
 *       the effective ordering for that fixture. Therefore that synthetic setup
 *       cannot establish the production retrieval boundary.
 *     - Real DMM documents (with varying title tokens and metadata) may produce
 *       different BM25 scores. Only real-corpus measurement can determine
 *       whether a retrieval cap is needed and what size it should be.
 *     - The provisional 2000 window has NOT been validated against real corpus data.
 *
 *   Override via RETRIEVAL_WINDOW env or options.retrievalWindow.
 */

import { createReleaseIdentity, createReleaseKey } from '../../api/release-contract.js';
import { rankHits } from './ranking.js';
import { isEpisodeCovered } from './episode-coverage.js';
import { evaluateEligibility, RejectionReason } from './rejection.js';
import {
  toCanonicalLocal,
  toCanonicalLive,
  deduplicateByReleaseKey,
  toRankingInput,
} from './canonical.js';

/**
 * Build FTS5 MATCH expression from user query.
 * Handles:
 * - Plain terms: "black mirror" → title : black mirror
 * - Phrases: '"black mirror"' → title : "black mirror"
 * - Year filter: treated as filter, not FTS term
 * - Season/episode: treated as filter, not FTS term
 *
 * @param {string} query - Raw user query
 * @returns {{ match: string, filters: Object }}
 */
function _parseQuery(query) {
  if (!query || typeof query !== 'string') {
    return { match: '*', filters: {} };
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return { match: '*', filters: {} };
  }

  const filters = {};
  let matchParts = [];

  // Extract year (4-digit number that looks like a year)
  const yearMatch = trimmed.match(/\b(19[3-9]\d|20[0-3]\d)\b/);
  if (yearMatch) {
    filters.year = parseInt(yearMatch[1], 10);
  }

  // Extract season/episode patterns: S01E01, s1e1, Season 1 Episode 1
  const seMatch = trimmed.match(/[Ss](\d{1,2})[Ee](\d{1,2})/);
  if (seMatch) {
    filters.season = parseInt(seMatch[1], 10);
    filters.episode = parseInt(seMatch[2], 10);
  }

  // Extract resolution
  const resMatch = trimmed.match(/\b(2160p|1080p|720p|480p|360p|4k|8k)\b/i);
  if (resMatch) {
    const res = resMatch[1].toLowerCase();
    filters.resolution = res.includes('2160') || res === '4k' ? '2160p' : res;
  }

  // Extract source
  const sourceMatch = trimmed.match(/\b(blu[-\s]?ray|bdrip|brrip|web[-\s]?dl|webrip|hdtv|dvd|remux)\b/i);
  if (sourceMatch) {
    const src = sourceMatch[1].toLowerCase().replace(/[-\s]/g, '');
    if (src.includes('remux')) filters.source = 'Remux';
    else if (src.includes('bluray') || src.includes('bdrip') || src.includes('brrip')) filters.source = 'BluRay';
    else if (src.includes('webdl')) filters.source = 'WEB-DL';
    else if (src.includes('webrip')) filters.source = 'WEBRip';
    else if (src.includes('hdtv')) filters.source = 'HDTV';
    else if (src.includes('dvd')) filters.source = 'DVD';
  }

  // Remaining text is the title query (remove extracted filters)
  let titleQuery = trimmed;
  if (yearMatch) titleQuery = titleQuery.replace(yearMatch[0], '');
  if (seMatch) titleQuery = titleQuery.replace(seMatch[0], '');
  if (resMatch) titleQuery = titleQuery.replace(resMatch[0], '');
  if (sourceMatch) titleQuery = titleQuery.replace(sourceMatch[0], '');

  titleQuery = titleQuery.trim();

  if (titleQuery) {
    // Build FTS5 MATCH: each term becomes prefix-matchable
    const terms = titleQuery.split(/\s+/).filter(t => t.length > 0);
    if (terms.length > 0) {
      // Use AND semantics: all terms must match
      matchParts = terms.map(t => `"${t.replace(/"/g, '""')}"*`);
    }
  }

  return {
    match: matchParts.length > 0 ? matchParts.join(' AND ') : '*',
    filters,
    titleQuery: titleQuery || null,
  };
}

/**
 * Build SQL WHERE clause for structured filters.
 *
 * @param {Object} filters - Parsed filters from parseQuery
 * @returns {{ where: string, params: Object }}
 */
function buildFilterClause(filters) {
  const clauses = [];
  const params = {};

  if (filters.year != null) {
    clauses.push('ra.year = @year');
    params.year = filters.year;
  }
  if (filters.season != null) {
    clauses.push('ra.season = @season');
    params.season = filters.season;
    // When explicit episode intent exists alongside a season, do NOT filter
    // by exact episode in SQL. Episode ranges and season packs have NULL
    // episode but may still cover the requested episode. Precise coverage is
    // determined by the post-fetch hard eligibility gate.
  }
  if (filters.episode != null && filters.season == null) {
    // Season not specified — filter by exact episode only
    clauses.push('ra.episode = @episode');
    params.episode = filters.episode;
  }
  if (filters.resolution != null) {
    clauses.push('ra.resolution = @resolution');
    params.resolution = filters.resolution;
  }
  if (filters.source != null) {
    clauses.push('ra.source_type = @source');
    params.source = filters.source;
  }
  if (filters.codec != null) {
    clauses.push('ra.codec = @codec');
    params.codec = filters.codec;
  }
  if (filters.hdr != null) {
    clauses.push('ra.hdr = @hdr');
    params.hdr = filters.hdr;
  }
  if (filters.audio != null) {
    clauses.push('ra.audio = @audio');
    params.audio = filters.audio;
  }

  return {
    where: clauses.length > 0 ? clauses.join(' AND ') : '1=1',
    params,
  };
}

/**
 * Calculate quality bonus score from parsed attributes.
 *
 * @param {Object} attrs - Release attributes row
 * @returns {number} 0.0-1.0
 */
function qualityBonus(attrs) {
  let score = 0;

  // Resolution
  const resScore = QUALITY_TIERS[attrs.resolution] || 0;
  score += resScore * 0.4;

  // Source
  const srcScore = SOURCE_TIERS[attrs.source_type] || 0;
  score += srcScore * 0.3;

  // HDR bonus
  if (attrs.hdr === 1) score += 0.15;

  // Codec bonus (HEVC/x265 preferred for 4K)
  if (attrs.codec === 'x265' && attrs.resolution === '2160p') score += 0.1;
  else if (attrs.codec === 'x264' && attrs.resolution !== '2160p') score += 0.05;

  return Math.min(1.0, score);
}

/**
 * Calculate provider availability bonus.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {string} infoHash - Candidate infoHash
 * @param {number|null} fileIndex - Candidate fileIndex
 * @returns {number} 0.0-1.0
 */
function providerBonus(cache, infoHash, fileIndex) {
  if (!cache) return 0;

  // Ranking may use only fresh authoritative truth. Stale history, inferred
  // hints, and predictions remain visible evidence but cannot masquerade as a
  // current confirmed cache observation.
  const observations = cache.getProviderObservations(infoHash, fileIndex, {
    includeStale: false,
    kinds: ['authoritative'],
  });
  if (observations.length === 0) return 0;

  const cached = observations.filter(o => o.state === 'cached');
  if (cached.length === 0) return 0;

  // More cached providers = higher bonus
  // Single provider: 0.4, two: 0.7, three+: 1.0
  return Math.min(1.0, 0.4 + (cached.length - 1) * 0.3);
}

/**
 * Search the internal index.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} options - Search options
 * @param {string} options.query - User search query
 * @param {number} [options.year] - Filter by year
 * @param {number} [options.season] - Filter by season
 * @param {number} [options.episode] - Filter by episode
 * @param {string} [options.resolution] - Filter by resolution
 * @param {string} [options.source] - Filter by source type
 * @param {number} [options.limit] - Max results (default 50)
 * @param {number} [options.offset] - Pagination offset
 * @param {boolean} [options.includeProviders] - Include provider observations
 * @param {string} [options.mediaId] - Selected media ID for eligibility scoping
 *   When provided, only candidates with an explicit candidate_media association
 *   to this mediaId are eligible. Identity confidence is scoped to this association.
 * @returns {{ results: Array, total: number, query: Object }}
 */
export function searchReleases(cache, options = {}) {
  if (!cache) {
    return { results: [], total: 0, query: {} };
  }

  const {
    query = '',
    year,
    season,
    episode,
    resolution,
    source,
    codec,
    hdr,
    audio,
    limit = 50,
    offset = 0,
    includeProviders = false,
    includeMedia = false,
    mediaId = null,
  } = options;

  // Parse query
  const parsed = _parseQuery(query);

  // Override parsed filters with explicit options
  if (year != null) parsed.filters.year = year;
  if (season != null) parsed.filters.season = season;
  if (episode != null) parsed.filters.episode = episode;
  if (resolution != null) parsed.filters.resolution = resolution;
  if (source != null) parsed.filters.source = source;
  if (codec != null) parsed.filters.codec = codec;
  if (hdr != null) parsed.filters.hdr = hdr;
  if (audio != null) parsed.filters.audio = audio;

  // Build filter clause
  const { where, params } = buildFilterClause(parsed.filters);

  // Build the search query
  // FTS5 BM25: lower score = more relevant
  // We invert so higher = better for composite scoring
  //
  // When mediaId is provided (selected-media path), we INNER JOIN with
  // candidate_media to require an explicit association between the exact
  // candidate (info_hash, file_index_key) and the selected mediaId.
  // This is the hard eligibility filter: no association → ineligible.
  let sql, countSql;
  const isWildcard = parsed.match === '*';

  // Media-scoped eligibility: require candidate_media association
  const mediaJoin = mediaId
    ? 'INNER JOIN candidate_media cm ON cm.info_hash = ra.info_hash AND cm.file_index_key = ra.file_index_key AND cm.media_id = @mediaId'
    : '';
  const mediaParam = mediaId ? { mediaId } : {};

  if (isWildcard) {
    // For wildcard/empty queries, don't use MATCH (not supported)
    sql = `
      SELECT
        ra.info_hash,
        ra.file_index_key,
        ra.filename,
        ra.title,
        ra.year,
        ra.season,
        ra.episode,
        ra.episode_range,
        ra.media_type,
        ra.resolution,
        ra.source_type,
        ra.codec,
        ra.hdr,
        ra.audio,
        ra.release_group,
        ra.confidence,
        ra.evidence,
        0 as bm25_score
      FROM release_attributes ra
      ${mediaJoin}
      WHERE ${where}
      ORDER BY ra.parsed_at DESC
      LIMIT @limit OFFSET @offset
    `;
    countSql = `
      SELECT COUNT(*) as total
      FROM release_attributes ra
      ${mediaJoin}
      WHERE ${where}
    `;
  } else {
    sql = `
      SELECT
        ra.info_hash,
        ra.file_index_key,
        ra.filename,
        ra.title,
        ra.year,
        ra.season,
        ra.episode,
        ra.episode_range,
        ra.media_type,
        ra.resolution,
        ra.source_type,
        ra.codec,
        ra.hdr,
        ra.audio,
        ra.release_group,
        ra.confidence,
        ra.evidence,
        bm25(release_search) as bm25_score
      FROM release_search rs
      JOIN release_attributes ra ON ra.rowid = rs.rowid
      ${mediaJoin}
      WHERE release_search MATCH @match
        AND ${where}
      ORDER BY bm25_score ASC
      LIMIT @limit OFFSET @offset
    `;
    countSql = `
      SELECT COUNT(*) as total
      FROM release_search rs
      JOIN release_attributes ra ON ra.rowid = rs.rowid
      ${mediaJoin}
      WHERE release_search MATCH @match
        AND ${where}
    `;
  }

  const stmt = cache.db.prepare(sql);
  const countStmt = cache.db.prepare(countSql);

  const queryParams = {
    ...(isWildcard ? {} : { match: parsed.match }),
    limit,
    offset,
    ...params,
    ...mediaParam,
  };

  const rows = stmt.all(queryParams);
  const countRow = countStmt.get({
    ...(isWildcard ? {} : { match: parsed.match }),
    ...params,
    ...mediaParam,
  });
  const total = countRow?.total || 0;

  // Score and rank results using the pure ranking module
  const queryIntent = {};
  if (parsed.filters.season != null) queryIntent.season = parsed.filters.season;
  if (parsed.filters.episode != null) queryIntent.episode = parsed.filters.episode;

  const hits = rows.map(row => {
    const bm25 = row.bm25_score || 0;
    const relevance = 1.0 / (1.0 + Math.abs(bm25));
    const fileIndexForKey = row.file_index_key === -1 ? null : row.file_index_key;

    // When mediaId is set, always fetch media associations for identity
    // confidence scoping (even if includeMedia output flag is false).
    // Identity confidence must come only from the selected-media association.
    const fetchMedia = includeMedia || mediaId != null;

    return {
      hash: row.info_hash,
      fileIndex: fileIndexForKey,
      filename: row.filename,
      relevance,
      releaseAttributes: {
        title: row.title,
        year: row.year,
        season: row.season,
        episode: row.episode,
        episodeRange: row.episode_range || null,
        seasonOnly: row.media_type === 'season',
        resolution: row.resolution,
        sourceType: row.source_type,
        codec: row.codec,
        hdr: row.hdr === 1,
        audio: row.audio,
        releaseGroup: row.release_group,
      },
      parserConfidence: row.confidence || 0.5,
      mediaAssociations: fetchMedia ? cache.getMediaAssociations(row.info_hash, fileIndexForKey) : [],
      // Only fresh authoritative observations may influence desirability ranking.
      // Full current evidence is attached separately for optional API output.
      providerObservations: cache.getProviderObservations(row.info_hash, fileIndexForKey, {
        includeStale: false,
        kinds: ['authoritative'],
      }),
      providerEvidence: cache.getProviderObservations(row.info_hash, fileIndexForKey),
    };
  });

  // Hard episode-coverage eligibility gate for explicit TV episode intent.
  // Must run BEFORE preference scoring: a release that does not cover the
  // requested episode is ineligible regardless of other evidence.
  // Only applies when the query carries explicit season+episode intent.
  let eligibleHits = hits;
  if (queryIntent.season != null && queryIntent.episode != null) {
    eligibleHits = hits.filter(hit =>
      isEpisodeCovered(hit.releaseAttributes, queryIntent.season, queryIntent.episode)
    );
  }

  // Pass mediaId for identity confidence scoping
  const ranked = rankHits(eligibleHits, queryIntent, mediaId);

  // Map back to the expected output format
  const results = ranked.map(r => ({
    hash: r.hash,
    fileIndex: r.fileIndex,
    releaseKey: createReleaseKey(r.hash, r.fileIndex),
    filename: r.filename,
    parsed: {
      ...r.releaseAttributes,
      source: r.releaseAttributes.sourceType,  // Backwards-compatible API field name
    },
    confidence: r.components.releaseConfidence,
    score: r.score,
    relevance: r.components.relevance,
    quality: r.components.quality,
    releaseConfidence: r.components.releaseConfidence,
    identityConfidence: r.components.identityConfidence,
    provider: r.components.providerAvailability,
    episodeMatch: r.components.episodeMatch,
    components: r.components,
    ...(includeProviders && { providers: r.providerEvidence }),
    ...(includeMedia && { media: r.mediaAssociations }),
  }));

  return {
    results,
    total,
    query: {
      match: parsed.match,
      filters: parsed.filters,
      titleQuery: parsed.titleQuery,
    },
  };
}

/**
 * Combined search: DMM corpus + live discovery (Torrentio/Torznab).
 *
 * Canonical normalization and global ranking pipeline:
 *
 *   Local corpus (ranked by FTS5, bounded retrieval window)
 *     → toCanonicalLocal()  → canonical evidence
 *   Live discovery
 *     → toCanonicalLive()   → canonical evidence
 *     → deduplicateByReleaseKey()  → exact merge
 *     → rankHits()          → one global deterministic rank
 *     → pagination
 *     → mapToUIShape()
 *
 * Retrieval window invariant:
 *   The Stage 1 retrieval window is FIXED (default 2000 rows) and INDEPENDENT
 *   of public pagination. Public `limit` controls post-rank page size only.
 *   This prevents public page size from determining candidate recall and
 *   ensures stronger eligible candidates cannot be silently hidden.
 *
 *   Measurement (100k-1M scale, realistic adversarial): 2000 rows gives
 *   See retrieval window contract above — window size is provisional pending
 *   real-corpus measurement.
 *
 * Other invariants:
 * - Source origin does NOT directly determine desirability score.
 * - Local/live copies of the SAME releaseKey merge evidence; neither source
 *   blindly replaces the other.
 * - Provider hints from Torrentio/Comet remain evidence only, not authoritative.
 * - Stage 2 hard eligibility remains intact for LOCAL corpus candidates.
 * - Live candidates do NOT require persisted candidate_media.
 * - Pagination happens AFTER global rank.
 * - Deterministic tie-breakers ensure identical input yields identical order.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} options - Search options
 * @param {string} options.query - User search query
 * @param {number} [options.year] - Filter by year
 * @param {number} [options.season] - Filter by season
 * @param {number} [options.episode] - Filter by episode
 * @param {string} [options.resolution] - Filter by resolution
 * @param {string} [options.source] - Filter by source type
 * @param {string} [options.codec] - Filter by codec
 * @param {number} [options.hdr] - Filter by HDR
 * @param {string} [options.audio] - Filter by audio format
 * @param {number} [options.limit] - Max results per page (default 50). POST-RANK.
 * @param {number} [options.offset] - Pagination offset. POST-RANK.
 * @param {number} [options.retrievalWindow] - Stage 1 retrieval limit (default 2000, env RETRIEVAL_WINDOW)
 * @param {boolean} [options.includeProviders] - Include provider observations
 * @param {boolean} [options.includeMedia] - Include media associations
 * @param {boolean} [options.includeLive] - Include live discovery results (Torrentio/Torznab)
 * @param {Function} [options.liveDiscoveryFn] - Async function that returns live discovery results
 * @param {string} [options.mode] - Output mode: 'raw' or 'ui' (default 'raw')
 * @param {string} [options.mediaId] - Selected media ID for eligibility scoping
 * @returns {{ results: Array, total: number, query: Object, stats: Object }}
 */
export async function combinedSearch(cache, options = {}) {
  const {
    limit = 50,
    offset = 0,
    includeLive = false,
    liveDiscoveryFn = null,
    mode = 'raw',
    retrievalWindow = null,  // null = use default 2000
    ...searchOptions
  } = options;

  // Stage 1 retrieval window: FIXED, independent of public page size.
  //
  // The 2000 default is PROVISIONAL. Empirical measurement against the real
  // DMM corpus is required to validate or replace it. See roadmap Stage 3
  // deferred measurement criterion.
  //
  // Public `limit` only controls post-rank pagination size — it never
  // determines which candidates can win.
  const effectiveRetrievalWindow = retrievalWindow
    || parseInt(process.env.RETRIEVAL_WINDOW, 10)
    || 2000;

  // Always search DMM corpus (returns locally-ranked results)
  const corpusResult = searchReleases(cache, {
    ...searchOptions,
    limit: effectiveRetrievalWindow,
    offset: 0,  // Stage 1 retrieval always starts at 0 — pagination happens AFTER rank
    includeProviders: true,
    includeMedia: true,
  });

  // Media-scoped eligibility: require candidate_media association
  const mediaId = searchOptions.mediaId || null;

  // Convert local results to canonical evidence shape
  const canonicalLocal = corpusResult.results.map(toCanonicalLocal);

  // Optionally run live discovery and normalize to canonical shape.
  // When mediaId is set, live discovery is already scoped by selected media
  // intent — the liveDiscoveryFn receives mediaId and returns only candidates
  // relevant to that media. No persisted candidate_media is required.
  let canonicalLive = [];
  if (includeLive && typeof liveDiscoveryFn === 'function') {
    try {
      const liveResults = await liveDiscoveryFn(options);
      if (liveResults && Array.isArray(liveResults)) {
        // Tag live candidates with selected-media intent provenance when
        // mediaId is set. This preserves the invariant that live discovery
        // was already scoped by the selected media, without manufacturing
        // a candidate_media row or treating live intent as persisted identity.
        canonicalLive = liveResults.map(r => toCanonicalLive(r, { selectedMediaId: mediaId }));
      }
    } catch (error) {
      // Live discovery failure must not break corpus results
      console.error(`Live discovery failed: ${error.message}`);
    }
  }

  // Merge into single candidate pool (local + live)
  const allCandidates = [...canonicalLocal, ...canonicalLive];

  // Deduplicate exact releaseKeys BEFORE ranking.
  // For exact duplicates: merge evidence; neither source blindly replaces.
  const deduped = deduplicateByReleaseKey(allCandidates);

  // Build query intent for ranking
  const parsed = _parseQuery(searchOptions.query || '');
  const queryIntent = {};
  if (parsed.filters.season != null) queryIntent.season = parsed.filters.season;
  if (parsed.filters.episode != null) queryIntent.episode = parsed.filters.episode;

  // Apply Stage 2 episode-coverage eligibility gate for LOCAL candidates.
  // Live candidates are already scoped by selected-media/live-discovery intent
  // and must NOT be rejected merely for lacking a persisted candidate_media row.
  //
  // Produce typed rejection reasons for diagnostics (not part of public results).
  const rejections = [];
  let eligibleCandidates = deduped;
  if (queryIntent.season != null && queryIntent.episode != null) {
    eligibleCandidates = deduped.filter(candidate => {
      // Local corpus: apply episode-coverage hard gate.
      // Requires candidate_media association (enforced by INNER JOIN in
      // searchReleases) AND episode coverage.
      if (candidate.sources.some(s => s.origin === 'corpus')) {
        const evaluation = evaluateEligibility(
          candidate,
          queryIntent.season,
          queryIntent.episode
        );
        if (!evaluation.eligible) {
          rejections.push({
            hash: candidate.hash,
            fileIndex: candidate.fileIndex,
            releaseKey: candidate.releaseKey,
            reason: evaluation.reason,
            description: evaluation.description,
          });
        }
        return evaluation.eligible;
      }
      // Live: already scoped by selected-media/live-discovery intent.
      // The liveDiscoveryFn was called with mediaId, so these candidates
      // are already relevant to the selected media. No persisted
      // candidate_media is required to enter the global ranking.
      return true;
    });
  }

  // ONE global deterministic rank across all eligible candidates.
  // Source origin does NOT determine desirability — evidence does.
  const rankingInputs = eligibleCandidates.map(toRankingInput);
  const ranked = rankHits(rankingInputs, queryIntent, mediaId);

  // Pagination AFTER global rank. Source ordering cannot leak through.
  const total = ranked.length;
  const results = ranked.slice(offset, offset + limit);

  // Map to UI-compatible shape if requested
  const mappedResults = mode === 'ui' ? results.map(mapToUIShape) : results;

  return {
    results: mappedResults,
    total,
    query: corpusResult.query,
    stats: getSearchStats(cache),
    // Debug/internal: typed rejection reasons for candidates that failed
    // hard eligibility. Not part of the normal public result list.
    // Only populated when explicit S/E intent produced rejections.
    debug: {
      rejections,
    },
  };
}

/**
 * Map a ranked result to the UI-compatible release shape.
 * Matches what prepareReleases() expects and the public DTO contract.
 *
 * Works with both canonical-local and canonical-live ranked results.
 * Preserves provenance (sources, selectedMediaId) so that UI source
 * inference can rely on actual origin evidence, not heuristics.
 */
function mapToUIShape(r) {
  const identity = createReleaseIdentity(r.hash, r.fileIndex);
  const attrs = r.releaseAttributes || r.parsed || {};

  // Normalize providers: ranked results carry providerObservations array;
  // public DTO expects { providerName: { cached, evidence } }
  const observations = r.providerObservations || r.providers || [];
  const providers = Array.isArray(observations)
    ? observations.reduce((acc, o) => {
        acc[o.provider] = {
          cached: o.cached,
          state: o.state,
          kind: o.kind,
          scope: o.scope,
          observedAt: o.observedAt,
          expiresAt: o.expiresAt,
          freshness: o.freshness,
          fresh: o.fresh,
          ageMs: o.ageMs,
          source: o.source,
          evidence: o.evidence,
          errorCategory: o.errorCategory,
          retryable: o.retryable,
          retryAfterMs: o.retryAfterMs,
        };
        return acc;
      }, {})
    : observations;

  // Determine source origin from provenance — never from whether title exists.
  // sources is the authoritative record of which origins contributed evidence.
  const source = determineSourceOrigin(r);

  return {
    ...identity,
    title: attrs.title || r.filename,
    filename: r.filename,
    size: attrs.size || null,
    resolution: attrs.resolution || null,
    quality: attrs.sourceType || null,
    codec: attrs.codec || null,
    hdr: attrs.hdr ? String(attrs.hdr) : null,
    audio: attrs.audio || null,
    releaseGroup: attrs.releaseGroup || null,
    year: attrs.year || null,
    season: attrs.season || null,
    episode: attrs.episode || null,
    confidence: r.components?.releaseConfidence ?? r.confidence ?? 0.5,
    score: r.score ?? 0,
    components: r.components || {},
    providers,
    media: r.mediaAssociations || r.media || [],
    _source: source,
    // Preserve provenance through to the UI/public shape
    _sources: r.sources || [],
    _selectedMediaId: r.selectedMediaId || null,
  };
}

/**
 * Determine source origin from provenance evidence.
 *
 * Uses the authoritative sources array to determine which origins contributed
 * to this result. Never infers origin from whether releaseAttributes.title exists,
 * as that would be unreliable for live results that may or may not have titles.
 *
 * @param {Object} r - Ranked result with sources array
 * @returns {string} Source origin: 'corpus', 'live', 'merged', or 'unknown'
 */
function determineSourceOrigin(r) {
  const sources = r.sources || [];
  if (sources.length === 0) return r._source || 'unknown';

  const origins = new Set(sources.map(s => s.origin));
  if (origins.has('corpus') && origins.has('live')) return 'merged';
  if (origins.has('corpus')) return 'corpus';
  if (origins.has('live')) return 'live';
  return r._source || 'unknown';
}

/**
 * Get search index statistics.
 *
 * @param {Object} cache - Discovery cache instance
 * @returns {Object} Index stats
 */
export function getSearchStats(cache) {
  if (!cache) return { indexed: 0, total: 0 };

  const indexed = cache.db.prepare('SELECT COUNT(*) as c FROM release_search').get();
  const total = cache.db.prepare('SELECT COUNT(*) as c FROM release_attributes').get();

  return {
    indexed: indexed?.c || 0,
    total: total?.c || 0,
  };
}

/**
 * Rebuild the entire FTS5 index from release_attributes.
 * Useful after bulk imports or schema changes.
 *
 * @param {Object} cache - Discovery cache instance
 * @returns {number} Number of rows indexed
 */
export function rebuildSearchIndex(cache) {
  if (!cache) return 0;

  // Clear existing index
  cache.db.exec("DELETE FROM release_search");

  // Rebuild from release_attributes
  const result = cache.db.exec(`
    INSERT INTO release_search(rowid, title, filename, resolution, source_type, codec, audio, release_group, language, media_type)
    SELECT rowid, title, filename, resolution, source_type, codec, audio, release_group, language, media_type
    FROM release_attributes
  `);

  const count = cache.db.prepare('SELECT COUNT(*) as c FROM release_search').get();
  return count?.c || 0;
}
