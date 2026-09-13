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

// Theatrical captures + screeners. Matched as whole tokens AFTER
// stripping the extension and the trailing -GROUP suffix (a group named
// "TC" must not condemn an otherwise clean WEB-DL). Tokenization keeps
// dashes so multiword tags (hd-ts, web-dl) survive intact.
const GARBAGE_TOKENS = [
  'cam', 'hd-cam', 'hdcam',
  'ts', 'hd-ts', 'hdts', 'telesync',
  'tc', 'hd-tc', 'hdtc', 'telecine',
  'scr', 'dvd-scr', 'dvdscr', 'screener',
];

function stripExtension(filename) {
  return String(filename || '').replace(/\.(mkv|mp4|avi|mov|m4v|mpg|mpeg|wmv|flv|webm|ts|iso|img)$/i, '');
}

function stripReleaseGroup(name) {
  // Trailing -GROUP suffix (1-12 alphanumerics after the last dash).
  // Only the final dash-component is removed, so mid-name quality
  // tokens are never affected.
  return String(name || '').replace(/-[A-Za-z0-9]{1,12}$/, '');
}

function tokensOf(name) {
  // Dashes are KEPT so multiword tags (hd-ts, web-dl, blu-ray) survive
  // as single tokens. Dots/spaces/brackets separate tokens.
  return String(name || '').toLowerCase().split(/[\.\s_\[\]\(\)]+/).filter(Boolean);
}

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
  const toks = new Set(tokensOf(stripReleaseGroup(stripExtension(filename))));
  for (const g of GARBAGE_TOKENS) {
    if (toks.has(g)) return ANTICIPATION_QUALITY.GARBAGE;
  }
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
  for (const t of ['remux', 'bluray', 'blu-ray', 'web-dl', 'webdl', 'web', 'webrip', 'hdtv', 'bdrip', 'brrip']) {
    if (toks.has(t)) return ANTICIPATION_QUALITY.ACCEPTABLE;
  }
  return ANTICIPATION_QUALITY.UNKNOWN;
}
