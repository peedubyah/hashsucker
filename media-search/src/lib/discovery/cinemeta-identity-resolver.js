/**
 * Cinemeta Identity Resolver
 *
 * Production identity resolver that queries Cinemeta (Stremio's metadata service)
 * to resolve media identity from candidate release attributes.
 *
 * Resolution strategy:
 * 1. Extract title, year, season, episode from parsed release attributes
 * 2. Search Cinemeta catalog for matching titles
 * 3. Verify year/season/episode alignment
 * 4. Return structured matches with confidence and evidence
 *
 * Confidence scoring:
 * - Title exact match: 0.5 base
 * - Title starts with query: 0.3 base
 * - Title contains query: 0.2 base
 * - Year match: +0.2
 * - Season/episode match: +0.3
 * - Cap at 1.0, minimum threshold 0.4
 *
 * Design principles:
 * - No side effects (read-only API calls)
 * - Never throws for "not found" (returns empty matches)
 * - Throws ResolverError only on infrastructure failures
 * - Does not force associations on ambiguous matches
 * - Preserves all provenance for audit trail
 */

import { searchCatalog, getMedia } from '../metadata/cinemeta.js';
import { ResolverError, BaseIdentityResolver } from './identity-resolver.js';

export class CinemetaIdentityResolver extends BaseIdentityResolver {
  constructor(options = {}) {
    super({
      sourceName: 'cinemeta',
      version: options.version || '1.0.0',
      enabled: options.enabled !== false,
    });
    this.fetchImpl = options.fetchImpl || globalThis.fetch || fetch;
    this.minConfidence = options.minConfidence ?? 0.4;
  }

  /**
   * Check if this resolver can handle the given candidate.
   * Requires a title or filename to search with.
   *
   * @param {Object} params
   * @param {Object} params.candidate - Candidate object
   * @param {Object|null} params.parsedAttributes - Strongest release attributes
   * @returns {boolean}
   */
  canResolve({ candidate, parsedAttributes }) {
    if (!this.enabled) return false;
    const title = this._extractSearchTitle(candidate, parsedAttributes);
    return title != null && title.length >= 2;
  }

  /**
   * Resolve media identity for a candidate.
   *
   * @param {Object} params
   * @param {Object} params.candidate - Candidate object
   * @param {Object|null} params.parsedAttributes - Strongest release attributes
   * @returns {Promise<Object>} { matches: [{ mediaId, mediaType, confidence, evidence }] }
   */
  async resolveIdentity({ candidate, parsedAttributes }) {
    const title = this._extractSearchTitle(candidate, parsedAttributes);
    if (!title || title.length < 2) {
      return { matches: [] };
    }

    const year = parsedAttributes?.year ?? null;
    const season = parsedAttributes?.season ?? null;
    const episode = parsedAttributes?.episode ?? null;

    try {
      // Search Cinemeta catalog
      const results = await searchCatalog(title, this.fetchImpl);

      if (!results || results.length === 0) {
        return { matches: [] };
      }

      // Score and filter results
      const matches = [];
      for (const result of results) {
        const score = this._scoreMatch({ result, title, year, season, episode });
        if (score.confidence >= this.minConfidence) {
          matches.push({
            mediaId: result.id,
            mediaType: result.type,
            confidence: score.confidence,
            evidence: score.evidence,
          });
        }
      }

      // Sort by confidence descending
      matches.sort((a, b) => b.confidence - a.confidence);

      // For series, verify season/episode exists
      const verifiedMatches = [];
      for (const match of matches) {
        if (match.mediaType === 'series' && season != null && episode != null) {
          const hasEpisode = await this._verifyEpisode(match.mediaId, season, episode);
          if (!hasEpisode) {
            // Downgrade confidence if episode not found
            match.confidence *= 0.7;
            match.evidence.push('episode_not_verified');
          } else {
            match.evidence.push('episode_verified');
          }
        }
        if (match.confidence >= this.minConfidence) {
          verifiedMatches.push(match);
        }
      }

      return { matches: verifiedMatches };
    } catch (error) {
      // Infrastructure failure — throw ResolverError
      throw new ResolverError(
        `Cinemeta resolution failed: ${error.message}`,
        'cinemeta-infrastructure',
        error
      );
    }
  }

  /**
   * Extract search title from parsed attributes or candidate.
   * Prefers parsed title, falls back to candidate title/filename.
   *
   * @param {Object} candidate
   * @param {Object|null} parsedAttributes
   * @returns {string|null}
   */
  _extractSearchTitle(candidate, parsedAttributes) {
    if (parsedAttributes?.title) {
      return parsedAttributes.title.trim();
    }
    if (candidate?.title) {
      return candidate.title.trim();
    }
    if (candidate?.filename) {
      // Remove extension and common release tokens for search
      return this._cleanFilename(candidate.filename);
    }
    return null;
  }

  /**
   * Clean a filename to extract a searchable title.
   * Removes extension, resolution, codec, release group tokens.
   *
   * @param {string} filename
   * @returns {string}
   */
  _cleanFilename(filename) {
    return filename
      .replace(/\.\w{3,4}$/, '') // Remove extension
      .replace(/[._]/g, ' ') // Dots and underscores to spaces
      .replace(/\b(1080p|720p|2160p|4k|hdr|bluray|web-dl|webrip|hdtv|x264|x265|hevc|aac|dts|atmos|multi|subs)\b/gi, '')
      .replace(/\b(s\d{1,2}e\d{1,2})\b/gi, '') // Remove season/episode tokens
      .replace(/\b(\d{4})\b/g, '') // Remove year tokens
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Score a Cinemeta result against the search parameters.
   *
   * @param {Object} params
   * @param {Object} params.result - Cinemeta result { id, type, title, year }
   * @param {string} params.title - Search title
   * @param {number|null} params.year - Search year
   * @param {number|null} params.season - Search season
   * @param {number|null} params.episode - Search episode
   * @returns {Object} { confidence, evidence }
   */
  _scoreMatch({ result, title, year, season, episode }) {
    const evidence = [];
    let confidence = 0;

    const resultTitle = (result.title || '').toLowerCase();
    const searchTitle = (title || '').toLowerCase();

    // Title match scoring
    if (resultTitle === searchTitle) {
      confidence += 0.5;
      evidence.push('title_exact_match');
    } else if (resultTitle.startsWith(searchTitle)) {
      confidence += 0.3;
      evidence.push('title_prefix_match');
    } else if (resultTitle.includes(searchTitle)) {
      confidence += 0.2;
      evidence.push('title_contains_match');
    } else {
      // Token overlap scoring for fuzzy matches
      const overlap = this._tokenOverlap(searchTitle, resultTitle);
      if (overlap > 0.7) {
        confidence += 0.25;
        evidence.push('title_token_match');
      } else if (overlap > 0.4) {
        confidence += 0.15;
        evidence.push('title_partial_token_match');
      } else {
        // Low title match — likely unrelated
        confidence += 0.05;
        evidence.push('title_weak_match');
      }
    }

    // Year match bonus
    if (year != null && result.year != null) {
      if (result.year === year) {
        confidence += 0.2;
        evidence.push('year_match');
      } else if (Math.abs(result.year - year) <= 1) {
        confidence += 0.1;
        evidence.push('year_close_match');
      } else {
        // Year mismatch — penalize
        confidence -= 0.15;
        evidence.push('year_mismatch');
      }
    }

    // Season/episode match bonus (for series)
    if (season != null && episode != null && result.type === 'series') {
      // We'll verify actual episode existence later
      // For now, give a small bonus for series match
      confidence += 0.15;
      evidence.push('series_match');
    } else if (result.type === 'movie' && (season != null || episode != null)) {
      // Movie result but candidate has season/episode — likely mismatch
      confidence -= 0.2;
      evidence.push('type_mismatch');
    }

    // Clamp to [0, 1]
    confidence = Math.max(0, Math.min(1, confidence));

    return { confidence, evidence };
  }

  /**
   * Calculate token overlap between two strings.
   * Returns a ratio of shared tokens to total unique tokens.
   *
   * @param {string} a
   * @param {string} b
   * @returns {number} Overlap ratio 0-1
   */
  _tokenOverlap(a, b) {
    const tokensA = new Set(a.split(/\s+/).filter(t => t.length > 2));
    const tokensB = new Set(b.split(/\s+/).filter(t => t.length > 2));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let overlap = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) overlap++;
    }
    return overlap / Math.max(tokensA.size, tokensB.size);
  }

  /**
   * Verify that a series has a specific season/episode.
   *
   * @param {string} mediaId - Cinemeta media ID
   * @param {number} season
   * @param {number} episode
   * @returns {Promise<boolean>}
   */
  async _verifyEpisode(mediaId, season, episode) {
    try {
      const media = await getMedia('series', mediaId, this.fetchImpl);
      if (!media || !media.videos) return false;
      return media.videos.some(
        v => v.season === season && v.episode === episode
      );
    } catch {
      // If verification fails, don't block resolution
      return false;
    }
  }
}
