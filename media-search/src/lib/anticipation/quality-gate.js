/**
 * Anticipatory release-quality gate (anticipation policy hardening tranche).
 *
 * Automatic speculative PUBLICATION must never present the first torrent
 * on Earth: theatrical captures (CAM/TS/TC) and screeners routinely appear
 * weeks before acceptable home-quality media. This module judges ONE
 * already-selected candidate (winner filename + parsed source class) as:
 *
 *   acceptable — clearly home-quality classes (REMUX/BluRay/WEB-DL/
 *                WEBRip/HDTV). Safe to publish speculatively.
 *   garbage    — clearly theatrical-capture/screener classes. Never
 *                publish speculatively.
 *   unknown    — anything else. Do not publish prematurely; keep waiting.
 *
 * Inputs are the pipeline's EXISTING outputs (ranked winner filename +
 * parsed `release.source`); no second title parser is built here. Only a
 * small quality-token scan runs on the filename, because the shared
 * filename parser has no TS/TC/SCR vocabulary and this tranche must not
 * change global ranking. No size inference anywhere, by policy.
 */

export const ANTICIPATION_QUALITY = Object.freeze({
  ACCEPTABLE: 'acceptable',
  GARBAGE: 'garbage',
  UNKNOWN: 'unknown',
});

import { THEATRICAL_SOURCE_TOKENS, detectTheatricalSource } from '../discovery/quality-features.js';

// Theatrical captures + screeners share one vocabulary with the
// interactive ranker (THEATRICAL_SOURCE_TOKENS); only the verdict
// differs (hard park here, score penalty there). Extension/group
// stripping lives in the shared detector.

// Normalized acceptable source classes, covering both the filename
// parser's vocabulary (BluRay/WEB-DL/WEBRip/HDTV/DVD/Remux/…) and the
// quality-features vocabulary (bluray/web-dl/webrip/hdtv/remux/…).
const ACCEPTABLE_SOURCES = new Set([
  'remux',
  'bluray', 'blu-ray', 'bdrip', 'brrip',
  'webdl', 'web-dl', 'web',
  'webrip',
  'hdtv',
]);

function acceptableTokensOf(filename) {
  // Same normalization as the shared theatrical scan (extension + group
  // stripped) so `WEB-DL-G` still reads as an acceptable token.
  const bare = String(filename || '')
    .replace(/\.(mkv|mp4|avi|mov|m4v|mpg|mpeg|wmv|flv|webm|ts|iso|img)$/i, '')
    .replace(/-[A-Za-z0-9]{1,12}$/, '');
  return bare.toLowerCase().split(/[\.\s_\[\]\(\)]+/).filter(Boolean);
}

function normalizeSourceClass(source) {
  if (source == null) return null;
  const s = String(source).trim().toLowerCase().replace(/[\s._]+/g, '-');
  return s || null;
}

/**
 * Judge one selected candidate for speculative publication.
 *
 * @param {Object} args
 * @param {string|null} args.filename   ranked winner filename
 * @param {string|null} args.sourceType parsed release.source class (any vocabulary)
 * @returns {'acceptable'|'garbage'|'unknown'}
 */
export function judgeReleaseQuality({ filename = null, sourceType = null } = {}) {
  if (detectTheatricalSource(filename)) return ANTICIPATION_QUALITY.GARBAGE;
  // 'cam' is also caught above as a token; this covers a parser that
  // already classified the source as cam-class without token residue.
  const norm = normalizeSourceClass(sourceType);
  if (norm === 'cam') return ANTICIPATION_QUALITY.GARBAGE;
  if (norm && (ACCEPTABLE_SOURCES.has(norm) || ACCEPTABLE_SOURCES.has(norm.replace(/-/g, '')))) {
    return ANTICIPATION_QUALITY.ACCEPTABLE;
  }
  // Filename-level acceptable tokens rescue candidates whose parsed
  // source class is missing but whose release line is explicit. Bare
  // 'web' (not theatrical) and 'blu-ray' (dashes kept) included.
  const toks = new Set(acceptableTokensOf(filename));
  for (const t of ['remux', 'bluray', 'blu-ray', 'web-dl', 'webdl', 'web', 'webrip', 'hdtv', 'bdrip', 'brrip']) {
    if (toks.has(t)) return ANTICIPATION_QUALITY.ACCEPTABLE;
  }
  return ANTICIPATION_QUALITY.UNKNOWN;
}
