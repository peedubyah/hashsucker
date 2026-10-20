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
import { randomUUID } from 'node:crypto';

import { getMedia } from '../metadata/cinemeta.js';
import {
  resolvePresentationName,
  buildPresentationStrmPath,
  inferMoviePresentation,
  inferEpisodePresentation,
} from '../control-plane/presentation-identity.js';
import { perfTrace } from '../perf-trace.js';

// Resolved per call (not at module load) so tests and operators can point
// output elsewhere via env without reimporting. Production default unchanged.
function strmOutputRoot() {
  return process.env.STRM_OUTPUT_PATH || '/strm';
}
const RESOLVER_BASE_URL = process.env.RESOLVER_BASE_URL || 'http://localhost:8080';

/**
 * The legacy title sanitizer (underscore replacement) is GONE: a
 * publication no longer renames an artifact. An artifact published under
 * an older naming rule is adopted where it is, and the presentation
 * identity records that path.
 *
 * @param {string} title
 * @returns {string}
 */
export function legacySanitizeFilename(title) {
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
 * Resolve the media title and year for `.strm` naming.
 *
 * The precedence is the SHARED one (`resolvePresentationName`): the
 * request's canonical title, then the catalog metadata, then the release
 * filename inference, then the media id. The `.strm` publisher used to
 * ignore the request's canonical title entirely and to lead with the
 * catalog, so the consumer path and the VFS path could disagree about the
 * name of the same media — and a catalog answer could move a published
 * artifact.
 *
 * @param {Object} params
 * @param {string} params.mediaId - Media identifier
 * @param {string} params.mediaType - 'movie' or 'series'
 * @param {Object} [params.selection] - Selection result with release metadata
 * @param {Object} [params.handoff] - The playback handoff
 * @returns {Promise<{ title: string, year: number|null }>}
 */
async function resolveMediaTitle({ mediaId, mediaType, selection, handoff }) {
  const isSeries = mediaType === 'series' || mediaType === 'tv';
  const inferred = isSeries
    ? inferEpisodePresentation(handoff?.filename, mediaId)
    : inferMoviePresentation(handoff?.filename, mediaId);

  let catalogTitle = null;
  let catalogYear = null;
  const cinemetaStartedAt = Date.now();
  // The catalog is consulted ONLY when the request did not name the media:
  // an explicit canonical title is the identity authority, and the year
  // rule follows the title's authority.
  const explicitTitle = typeof handoff?.canonicalTitle === 'string' ? handoff.canonicalTitle.trim() : '';
  try {
    if (explicitTitle) throw new Error('skip: the request named the media');
    const type = mediaType === 'series' ? 'series' : 'movie';
    const media = await getMedia(type, mediaId);
    perfTrace('provider.cinemeta', {
      provider: 'cinemeta', endpoint: 'meta', action: 'title',
      origin: 'remote', stage: 'strm-title', ok: true,
      ms: Date.now() - cinemetaStartedAt,
    });
    if (media?.title) {
      catalogTitle = media.title;
      catalogYear = media.year ?? null;
    }
  } catch (error) {
    perfTrace('provider.cinemeta', {
      provider: 'cinemeta', endpoint: 'meta', action: 'title',
      origin: 'remote', stage: 'strm-title', ok: false,
      ms: Date.now() - cinemetaStartedAt,
      err: String(error?.message ?? error),
    });
    // Cinemeta unavailable — fall through to the release filename.
  }

  return resolvePresentationName({
    canonicalTitle: handoff?.canonicalTitle ?? null,
    canonicalYear: handoff?.canonicalYear ?? null,
    catalogTitle,
    catalogYear,
    inferredTitle: inferred.title,
    inferredYear: isSeries ? null : inferred.year,
    mediaId,
  });
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
function buildStrmPath({ title, year, mediaType, season, episode }, sanitize = null) {
  const relative = buildPresentationStrmPath({
    mediaType: mediaType === 'series' || mediaType === 'tv' ? 'episode' : 'movie',
    title,
    year,
    season,
    episode,
  });
  const parts = relative.split('/');
  const file = parts.pop();
  return { dir: path.join(strmOutputRoot(), ...parts), file };
}

/**
 * Expected on-disk .strm path for a presentation identity, without
 * touching the filesystem or network. Lets callers verify an existing
 * publication cheaply instead of resolving titles upstream.
 */
export function expectedStrmPath({ title, year, mediaType, season, episode }) {
  const { dir, file } = buildStrmPath({ title, year, mediaType, season, episode });
  return path.join(dir, file);
}

/**
 * Find the artifact that already carries THIS media's resolver URL.
 *
 * The CONTENT is the arbiter, not the file name: a publication that was
 * made under an older naming rule is found here and ADOPTED, so a
 * republication never writes a second artifact for the same media (and
 * never renames the one the consumer already has).
 *
 * @param {Object} params
 * @param {string} params.mediaId
 * @param {string} params.mediaType
 * @param {number|null} [params.season]
 * @param {number|null} [params.episode]
 * @param {string} [params.root]
 * @returns {Promise<string|null>} the existing artifact's path
 */
export async function findExistingStrmArtifact({ mediaId, mediaType, season = null, episode = null, root = null }) {
  const isMovie = mediaType === 'movie';
  const base = root ?? strmOutputRoot();
  const candidates = [];
  try {
    if (isMovie) {
      const moviesRoot = path.join(base, 'Movies');
      for (const dir of await fs.readdir(moviesRoot, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const file of await fs.readdir(path.join(moviesRoot, dir.name))) {
          if (file.endsWith('.strm')) candidates.push(path.join(moviesRoot, dir.name, file));
        }
      }
    } else {
      const showsRoot = path.join(base, 'TV Shows');
      for (const show of await fs.readdir(showsRoot, { withFileTypes: true })) {
        if (!show.isDirectory()) continue;
        const seasonDir = path.join(showsRoot, show.name,
          `Season ${String(season ?? 0).padStart(2, '0')}`);
        for (const file of await fs.readdir(seasonDir).catch(() => [])) {
          if (file.endsWith('.strm')) candidates.push(path.join(seasonDir, file));
        }
      }
    }
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    let content;
    try {
      content = await fs.readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    const firstLine = content.split('\n')[0].trim();
    if (isMovie) {
      if (firstLine.includes(`/stream/movie/${mediaId}`)) return candidate;
      continue;
    }
    if (!firstLine.includes(`/stream/series/${mediaId}`)) continue;
    if (season != null && !firstLine.includes(`season=${season}`)) continue;
    if (episode != null && !firstLine.includes(`episode=${episode}`)) continue;
    return candidate;
  }
  return null;
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
export async function publishStrm({ handoff, selection, presentation = null }) {
  if (!handoff || !handoff.mediaId) {
    return { published: false, path: null };
  }

  const { mediaId, mediaType, season, episode } = handoff;

  // A COMMITTED presentation identity names the artifact. Nothing is
  // resolved, no metadata is fetched, and the path cannot move: the
  // identity was decided once, at the commit point.
  //
  // Without a committed identity (the first publication, or a legacy
  // publication that predates the identity) the name is resolved through
  // the shared precedence.
  let title;
  let year;
  let destFile;
  if (presentation?.strmPath) {
    destFile = path.join(strmOutputRoot(), presentation.strmPath);
    title = presentation.title ?? null;
    year = presentation.year ?? null;
  } else {
    const resolved = await resolveMediaTitle({
      mediaId,
      mediaType,
      selection,
      handoff,
    });
    title = resolved.title;
    year = resolved.year;
    // Build destination path with the canonical presentation rule shared
    // with VFS publication (illegal punctuation becomes a space, whitespace
    // collapses — no underscore artifacts).
    const { dir, file } = buildStrmPath({ title, year, mediaType, season, episode });
    destFile = path.join(dir, file);
  }
  const dir = path.dirname(destFile);
  const file = path.basename(destFile);

  // Idempotency: if the file already exists, return it.
  try {
    await fs.access(destFile);
    return { published: true, path: destFile };
  } catch {
    // The file is not at the expected path. Before creating one, look for
    // the artifact that already carries THIS media's resolver URL: a
    // publication made under an older naming rule is ADOPTED, not
    // duplicated and not renamed. The consumer's artifact keeps the path
    // it has always had.
    const existing = await findExistingStrmArtifact({
      mediaId, mediaType, season, episode, root: strmOutputRoot(),
    });
    if (existing) return { published: true, path: existing, adopted: true };
  }

  // Build the stable resolver URL. Series URLs MUST carry exact season/episode
  // identity so the resolver can load the matching playback handoff row.
  // Without these query params the resolver falls back to the latest handoff
  // for the media_id, which is the wrong episode for any series with more
  // than one episode. Movies are unchanged.
  const params = new URLSearchParams();
  if (mediaType === 'series' && season != null && episode != null) {
    params.set('season', String(season));
    params.set('episode', String(episode));
  }
  const queryString = params.toString();
  const resolverUrl = `${RESOLVER_BASE_URL}/stream/${mediaType}/${mediaId}${queryString ? `?${queryString}` : ''}`;

  // Atomic write: temp file → rename. The temp name is unique per writer:
  // two concurrent publications of the same item would otherwise race on
  // one temp file, and the loser's rename would fail with ENOENT.
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = path.join(dir, `.${file}.${randomUUID()}.tmp`);
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
