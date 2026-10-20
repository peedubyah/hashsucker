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
 *
 * This module owns the entry points (searchByMedia) and the reuse fast path;
 * the stage sequence itself lives in ./media-request-stages.js and the
 * presentation tail in ../lib/requests/publication.js.
 */

import { isPlayableVideoTorrentFile } from '../lib/resolver/tv-episode-resolver.js';
import { getServiceability } from '../lib/vfs/byte-health.js';
import { publishStrm } from '../lib/requests/strm-publisher.js';
import {
  createLibraryIdentityKey,
  stableLibraryItemId,
} from '../lib/control-plane/canonical-path.js';
import { notifyJellyfin } from '../lib/requests/jellyfin-notifier.js';
import { confirmPlexEpisode } from '../lib/consumers/plex.js';
import { vfsPartFile } from '../lib/plex/vfs-path.js';
import {
  PublicationError,
  verifyPublishedStrm,
  publishSelectedHandoff,
  republishHealthyHandoff,
  materializeHandoff,
} from '../lib/requests/publication.js';
import {
  buildRequestContext,
  collectTitleIndexInputs,
  runLiveDiscoveryStage,
  mergeTitleInputsIntoLive,
  buildCorpusRankingInput,
  shapeRankedResults,
  applyTorboxAvailability,
  selectCandidateForRequest,
  persistRequestAndBackfill,
  buildHandoffForSelection,
  promoteDemandForRequest,
  requestResponseBase,
  unfulfilledResponse,
  skippedCandidatesOf,
} from './media-request-stages.js';
import { rankHitsTiered } from '../lib/discovery/ranking.js';
import { backfillRequestMediaAssociations } from './media-request-stages.js';
import { perfTrace } from '../lib/perf-trace.js';

// Backfill moved into the stages module (it is a pipeline stage); re-exported
// here because existing callers and tests import it from this module.
export { backfillRequestMediaAssociations };

export function getPreparedDurableState({
  cache,
  controlPlaneStore,
  mediaId,
  mediaType,
  season = null,
  episode = null,
  canonicalTitle = null,
  canonicalYear = null,
}) {
  const hasEpisodeCoords = Number.isSafeInteger(season) && season >= 1
    && Number.isSafeInteger(episode) && episode >= 1;
  const isEpisode = mediaType === 'episode' || hasEpisodeCoords;
  if (!isEpisode && mediaType !== 'movie') {
    return null;
  }
  const stored = isEpisode
    ? cache.getTvPlaybackHandoff?.(mediaId, season, episode)
    : cache.getPlaybackHandoffByMediaId?.(mediaId);
  if (!stored) {
    return null;
  }
  if (!isEpisode && (stored.season != null || stored.episode != null)) {
    return null;
  }
  let infoHash = stored.infoHash ?? stored.selectedHash;
  let torrentFileId = stored.torrentFileId ?? null;
  let authoritative = null;
  if (typeof controlPlaneStore?.getLibraryItemByIdentityKey === 'function'
    && typeof controlPlaneStore?.getActiveBindingForLibraryItem === 'function') {
    const identityKey = createLibraryIdentityKey({
      mediaType: isEpisode ? 'episode' : 'movie',
      mediaId,
      season: isEpisode ? season : null,
      episode: isEpisode ? episode : null,
    });
    const item = controlPlaneStore.getLibraryItemByIdentityKey(identityKey);
    if (item) {
      authoritative = controlPlaneStore.getActiveBindingForLibraryItem(item.id);
      if (!authoritative) return null;
      infoHash = authoritative.binding.infoHash;
      torrentFileId = authoritative.torrentFile.id;
    }
  }
  if (!infoHash || !stored.releaseKey || !torrentFileId || !stored.filename || !stored.provider) {
    return null;
  }
  if (isEpisode && (stored.season !== season || stored.episode !== episode)) {
    return null;
  }
  if (!controlPlaneStore
    || typeof controlPlaneStore.getTorrentFile !== 'function'
    || typeof controlPlaneStore.listDataPlaneCoordinates !== 'function') {
    return null;
  }
  const torrentFile = controlPlaneStore.getTorrentFile(torrentFileId);
  if (!torrentFile
    || String(torrentFile.infoHash || '').toLowerCase() !== String(infoHash).toLowerCase()
    || !(Number.isSafeInteger(torrentFile.size) && torrentFile.size > 0)) {
    return null;
  }
  const coords = controlPlaneStore.listDataPlaneCoordinates(torrentFileId) || [];
  if (coords.length === 0) {
    return null;
  }
  if (isEpisode && !isPlayableVideoTorrentFile(torrentFile)) {
    return null;
  }
  const handoff = {
    requestId: stored.requestId,
    mediaId: stored.mediaId,
    mediaType: stored.mediaType,
    season: stored.season ?? null,
    episode: stored.episode ?? null,
    releaseKey: authoritative?.binding.releaseKey ?? stored.releaseKey,
    infoHash,
    fileIndex: authoritative?.binding.fileIndex ?? stored.fileIndex ?? null,
    filename: stored.filename,
    provider: stored.provider,
    providerState: stored.providerState,
    identityTier: stored.identityTier,
    resolutionState: stored.resolutionState,
    selectionReason: stored.selectionReason || stored.reason,
    selectedAt: stored.selectedAt,
    torrentFileId,
    ...(typeof canonicalTitle === 'string' && canonicalTitle.trim() ? { canonicalTitle: canonicalTitle.trim() } : {}),
    ...(Number.isSafeInteger(canonicalYear) ? { canonicalYear } : {}),
  };
  return { handoff, torrentFileId, torrentFile };
}


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
/**
 * The committed presentation identity of a media intent, if it has one.
 */
function committedPresentation(controlPlaneStore, { mediaId, mediaType, season = null, episode = null }) {
  if (!controlPlaneStore || typeof controlPlaneStore.getPresentationIdentity !== 'function') return null;
  try {
    const identityKey = createLibraryIdentityKey({
      mediaType: mediaType === 'movie' ? 'movie' : 'episode',
      mediaId,
      season: season ?? undefined,
      episode: episode ?? undefined,
    });
    return controlPlaneStore.getPresentationIdentity(stableLibraryItemId(identityKey)) ?? null;
  } catch {
    return null;
  }
}

async function ensureStrmForExistingHandoff(cache, controlPlaneStore, mediaId, mediaType, season = null, episode = null) {
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

  // Attempt STRM publication (idempotent - returns existing if present).
  // The COMMITTED presentation identity names the artifact when it exists:
  // no title is resolved and no metadata is fetched, so a republication
  // can neither move the artifact nor duplicate it.
  const presentation = committedPresentation(controlPlaneStore, {
    mediaId, mediaType, season, episode,
  });
  const strmResult = await publishStrm({
    handoff: handoffObj,
    ...(presentation ? { presentation } : {}),
  });

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
 * Fast-path reuse predicate + idempotent republication for already-healthy
 * published media.
 *
 * Returns an API-compatible searchByMedia result when durable truth proves
 * reusability, or null when the full discovery path must run. Only exact
 * lookups are eligible (movies by mediaId; episodes by mediaId+season+episode).
 *
 * Validity (all required):
 * - existing selected handoff with infoHash, releaseKey, and torrentFileId;
 * - TorrentFile row exists with identical infoHash and positive size
 *   (enforced again inside materializeVfsEntry via torrentFileForHandoff);
 * - at least one mapped present provider coordinate exists for the
 *   TorrentFile (listDataPlaneCoordinates — the S-1 serving set).
 *
 * On any insufficiency, unhealthy state, or publication error, returns null
 * so the caller falls through to full discovery. No new Release is ever
 * selected here.
 */
async function tryReuseHealthyPublication({
  cache,
  controlPlaneStore,
  hydrateVfs,
  mediaId,
  mediaType,
  season,
  episode,
  canonicalTitle = null,
  canonicalYear = null,
  ensureTorBoxFileIdentityFn = null,
  source = 'request',
  requestStartedAt = Date.now(),
  confirmPlexFn = null,
}) {
  // Plex presence seam: real confirmPlexEpisode in production, injected
  // probe in tests. Absent by default.
  const confirmPlex = typeof confirmPlexFn === 'function' ? confirmPlexFn : confirmPlexEpisode;
  try {
    // Prepared durable truth (shared with preparation): stored handoff +
    // matching TorrentFile + serving coordinates. Anything insufficient
    // falls through to full discovery below.
    const prepared = getPreparedDurableState({
      cache,
      controlPlaneStore,
      mediaId,
      mediaType,
      season,
      episode,
      canonicalTitle,
      canonicalYear,
    });
    if (!prepared) {
      return null;
    }
    const { handoff, torrentFileId, torrentFile } = prepared;
    const infoHash = handoff.infoHash;
    const hasEpisodeCoords = Number.isSafeInteger(season) && season >= 1
      && Number.isSafeInteger(episode) && episode >= 1;
    const isEpisode = mediaType === 'episode' || hasEpisodeCoords;

    const noopSelected = () => ({
      infoHash,
      fileIndex: handoff.fileIndex,
      filename: handoff.filename,
      provider: handoff.provider,
      providerState: handoff.providerState,
      identityTier: handoff.identityTier,
      resolutionState: handoff.resolutionState,
      releaseKey: handoff.releaseKey,
      torrentFileId,
      score: null,
      reason: 'reused-healthy-publication',
    });

    // The DELIVERY fact, read from the in-process byte-health registry.
    // It costs no provider work and it is never authority: it says whether
    // the exact bound TorrentFile can deliver bytes right now, which is a
    // different question from "is this the authoritative representation".
    const deliveryState = () => getServiceability(torrentFileId);

    const confirmReuseFulfillment = async () => {
      if (!isEpisode || !controlPlaneStore) return { fulfilled: false, retryOwned: true, unfulfilled: true, published: true, vfsPublished: true, plex: null };
      try {
        // The expected Part file comes from OUR durable canonical path, so
        // the check is "is OUR projection visible" — not "does the consumer
        // hold SOME Part for this episode".
        const itemKey = createLibraryIdentityKey({
          mediaType: isEpisode ? 'episode' : 'movie',
          mediaId,
          season: isEpisode ? season : null,
          episode: isEpisode ? episode : null,
        });
        const item = controlPlaneStore.getLibraryItemByIdentityKey?.(itemKey) ?? null;
        const canonical = item ? controlPlaneStore.getActiveCanonicalPath?.(item.id) : null;
        const expectedPartFile = vfsPartFile(canonical?.canonicalPath ?? null);
        const plex = await confirmPlex({ mediaId, season, episode, expectedPartFile });
        const fulfilled = plex?.visible === true && plex?.mediaPart?.file;
        return {
          fulfilled: !!fulfilled,
          retryOwned: !fulfilled,
          unfulfilled: !fulfilled,
          published: true,
          vfsPublished: true,
          plex: fulfilled ? plex : null,
        };
      } catch {
        return { fulfilled: false, retryOwned: true, unfulfilled: true, published: true, vfsPublished: true, plex: null };
      }
    };

    const noopResultEntry = () => ({
      rank: 1,
      infoHash,
      fileIndex: handoff.fileIndex,
      filename: handoff.filename,
      score: null,
      identity: {
        tier: handoff.identityTier,
        confidence: null,
        evidence: [],
        state: handoff.resolutionState,
        eligible: true,
      },
      release: {},
      sources: [],
      observations: [],
      availability: {},
    });

    // Path-A predicate: the VFS row itself must already name this exact
    // TorrentFile with a hydrated size, the library item must still desire
    // it, and the verified .strm must exist. Mirrors the identity asserts
    // inside materializeVfsEntry without any writes or network.
    const checkPublishedNoop = async () => {
      let vfsRow = null;
      try {
        vfsRow = isEpisode
          ? cache.getVfsTvEntry?.(mediaId, season, episode)
          : cache.getVfsMovieEntry?.(mediaId);
      } catch {
        return false;
      }
      if (!vfsRow
        || vfsRow.torrentFileId !== torrentFileId
        || String(vfsRow.infoHash || '').toLowerCase() !== String(infoHash).toLowerCase()
        || vfsRow.size !== torrentFile.size
        || typeof vfsRow.canonicalPath !== 'string'
        || vfsRow.canonicalPath.length === 0) {
        return false;
      }
      try {
        const key = createLibraryIdentityKey({
          mediaType: isEpisode ? 'episode' : 'movie',
          mediaId,
          season: isEpisode ? season : null,
          episode: isEpisode ? episode : null,
        });
        const item = controlPlaneStore.getLibraryItemByIdentityKey?.(key);
        if (!item || item.desiredState === 'absent') {
          return false;
        }
      } catch {
        return false;
      }
      const verified = await verifyPublishedStrm({
        vfsCanonicalPath: vfsRow.canonicalPath,
        mediaType: handoff.mediaType,
        mediaId,
        season: handoff.season,
        episode: handoff.episode,
      }).catch(() => null);
      return verified != null;
    };

    // Path A: already published + healthy → pure local no-op return.
    // All checks are SQLite reads or filesystem stats: no provider APIs,
    // no network title resolution, no VFS/STRM rewrites, no binding work,
    // no notifications. Anything insufficient takes path B (republish) or
    // falls through to full discovery.
    const noopReady = await checkPublishedNoop();
    if (noopReady) {
      const fulfillment = await confirmReuseFulfillment();
      cache.recordEvidenceQuery?.({ queryKey: `media:${mediaId}:${season ?? ''}:${episode ?? ''}`, observer: 'hashsucker', sourceClass: source, disposition: 'healthy_exact_reuse', observedAt: Date.now(), latencyMs: Date.now() - requestStartedAt, candidateCount: 0, selectedCount: 1 });
      return {
        requestId: handoff.requestId,
        intent: { type: handoff.mediaType, mediaId: handoff.mediaId },
        results: [noopResultEntry()],
        total: 1,
        query: { mediaId, mediaType, season, episode },
        identitySummary: { tier: handoff.identityTier, confidence: null, evidence: [] },
        ranking: { TieredRankingApplied: false, TierCounts: {}, reusedHealthyPublication: true },
        discovery: { liveDiscoveryTriggered: false, liveCandidates: 0, liveEligible: 0, reusedHealthyPublication: true },
        availability: { checked: 0, cached: 0, uncached: 0, unknown: 0 },
        selection: { selected: noopSelected(), reason: 'reused-healthy-publication', alternates: [] },
        handoff,
        demandPromotion: { enrichmentPromoted: 0, probePromoted: 0 },
        ...fulfillment,
        reuseMode: 'noop',
        // The representation is authoritative (the Binding); the delivery
        // state is reported separately, so "published" never hides a route
        // that just proved it cannot serve bytes.
        serviceability: deliveryState(),
      };
    }

    // Idempotent republication. Refresh the exact provider inventory first so
    // the authoritative Binding freshness guard can pass on a prepared handoff.
    // This remains same-TorrentFile only; no selection or discovery occurs.
    if (typeof ensureTorBoxFileIdentityFn === 'function' && torrentFileId) {
      try {
        await ensureTorBoxFileIdentityFn({ infoHash, skipSizeMatch: true });
      } catch (error) {
        console.warn(`Reuse binding inventory refresh failed: ${error.message}`);
      }
    }
    // materializeVfsEntry re-asserts the stored identity against the existing
    // row (throws on divergence → fall through to full discovery). The
    // publication module owns the rest: converged .strm, Jellyfin, VFS
    // hydration, and the confirm-then-notify Plex dispatch.
    try {
      await republishHealthyHandoff({
        cache,
        controlPlaneStore,
        handoff,
        mediaId: handoff.mediaId,
        mediaType: handoff.mediaType,
        season,
        episode,
        isEpisode,
        hydrateVfs,
      });
    } catch (error) {
      console.error(`Reuse republication failed, falling back to discovery: ${error.message}`);
      return null;
    }

    const selected = noopSelected();
    const fulfillment = await confirmReuseFulfillment();
    return {
      requestId: handoff.requestId,
      intent: { type: handoff.mediaType, mediaId: handoff.mediaId },
      results: [noopResultEntry()],
      total: 1,
      query: { mediaId, mediaType, season, episode },
      identitySummary: { tier: handoff.identityTier, confidence: null, evidence: [] },
      ranking: { TieredRankingApplied: false, TierCounts: {}, reusedHealthyPublication: true },
      discovery: { liveDiscoveryTriggered: false, liveCandidates: 0, liveEligible: 0, reusedHealthyPublication: true },
      availability: { checked: 0, cached: 0, uncached: 0, unknown: 0 },
      selection: { selected, reason: 'reused-healthy-publication', alternates: [] },
      handoff,
      demandPromotion: { enrichmentPromoted: 0, probePromoted: 0 },
      ...fulfillment,
      reuseMode: 'republish',
      serviceability: deliveryState(),
    };
  } catch (error) {
    console.error(`Reuse fast path failed, falling back to discovery: ${error.message}`);
    return null;
  }
}

/**
 * Search for release candidates by media identity.
 *
 * Product stage sequence:
 *   1. fast paths (already-prepared, healthy-publication reuse)
 *   2. candidate collection (corpus and/or live discovery)
 *   3. ranking → explainable rows
 *   4. provider availability
 *   5. binding selection
 *   6. request persistence
 *   7. durable handoff
 *   8. publication (request path) / materialization (corpus path)
 *   9. demand promotion + response
 *
 * Two candidate pipelines share those stages:
 *   - live pipeline: used when the corpus has no candidates for this item
 *     (or an explicit live-only retry). Publishes fully.
 *   - corpus pipeline: normal corpus-serving path. Materializes the
 *     authoritative VFS row and fails closed on presentation gaps.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {Object} request - Media request (see media-request-stages.buildRequestContext)
 * @returns {Promise<Object>} Ranked results with identity state and score breakdown
 */
export async function searchByMedia(cache, request) {
  const ctx = buildRequestContext(cache, request);
  perfTrace('request.start', {
    mediaId: ctx.mediaId,
    mediaType: ctx.mediaType,
    season: ctx.season,
    episode: ctx.episode,
    liveOnly: ctx.liveOnly,
    prepareOnly: ctx.prepareOnly,
    source: ctx.source ?? null,
  });

  // Stage 1a: preparation mode never publishes and never discovers when
  // durable truth already proves the item prepared.
  if (ctx.prepareOnly && !request.forceDiscovery && !ctx.liveOnly) {
    const already = getPreparedDurableState({
      cache,
      controlPlaneStore: ctx.controlPlaneStore,
      mediaId: ctx.mediaId,
      mediaType: ctx.mediaType,
      season: ctx.season,
      episode: ctx.episode,
    });
    if (already) {
      return {
        requestId: already.handoff.requestId ?? null,
        intent: ctx.intent,
        results: [],
        total: 0,
        query: { mediaId: ctx.mediaId, mediaType: ctx.mediaType, season: ctx.season, episode: ctx.episode },
        selection: { selected: null, reason: 'already-prepared', alternates: [] },
        handoff: already.handoff,
        prepared: true,
        alreadyPrepared: true,
        published: false,
      };
    }
  } else if (!ctx.liveOnly) {
    // Stage 1b: reuse a healthy durable publication (no discovery, no
    // provider work) — see tryReuseHealthyPublication.
    const reuseResult = await tryReuseHealthyPublication({
      cache,
      controlPlaneStore: ctx.controlPlaneStore,
      hydrateVfs: ctx.hydrateVfs,
      mediaId: ctx.mediaId,
      mediaType: ctx.mediaType,
      season: ctx.season,
      episode: ctx.episode,
      canonicalTitle: ctx.canonicalTitle,
      canonicalYear: ctx.canonicalYear,
      ensureTorBoxFileIdentityFn: ctx.ensureTorBoxFileIdentityFn,
      source: ctx.source,
      requestStartedAt: ctx.startedAt,
      confirmPlexFn: ctx.confirmPlexFn,
    });
    if (reuseResult) {
      return reuseResult;
    }
  }

  // Stage 2: candidate collection. Corpus rows suppress live discovery; a
  // live-only retry is used only after persisted candidates fail exact
  // durable binding — it keeps the same ranking/identity/binding pipeline
  // while preventing corpus rows from suppressing the live fallback.
  const titleIndex = await collectTitleIndexInputs(ctx);
  const titleInputs = ctx.liveOnly ? [] : titleIndex.inputs;
  const candidates = ctx.liveOnly ? [] : cache.queryCandidatesByMedia(ctx.mediaId);

  // Unreleased media never enters live discovery implicitly; an explicit
  // liveOnly request is an operator/manual override and still honors it.
  if ((candidates.length === 0 || ctx.liveOnly) && !ctx.skipLiveDiscovery
    && (!ctx.unreleased || ctx.liveOnly)) {
    return runLivePipeline(ctx, { titleIndex, titleInputs, candidates });
  }

  if (candidates.length === 0 && titleInputs.length === 0) {
    // No corpus candidates and no title-index hits — but an existing
    // durable handoff may still need its STRM materialized (idempotence
    // invariant).
    const { strmPath } = await ensureStrmForExistingHandoff(cache, ctx.controlPlaneStore, ctx.mediaId, ctx.mediaType, ctx.season, ctx.episode);
    return {
      requestId: null,
      intent: ctx.intent,
      results: [],
      total: 0,
      query: { mediaId: ctx.mediaId, mediaType: ctx.mediaType, season: ctx.season, episode: ctx.episode },
      identitySummary: { tier: 'none', confidence: 0, evidence: [] },
      ranking: { TieredRankingApplied: false, TierCounts: {} },
      discovery: { liveDiscoveryTriggered: false, liveCandidates: 0, liveEligible: 0 },
      availability: { checked: 0, cached: 0, uncached: 0, unknown: 0 },
      selection: { selected: null, reason: 'no candidates', alternates: [] },
      strmPath,
    };
  }

  return runCorpusPipeline(ctx, { titleIndex, titleInputs, candidates });
}

/* ------------------------------------------------------------------ *
 * Live pipeline — no corpus candidates (or explicit live-only retry).
 * ------------------------------------------------------------------ */

async function runLivePipeline(ctx, { titleIndex, titleInputs }) {
  const discovery = await runLiveDiscoveryStage(ctx, { wantedIdentity: titleIndex.wanted });
  const { liveCandidates, liveEligibilityByHash, liveMetadataByHash, liveEligibleCount } = discovery;

  if (liveCandidates.length === 0) {
    // No candidates from corpus or live discovery — but an existing durable
    // handoff may still need its STRM materialized (idempotence invariant).
    const { strmPath } = await ensureStrmForExistingHandoff(ctx.cache, ctx.controlPlaneStore, ctx.mediaId, ctx.mediaType, ctx.season, ctx.episode);
    return {
      requestId: null,
      intent: ctx.intent,
      results: [],
      total: 0,
      query: { mediaId: ctx.mediaId, mediaType: ctx.mediaType, season: ctx.season, episode: ctx.episode },
      identitySummary: { tier: 'none', confidence: 0, evidence: [] },
      ranking: { TieredRankingApplied: false, TierCounts: {} },
      discovery: { liveDiscoveryTriggered: true, liveCandidates: 0, liveEligible: 0, liveSources: discovery.sources },
      availability: { checked: 0, cached: 0, uncached: 0, unknown: 0 },
      selection: { selected: null, reason: 'no candidates', alternates: [] },
      strmPath,
    };
  }

  mergeTitleInputsIntoLive({
    titleInputs,
    titleEligibilityByHash: titleIndex.eligibilityByHash,
    liveCandidates,
    liveEligibilityByHash,
    seenLiveKeys: discovery.seenLiveKeys,
  });

  // Ranking → explainable rows. Tier classification uses the resolved
  // wanted identity (see corpus pipeline) for the same reason.
  const liveTierAliases = Array.isArray(titleIndex?.wanted?.aliases) ? titleIndex.wanted.aliases : [];
  const { ranked, tierMeta } = rankHitsTiered(
    liveCandidates,
    {
      season: ctx.season,
      episode: ctx.episode,
      mediaTitle: titleIndex?.wanted?.title ?? ctx.mediaTitle,
      ...(liveTierAliases.length > 0 ? { mediaTitleAliases: liveTierAliases } : {}),
      year: titleIndex?.wanted?.year ?? ctx.canonicalYear ?? null,
    },
    ctx.mediaId,
    liveEligibilityByHash,
  );
  const total = ranked.length;
  const explainable = shapeRankedResults({
    ranked, ctx, metadataByHash: new Map(), eligibilityByHash: liveEligibilityByHash,
    wantedIdentity: titleIndex?.wanted ?? null,
  });

  // Provider availability for eligible candidates.
  const availabilityStats = ctx.skipAvailability
    ? { checked: 0, cached: 0, uncached: 0, unknown: 0 }
    : await applyTorboxAvailability({ explainable, cache: ctx.cache });

  // Binding selection.
  const selection = await selectCandidateForRequest({ explainable, ctx });

  // No bloodhound re-entry here: this pipeline just consulted the live
  // market itself, so re-entering liveOnly would ask the same market the
  // same question. The corpus-pipeline trigger below is the meaningful one
  // (persisted rows insufficient → ask the market).

  // Request persistence (selection decides completed vs pending).
  const requestId = persistRequestAndBackfill({
    cache: ctx.cache, ctx, explainable, selection,
    status: selection.selected ? 'completed' : 'pending',
  });

  const base = requestResponseBase({
    ctx, requestId, total, tierMeta,
    liveDiscoveryTriggered: true, liveCandidates: liveCandidates.length, liveEligible: liveEligibleCount,
    liveSources: discovery.sources,
    availabilityStats, selection, explainable,
  });

  // Durable handoff + publication.
  let handoff = null;
  if (selection.selected && requestId) {
    handoff = buildHandoffForSelection({ cache: ctx.cache, ctx, requestId, selection, explainable });
    try {
      ctx.cache.persistPlaybackHandoff(handoff);
      if (!ctx.prepareOnly) {
        // Presentation: authoritative VFS → converged .strm → consumers.
        try {
          await publishSelectedHandoff({
            cache: ctx.cache,
            controlPlaneStore: ctx.controlPlaneStore,
            handoff,
            selection,
            mediaId: ctx.mediaId,
            mediaType: ctx.mediaType,
            season: ctx.season,
            episode: ctx.episode,
            isEpisode: ctx.isEpisode,
            hydrateVfs: ctx.hydrateVfs,
          });
        } catch (publicationError) {
          const stage = publicationError instanceof PublicationError ? publicationError.stage : null;
          const reason = stage === 'strm-publication'
            ? 'adapter-publication-failed'
            : 'durable-publication-failed';
          console.error(`Publication failed for ${ctx.mediaId} stage=${stage}: ${publicationError.message}`);
          return unfulfilledResponse({ base, reason, error: publicationError, extra: { handoff } });
        }
      }
    } catch (error) {
      return unfulfilledResponse({ base, reason: 'handoff-persistence-failed', error });
    }

    // Consumer confirmation: the authoritative Binding + Plex visibility
    // decide whether this request is fulfilled right now. An unconfirmed
    // publication falls through to the pending response below (demand
    // promotion still runs) — exactly as before.
    if (!ctx.prepareOnly) {
      const confirmed = await confirmAuthoritativePublication({ ctx, base, handoff, selection });
      if (confirmed) return confirmed;
    }
  }

  perfTrace('request.live_pipeline_end', {
    ms: Date.now() - ctx.startedAt,
    selected: !!selection.selected,
    reason: selection.reason,
  });
  return publishedOrPendingResponse({ ctx, base, handoff, selection, explainable });
}

/* ------------------------------------------------------------------ *
 * Corpus pipeline — the normal corpus-serving path.
 * ------------------------------------------------------------------ */

async function runCorpusPipeline(ctx, { titleIndex, titleInputs, candidates }) {
  // Build ranking inputs with identity associations. Metadata is kept
  // separately because rankHit() returns a new object.
  const metadataByHash = new Map();
  const eligibilityByHash = new Map();
  const rankingInputs = candidates.map((candidate) => buildCorpusRankingInput({
    cache: ctx.cache, candidate, ctx, eligibilityByHash, metadataByHash,
    wantedIdentity: titleIndex?.wanted ?? null,
  }));

  // Stage 2b: corpus eligible count. For an exact TV request, generic
  // season-pack rows do not prove that the requested episode can be
  // fulfilled; let the existing bindable selection attempt them, but do
  // not let them suppress the bounded live fallback.
  const corpusEligibleCount = rankingInputs.filter((input) => {
    const eligibility = eligibilityByHash.get(input.releaseKey);
    return eligibility ? eligibility.eligible : true;
  }).length;
  const exactEpisodeCorpusCount = (ctx.season != null && ctx.episode != null)
    ? rankingInputs.filter((input) => {
      const eligibility = eligibilityByHash.get(input.releaseKey);
      if (eligibility && !eligibility.eligible) return false;
      const release = input.releaseAttributes || {};
      return release.season === ctx.season && release.episode === ctx.episode;
    }).length
    : corpusEligibleCount;

  // Stage 2c: live discovery fallback.
  let liveDiscoveryTriggered = false;
  let liveCandidates = [];
  let liveEligibleCount = 0;
  const liveMetadataByHash = new Map();
  const liveEligibilityByHash = new Map();
  // Audit: ranking-determinism — live-vs-live dedup AND corpus-vs-live
  // dedup. A release already known to corpus is skipped (corpus wins — it
  // has authoritative mediaAssociations and providerObservations), and any
  // duplicate releaseKey appearing twice in the live stream is skipped so
  // the ranking set never contains two equal (hash, fileIndex) pairs.
  const seenLiveKeys = new Set();

  if (!ctx.skipLiveDiscovery && !ctx.unreleased && exactEpisodeCorpusCount < ctx.liveDiscoveryThreshold) {
    liveDiscoveryTriggered = true;
    console.log(`media-search: bloodhound live-start media=${ctx.mediaId} season=${ctx.season ?? ''} episode=${ctx.episode ?? ''} corpus=${exactEpisodeCorpusCount}`);
    const discovery = await runLiveDiscoveryStage(ctx, { wantedIdentity: titleIndex.wanted, withHistoricalPrior: true });
    liveCandidates = discovery.liveCandidates;
    liveEligibleCount = discovery.liveEligibleCount;
    console.log(`media-search: bloodhound live-results media=${ctx.mediaId} count=${discovery.rawCount}`);

    for (const live of discovery.liveCandidates) {
      const key = live.releaseKey;
      // Skip if already present in corpus (will be deduped later)
      if (eligibilityByHash.has(key)) {
        liveMetadataByHash.set(key, { ...discovery.liveMetadataByHash.get(key), live: true });
        continue;
      }
      // Skip duplicate live entries (same infoHash+fileIndex from multiple
      // live providers or repeated within one provider). Marking the key
      // seen after the corpus-check ensures a later corpus row never
      // overwrites a kept live entry either, but corpus is populated
      // before this loop runs so the inner check above already handles the
      // corpus side.
      if (seenLiveKeys.has(key)) continue;
      seenLiveKeys.add(key);

      liveEligibilityByHash.set(key, discovery.liveEligibilityByHash.get(key));
      liveMetadataByHash.set(key, discovery.liveMetadataByHash.get(key));
      // Build ranking input for live candidate
      rankingInputs.push(live);
    }
  }

  // Stage 3: Rank within tier (with eligibility overrides). Merge
  // eligibility maps for ranking.
  const rankingStartedAt = Date.now();
  const allEligibilityByHash = new Map([...eligibilityByHash, ...liveEligibilityByHash, ...titleIndex.eligibilityByHash]);
  {
    // Corpus title-index merge (same mechanism as the live path).
    const haveKeys = new Set(rankingInputs.map((i) => i?.releaseKey).filter(Boolean));
    for (const t of titleInputs) {
      if (haveKeys.has(t.releaseKey)) continue;
      haveKeys.add(t.releaseKey);
      rankingInputs.push(t);
    }
  }
  // Tier classification must see the same resolved wanted identity the
  // eligibility gate used — never just the caller-supplied mediaTitle,
  // which scheduler-driven requests leave null.
  const tierWantedAliases = Array.isArray(titleIndex?.wanted?.aliases) ? titleIndex.wanted.aliases : [];
  const tierIntent = {
    season: ctx.season,
    episode: ctx.episode,
    mediaTitle: titleIndex?.wanted?.title ?? ctx.mediaTitle,
    ...(tierWantedAliases.length > 0 ? { mediaTitleAliases: tierWantedAliases } : {}),
    year: titleIndex?.wanted?.year ?? ctx.canonicalYear ?? null,
  };
  const { ranked, tierMeta } = rankHitsTiered(rankingInputs, tierIntent, ctx.mediaId, allEligibilityByHash);
  const rankingLatencyMs = Date.now() - rankingStartedAt;

  // Stage 4/5: Paginate + explainable response rows.
  const total = ranked.length;
  const explainable = shapeRankedResults({
    ranked, ctx, metadataByHash, eligibilityByHash: allEligibilityByHash, liveMetadataByHash,
    wantedIdentity: titleIndex?.wanted ?? null,
  });

  const availabilityStats = ctx.skipAvailability
    ? { checked: 0, cached: 0, uncached: 0, unknown: 0 }
    : await applyTorboxAvailability({ explainable, cache: ctx.cache });

  // Stage 6: Persist results (this path always persists the pending
  // request; selection runs afterwards and reports fulfillment separately).
  const requestId = persistRequestAndBackfill({ cache: ctx.cache, ctx, explainable, selection: { selected: null } });

  // Stage 7: Binding selection.
  const selection = await selectCandidateForRequest({ explainable, ctx });

  // Bloodhound fallback, identical to the live pipeline's: persisted rows can
  // be identity-valid yet impossible to bind, and a released request gets
  // exactly one live re-entry before it is reported unfulfilled. Re-entering
  // with liveOnly keeps the same ranking/identity/binding pipeline while
  // preventing the corpus rows from suppressing the live market; it does not
  // create a second ranking or publication path.
  // A miss from the live re-entry is reported on THIS response: the caller
  // must be able to see that the market was asked (and what each route
  // answered) rather than inferring "never looked".
  let bloodhoundTriggered = false;
  let bloodhoundSources = [];
  // `!liveDiscoveryTriggered` keeps the fanout bounded at one per request
  // attempt: when this pipeline already consulted the live market (threshold
  // fallback) and came back empty, re-entering would ask the same market the
  // same question twice.
  if (!selection.selected && !ctx.skipLiveDiscovery && !ctx.liveOnly && !ctx.unreleased
    && !liveDiscoveryTriggered) {
    console.log(`media-search: bloodhound trigger media=${ctx.mediaId} season=${ctx.season ?? ''} episode=${ctx.episode ?? ''} candidates=${explainable.length} reason=${selection.reason}`);
    const liveRetry = await searchByMedia(ctx.cache, {
      ...ctx.request,
      liveOnly: true,
      forceDiscovery: true,
      skipLiveDiscovery: false,
      persist: true,
      bloodhound: true,
    });
    if (liveRetry?.selection?.selected) {
      return liveRetry;
    }
    bloodhoundTriggered = liveRetry?.discovery?.liveDiscoveryTriggered === true;
    bloodhoundSources = liveRetry?.discovery?.liveSources ?? [];
  }

  const base = requestResponseBase({
    ctx, requestId, total, tierMeta,
    liveDiscoveryTriggered: liveDiscoveryTriggered || bloodhoundTriggered,
    liveCandidates: liveCandidates.length,
    liveEligible: liveEligibleCount,
    liveSources: [...(liveDiscoveryTriggered ? [] : []), ...bloodhoundSources],
    availabilityStats, selection, explainable,
  });

  // Stage 8: Durable handoff + authoritative materialization.
  let handoff = null;
  if (selection.selected && requestId) {
    handoff = buildHandoffForSelection({ cache: ctx.cache, ctx, requestId, selection, explainable });
    try {
      ctx.cache.persistPlaybackHandoff(handoff);
    } catch (error) {
      console.error(`Handoff persistence failed: ${error.message}`);
    }
    // This corpus/live branch previously stopped after handoff persistence.
    // That made activateBinding() unreachable: no VFS materialization meant
    // no LibraryItem/Binding could be created. Enter the same authoritative
    // materialization boundary used by the full publication path.
    if (!ctx.prepareOnly) {
      try {
        const vfsEntry = await materializeHandoff({
          cache: ctx.cache, controlPlaneStore: ctx.controlPlaneStore, handoff,
        });
        if (!vfsEntry) {
          throw new PublicationError('vfs-materialization', new Error(`VFS materialization returned no entry for ${handoff.mediaId}`));
        }
      } catch (error) {
        console.error(`VFS materialization failed: ${error.message}`);
        return unfulfilledResponse({ base, reason: 'durable-publication-failed', error, extra: { handoff } });
      }
    }
  }

  // Stage 9: Demand-driven queue promotion.
  const promotion = promoteDemandForRequest({ cache: ctx.cache, ctx, explainable, selection });
  perfTrace('request.corpus_pipeline_end', {
    ms: Date.now() - ctx.startedAt,
    selected: !!selection.selected,
    reason: selection.reason,
  });

  ctx.cache.recordEvidenceQuery?.({
    queryKey: `media:${ctx.mediaId}:${ctx.season ?? ''}:${ctx.episode ?? ''}`, observer: 'hashsucker', sourceClass: ctx.source || 'request', disposition: 'ranked_request', observedAt: Date.now(), latencyMs: Date.now() - ctx.startedAt, candidateCount: rankingInputs.length, selectedCount: selection.selected ? 1 : 0,
  });

  return {
    ...base,
    handoff,
    demandPromotion: {
      enrichmentPromoted: promotion.enrichmentPromoted,
      probePromoted: promotion.probePromoted,
    },
    requestWork: {
      reuse: false, discovery: liveDiscoveryTriggered, ranking: true,
      candidateCount: rankingInputs.length, rankedCount: ranked.length,
      rankingLatencyMs, latencyMs: Date.now() - ctx.startedAt,
      source: ctx.source || 'request',
      selectedInfoHash: selection.selected?.infoHash ?? null,
      selectedTorrentFileId: selection.selected?._torrentFileId ?? handoff?.torrentFileId ?? null,
    },
    // This corpus/live fallback path persists the exact handoff but does not
    // execute the durable publication sequence above. A handoff is not a
    // publication, so released requests fail closed rather than report
    // `published: true`.
    prepared: ctx.prepareOnly && handoff != null,
    published: false,
    fulfilled: false,
    unfulfilled: !ctx.prepareOnly,
    retryOwned: !ctx.prepareOnly,
    reason: !ctx.prepareOnly ? 'durable-publication-incomplete' : undefined,
    ...skippedCandidatesOf(selection),
  };
}

/* ------------------------------------------------------------------ *
 * Shared end-of-pipeline stages
 * ------------------------------------------------------------------ */

/**
 * Authoritative publication confirmation for a freshly published item.
 * Returns the fulfilled response when the Binding and Plex both confirm,
 * otherwise null so the caller falls through to the pending response.
 */
async function confirmAuthoritativePublication({ ctx, base, handoff, selection = null }) {
  const itemKey = createLibraryIdentityKey({
    mediaType: ctx.mediaType === 'movie' ? 'movie' : 'episode',
    mediaId: ctx.mediaId,
    season: ctx.mediaType === 'movie' ? null : ctx.season,
    episode: ctx.mediaType === 'movie' ? null : ctx.episode,
  });
  const item = ctx.controlPlaneStore?.getLibraryItemByIdentityKey?.(itemKey);
  const binding = item ? ctx.controlPlaneStore?.getActiveBindingForLibraryItem?.(item.id) : null;
  const libraryPath = item ? ctx.controlPlaneStore?.getActiveCanonicalPath?.(item.id) : null;
  if (!binding || !libraryPath || binding.torrentFile.id !== handoff.torrentFileId) {
    return unfulfilledResponse({
      base, reason: 'authoritative-publication-incomplete',
      extra: { fulfilled: false, published: false, handoff },
    });
  }
  let plex = null;
  if ((ctx.mediaType === 'series' || ctx.mediaType === 'tv' || ctx.mediaType === 'episode')
    && ctx.season != null && ctx.episode != null) {
    const confirmPlex = ctx.confirmPlexFn ?? confirmPlexEpisode;
    // The expected Part file is derived from OUR durable canonical path:
    // the confirmation asks whether OUR projection is visible, not whether
    // the consumer happens to hold a Part.
    const expectedPartFile = vfsPartFile(libraryPath.canonicalPath);
    try {
      plex = await confirmPlex({
        mediaId: ctx.mediaId, season: ctx.season, episode: ctx.episode, expectedPartFile,
      });
    } catch { plex = null; }
  }
  if (plex?.visible && plex.mediaPart?.file) {
    return {
      ...base,
      handoff,
      published: true,
      vfsPublished: true,
      fulfilled: true,
      unfulfilled: false,
      retryOwned: false,
      serviceability: selection?.serviceability ?? null,
      plex,
    };
  }
  // Not visible (or a movie): fall through to the pending response.
  return null;
}

/** Demand promotion + final response for a published-or-pending live request. */
function publishedOrPendingResponse({ ctx, base, handoff, selection, explainable }) {
  const promotion = promoteDemandForRequest({ cache: ctx.cache, ctx, explainable, selection: selection ?? { selected: null } });
  return {
    ...base,
    handoff: handoff ?? null,
    demandPromotion: {
      enrichmentPromoted: promotion.enrichmentPromoted,
      probePromoted: promotion.probePromoted,
    },
    // Preparation tranche: preparation persists reusable durable truth
    // (handoff + TorrentFile + coordinates) without presentation.
    prepared: ctx.prepareOnly && handoff != null,
    published: !ctx.prepareOnly && handoff != null,
    vfsPublished: !ctx.prepareOnly && handoff != null,
    fulfilled: false,
    unfulfilled: !ctx.prepareOnly,
    retryOwned: !ctx.prepareOnly,
    reason: !ctx.prepareOnly ? 'plex-confirmation-pending' : undefined,
    // Execution-quality tranche: runtime byte serviceability of the selected
    // representation. {state:'serviceable'|'unserviceable'|'unknown', reason,
    // provider, source, retryInMs} when a selection probe ran; null otherwise.
    // An unserviceable selection still publishes (visible) but reports the
    // exact route blocker. This is DELIVERY truth, never representation
    // authority: the Binding is unchanged either way.
    serviceability: selection?.serviceability ?? null,
    ...skippedCandidatesOf(selection ?? { selected: null }),
  };
}
