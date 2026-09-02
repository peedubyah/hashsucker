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
    resolveTvTorrentFileFn,
    tvCoordinates,
    controlPlaneStore,
  } = options;

  if (!Array.isArray(results) || results.length === 0) {
    return { selected: null, reason: 'no candidates', alternates: [], skipped: [] };
  }

  const eligible = results.filter(r => r.identity?.eligible !== false);

  if (eligible.length === 0) {
    return { selected: null, reason: 'no eligible candidates', alternates: [], skipped: [] };
  }

  const skipped = [];
  let selected = null;
  let reason = '';

  for (const candidate of eligible) {
    // ---- PATH A: exact-file-size binding (existing Slice 1.75 fast path) ----
    const selectedFileSize =
      Number.isSafeInteger(candidate.exactFileSize) && candidate.exactFileSize > 0
        ? candidate.exactFileSize
        : Number.isSafeInteger(candidate.selectedFileSize) && candidate.selectedFileSize > 0
          ? candidate.selectedFileSize
          : null;

    if (selectedFileSize != null && typeof ensureTorBoxFileIdentityFn === 'function') {
      try {
        const sizeResult = await ensureTorBoxFileIdentityFn({
          infoHash: candidate.infoHash,
          selectedFileSize,
          releaseKey: candidate.release?.key || null,
        });
        if (sizeResult?.torrentFileId) {
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
          break;
        }
      } catch {
        // exact-size failed; fall through to try TV/movie PATH B
      }
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
    if (!tvCoordinates
        && selectedFileSize == null
        && typeof ensureTorBoxFileIdentityFn === 'function'
        && controlPlaneStore) {
      let placementId = null;
      let placementTorrentFiles = null;
      try {
        const result = await ensureTorBoxFileIdentityFn({
          infoHash: candidate.infoHash,
          controlPlaneStore,
          skipSizeMatch: true,
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
        // Placement create refused (release not cached) or inventory fetch
        // failed. Either way, this candidate cannot be bound authoritatively;
        // continue to the next already-ranked candidate.
        skipped.push({
          infoHash: candidate.infoHash,
          rank: candidate.rank,
          torboxState: candidate.availability?.torbox?.state || 'unknown',
          reason: 'movie-cached-placement-failed',
        });
        continue;
      }

      if (!Array.isArray(placementTorrentFiles) || placementTorrentFiles.length === 0) {
        skipped.push({
          infoHash: candidate.infoHash,
          rank: candidate.rank,
          torboxState: candidate.availability?.torbox?.state || 'unknown',
          reason: 'movie-no-torrent-files',
        });
        continue;
      }

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
        continue;
      }

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
      break;
    }

    // ---- PATH B: TV episode resolution from cached-only TorBox inventory ----
    if (tvCoordinates && typeof resolveTvTorrentFileFn === 'function' && controlPlaneStore) {
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
          continue;
        }
        let placementTorrentFiles;
        let placementId = null;
        try {
          const result = await ensureTorBoxFileIdentityFn({
            infoHash: candidate.infoHash,
            controlPlaneStore,
            skipSizeMatch: true,
          });
          placementId = result?.placementId ?? null;
          placementTorrentFiles = result?.torrentFiles ?? controlPlaneStore.listTorrentFilesForRelease(candidate.infoHash);
        } catch (err) {
          console.error(`[PATH B] ensureTorBox FAILED hash=${candidate.infoHash} err=${err?.message ?? err}`);
          skipped.push({
            infoHash: candidate.infoHash,
            rank: candidate.rank,
            torboxState: candidate.availability?.torbox?.state || 'unknown',
            reason: 'TorBox placement failed',
          });
          continue;
        }

        // STEP 2: Resolve requested S/E from the now-persisted TorrentFiles.
        try {
          const { torrentFile } = resolveTvTorrentFileFn({ torrentFiles: placementTorrentFiles, season, episode });
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
          break;
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

    skipped.push({
      infoHash: candidate.infoHash,
      rank: candidate.rank,
      torboxState: candidate.availability?.torbox?.state || 'unknown',
    });
  }

  // ---- FALLBACK: preserve cached-first selection only when bindability cannot
  // be determined at all. Movies no longer fall through here because the movie
  // PATH B has now consumed every ranked candidate with a cached-only
  // placement attempt; if no candidate is bindable we leave `selected` null
  // so the orchestrator (media-request.js) does NOT build a handoff with
  // torrent_file_id=NULL. TV still uses the fallback when no controlPlaneStore
  // is available (PATH B cannot run), preserving the original behavior for
  // that branch.
  if (!selected && eligible.length > 0 && tvCoordinates) {
    const byState = { cached: [], unknown: [], uncached: [] };
    for (const candidate of eligible) {
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

  const alternates = eligible
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

  return { selected, reason, alternates, skipped };
}
