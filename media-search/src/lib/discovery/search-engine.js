/**
 * Internal Search Engine
 *
 * HashSucker's core search capability — FTS5-backed full-text search
 * over the DMM-derived release corpus.
 *
 * Pipeline:
 *   Query text + filters
 *     → FTS5 full-text match
 *     → Structured attribute filtering (year, season, resolution, etc.)
 *     → Rank by composite score using the pure ranking module
 *     → Return ranked candidates with parsed attributes + component scores
 *
 * The FTS5 index is maintained automatically by triggers on the
 * release_attributes table. No manual index management needed.
 */

import { rankHits } from './ranking.js';

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
  }
  if (filters.episode != null) {
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

  const observations = cache.getProviderObservations(infoHash, fileIndex);
  if (observations.length === 0) return 0;

  // Any cached provider gives bonus (cached may be boolean true or integer 1)
  const cached = observations.filter(o => o.cached === 1 || o.cached === true);
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

  const queryParams = isWildcard
    ? { limit, offset, ...params }
    : { match: parsed.match, limit, offset, ...params };

  const rows = stmt.all(queryParams);
  const countRow = countStmt.get(isWildcard ? { ...params } : { match: parsed.match, ...params });
  const total = countRow?.total || 0;

  // Score and rank results using the pure ranking module
  const queryIntent = {};
  if (parsed.filters.season != null) queryIntent.season = parsed.filters.season;
  if (parsed.filters.episode != null) queryIntent.episode = parsed.filters.episode;

  const hits = rows.map(row => {
    const bm25 = row.bm25_score || 0;
    const relevance = 1.0 / (1.0 + Math.abs(bm25));
    const fileIndexForKey = row.file_index_key === -1 ? null : row.file_index_key;

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
        resolution: row.resolution,
        sourceType: row.source_type,
        codec: row.codec,
        hdr: row.hdr === 1,
        audio: row.audio,
        releaseGroup: row.release_group,
      },
      parserConfidence: row.confidence || 0.5,
      mediaAssociations: includeMedia ? cache.getMediaAssociations(row.info_hash, fileIndexForKey) : [],
      // Always fetch provider observations for ranking (even if not included in output)
      providerObservations: cache.getProviderObservations(row.info_hash, fileIndexForKey),
    };
  });

  const ranked = rankHits(hits, queryIntent);

  // Map back to the expected output format
  const results = ranked.map(r => ({
    hash: r.hash,
    fileIndex: r.fileIndex,
    filename: r.filename,
    parsed: {
      ...r.releaseAttributes,
      source: r.releaseAttributes.sourceType,  // Backwards-compatible API field name
    },
    confidence: r.releaseAttributes.confidence,
    score: r.score,
    relevance: r.components.relevance,
    quality: r.components.quality,
    releaseConfidence: r.components.releaseConfidence,
    identityConfidence: r.components.identityConfidence,
    provider: r.components.providerAvailability,
    episodeMatch: r.components.episodeMatch,
    components: r.components,
    ...(includeProviders && { providers: r.providerObservations }),
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
