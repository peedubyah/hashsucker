/**
 * Quality Feature Extraction — Slice 6.
 *
 * Pure, deterministic feature extractor for ranked candidates.
 * Captures durable quality features for later analytics without
 * changing ranking behavior.
 *
 * This module does NOT:
 * - Change ranking behavior or weights
 * - Compute quality scores
 * - Access provider state (no I/O, no DB, no network)
 * - Infer resolution from file size
 * - Make raw size globally monotonic
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
 */

export const QUALITY_FEATURES_VERSION = 1;

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

function normalizeResolution(res) {
  if (!res) return null;
  const key = String(res).toLowerCase().replace(/[\s.-]/g, '');
  return RESOLUTION_MAP[key] || null;
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
  // Assemble frozen snapshot
  // -----------------------------------------------------------------------
  return Object.freeze({
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
      sizeWithinResolutionPeerPercentile: null,
    }),
  });
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
