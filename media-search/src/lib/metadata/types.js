/**
 * Normalized Media Object
 *
 * Provider-agnostic media representation. All upstream metadata providers
 * (Cinemeta, TMDB, etc.) must adapt their responses to this shape.
 *
 * This is the ONLY shape the frontend should ever see for title discovery.
 */

/**
 * @typedef {Object} NormalizedMedia
 * @property {string} id - Provider-specific media identifier (e.g., "tt2085059")
 * @property {'movie'|'series'} type - Media type
 * @property {string} title - Canonical title
 * @property {number|null} year - Release year (null if unknown)
 * @property {string|null} posterUrl - Poster image URL (null if unavailable)
 * @property {string|null} backdropUrl - Backdrop/fanart URL (null if unavailable)
 * @property {string|null} overview - Brief description/synopsis (null if unavailable)
 */

/**
 * Create a normalized media object with safe defaults.
 *
 * @param {Object} input - Partial media data
 * @returns {NormalizedMedia} Normalized media object
 */
export function createNormalizedMedia(input = {}) {
  return {
    id: String(input.id || ''),
    type: input.type === 'movie' ? 'movie' : 'series',
    title: String(input.title || ''),
    year: Number.isFinite(input.year) ? input.year : null,
    posterUrl: input.posterUrl || null,
    backdropUrl: input.backdropUrl || null,
    overview: input.overview || null,
  };
}

/**
 * Validate that an object conforms to the normalized media shape.
 * Returns array of missing/invalid fields (empty = valid).
 *
 * @param {Object} obj
 * @returns {string[]} Array of validation errors
 */
export function validateNormalizedMedia(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return ['not an object'];
  if (typeof obj.id !== 'string' || !obj.id) errors.push('id must be non-empty string');
  if (!['movie', 'series'].includes(obj.type)) errors.push('type must be "movie" or "series"');
  if (typeof obj.title !== 'string' || !obj.title) errors.push('title must be non-empty string');
  if (obj.year !== null && !Number.isInteger(obj.year)) errors.push('year must be integer or null');
  if (obj.posterUrl !== null && typeof obj.posterUrl !== 'string') errors.push('posterUrl must be string or null');
  if (obj.backdropUrl !== null && typeof obj.backdropUrl !== 'string') errors.push('backdropUrl must be string or null');
  if (obj.overview !== null && typeof obj.overview !== 'string') errors.push('overview must be string or null');
  return errors;
}
