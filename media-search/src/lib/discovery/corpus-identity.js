/**
 * Corpus identity lookup (corpus intelligence tranche).
 *
 * Answers "what candidates do I already know for media X?" WITHOUT prior
 * requests and WITHOUT external per-candidate calls, using only local
 * truth:
 *
 * - an FTS5 title index over release_attributes (3 ms per lookup), plus
 * - exact year / season-episode structural filters, plus
 * - a strict normalized-title equality post-filter.
 *
 * Confidence tiers:
 * - STRONG: explicit upstream IDs or request-outcome associations at
 *   high confidence (served by the existing candidate_media path).
 * - STRUCTURED: exact normalized title (+year for movies, +S/E for TV).
 *   Only this tier (and STRONG) feeds ranking automatically.
 * - WEAK: release-name-only inference. Never auto-populates; diagnostic
 *   use only (no code path produces it today).
 *
 * Wanted-identity resolution (title/year for a bare mediaId) uses one
 * cached Cinemeta lookup per unknown media — never a fanout. Seerr
 * requests already carry canonical titles and skip it entirely.
 */
import { getMedia } from '../metadata/cinemeta.js';

export const IDENTITY_TIERS = Object.freeze({
  STRONG: 'strong',
  STRUCTURED: 'structured',
  WEAK: 'weak',
});

const TITLE_CACHE_TTL_MS = 60 * 60 * 1000;
const titleCache = new Map();

/** Normalize a title for exact comparison: lowercase, de-diacritic, punctuation → space. */
export function normalizeTitle(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Build a safe FTS5 phrase query from a normalized title. */
export function ftsTitleQuery(normalized) {
  const tokens = normalized.split(' ').filter(Boolean).slice(0, 12);
  if (tokens.length === 0) return null;
  // Quote each token (FTS5 phrase); tokens are [a-z0-9] so no escaping needed.
  return tokens.map((t) => `"${t}"`).join(' ');
}

function dbOf(cache) {
  const db = cache?.db;
  if (!db) throw new Error('corpus identity lookup requires cache.db');
  return db;
}

/**
 * Look up corpus candidates by wanted identity. Pure local reads.
 * Movies require exact title + year. Episodes require exact title + S/E.
 * Returns deduplicated rows with STRUCTURED tier evidence.
 */
export function lookupCorpusByTitle(cache, {
  title, year = null, season = null, episode = null, mediaType = 'movie', limit = 100,
} = {}) {
  const norm = normalizeTitle(title);
  if (!norm) return [];
  const phrase = ftsTitleQuery(norm);
  if (!phrase) return [];
  const db = dbOf(cache);
  const isEpisode = mediaType === 'episode' || mediaType === 'series'
    || (Number.isSafeInteger(season) && Number.isSafeInteger(episode));
  let rows;
  const cols = `r.info_hash AS infoHash, r.file_index AS fileIndex,
               r.filename AS filename, r.title AS title, r.year AS year,
               r.season AS season, r.episode AS episode,
               r.resolution AS resolution, r.source_type AS sourceType,
               r.codec AS codec, r.hdr AS hdr, r.audio AS audio,
               c.size AS size`;
  try {
    if (isEpisode && Number.isSafeInteger(season) && Number.isSafeInteger(episode)) {
      rows = db.prepare(`
        SELECT ${cols}
        FROM release_search s
        JOIN release_attributes r ON r.rowid = s.rowid
        LEFT JOIN candidates c ON c.info_hash = r.info_hash
          AND c.file_index_key = r.file_index_key
        WHERE s.title MATCH ?
          AND r.season = ? AND r.episode = ?
        LIMIT ?`).all(phrase, season, episode, limit * 4);
    } else if (!isEpisode && Number.isSafeInteger(year)) {
      rows = db.prepare(`
        SELECT ${cols}
        FROM release_search s
        JOIN release_attributes r ON r.rowid = s.rowid
        LEFT JOIN candidates c ON c.info_hash = r.info_hash
          AND c.file_index_key = r.file_index_key
        WHERE s.title MATCH ?
          AND r.year = ? AND (r.media_type = 'movie' OR r.media_type IS NULL)
        LIMIT ?`).all(phrase, year, limit * 4);
    } else {
      return [];
    }
  } catch {
    return [];
  }
  // Strict post-filter: exact normalized title equality (FTS stems).
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row?.infoHash || normalizeTitle(row.title) !== norm) continue;
    const key = `${row.infoHash}:${row.fileIndex ?? 'torrent'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      infoHash: row.infoHash,
      fileIndex: row.fileIndex,
      filename: row.filename,
      title: row.title,
      year: row.year,
      season: row.season,
      episode: row.episode,
      resolution: row.resolution,
      sourceType: row.sourceType,
      codec: row.codec,
      hdr: row.hdr,
      audio: row.audio,
      size: Number.isSafeInteger(row.size) && row.size > 0 ? row.size : null,
      tier: IDENTITY_TIERS.STRUCTURED,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Resolve the wanted title/year for a request. Prefers caller-supplied
 * canonical identity (zero calls); otherwise one cached Cinemeta lookup.
 * Returns { title, year } with year possibly null.
 */
export async function resolveWantedIdentity({
  mediaId, mediaType = 'movie', mediaTitle = null, canonicalYear = null, getMediaFn = null,
} = {}) {
  if (mediaTitle && String(mediaTitle).trim()) {
    const year = Number.isSafeInteger(canonicalYear) ? canonicalYear : null;
    return { title: String(mediaTitle).trim(), year, source: 'caller' };
  }
  if (!mediaId) return { title: null, year: null, source: 'none' };
  const cacheKey = `${mediaType}:${mediaId}`;
  const hit = titleCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const get = getMediaFn || ((type, id) => getMedia(type, id));
    const type = mediaType === 'series' || mediaType === 'episode' ? 'series' : 'movie';
    const meta = await get(type, mediaId);
    const title = meta?.title || meta?.name || null;
    let year = null;
    const rawYear = meta?.year;
    if (Number.isSafeInteger(rawYear)) year = rawYear;
    else if (typeof rawYear === 'string') {
      const m = rawYear.match(/(\d{4})/);
      if (m) year = parseInt(m[1], 10);
    }
    const value = { title, year, source: 'cinemeta' };
    titleCache.set(cacheKey, { value, expiresAt: Date.now() + TITLE_CACHE_TTL_MS });
    if (titleCache.size > 5000) {
      const first = titleCache.keys().next().value;
      titleCache.delete(first);
    }
    return value;
  } catch {
    return { title: null, year: null, source: 'failed' };
  }
}

export function _clearTitleCacheForTests() {
  titleCache.clear();
}
