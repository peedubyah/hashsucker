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
import { emit, EVENTS } from '../../lib/trace/events.js';
import { inc, recordScore, recordTopNCacheState } from '../../lib/metrics.js';
import { rankHits, countIdentityEligibility, aggregateIdentityTiers, shadowRankComparison, rankHitsTiered, diagnoseTopCandidates, evaluateIdentityEligibility } from './ranking.js';
import { isEpisodeCovered } from './episode-coverage.js';
import { evaluateEligibility } from './rejection.js';
import { RejectionReason, RejectionTracker, createRejection, describeRejection } from './rejection-tracker.js';
import { parseFilename } from './parser-adapter.js';
import { RequestTiming } from '../requests/timing.js';
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
 * Derive transient release attributes for a live candidate's filename.
 *
 * Reuses the same parser proven for corpus ingestion. Returns the shape
 * coversEpisode() expects ({ season, episode, episodeRange, seasonOnly,
 * mediaType }), or null when the filename carries no usable structural
 * season/episode evidence. The caller treats null as
 * "unknown episode coverage" and rejects fail-closed.
 *
 * @param {string|null|undefined} filename
 * @returns {Object|null}
 */
function deriveLiveReleaseAttributes(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const parsed = parseFilename(filename);
  if (!parsed || !parsed.parsed) return null;
  const p = parsed.parsed;
  if (p.season == null && p.episode == null && !p.episodeRange && p.mediaType !== 'season') {
    return null;
  }
  return {
    season: p.season ?? null,
    episode: p.episode ?? null,
    episodeRange: p.episodeRange ?? null,
    seasonOnly: p.seasonOnly === true || p.mediaType === 'season',
    mediaType: p.mediaType ?? null,
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
    emit(EVENTS.DISCOVERY_SEARCH, { query: options.query, mediaId: options.mediaId, cache: false });
    return { results: [], total: 0, query: {} };
  }

  emit(EVENTS.DISCOVERY_SEARCH, {
    query: options.query,
    mediaId: options.mediaId,
    filters: {
      year: options.year,
      season: options.season,
      episode: options.episode,
      resolution: options.resolution,
      source: options.source,
      codec: options.codec,
      hdr: options.hdr,
      audio: options.audio,
    },
  });

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
  // Corpus lookup is searchable by release identity: title, year,
  // season/episode, filename tokens. mediaId is NOT a required lookup
  // key — it only scopes identity confidence in ranking (via rankHits).
  // candidate_media associations are enrichment, not retrieval gates.
  let sql, countSql;
  const isWildcard = parsed.match === '*';

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
      WHERE ${where}
      ORDER BY ra.parsed_at DESC
      LIMIT @limit OFFSET @offset
    `;
    countSql = `
      SELECT COUNT(*) as total
      FROM release_attributes ra
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
      WHERE release_search MATCH @match
        AND ${where}
      ORDER BY bm25_score ASC
      LIMIT @limit OFFSET @offset
    `;
    countSql = `
      SELECT COUNT(*) as total
      FROM release_search rs
      JOIN release_attributes ra ON ra.rowid = rs.rowid
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
  };

  const rows = stmt.all(queryParams);
  const countRow = countStmt.get({
    ...(isWildcard ? {} : { match: parsed.match }),
    ...params,
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
      }).filter((observation) => observation.freshness === 'fresh' && observation.fresh === true),
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

  // Timing instrumentation — non-blocking, fail-safe
  const timing = new RequestTiming('combined-search');

  try {
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
    timing.start('corpus.lookup');
    const corpusResult = searchReleases(cache, {
      ...searchOptions,
      limit: effectiveRetrievalWindow,
      offset: 0,  // Stage 1 retrieval always starts at 0 — pagination happens AFTER rank
      includeProviders: true,
      includeMedia: true,
    });
    timing.end('corpus.lookup', 'completed');

    // Media-scoped eligibility: require candidate_media association
    const mediaId = searchOptions.mediaId || null;

    // Convert local results to canonical evidence shape
    const canonicalLocal = corpusResult.results.map(toCanonicalLocal);

    // Rejection tracker — every candidate that doesn't make it to results
    // gets a rejection record. No silent discards.
    const rejectionTracker = new RejectionTracker();

    // Optionally run live discovery and normalize to canonical shape.
    // When mediaId is set, live discovery is already scoped by selected media
    // intent — the liveDiscoveryFn receives mediaId and returns only candidates
    // relevant to that media. No persisted candidate_media is required.
    let canonicalLive = [];
    let liveDebug = {
      started: false,
      providersAttempted: 0,
      providersSucceeded: 0,
      candidatesReturned: 0,
      candidatesRejected: 0,
      errors: [],
    };
    if (includeLive && typeof liveDiscoveryFn === 'function') {
      timing.start('live.discovery');
      liveDebug.started = true;
      try {
        const result = await liveDiscoveryFn(options);
        // Support both shapes: array (legacy) and { releases, sources } (with counts)
        let liveResults = [];
        let liveSources = {};
        if (Array.isArray(result)) {
          liveResults = result;
        } else if (result && typeof result === 'object') {
          liveResults = result.releases || [];
          liveSources = result.sources || {};
        }
        liveDebug.providersAttempted = Object.keys(liveSources).length;
        liveDebug.providersSucceeded = Object.values(liveSources).filter(s => !s.error).length;
        for (const [name, src] of Object.entries(liveSources)) {
          if (src.error) liveDebug.errors.push({ provider: name, error: src.error });
        }
        liveDebug.candidatesReturned = liveResults.length;
        if (liveResults && Array.isArray(liveResults)) {
          // Filter out candidates with no infoHash — track as rejected
          const withHash = [];
          for (const r of liveResults) {
            if (r.infoHash) {
              withHash.push(r);
            } else {
              rejectionTracker.recordMissingHash(r);
              liveDebug.candidatesRejected++;
            }
          }
          // Tag live candidates with selected-media intent provenance when
          // mediaId is set. This preserves the invariant that live discovery
          // was already scoped by the selected media, without manufacturing
          // a candidate_media row or treating live intent as persisted identity.
          canonicalLive = withHash.map(r => toCanonicalLive(r, { selectedMediaId: mediaId }));
        }
        timing.end('live.discovery', 'completed');
      } catch (error) {
        // Live discovery failure must not break corpus results
        timing.fail('live.discovery', error.message);
        liveDebug.errors.push({ provider: 'unknown', error: error.message });
        emit(EVENTS.DISCOVERY_ERROR, { scope: 'live', error: error.message });
      }
    }

    // Merge into single candidate pool (local + live)
    const allCandidates = [...canonicalLocal, ...canonicalLive];

    // Debug: track candidate flow through pipeline
    const pipelineDebug = {
      corpusCandidates: canonicalLocal.length,
      liveCandidates: canonicalLive.length,
      mergedCandidates: allCandidates.length,
      dedupedCandidates: 0,
      eligibleCandidates: 0,
      rankedCandidates: 0,
      returnedCandidates: 0,
      rejections: [],
    };

    let eligibleCandidates = allCandidates;

    // Deduplicate exact releaseKeys BEFORE ranking.
    // For exact duplicates: merge evidence; neither source blindly replaces.
    // Track duplicates as rejections.
    timing.start('candidate.dedup');
    const deduped = deduplicateByReleaseKey(allCandidates, {
      onDuplicate: (duplicate, surviving) => {
        rejectionTracker.recordDuplicate(duplicate, surviving.releaseKey);
        pipelineDebug.rejections.push({
          candidate: { hash: duplicate.hash, fileIndex: duplicate.fileIndex, releaseKey: duplicate.releaseKey },
          stage: 'deduplication',
          reason: `duplicate of ${surviving.releaseKey}`,
        });
      },
    });
    pipelineDebug.dedupedCandidates = deduped.length;
    timing.end('candidate.dedup', 'completed');

    // Build query intent for ranking. Merge explicit searchOptions fields
    // (route-passed intent.season / intent.episodes[0] from /api/search)
    // with text-parsed filters so the Stage 2 episode gate and identity
    // tier classifier both see the same constraints the SQL filter applied.
    // Without this merge, the gate silently no-ops for TV requests where
    // the caller passes season/episode via the route contract rather than
    // embedding them in the search query string.
    const parsed = _parseQuery(searchOptions.query || '');
    const queryIntent = {};
    if (searchOptions.season != null) queryIntent.season = searchOptions.season;
    else if (parsed.filters.season != null) queryIntent.season = parsed.filters.season;
    if (searchOptions.episode != null) queryIntent.episode = searchOptions.episode;
    else if (parsed.filters.episode != null) queryIntent.episode = parsed.filters.episode;
    if (searchOptions.mediaTitle) queryIntent.mediaTitle = searchOptions.mediaTitle;
    else if (parsed.filters.mediaTitle) queryIntent.mediaTitle = parsed.filters.mediaTitle;

    // Apply Stage 2 episode-coverage eligibility gate for LOCAL candidates.
    // Live candidates are also gated against the requested episode. Structural
    // filename evidence must unambiguously cover the requested (season, episode)
    // — upstream live-provider scoping is not trusted. This reuses the same
    // coversEpisode() machinery proven for corpus candidates; for live rows the
    // releaseAttributes are derived transiently from the live candidate's
    // per-file filename via the existing parser. A live candidate whose
    // filename cannot establish requested-episode coverage (unknown) is
    // rejected fail-closed, mirroring corpus identity philosophy.
    //
    // Season-pack deferral is intentionally NOT enabled here: the downstream
    // provider file-mapping path requires a candidate filename to perform the
    // exact-match against provider file inventory. A season-pack candidate
    // without an episode-specific filename cannot be resolved to a single
    // physical episode file today, so allowing it through this gate would
    // silently break file mapping. Rejection is correct; building the
    // downstream season-pack → episode-file resolution is a separate slice.
    //
    // Produce typed rejection reasons for diagnostics (not part of public results).
    timing.start('candidate.eligibility');
    eligibleCandidates = deduped;
    if (queryIntent.season != null && queryIntent.episode != null) {
      eligibleCandidates = deduped.filter(candidate => {
        // Resolve release attributes for the gate.
        // Corpus: already persisted via storeReleaseAttributes.
        // Live: derive transiently from per-file filename via the existing parser.
        let attrs = candidate.releaseAttributes || null;
        const isCorpus = candidate.sources.some(s => s.origin === 'corpus');
        if (!isCorpus) {
          attrs = deriveLiveReleaseAttributes(candidate.filename);
        }
        if (!attrs) {
          // No structural filename evidence for a TV episode request → reject.
          const reason = RejectionReason.UNKNOWN_EPISODE_COVERAGE;
          const description = describeRejection(reason);
          rejectionTracker.record(createRejection({
            hash: candidate.hash,
            fileIndex: candidate.fileIndex,
            releaseKey: candidate.releaseKey,
            reason,
            description,
          }));
          pipelineDebug.rejections.push({
            candidate: { hash: candidate.hash, fileIndex: candidate.fileIndex, releaseKey: candidate.releaseKey },
            stage: 'eligibility',
            reason,
            description,
          });
          return false;
        }
        const evaluation = evaluateEligibility(
          { ...candidate, releaseAttributes: attrs },
          queryIntent.season,
          queryIntent.episode
        );
        if (!evaluation.eligible) {
          rejectionTracker.record(createRejection({
            hash: candidate.hash,
            fileIndex: candidate.fileIndex,
            releaseKey: candidate.releaseKey,
            reason: evaluation.reason,
            description: evaluation.description,
          }));
          pipelineDebug.rejections.push({
            candidate: { hash: candidate.hash, fileIndex: candidate.fileIndex, releaseKey: candidate.releaseKey },
            stage: 'eligibility',
            reason: evaluation.reason,
            description: evaluation.description,
          });
        }
        return evaluation.eligible;
      });
    }
    pipelineDebug.eligibleCandidates = eligibleCandidates.length;

    // Stage 2b: Identity-eligibility gate (title cross-check) for corpus
    // candidates when the query carries an explicit mediaTitle. The POST
    // /api/media-request path uses this same gate (see media-request.js) —
    // we mirror it here so the GET /api/search discovery path also rejects
    // unrelated corpus rows (e.g. a candidate whose parsed title is a
    // completely different show from the user-selected media).
    //
    // Live candidates are already scoped by selected-media/live-discovery
    // intent and must NOT be rejected for lacking a parsed title match.
    const mediaTitleForGate = queryIntent.mediaTitle || null;
    if (mediaTitleForGate) {
      const titleGateIntent = { ...queryIntent, mediaTitle: mediaTitleForGate };
      eligibleCandidates = eligibleCandidates.filter(candidate => {
        if (!candidate.sources.some(s => s.origin === 'corpus')) return true;
        const evaluation = evaluateIdentityEligibility(candidate, titleGateIntent);
        if (!evaluation.eligible) {
          rejectionTracker.record(createRejection({
            hash: candidate.hash,
            fileIndex: candidate.fileIndex,
            releaseKey: candidate.releaseKey,
            reason: evaluation.reason,
            description: evaluation.description,
          }));
          pipelineDebug.rejections.push({
            candidate: { hash: candidate.hash, fileIndex: candidate.fileIndex, releaseKey: candidate.releaseKey },
            stage: 'identity-eligibility',
            reason: evaluation.reason,
            description: evaluation.description,
          });
        }
        return evaluation.eligible;
      });
    }
    pipelineDebug.eligibleCandidates = eligibleCandidates.length;
    timing.end('candidate.eligibility', 'completed');

    // Identity tier diagnostic — classify identity match quality before ranking.
    // Measurement only, no filtering. Exposes distribution of valid matches.
    timing.start('candidate.identity-tier');
    const identityTierCounts = aggregateIdentityTiers(eligibleCandidates, queryIntent, mediaId);
    timing.end('candidate.identity-tier', 'completed');

    // Shadow ranking comparison — hypothetical result sets without changing active ranking.
    // Measurement only, no filtering. Exposes what-if scenarios for identity filtering.
    timing.start('candidate.shadow-ranking');
    const shadowRanking = shadowRankComparison(eligibleCandidates, queryIntent, mediaId, limit);
    timing.end('candidate.shadow-ranking', 'completed');

    // ONE global deterministic rank across all eligible candidates.
    // Source origin does NOT determine desirability — evidence does.
    // Apply identity tier as primary precedence signal.
    timing.start('candidate.ranking');
    const rankingInputs = eligibleCandidates.map(toRankingInput);
    const { ranked, tierMeta } = rankHitsTiered(rankingInputs, queryIntent, mediaId);
    pipelineDebug.rankedCandidates = ranked.length;
    pipelineDebug.afterRanking = ranked.length;
    pipelineDebug.tieredRanking = tierMeta;

    // Identity evidence diagnostic — shows why each candidate received its tier
    timing.start('candidate.identity-diag');
    const identityDiagnostics = diagnoseTopCandidates(ranked, queryIntent, mediaId, limit);
    timing.end('candidate.identity-diag');

    const topRanked = ranked.slice(0, limit);
    const rankingComposition = {
      beforeRanking: {
        corpusCount: eligibleCandidates.filter(candidate => candidate.sources.some(source => source.origin === 'corpus')).length,
        liveCount: eligibleCandidates.filter(candidate => candidate.sources.some(source => source.origin === 'live')).length,
      },
      afterRanking: {
        corpusInTopN: topRanked.filter(candidate => candidate.sources.some(source => source.origin === 'corpus')).length,
        liveInTopN: topRanked.filter(candidate => candidate.sources.some(source => source.origin === 'live')).length,
      },
      liveCandidateRanks: ranked
        .filter(candidate => candidate.sources.some(source => source.origin === 'live'))
        .map(candidate => ({
          releaseKey: candidate.releaseKey,
          rank: candidate.justification?.rank ?? null,
          score: candidate.score,
        })),
    };

    // Extract ranking factor explanations for top candidates
    const rankingExplanations = extractRankingExplanations(ranked);

    timing.end('candidate.ranking', 'completed');

    // Pagination AFTER global rank. Source ordering cannot leak through.
    const total = ranked.length;
    pipelineDebug.paginationOffset = offset;
    pipelineDebug.paginationLimit = limit;
    const results = ranked.slice(offset, offset + limit);
    pipelineDebug.afterPagination = results.length;

    // Track paginated-out candidates as rejections
    for (let i = offset + limit; i < ranked.length; i++) {
      rejectionTracker.recordPaginated(ranked[i], i + 1, offset, limit);
      pipelineDebug.rejections.push({
        candidate: { hash: ranked[i].hash, fileIndex: ranked[i].fileIndex, releaseKey: ranked[i].releaseKey },
        stage: 'pagination',
        reason: `paginated out (position ${i + 1}, limit ${limit})`,
      });
    }

    // Map to UI-compatible shape if requested
    timing.start('candidate.selection');
    let mappedResults = [];
    try {
      mappedResults = mode === 'ui' ? results.map(mapToUIShape) : results;
    } catch (mappingError) {
      pipelineDebug.mappingError = mappingError.message;
    }
    pipelineDebug.afterMapping = mappedResults.length;
    pipelineDebug.returnedCandidates = mappedResults.length;
    timing.end('candidate.selection', 'completed');

    // Record metrics for each candidate
    for (const [index, result] of mappedResults.entries()) {
      const position = index + 1;

      // Source tracking
      inc('candidate_sources_total');
      const source = result._source || determineSourceOrigin(result);
      if (source === 'corpus' || source === 'merged') {
        inc('torrentio_candidates'); // Legacy name for corpus candidates
      }
      if (source === 'live' || source === 'merged') {
        inc('comet_candidates'); // Live candidates
      }

      // Score distribution
      if (result.score != null) {
        recordScore(result.score);
      }

      // Cache state tracking
      const cacheState = result.providers?.torbox?.cached;
      if (cacheState === true) {
        inc('cached_candidates');
      } else if (cacheState === false) {
        inc('uncached_candidates');
      } else {
        inc('unknown_cache_state');
      }

      // Top-N cache state
      recordTopNCacheState(position, cacheState === true);
    }

    // Track winner (first result)
    if (mappedResults.length > 0) {
      const winner = mappedResults[0];
      const winnerSource = winner._source || determineSourceOrigin(winner);
      if (winnerSource === 'corpus') {
        inc('winner_source_corpus');
      } else if (winnerSource === 'live') {
        inc('winner_source_live');
      } else if (winnerSource === 'merged') {
        inc('winner_source_merged');
      }

      const winnerCache = winner.providers?.torbox?.cached;
      if (winnerCache === true) {
        inc('winner_cache_cached');
      } else if (winnerCache === false) {
        inc('winner_cache_uncached');
      } else {
        inc('winner_cache_unknown');
      }
    }

    emit(EVENTS.DISCOVERY_RESULT, {
      query: corpusResult.query,
      mediaId: options.mediaId,
      results: mappedResults.length,
      total,
    });

    timing.complete();

    return {
      results: mappedResults,
      total,
      query: corpusResult.query,
      stats: getSearchStats(cache),
      // Debug/internal: all rejected candidates with reasons.
      // No candidate is silently discarded.
      debug: {
        rejections: rejectionTracker.getRejections(),
        liveDiscovery: liveDebug,
        pipeline: pipelineDebug,
        rankingComposition,
        rankingExplanations,
        identityTiers: identityTierCounts,
        shadowRanking,
        identityDiagnostics,
      },
      timing: timing.summary(),
    };
  } catch (error) {
    timing.complete();
    throw error;
  }
}

/**
 * Run a search and return full pipeline trace for diagnostics.
 *
 * Answers: "Why did I see these results?"
 *
 * Returns source counts, pipeline funnel, and candidate details
 * with provenance, justification, and rejection reasons.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} options - Same as combinedSearch, plus:
 * @param {Function} [options.liveDiscoveryFnWithCounts] - Returns { releases, sources }
 * @returns {Promise<Object>} Trace result
 */
export async function searchTrace(cache, options = {}) {
  const {
    limit = 50,
    offset = 0,
    includeLive = false,
    liveDiscoveryFnWithCounts = null,
    mode = 'raw',
    retrievalWindow = null,
    ...searchOptions
  } = options;

  const timing = new RequestTiming('search-trace');

  try {
    const effectiveRetrievalWindow = retrievalWindow
      || parseInt(process.env.RETRIEVAL_WINDOW, 10)
      || 2000;

    // Stage 1: Corpus retrieval
    timing.start('corpus.lookup');
    const corpusResult = searchReleases(cache, {
      ...searchOptions,
      limit: effectiveRetrievalWindow,
      offset: 0,
      includeProviders: true,
      includeMedia: true,
    });
    timing.end('corpus.lookup', 'completed');

    const mediaId = searchOptions.mediaId || null;
    const canonicalLocal = corpusResult.results.map(toCanonicalLocal);
    const rejectionTracker = new RejectionTracker();

    // Stage 1: Live retrieval with per-source counts
    let canonicalLive = [];
    let liveSources = {};
    if (includeLive && typeof liveDiscoveryFnWithCounts === 'function') {
      timing.start('live.discovery');
      try {
        const { releases, sources } = await liveDiscoveryFnWithCounts(options);
        liveSources = sources;
        const withHash = [];
        for (const r of releases) {
          if (r.infoHash) {
            withHash.push(r);
          } else {
            rejectionTracker.recordMissingHash(r);
          }
        }
        canonicalLive = withHash.map(r => toCanonicalLive(r, { selectedMediaId: mediaId }));
      } catch (error) {
        liveSources = { error: error.message };
        timing.fail('live.discovery', error.message);
      } finally {
        if (liveSources.error) {
          timing.fail('live.discovery', liveSources.error);
        } else {
          timing.end('live.discovery', 'completed');
        }
      }
    }

    const allCandidates = [...canonicalLocal, ...canonicalLive];
    const discovered = allCandidates.length;

    // Dedup
    timing.start('candidate.dedup');
    const deduped = deduplicateByReleaseKey(allCandidates, {
      onDuplicate: (duplicate, surviving) => {
        rejectionTracker.recordDuplicate(duplicate, surviving.releaseKey);
      },
    });
    timing.end('candidate.dedup', 'completed');

    // Episode eligibility gate
    const parsed = _parseQuery(searchOptions.query || '');
    const queryIntent = {};
    if (parsed.filters.season != null) queryIntent.season = parsed.filters.season;
    if (parsed.filters.episode != null) queryIntent.episode = parsed.filters.episode;

    timing.start('candidate.eligibility');
    let eligibleCandidates = deduped;
    if (queryIntent.season != null && queryIntent.episode != null) {
      eligibleCandidates = deduped.filter(candidate => {
        if (candidate.sources.some(s => s.origin === 'corpus')) {
          const evaluation = evaluateEligibility(candidate, queryIntent.season, queryIntent.episode);
          if (!evaluation.eligible) {
            rejectionTracker.record(createRejection({
              hash: candidate.hash,
              fileIndex: candidate.fileIndex,
              releaseKey: candidate.releaseKey,
              reason: evaluation.reason,
              description: evaluation.description,
            }));
          }
          return evaluation.eligible;
        }
        return true;
      });
    }
    pipelineDebug.eligibleCandidates = eligibleCandidates.length;

    // Stage 2b: Identity-eligibility gate (title cross-check) for corpus
    // candidates when the query carries an explicit mediaTitle.
    const mediaTitleForGate2 = searchOptions.mediaTitle || queryIntent.mediaTitle || null;
    if (mediaTitleForGate2) {
      const titleGateIntent2 = { ...queryIntent, mediaTitle: mediaTitleForGate2 };
      eligibleCandidates = eligibleCandidates.filter(candidate => {
        if (!candidate.sources.some(s => s.origin === 'corpus')) return true;
        const evaluation = evaluateIdentityEligibility(candidate, titleGateIntent2);
        if (!evaluation.eligible) {
          rejectionTracker.record(createRejection({
            hash: candidate.hash,
            fileIndex: candidate.fileIndex,
            releaseKey: candidate.releaseKey,
            reason: evaluation.reason,
            description: evaluation.description,
          }));
        }
        return evaluation.eligible;
      });
    }
    pipelineDebug.eligibleCandidates = eligibleCandidates.length;
    timing.end('candidate.eligibility', 'completed');

    // Identity eligibility diagnostic — measure only, no filtering
    timing.start('candidate.identity-diag');
    const identityEligibilityCounts = countIdentityEligibility(eligibleCandidates, queryIntent, mediaId);
    pipelineDebug.identityEligibility = identityEligibilityCounts;
    timing.end('candidate.identity-diag', 'completed');

    // Identity tier classification — classify identity match quality before ranking
    timing.start('candidate.identity-tier');
    const identityTierCounts = aggregateIdentityTiers(eligibleCandidates, queryIntent, mediaId);
    timing.end('candidate.identity-tier', 'completed');

    // Shadow ranking comparison — hypothetical result sets without changing active ranking
    timing.start('candidate.shadow-ranking');
    const shadowRanking = shadowRankComparison(eligibleCandidates, queryIntent, mediaId, limit);
    timing.end('candidate.shadow-ranking', 'completed');

    // Rank
    timing.start('candidate.ranking');
    const rankingInputs = eligibleCandidates.map(toRankingInput);
    const ranked = rankHits(rankingInputs, queryIntent, mediaId);
    const topRanked = ranked.slice(0, limit);
    const rankingComposition = {
      beforeRanking: {
        corpusCount: eligibleCandidates.filter(candidate => candidate.sources.some(source => source.origin === 'corpus')).length,
        liveCount: eligibleCandidates.filter(candidate => candidate.sources.some(source => source.origin === 'live')).length,
      },
      afterRanking: {
        corpusInTopN: topRanked.filter(candidate => candidate.sources.some(source => source.origin === 'corpus')).length,
        liveInTopN: topRanked.filter(candidate => candidate.sources.some(source => source.origin === 'live')).length,
      },
      liveCandidateRanks: ranked
        .filter(candidate => candidate.sources.some(source => source.origin === 'live'))
        .map(candidate => ({
          releaseKey: candidate.releaseKey,
          rank: candidate.justification?.rank ?? null,
          score: candidate.score,
        })),
    };
    const rankingExplanations = extractRankingExplanations(ranked);
    timing.end('candidate.ranking', 'completed');

    // Pagination
    const total = ranked.length;
    const results = ranked.slice(offset, offset + limit);

    // Track paginated-out
    for (let i = offset + limit; i < ranked.length; i++) {
      rejectionTracker.recordPaginated(ranked[i], i + 1, offset, limit);
    }

    timing.start('candidate.selection');
    const mappedResults = mode === 'ui' ? results.map(mapToUIShape) : results;
    timing.end('candidate.selection', 'completed');

    // Build candidate trace — derive identity fields.
    // mappedResults may be UI shape (infoHash/releaseKey) or raw (hash/fileIndex).
    const candidates = mappedResults.map((r, i) => {
      const hash = r.infoHash || r.hash;
      const fileIndex = r.fileIndex ?? null;
      const releaseKey = r.releaseKey || `${hash}:${fileIndex ?? 'torrent'}`;
      return {
        rank: i + 1,
        hash,
        fileIndex,
        releaseKey,
        filename: r.filename,
        score: r.score ?? null,
        source: r._source || null,
        provenance: r._provenance || r.provenance || null,
        justification: r._justification || r.justification || null,
      };
    });

    timing.complete();

    return {
      query: searchOptions.query || '',
      sources: {
        corpus: {
          queried: true,
          count: canonicalLocal.length,
        },
        live: includeLive ? {
          torrentio: liveSources.torrentio?.count ?? 0,
          torznab: liveSources.torznab?.count ?? 0,
          errors: {
            torrentio: liveSources.torrentio?.error || null,
            torznab: liveSources.torznab?.error || null,
          },
        } : { queried: false },
      },
      pipeline: {
        discovered,
        deduped: deduped.length,
        ranked: ranked.length,
        returned: results.length,
      },
      rankingComposition,
      rankingExplanations,
      identityTiers: identityTierCounts,
      shadowRanking,
      rejections: rejectionTracker.getRejections(),
      candidates,
      timing: timing.summary(),
    };
  } catch (error) {
    timing.complete();
    throw error;
  }
}

/**
 * Extract ranking factor explanations for top candidates.
 */
function extractRankingExplanations(ranked) {
  const extractExplanation = (candidate) => ({
    releaseKey: candidate.releaseKey,
    source: candidate.sources?.some(source => source.origin === 'live') ? 'live' : 'corpus',
    totalScore: candidate.score,
    scoreComponents: candidate.components ?? {},
    contributions: candidate.contributions ?? {},
  });

  const top10 = ranked.slice(0, 10).map(extractExplanation);
  const liveCandidates = ranked.filter(candidate => candidate.sources?.some(source => source.origin === 'live'));
  const top10Live = liveCandidates.slice(0, 10).map(extractExplanation);

  return {
    top10,
    top10Live,
    liveCandidateCount: liveCandidates.length,
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

  // Ranking evidence and visible provider evidence are intentionally separate.
  // The legacy providers map remains during the public-contract transition.
  const observations = r.providerEvidence || r.providerObservations || r.providers || [];
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
    providerObservations: Array.isArray(observations) ? observations : [],
    media: r.mediaAssociations || r.media || [],
    _source: source,
    // Preserve provenance through to the UI/public shape
    _sources: r.sources || [],
    _selectedMediaId: r.selectedMediaId || null,
    _provenance: r.provenance || null,
    _justification: r.justification || null,
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
