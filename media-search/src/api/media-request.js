/**
 * Media Request API
 *
 * Accepts a known media identity and returns ranked release candidates.
 * Pipeline:
 *   media ID → corpus retrieval → identity association → tier-aware ranking → explainable JSON
 *
 * Contract: media ID -> ranked release candidates -> explainable JSON response.
 */

import { createRequestIntent } from '../lib/requests/intent.js';
import { rankHitsTiered, classifyIdentityTier } from '../lib/discovery/ranking.js';
import { getStrongestReleaseAttributes } from '../lib/discovery/release-attributes.js';

/**
 * Search for release candidates by media identity.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} request - Media request
 * @param {string} request.mediaId - Media ID (IMDB, TMDB, etc.)
 * @param {string} request.mediaType - 'movie' or 'series'
 * @param {number} [request.season] - Season number (series only)
 * @param {number} [request.episode] - Episode number (series only)
 * @param {number} [request.limit=50] - Max results
 * @param {number} [request.offset=0] - Pagination offset
 * @param {boolean} [request.persist=true] - Persist results to database
 * @returns {Object} Ranked results with identity state and score breakdown
 */
export function searchByMedia(cache, request) {
  const mediaId = String(request.mediaId || '').trim();
  const mediaType = request.mediaType || 'movie';
  const season = request.season != null ? parseInt(request.season, 10) : null;
  const episode = request.episode != null ? parseInt(request.episode, 10) : null;
  const limit = Math.min(parseInt(request.limit, 10) || 50, 100);
  const offset = parseInt(request.offset, 10) || 0;
  const persist = request.persist !== false;

  if (!mediaId) {
    throw new Error('mediaId is required');
  }

  const intent = createRequestIntent({ type: mediaType, mediaId });

  // Stage 1: Retrieve candidates by media association
  const candidates = cache.queryCandidatesByMedia(mediaId);

  if (candidates.length === 0) {
    return {
      intent,
      results: [],
      total: 0,
      query: { mediaId, mediaType, season, episode },
      identitySummary: { tier: 'none', confidence: 0, evidence: [] },
      ranking: { TieredRankingApplied: false, TierCounts: {} },
    };
  }

  // Stage 2: Build ranking inputs with identity associations
  // Preserve metadata separately — rankHit() returns a new object that doesn't include custom fields
  const metadataByHash = new Map();

  const rankingInputs = candidates.map(candidate => {
    const attrs = getStrongestReleaseAttributes(cache, candidate.infoHash, candidate.fileIndex);
    const associations = cache.getMediaAssociations(candidate.infoHash, candidate.fileIndex);
    const observations = cache.getProviderObservations(candidate.infoHash, candidate.fileIndex, { includeStale: true });

    // Find association matching requested media
    const matchingAssoc = associations.find(a => a.mediaId === mediaId);
    const resolutionState = matchingAssoc?.resolutionState || 'unresolved';
    const evidence = matchingAssoc?.evidence || [];

    // Store metadata for post-ranking merge
    const key = `${candidate.infoHash}:${candidate.fileIndex ?? 'torrent'}`;
    metadataByHash.set(key, {
      resolutionState,
      evidence,
      matchMethod: matchingAssoc?.matchMethod,
      filename: candidate.filename,
    });

    return {
      hash: candidate.infoHash,
      fileIndex: candidate.fileIndex,
      releaseKey: key,
      filename: candidate.filename,
      relevance: 1.0, // Direct media match = max relevance
      releaseAttributes: attrs ? {
        title: attrs.title,
        year: attrs.year,
        season: attrs.season,
        episode: attrs.episode,
        resolution: attrs.resolution,
        source: attrs.sourceType,
        codec: attrs.codec,
        hdr: attrs.hdr,
        audio: attrs.audio,
        releaseGroup: attrs.releaseGroup,
      } : {},
      parserConfidence: attrs?.confidence ?? 0,
      mediaAssociations: associations.map(a => ({
        mediaId: a.mediaId,
        confidence: a.confidence,
        evidence: a.evidence || [],
        resolutionState: a.resolutionState || 'unresolved',
      })),
      providerObservations: observations,
      providerEvidence: observations,
      sources: candidate.sources || [{ origin: 'corpus', evidence: [], confidence: 0.5 }],
      selectedMediaId: mediaId,
      hasLiveDiscovery: false,
    };
  });

  // Stage 3: Rank within tier
  const { ranked, tierMeta } = rankHitsTiered(rankingInputs, { season, episode }, mediaId);

  // Stage 4: Paginate
  const total = ranked.length;
  const results = ranked.slice(offset, offset + limit);

  // Stage 5: Build explainable response
  const explainable = results.map((hit, index) => {
    // Restore metadata from pre-ranking store
    const key = `${hit.hash}:${hit.fileIndex ?? 'torrent'}`;
    const meta = metadataByHash.get(key) || {};

    const tier = classifyIdentityTier(
      {
        releaseAttributes: hit.releaseAttributes,
        mediaAssociations: hit.mediaAssociations,
        sources: hit.sources,
        relevance: hit.components?.relevance || 0,
        selectedMediaId: hit.selectedMediaId,
      },
      { season, episode },
      mediaId
    );

    return {
      rank: offset + index + 1,
      infoHash: hit.hash,
      fileIndex: hit.fileIndex,
      filename: hit.filename,
      score: hit.score,
      scoreBreakdown: hit.justification?.scoreBreakdown || {},
      identity: {
        tier: tier.IdentityTier,
        confidence: tier.IdentityConfidence,
        evidence: tier.IdentityEvidence || [],
        state: meta.resolutionState || 'unresolved',
        matchMethod: meta.matchMethod,
      },
      release: hit.releaseAttributes,
      observations: (hit.providerObservations || []).map(o => ({
        provider: o.provider,
        state: o.state,
        cached: o.state === 'cached',
        observedAt: o.observedAt,
      })),
    };
  });

  // Stage 6: Persist results
  let requestId = null;
  if (persist) {
    requestId = cache.persistMediaRequest(
      {
        mediaId: intent.mediaId,
        mediaType: intent.mediaType,
        season,
        episode,
      },
      explainable
    );
  }

  return {
    requestId,
    intent,
    results: explainable,
    total,
    query: { mediaId, mediaType, season, episode },
    identitySummary: summarizeIdentity(explainable),
    ranking: tierMeta,
  };
}

function summarizeIdentity(results) {
  if (results.length === 0) {
    return { tier: 'none', confidence: 0, evidence: [] };
  }

  const top = results[0];
  return {
    tier: top.identity?.tier || 'unknown',
    confidence: top.identity?.confidence || 0,
    evidence: top.identity?.evidence || [],
    totalCandidates: results.length,
    resolutionStates: results.reduce((acc, r) => {
      const state = r.identity?.state || 'unresolved';
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {}),
  };
}
