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
