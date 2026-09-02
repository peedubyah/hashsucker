import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_SEGMENT_LENGTH = 160;
const MAX_PATH_LENGTH = 768;

export function buildPreferredCanonicalPath(item, options = {}) {
  const mediaType = normalizeMediaType(item.mediaType);
  const title = sanitizePathSegment(item.title || item.mediaId, 'Untitled');
  const extension = normalizeExtension(options.extension ?? item.extension ?? '.mkv');
  const year = normalizeOptionalInteger(item.year, 'year');
  const yearSuffix = year == null ? '' : ` (${year})`;

  if (mediaType === 'movie') {
    const display = `${title}${yearSuffix}`;
    return normalizeCanonicalPath(`Movies/${display}/${display}${extension}`);
  }

  const season = normalizeOptionalInteger(item.season, 'season');
  const episode = normalizeOptionalInteger(item.episode, 'episode');
  if (season == null || episode == null) {
    throw new TypeError('Episode canonical paths require season and episode');
  }
  const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return normalizeCanonicalPath(
    `TV/${title}${yearSuffix}/Season ${String(season).padStart(2, '0')}/${title} - ${code}${extension}`,
  );
}

export function normalizeCanonicalPath(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('canonicalPath must be a non-empty relative path');
  }
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    throw new TypeError('canonicalPath must be relative');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('canonicalPath cannot contain empty, dot, or parent segments');
  }
  const safe = segments.map((segment) => sanitizePathSegment(segment)).join('/');
  if (safe.length > MAX_PATH_LENGTH) throw new TypeError('canonicalPath is too long');
  return safe;
}

export function addDeterministicCollisionSuffix(canonicalPath, identityKey, length = 10) {
  const normalized = normalizeCanonicalPath(canonicalPath);
  if (typeof identityKey !== 'string' || identityKey.length === 0) {
    throw new TypeError('identityKey is required for collision handling');
  }
  const token = createHash('sha256').update(identityKey).digest('hex').slice(0, length);
  const parsed = path.posix.parse(normalized);
  return `${parsed.dir ? `${parsed.dir}/` : ''}${parsed.name} [${token}]${parsed.ext}`;
}

export function stableLibraryItemId(identityKey) {
  if (typeof identityKey !== 'string' || identityKey.length === 0) {
    throw new TypeError('identityKey is required');
  }
  return `li_${createHash('sha256').update(identityKey).digest('hex').slice(0, 24)}`;
}

export function createLibraryIdentityKey({ mediaType, mediaId, season, episode, editionKey = 'default' }) {
  const type = normalizeMediaType(mediaType);
  const id = normalizeIdentityPart(mediaId, 'mediaId');
  const edition = normalizeIdentityPart(editionKey, 'editionKey').toLowerCase();
  // Episode identity must include (season, episode) so a season pack yields
  // a distinct library_items row per episode. Without this, all episodes
  // collapse into one row keyed only by mediaId, and the per-episode
  // canonical path / exposure / binding all collide. The DB columns were
  // always there; the identity key just failed to include them.
  if (type === 'episode') {
    if (!Number.isSafeInteger(season) || season < 0) {
      throw new TypeError('season must be a non-negative safe integer for episode identity');
    }
    if (!Number.isSafeInteger(episode) || episode < 1) {
      throw new TypeError('episode must be a positive safe integer for episode identity');
    }
    return `${type}:${id}:${edition}:${season}:${episode}`;
  }
  return `${type}:${id}:${edition}`;
}

function sanitizePathSegment(value, fallback = null) {
  let safe = String(value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!safe && fallback != null) safe = fallback;
  if (!safe) throw new TypeError('canonicalPath contains an empty unsafe segment');
  if (safe.length > MAX_SEGMENT_LENGTH) safe = safe.slice(0, MAX_SEGMENT_LENGTH).trimEnd();
  return safe;
}

function normalizeExtension(value) {
  if (typeof value !== 'string' || !/^\.[a-z0-9]{1,10}$/i.test(value.trim())) {
    throw new TypeError('extension must be a dot-prefixed alphanumeric file extension');
  }
  return value.trim().toLowerCase();
}

function normalizeMediaType(value) {
  if (value !== 'movie' && value !== 'episode') {
    throw new TypeError('mediaType must be movie or episode');
  }
  return value;
}

function normalizeOptionalInteger(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer or null`);
  }
  return value;
}

function normalizeIdentityPart(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be a non-empty string up to 256 characters`);
  }
  return value.trim();
}
