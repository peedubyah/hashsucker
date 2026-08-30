/**
 * STRM Publisher
 *
 * Publishes a `.strm` artifact immediately after a durable playback handoff
 * is committed. The `.strm` contains the stable resolver URL (Caddy edge),
 * not a transient provider URL.
 *
 * Behavior:
 *   - Only publishes after a valid durable playback handoff exists
 *   - Writes atomically: temp file in same directory → rename to final `.strm`
 *   - Idempotent: repeating the same request does not create duplicate files
 *   - Never overwrites an existing `.strm`
 *
 * Output structure (matches existing torbox-importer conventions):
 *   /strm/Movies/Title (Year)/Title (Year).strm
 *   /strm/TV Shows/Title (Year)/Season XX/Title (Year) - SXXEXX.strm
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { getMedia } from '../metadata/cinemeta.js';

const STRM_OUTPUT_ROOT = process.env.STRM_OUTPUT_PATH || '/strm';
const RESOLVER_BASE_URL = process.env.RESOLVER_BASE_URL || 'http://localhost:8080';

/**
 * Sanitize a title for filesystem use: replace path-unsafe characters.
 * @param {string} title
 * @returns {string}
 */
function sanitizeFilename(title) {
  return String(title || '')
    .replace(/\//g, '_')
    .replace(/:/g, '_')
    .replace(/\?/g, '_')
    .replace(/"/g, '_')
    .replace(/\*/g, '_')
    .replace(/</g, '_')
    .replace(/>/g, '_')
    .replace(/\|/g, '_')
    .trim();
}

/**
 * Resolve media title and year for STRM naming.
 *
 * Priority:
 *   1. Cinemeta lookup (clean canonical name + year)
 *   2. Selection release metadata (from corpus/live discovery)
 *   3. Fallback to mediaId
 *
 * @param {Object} params
 * @param {string} params.mediaId - Media identifier
 * @param {string} params.mediaType - 'movie' or 'series'
 * @param {Object} [params.selection] - Selection result with release metadata
 * @param {string} [params.fallbackTitle] - Optional fallback title
 * @returns {Promise<{ title: string, year: string|null }>}
 */
async function resolveMediaTitle({ mediaId, mediaType, selection, handoff }) {
  // Priority 1: Cinemeta lookup for clean canonical name
  try {
    const type = mediaType === 'series' ? 'series' : 'movie';
    const media = await getMedia(type, mediaId);
    if (media?.title) {
      return {
        title: media.title,
        year: media.year ? String(media.year) : null,
      };
    }
  } catch {
    // Cinemeta unavailable — fall through
  }

  // Priority 2: Selection release metadata
  const release = selection?.selected?.release;
  if (release?.title) {
    return {
      title: release.title,
      year: release.year ? String(release.year) : null,
    };
  }

  // Priority 3: Handoff filename (cleaned up)
  if (handoff?.filename) {
    const cleanTitle = handoff.filename
      .replace(/\.(mkv|mp4|avi|mov|webm)$/i, '')
      .replace(/\./g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanTitle) {
      return { title: cleanTitle, year: null };
    }
  }

  // Last resort: use mediaId
  return { title: mediaId, year: null };
}

/**
 * Build the STRM destination path.
 *
 * @param {Object} params
 * @param {string} params.title - Media title
 * @param {string|null} params.year - Release year
 * @param {string} params.mediaType - 'movie' or 'series'
 * @param {number|null} [params.season] - Season number (series only)
 * @param {number|null} [params.episode] - Episode number (series only)
 * @returns {{ dir: string, file: string }} Destination directory and filename
 */
function buildStrmPath({ title, year, mediaType, season, episode }) {
  const safeTitle = sanitizeFilename(title);
  const yearPart = year ? ` (${year})` : '';

  if (mediaType === 'series') {
    const seasonNum = season != null ? String(season).padStart(2, '0') : '00';
    const episodeNum = episode != null ? String(episode).padStart(2, '0') : '00';
    const dir = path.join(STRM_OUTPUT_ROOT, 'TV Shows', `${safeTitle}${yearPart}`, `Season ${seasonNum}`);
    const file = `${safeTitle}${yearPart} - S${seasonNum}E${episodeNum}.strm`;
    return { dir, file };
  }

  // Movie
  const dir = path.join(STRM_OUTPUT_ROOT, 'Movies', `${safeTitle}${yearPart}`);
  const file = `${safeTitle}${yearPart}.strm`;
  return { dir, file };
}

/**
 * Publish a `.strm` artifact for a committed playback handoff.
 *
 * Idempotent: if the `.strm` already exists, returns the existing path.
 *
 * @param {Object} params
 * @param {Object} params.handoff - The committed playback handoff
 * @param {string} params.handoff.mediaId - Media identifier
 * @param {string} params.handoff.mediaType - 'movie' or 'series'
 * @param {number|null} [params.handoff.season] - Season number
 * @param {number|null} [params.handoff.episode] - Episode number
 * @param {Object} [params.selection] - Selection result with release metadata
 * @param {string} [params.fallbackTitle] - Optional fallback title
 * @returns {Promise<{ published: boolean, path: string|null }>} Result
 */
export async function publishStrm({ handoff, selection }) {
  if (!handoff || !handoff.mediaId) {
    return { published: false, path: null };
  }

  const { mediaId, mediaType, season, episode } = handoff;

  // Resolve title/year for naming
  const { title, year } = await resolveMediaTitle({
    mediaId,
    mediaType,
    selection,
    handoff,
  });



  // Build destination path
  const { dir, file } = buildStrmPath({ title, year, mediaType, season, episode });
  const destFile = path.join(dir, file);

  // Idempotency check: if file already exists, return it
  try {
    await fs.access(destFile);
    return { published: true, path: destFile };
  } catch {
    // File doesn't exist — proceed to create
  }

  // Build the stable resolver URL
  const resolverUrl = `${RESOLVER_BASE_URL}/stream/${mediaType}/${mediaId}`;

  // Atomic write: temp file → rename
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = path.join(dir, `.${file}.tmp`);
  try {
    await fs.writeFile(tmpFile, `${resolverUrl}\n`, { encoding: 'utf8' });
    await fs.rename(tmpFile, destFile);
    return { published: true, path: destFile };
  } catch (error) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpFile);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}
