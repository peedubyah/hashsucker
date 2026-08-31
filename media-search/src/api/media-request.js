/**
 * Media Request API
 *
 * Accepts a known media identity and returns ranked release candidates.
 * Pipeline:
 *   media ID → corpus retrieval → identity association → tier-aware ranking → explainable JSON
 *
 * When corpus returns insufficient eligible candidates, falls back to live discovery
 * (Torrentio/Comet). Live results pass through the same identity eligibility gate.
 *
 * Contract: media ID -> ranked release candidates -> explainable JSON response.
 */

import { createRequestIntent } from '../lib/requests/intent.js';
import { rankHitsTiered, classifyIdentityTier, evaluateIdentityEligibility } from '../lib/discovery/ranking.js';
import { getStrongestReleaseAttributes } from '../lib/discovery/release-attributes.js';
import { evaluateObservationFreshness } from '../lib/providers/observations.js';
import { runLiveDiscovery } from '../lib/discovery/live-bridge.js';
import { createAvailabilityChecker } from '../lib/intents/availability.js';
import { selectBestCandidate } from '../lib/discovery/selection.js';
import { buildPlaybackHandoff } from '../lib/discovery/playback-handoff.js';
import { publishStrm } from '../lib/requests/strm-publisher.js';
import { notifyJellyfin } from '../lib/requests/jellyfin-notifier.js';
import { notifyPlex } from '../lib/requests/plex-notifier.js';
import { materializeVfsEntry } from '../lib/vfs/materialize.js';
import { DEMAND_PRIORITY } from '../lib/discovery/cache.js';

/**
 * Minimum eligible corpus candidates before live discovery is triggered.
 * Configurable via request.liveDiscoveryThreshold.
 */
const DEFAULT_LIVE_DISCOVERY_THRESHOLD = 1;

/**
 * Ensure the canonical STRM is materialized for an existing durable handoff.
 *
 * Idempotence invariant:
 *   handoff exists + STRM missing → recreate STRM
 *   handoff exists + STRM present → no-op
 *
 * This is called when no new candidates are produced (corpus empty, live discovery
 * empty) but a durable handoff already exists from prior work. The STRM may have
 * been deleted, or the handoff may predate STRM publisher integration.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {string} mediaId - Media identifier
 * @param {string} mediaType - 'movie' or 'episode'
 * @param {number|null} season - Season number (episodes only)
 * @param {number|null} episode - Episode number (episodes only)
 * @returns {Promise<{ strmPath: string|null, handoff: Object|null }>} Result
 */
async function ensureStrmForExistingHandoff(cache, mediaId, mediaType, season = null, episode = null) {
  // Look up existing handoff (if any). Movies key by mediaId only; episodes
  // must use exact season/episode identity to avoid ambiguity when a series
  // has multiple episode handoffs.
  let handoff;
  if (mediaType === 'episode') {
    handoff = cache.getTvPlaybackHandoff(mediaId, season, episode);
    if (!handoff) {
      return { strmPath: null, handoff: null };
    }
    // Normalize rowToPlaybackHandoff shape to the selection shape expected below
    handoff = {
      status: 'selected',
      requestId: handoff.requestId,
      mediaId: handoff.mediaId,
      mediaType: handoff.mediaType,
      season: handoff.season ?? null,
      episode: handoff.episode ?? null,
      releaseKey: handoff.releaseKey,
      selectedHash: handoff.infoHash,
      fileIndex: handoff.fileIndex,
      filename: handoff.filename,
      provider: handoff.provider,
      providerState: handoff.providerState,
      identityTier: handoff.identityTier,
      resolutionState: handoff.resolutionState,
      reason: handoff.selectionReason,
      selectedAt: handoff.selectedAt,
    };
  } else {
    handoff = cache.getExistingSelection(mediaId);
    if (!handoff || handoff.status !== 'selected') {
      return { strmPath: null, handoff: null };
    }
  }

  // Transform to camelCase shape expected by publishStrm
  const handoffObj = {
    requestId: handoff.requestId,
    mediaId: handoff.mediaId,
    mediaType: handoff.mediaType,
    season: handoff.season ?? null,
    episode: handoff.episode ?? null,
    releaseKey: handoff.releaseKey,
    infoHash: handoff.selectedHash,
    fileIndex: handoff.fileIndex,
    filename: handoff.filename,
    provider: handoff.provider,
    providerState: handoff.providerState,
    identityTier: handoff.identityTier,
    resolutionState: handoff.resolutionState,
    selectionReason: handoff.reason,
    selectedAt: handoff.selectedAt,
  };

  // Attempt STRM publication (idempotent - returns existing if present)
  const strmResult = await publishStrm({ handoff: handoffObj });

  if (strmResult.published && strmResult.path) {
    // Notify Jellyfin (non-blocking)
    notifyJellyfin({
      strmPath: strmResult.path,
      mediaId: handoff.mediaId,
      mediaType: handoff.mediaType,
    }).catch(() => {});
  }

  return { strmPath: strmResult.path || null, handoff: handoffObj };
}

/**
 * Get availability info for a candidate from stored observations.
 * @param {Object} hit - Ranked candidate
 * @returns {Object}
 */
function _getAvailabilityForCandidate(hit) {
  const observations = hit.providerObservations || [];
  const availability = {};

  for (const obs of observations) {
    if (obs.provider && obs.state) {
      const freshness = evaluateObservationFreshness(obs, { now: Date.now() });
      availability[obs.provider] = {
        state: obs.state,
        checkedAt: obs.observedAt,
        ageMs: freshness.ageMs,
        fileMetadata: obs.evidence?.fileMetadata || null,
      };
    }
  }

  return availability;
}

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
 * @param {number} [request.liveDiscoveryThreshold] - Min eligible corpus before live discovery
 * @param {boolean} [request.skipLiveDiscovery] - Skip live discovery fallback
 * @param {boolean} [request.skipAvailability] - Skip TorBox availability check
 * @returns {Promise<Object>} Ranked results with identity state and score breakdown
 */
export async function searchByMedia(cache, request) {
  const mediaId = String(request.mediaId || '').trim();
  const mediaType = request.mediaType || 'movie';
  const season = request.season != null ? parseInt(request.season, 10) : null;
  const episode = request.episode != null ? parseInt(request.episode, 10) : null;
  const limit = Math.min(parseInt(request.limit, 10) || 50, 100);
  const offset = parseInt(request.offset, 10) || 0;
  const persist = request.persist !== false;
  const liveDiscoveryThreshold = request.liveDiscoveryThreshold != null
    ? parseInt(request.liveDiscoveryThreshold, 10)
    : DEFAULT_LIVE_DISCOVERY_THRESHOLD;
  const skipLiveDiscovery = request.skipLiveDiscovery === true;
  const skipAvailability = request.skipAvailability === true;

  // Intent source metadata (optional)
  const source = request.source || null;
  const sourceType = request.sourceType || null;
  const sourceId = request.sourceId || null;
  const sourceLabel = request.sourceLabel || null;
  const requestedBy = request.requestedBy || null;
  const priority = request.priority ?? null;
  const mediaTitle = request.mediaTitle || null; // Optional: human-readable media name for identity verification
  const intentId = request.intentId != null ? request.intentId : null; // Optional: pre-existing media_intents.id (skips implicit upsert)

  if (!mediaId) {
    throw new Error('mediaId is required');
  }

  const intent = createRequestIntent({ type: mediaType, mediaId });

  // Stage 1: Retrieve candidates by media association
  const candidates = cache.queryCandidatesByMedia(mediaId);

  if (candidates.length === 0 && !skipLiveDiscovery) {
    // No corpus candidates — try live discovery
    let liveCandidates = [];
    let liveEligibleCount = 0;
    const liveMetadataByHash = new Map();
    const liveEligibilityByHash = new Map();
    let liveDiscoveryTriggered = true;
    let requestId = null;

    try {
      const liveResults = await runLiveDiscovery(mediaId, { season, episode });
      for (const live of liveResults) {
        const key = live.releaseKey;
        if (!key || !live.infoHash) continue;

        const releaseAttrs = {
          title: live.title || live.filename,
          year: live.year,
          season: live.season,
          episode: live.episode,
          episodeRange: live.episodeRange,
          seasonOnly: live.seasonOnly,
          mediaType: live.mediaType,
          resolution: live.resolution,
          source: live.source,
          codec: live.codec,
          hdr: live.hdr,
          audio: live.audio,
          releaseGroup: live.releaseGroup,
        };

        const eligibility = evaluateIdentityEligibility(
          { releaseAttributes: releaseAttrs },
          { season, episode, mediaType, mediaTitle }
        );
        liveEligibilityByHash.set(key, eligibility);
        if (eligibility.eligible) liveEligibleCount++;

        liveMetadataByHash.set(key, {
          filename: live.filename,
          releaseAttributes: releaseAttrs,
          providers: live.providers,
        });

        liveCandidates.push({
          hash: live.infoHash,
          fileIndex: live.fileIndex,
          releaseKey: key,
          filename: live.filename || live.title,
          relevance: 0.8,
          releaseAttributes: releaseAttrs,
          parserConfidence: live.confidence ?? 0.5,
          mediaAssociations: [],
          providerObservations: [],
          providerEvidence: [],
          sources: [{ origin: 'live', evidence: [], confidence: live.confidence ?? 0.5 }],
          selectedMediaId: mediaId,
          hasLiveDiscovery: true,
        });
      }
    } catch (error) {
      console.error(`Live discovery failed for ${mediaId}: ${error.message}`);
    }

    if (liveCandidates.length === 0) {
      // No candidates from corpus or live discovery — but an existing durable
      // handoff may still need its STRM materialized (idempotence invariant).
      const { strmPath } = await ensureStrmForExistingHandoff(cache, mediaId, mediaType, season, episode);
      return {
        requestId,
        intent,
        results: [],
        total: 0,
        query: { mediaId, mediaType, season, episode },
        identitySummary: { tier: 'none', confidence: 0, evidence: [] },
        ranking: { TieredRankingApplied: false, TierCounts: {} },
        discovery: { liveDiscoveryTriggered, liveCandidates: 0, liveEligible: 0 },
        availability: { checked: 0, cached: 0, uncached: 0, unknown: 0 },
        selection: { selected: null, reason: 'no candidates', alternates: [] },
        strmPath,
      };
    }

    // Rank live candidates
    const { ranked, tierMeta } = rankHitsTiered(liveCandidates, { season, episode, mediaTitle }, mediaId, liveEligibilityByHash);
    const total = ranked.length;
    const results = ranked.slice(offset, offset + limit);

    const explainable = results.map((hit, index) => {
      const key = `${hit.hash}:${hit.fileIndex ?? 'torrent'}`;
      const meta = liveMetadataByHash.get(key) || {};
      const eligibility = hit.eligibility || liveEligibilityByHash.get(key);

      const tier = classifyIdentityTier(
        { releaseAttributes: hit.releaseAttributes, mediaAssociations: hit.mediaAssociations, sources: hit.sources, relevance: hit.components?.relevance || 0, selectedMediaId: hit.selectedMediaId },
        { season, episode, mediaTitle }, mediaId
      );

      const identityTier = (eligibility && !eligibility.eligible) ? 'Ineligible' : tier.IdentityTier;
      const identityConfidence = (eligibility && !eligibility.eligible) ? 0 : tier.IdentityConfidence;
      const identityEvidence = (eligibility && !eligibility.eligible) ? (tier.IdentityEvidence || []).concat([eligibility.code]) : (tier.IdentityEvidence || []);
      const expectedMediaScope = `${mediaType}${season != null ? `:S${String(season).padStart(2, '0')}` : ''}${episode != null ? `:E${String(episode).padStart(2, '0')}` : ''}`;
      const parsedCandidateScope = hit.releaseAttributes?.season != null || hit.releaseAttributes?.episode != null
        ? `${hit.releaseAttributes?.mediaType || 'unknown'}:S${String(hit.releaseAttributes?.season || 0).padStart(2, '0')}:E${String(hit.releaseAttributes?.episode || 0).padStart(2, '0')}`
        : null;

      return {
        rank: offset + index + 1,
        infoHash: hit.hash,
        fileIndex: hit.fileIndex,
        filename: hit.filename,
        score: hit.score,
        scoreBreakdown: hit.justification?.scoreBreakdown || {},
        identity: { tier: identityTier, confidence: identityConfidence, evidence: identityEvidence, state: meta.resolutionState || 'unresolved', matchMethod: meta.matchMethod, eligible: eligibility ? eligibility.eligible : true, ineligibleReason: eligibility && !eligibility.eligible ? eligibility.reason : null, ineligibleCode: eligibility && !eligibility.eligible ? eligibility.code : null, expectedMediaScope, parsedCandidateScope },
        release: hit.releaseAttributes,
        sources: hit.sources || [],
        observations: [],
        availability: {},
      };
    });

    // TorBox availability check
    let availabilityStats = { checked: 0, cached: 0, uncached: 0, unknown: 0 };
    if (!skipAvailability) {
      const eligibleHashes = explainable.filter(r => r.identity?.eligible !== false && r.infoHash).map(r => r.infoHash);
      if (eligibleHashes.length > 0) {
        try {
          const checker = createAvailabilityChecker(cache);
          const batchResult = await checker.checkAvailability(eligibleHashes);
          availabilityStats.checked = eligibleHashes.length;
          availabilityStats.cached = batchResult.results.filter(r => r.state === 'cached').length;
          availabilityStats.uncached = batchResult.results.filter(r => r.state === 'uncached').length;
          availabilityStats.unknown = batchResult.results.filter(r => r.state === 'unknown').length;
          const availabilityByHash = new Map(batchResult.results.map(r => [r.infoHash, r]));
          for (const result of explainable) {
            const avail = availabilityByHash.get(result.infoHash);
            if (avail) {
              result.availability.torbox = { state: avail.state, checkedAt: avail.checkedAt, latencyMs: avail.latencyMs };
            }
          }
        } catch (error) {
          console.error(`Availability check failed: ${error.message}`);
        }
      }
    }

    // Stage 7: Select best candidate
    const selection = selectBestCandidate(explainable);

    // Stage 8: Persist media request to obtain requestId
    if (persist) {
      requestId = cache.persistMediaRequest(
        {
          mediaId: intent.mediaId,
          mediaType: intent.mediaType,
          season,
          episode,
          source,
          sourceType,
          sourceId,
          sourceLabel,
          requestedBy,
          priority,
          intentId,
        },
        explainable
      );
    }

    // Stage 9: Build playback handoff if selection succeeded and request was persisted
    let handoff = null;
    if (selection.selected && !selection.selected.ineligibleReason && requestId) {
      const handoffRequest = {
        requestId,
        mediaId,
        mediaType,
        season,
        episode,
      };
      handoff = buildPlaybackHandoff(selection, handoffRequest);

      // Persist handoff
      if (handoff) {
        try {
          cache.persistPlaybackHandoff(handoff);
          let vfsEntry = null;
          try {
            vfsEntry = materializeVfsEntry(cache, handoff);
          } catch (error) {
            console.error(`VFS materialization failed: ${error.message}`);
          }

          // After durable handoff, immediately publish .strm
          // Idempotent: safe to call for repeated requests
          try {
            const strmResult = await publishStrm({
              handoff,
              selection,
            });
            if (strmResult.published) {
              // Attach STRM path to handoff for downstream telemetry
              handoff.strmPath = strmResult.path;
            }

            // Notify Jellyfin of the new media (non-blocking)
            // Failure does NOT roll back the request/handoff/STRM
            if (strmResult.path) {
              notifyJellyfin({
                strmPath: strmResult.path,
                mediaId: handoff.mediaId,
                mediaType: handoff.mediaType,
              }).then((jfResult) => {
                if (jfResult.notified) {
                  console.log(`[Jellyfin] Notified via ${jfResult.method}: ${handoff.mediaId}`);
                } else if (jfResult.error) {
                  console.error(`[Jellyfin] Will be discovered on next scan: ${jfResult.error}`);
                }
              }).catch(() => {
                // Jellyfin notification failure is non-fatal
              });

              // Request Plex partial scan of the VFS directory that contains
              // the new file. Failure does not invalidate the fulfillment.
              if (vfsEntry) {
                notifyPlex({
                  mediaId: handoff.mediaId,
                  mediaType: handoff.mediaType,
                  canonicalPath: vfsEntry.canonicalPath,
                }).then((plResult) => {
                  if (plResult.notified) {
                    console.log(`[Plex] Notified via ${plResult.method}: ${handoff.mediaId}`);
                  } else if (plResult.error) {
                    console.error(`[Plex] Will be discovered on next scan: ${plResult.error}`);
                  }
                }).catch(() => {
                  // Plex notification failure is non-fatal
                });
              }
            }
          } catch (strmError) {
            // STRM publication failure must not fail the request
            console.error(`STRM publication failed: ${strmError.message}`);
          }
        } catch (error) {
          console.error(`Handoff persistence failed: ${error.message}`);
        }
      }
    }

    // Stage 10: Demand-driven queue promotion
    // Promote enrichment and probe work for requested candidates
    // Selected release gets highest priority, others get explicit-request priority
    const demandCandidates = explainable
      .filter(r => r.identity?.eligible !== false && r.infoHash)
      .map(r => ({ infoHash: r.infoHash, fileIndex: r.fileIndex }));

    // Promote all candidates to explicit-request priority
    const promotion = cache.promoteDemand(
      demandCandidates,
      DEMAND_PRIORITY.EXPLICIT_REQUEST,
      { reason: `media-request:${mediaId}` }
    );

    // If there's a selected release, promote it further to selected-release priority
    if (selection.selected && selection.selected.infoHash) {
      cache.promoteDemand(
        [{ infoHash: selection.selected.infoHash, fileIndex: selection.selected.fileIndex }],
        DEMAND_PRIORITY.SELECTED_RELEASE,
        { reason: `selected-release:${mediaId}` }
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
      discovery: { liveDiscoveryTriggered, liveCandidates: liveCandidates.length, liveEligible: liveEligibleCount },
      availability: availabilityStats,
      selection,
      handoff,
      demandPromotion: {
        enrichmentPromoted: promotion.enrichmentPromoted,
        probePromoted: promotion.probePromoted,
      },
    };
  }

  if (candidates.length === 0) {
    // No corpus candidates — but an existing durable handoff may still need
    // its STRM materialized (idempotence invariant).
    const { strmPath } = await ensureStrmForExistingHandoff(cache, mediaId, mediaType, season, episode);
    return {
      requestId: null,
      intent,
      results: [],
      total: 0,
      query: { mediaId, mediaType, season, episode },
      identitySummary: { tier: 'none', confidence: 0, evidence: [] },
      ranking: { TieredRankingApplied: false, TierCounts: {} },
      discovery: { liveDiscoveryTriggered: false, liveCandidates: 0, liveEligible: 0 },
      availability: { checked: 0, cached: 0, uncached: 0, unknown: 0 },
      selection: { selected: null, reason: 'no candidates', alternates: [] },
      strmPath,
    };
  }

  // Stage 2: Build ranking inputs with identity associations
  // Preserve metadata separately — rankHit() returns a new object that doesn't include custom fields
  const metadataByHash = new Map();
  const eligibilityByHash = new Map();

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

    // Build release attributes for eligibility evaluation
    const releaseAttrs = attrs ? {
      title: attrs.title,
      year: attrs.year,
      season: attrs.season,
      episode: attrs.episode,
      episodeRange: attrs.episodeRange,
      seasonOnly: attrs.seasonOnly,
      mediaType: attrs.mediaType,
      resolution: attrs.resolution,
      source: attrs.sourceType,
      codec: attrs.codec,
      hdr: attrs.hdr,
      audio: attrs.audio,
      releaseGroup: attrs.releaseGroup,
    } : {};

    // Evaluate identity eligibility for this candidate
    const eligibility = evaluateIdentityEligibility(
      { releaseAttributes: releaseAttrs },
      { season, episode, mediaType }
    );
    eligibilityByHash.set(key, eligibility);

    return {
      hash: candidate.infoHash,
      fileIndex: candidate.fileIndex,
      releaseKey: key,
      filename: candidate.filename,
      relevance: 1.0, // Direct media match = max relevance
      releaseAttributes: releaseAttrs,
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

  // Stage 2b: Determine corpus eligible count
  const corpusEligibleCount = rankingInputs.filter(input => {
    const eligibility = eligibilityByHash.get(input.releaseKey);
    return eligibility ? eligibility.eligible : true;
  }).length;

  // Stage 2c: Live discovery fallback
  let liveDiscoveryTriggered = false;
  let liveCandidates = [];
  let liveEligibleCount = 0;
  const liveMetadataByHash = new Map();
  const liveEligibilityByHash = new Map();

  if (!skipLiveDiscovery && corpusEligibleCount < liveDiscoveryThreshold) {
    liveDiscoveryTriggered = true;
    try {
      const liveResults = await runLiveDiscovery(mediaId, { season, episode });

      for (const live of liveResults) {
        const key = live.releaseKey;
        if (!key || !live.infoHash) continue;

        // Skip if already present in corpus (will be deduped later)
        if (eligibilityByHash.has(key)) {
          liveMetadataByHash.set(key, { ...liveMetadataByHash.get(key), live: true });
          continue;
        }

        const releaseAttrs = {
          title: live.title || live.filename,
          year: live.year,
          season: live.season,
          episode: live.episode,
          episodeRange: live.episodeRange,
          seasonOnly: live.seasonOnly,
          mediaType: live.mediaType,
          resolution: live.resolution,
          source: live.source,
          codec: live.codec,
          hdr: live.hdr,
          audio: live.audio,
          releaseGroup: live.releaseGroup,
        };

        // Same identity eligibility gate as corpus
        const eligibility = evaluateIdentityEligibility(
          { releaseAttributes: releaseAttrs },
          { season, episode, mediaType, mediaTitle }
        );
        liveEligibilityByHash.set(key, eligibility);

        if (eligibility.eligible) {
          liveEligibleCount++;
        }

        liveMetadataByHash.set(key, {
          filename: live.filename,
          releaseAttributes: releaseAttrs,
          providers: live.providers,
        });

        // Build ranking input for live candidate
        const rankingInput = {
          hash: live.infoHash,
          fileIndex: live.fileIndex,
          releaseKey: key,
          filename: live.filename || live.title,
          relevance: 0.8, // Live discovery slightly lower relevance than direct corpus match
          releaseAttributes: releaseAttrs,
          parserConfidence: live.confidence ?? 0.5,
          mediaAssociations: [], // Live has no persisted media associations
          providerObservations: [], // Will be populated by availability check
          providerEvidence: [],
          sources: [{ origin: 'live', evidence: [], confidence: live.confidence ?? 0.5 }],
          selectedMediaId: mediaId,
          hasLiveDiscovery: true,
        };

        rankingInputs.push(rankingInput);
        liveCandidates.push(rankingInput);
      }
    } catch (error) {
      // Live discovery failure must not break corpus results
      console.error(`Live discovery failed for ${mediaId}: ${error.message}`);
    }
  }

  // Stage 3: Rank within tier (with eligibility overrides)
  // Merge eligibility maps for ranking
  const allEligibilityByHash = new Map([...eligibilityByHash, ...liveEligibilityByHash]);
  const { ranked, tierMeta } = rankHitsTiered(rankingInputs, { season, episode, mediaTitle }, mediaId, allEligibilityByHash);

  // Stage 4: Paginate
  const total = ranked.length;
  const results = ranked.slice(offset, offset + limit);

  // Stage 5: Build explainable response
  const explainable = results.map((hit, index) => {
    // Restore metadata from pre-ranking store
    const key = `${hit.hash}:${hit.fileIndex ?? 'torrent'}`;
    const meta = metadataByHash.get(key) || liveMetadataByHash.get(key) || {};
    const eligibility = hit.eligibility || allEligibilityByHash.get(key);

    const tier = classifyIdentityTier(
      {
        releaseAttributes: hit.releaseAttributes,
        mediaAssociations: hit.mediaAssociations,
        sources: hit.sources,
        relevance: hit.components?.relevance || 0,
        selectedMediaId: hit.selectedMediaId,
      },
      { season, episode, mediaTitle },
      mediaId
    );

    // Use eligibility-based tier if available (Ineligible overrides classifyIdentityTier)
    const identityTier = (eligibility && !eligibility.eligible) ? 'Ineligible' : tier.IdentityTier;
    const identityConfidence = (eligibility && !eligibility.eligible) ? 0 : tier.IdentityConfidence;
    const identityEvidence = (eligibility && !eligibility.eligible)
      ? (tier.IdentityEvidence || []).concat([eligibility.code])
      : (tier.IdentityEvidence || []);
    // Build scope information for diagnostics
    const expectedMediaScope = `${mediaType}${season != null ? `:S${String(season).padStart(2, '0')}` : ''}${episode != null ? `:E${String(episode).padStart(2, '0')}` : ''}`;
    const parsedCandidateScope = hit.releaseAttributes?.season != null || hit.releaseAttributes?.episode != null
      ? `${hit.releaseAttributes?.mediaType || 'unknown'}:S${String(hit.releaseAttributes?.season || 0).padStart(2, '0')}:E${String(hit.releaseAttributes?.episode || 0).padStart(2, '0')}`
      : null;
    return {
      rank: offset + index + 1,
      infoHash: hit.hash,
      fileIndex: hit.fileIndex,
      filename: hit.filename,
      score: hit.score,
      scoreBreakdown: hit.justification?.scoreBreakdown || {},
      identity: {
        tier: identityTier,
        confidence: identityConfidence,
        evidence: identityEvidence,
        state: meta.resolutionState || 'unresolved',
        matchMethod: meta.matchMethod,
        eligible: eligibility ? eligibility.eligible : true,
        ineligibleReason: eligibility && !eligibility.eligible ? eligibility.reason : null,
        ineligibleCode: eligibility && !eligibility.eligible ? eligibility.code : null,
        expectedMediaScope,
        parsedCandidateScope,
      },
      release: hit.releaseAttributes,
      sources: hit.sources || [],
      observations: (hit.providerObservations || []).map(o => ({
        provider: o.provider,
        state: o.state,
        cached: o.state === 'cached',
        observedAt: o.observedAt,
      })),
      availability: _getAvailabilityForCandidate(hit),
    };
  });

  // Stage 5b: TorBox availability check for eligible candidates
  let availabilityStats = { checked: 0, cached: 0, uncached: 0, unknown: 0 };
  if (!skipAvailability) {
    const eligibleHashes = explainable
      .filter(r => r.identity?.eligible !== false && r.infoHash)
      .map(r => r.infoHash);

    if (eligibleHashes.length > 0) {
      try {
        const checker = createAvailabilityChecker(cache);
        const batchResult = await checker.checkAvailability(eligibleHashes);
        availabilityStats.checked = eligibleHashes.length;
        availabilityStats.cached = batchResult.results.filter(r => r.state === 'cached').length;
        availabilityStats.uncached = batchResult.results.filter(r => r.state === 'uncached').length;
        availabilityStats.unknown = batchResult.results.filter(r => r.state === 'unknown').length;

        // Merge availability into results
        const availabilityByHash = new Map(batchResult.results.map(r => [r.infoHash, r]));
        for (const result of explainable) {
          const avail = availabilityByHash.get(result.infoHash);
          if (avail) {
            result.availability = result.availability || {};
            result.availability.torbox = {
              state: avail.state,
              checkedAt: avail.checkedAt,
              latencyMs: avail.latencyMs,
            };
          }
        }
      } catch (error) {
        // Availability check failure must not break results
        console.error(`Availability check failed: ${error.message}`);
      }
    }
  }

  // Stage 6: Persist results
  let requestId = null;
  if (persist) {
    requestId = cache.persistMediaRequest(
      {
        mediaId: intent.mediaId,
        mediaType: intent.mediaType,
        season,
        episode,
        source,
        sourceType,
        sourceId,
        sourceLabel,
        requestedBy,
        priority,
        intentId,
      },
      explainable
    );
  }

  // Stage 7: Select best candidate
  const selection = selectBestCandidate(explainable);

  // Stage 8: Build playback handoff if selection succeeded and request was persisted
  let handoff = null;
  if (selection.selected && !selection.selected.ineligibleReason && requestId) {
    const handoffRequest = {
      requestId,
      mediaId,
      mediaType,
      season,
      episode,
    };
    handoff = buildPlaybackHandoff(selection, handoffRequest);

    // Persist handoff
    if (handoff) {
      try {
        cache.persistPlaybackHandoff(handoff);
      } catch (error) {
        console.error(`Handoff persistence failed: ${error.message}`);
      }
    }
  }

  // Stage 9: Demand-driven queue promotion
  // Promote enrichment and probe work for requested candidates
  const demandCandidates = explainable
    .filter(r => r.identity?.eligible !== false && r.infoHash)
    .map(r => ({ infoHash: r.infoHash, fileIndex: r.fileIndex }));

  // Promote all candidates to explicit-request priority
  const promotion = cache.promoteDemand(
    demandCandidates,
    DEMAND_PRIORITY.EXPLICIT_REQUEST,
    { reason: `media-request:${mediaId}` }
  );

  // If there's a selected release, promote it further to selected-release priority
  if (selection.selected && selection.selected.infoHash) {
    cache.promoteDemand(
      [{ infoHash: selection.selected.infoHash, fileIndex: selection.selected.fileIndex }],
      DEMAND_PRIORITY.SELECTED_RELEASE,
      { reason: `selected-release:${mediaId}` }
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
    discovery: {
      liveDiscoveryTriggered,
      liveCandidates: liveCandidates.length,
      liveEligible: liveEligibleCount,
    },
    availability: availabilityStats,
    selection,
    handoff,
    demandPromotion: {
      enrichmentPromoted: promotion.enrichmentPromoted,
      probePromoted: promotion.probePromoted,
    },
  };
}

function summarizeIdentity(results) {
  if (results.length === 0) {
    return { tier: 'none', confidence: 0, evidence: [] };
  }

  const top = results[0];
  const ineligibleCount = results.filter(r => r.identity?.eligible === false).length;
  const eligibleCount = results.length - ineligibleCount;

  // Count by eligibility code
  const ineligibleByCode = results.reduce((acc, r) => {
    if (r.identity?.eligible === false && r.identity?.ineligibleCode) {
      acc[r.identity.ineligibleCode] = (acc[r.identity.ineligibleCode] || 0) + 1;
    }
    return acc;
  }, {});

  // Count by tier
  const tierCounts = results.reduce((acc, r) => {
    const tier = r.identity?.tier || 'unknown';
    acc[tier] = (acc[tier] || 0) + 1;
    return acc;
  }, {});

  // Count exact episode matches and season packs
  const exactEpisodeMatches = results.filter(r =>
    r.identity?.eligible !== false &&
    r.release?.season != null &&
    r.release?.episode != null
  ).length;
  const seasonPackMatches = results.filter(r =>
    r.identity?.eligible !== false &&
    r.release?.seasonOnly === true || r.release?.mediaType === 'season'
  ).length;

  return {
    tier: top.identity?.tier || 'unknown',
    confidence: top.identity?.confidence || 0,
    evidence: top.identity?.evidence || [],
    totalCandidates: results.length,
    eligibleCount,
    ineligibleCount,
    ineligibleByCode,
    tierCounts,
    exactEpisodeMatches,
    seasonPackMatches,
    resolutionStates: results.reduce((acc, r) => {
      const state = r.identity?.state || 'unresolved';
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {}),
  };
}
