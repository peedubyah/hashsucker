/**
 * Media-request pipeline stages.
 *
 * searchByMedia() is the product stage sequence; this module owns the
 * individual stages and the response shapes so the orchestration reads as
 * stages and each stage is independently testable.
 *
 * Stage contract (each stage: narrow inputs → narrow outputs, no hidden
 * global policy):
 *   context      buildRequestContext          parse/validate the request once
 *   title index  collectTitleIndexInputs      corpus title-index candidates
 *   discovery    runLiveDiscoveryStage        live candidates + eligibility
 *   ranking      shapeRankedResults           ranked hits → explainable rows
 *   availability applyTorboxAvailability      provider state per candidate
 *   selection    selectCandidateForRequest    bindable candidate (Binding)
 *   persistence  persistRequestAndBackfill    request row + associations
 *   handoff      buildHandoffForSelection     durable playback handoff
 *   demand       promoteDemandForRequest      queue promotion
 *   publication  (lib/requests/publication)   handoff → published item
 *
 * Response assembly lives here too (requestResponseBase / unfulfilled /
 * completed) so the success, prepared, and failure shapes cannot drift.
 */

import { createRequestIntent } from '../lib/requests/intent.js';
import { rankHitsTiered, classifyIdentityTier, evaluateIdentityEligibility } from '../lib/discovery/ranking.js';
import { getStrongestReleaseAttributes } from '../lib/discovery/release-attributes.js';
import { evaluateObservationFreshness } from '../lib/providers/observations.js';
import { runLiveDiscovery } from '../lib/discovery/live-bridge.js';
import { createAvailabilityChecker } from '../lib/intents/availability.js';
import { selectBindableCandidate } from '../lib/discovery/selection.js';
import { lookupCorpusByTitle, resolveWantedIdentity, IDENTITY_TIERS } from '../lib/discovery/corpus-identity.js';
import { computeHistoricalAvailabilityPrior } from '../lib/discovery/confidence-projection.js';
import { resolveTvTorrentFile } from '../lib/resolver/tv-episode-resolver.js';
import { buildPlaybackHandoff } from '../lib/discovery/playback-handoff.js';
import { DEMAND_PRIORITY } from '../lib/discovery/cache.js';

/** Minimum eligible corpus candidates before live discovery is triggered. */
export const DEFAULT_LIVE_DISCOVERY_THRESHOLD = 1;

/** Episode geometry: explicit season+episode coordinates (or legacy type). */
function episodeGeometry(mediaType, season, episode) {
  const hasEpisodeCoords = Number.isSafeInteger(season) && season >= 1
    && Number.isSafeInteger(episode) && episode >= 1;
  return mediaType === 'episode' || hasEpisodeCoords;
}

/**
 * Parse and validate a media request once. Every later stage reads this
 * context instead of re-deriving request flags.
 */
export function buildRequestContext(cache, request) {
  const mediaId = String(request.mediaId || '').trim();
  const mediaType = request.mediaType || 'movie';
  const startedAt = Date.now();
  const limit = Math.min(parseInt(request.limit, 10) || 50, 100);
  const offset = parseInt(request.offset, 10) || 0;

  if (!mediaId) {
    throw new Error('mediaId is required');
  }

  const intent = createRequestIntent({ type: mediaType, mediaId });
  const season = request.season != null ? parseInt(request.season, 10)
    : (intent.season != null ? intent.season : null);
  const episode = request.episode != null ? parseInt(request.episode, 10)
    : (intent.episodes?.length > 0 ? intent.episodes[0] : null);

  return {
    cache,
    request,
    startedAt,
    mediaId,
    mediaType,
    season,
    episode,
    isEpisode: episodeGeometry(mediaType, season, episode),
    limit,
    offset,
    intent,
    persist: request.persist !== false,
    liveDiscoveryThreshold: request.liveDiscoveryThreshold != null
      ? parseInt(request.liveDiscoveryThreshold, 10)
      : DEFAULT_LIVE_DISCOVERY_THRESHOLD,
    skipLiveDiscovery: request.skipLiveDiscovery === true,
    liveOnly: request.liveOnly === true,
    bloodhound: request.bloodhound === true,
    skipAvailability: request.skipAvailability === true,
    // Preparation tranche: discovery/ranking/selection/binding + durable
    // persistence WITHOUT presentation. A later normal request recognizes
    // the prepared state and publishes with zero provider work.
    prepareOnly: request.prepareOnly === true,
    // Provider identity-binding seams (optional by design: absent in tests
    // and when the operator has not configured that provider).
    ensureTorBoxFileIdentityFn: typeof request.ensureTorBoxFileIdentity === 'function'
      ? request.ensureTorBoxFileIdentity
      : null,
    ensureRealDebridFileIdentityFn: typeof request.ensureRealDebridFileIdentity === 'function'
      ? request.ensureRealDebridFileIdentity
      : null,
    hydrateVfs: request.hydrateVfs && typeof request.hydrateVfs === 'object'
      ? request.hydrateVfs
      : null,
    controlPlaneStore: request.controlPlaneStore ?? null,
    maxTier: request.maxTier ?? null,
    source: request.source || null,
    sourceType: request.sourceType || null,
    sourceId: request.sourceId || null,
    sourceLabel: request.sourceLabel || null,
    requestedBy: request.requestedBy || null,
    priority: request.priority ?? null,
    requestIntent: request.intent || 'library',
    qualityProfile: request.qualityProfile || 'balanced',
    posterUrl: request.posterUrl || null,
    mediaYear: request.canonicalYear ?? request.year ?? null,
    mediaTitle: request.mediaTitle || null,
    intentId: request.intentId != null ? request.intentId : null,
    canonicalTitle: typeof request.canonicalTitle === 'string' && request.canonicalTitle.trim()
      ? request.canonicalTitle.trim()
      : null,
    canonicalYear: Number.isSafeInteger(request.canonicalYear) && request.canonicalYear >= 0
      ? request.canonicalYear
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * Stage: corpus title index
 * ------------------------------------------------------------------ */

/**
 * Corpus title-index inputs, collected once per request and merged into
 * whichever ranking path runs (live, corpus, or title-only). One FTS query
 * plus at most one cached metadata lookup. The resolved wanted identity is
 * reused for live discovery. Best-effort: never fatal.
 */
export async function collectTitleIndexInputs(ctx) {
  const { cache, mediaId, mediaType, season, episode, mediaTitle, canonicalYear } = ctx;
  const inputs = [];
  const eligibilityByHash = new Map();
  let wanted = { title: null, year: null, source: 'none' };
  try {
    wanted = await resolveWantedIdentity({ mediaId, mediaType, mediaTitle, canonicalYear });
    if (!wanted.title) return { inputs, eligibilityByHash, wanted };
    const rows = lookupCorpusByTitle(cache, {
      title: wanted.title, year: wanted.year, season, episode, mediaType,
    });
    for (const row of rows) {
      const key = `${row.infoHash}:${row.fileIndex ?? 'torrent'}`;
      const releaseAttrs = {
        title: row.title,
        year: row.year ?? undefined,
        season: row.season ?? undefined,
        episode: row.episode ?? undefined,
        episodeRange: undefined,
        seasonOnly: false,
        mediaType,
        resolution: row.resolution ?? undefined,
        source: row.sourceType ?? undefined,
        // Canonical scoring key (ranker V2 fix 1): qualityScore reads
        // sourceType; mirror it like the other ranking-input builders.
        sourceType: row.sourceType ?? undefined,
        codec: row.codec ?? undefined,
        hdr: row.hdr ?? undefined,
        audio: row.audio ?? undefined,
      };
      const eligibility = evaluateIdentityEligibility(
        { releaseAttributes: releaseAttrs, sources: [{ origin: 'corpus-title-index' }] },
        { season, episode, mediaType, mediaTitle: wanted.title, year: wanted.year ?? canonicalYear },
      );
      eligibilityByHash.set(key, eligibility);
      inputs.push({
        hash: row.infoHash,
        fileIndex: row.fileIndex,
        releaseKey: key,
        filename: row.filename,
        relevance: 0.75,
        releaseAttributes: releaseAttrs,
        parserConfidence: 0.75,
        mediaAssociations: [],
        providerObservations: [],
        providerEvidence: [],
        sources: [{ origin: 'corpus-title-index', evidence: ['exact-normalized-title-match', `tier:${IDENTITY_TIERS.STRUCTURED}`], confidence: 0.75 }],
        selectedMediaId: mediaId,
        hasLiveDiscovery: false,
        hasTitleIndex: true,
        exactFileSize: row.size,
        selectedFileSize: row.size,
        historicalPrior: 0,
      });
    }
  } catch {
    // Title lookup is best-effort enrichment, never fatal.
  }
  return { inputs, eligibilityByHash, wanted };
}

/* ------------------------------------------------------------------ *
 * Stage: live discovery
 * ------------------------------------------------------------------ */

/**
 * Run live discovery and build ranking inputs.
 *
 * Audit: ranking-determinism — live-vs-live dedup. runLiveDiscovery
 * aggregates Stremio + Torznab; both may return the same
 * (infoHash, fileIndex). Without the seen-key Set, identical releaseKeys
 * would be pushed into rankingInputs, the comparator would return 0
 * (tied at all 5 tie-breakers), and JS stable sort would preserve
 * input-arrival order — defeating the deterministic ordering invariant.
 * The Set is keyed on releaseKey, the canonical identity produced by
 * createReleaseIdentity.
 */
export async function runLiveDiscoveryStage(ctx, { wantedIdentity, withHistoricalPrior = false }) {
  const { cache, mediaId, mediaType, season, episode, mediaTitle, canonicalYear } = ctx;
  const liveCandidates = [];
  const liveEligibilityByHash = new Map();
  const liveMetadataByHash = new Map();
  const seenLiveKeys = new Set();
  let liveEligibleCount = 0;
  let error = null;
  let rawCount = 0;

  try {
    const liveResults = await runLiveDiscovery(mediaId, {
      season,
      episode,
      title: wantedIdentity?.title ?? mediaTitle ?? null,
      year: wantedIdentity?.year ?? canonicalYear ?? null,
      wantedImdbId: mediaId,
    });
    rawCount = liveResults.length;
    for (const live of liveResults) {
      const key = live.releaseKey;
      if (!key || !live.infoHash) continue;
      // Skip duplicate live entries (same infoHash+fileIndex from
      // multiple live providers or repeated within one provider).
      if (seenLiveKeys.has(key)) continue;
      seenLiveKeys.add(key);

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
        // Canonical scoring key (ranker V2 fix 1): qualityScore reads
        // sourceType. Mirror the live class so source contribution is
        // not silently zeroed.
        sourceType: live.source,
        codec: live.codec,
        hdr: live.hdr,
        audio: live.audio,
        releaseGroup: live.releaseGroup,
      };

      const eligibility = evaluateIdentityEligibility(
        { releaseAttributes: releaseAttrs, sources: live.sources ?? null },
        { season, episode, mediaType, mediaTitle, year: wantedIdentity?.year ?? canonicalYear }
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
        // Preserve per-source relevance/provenance when the discovery
        // source supplies them (Prowlarr rows carry relevance 0.7 and
        // origin 'prowlarr'); legacy rows fall back to live defaults.
        relevance: live.relevance ?? 0.8,
        releaseAttributes: releaseAttrs,
        parserConfidence: live.parserConfidence ?? live.confidence ?? 0.5,
        mediaAssociations: [],
        providerObservations: [],
        providerEvidence: [],
        sources: live.sources ?? [{ origin: 'live', evidence: [], confidence: live.confidence ?? 0.5 }],
        selectedMediaId: mediaId,
        hasLiveDiscovery: true,
        // Surface the per-file byte size carried by live discovery so the
        // pre-publication identity helper can match by exact size. Null
        // when the source stream had no numeric videoSize.
        selectedFileSize: live.selectedFileSize ?? null,
        // The corpus path folds a bounded historical evidence prior into
        // providerAvailability; the live path leaves it unset exactly as
        // before.
        ...(withHistoricalPrior
          ? { historicalPrior: computeHistoricalAvailabilityPrior(cache, live.infoHash, live.fileIndex) }
          : {}),
      });
    }
  } catch (liveError) {
    error = liveError;
    console.error(`Live discovery failed for ${mediaId}: ${liveError.message}`);
  }

  return {
    liveCandidates, liveEligibilityByHash, liveMetadataByHash,
    liveEligibleCount, rawCount, seenLiveKeys, error,
  };
}

/**
 * Merge corpus title-index candidates into the live ranking set under
 * normal rules (deduped, eligibility-gated). Runs before the empty check
 * so title-index hits alone can carry a request with zero live results.
 */
export function mergeTitleInputsIntoLive({ titleInputs, titleEligibilityByHash, liveCandidates, liveEligibilityByHash, seenLiveKeys }) {
  let merged = 0;
  for (const t of titleInputs) {
    if (seenLiveKeys.has(t.releaseKey)) continue;
    seenLiveKeys.add(t.releaseKey);
    liveCandidates.push(t);
    merged += 1;
    if (!liveEligibilityByHash.has(t.releaseKey)) {
      liveEligibilityByHash.set(t.releaseKey, titleEligibilityByHash.get(t.releaseKey));
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * Stage: ranking → explainable rows
 * ------------------------------------------------------------------ */

/**
 * Build the corpus ranking input row for one persisted candidate.
 * Identity associations, provider observations, eligibility, and the
 * historical availability prior are all resolved here so ranking sees one
 * uniform input shape regardless of source.
 */
export function buildCorpusRankingInput({ cache, candidate, ctx, eligibilityByHash, metadataByHash }) {
  const { mediaId, mediaType, season, episode, mediaTitle, canonicalYear } = ctx;
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
    // Canonical scoring key (ranker V2 fix 1): qualityScore reads
    // sourceType; mirror the corpus class for the same reason.
    sourceType: attrs.sourceType,
    codec: attrs.codec,
    hdr: attrs.hdr,
    audio: attrs.audio,
    releaseGroup: attrs.releaseGroup,
  } : {};

  // Evaluate identity eligibility for this candidate
  const eligibility = evaluateIdentityEligibility(
    { releaseAttributes: releaseAttrs, sources: candidate.sources ?? null },
    { season, episode, mediaType, year: ctx.wantedIdentity?.year ?? canonicalYear }
  );
  eligibilityByHash.set(key, eligibility);

  // Historical evidence prior: bounded contribution folded into
  // providerAvailability by rankHit(). Fresh authoritative evidence
  // always outranks this; it only modestly influences close candidates.
  const historicalPrior = computeHistoricalAvailabilityPrior(
    cache,
    candidate.infoHash,
    candidate.fileIndex,
  );

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
    historicalPrior,
  };
}

/** Availability from stored provider observations for one ranked hit. */
function availabilityForCandidate(hit) {
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
 * Rank hits and project them into the persisted/explainable response rows.
 * Both the live and corpus paths use this exact projection.
 */
export function shapeRankedResults({ ranked, ctx, metadataByHash, eligibilityByHash, liveMetadataByHash = null }) {
  const { mediaId, mediaType, season, episode, mediaTitle, offset, limit } = ctx;
  const results = ranked.slice(offset, offset + limit);

  return results.map((hit, index) => {
    const key = `${hit.hash}:${hit.fileIndex ?? 'torrent'}`;
    const meta = metadataByHash.get(key) || liveMetadataByHash?.get(key) || {};
    const eligibility = hit.eligibility || eligibilityByHash.get(key);

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
      availability: availabilityForCandidate(hit),
      // Corpus rows do NOT have a per-file exact size (the candidates
      // table only stores the whole-torrent size which is not a usable
      // identity). Live-discovery rows carry the raw videoSize from
      // behaviorHints. The pre-publication identity helper is a no-op
      // when this is null.
      selectedFileSize: hit.selectedFileSize ?? null,
      // Pass through the ranked-specific evidence fields so the
      // persistence layer can build a frozen snapshot of what the scorer
      // actually saw. Without these, the snapshot would be all-zeros and
      // useless for post-restart explanation.
      justification: hit.justification,
      components: hit.components,
      contributions: hit.contributions,
      providerObservations: hit.providerObservations || [],
      hasLiveDiscovery: hit.hasLiveDiscovery === true,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Stage: availability
 * ------------------------------------------------------------------ */

/** TorBox availability for eligible candidates; never breaks results. */
export async function applyTorboxAvailability({ explainable, cache }) {
  let availabilityStats = { checked: 0, cached: 0, uncached: 0, unknown: 0 };
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
  return availabilityStats;
}

/* ------------------------------------------------------------------ *
 * Stage: selection (Binding)
 * ------------------------------------------------------------------ */

/**
 * Iterate ranked candidates in existing order until one becomes bindable
 * (exact-size fast path, or TV episode resolution for cached TorBox).
 * Side effects (handoff persist, VFS publication, STRM, notifications) are
 * deferred until a genuine TorrentFile binding is proven.
 *
 * TV episode scope: PATH B TV resolution activates when there is explicit
 * episode context, regardless of intent scope:
 * - S:E in mediaId → intent.scope='episode' (direct episode request)
 * - request.season/episode params → Seerr fan-out children (scope='series')
 * - mediaType='episode' → legacy direct episode request
 */
export async function selectCandidateForRequest({ explainable, ctx }) {
  const hasExplicitEpisode = ctx.request.season != null || ctx.request.episode != null;
  const tvCoordinates = (ctx.intent.scope === 'episode' || ctx.mediaType === 'episode' || hasExplicitEpisode)
    ? { season: ctx.season, episode: ctx.episode }
    : null;
  return selectBindableCandidate(explainable, {
    ensureTorBoxFileIdentityFn: ctx.ensureTorBoxFileIdentityFn,
    ensureRealDebridFileIdentityFn: ctx.ensureRealDebridFileIdentityFn,
    resolveTvTorrentFileFn: resolveTvTorrentFile,
    tvCoordinates,
    controlPlaneStore: ctx.controlPlaneStore,
    maxTier: ctx.maxTier,
  });
}

/**
 * Corpus backfill (corpus productization tranche): record observed
 * request outcomes as candidate→media associations so the corpus can
 * serve future discovery for previously-requested media without any
 * external matching. Only eligible ranked results are recorded, with
 * their identity confidence; ranking rules are untouched. Best-effort:
 * never fails the request. Runs after persistMediaRequest commits.
 */
export function backfillRequestMediaAssociations(cache, intent, explainable, requestId) {
  if (typeof cache.upsertMediaAssociation !== 'function') return 0;
  if (!intent?.mediaId || !Array.isArray(explainable) || explainable.length === 0) return 0;
  let associated = 0;
  for (const r of explainable) {
    try {
      if (!r || !r.infoHash) continue;
      if (r.identity?.eligible === false) continue;
      cache.upsertMediaAssociation(r.infoHash, r.fileIndex ?? null, intent.mediaId, {
        source: 'request-outcome',
        confidence: typeof r.identity?.confidence === 'number' ? r.identity.confidence : 0.5,
        evidence: [`request:${requestId}`, `rank:${r.rank ?? '?'}`],
        resolutionState: r.identity?.state || 'unresolved',
        matchMethod: 'request-ranked',
      });
      associated++;
    } catch {
      // One bad row must not poison the rest.
    }
  }
  return associated;
}

/* ------------------------------------------------------------------ *
 * Stage: persistence
 * ------------------------------------------------------------------ */

/**
 * Persist the media request (obtaining its id) and backfill durable
 * candidate→media associations for eligible ranked outcomes.
 * Association bookkeeping is best-effort and never fails fulfillment.
 */
export function persistRequestAndBackfill({ cache, ctx, explainable, selection, status }) {
  let requestId = null;
  if (!ctx.persist) return requestId;
  requestId = cache.persistMediaRequest(
    {
      mediaId: ctx.intent.mediaId,
      mediaType: ctx.intent.mediaType,
      season: ctx.season,
      episode: ctx.episode,
      source: ctx.source,
      sourceType: ctx.sourceType,
      sourceId: ctx.sourceId,
      sourceLabel: ctx.sourceLabel,
      requestedBy: ctx.requestedBy,
      priority: ctx.priority,
      requestIntent: ctx.requestIntent,
      ...(status != null ? { status } : {}),
      qualityProfile: ctx.qualityProfile,
      mediaTitle: ctx.mediaTitle,
      mediaYear: ctx.mediaYear,
      posterUrl: ctx.posterUrl,
      intentId: ctx.intentId,
    },
    explainable
  );
  try {
    backfillRequestMediaAssociations(cache, ctx.intent, explainable, requestId);
  } catch {
    // Association bookkeeping must never fail fulfillment.
  }
  return requestId;
}

/**
 * Build and persist the durable playback handoff for a bindable
 * selection. The selection already resolved the TorrentFile, so the
 * binding marker set inside selectBindableCandidate is copied onto the
 * handoff, and the selection itself is recorded as evidence.
 */
export function buildHandoffForSelection({ cache, ctx, requestId, selection, explainable }) {
  const { mediaId, mediaType, season, episode, canonicalTitle, canonicalYear } = ctx;
  // Pull the private _binding marker set inside selectBindableCandidate.
  const binding = selection.selected._binding ?? null;
  const handoffRequest = {
    requestId,
    mediaId,
    mediaType,
    season,
    episode,
    // Canonical presentation identity (e.g. Seerr `originalTitle` /
    // `releaseDate`). Threaded into the handoff so the VFS materializer
    // can build a clean Plex-facing path (Movies/<Title> (<Year>)/...)
    // without parsing it out of the provider release filename. Only used
    // for presentation; the handoff's `filename` / `infoHash` continue
    // to identify the provider-backed file.
    ...(canonicalTitle ? { canonicalTitle } : {}),
    ...(canonicalYear != null ? { canonicalYear } : {}),
    // Durable TorrentFile id from bindable selection. NULL when no
    // bindable candidate exists (all candidates unbindable).
    ...(selection.selected._torrentFileId ? { torrentFileId: selection.selected._torrentFileId } : {}),
  };
  const handoff = buildPlaybackHandoff(selection, handoffRequest);
  if (selection.selected && cache.appendEvidenceObservation) {
    cache.appendEvidenceObservation({
      subjectKind: 'selection',
      infoHash: selection.selected.infoHash,
      fileIndex: selection.selected.fileIndex,
      mediaId,
      observer: 'hashsucker',
      sourceClass: ctx.source || 'request',
      state: ctx.requestIntent || 'library',
      correlationId: requestId == null ? null : String(requestId),
      payload: {
        qualityProfile: ctx.qualityProfile,
        reason: selection.reason,
        candidateCount: explainable.length,
        alternativeCount: selection.alternates?.length ?? 0,
        identityTier: selection.selected.identity?.tier ?? null,
      },
    });
  }
  if (handoff && binding) {
    handoff.torrentFileIdentity = {
      status: binding.status,
      torrentFileId: binding.torrentFileId,
      placementId: binding.placementId ?? null,
      providerFileId: binding.providerFileId ?? null,
      size: binding.size ?? null,
      season: binding.season ?? null,
      episode: binding.episode ?? null,
    };
  }
  return handoff;
}

/* ------------------------------------------------------------------ *
 * Stage: demand promotion
 * ------------------------------------------------------------------ */

/**
 * Promote enrichment and probe work for requested candidates. The selected
 * release gets the highest priority; every other eligible candidate gets
 * explicit-request priority.
 */
export function promoteDemandForRequest({ cache, ctx, explainable, selection }) {
  const demandCandidates = explainable
    .filter(r => r.identity?.eligible !== false && r.infoHash)
    .map(r => ({ infoHash: r.infoHash, fileIndex: r.fileIndex }));

  // Promote all candidates to explicit-request priority
  const promotion = cache.promoteDemand(
    demandCandidates,
    DEMAND_PRIORITY.EXPLICIT_REQUEST,
    { reason: `media-request:${ctx.mediaId}` }
  );

  // If there's a selected release, promote it further to selected-release priority
  if (selection.selected && selection.selected.infoHash) {
    cache.promoteDemand(
      [{ infoHash: selection.selected.infoHash, fileIndex: selection.selected.fileIndex }],
      DEMAND_PRIORITY.SELECTED_RELEASE,
      { reason: `selected-release:${ctx.mediaId}` }
    );
  }
  return promotion;
}

/* ------------------------------------------------------------------ *
 * Response assembly
 * ------------------------------------------------------------------ */

/** Identity summary across the ranked set (also the response contract). */
export function summarizeIdentity(results) {
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

/**
 * Per-candidate bindability diagnostics. These are what made recent
 * root-cause work possible (why each ranked candidate could not bind),
 * so they are part of the response contract, not debug-only output.
 */
export function skippedCandidatesOf(selection) {
  if (!Array.isArray(selection.skipped) || selection.skipped.length === 0) return {};
  return {
    skippedCandidates: selection.skipped.slice(0, 25).map((s) => ({
      infoHash: s.infoHash ?? null,
      rank: s.rank ?? null,
      torboxState: s.torboxState ?? null,
      reason: s.reason ?? null,
    })),
  };
}

/** Fields every pipeline response carries. */
export function requestResponseBase({
  ctx, requestId, total, tierMeta,
  liveDiscoveryTriggered = false, liveCandidates = 0, liveEligible = 0,
  availabilityStats, selection, explainable,
}) {
  return {
    requestId,
    intent: ctx.intent,
    results: explainable,
    total,
    query: { mediaId: ctx.mediaId, mediaType: ctx.mediaType, season: ctx.season, episode: ctx.episode },
    identitySummary: summarizeIdentity(explainable),
    ranking: tierMeta,
    discovery: { liveDiscoveryTriggered, liveCandidates, liveEligible },
    availability: availabilityStats,
    selection,
  };
}

/**
 * Unfulfilled result: the item is not playable and the retry decision
 * belongs to whoever owns the request (scheduler for scheduled work).
 */
export function unfulfilledResponse({ base, reason, error = null, published = false, extra = {} }) {
  return {
    ...base,
    unfulfilled: true,
    retryOwned: true,
    published,
    reason,
    ...(error ? { error: error.message ?? String(error) } : {}),
    ...extra,
  };
}
