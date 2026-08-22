/**
 * Filename Parser Adapter
 *
 * Parses release filenames into structured release attributes.
 * Based on PTN patterns — custom regex-based implementation to avoid
 * broken npm dependencies.
 *
 * This adapter does NOT:
 * - Resolve media identity
 * - Create candidate_media rows
 * - Create provider observations
 *
 * It ONLY produces release attributes (evidence) from filename parsing.
 *
 * Architectural contract:
 * - Parser failures do not break ingestion
 * - Low-confidence parses are stored with confidence
 * - Ambiguous titles remain unresolved
 * - Evidence tags preserved
 * - Raw filename always retained
 */

// Common patterns for release filename parsing
const PATTERNS = {
  // Resolution patterns
  resolution: /(2160p|1080p|720p|480p|360p|4k|8k|4kuhd|uhd)/i,

  // Source patterns (flexible matching for common variations)
  source: /(blu[-\s]?ray|bdrip|brrip|web[-\s]?dl|webrip|web|hdtv|hd[-\s]?dvd|dvd|dsr|dsrip|hdtvrip|pdtv|tvrip|vhs|vhsrip|internal|repack|proper|rerip|remux)/i,

  // Codec patterns (including AVC as H.264 variant)
  codec: /(x264|x265|h\.?264|h\.?265|hevc|avc|divx|xvid|mpeg-?2|vc-?1)/i,

  // Audio patterns (order matters - more specific patterns first)
  audio: /(dts[-\s]?hd(?:\d\.\d)?|dts(?:\d\.\d)?|aac(?:\d\.\d)?|ac-?3(?:\d\.\d)?|truehd|atmos|mp3|flac|ogg|wma|pcm)/i,

  // HDR patterns
  hdr: /(hdr(?:10)?|dv|dolby.?vision|hlg)/i,

  // Language patterns
  language: /(english|french|spanish|german|italian|dutch|swedish|norwegian|danish|finnish|polish|russian|japanese|korean|chinese|multi)/i,

  // Release group pattern (typically at end of filename, after last dash)
  releaseGroup: /(?:^|[^a-zA-Z0-9])([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)(?:\.[a-zA-Z0-9]+)?$/,

  // Season/episode patterns
  seasonEpisode: /[Ss](\d{1,2})[Ee](\d{1,2})/,
  seasonEpisodeAlt: /Season\s*(\d{1,2})\s*Episode\s*(\d{1,2})/i,
  seasonEpisodeRange: /[Ss](\d{1,2})[Ee](\d{1,2})[-~][Ee]?(\d{1,2})/,
  seasonOnly: /Season\s*(\d{1,2})/i,
  episodeOnly: /Episode\s*(\d{1,2})/i,

  // Year pattern (must be surrounded by non-alphanumeric or start/end)
  year: /(?:^|[^a-zA-Z0-9])(19[3-9]\d|20[0-3]\d)(?:[^a-zA-Z0-9]|$)/,

  // Episode range (e.g., "S01E01-E03", "S01E01-03")
  episodeRange: /[Ss]\d{1,2}[Ee](\d{1,2})[-~][Ee]?(\d{1,2})/,

  // Edition patterns
  edition: /(extended|directors.?cut|unrated|theatrical|remastered|ultimate|collectors)/i,
};

/**
 * Parse a release filename into structured attributes.
 *
 * @param {string} filename - Raw filename to parse
 * @returns {Object} Parsed attributes with confidence and evidence
 */
export function parseFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return null;
  }

  const rawFilename = filename.trim();
  if (!rawFilename) {
    return null;
  }

  const evidence = [];
  const parsed = {};

  // Strip extension and common wrappers
  const cleaned = cleanFilename(rawFilename);

  // Extract resolution
  const resolution = extractPattern(rawFilename, PATTERNS.resolution);
  if (resolution) {
    parsed.resolution = normalizeResolution(resolution);
    evidence.push('resolution_detected');
  }

  // Extract source
  const source = extractPattern(rawFilename, PATTERNS.source);
  if (source) {
    parsed.source = normalizeSource(source);
    evidence.push('source_detected');
  }

  // Extract codec
  const codec = extractPattern(rawFilename, PATTERNS.codec);
  if (codec) {
    parsed.codec = normalizeCodec(codec);
    evidence.push('codec_detected');
  }

  // Extract audio
  const audio = extractPattern(rawFilename, PATTERNS.audio);
  if (audio) {
    parsed.audio = normalizeAudio(audio);
    evidence.push('audio_detected');
  }

  // Extract HDR
  const hdr = extractPattern(rawFilename, PATTERNS.hdr);
  if (hdr) {
    parsed.hdr = true;
    evidence.push('hdr_detected');
  }

  // Extract language
  const language = extractPattern(rawFilename, PATTERNS.language);
  if (language) {
    parsed.language = language.toLowerCase();
    evidence.push('language_detected');
  }

  // Extract season/episode
  const seInfo = extractSeasonEpisode(rawFilename);
  if (seInfo) {
    if (seInfo.season != null) parsed.season = seInfo.season;
    if (seInfo.episode != null) parsed.episode = seInfo.episode;
    if (seInfo.episodeRange) parsed.episodeRange = seInfo.episodeRange;
    if (seInfo.seasonOnly) parsed.mediaType = 'season'; // season pack
    evidence.push(...seInfo.evidence);
  }

  // Extract year (only if not a season/episode match)
  if (!parsed.season && !parsed.episode) {
    const yearMatch = rawFilename.match(PATTERNS.year);
    if (yearMatch) {
      parsed.year = parseInt(yearMatch[1], 10);
      evidence.push('year_detected');
    }
  }

  // Extract release group
  const group = extractReleaseGroup(rawFilename);
  if (group) {
    parsed.releaseGroup = group;
    evidence.push('release_group_detected');
  }

  // Extract title
  const title = extractTitle(cleaned, parsed);
  if (title) {
    parsed.title = title;
    evidence.push('title_extracted');
  }

  // Determine media type guess
  parsed.mediaType = guessMediaType(parsed);

  // Calculate confidence based on what we found
  const confidence = calculateConfidence(parsed, evidence);

  return {
    filename: rawFilename,
    parsed,
    confidence,
    evidence,
  };
}

/**
 * Clean filename by removing common wrappers and extensions.
 */
function cleanFilename(filename) {
  let cleaned = filename;

  // Remove extension
  cleaned = cleaned.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|iso|img)$/i, '');

  // Remove common wrapper patterns
  cleaned = cleaned.replace(/\.(x264|x265|h264|h265|hevc|aac|dts|ac3|mp3)$/i, '');

  return cleaned;
}

/**
 * Extract a regex pattern from text.
 */
function extractPattern(text, pattern) {
  const match = text.match(pattern);
  return match ? match[0] : null;
}

/**
 * Normalize resolution to standard form.
 */
function normalizeResolution(res) {
  const lower = res.toLowerCase();
  if (lower.includes('2160') || lower === '4k' || lower === '4kuhd' || lower === 'uhd') return '2160p';
  if (lower.includes('1080')) return '1080p';
  if (lower.includes('720')) return '720p';
  if (lower.includes('480')) return '480p';
  if (lower.includes('360')) return '360p';
  return lower;
}

/**
 * Normalize source to standard form.
 */
function normalizeSource(src) {
  const lower = src.toLowerCase().replace(/[-.\s]/g, '');
  if (lower.includes('bluray') || lower.includes('bdrip') || lower.includes('brrip')) return 'BluRay';
  if (lower.includes('webdl') || lower === 'web') return 'WEB-DL';
  if (lower.includes('webrip')) return 'WEBRip';
  if (lower.includes('hdtv')) return 'HDTV';
  if (lower.includes('dvd')) return 'DVD';
  if (lower.includes('dsr') || lower.includes('dsrip')) return 'DSRip';
  if (lower.includes('remux')) return 'Remux';
  if (lower === 'proper' || lower === 'repack') return 'Proper';
  if (lower === 'internal') return 'Internal';
  return src;
}

/**
 * Normalize codec to standard form.
 */
function normalizeCodec(codec) {
  const lower = codec.toLowerCase().replace(/[.\s]/g, '');
  if (lower.includes('x264') || lower === 'h264') return 'x264';
  if (lower.includes('x265') || lower === 'hevc' || lower === 'h265') return 'x265';
  if (lower.includes('divx')) return 'DivX';
  if (lower.includes('xvid')) return 'XviD';
  if (lower.includes('mpeg2') || lower === 'mpeg-2') return 'MPEG-2';
  if (lower.includes('vc1') || lower === 'vc-1') return 'VC-1';
  return codec;
}

/**
 * Normalize audio to standard form.
 */
function normalizeAudio(audio) {
  const lower = audio.toLowerCase();
  if (lower.includes('dts-hd') || lower.includes('dtshd')) return 'DTS-HD';
  if (lower.includes('dts')) return 'DTS';
  if (lower === 'aac' || lower.includes('aac')) return 'AAC';
  if (lower.includes('ac3') || lower.includes('ac-3')) return 'AC3';
  if (lower.includes('truehd') || lower.includes('true-hd')) return 'TrueHD';
  if (lower.includes('atmos')) return 'Atmos';
  if (lower.includes('flac')) return 'FLAC';
  if (lower.includes('mp3')) return 'MP3';
  return audio;
}

/**
 * Extract season and episode information.
 */
function extractSeasonEpisode(filename) {
  const result = { evidence: [] };

  // Try S01E03 range pattern first
  const rangeMatch = filename.match(PATTERNS.episodeRange);
  if (rangeMatch) {
    // Strip leading zeros for consistency
    result.episodeRange = `${parseInt(rangeMatch[1], 10)}-${parseInt(rangeMatch[2], 10)}`;
    result.evidence.push('episode_range_detected');
    // Also extract season from the S part
    const seasonMatch = filename.match(/[Ss](\d{1,2})/);
    if (seasonMatch) {
      result.season = parseInt(seasonMatch[1], 10);
    }
    return result;
  }

  // Try S01E03 pattern
  const seMatch = filename.match(PATTERNS.seasonEpisode);
  if (seMatch) {
    result.season = parseInt(seMatch[1], 10);
    result.episode = parseInt(seMatch[2], 10);
    result.evidence.push('season_episode_detected');
    return result;
  }

  // Try Season X Episode Y pattern
  const altMatch = filename.match(PATTERNS.seasonEpisodeAlt);
  if (altMatch) {
    result.season = parseInt(altMatch[1], 10);
    result.episode = parseInt(altMatch[2], 10);
    result.evidence.push('season_episode_detected');
    return result;
  }

  // Try season only
  const seasonMatch = filename.match(PATTERNS.seasonOnly);
  if (seasonMatch) {
    result.season = parseInt(seasonMatch[1], 10);
    result.seasonOnly = true;
    result.evidence.push('season_detected');
    return result;
  }

  // Try episode only (less common)
  const episodeMatch = filename.match(PATTERNS.episodeOnly);
  if (episodeMatch) {
    result.episode = parseInt(episodeMatch[1], 10);
    result.evidence.push('episode_detected');
    return result;
  }

  return null;
}

/**
 * Extract release group from filename.
 */
function extractReleaseGroup(filename) {
  // Remove extension
  const noExt = filename.replace(/\.\w+$/, '');

  // Look for group after last dash
  const parts = noExt.split(/[-\s]/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    // Group should be alphanumeric, not a year/resolution/etc.
    if (/^[a-zA-Z0-9]+$/.test(last) &&
        !/^\d{4}$/.test(last) &&
        !/^\d{3,4}p$/i.test(last) &&
        !/^(x264|x265|h264|hevc|aac|dts|ac3|mp3|flac|web|dl|bluray|bdrip|brrip|webrip|hdtv|dvd|proper|repack|remux|internal|hdr|dv|1080|720|480|2160|4k|uhd|extended|directors|unrated|theatrical|remastered|collectors)$/i.test(last)) {
      return last;
    }
  }

  return null;
}

/**
 * Extract title from cleaned filename.
 */
function extractTitle(cleaned, parsed) {
  let title = cleaned;

  // Remove season/episode patterns
  title = title.replace(/[Ss]\d{1,2}[Ee]\d{1,2}(?:[-~][Ee]?\d{1,2})?/g, '');
  title = title.replace(/Season\s*\d{1,2}(?:\s*Episode\s*\d{1,2})?/gi, '');
  title = title.replace(/Episode\s*\d{1,2}/gi, '');
  // Remove audio channel counts (e.g., "AAC2.0", "AC35.1", "DDP5.1")
  title = title.replace(/(?:aac|ac3|dts|mp3|flac|pcm|ddp?)\d(?:\.\d)?/gi, '');

  // Remove year (but preserve for parsed.year)
  title = title.replace(/(?:^|[^a-zA-Z0-9])(19[3-9]\d|20[0-3]\d)(?:[^a-zA-Z0-9]|$)/g, ' ');

  // Remove resolution
  title = title.replace(/(2160p|1080p|720p|480p|360p|4k|8k|4kuhd|uhd)/gi, '');

  // Remove source (flexible matching)
  title = title.replace(/(blu[-\s]?ray|bdrip|brrip|web[-\s]?dl|webrip|web|hdtv|hd[-\s]?dvd|dvd|dsr|dsrip|hdtvrip|pdtv|tvrip|vhs|vhsrip|internal|repack|proper|rerip|remux)/gi, '');

  // Remove codec
  title = title.replace(/(x264|x265|h\.?264|h\.?265|hevc|avc|divx|xvid|mpeg-?2|vc-?1)/gi, '');

  // Remove audio (with optional channel count and dash handling)
  // DDP = Dolby Digital Plus, DD = Dolby Digital
  title = title.replace(/(aac(?:\d\.\d)?|ac-?3(?:\d\.\d)?|ddp(?:\d\.\d)?|dd(?:\d\.\d)?|dts[-\s]?hd(?:\d\.\d)?|dts(?:\d\.\d)?|truehd|atmos|mp3|flac|ogg|wma|pcm)/gi, '');

  // Remove HDR
  title = title.replace(/(hdr(?:10)?|dv|dolby.?vision|hlg)/gi, '');

  // Remove streaming service tags (common in release filenames)
  title = title.replace(/\b(nf|amzn|dsnp|hmax|atvp|hulu|disney|netflix|hbo|apple|paramount)\b/gi, '');

  // Remove edition
  title = title.replace(/(extended|directors.?cut|unrated|theatrical|remastered|ultimate|collectors)/gi, '');

  // Clean up dots, dashes, underscores
  title = title.replace(/[._-]/g, ' ');

  // Remove extra whitespace
  title = title.replace(/\s+/g, ' ').trim();

  // Remove the already-extracted release group from the title
  // The release group was extracted earlier by extractReleaseGroup()
  if (parsed.releaseGroup) {
    const rg = parsed.releaseGroup;
    // Remove release group from end of title (with optional dash/space separator)
    title = title.replace(new RegExp(`\\s*[-\\s]?\\s*${rg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim();
  }

  return title || null;
}

/**
 * Guess media type from parsed attributes.
 */
function guessMediaType(parsed) {
  if (parsed.season && parsed.episode) return 'episode';
  if (parsed.season && parsed.episodeRange) return 'episode';
  if (parsed.seasonOnly) return 'season';
  if (parsed.year && !parsed.season && !parsed.episode) return 'movie';
  return 'unknown';
}

/**
 * Calculate confidence score based on parsed attributes.
 *
 * @param {Object} parsed - Parsed attributes
 * @param {Array<string>} evidence - Evidence tags
 * @returns {number} Confidence 0.0-1.0
 */
function calculateConfidence(parsed, evidence) {
  let score = 0.3; // Base confidence

  // Bonus for each detected field
  const bonuses = {
    title: 0.25,
    year: 0.15,
    season: 0.1,
    episode: 0.1,
    resolution: 0.1,
    source: 0.05,
    codec: 0.05,
    audio: 0.03,
    releaseGroup: 0.05,
    language: 0.02,
    hdr: 0.02,
  };

  for (const [field, bonus] of Object.entries(bonuses)) {
    if (parsed[field] != null) {
      score += bonus;
    }
  }

  // Cap at 1.0
  return Math.min(1.0, Math.max(0.0, score));
}

/**
 * Create a release attributes object for storage.
 * Combines parse result with candidate identity.
 *
 * @param {string} infoHash - Candidate infoHash
 * @param {number|null} fileIndex - Candidate fileIndex
 * @param {string} filename - Raw filename
 * @returns {Object|null} Release attributes ready for storage, or null if parse failed
 */
export function createReleaseAttributes(infoHash, fileIndex, filename) {
  if (!infoHash || !filename) return null;

  const parseResult = parseFilename(filename);
  if (!parseResult) return null;

  return {
    infoHash,
    fileIndex,
    filename: parseResult.filename,
    source: 'ptn-regex',
    confidence: parseResult.confidence,
    parsed: parseResult.parsed,
    evidence: parseResult.evidence,
  };
}

/**
 * Parse multiple filenames and return results.
 *
 * @param {Array<{infoHash: string, fileIndex: number|null, filename: string}>} items - Items to parse
 * @returns {Array<Object>} Parse results
 */
export function parseFilenames(items) {
  if (!Array.isArray(items)) return [];

  const results = [];
  for (const item of items) {
    const result = createReleaseAttributes(item.infoHash, item.fileIndex, item.filename);
    if (result) {
      results.push(result);
    }
  }
  return results;
}
