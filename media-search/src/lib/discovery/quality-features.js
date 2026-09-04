/**
 * Quality Feature Extraction — Slice 6 + Slice 7 + Slice 7B + Slice 8.
 *
 * Pure, deterministic feature extractor for ranked candidates.
 * Captures durable quality features for later analytics without
 * changing ranking behavior.
 *
 * Slice 8 adds a SHADOW quality contribution model:
 *   - computeQualityContribution(features) — pure, bounded, component-scored
 *   - rankWithHypotheticalQualityWeight(results, weight) — counterfactual only
 *   - Shadow is embedded in extractQualityFeatures output as
 *     qualityContributionShadow — persisted but ZERO ranking influence.
 *
 * This module does NOT:
 * - Change ranking behavior or weights
 * - Compute quality scores used by production ranking
 * - Access provider state (no I/O, no DB, no network)
 * - Infer resolution from file size
 * - Make raw size globally monotonic
 * - Use release group in quality contribution (group is analytics-only)
 *
 * It ONLY extracts features from the candidate/result object that
 * produced the ranked row. The SAME object whose score was persisted
 * is the source of truth — no re-querying, no re-ranking.
 *
 * Architectural contract:
 *   - Input: the ranked result object (r.release, r.filename, r.selectedFileSize)
 *   - Output: a frozen, versioned, deterministic feature snapshot
 *   - Provider/auth data NEVER enters the snapshot
 *   - Unknown values stay null/unknown (never invented)
 *
 * Slice 6 spec traceability:
 *   B  quality feature schema (versioned, compact)
 *   C  resolution normalization (explicit parsed → filename fallback)
 *   D  size/bitrate proxy (bytesPerMinute when runtime known, else raw-only)
 *   E  source type normalization
 *   F  release group normalization (raw preserved, normalized conservatively)
 *   G  codec normalization
 *   H  container derivation from extension only
 *   M  YIFY/small-release: features differ, NO ranking difference
 *   N  determinism (byte-identical JSON for same candidate)
 *   O  non-goals: no quality_score, no group reliability weights
 *
 * Slice 8 spec traceability:
 *   A  quality model: versioned, component-scored, reasons, confidence
 *   B  component priority: resolution > sizeRelative > source > codec > container
 *   C  resolution component: 2160p→1.0, 1440p→0.88, 1080p→0.72, 720p→0.45, sd→0.20
 *   D  relative size: log-sigmoid on peerRatio, saturating, no raw bytes
 *   E  source type: remux>bluray>web-dl>webrip>hdtv>cam, smaller than resolution
 *   F  codec: tiny modifier (av1>hevc>h264>vc1>mpeg2)
 *   G  container: nearly negligible (mkv>mp4>m2ts>avi)
 *   H  release group: NO SCORE CONTRIBUTION (analytics-only)
 *   I  confidence: fraction of components with known values; missing ≠ negative
 *   J  shadow integration: zero ranking influence, persists alongside explanation
 *   K  counterfactual: rankWithHypotheticalQualityWeight for what-if analysis
 */

export const QUALITY_FEATURES_VERSION = 1;

// ---------------------------------------------------------------------------
// Slice 8: Quality Contribution Model (SHADOW ONLY — zero ranking influence)
// ---------------------------------------------------------------------------

export const QUALITY_CONTRIBUTION_VERSION = 1;

/**
 * Internal component weights for the quality contribution model.
 * These represent RELATIVE importance within the quality model only.
 * They are NOT global ranking weights and do NOT affect production scores.
 *
 * Desired shape (spec section B):
 *   resolution   ~45-55%  (DOMINANT)
 *   sizeRelative ~25-35%  (SECONDARY, BOUNDED)
 *   source       ~10-20%  (SMALLER)
 *   codec        ~3-6%    (TINY)
 *   container    ~0-2%    (NEARLY NEGLIGIBLE)
 */
const QUALITY_COMPONENT_WEIGHTS = Object.freeze({
  resolution: 0.50,
  sizeRelative: 0.30,
  source: 0.12,
  codec: 0.05,
  container: 0.03,
});

// Resolution component scores (spec section C).
// 'unknown' gets 0.0 — low-confidence estimate, not a quality signal.
const RESOLUTION_COMPONENT_SCORES = Object.freeze({
  '2160p': 1.00,
  '1440p': 0.88,
  '1080p': 0.72,
  '720p': 0.45,
  'sd': 0.20,
  'unknown': 0.00,
});

// Source type component scores (spec section E).
const SOURCE_COMPONENT_SCORES = Object.freeze({
  'remux': 1.00,
  'bluray': 0.85,
  'web-dl': 0.70,
  'webrip': 0.55,
  'hdtv': 0.35,
  'cam': 0.10,
});

// Codec component scores (spec section F) — efficiency/context signal only.
const CODEC_COMPONENT_SCORES = Object.freeze({
  'av1': 0.70,
  'hevc': 0.65,
  'h264': 0.50,
  'vc1': 0.35,
  'mpeg2': 0.30,
});

// Container component scores (spec section G) — nearly negligible.
const CONTAINER_COMPONENT_SCORES = Object.freeze({
  'mkv': 0.55,
  'mp4': 0.50,
  'm2ts': 0.45,
  'ts': 0.45,
  'avi': 0.35,
});

// Neutral value for unknown/missing component data (spec section I).
const NEUTRAL_COMPONENT = 0.50;

/**
 * Compute the resolution component score (spec section C).
 * @param {string} resolutionLabel — canonical resolution label
 * @returns {number} 0.0-1.0
 */
function resolutionComponentScore(resolutionLabel) {
  if (!resolutionLabel || resolutionLabel === 'unknown') return 0.0;
  return RESOLUTION_COMPONENT_SCORES[resolutionLabel] ?? 0.0;
}

/**
 * Compute the relative-size component score (spec section D).
 *
 * Uses a log-sigmoid on peerRatio so that:
 *   - very small sizes → modest low signal (not annihilated)
 *   - around median (ratio≈1.0) → neutral/good (~0.65)
 *   - moderately above median → positive (~0.86 at ratio=2)
 *   - absurdly huge → saturating (~0.95 at ratio=4, ~0.99 at ratio=10)
 *
 * When peerRatio is null (no cohort), returns neutral (0.50).
 *
 * @param {number|null} peerRatio — sizeRatioToMedian from derived features
 * @returns {number} 0.0-1.0
 */
function sizeRelativeComponentScore(peerRatio) {
  if (peerRatio == null || !Number.isFinite(peerRatio)) return NEUTRAL_COMPONENT;
  // Clamp ratio to avoid log(0); log2(0.01) ≈ -6.64 gives score ≈ 0.02
  const logRatio = Math.log2(Math.max(peerRatio, 0.01));
  // Sigmoid: centered at logRatio=-0.5, steepness 1.2
  // At ratio=1.0 (log2=0): score ≈ 0.645 (neutral/good)
  // At ratio=0.25 (log2=-2): score ≈ 0.142 (low but not annihilated)
  // At ratio=4.0 (log2=2): score ≈ 0.953 (saturating)
  const score = 1 / (1 + Math.exp(-1.2 * (logRatio + 0.5)));
  return Math.max(0, Math.min(1, score));
}

/**
 * Compute the source type component score (spec section E).
 * @param {string} sourceType — canonical source type
 * @returns {number} 0.0-1.0
 */
function sourceComponentScore(sourceType) {
  if (!sourceType || sourceType === 'unknown') return NEUTRAL_COMPONENT;
  return SOURCE_COMPONENT_SCORES[sourceType] ?? NEUTRAL_COMPONENT;
}

/**
 * Compute the codec component score (spec section F).
 * @param {string} codec — canonical codec label
 * @returns {number} 0.0-1.0
 */
function codecComponentScore(codec) {
  if (!codec || codec === 'unknown') return NEUTRAL_COMPONENT;
  return CODEC_COMPONENT_SCORES[codec] ?? NEUTRAL_COMPONENT;
}

/**
 * Compute the container component score (spec section G).
 * @param {string} container — canonical container type
 * @returns {number} 0.0-1.0
 */
function containerComponentScore(container) {
  if (!container || container === 'unknown') return NEUTRAL_COMPONENT;
  return CONTAINER_COMPONENT_SCORES[container] ?? NEUTRAL_COMPONENT;
}

/**
 * Compute confidence as fraction of components with known values (spec section I).
 * Unknown values do NOT count as known; absence is not penalized.
 *
 * @param {Object} features — the quality feature snapshot
 * @returns {number} 0.0-1.0 (fraction of components with known values)
 */
function computeConfidence(features) {
  let known = 0;
  const total = 5;
  if (features.resolution?.label && features.resolution.label !== 'unknown') known++;
  if (features.derived?.peerRatio != null) known++;
  if (features.source?.type && features.source.type !== 'unknown') known++;
  if (features.codec?.video && features.codec.video !== 'unknown') known++;
  if (features.container?.type && features.container.type !== 'unknown') known++;
  return known / total;
}

/**
 * Pure, deterministic quality contribution model (spec section A).
 *
 * Takes the quality feature snapshot (output of extractQualityFeatures) and
 * computes a bounded quality contribution. This function is PURE — no I/O,
 * no DB, no network, no provider data access.
 *
 * Output shape:
 *   {
 *     version: 1,
 *     total: <bounded 0-1>,
 *     components: { resolution, sizeRelative, source, codec, container },
 *     componentWeights: { resolution, sizeRelative, source, codec, container },
 *     reasons: [...],
 *     confidence: <0-1 fraction of known components>
 *   }
 *
 * IMPORTANT:
 *   - This is SHADOW DATA. It does NOT affect production ranking.
 *   - Release group contributes exactly 0 (spec section H).
 *   - Missing data is neutral, not negative (spec section I).
 *
 * @param {Object} features — output of extractQualityFeatures
 * @returns {Object} Frozen quality contribution snapshot
 */
export function computeQualityContribution(features = {}) {
  const resolution = resolutionComponentScore(features.resolution?.label);
  const sizeRelative = sizeRelativeComponentScore(features.derived?.peerRatio);
  const source = sourceComponentScore(features.source?.type);
  const codec = codecComponentScore(features.codec?.video);
  const container = containerComponentScore(features.container?.type);

  const weights = QUALITY_COMPONENT_WEIGHTS;
  const total = Math.max(0, Math.min(1,
    resolution * weights.resolution +
    sizeRelative * weights.sizeRelative +
    source * weights.source +
    codec * weights.codec +
    container * weights.container
  ));

  const confidence = computeConfidence(features);

  // Build human-readable reasons for inspectability
  const reasons = [];
  reasons.push(`resolution=${features.resolution?.label || 'unknown'} (component=${resolution.toFixed(3)})`);
  if (features.derived?.peerRatio != null) {
    reasons.push(`peerRatio=${features.derived.peerRatio.toFixed(3)} (component=${sizeRelative.toFixed(3)})`);
  } else {
    reasons.push('sizeRelative=neutral (no peer cohort)');
  }
  reasons.push(`source=${features.source?.type || 'unknown'} (component=${source.toFixed(3)})`);
  reasons.push(`codec=${features.codec?.video || 'unknown'} (component=${codec.toFixed(3)})`);
  reasons.push(`container=${features.container?.type || 'unknown'} (component=${container.toFixed(3)})`);
  reasons.push('releaseGroup=0 (analytics-only, no score contribution)');

  return Object.freeze({
    version: QUALITY_CONTRIBUTION_VERSION,
    total: Math.round(total * 1000) / 1000,
    components: Object.freeze({
      resolution: Math.round(resolution * 1000) / 1000,
      sizeRelative: Math.round(sizeRelative * 1000) / 1000,
      source: Math.round(source * 1000) / 1000,
      codec: Math.round(codec * 1000) / 1000,
      container: Math.round(container * 1000) / 1000,
    }),
    componentWeights: Object.freeze({ ...QUALITY_COMPONENT_WEIGHTS }),
    reasons,
    confidence: Math.round(confidence * 1000) / 1000,
  });
}

/**
 * Counterfactual ranking helper (spec section K).
 *
 * Pure analysis tool — computes what WOULD happen if quality contributed
 * to ranking at the given hypothetical weight. Does NOT mutate input.
 *
 * Use this to answer: "If quality had weight X, what would move?"
 *
 * @param {Array<Object>} results — ranked results, each with optional
 *   .qualityContributionShadow (the shadow object) and .score
 * @param {number} [weight=0.05] — hypothetical quality weight (0-1)
 * @returns {Object} Reordering analysis:
 *   - weight: the hypothetical weight used
 *   - totalCandidates: count of input results
 *   - reorderCount: number of candidates that changed rank
 *   - medianRankMovement: median absolute rank change
 *   - maxRankMovement: maximum absolute rank change
 *   - averageRankMovement: mean absolute rank change
 *   - originalOrder: array of { score, shadowTotal }
 *   - hypotheticalOrder: array of { score, hypotheticalScore, shadowTotal }
 */
export function rankWithHypotheticalQualityWeight(results, weight = 0.05) {
  if (!Array.isArray(results) || results.length === 0) {
    return Object.freeze({
      weight,
      totalCandidates: 0,
      reorderCount: 0,
      medianRankMovement: 0,
      maxRankMovement: 0,
      averageRankMovement: 0,
      originalOrder: [],
      hypotheticalOrder: [],
    });
  }

  const enriched = results.map((r, i) => {
    const shadowTotal = r.qualityContributionShadow?.total ?? 0.5;
    const baseScore = Number.isFinite(r.score) ? r.score : 0;
    const hypotheticalScore = baseScore + weight * shadowTotal;
    return {
      _originalIndex: i,
      _baseScore: baseScore,
      _shadowTotal: shadowTotal,
      _hypotheticalScore: hypotheticalScore,
      _rank: r.rank ?? i,
    };
  });

  // Sort descending by hypothetical score; tie-break by original index (stable)
  const sorted = [...enriched].sort((a, b) => {
    if (b._hypotheticalScore !== a._hypotheticalScore) {
      return b._hypotheticalScore - a._hypotheticalScore;
    }
    return a._originalIndex - b._originalIndex;
  });

  // Compute rank movements
  const movements = [];
  let reorderCount = 0;
  let totalMovement = 0;
  let maxMovement = 0;

  for (let newRank = 0; newRank < sorted.length; newRank++) {
    const origRank = sorted[newRank]._originalIndex;
    const movement = Math.abs(newRank - origRank);
    movements.push(movement);
    if (movement > 0) reorderCount++;
    totalMovement += movement;
    if (movement > maxMovement) maxMovement = movement;
  }

  movements.sort((a, b) => a - b);
  const medianMovement = movements.length > 0
    ? movements[Math.floor(movements.length / 2)]
    : 0;

  return Object.freeze({
    weight,
    totalCandidates: results.length,
    reorderCount,
    medianRankMovement: medianMovement,
    maxRankMovement: maxMovement,
    averageRankMovement: Math.round((totalMovement / results.length) * 1000) / 1000,
    originalOrder: enriched.map((e) => ({
      score: e._baseScore,
      shadowTotal: e._shadowTotal,
    })),
    hypotheticalOrder: sorted.map((e) => ({
      score: e._baseScore,
      hypotheticalScore: Math.round(e._hypotheticalScore * 1000) / 1000,
      shadowTotal: e._shadowTotal,
    })),
  });
}

// ---------------------------------------------------------------------------
// Normalization maps
// ---------------------------------------------------------------------------

// Resolution: map all common labels to canonical form.
// 576p/480p/360p collapse to 'sd' per spec.
const RESOLUTION_MAP = {
  '2160p': '2160p', '4k': '2160p', 'uhd': '2160p', '4kuhd': '2160p',
  '1440p': '1440p',
  '1080p': '1080p', '1080i': '1080p', 'fhd': '1080p',
  '720p': '720p',
  '576p': 'sd', '480p': 'sd', '360p': 'sd',
  'sd': 'sd',
};

// Standard display dimensions for known resolutions.
// 'sd' has no single standard → null.
const RESOLUTION_DIMENSIONS = {
  '2160p': { width: 3840, height: 2160 },
  '1440p': { width: 2560, height: 1440 },
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
};

// Source type: normalize to lowercase canonical forms.
const SOURCE_MAP = {
  'remux': 'remux',
  'bluray': 'bluray', 'blu-ray': 'bluray', 'bdrip': 'bluray', 'brrip': 'bluray',
  'web-dl': 'web-dl', 'webdl': 'web-dl',
  'webrip': 'webrip',
  'hdtv': 'hdtv',
  'cam': 'cam',
};

// Codec: normalize to canonical forms (spec wants hevc/h264, not x265/x264).
const CODEC_MAP = {
  'av1': 'av1',
  'hevc': 'hevc', 'x265': 'hevc', 'h265': 'hevc',
  'h264': 'h264', 'x264': 'h264', 'avc': 'h264',
  'vc1': 'vc1', 'vc-1': 'vc1',
  'mpeg2': 'mpeg2',
};

// Container: file extension → canonical form.
const CONTAINER_EXT = {
  'mkv': 'mkv', 'mp4': 'mp4', 'm2ts': 'm2ts', 'ts': 'ts', 'avi': 'avi',
};

// ---------------------------------------------------------------------------
// Normalization helpers (pure)
// ---------------------------------------------------------------------------

export function normalizeResolution(res) {
  if (!res) return null;
  const key = String(res).toLowerCase().replace(/[\s.-]/g, '');
  return RESOLUTION_MAP[key] || null;
}

/**
 * Compute the resolution tier label for a candidate result.
 * Encapsulates the same resolution-detection logic used by extractQualityFeatures
 * (explicit parsed resolution → filename fallback) so callers can build peer
 * cohorts without duplicating the matching rules.
 *
 * @param {Object} [release] — release_attributes (may contain .resolution)
 * @param {string} [filename] — release filename
 * @returns {string} Canonical tier label ('2160p'|'1440p'|'1080p'|'720p'|'sd'|'unknown')
 */
export function getResolutionTierLabel(release = {}, filename = '') {
  const explicit = normalizeResolution(release.resolution);
  if (explicit) return explicit;
  const resMatch = filename.match(/\b(8640p|4320p|2160p|1440p|1080p|1080i|720p|576p|480p|360p|4[kk]|uhd)\b/i);
  if (resMatch) return normalizeResolution(resMatch[1]);
  return 'unknown';
}

/**
 * Compute peer-relative size features for a candidate within its resolution-tier cohort.
 *
 * Pure function — no I/O, no DB. Takes the candidate's exact byte size and the
 * sorted array of all valid sizes in the same resolution tier (including this
 * candidate's own size). Returns percentile rank, ratio to median, peer count,
 * and median byte size.
 *
 * Percentile uses the standard "percentile rank" formula:
 *   round(count_smaller / (n - 1) * 100)
 * A single-peer cohort returns percentile 50 (the candidate is its own median).
 *
 * @param {number|null} sizeBytes — This candidate's exact byte size (positive safe integer)
 * @param {number[]} [cohortSizes] — Sorted ascending array of all sizes in the same tier
 * @returns {{sizeWithinResolutionPeerPercentile: number|null, peerRatio: number|null, peerCount: number, peerMedianBytes: number|null}}
 */
export function computePeerRelativeSizeFeatures(sizeBytes, cohortSizes) {
  if (sizeBytes == null || !Array.isArray(cohortSizes) || cohortSizes.length === 0) {
    return {
      sizeWithinResolutionPeerPercentile: null,
      peerRatio: null,
      peerCount: 0,
      peerMedianBytes: null,
    };
  }

  const peerCount = cohortSizes.length;
  const median = computeMedian(cohortSizes);

  let percentile;
  if (peerCount === 1) {
    percentile = 50;
  } else {
    let smallerCount = 0;
    for (const s of cohortSizes) {
      if (s < sizeBytes) smallerCount++;
    }
    percentile = Math.round((smallerCount / (peerCount - 1)) * 100);
  }

  const peerRatio = median > 0 ? Number((sizeBytes / median).toFixed(4)) : null;

  return {
    sizeWithinResolutionPeerPercentile: percentile,
    peerRatio,
    peerCount,
    peerMedianBytes: median,
  };
}

/**
 * Compute the median of a sorted (ascending) number array.
 * For even-length arrays, returns the arithmetic mean of the two central values.
 * @param {number[]} sortedArray — Must be sorted ascending
 * @returns {number}
 */
function computeMedian(sortedArray) {
  const n = sortedArray.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0
    ? (sortedArray[mid - 1] + sortedArray[mid]) / 2
    : sortedArray[mid];
}

function normalizeSource(src) {
  if (!src) return 'unknown';
  const key = String(src).toLowerCase().replace(/[\s.-]/g, '');
  return SOURCE_MAP[key] || 'unknown';
}

function normalizeCodec(codec) {
  if (!codec) return 'unknown';
  const key = String(codec).toLowerCase().replace(/[\s.-]/g, '');
  return CODEC_MAP[key] || 'unknown';
}

function normalizeContainer(ext) {
  if (!ext) return 'unknown';
  const key = String(ext).toLowerCase().replace(/^\./, '');
  return CONTAINER_EXT[key] || 'unknown';
}

function extractExtension(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const match = filename.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Normalize a release group tag conservatively.
 * - Trim whitespace
 * - Strip surrounding punctuation wrappers (e.g., "-GROUP." → "GROUP")
 * - Collapse internal whitespace
 * - Do NOT force case (preserve mixed-case groups like FraMeSToR)
 * - Do NOT merge distinct groups
 */
function normalizeReleaseGroup(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let normalized = raw.trim();
  if (!normalized) return null;
  // Strip surrounding punctuation wrappers
  normalized = normalized.replace(/^[-[\]{}()]+|[-[\]{}()]+$/g, '');
  // Strip trailing dots (e.g., "YTS." → "YTS")
  normalized = normalized.replace(/\.+$/, '');
  // Collapse internal whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

/**
 * Extract quality features from a ranked candidate/result object.
 *
 * @param {Object} candidate - The ranked result object. Expected fields:
 *   - candidate.release (Object) — release_attributes (resolution, source_type, codec, release_group)
 *   - candidate.filename (string) — release filename
 *   - candidate.selectedFileSize (number|null) — exact byte size
 * @param {Object} [context] - Optional context for future enhancements:
 *   - context.runtimeMinutes (number|null) — media runtime if known
 *   - context.peerCohort (number[]) — sorted ascending array of all valid sizes
 *     in the same resolution tier (including this candidate's own size). When
 *     provided, populates derived.sizeWithinResolutionPeerPercentile, peerRatio,
 *     peerCount, and peerMedianBytes. When absent, those fields remain null.
 * @returns {Object} Frozen, versioned quality feature snapshot
 */
export function extractQualityFeatures(candidate, context = {}) {
  const release = (candidate && (candidate.release || candidate.releaseAttributes)) || {};
  const filename = (candidate && candidate.filename) || '';

  // -----------------------------------------------------------------------
  // Resolution: prefer explicit parsed resolution from release_attributes.
  // Fall back to filename tokens only if parser output is absent.
  // -----------------------------------------------------------------------
  let resolutionLabel = normalizeResolution(release.resolution);
  let resolutionConfidence = 0.8;
  if (!resolutionLabel) {
    const resMatch = filename.match(/\b(8640p|4320p|2160p|1440p|1080p|1080i|720p|576p|480p|360p|4[kk]|uhd)\b/i);
    if (resMatch) {
      resolutionLabel = normalizeResolution(resMatch[1]);
      resolutionConfidence = 0.5;
    }
  }
  const dims = RESOLUTION_DIMENSIONS[resolutionLabel] || null;

  // -----------------------------------------------------------------------
  // Size: prefer exact selectedFileSize, fall back to release.size.
  // bytesPerMinute only when runtime is available (currently MISSING).
  // -----------------------------------------------------------------------
  const exactBytes = Number.isSafeInteger(candidate?.selectedFileSize) && candidate.selectedFileSize > 0
    ? candidate.selectedFileSize
    : (Number.isSafeInteger(release.size) && release.size > 0 ? release.size : null);

  const runtimeMinutes = Number.isSafeInteger(context?.runtimeMinutes) && context.runtimeMinutes > 0
    ? context.runtimeMinutes
    : null;

  let sizeDensityMode = 'missing';
  if (exactBytes != null) {
    sizeDensityMode = runtimeMinutes != null ? 'runtime-normalized' : 'raw-only';
  }

  const bytesPerMinute = (exactBytes != null && runtimeMinutes != null)
    ? Math.round(exactBytes / runtimeMinutes)
    : null;

  // -----------------------------------------------------------------------
  // Peer-relative size features: percentile rank within resolution tier,
  // ratio to peer median, peer count, and median byte size. Pure derivation
  // from the cohort array — no I/O, no DB. When context.peerCohort is absent
  // or empty, these fields remain null (the extractor stays backward-compatible
  // with callers that don't supply cohort data).
  // -----------------------------------------------------------------------
  const peerFeatures = computePeerRelativeSizeFeatures(exactBytes, context.peerCohort);

  // -----------------------------------------------------------------------
  // Source type: prefer release_attributes.source_type, fall back to filename.
  // -----------------------------------------------------------------------
  let sourceType = normalizeSource(release.source_type || release.sourceType);
  if (sourceType === 'unknown') {
    const srcMatch = filename.match(/\b(blu[-\s]?ray|bdrip|brrip|web[-\s]?dl|webrip|hdtv|remux|cam)\b/i);
    if (srcMatch) {
      sourceType = normalizeSource(srcMatch[1]);
    }
  }

  // -----------------------------------------------------------------------
  // Codec: prefer release_attributes.codec, fall back to filename.
  // -----------------------------------------------------------------------
  let codec = normalizeCodec(release.codec);
  if (codec === 'unknown') {
    const codecMatch = filename.match(/\b(x264|x265|h\.?264|h\.?265|hevc|avc|av1|vc-?1|mpeg-?2)\b/i);
    if (codecMatch) {
      codec = normalizeCodec(codecMatch[1]);
    }
  }

  // -----------------------------------------------------------------------
  // Container: derive from filename extension only.
  // -----------------------------------------------------------------------
  const ext = extractExtension(filename);
  const container = normalizeContainer(ext);

  // -----------------------------------------------------------------------
  // Release group: preserve raw, normalize conservatively.
  // -----------------------------------------------------------------------
  const rawGroup = release.release_group || release.releaseGroup || null;
  const normalizedGroup = normalizeReleaseGroup(rawGroup);

  // -----------------------------------------------------------------------
  // Assemble snapshot (unfrozen for shadow attachment)
  // -----------------------------------------------------------------------
  const snapshot = {
    version: QUALITY_FEATURES_VERSION,
    resolution: Object.freeze({
      label: resolutionLabel || 'unknown',
      width: dims ? dims.width : null,
      height: dims ? dims.height : null,
      confidence: resolutionLabel ? resolutionConfidence : 0.0,
    }),
    size: Object.freeze({
      bytes: exactBytes,
      bytesPerMinute,
      sizeDensityMode,
    }),
    source: Object.freeze({
      type: sourceType,
    }),
    codec: Object.freeze({
      video: codec,
    }),
    container: Object.freeze({
      type: container,
    }),
    releaseGroup: Object.freeze({
      raw: rawGroup,
      normalized: normalizedGroup,
      confidence: rawGroup ? 0.8 : 0.0,
    }),
    derived: Object.freeze({
      runtimeMinutes,
      sizeWithinResolutionPeerPercentile: peerFeatures.sizeWithinResolutionPeerPercentile,
      peerRatio: peerFeatures.peerRatio,
      peerCount: peerFeatures.peerCount,
      peerMedianBytes: peerFeatures.peerMedianBytes,
    }),
  };

  // -----------------------------------------------------------------------
  // Slice 8: attach quality contribution shadow.
  // ZERO ranking influence — this is analytics/inspection only.
  // The shadow is computed from the fully-assembled feature snapshot,
  // but the snapshot's score is NOT modified by the shadow.
  // -----------------------------------------------------------------------
  snapshot.qualityContributionShadow = computeQualityContribution(snapshot);

  return Object.freeze(snapshot);
}

/**
 * Build the quality contribution shadow from a fully-assembled feature object.
 * Extracted so the shadow can be attached after all feature components are
 * known, but before the snapshot is frozen.
 *
 * @param {Object} features — the unfrozen feature object (without shadow yet)
 * @returns {Object} Frozen quality contribution shadow
 */
function attachQualityContributionShadow(features) {
  return computeQualityContribution(features);
}

/**
 * Serialize a quality feature snapshot to deterministic JSON.
 * Object keys are sorted for byte-identical output across calls.
 *
 * @param {Object} features - Output of extractQualityFeatures()
 * @returns {string} Deterministic JSON string
 */
export function serializeQualityFeatures(features) {
  return JSON.stringify(features, Object.keys(features).sort());
}
