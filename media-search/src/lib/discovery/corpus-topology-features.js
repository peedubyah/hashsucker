/**
 * Corpus Topology Evidence Projection
 *
 * Pure read-only feature extraction layer that derives torrent/file topology
 * evidence from existing candidate and release attribute data.
 *
 * Purpose:
 *   Projects the internal structure of a torrent into a normalized feature
 *   vector describing file composition, media types, and structural patterns.
 *
 *   This is NOT confidence scoring. It is a normalized description of torrent
 *   topology that future confidence models can consume.
 *
 * Feature categories:
 *   - identity   : canonical (infoHash, fileIndex) pair
 *   - files      : file counts by type classification
 *   - structure  : structural patterns (single file, extras, samples, season)
 *   - quality    : heuristic playability indicators
 *
 * Identity key:
 *   - (info_hash, file_index_key) — same normalized identity everywhere
 *
 * Data sources:
 *   - candidates table (filename, size per file index)
 *   - release_attributes table (parsed metadata: media_type, season, etc.)
 *
 * Contract:
 *   - No schema additions — pure query over existing tables
 *   - No UPDATE/DELETE on any table
 *   - No access to provider observations or acquisition logic
 *   - No writes to any table
 *   - Deterministic output
 *   - Safe when no candidate or attribute data exists
 *   - Preserves file_index null vs 0 identity distinction
 */

// File extension classifications
const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm',
  '.m4v', '.mpg', '.mpeg', '.ts', '.m2ts', '.vob', '.ogv',
]);

const SUBTITLE_EXTENSIONS = new Set([
  '.srt', '.sub', '.idx', '.ass', '.ssa', '.vtt', '.sup',
]);

const ARCHIVE_EXTENSIONS = new Set([
  '.rar', '.zip', '.7z', '.tar', '.gz', '.bz2', '.xz',
]);

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.aac', '.ogg', '.wma', '.wav', '.m4a',
  '.ac3', '.dts', '.opus', '.aiff',
]);

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp', '.svg',
]);

const NFO_EXTENSIONS = new Set([
  '.nfo', '.txt', '.md',
]);

// Sample patterns (filenames that indicate sample files)
const SAMPLE_PATTERNS = [
  /^sample/i,
  /[._-]sample[._-]/i,
  /sample[._-]/i,
  /[._-]sample\./i,
];

// Extras patterns (filenames indicating bonus/extra content)
const EXTRAS_PATTERNS = [
  /extra/i,
  /featurette/i,
  /behind[._-]the[._-]scenes/i,
  /deleted[._-]scene/i,
  /making[._-]of/i,
  /bonus/i,
  /trailer/i,
  /interview/i,
  /preview/i,
  /teaser/i,
];

/**
 * Extract file extension from filename (lowercase, including the dot).
 * Returns empty string if no extension found.
 */
function getExtension(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) return '';
  const ext = filename.slice(lastDot).toLowerCase();
  // Sanity: extensions are short and alphanumeric
  if (!/^\.[a-z0-9]{1,5}$/.test(ext)) return '';
  return ext;
}

/**
 * Classify a file by its extension into a broad type category.
 * Returns: 'video', 'subtitle', 'archive', 'audio', 'image', 'nfo', or 'other'
 */
function classifyFile(filename) {
  const ext = getExtension(filename);
  if (!ext) return 'other';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'subtitle';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (NFO_EXTENSIONS.has(ext)) return 'nfo';
  return 'other';
}

/**
 * Check if a filename appears to be a sample file.
 */
function isSampleFile(filename) {
  if (!filename) return false;
  return SAMPLE_PATTERNS.some((pattern) => pattern.test(filename));
}

/**
 * Check if a filename appears to be extras/bonus content.
 */
function isExtrasFile(filename) {
  if (!filename) return false;
  return EXTRAS_PATTERNS.some((pattern) => pattern.test(filename));
}

/**
 * Compute the ratio of the largest file to total size.
 * Returns null if total size is 0 or no files have valid sizes.
 */
function computeLargestFileRatio(files) {
  if (files.length === 0) return null;

  let totalSize = 0;
  let largestSize = 0;
  let hasValidSize = false;

  for (const file of files) {
    if (file.size != null && file.size > 0) {
      hasValidSize = true;
      totalSize += file.size;
      if (file.size > largestSize) {
        largestSize = file.size;
      }
    }
  }

  if (!hasValidSize || totalSize === 0) return null;

  // Round to 4 decimal places to avoid floating point noise
  return Math.round((largestSize / totalSize) * 10000) / 10000;
}

/**
 * Determine if this is a single-file media torrent.
 * true when there's exactly one file and it's video type.
 */
function isSingleFileMedia(files) {
  if (files.length !== 1) return false;
  return files[0].type === 'video';
}

/**
 * Check if any release attribute indicates season structure.
 */
function hasSeasonStructure(allAttributes) {
  return allAttributes.some((attr) => {
    if (attr.media_type === 'season') return true;
    if (attr.season != null && attr.season > 0) return true;
    return false;
  });
}

/**
 * Determine if a file is a likely playable target.
 * Heuristic: video file that's > 10MB and not a sample.
 */
function isLikelyPlayableTarget(file) {
  if (file.type !== 'video') return false;
  if (isSampleFile(file.filename)) return false;
  // 10MB threshold — below this is likely a preview/intro
  if (file.size != null && file.size < 10 * 1024 * 1024) return false;
  return true;
}

/**
 * Compute topology confidence based on available evidence.
 * Higher when we have more attributes and consistent classification.
 * Returns a value between 0 and 1.
 */
function computeTopologyConfidence(files, allAttributes, queriedFileCount) {
  if (queriedFileCount === 0) return null;

  let confidence = 0.5; // base confidence

  // Boost if we have release attributes
  if (allAttributes.length > 0) {
    confidence += 0.2;
  }

  // Boost if we have size data
  const filesWithSize = files.filter((f) => f.size != null && f.size > 0).length;
  if (filesWithSize > 0) {
    confidence += 0.15;
  }

  // Boost if we have video files
  const videoFiles = files.filter((f) => f.type === 'video').length;
  if (videoFiles > 0) {
    confidence += 0.15;
  }

  return Math.min(confidence, 1.0);
}

/**
 * Generate topology warnings based on structural anomalies.
 */
function generateWarnings(files, allAttributes) {
  const warnings = [];

  if (files.length === 0) {
    warnings.push('no_files');
    return warnings;
  }

  // Check for very small video files (likely samples or corrupt)
  const smallVideoFiles = files.filter(
    (f) => f.type === 'video' && f.size != null && f.size > 0 && f.size < 50 * 1024 * 1024
  );
  if (smallVideoFiles.length > 0) {
    warnings.push('small_video_files');
  }

  // Check for torrents with many non-media files
  const nonMediaFiles = files.filter(
    (f) => f.type === 'other' || f.type === 'nfo' || f.type === 'image'
  );
  if (nonMediaFiles.length > files.length * 0.5) {
    warnings.push('mostly_non_media');
  }

  // Check for missing size data
  const filesWithoutSize = files.filter((f) => f.size == null || f.size === 0);
  if (filesWithoutSize.length === files.length && files.length > 0) {
    warnings.push('no_size_data');
  }

  // Check for sample files
  const sampleFiles = files.filter((f) => isSampleFile(f.filename));
  if (sampleFiles.length > 0) {
    warnings.push('has_samples');
  }

  return warnings;
}

/**
 * Create a corpus topology feature projection.
 *
 * @param {Object} cache - Discovery cache instance (createDiscoveryCache)
 * @returns {Object} Corpus topology feature projection interface
 */
export function createCorpusTopologyFeatures(cache) {
  if (!cache) throw new Error('Corpus topology features require a discovery cache');

  const db = cache.db;

  /**
   * Get topology features for a specific candidate identity.
   *
   * Queries all file indexes for the given info_hash to build a complete
   * picture of the torrent's internal structure.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {{
   *   identity: { infoHash: string, fileIndex: number },
   *   files: {
   *     totalFiles: number,
   *     mediaFiles: number,
   *     nonMediaFiles: number,
   *     videoFiles: number,
   *     subtitleFiles: number,
   *     archiveFiles: number,
   *   },
   *   structure: {
   *     singleFileMedia: boolean,
   *     hasExtras: boolean,
   *     hasSamples: boolean,
   *     hasSeasonStructure: boolean,
   *     largestFileRatio: number|null,
   *   },
   *   quality: {
   *     likelyPlayableTarget: boolean,
   *     topologyConfidence: number|null,
   *     warnings: string[],
   *   },
   * }}
   */
  function getTopologyFeatures(infoHash, fileIndex) {
    if (!infoHash) throw new Error('getTopologyFeatures requires infoHash');

    const fileIdxKey = fileIndex == null ? -1 : fileIndex;

    // Query all candidates with this info_hash (all file indexes)
    const candidateRows = db.prepare(`
      SELECT info_hash, file_index, file_index_key, filename, size
      FROM candidates
      WHERE info_hash = @info_hash
      ORDER BY file_index_key;
    `).all({ info_hash: infoHash });

    // Query release attributes for all file indexes of this info_hash
    const attributeRows = db.prepare(`
      SELECT info_hash, file_index_key, media_type, season, episode, resolution, source_type
      FROM release_attributes
      WHERE info_hash = @info_hash
      ORDER BY file_index_key;
    `).all({ info_hash: infoHash });

    // Build file list from candidates
    const files = candidateRows.map((row) => ({
      infoHash: row.info_hash,
      fileIndex: row.file_index_key,
      filename: row.filename,
      size: row.size,
      type: classifyFile(row.filename),
    }));

    const totalFiles = files.length;

    // Count by type
    const videoFiles = files.filter((f) => f.type === 'video').length;
    const subtitleFiles = files.filter((f) => f.type === 'subtitle').length;
    const archiveFiles = files.filter((f) => f.type === 'archive').length;
    const mediaFiles = videoFiles + subtitleFiles + archiveFiles;
    const nonMediaFiles = totalFiles - mediaFiles;

    // Structure detection
    const singleFileMedia = isSingleFileMedia(files);
    const hasExtras = files.some((f) => isExtrasFile(f.filename));
    const hasSamples = files.some((f) => isSampleFile(f.filename));
    const seasonStructure = hasSeasonStructure(attributeRows);
    const largestFileRatio = computeLargestFileRatio(files);

    // Quality signals
    const likelyPlayableTarget = files.some((f) => isLikelyPlayableTarget(f));
    const topologyConfidence = computeTopologyConfidence(files, attributeRows, totalFiles);
    const warnings = generateWarnings(files, attributeRows);

    return {
      identity: {
        infoHash,
        fileIndex,
      },
      files: {
        totalFiles,
        mediaFiles,
        nonMediaFiles,
        videoFiles,
        subtitleFiles,
        archiveFiles,
      },
      structure: {
        singleFileMedia,
        hasExtras,
        hasSamples,
        hasSeasonStructure: seasonStructure,
        largestFileRatio,
      },
      quality: {
        likelyPlayableTarget,
        topologyConfidence,
        warnings,
      },
    };
  }

  return {
    getTopologyFeatures,
  };
}
