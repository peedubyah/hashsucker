/**
 * Shared media-identity agreement (ONE conservative matcher for
 * foreground enrichment, background enrichment, and corpus hygiene).
 *
 * Answers: does this release filename/title plausibly depict THIS media?
 * Never asserts a positive identity — only agreement or refusal — so
 * transliteration, alternate titles, and incomplete metadata fail safe
 * (refuse/flag, never auto-repair on ambiguity).
 */
import { parseFilename } from './parser-adapter.js';

export const STOPWORDS = new Set(['the', 'of', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 's']);

/** Significant tokens: lowercase alnum, len>=3, no stopwords. */
export function significantTokens(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Usable as an unsupervised reference only when substantial: 2+
 * significant tokens, or 8+ significant chars. Single short tokens
 * ("Mogul", "Up") are too ambiguous for background decisions.
 */
export function isSubstantialTitle(title) {
  const toks = significantTokens(title);
  if (toks.length >= 2) return true;
  return toks.join('').length >= 8;
}

/** Parsed release title (filename first — the accurate identity source). */
export function parsedReleaseTitle(release) {
  let parsed = null;
  try {
    parsed = parseFilename(release?.filename ?? release?.title ?? '')?.parsed ?? null;
  } catch { /* unparseable */ }
  return {
    title: parsed?.title ?? release?.title ?? release?.filename ?? '',
    year: parsed?.year ?? release?.year ?? null,
    season: parsed?.season ?? release?.season ?? null,
    episode: parsed?.episode ?? release?.episode ?? null,
  };
}

/**
 * Title agreement: 2+ shared significant tokens, or shared coverage of
 * 60%+ of the reference's significant chars (covers single distinctive
 * words like "Severance"), or show-root agreement (the FIRST significant
 * token matches — packs/collections like "The Sopranos Complete" match
 * "The Sopranos" even when the full token bags diverge). First-token
 * only (not first-two): generic second words like "show"/"movie" must
 * not fuse unrelated titles. All three are required to FAIL before a
 * mismatch is declared.
 */
export function titleAgrees(reference, release) {
  const rel = parsedReleaseTitle(release);
  const refToks = new Set(significantTokens(reference));
  if (refToks.size === 0) return false;
  const relToks = significantTokens(rel.title);
  const refChars = [...refToks].join('').length;
  let shared = 0;
  let sharedChars = 0;
  for (const t of new Set(relToks)) {
    if (refToks.has(t)) {
      shared += 1;
      sharedChars += t.length;
    }
  }
  if (shared >= 2) return true;
  if (refChars > 0 && sharedChars / refChars >= 0.6) return true;
  const refRoot = [...refToks][0];
  const relRoot = [...new Set(relToks)][0];
  return refRoot != null && refRoot === relRoot;
}

/** Exact season/episode agreement (null-safe: unknown never agrees). */
export function episodeAgrees(release, season, episode) {
  const rel = parsedReleaseTitle(release);
  if (season == null || episode == null) return false;
  return rel.season === season && rel.episode === episode;
}

/** Year agreement within festival tolerance (±1); unknown never agrees. */
export function yearAgrees(release, year) {
  const rel = parsedReleaseTitle(release);
  if (rel.year == null || year == null) return false;
  return Math.abs(rel.year - year) <= 1;
}

/**
 * Reference title for a media identity, most-authoritative first:
 *  1. a published/bound TorrentFile for the same media (any episode) —
 *     household-verified truth; immune to association pollution and
 *     garbage metadata resolutions. Internal paths are basenamed first:
 *     parsers expect filenames, and a raw path parses to garbage that
 *     poisons agreement math in both directions.
 *  2. consensus of already-associated candidate titles, when substantial.
 *  3. the resolved title, when substantial.
 *  4. null (refuse — never guess blind).
 */
export function referenceTitleForMedia({ mediaId, title = null } = {}, cache, controlPlaneStore) {
  try {
    const items = controlPlaneStore?.listAllLibraryItems?.({ limit: 500 }) ?? [];
    for (const it of items) {
      if ((it.mediaId ?? it.media_id) !== mediaId) continue;
      const isEp = (it.season ?? it.episode) != null;
      const handoff = isEp
        ? cache?.getTvPlaybackHandoff?.(mediaId, it.season, it.episode)
        : cache?.getPlaybackHandoffByMediaId?.(mediaId);
      const tfId = handoff?.torrentFileId ?? null;
      if (!tfId) continue;
      const tf = controlPlaneStore?.getTorrentFile?.(tfId);
      const internal = tf?.internalPath ?? tf?.internal_path ?? null;
      if (!internal) continue;
      const base = String(internal).split('/').pop() || internal;
      let parsedTitle = null;
      try {
        parsedTitle = parseFilename(base)?.parsed?.title ?? null;
      } catch { /* unparseable */ }
      if (isSubstantialTitle(parsedTitle)) return parsedTitle;
    }
  } catch { /* fall through */ }
  try {
    const rows = cache?.db?.prepare(`
      SELECT DISTINCT c.title FROM candidates c
      JOIN candidate_media m ON m.info_hash = c.info_hash
      WHERE m.media_id = ? AND c.title IS NOT NULL LIMIT 20`).all(mediaId) ?? [];
    const consensus = rows.map((r) => r.title).join(' ');
    if (isSubstantialTitle(consensus)) return consensus;
  } catch { /* fall through to resolved title */ }
  if (isSubstantialTitle(title)) return title;
  return null;
}
