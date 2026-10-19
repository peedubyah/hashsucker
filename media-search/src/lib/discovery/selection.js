/**
 * Candidate Selection Module
 *
 * Pure selection logic — no I/O, no ranking weights, no provider calls.
 * Operates on already-ranked results with availability data.
 *
 * Selection rules:
 * - Only eligible candidates (identity.eligible !== false)
 * - Prefer 'cached' over 'uncached'
 * - Among cached candidates, preserve ranking order
 * - 'unknown' may be used only if no cached candidate exists
 * - Ineligible candidates can never win
 */

import { isPlayableVideoTorrentFile } from '../resolver/tv-episode-resolver.js';
import { parseFilename } from './parser-adapter.js';
import { perfTrace } from '../perf-trace.js';

/**
 * Proven-contradiction check for PATH A TV binds.
 *
 * Exact-size binding proves the FILE (unique size within the torrent),
 * not the EPISODE. A candidate whose release name says S01E02 but whose
 * sized file is actually E10 (upstream stream mislabel, multi-episode
 * size collision) must not bind through the fast path. Returns true
 * ONLY on proven contradiction: the bound path parses to an exact
 * single season+episode that disagrees with the request. Unparseable
 * paths and episode ranges preserve today's behavior (release-level
 * title+S/E already passed) — PATH B still decides those.
 */
function boundFileContradictsEpisode(internalPath, season, episode) {
  if (!internalPath || !Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) return false;
  let parsed = null;
  try {
    parsed = parseFilename(internalPath)?.parsed ?? null;
  } catch {
    return false;
  }
  if (!parsed || parsed.season == null || parsed.episode == null) return false;
  if (parsed.episodeRange != null) return false;
  return parsed.season !== season || parsed.episode !== episode;
}

function isMediaPayloadForSelection(controlPlaneStore, torrentFileId) {
  if (!controlPlaneStore || typeof controlPlaneStore.getTorrentFile !== 'function') return true;
  const torrentFile = controlPlaneStore.getTorrentFile(torrentFileId);
  return isPlayableVideoTorrentFile(torrentFile);
}

/**
 * Select the best candidate from ranked results.
 *
 * @param {Object[]} results - Ranked results from searchByMedia
 * @param {Object} [options] - Selection options
 * @param {string} [options.preferState='cached'] - Preferred availability state
 * @returns {{selected: Object|null, reason: string, alternates: Object[]}}
 */
export function selectBestCandidate(results, options = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    return {
      selected: null,
      reason: 'no candidates',
      alternates: [],
    };
  }

  // Filter to eligible candidates only
  const eligible = results.filter(r => r.identity?.eligible !== false);

  if (eligible.length === 0) {
    return {
      selected: null,
      reason: 'no eligible candidates',
      alternates: [],
    };
  }

  // Group by TorBox availability state
  const byState = {
    cached: [],
    uncached: [],
    unknown: [],
  };

  for (const candidate of eligible) {
    const state = candidate.availability?.torbox?.state || 'unknown';
    if (byState[state]) {
      byState[state].push(candidate);
    } else {
      byState.unknown.push(candidate);
    }
  }

  // Selection strategy: cached first, then unknown (only if no cached), never uncached unless only option
  let selected = null;
  let reason = '';

  if (byState.cached.length > 0) {
    // Already in ranking order — take first cached
    selected = byState.cached[0];
    reason = 'highest-ranked cached eligible candidate';
  } else if (byState.unknown.length > 0) {
    // No cached, but have unknown — can use as fallback
    selected = byState.unknown[0];
    reason = 'no cached candidates; highest-ranked unknown eligible candidate';
  } else if (byState.uncached.length > 0) {
    // Only uncached available
    selected = byState.uncached[0];
    reason = 'no cached or unknown candidates; highest-ranked uncached eligible candidate';
  }

  if (!selected) {
    return {
      selected: null,
      reason: 'no eligible candidates with availability data',
      alternates: eligible.slice(0, 5),
    };
  }

  // Build alternates list (other eligible candidates, excluding selected)
  const alternates = eligible
    .filter(c => c.infoHash !== selected.infoHash || c.fileIndex !== selected.fileIndex)
    .slice(0, 10)
    .map(c => ({
      infoHash: c.infoHash,
      fileIndex: c.fileIndex,
      filename: c.filename,
      rank: c.rank,
      score: c.score,
      identityTier: c.identity?.tier,
      torboxState: c.availability?.torbox?.state || 'unknown',
    }));

  return {
    selected: formatSelection(selected),
    reason,
    alternates,
  };
}

/**
 * Format a selected candidate for output.
 * @param {Object} candidate
 * @returns {Object}
 */
function formatSelection(candidate) {
  return {
    infoHash: candidate.infoHash,
    fileIndex: candidate.fileIndex,
    filename: candidate.filename,
    rank: candidate.rank,
    score: candidate.score,
    identityTier: candidate.identity?.tier,
    identityConfidence: candidate.identity?.confidence,
    torboxState: candidate.availability?.torbox?.state || 'unknown',
    torboxCheckedAt: candidate.availability?.torbox?.checkedAt || null,
    release: candidate.release ? {
      title: candidate.release.title,
      year: candidate.release.year,
      resolution: candidate.release.resolution,
      source: candidate.release.source,
      codec: candidate.release.codec,
      hdr: candidate.release.hdr,
      releaseGroup: candidate.release.releaseGroup,
      season: candidate.release.season,
      episode: candidate.release.episode,
    } : null,
    sources: candidate.sources?.map(s => s.origin) || [],
    // Slice 1.75: the raw per-file byte size from behaviorHints.videoSize.
    // Null when the source stream had no numeric videoSize. The pre-publication
    // TorBox identity helper uses this to match provider files by exact size.
    // Sourced from the strict `exactFileSize` (Number.isSafeInteger && > 0);
    // the legacy `selectedFileSize` is only consulted as a compatibility shim
    // for upstream callers that pre-date the strict-field rename.
    selectedFileSize:
      Number.isSafeInteger(candidate.exactFileSize) && candidate.exactFileSize > 0
        ? candidate.exactFileSize
        : Number.isSafeInteger(candidate.selectedFileSize) && candidate.selectedFileSize > 0
          ? candidate.selectedFileSize
          : null,
  };
}

/**
 * Slice 2.1 — Bindable TV Candidate Selection
 *
 * Iterate ranked candidates in EXISTING array order until one becomes bindable.
 * A candidate is bindable when either:
 *   (A) it carries a trustworthy exact selected-file size and exact-size binding succeeds, OR
 *   (B) it is a TV media request and TV episode resolution succeeds uniquely.
 *
 * No rediscovery, no reranking, no mutation of the input array.
 *
 * @param {Object[]} results     - Already-ranked explainable candidates
 * @param {Object}   options
 * @param {Function} options.ensureTorBoxFileIdentityFn
 * @param {Function} options.resolveTvTorrentFileFn  - resolveTvTorrentFile({ torrentFiles, season, episode })
 * @param {Object}   options.tvCoordinates           - { season, episode } or null for movies
 * @param {Object}   options.controlPlaneStore
 * @returns {{ selected: Object|null, reason: string, alternates: Object[], skipped: Object[] }}
 */
export async function selectBindableCandidate(results, options = {}) {
  const {
    ensureTorBoxFileIdentityFn,
    ensureRealDebridFileIdentityFn = null,
    resolveTvTorrentFileFn,
    tvCoordinates,
    controlPlaneStore,
    // Intent quality cap (quality-profile tranche): drop candidates
    // above this tier so a bounded profile never binds a giant it does
    // not want. Null = uncapped (today's behavior). Never empties the
    // set: if everything exceeds the cap, fall back unfiltered rather
    // than failing the request.
    maxTier = null,
    // Serviceability-aware selection (execution-quality tranche). When
    // provided, a candidate that BINDS is not accepted until this probe
    // confirms the exact TorrentFile can actually deliver bytes here. An
    // unserviceable bind is skipped and the traversal continues to the next
    // acceptable candidate, so a representation that is merely cached-but-dead
    // no longer wins over one that is actually executable.
    //
    //   serviceabilityProbeFn(torrentFileId, { provider, infoHash, rank })
    //     -> { serviceable: boolean, reason?: string, source?: string }
    //
    // Omitted (null) => EXACT pre-change behavior (no probe, first bind wins).
    serviceabilityProbeFn = null,
    // Bound on how many EXTRA candidates are attempted after the first
    // unserviceable bind. Prevents "probe the world": we never call providers
    // for every ranked candidate. The first unserviceable bind is retained as
    // the fallback so the request still publishes (visible + precise blocker)
    // when no serviceable candidate exists.
    maxServiceabilityAlternates = 4,
  } = options;

  if (!Array.isArray(results) || results.length === 0) {
    return { selected: null, reason: 'no candidates', alternates: [], skipped: [] };
  }

  const eligible = results.filter(r => r.identity?.eligible !== false);

  if (eligible.length === 0) {
    return { selected: null, reason: 'no eligible candidates', alternates: [], skipped: [] };
  }

  let capped = eligible;
  if (Number.isFinite(maxTier)) {
    try {
      const { tierOf } = await import('../lifecycle/upgrade-policy.js');
      const under = eligible.filter((r) => {
        const t = tierOf({ sourceType: r.release?.source ?? null, resolution: r.release?.resolution ?? null });
        return t.tier == null || t.tier <= maxTier;
      });
      if (under.length > 0) capped = under;
    } catch {}
  }

  const skipped = [];
  let selected = null;
  let reason = '';
  // RD-only tranche: when no RD ensure seam is configured, every early
  // exit below behaves exactly as before this change (zero behavior
  // delta for TorBox-only deployments).
  const hasRdSeam = typeof ensureRealDebridFileIdentityFn === 'function';

  // ---- Serviceability gate (execution-quality tranche) ----
  // A bound candidate is accepted only when the exact TorrentFile is (or can
  // prove it is) byte-serviceable. The FIRST unserviceable bind is kept as the
  // fallback so that when nothing is serviceable the request still publishes
  // the best-ranked representation and reports the exact blocker; but if a
  // later acceptable candidate IS serviceable, it wins.
  const probeServiceability = typeof serviceabilityProbeFn === 'function' ? serviceabilityProbeFn : null;
  const maxAlternates = Number.isFinite(maxServiceabilityAlternates)
    ? Math.max(0, maxServiceabilityAlternates) : 4;
  // How many candidates are inspected AFTER the first unserviceable bind. This
  // is the "small top-N" bound: it stops the alternate search so providers are
  // never called for every ranked candidate.
  let serviceabilityVisitedAfterReject = 0;
  let serviceabilityFallback = null; // { selection, binding, reason, candidate, probe }
  let serviceability = null;         // outcome for the winning candidate

  async function acceptBound(candidate) {
    if (!probeServiceability) return true; // no gate: exact pre-change behavior
    const binding = selected?._binding ?? null;
    const provider = binding?.provider ?? 'torbox';
    let probe;
    const probeStartedAt = Date.now();
    try {
      probe = await probeServiceability(selected._torrentFileId, {
        provider, infoHash: candidate.infoHash, rank: candidate.rank,
      });
    } catch (err) {
      probe = { serviceable: false, reason: `probe-error:${String(err?.message || err).slice(0, 60)}` };
    }
    perfTrace('selection.serviceability_probe', {
      torrentFileId: selected._torrentFileId,
      provider,
      rank: candidate.rank,
      ms: Date.now() - probeStartedAt,
      serviceable: probe?.serviceable === true,
      source: probe?.source ?? null,
      reason: probe?.reason ?? null,
    });
    if (probe?.serviceable) {
      serviceability = { state: 'serviceable', source: probe.source ?? 'probe' };
      return true;
    }
    // Remember the best-ranked unserviceable bind as the publish fallback, and
    // reject this bind so the traversal continues to a possibly-serviceable one.
    if (!serviceabilityFallback) {
      serviceabilityFallback = { selection: selected, binding, reason, candidate, probe };
    }
    skipped.push({
      infoHash: candidate.infoHash,
      rank: candidate.rank,
      torboxState: candidate.availability?.torbox?.state || 'unknown',
      reason: `bound-unserviceable:${probe?.reason ?? 'unknown'}`,
    });
    selected = null;
    reason = '';
    return false;
  }

  // Two-phase traversal: candidates the fresh availability batch proved
  // uncached are deferred to a fallback pass. Under static provider truth
  // (the seconds-long request window) this selects the identical winner:
  // every deferred candidate would have failed its ensure exactly as the
  // batch predicts, and any candidate that binds is attempted in rank
  // order within its phase. A TorBox cached-set flip mid-request is the
  // only divergence source, and it can only swap between equally-ranked
  // bindable releases. Unknown/missing states always attempt normally.
  //
  // Ranker V2 fix 2 (tier-aware fulfillability): traversal is tier-major,
  // availability-minor. Strong identity tiers (Verified, ProviderConfirmed,
  // Probable) are attempted before weak ones (ProviderScoped, TextOnly,
  // Rejected) regardless of cache state, so a cached weak row can no
  // longer silently outrank a stronger-identity candidate. Within a tier
  // class the existing cached/unknown-before-uncached preference holds.
  // Tierless rows keep legacy relative order (strong side). Stable sort
  // preserves rank order inside each phase.
  const STRONG_TIERS = new Set(['Verified', 'ProviderConfirmed', 'Probable']);
  const tierClass = (c) => {
    const t = c.identity?.tier;
    if (!t) return 0;
    return STRONG_TIERS.has(t) ? 0 : 1;
  };
  const availClass = (c) => (c.availability?.torbox?.state === 'uncached' ? 1 : 0);
  const immediate = [];
  const deferred = [];
  for (const candidate of capped) {
    (availClass(candidate) === 0 ? immediate : deferred).push(candidate);
  }
  const ordered = [...immediate, ...deferred]
    .map((c, i) => [c, i])
    .sort((a, b) => (tierClass(a[0]) - tierClass(b[0])) || (a[1] - b[1]))
    .map(([c]) => c);

  for (const candidate of ordered) {
    const candidateStartedAt = Date.now();
    perfTrace('selection.candidate_attempt', {
      rank: candidate.rank,
      hash: candidate.infoHash,
      tier: candidate.identity?.tier ?? null,
      torboxState: candidate.availability?.torbox?.state ?? 'unknown',
      fileSize: Number.isSafeInteger(candidate.exactFileSize) && candidate.exactFileSize > 0
        ? candidate.exactFileSize
        : (Number.isSafeInteger(candidate.selectedFileSize) && candidate.selectedFileSize > 0
          ? candidate.selectedFileSize : null),
    });
    // Alternate-search budget: once a bind has been rejected as unserviceable,
    // inspect at most `maxAlternates` further candidates, then publish the
    // best-ranked unserviceable bind with a precise blocker. Bounds provider
    // work: never "probe the world".
    if (probeServiceability && serviceabilityFallback) {
      if (serviceabilityVisitedAfterReject >= maxAlternates) {
        selected = serviceabilityFallback.selection;
        reason = serviceabilityFallback.reason;
        serviceability = {
          state: 'blocked',
          reason: serviceabilityFallback.probe?.reason ?? 'unknown',
          provider: serviceabilityFallback.binding?.provider ?? null,
        };
        break;
      }
      serviceabilityVisitedAfterReject += 1;
    }
    // Set when PATH A/B bound this candidate but the serviceability gate
    // rejected it; the later same-candidate paths are then skipped so we do not
    // re-bind the same exact TorrentFile, and PATH C (RD) may still discover an
    // RD route for the SAME hash.
    let pathARejected = false;
    // ---- PATH A: exact-file-size binding (existing Slice 1.75 fast path) ----
    const selectedFileSize =
      Number.isSafeInteger(candidate.exactFileSize) && candidate.exactFileSize > 0
        ? candidate.exactFileSize
        : Number.isSafeInteger(candidate.selectedFileSize) && candidate.selectedFileSize > 0
          ? candidate.selectedFileSize
          : null;

    // PATH A failure code, when PATH A ran. A NO_PLACEMENT (or missing
    // inventory provider) failure is deterministic for this candidate: the
    // PATH B ensure below would fail identically (same placement/create
    // preconditions), so PATH B is skipped and records what it would have
    // recorded. Any other failure still runs PATH B (e.g. size mismatch
    // can still bind via single-file/episode rules).
    let pathAFailureCode = null;
    if (selectedFileSize != null && typeof ensureTorBoxFileIdentityFn === 'function') {
      const ensureStartedAt = Date.now();
      try {
        const sizeResult = await ensureTorBoxFileIdentityFn({
          infoHash: candidate.infoHash,
          selectedFileSize,
          releaseKey: candidate.release?.key || null,
        });
        perfTrace('selection.ensure', {
          path: 'A-exact-size',
          rank: candidate.rank,
          hash: candidate.infoHash,
          selectedFileSize,
          ms: Date.now() - ensureStartedAt,
          bound: !!sizeResult?.torrentFileId,
          torrentFileId: sizeResult?.torrentFileId ?? null,
          placementId: sizeResult?.placementId ?? null,
        });
        if (sizeResult?.torrentFileId
          && isMediaPayloadForSelection(controlPlaneStore, sizeResult.torrentFileId)) {
          // PATH A TV verification (wrong-content slice): the size proved
          // the file, not the episode. A proven S/E contradiction in the
          // bound file's own path falls through to PATH B episode
          // resolution instead of binding the wrong episode.
          const tvVerify = tvCoordinates && controlPlaneStore
            && typeof controlPlaneStore.getTorrentFile === 'function'
            ? controlPlaneStore.getTorrentFile(sizeResult.torrentFileId)
            : null;
          if (tvVerify && boundFileContradictsEpisode(tvVerify.internalPath, tvCoordinates.season, tvCoordinates.episode)) {
            skipped.push({
              infoHash: candidate.infoHash,
              rank: candidate.rank,
              torboxState: candidate.availability?.torbox?.state || 'unknown',
              reason: `path-a-episode-contradiction: sized file "${tvVerify.internalPath ?? '?'}" is not S${String(tvCoordinates.season).padStart(2, '0')}E${String(tvCoordinates.episode).padStart(2, '0')}`,
            });
            // pathARejected stays false so PATH B still runs: it may
            // resolve the correct episode from another file in the
            // same torrent. Fall through (no select, no break).
          } else {
            selected = formatSelection(candidate);
            selected._torrentFileId = sizeResult.torrentFileId;
            selected._binding = {
              status: 'exact-size',
              torrentFileId: sizeResult.torrentFileId,
              placementId: sizeResult.placementId,
              providerFileId: sizeResult.providerFileId,
              size: sizeResult.size,
              selectedFileSize,
            };
            reason = 'exact-size bound';
            if (await acceptBound(candidate)) break;
            pathARejected = true;
          }
        }
      } catch (err) {
        perfTrace('selection.ensure', {
          path: 'A-exact-size',
          rank: candidate.rank,
          hash: candidate.infoHash,
          selectedFileSize,
          ms: Date.now() - ensureStartedAt,
          bound: false,
          code: err?.code ?? null,
          err: String(err?.message ?? err),
        });
        // exact-size failed; PATH B below decides whether a retry is worthwhile.
        pathAFailureCode = err?.code ?? null;
      }
    }

    if (pathAFailureCode === 'NO_PLACEMENT' || pathAFailureCode === 'INVENTORY_UNAVAILABLE') {
      skipped.push({
        infoHash: candidate.infoHash,
        rank: candidate.rank,
        torboxState: candidate.availability?.torbox?.state || 'unknown',
        reason: tvCoordinates ? 'TorBox placement failed' : 'movie-cached-placement-failed',
      });
      if (!hasRdSeam) continue;
      }

    // ---- PATH B (movie): cached-only single-file binding fallback ----
    // Slice 2.7: when discovery did not provide a trustworthy exact
    // selected-file size (e.g. behaviorHints.videoSize absent on a cold
    // Stremio stream) we cannot use the exact-size fast path. For a movie
    // we therefore consult the authoritative TorBox inventory that the
    // cached-only placement already populated: the candidate is bindable
    // when the durable TorrentFile inventory contains EXACTLY ONE playable
    // video file. Zero files → unbindable; >1 files → ambiguous; both
    // unbindable paths fall through to the next already-ranked candidate.
    // The provider call surface is identical to the TV PATH B: one
    // cached-only placement create (addOnlyIfCached=true; never an
    // uncached download) plus the inventory fetch driven by the same
    // ensureTorBoxFileIdentityFn factory. No nested retries.
    if (!pathARejected
        && !tvCoordinates
        && selectedFileSize == null
        && typeof ensureTorBoxFileIdentityFn === 'function'
        && controlPlaneStore) {
      let placementId = null;
      let placementTorrentFiles = null;
      // With an RD seam configured, a failed TorBox movie path must fall
      // through to the RD path (PATH C) for the SAME candidate — never to
      // the remainder of this block, which assumes a usable inventory.
      // Without an RD seam, any failure moves to the next candidate.
      let moviePathBFailed = false;
      const movieEnsureStartedAt = Date.now();
      try {
        const result = await ensureTorBoxFileIdentityFn({
          infoHash: candidate.infoHash,
          controlPlaneStore,
          skipSizeMatch: true,
        });
        perfTrace('selection.ensure', {
          path: 'B-movie-cached-single-file',
          rank: candidate.rank,
          hash: candidate.infoHash,
          ms: Date.now() - movieEnsureStartedAt,
          bound: true,
          placementId: result?.placementId ?? null,
        });
        placementId = result?.placementId ?? null;
        // Prefer the inventory returned by the helper, but fall back to a
        // authoritative listTorrentFilesForRelease read so the cardinality
        // check always sees the freshly-persisted TorrentFile rows
        // (replaceProviderFileInventory may have assigned torrent_file_id
        // mapping state the in-memory `files` array doesn't reflect yet).
        placementTorrentFiles = result?.torrentFiles
          ?? controlPlaneStore.listTorrentFilesForRelease(candidate.infoHash);
      } catch (err) {
        perfTrace('selection.ensure', {
          path: 'B-movie-cached-single-file',
          rank: candidate.rank,
          hash: candidate.infoHash,
          ms: Date.now() - movieEnsureStartedAt,
          bound: false,
          code: err?.code ?? null,
          err: String(err?.message ?? err),
        });
        // Placement create refused (release not cached) or inventory fetch
        // failed. Either way, this candidate cannot be bound authoritatively;
        // continue to the next already-ranked candidate.
        skipped.push({
          infoHash: candidate.infoHash,
          rank: candidate.rank,
          torboxState: candidate.availability?.torbox?.state || 'unknown',
          reason: 'movie-cached-placement-failed',
        });
        if (!hasRdSeam) continue;
        moviePathBFailed = true;
      }

      if (!moviePathBFailed && (!Array.isArray(placementTorrentFiles) || placementTorrentFiles.length === 0)) {
        skipped.push({
          infoHash: candidate.infoHash,
          rank: candidate.rank,
          torboxState: candidate.availability?.torbox?.state || 'unknown',
          reason: 'movie-no-torrent-files',
        });
        if (!hasRdSeam) continue;
        moviePathBFailed = true;
      }

      if (!moviePathBFailed) {
        // Use the same playable-video filter as TV PATH B so the project
        // rules (video extensions + non-sample + positive integer size) are
        // honored uniformly across media types.
        const playable = placementTorrentFiles.filter(isPlayableVideoTorrentFile);
        if (playable.length !== 1) {
          skipped.push({
            infoHash: candidate.infoHash,
            rank: candidate.rank,
            torboxState: candidate.availability?.torbox?.state || 'unknown',
            reason: playable.length === 0 ? 'movie-no-playable' : 'movie-ambiguous',
          });
          if (!hasRdSeam) continue;
          moviePathBFailed = true;
        } else {
          // Cardinality == 1 → bind authoritatively. Map the chosen
          // TorrentFile back to its present provider_file (within the placement
          // we just created) so the durable handoff carries the full
          // (placement, providerFile, torrentFile) identity triple.
          const torrentFile = playable[0];
          let providerFileId = null;
          if (placementId && typeof controlPlaneStore.listProviderRefsForTorrentFile === 'function') {
            const refs = controlPlaneStore.listProviderRefsForTorrentFile(torrentFile.id) || [];
            const present = refs.find((r) => r.placementId === placementId && r.present);
            providerFileId = present?.providerFileId ?? null;
          }
          selected = formatSelection(candidate);
          selected._torrentFileId = torrentFile.id;
          selected._binding = {
            status: 'movie-cached-single-file',
            torrentFileId: torrentFile.id,
            placementId,
            providerFileId,
            size: torrentFile.size,
          };
          reason = 'movie-cached-single-file bound';
          if (await acceptBound(candidate)) break;
          pathARejected = true;
        }
      }
    }

    // ---- PATH B: TV episode resolution from cached-only TorBox inventory ----
    if (!pathARejected
        && tvCoordinates && typeof resolveTvTorrentFileFn === 'function' && controlPlaneStore) {
      const { season, episode } = tvCoordinates;
      if (Number.isSafeInteger(season) && season >= 1 &&
          Number.isSafeInteger(episode) && episode >= 1) {
        // STEP 1: Ensure cached-only TorBox placement + authoritative inventory + TorrentFiles.
        // Uses the same ensureTorBoxFileIdentityFn factory as PATH A but skips
        // the selectedFileSize match (no exact size evidence available for TV).
        // This guarantees listTorrentFilesForRelease returns non-empty results
        // when the candidate is actually TorBox-cached.
        if (typeof ensureTorBoxFileIdentityFn !== 'function') {
          console.error(`[PATH B] No TorBox integration — cannot bind ${candidate.infoHash}`);
          skipped.push({
            infoHash: candidate.infoHash,
            rank: candidate.rank,
            torboxState: candidate.availability?.torbox?.state || 'unknown',
            reason: 'no TorBox integration',
          });
          if (!hasRdSeam) continue;
        }
        let placementTorrentFiles;
        let placementId = null;
        let placementFailed = false;
        const tvEnsureStartedAt = Date.now();
        try {
          const result = await ensureTorBoxFileIdentityFn({
            infoHash: candidate.infoHash,
            controlPlaneStore,
            skipSizeMatch: true,
          });
          perfTrace('selection.ensure', {
            path: 'B-tv-episode',
            rank: candidate.rank,
            hash: candidate.infoHash,
            ms: Date.now() - tvEnsureStartedAt,
            bound: true,
            placementId: result?.placementId ?? null,
          });
          placementId = result?.placementId ?? null;
          placementTorrentFiles = result?.torrentFiles ?? controlPlaneStore.listTorrentFilesForRelease(candidate.infoHash);
        } catch (err) {
          perfTrace('selection.ensure', {
            path: 'B-tv-episode',
            rank: candidate.rank,
            hash: candidate.infoHash,
            ms: Date.now() - tvEnsureStartedAt,
            bound: false,
            code: err?.code ?? null,
            err: String(err?.message ?? err),
          });
          console.error(`[PATH B] ensureTorBox FAILED hash=${candidate.infoHash} err=${err?.message ?? err}`);
          skipped.push({
            infoHash: candidate.infoHash,
            rank: candidate.rank,
            torboxState: candidate.availability?.torbox?.state || 'unknown',
            reason: 'TorBox placement failed',
          });
          placementFailed = true;
        }

        // STEP 2: Resolve requested S/E from the now-persisted TorrentFiles.
        // When the placement ensure already failed there is nothing to resolve:
        // falling through would hand `undefined` to the resolver and report
        // INVALID_COORDINATES, which reads like bad input rather than "not
        // cached yet".
        if (!placementFailed) try {
          const { torrentFile } = resolveTvTorrentFileFn({ torrentFiles: placementTorrentFiles, season, episode });
          if (!isPlayableVideoTorrentFile(torrentFile)) {
            throw { code: 'EPISODE_NOT_PLAYABLE', message: 'Selected TorrentFile is not a playable media payload' };
          }
          // Map the chosen TorrentFile back to its present provider_file so
          // the durable handoff carries the full (placement, providerFile,
          // torrentFile) identity triple. Without this, the handoff's
          // torrentFileIdentity.placementId and .providerFileId are null
          // even though the placement is the source of truth for the binding.
          let providerFileId = null;
          if (placementId && typeof controlPlaneStore.listProviderRefsForTorrentFile === 'function') {
            const refs = controlPlaneStore.listProviderRefsForTorrentFile(torrentFile.id) || [];
            const present = refs.find((r) => r.placementId === placementId && r.present);
            providerFileId = present?.providerFileId ?? null;
          }
          selected = formatSelection(candidate);
          selected._torrentFileId = torrentFile.id;
          selected._binding = {
            status: 'tv-episode',
            torrentFileId: torrentFile.id,
            placementId,
            providerFileId,
            size: torrentFile.size,
            season,
            episode,
          };
          reason = `tv-episode bound S${season}E${episode}`;
          if (await acceptBound(candidate)) break;
          pathARejected = true;
        } catch (err) {
          // unbindable: EPISODE_NOT_PLAYABLE | EPISODE_NOT_FOUND | EPISODE_AMBIGUOUS
          // skip to next candidate
          skipped.push({
            infoHash: candidate.infoHash,
            rank: candidate.rank,
            torboxState: candidate.availability?.torbox?.state || 'unknown',
            reason: err?.code || 'tv-resolution-failed',
          });
        }
      }
    }

    // ---- PATH C: Real-Debrid durable ensure (RD-only tranche) ----
    // Runs per candidate AFTER the TorBox paths, in traversal order, so
    // existing TorBox-first policy is preserved bit-for-bit and RD-only
    // mode (where A/B skip for lack of a TorBox seam) still binds.
    // The RD ensure is cached-only by construction: uncached probes are
    // cleaned up inside the ensure and reported here as skips.
    if (!selected && typeof ensureRealDebridFileIdentityFn === 'function') {
      try {
        const rdResult = await ensureRealDebridFileIdentityFn({
          infoHash: candidate.infoHash,
          filename: candidate.filename,
          fileIndex: candidate.fileIndex,
          size: Number.isSafeInteger(candidate.exactFileSize) && candidate.exactFileSize > 0
            ? candidate.exactFileSize
            : (Number.isSafeInteger(candidate.selectedFileSize) && candidate.selectedFileSize > 0
              ? candidate.selectedFileSize : null),
          season: tvCoordinates?.season ?? candidate.season ?? null,
          episode: tvCoordinates?.episode ?? candidate.episode ?? null,
        });
        if (rdResult?.status === 'ready' && rdResult.torrentFileId
          && isMediaPayloadForSelection(controlPlaneStore, rdResult.torrentFileId)) {
          selected = formatSelection(candidate);
          selected._torrentFileId = rdResult.torrentFileId;
          selected.rdState = 'cached';
          selected._binding = {
            status: 'rd-cached',
            torrentFileId: rdResult.torrentFileId,
            placementId: rdResult.placementId ?? null,
            providerFileId: rdResult.providerFileId ?? null,
            size: rdResult.size ?? null,
            provider: 'realdebrid',
            source: rdResult.source ?? null,
          };
          reason = `rd-cached bound (${rdResult.source ?? 'probe'})`;
          if (await acceptBound(candidate)) break;
          continue;
        }
        skipped.push({
          infoHash: candidate.infoHash,
          rank: candidate.rank,
          torboxState: candidate.availability?.torbox?.state || 'unknown',
          reason: `rd-${rdResult?.status ?? 'failed'}:${String(rdResult?.reason || 'unknown').slice(0, 80)}`,
        });
      } catch (err) {
        skipped.push({
          infoHash: candidate.infoHash,
          rank: candidate.rank,
          torboxState: candidate.availability?.torbox?.state || 'unknown',
          reason: `rd-error:${String(err?.message || err).slice(0, 80)}`,
        });
      }
    }

    skipped.push({
      infoHash: candidate.infoHash,
      rank: candidate.rank,
      torboxState: candidate.availability?.torbox?.state || 'unknown',
      reason: pathAFailureCode ? `path-a-failed:${pathAFailureCode}` : 'no-bindable-path',
    });
  }

  // Deferred candidates ranked above the winner were deliberately never
  // attempted (fresh batch proved them uncached); record that honestly so
  // diagnostics distinguish deliberate skips from attempted failures.
  // Ranks below the winner were never visited, exactly as in strict order.
  if (selected) {
    const seen = new Set(skipped.map((s) => `${s.infoHash}:${s.rank}`));
    for (const candidate of capped) {
      if (candidate.rank >= selected.rank) break;
      if (candidate.availability?.torbox?.state === 'uncached'
          && !seen.has(`${candidate.infoHash}:${candidate.rank}`)) {
        skipped.push({
          infoHash: candidate.infoHash,
          rank: candidate.rank,
          torboxState: 'uncached',
          reason: 'deferred-uncached-unattempted',
        });
      }
    }
  }

  // ---- FALLBACK: preserve cached-first selection only when bindability cannot
  // be determined at all. Movies no longer fall through here because the movie
  // PATH B has now consumed every ranked candidate with a cached-only
  // placement attempt; if no candidate is bindable we leave `selected` null
  // so the orchestrator (media-request.js) does NOT build a handoff with
  // torrent_file_id=NULL. TV still uses the fallback when no controlPlaneStore
  // is available (PATH B cannot run), preserving the original behavior for
  // that branch.
  if (!selected && capped.length > 0 && tvCoordinates && !controlPlaneStore) {
    const byState = { cached: [], unknown: [], uncached: [] };
    for (const candidate of capped) {
      const state = candidate.availability?.torbox?.state || 'unknown';
      if (byState[state]) byState[state].push(candidate);
      else byState.unknown.push(candidate);
    }
    const fallback =
      byState.cached[0] ?? byState.unknown[0] ?? byState.uncached[0];
    if (fallback) {
      selected = formatSelection(fallback);
      reason = 'cached-first fallback (no bindable candidate)';
    }
  }

  const alternates = capped
    .filter(c => c.infoHash !== selected?.infoHash || c.fileIndex !== selected?.fileIndex)
    .slice(0, 10)
    .map(c => ({
      infoHash: c.infoHash,
      fileIndex: c.fileIndex,
      filename: c.filename,
      rank: c.rank,
      score: c.score,
      identityTier: c.identity?.tier,
      torboxState: c.availability?.torbox?.state || 'unknown',
    }));

  // An empty reason means eligible candidates existed but none could be
  // bound (e.g. RD-only deploys have no TorBox binding seam yet — see the
  // RD-only tranche report). Say so explicitly instead of returning "".
  if (!selected && !reason) {
    reason = eligible.length > 0 ? 'no-bindable-candidate' : 'no candidates';
  }

  // No serviceable candidate was found and the traversal ran out of
  // candidates: fall back to the best-ranked unserviceable bind so the request
  // still publishes (visible) with an explicit blocked state.
  if (!selected && serviceabilityFallback) {
    selected = serviceabilityFallback.selection;
    reason = serviceabilityFallback.reason;
    serviceability = {
      state: 'blocked',
      reason: serviceabilityFallback.probe?.reason ?? 'unknown',
      provider: serviceabilityFallback.binding?.provider ?? null,
    };
  }

  // `serviceability` is null when no probe seam was supplied (exact pre-change
  // behavior); otherwise {state:'serviceable'|'blocked', ...} describes the
  // winning representation's runtime byte serviceability.
  return { selected, reason, alternates, skipped, serviceability };
}
