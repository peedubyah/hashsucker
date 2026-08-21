/**
 * Type definitions for the frontend API contracts.
 * These types are derived from the actual backend responses.
 */

// ===== Public Response Shapes =====

/**
 * @typedef {Object} TitleSearchResult
 * @property {Array<TitleResult>} results - Title results from Cinemeta
 * @property {Timings} timings
 */

/**
 * @typedef {Object} ReleaseSearchResult
 * @property {SearchIntent} intent - Parsed media intent
 * @property {Array<ReleaseResult>} results - Ranked release candidates
 * @property {number} total - Total results available
 * @property {Timings} timings
 * @property {SearchStats} stats
 */

/**
 * @typedef {Object} InternalSearchResult
 * @property {Array<InternalReleaseResult>} results - DMM corpus results
 * @property {number} total - Total results available
 * @property {Object} query - Query metadata (match, filters, titleQuery)
 * @property {Timings} timings
 * @property {SearchStats} stats
 */

/**
 * @typedef {Object} MediaLookupResult
 * @property {MediaResult} media - Media details
 * @property {Timings} timings
 */

/**
 * @typedef {Object} RequestSubmissionResult
 * @property {string} requestId - UUID of the submitted request
 * @property {string} status - Always "queued" on success
 */

/**
 * @typedef {Object} RequestStatusResult
 * @property {string} requestId - UUID of the request
 * @property {string} status - One of "queued", "processing", "done", "failed"
 */

/**
 * @typedef {Object} IngestResult
 * @property {number} imported - Records imported
 * @property {number} inserted - Records inserted
 * @property {number} updated - Records updated
 * @property {number} failed - Records failed
 * @property {number} attributesParsed - Records with attributes parsed
 * @property {number} durationMs - Duration in ms
 */

/**
 * @typedef {Object} AttributeRunResult
 * @property {number} parsed - Number of candidates parsed
 * @property {number} failed - Number of failures
 */

/**
 * @typedef {Object} HealthStatus
 * @property {boolean} ok - Always true
 */

// ===== Data Types =====

/**
 * @typedef {Object} TitleResult
 * @property {string} id - Media identifier (e.g., "tt2085059")
 * @property {string} type - 'movie' or 'series'
 * @property {string} name - Title name
 * @property {string|null} poster - Poster URL
 * @property {string|null} year - Year or year range
 * @property {string|null} description - Brief description
 */

/**
 * @typedef {Object} ReleaseResult
 * @property {string} infoHash - 40-char hex infoHash
 * @property {number|null} fileIndex - File index (null for single-file)
 * @property {string} title - Parsed title
 * @property {string} filename - Original release filename
 * @property {number|null} size - File size in bytes
 * @property {string|null} resolution - e.g., "1080p", "2160p", "720p"
 * @property {string|null} quality - e.g., "WEB-DL", "BluRay", "HDTV"
 * @property {string|null} codec - e.g., "x264", "x265"
 * @property {string|null} hdr - "true" if HDR (nullable)
 * @property {string|null} audio - Audio format
 * @property {string|null} releaseGroup - Release group name
 * @property {number|null} year - Release year
 * @property {number|null} season - Season number
 * @property {number|null} episode - Episode number
 * @property {number} confidence - Parse confidence (0.0-1.0)
 * @property {number} score - Composite ranking score (0.0-1.0)
 * @property {ScoreComponents} components - Score breakdown
 * @property {Object.<string, ProviderObservation>} providers - Provider observations
 * @property {Array<MediaAssociation>} media - Media associations
 * @property {string} _source - "corpus" (DMM) or "live" (Torrentio/Torznab)
 */

/**
 * @typedef {Object} InternalReleaseResult
 * @property {string} hash - 40-char hex infoHash
 * @property {number|null} fileIndex - File index (null for single-file)
 * @property {string} filename - Original release filename
 * @property {ReleaseAttributes} parsed - Parsed release attributes
 * @property {number} confidence - Parse confidence (0.0-1.0)
 * @property {number} score - Composite ranking score (0.0-1.0)
 * @property {number} relevance - Title relevance score
 * @property {number} quality - Quality score
 * @property {number} releaseConfidence - Release parse confidence
 * @property {number} identityConfidence - Media identity confidence
 * @property {number} provider - Provider availability score
 * @property {number} episodeMatch - Episode match score
 * @property {ScoreComponents} components - Score breakdown
 * @property {Array<ProviderObservation>} [providers] - Provider observations (if includeProviders)
 * @property {Array<MediaAssociation>} [media] - Media associations (if includeMedia)
 */

/**
 * @typedef {Object} ReleaseAttributes
 * @property {string} title - Parsed title
 * @property {number|null} year - Release year
 * @property {number|null} season - Season number
 * @property {number|null} episode - Episode number
 * @property {string|null} resolution - e.g., "1080p", "2160p"
 * @property {string|null} source - Source type (e.g., "WEB-DL", "BluRay")
 * @property {string|null} codec - e.g., "x264", "x265"
 * @property {boolean|null} hdr - HDR flag
 * @property {string|null} audio - Audio format
 * @property {string|null} releaseGroup - Release group name
 */

/**
 * @typedef {Object} ScoreComponents
 * @property {number} relevance - Title relevance
 * @property {number} quality - Quality score
 * @property {number} releaseConfidence - Release parse confidence
 * @property {number} identityConfidence - Media identity confidence
 * @property {number} providerAvailability - Provider availability
 * @property {number} episodeMatch - Episode match score
 */

/**
 * @typedef {Object} ProviderObservation
 * @property {boolean|null} cached - Cache state (null=unknown, true=cached, false=not cached)
 * @property {Array<string>|null} evidence - Evidence tags
 */

/**
 * @typedef {Object} MediaAssociation
 * @property {string} mediaId - Associated media identifier
 * @property {string} source - Association source
 * @property {number} confidence - Association confidence
 * @property {Array<string>|null} evidence - Evidence tags
 * @property {number} associatedAt - Timestamp
 */

/**
 * @typedef {Object} MediaResult
 * @property {string} id - Media identifier
 * @property {string} type - 'movie' or 'series'
 * @property {string} name - Title name
 * @property {string|null} poster - Poster URL
 * @property {string|null} year - Year or year range
 * @property {string|null} description - Brief description
 * @property {Array<VideoResult>} videos - Episode list (series only)
 */

/**
 * @typedef {Object} VideoResult
 * @property {string} id - Video identifier (e.g., "tt2085059:7:3")
 * @property {number} season - Season number
 * @property {number} episode - Episode number
 * @property {string} title - Episode title
 * @property {string|null} released - Release date ISO string
 * @property {string|null} thumbnail - Thumbnail URL
 */

/**
 * @typedef {Object} SearchIntent
 * @property {string} streamType - 'movie' or 'series'
 * @property {string} mediaType - 'movie' or 'tv'
 * @property {string} scope - 'movie', 'series', or 'episode'
 * @property {string} mediaId - Full media identifier
 * @property {string} baseMediaId - Base media identifier (without season:episode)
 * @property {number|null} season - Season number
 * @property {Array<number>} episodes - Episode numbers
 */

/**
 * @typedef {Object} SearchStats
 * @property {number} indexed - Number of candidates in FTS5 index
 * @property {number} total - Total candidates in database
 */

/**
 * @typedef {Object} Timings
 * @property {number} totalMs - Total response time in milliseconds
 */

export const Types = {};
