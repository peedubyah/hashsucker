/**
 * Pure Ranking Module
 *
 * Computes composite ranking scores from evidence inputs.
 * This module is pure — it does NOT:
 * - Call external APIs
 * - Know about specific providers (TorBox, RD, Torrentio, etc.)
 * - Mutate any storage
 * - Perform I/O
 *
 * Inputs are plain values; outputs are plain values.
 */

import { parseEpisodeRange } from './episode-coverage.js';
import { detectTheatricalSource } from './quality-features.js';

/**
 * Normalize a title for comparison.
 * Lowercases, folds diacritics to ASCII (Amélie → amelie), removes
 * punctuation, collapses whitespace. Folding is canonicalization, not
 * fuzz: it never equates two distinct ASCII titles.
 */
function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stopwords excluded from title overlap scoring. Without this filter, the
 * 60%-overlap heuristic is dominated by common English articles/prepositions
 * ("the", "of") and accepts unrelated shows whenever both titles share them
 * — e.g. "House of the Dragon" and "The Lord of the Rings: The Fellowship of
 * the Ring" share 6 stopwords and would otherwise pass as the same show.
 */
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'is', 'it', 'as', 'be', 'this', 'that', 's',
]);

function meaningfulTokens(title) {
  return title.split(' ').filter(Boolean).filter(t => !TITLE_STOPWORDS.has(t));
}

/**
 * Classify a parsed title (or filename fallback) as low-information parser junk.
 *
 * A parsed title is low-information when it carries no usable identity
 * evidence for comparison: pure stopword residue, a leftover Season/Episode
 * label, or a tokenless punctuation/digit string. Real foreign-language
 * titles (Cyrillic, CJK, etc.) carry non-Latin letters and are NEVER
 * classified as low-information — this helper is intentionally narrow
 * and only flags known parser failure shapes.
 *
 * When parsedTitle is null (parser failed to extract a title), filename is
 * checked as a fallback so the gate can still catch rows like bare "Season 02"
 * that the parser left with title=NULL and filename="Season 02".
 *
 * @param {string|null} parsedTitle - The parsed title (may be null)
 * @param {string} [filename] - Raw filename fallback when parsedTitle is null
 * @returns {boolean} True if the evidence is parser junk
 */
function isLowInformationParsedTitle(parsedTitle, filename = null) {
  // Check parsed title first
  if (parsedTitle != null) {
    if (isLowInformationTitleValue(parsedTitle)) return true;
  }

  // Fallback: when the parser failed to extract a title, the raw filename
  // may still expose the failure shape (e.g. "Season 02" bare filename).
  if (filename != null && isLowInformationTitleValue(filename)) return true;

  return false;
}

/**
 * Core low-information classification for a single string value.
 * @param {string} value
 * @returns {boolean}
 */
function isLowInformationTitleValue(value) {
  // Raw pattern: leftover Season/Episode label that the stripper missed
  // (e.g. filenames like "Season 02" with no extension or title prefix).
  // Localized season words (Sezon/Saison/Temporada/Stagione) count: a bare
  // residue label in any of them is equally title-less.
  if (/^(?:season|sezon|saison|temporada|stagione)\s*\d+(\s*[-~]\s*\d+)?$/i.test(value)) return true;
  if (/^episode\s*\d+(\s*[-~]\s*\d+)?$/i.test(value)) return true;

  const normalized = normalizeTitle(value);
  if (!normalized) return false;

  // Any non-Latin letter (Cyrillic, CJK, Greek, Arabic, etc.) is real
  // title content — not parser junk. We classify "Покаяние" as credible
  // even though titlesMatch returns null for it (no comparable tokens).
  if (/[^\u0000-\u007f]/.test(value)) return false;

  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 0) return false;

  // All-stopword residue: e.g. parser stripped the real title and only
  // left "The", "Of", "A" — no token carries meaning.
  if (tokens.every(t => TITLE_STOPWORDS.has(t))) return true;

  return false;
}

/**
 * Check if parsed title matches the requested media title.
 * Returns:
 *   true  - titles match (same show)
 *   false - titles clearly differ (different show)
 *   null  - insufficient data to determine (missing title)
 *
 * Token-boundary contract (identity-correctness slice):
 * - Comparison is on whole meaningful tokens, never character substrings.
 *   "Up" does not match "Upscale"; "Mogul" does not match "Moguls".
 * - A superstring parsed title only matches when every extra meaningful
 *   token is benign (a 4-digit release year). "Myth and Mogul",
 *   "Mogul Money", and "The Making of a Mogul" are NOT "Mogul".
 * - Single-meaningful-token requests are exact: the parsed meaningful
 *   token set must equal the requested set modulo benign extras. There is
 *   no 60%-overlap gradient for one token (any shared token would be
 *   100% and accept every superstring).
 * - Multi-token requests keep the 60% meaningful-token overlap rule for
 *   parser-damaged titles; movie sequels sharing 2/3 tokens are still
 *   separated by the year gate, series by the S/E gate.
 */
export function titlesMatch(requestedTitle, parsedTitle) {
  // Sequel-number expressions ("Chapter 4", "Part 2") denote the same
  // film as the bare number ("John Wick 4" IS "John Wick Chapter 4"), so
  // fold them before comparison on BOTH sides. Digit forms only — word
  // numbers ("Part Two") are canonical title words and stay intact. The
  // bare digit remains and is still judged by the benign-extra rule, so
  // "Dune 2" is not "Dune": the fold can only equate expressions that
  // already agree on the number.
  const foldSequelNumber = (s) => String(s || '').replace(/\b(chapter|part)\s+(\d{1,2})\b/gi, '$2');
  const r = foldSequelNumber(normalizeTitle(requestedTitle));
  const p = foldSequelNumber(normalizeTitle(parsedTitle));

  if (!r || !p) return null;

  // Exact match always wins.
  if (r === p) return true;

  // Requested title has no meaningful tokens (e.g. "Up", "It", "Her",
  // all-stopword titles). Token overlap is meaningless here, and
  // substring containment is dangerous — "up" is a substring of
  // "stargate collection upscale ai" and would falsely accept unrelated
  // entries. Return null (insufficient evidence to filter) so the gate
  // does not reject legitimate short-title corpus entries (e.g. "Up
  // 2009" for an "Up" request). For short-title requests, live results
  // from the media-scoped live-discovery path are the authoritative
  // source and will rank correctly above noise.
  // Leading release-grammar strip (P2P prefix naming): some releases
  // put source/resolution tags FIRST ("REMUX.2160p.Barbie.2023").
  // A leading parsed token is dropped only when it is closed-class
  // release grammar AND absent from the wanted title — so "Web Therapy"
  // keeps its "Web" (wanted word) while "REMUX 2160p Barbie" reduces to
  // the title. Stripping only removes disagreement; acceptance still
  // requires the wanted tokens to be present in what remains
  // (fail-closed by construction). The wanted side is never stripped:
  // wanted titles are authoritative, never grammar.
  const stripLeadingGrammar = (toks, wantedSet) => {
    let i = 0;
    while (i < toks.length && LEADING_GRAMMAR.has(toks[i]) && !wantedSet.has(toks[i])) i++;
    return toks.slice(i);
  };
  const rTokensRaw = meaningfulTokens(r);
  if (rTokensRaw.length === 0) return null;
  const pTokensRaw = meaningfulTokens(p);
  if (pTokensRaw.length === 0) {
    // Parsed side carries no comparable token. When the raw strings
    // differ this is indeterminate, not confirming — the caller decides
    // via low-information handling. (Exact equality already returned.)
    return null;
  }

  // Strip leading release grammar from the parsed side only (see above).
  const rTokens = rTokensRaw;
  const pMeaningful = stripLeadingGrammar(pTokensRaw, new Set(rTokensRaw));

  // Token-subset rule: every requested meaningful token present in the
  // parsed set matches only when the parsed side adds nothing
  // meaningful of its own (benign extras: release years, S/E coordinate
  // residue). Otherwise the titles clearly differ — return false, not
  // null, so the gate rejects.
  //
  // NOTE: no leetspeak/stylization folding here (Se7en ≠ Seven at this
  // layer). Stylized spellings match only through explicit alias evidence
  // (matchWantedTitle with accepted aliases from metadata), never through
  // a global fuzzy map whose blast radius cannot be bounded.
  const pSet = new Set(pMeaningful);
  if (rTokens.every((t) => pSet.has(t))) {
    return tokenSetsAgree(rTokens, pMeaningful) ? true : false;
  }

  // Multi-token overlap (parser-damage tolerance). Single-token requests
  // never reach here with a shared token: a shared single token means the
  // subset rule above already decided. So any overlap-based accept below
  // implies at least two requested tokens.
  if (rTokens.length >= 2) {
    const overlap = rTokens.filter((t) => pSet.has(t)).length;
    if (overlap / rTokens.length >= 0.6) return true;
  }
  return false;
}

/** True when the extra tokens beyond `requested` are all benign. */
function tokenSetsAgree(requestedTokens, parsedTokens) {
  const wanted = new Set(requestedTokens);
  const parsedSet = new Set(parsedTokens);
  // Audio companion: detached channel digits ("5 1", "2 0", "7 1") are
  // mastering residue ONLY beside an explicit audio codec word in the
  // same title. Without one, a bare digit is a sequel marker and rejects.
  const hasAudioContext = [...parsedSet].some((t) => AUDIO_CODECS.has(t));
  return parsedTokens.every((t) => {
    if (wanted.has(t) || isBenignExtraToken(t)) return true;
    if (hasAudioContext && /^\d{1,2}$/.test(t) && Number(t) <= 12) return true;
    return false;
  });
}

/**
 * Third-party alteration markers: phrases that assert the content is a
 * DERIVATION, not the canonical film/episode — fanedits, fan recuts,
 * "honest trailer" parodies, commentary tracks, redubs. Matched as
 * phrases on the raw filename (dots/dashes/spaces equivalent), never as
 * single words: "cut" alone stays benign (official Director's/Final
 * Cuts are legitimate representations), only the altering compounds
 * reject.
 */
const ALTERED_CONTENT_PATTERNS = [
  /fan[\s._-]*edit/i,
  /re[\s._-]*cut/i,
  /rogue[\s._-]*cut/i,
  /alternative[\s._-]*cut/i,
  /honest[\s._-]*trailer/i,
  /rifftrax/i,
  /\bcommentary\b/i,
  /\bredub/i,
];

export function hasAlteredContentMarker(filename) {
  const v = String(filename || '');
  if (!v) return false;
  return ALTERED_CONTENT_PATTERNS.some((re) => re.test(v));
}

/**
 * Benign title extras: tokens that carry no series/movie identity of their
 * own.
 *
 * - Release years (judged by the year gate for movies) and
 *   season/episode-shaped tokens (judged by the S/E gate for TV) are
 *   structural, not identity — e.g. parser residue "MobLand S01" is the
 *   same show with coordinate text appended.
 * - Pack words (complete, collection, trilogy, saga, anthology, duology)
 *   describe a container holding the wanted title's content, not a
 *   different title. Downstream exactness gates make this safe: a TV pack
 *   still resolves its episode file via PATH B, and a movie pack with
 *   more than one playable file fails PATH B cardinality. "The Godfather
 *   trilogy" IS Godfather content; "Myth and Mogul" is not Mogul content
 *   ("myth" is identity, not a container word).
 *
 * Bare numbers are NOT benign ("Dune 2" is not "Dune"). Codec, audio,
 * language, source, and group residue is NOT benign either — it is
 * handled structurally (series/movie filename-portion isolation), never
 * via a stoplist whose blast radius cannot be bounded.
 */
function isBenignExtraToken(token) {
  if (/^\d{4}$/.test(token)) {
    const y = Number(token);
    return y >= 1900 && y <= 2100;
  }
  // Bare resolution heights ("2160" without the "p", "1080" P2P residue):
  // pure technical residue, never story. Sequel numbers are 1–2 digits
  // and stay non-benign; 4-digit years are handled above.
  if (RESOLUTION_HEIGHTS.has(token)) return true;
  if (/^s\d{1,2}$/i.test(token)
    || /^e\d{1,3}$/i.test(token)
    || /^s\d{1,2}e\d{1,3}$/i.test(token)
    || /^\d{1,2}x\d{1,3}$/i.test(token)) return true;
  if (PACK_WORDS.has(token)) return true;
  if (AUDIO_CODECS.has(token)) return true;
  if (BIT_DEPTHS.has(token)) return true;
  // Edition/format words describe a cut or mastering of the SAME story,
  // never a different story: "The Shining EXTENDED" is The Shining, and
  // the identity model treats a different cut as a different
  // representation, not different media. Commentary, documentary, and
  // tribute words are deliberately absent (Rifftrax is not the film).
  return EDITION_WORDS.has(token);
}

/** Closed-class container words: the torrent holds the wanted title. */
const PACK_WORDS = new Set([
  'complete', 'collection', 'trilogy', 'saga', 'anthology', 'duology',
]);

/**
 * Leading release-grammar words (P2P prefix naming): source, resolution,
 * and codec tags that some releases put FIRST ("REMUX.2160p.Barbie.2023").
 * Only ever stripped from the parsed side, and only when absent from the
 * wanted title (so "Web Therapy" keeps its "Web"). Closed-class and
 * positional — group names ("fsi"), languages, and story words are not
 * here and still reject.
 */
const LEADING_GRAMMAR = new Set([
  '2160p', '1080p', '720p', '480p', '360p', '4k', '8k', 'uhd',
  'bluray', 'bdrip', 'brrip', 'webdl', 'webrip', 'web', 'hdtv', 'hddvd',
  'dvd', 'remux', 'internal', 'repack', 'proper', 'rerip',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx',
  'hdr', 'dv', 'hd', 'sd',
]);

/**
 * Edition/format words: same story, different cut or mastering. Each of
 * these modifies the wanted title without denoting different media.
 * Anything story-bearing (director names, "rifftrax", languages beyond
 * the STRUCTURAL service list) stays non-benign and rejects.
 */
const EDITION_WORDS = new Set([
  'extended', 'unrated', 'uncut', 'theatrical', 'remastered', 'ultimate',
  'directors', 'criterion', 'collectors', 'imax', '3d', 'cut', 'edition',
  // "Final" only ever benign as a cut-phrase word ("Final Cut" =
  // official alternate cut, same story). Known residual: single-token
  // wanted "Girls" would accept "The Final Girls" when years are
  // unknown — accepted because cut-phrase rows ("Blade Runner: The Final
  // Cut", "Apocalypse Now Final Cut") are same-story representations
  // users legitimately bind, while no observed wrong-media pair turns
  // on this word. The movie year gate mitigates when years are known.
  'final',
]);

/**
 * Bare technical residue. Bit depths ("10bit"), resolution heights
 * without "p" ("2160" P2P residue), and audio codec words ("atmos",
 * "dts") describe mastering, never story — no film is distinguished
 * from another by these tokens alone. Sequel numbers stay non-benign
 * ("Dune 2" is not "Dune"); detached channel digits ("5 1") are benign
 * only beside an explicit audio codec word (see tokenSetsAgree's
 * companion rule), because a bare digit is otherwise a sequel marker.
 */
const RESOLUTION_HEIGHTS = new Set(['480', '720', '1080', '1440', '2160', '4320']);
const BIT_DEPTHS = new Set(['8bit', '10bit', '12bit']);
const AUDIO_CODECS = new Set([
  'ma', 'dts', 'ac3', 'ddp', 'atmos', 'truehd', 'flac', 'aac', 'eac3', 'hdma',
]);

function wantedTitleList(wanted) {
  const titles = [];
  if (wanted && typeof wanted.title === 'string' && wanted.title.trim()) titles.push(wanted.title.trim());
  const aliases = Array.isArray(wanted?.aliases) ? wanted.aliases : [];
  for (const a of aliases) {
    if (typeof a === 'string' && a.trim()) titles.push(a.trim());
  }
  return titles;
}

/**
 * Match a parsed title against a wanted identity: the canonical title
 * plus any accepted aliases (original title, localized titles, explicit
 * aliases — including intentional stylizations such as Se7en ↔ Seven or
 * M3GAN ↔ Megan when the metadata source asserts them). Returns true
 * when ANY comparable alias matches, false only when at least one alias
 * is comparable and ALL comparable aliases contradict, null when nothing
 * is comparable.
 */
export function matchWantedTitle(wanted, parsedTitle) {
  const titles = wantedTitleList(wanted);
  if (titles.length === 0) return null;
  let sawComparable = false;
  for (const t of titles) {
    const r = titlesMatch(t, parsedTitle);
    if (r === true) return true;
    if (r === false) sawComparable = true;
  }
  // Affixed bilingual rendering ("Quei Bravi Ragazzi Goodfellas"): a
  // known title anchors one end and the entire remainder is known-title
  // words or benign extras. Fires only after every whole-title comparison
  // failed, so it adds bilingual accepts and nothing else.
  if (matchAffixTitle(titles, parsedTitle) != null) return true;
  return sawComparable ? false : null;
}

/**
 * Bilingual "Foreign - English" construction ("Via col vento - Gone with
 * the Wind", "Testimone d'accusa-Witness for the Prosecution").
 *
 * Both halves must be KNOWN strings: every dash-separated segment is
 * either an exact canonical/alias match (modulo benign extras) or a
 * token-subset of a known title, and at least one segment matches
 * exactly. A commentary/brand prefix ("Rifftrax- The Matrix") fails
 * because the brand half is unknown — the rule can only confirm
 * bilingual renderings of asserted titles, never bless new words.
 * Returns { result: true } on accept, { result: false } on a shaped but
 * unaccounted construction, { result: null } when there is no bilingual
 * shape (fewer than two segments) so the whole-title verdict stands.
 */
export function matchBilingualSegments(wantedTitles, rawPortion) {
  const titles = (Array.isArray(wantedTitles) ? wantedTitles : [wantedTitles])
    .filter((t) => typeof t === 'string' && t.trim());
  if (titles.length === 0) return { result: null, matchedAlias: null };
  const segs = String(rawPortion || '').split(/\s*-\s*/)
    .map((s) => s.replace(/[.\s_]+/g, ' ').trim())
    .filter(Boolean);
  if (segs.length < 2) return { result: null, matchedAlias: null };
  let sawExact = false;
  let exactAlias = null;
  for (const seg of segs) {
    let exact = false;
    let exactTitle = null;
    let subset = false;
    for (const t of titles) {
      const r = titlesMatch(t, seg);
      if (r === true) { exact = true; exactTitle = t; break; }
      const wt = new Set(meaningfulTokens(normalizeTitle(t)));
      const st = meaningfulTokens(normalizeTitle(seg));
      if (st.length > 0 && wt.size > 0 && st.every((tok) => wt.has(tok))) subset = true;
    }
    if (!exact && !subset) return { result: false, matchedAlias: null };
    if (exact) {
      sawExact = true;
      if (exactTitle !== titles[0]) exactAlias = exactTitle;
    }
  }
  return sawExact
    ? { result: true, matchedAlias: exactAlias }
    : { result: false, matchedAlias: null };
}

/**
 * Affixed known-title construction ("Quei Bravi Ragazzi Goodfellas",
 * "C'era una Volta in America Once Upon a Time in America" without a
 * dash, "Ritorno al Futuro Back to the Future").
 *
 * A KNOWN title (canonical or alias) anchors one end of the token
 * sequence; acceptance requires the ENTIRE remainder to be known-title
 * words or benign extras. "Quei Bravi Ragazzi | Goodfellas" accepts
 * (alias + canonical); "Rifftrax | The Matrix" rejects (brand unknown);
 * "Myth and | Mogul" rejects ("myth" unknown); "Mogul | Money" rejects.
 * The rule only fires when the whole-title comparison already failed,
 * so it strictly adds bilingual accepts, never new fuzzy ones.
 * Returns the anchoring known title on accept, null when it has no
 * opinion (caller keeps the whole-title verdict).
 */
export function matchAffixTitle(wantedTitles, parsedTitle) {
  const titles = (Array.isArray(wantedTitles) ? wantedTitles : [wantedTitles])
    .filter((t) => typeof t === 'string' && t.trim());
  const pt = meaningfulTokens(normalizeTitle(parsedTitle));
  if (titles.length === 0 || pt.length === 0) return null;
  const known = titles
    .map((t) => ({ title: t, tokens: meaningfulTokens(normalizeTitle(t)) }))
    .filter((k) => k.tokens.length > 0);
  if (known.length === 0) return null;
  const knownTokens = new Set(known.flatMap((k) => k.tokens));
  const startsWith = (seq, sub) => seq.length > sub.length
    && sub.every((t, i) => seq[i] === t);
  const endsWith = (seq, sub) => seq.length > sub.length
    && sub.every((t, i) => seq[seq.length - sub.length + i] === t);
  for (const k of known) {
    if (startsWith(pt, k.tokens) || endsWith(pt, k.tokens)) {
      const rest = startsWith(pt, k.tokens)
        ? pt.slice(k.tokens.length)
        : pt.slice(0, pt.length - k.tokens.length);
      if (rest.length > 0 && rest.every((t) => knownTokens.has(t) || isBenignExtraToken(t))) return k.title;
    }
  }
  return null;
}

/**
 * Match a structurally isolated filename portion against a wanted
 * identity. Tries the whole cleaned portion first; on contradiction,
 * tries the bilingual construction on the raw portion. Returns
 * { result: true|false|null, matchedAlias: string|null }.
 */
export function matchWantedPortion(wanted, rawSeriesPortion, rawMoviePortion, fallbackTitle) {
  const titles = wantedTitleList(wanted);
  if (titles.length === 0) return { result: null, matchedAlias: null };
  const raws = [rawSeriesPortion, rawMoviePortion].filter(Boolean);
  const cleaned = raws.map(cleanReleasePortion).filter(Boolean);
  // The fallback is raw parser output (residue-laden when no filename
  // portion was computable). Cleaning it with the same rules is
  // consistent — and fail-closed by construction, exactly like portions.
  const target = cleaned.length > 0 ? cleaned[0] : (cleanReleasePortion(fallbackTitle) || fallbackTitle);
  let sawComparable = false;
  let matchedAlias = null;
  for (const t of titles) {
    const r = titlesMatch(t, target);
    if (r === true) {
      return { result: true, matchedAlias: t === titles[0] ? null : t, bilingual: false };
    }
    if (r === false) sawComparable = true;
  }
  if (raws.length > 0) {
    const b = matchBilingualSegments(titles, raws[0]);
    if (b.result === true) return { result: true, matchedAlias: b.matchedAlias, bilingual: true };
  }
  // Space-joined bilingual rendering ("Quei Bravi Ragazzi Goodfellas"):
  // same both-known rule as the dashed form, without requiring a dash.
  const affixAnchor = matchAffixTitle(titles, target);
  if (affixAnchor != null) {
    return { result: true, matchedAlias: affixAnchor === titles[0] ? null : affixAnchor, bilingual: true };
  }
  return { result: sawComparable ? false : null, matchedAlias, bilingual: false };
}

/**
 * Identity Eligibility Evaluation
 *
 * Determines whether a candidate is eligible for ranking given a specific
 * media request with optional season/episode constraints.
 *
 * Eligibility Rules:
 * - Movie requests: no season/episode constraint → always eligible
 * - Series requests with season+episode: parsed season/episode must match
 * - Series requests without episode constraints: eligible if no parsed episode
 *   OR parsed season matches query (or no season constraint)
 *
 * This is a pre-ranking gate. Ineligible candidates are NOT removed from results
 * — they are reclassified to "Ineligible" tier for diagnostics but cannot rank
 * above valid episode matches.
 *
 * @param {Object} hit - Candidate to evaluate
 * @param {Object} queryIntent - Query intent with optional season/episode
 * @param {number} [queryIntent.season] - Requested season
 * @param {number} [queryIntent.episode] - Requested episode
 * @param {string} [queryIntent.mediaType] - 'movie' or 'series'
 * @returns {{ eligible: boolean, reason: string|null, code: string|null }}
 */
/**
 * Filename season-token helpers for the Prowlarr scope guard (ranker V2
 * fix 7). Dumb token scans over the release name — not a parser (no
 * title/year/group extraction). Extension and trailing -GROUP suffix are
 * stripped by callers before invoking. Seasons extract numerically so
 * S01, S1, S01E01, "Season 1" and 1x02 forms all compare correctly.
 */
/**
 * Season words recognized in filename scans, beyond scene-English.
 * Observed in this corpus on real localized releases (counts in the
 * thousands for temporada/saison, hundreds for sezon/stagione):
 * Polish "Sezon", French "Saison", Spanish "Temporada", Italian
 * "Stagione". Gate-side inference only (read-only token scan) — the
 * parser's stored attributes are untouched.
 */
const SEASON_WORDS = 'season|sezon|saison|temporada|stagione';

function filenameSeasons(bare) {
  const norm = String(bare || '').replace(/[.\s_-]+/g, ' ');
  const found = new Set();
  let m;
  const reS = /\bS(\d{1,2})(?![0-9])/gi;
  while ((m = reS.exec(norm)) !== null) found.add(Number(m[1]));
  const reWord = new RegExp(`\\b(?:${SEASON_WORDS})\\s*(\\d{1,2})\\b`, 'gi');
  while ((m = reWord.exec(norm)) !== null) found.add(Number(m[1]));
  const reX = /\b(\d{1,2})x\d{1,3}\b/gi;
  while ((m = reX.exec(norm)) !== null) found.add(Number(m[1]));
  found.delete(0);
  return found;
}

function seasonTokenPresent(bare, season) {
  return filenameSeasons(bare).has(Number(season));
}

/** Strip container extension + trailing -GROUP tag (same as the Prowlarr guard). */
function stripContainerAndGroup(bare) {
  return String(bare || '')
    .replace(/\.(mkv|mp4|avi|mov|m4v|mpg|mpeg|wmv|flv|webm|ts|iso|img|torrent)$/i, '')
    .replace(/-[A-Za-z0-9]{1,12}$/, '');
}

/**
 * Series-title portion of a release filename: text before the first
 * season/episode token whose numbers agree with the parsed coordinates.
 *
 * Scene convention puts the series title first
 * (Series.SxxExx.EpisodeTitle), so anything after the S/E token may be
 * an EPISODE title that must never satisfy a SERIES-title comparison
 * ("Making of a Mogul" is not "Mogul"). A bare season token (S01 with no
 * episode, as in season packs "Show.S01.MULTi") also terminates the
 * portion: everything after it is pack grammar, never series identity.
 * Returns null when uncomputable (no agreeing token, or empty prefix);
 * callers fall back to the full parsed title so this never introduces
 * new false negatives.
 */
export function seriesTitleBeforeEpisodeToken(filename, parsedSeason, parsedEpisode) {
  const bare = stripContainerAndGroup(filename);
  if (!bare) return null;
  const cands = [];
  const push = (idx, s, e) => { if (idx >= 0) cands.push({ idx, s, e }); };
  let m;
  const reSE = /\bS(\d{1,2})E(\d{1,3})(?![0-9])/gi;
  while ((m = reSE.exec(bare)) !== null) push(m.index, Number(m[1]), Number(m[2]));
  const reX = /\b(\d{1,2})x(\d{1,3})\b/gi;
  while ((m = reX.exec(bare)) !== null) push(m.index, Number(m[1]), Number(m[2]));
  const reBareS = /\bS(\d{1,2})(?![0-9])/gi;
  while ((m = reBareS.exec(bare)) !== null) push(m.index, Number(m[1]), null);
  const reS = new RegExp(`\\b(?:${SEASON_WORDS})[.\\s_]*(\\d{1,2})\\b`, 'gi');
  while ((m = reS.exec(bare)) !== null) {
    const me = /\bepisode[.\s_]*(\d{1,3})\b/i.exec(bare.slice(m.index));
    push(m.index, Number(m[1]), me ? Number(me[1]) : null);
  }
  cands.sort((a, b) => a.idx - b.idx);
  for (const c of cands) {
    if (parsedSeason != null && c.s !== parsedSeason) continue;
    if (parsedEpisode != null && c.e != null && c.e !== parsedEpisode) continue;
    const prefix = bare.slice(0, c.idx).replace(/[.\s_\-[\]()]+$/g, '').trim();
    if (!prefix) return null;
    return prefix;
  }
  return null;
}

/**
 * Movie-title portion of a release filename: text before the year token
 * matching the known year (parsed or requested).
 *
 * Scene convention puts the movie title first (Title.Year.Rest), so
 * anything after the year token is release grammar — codec, audio,
 * source, edition, language tags — that must never participate in a
 * title comparison ("Oppenheimer 10bit 6CH" is "Oppenheimer", and "The
 * Matrix MULTI VFI 7 1" is "The Matrix"). This is the movie parallel of
 * seriesTitleBeforeEpisodeToken: structural isolation instead of a
 * residue stoplist, so unbounded group/edition coinages cannot leak
 * into identity. Returns null when uncomputable (no agreeing year
 * token, or empty prefix); callers fall back to the full parsed title
 * so this never introduces new false negatives.
 */
export function movieTitleBeforeYearToken(filename, year) {
  const y = Number(year);
  if (!Number.isSafeInteger(y) || y < 1900 || y > 2100) return null;
  const bare = stripContainerAndGroup(filename);
  if (!bare) return null;
  const m = new RegExp(`\\b${y}\\b`).exec(bare);
  if (!m) return null;
  const prefix = bare.slice(0, m.index).replace(/[.\s_\-[\]()]+$/g, '').trim();
  if (!prefix) return null;
  return prefix;
}

/** Lowest explicit non-query season token, or null when none contradicts. */
function extractOtherSeasonToken(bare, querySeason) {
  const found = filenameSeasons(bare);
  found.delete(Number(querySeason));
  if (found.size === 0) return null;
  return Math.min(...found);
}

/**
 * Clean a structurally isolated title portion for comparison.
 *
 * The portion helpers cut at the S/E or year token, but the prefix itself
 * can carry machine tags that are never title words:
 * - indexer domain wrappers: "www.UIndex.org - Gladiator", "COMANDO.TO -
 *   Ted Lasso". Domain-shaped (dot + TLD) with whitespace around the dash
 *   — never a content word ("Rifftrax- The Matrix" has no dot and no
 *   pre-dash space, so commentary brands survive as comparable words).
 * - leading tag groups: "[DK2] The Dark Knight". Stripped only when a
 *   non-empty remainder survives, so a title that IS "[REC]" is kept.
 * - source-ID assertions and tag groups anywhere: "{tmdb-634649}",
 *   "[IMAX]", "(2020)". Consumed separately as corroboration evidence,
 *   never as title words.
 *
 * Cleaning only ever removes tokens, and acceptance requires the wanted
 * tokens to be present in what remains — so cleaning is fail-closed by
 * construction (it can only turn acceptance into rejection, never the
 * reverse, except by removing tag disagreement).
 */
export function cleanReleasePortion(portion) {
  let v = String(portion || '');
  v = v.replace(/^\s*([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\s+-\s+/, '');
  const noLead = v.replace(/^\s*(\[[^\[\]]*\]\s*)+/, '');
  if (noLead.trim()) v = noLead;
  v = v.replace(/\{[^{}]*\}/g, ' ');
  v = v.replace(/\[[^\[\]]*\]/g, ' ');
  v = v.replace(/\([^()]*\)/g, ' ');
  // Fracture-fallback: year-splits and truncated stored filenames can
  // leave an unbalanced opener ("...(Coogler" with the closer lost past
  // the cut). Balanced title parens never reach this rule (consumed
  // above), so a dangling opener-to-end is fracture, not title — drop it.
  // ("(500) Days of Summer" stays intact: its parens are balanced.)
  //
  // NOTE: no trailing-domain stripping here. A generic dot-word-dot-TLD
  // rule cannot tell release-group domains ("...2160.pctfenix.com") from
  // title words ("Despicable.Me", "The.Net", "WALL.E"). Group/site tags
  // live post-year (excluded by portion isolation) or stay rejecting in
  // the no-year fallback — fail closed, documented residual.
  v = v.replace(/\s*[\(\[][^()\[\]]*$/, ' ');
  return v.replace(/[.\s_\-]+/g, ' ').trim() || null;
}

export function evaluateIdentityEligibility(hit, queryIntent = {}) {
  const { season: querySeason, episode: queryEpisode, mediaType, mediaTitle: requestedMediaTitle, year: requestedYear } = queryIntent;
  // Accepted aliases for the wanted identity (original title, localized
  // titles, explicit aliases). Any comparable alias may satisfy the title
  // check; contradiction requires every comparable alias to fail.
  const wantedAliases = Array.isArray(queryIntent.mediaTitleAliases)
    ? queryIntent.mediaTitleAliases.filter((a) => typeof a === 'string' && a.trim())
    : [];
  const releaseAttributes = hit.releaseAttributes || {};
  const parsedSeason = releaseAttributes.season ?? null;
  const parsedEpisode = releaseAttributes.episode ?? null;
  const episodeRange = releaseAttributes.episodeRange ?? null;
  const seasonOnly = releaseAttributes.seasonOnly ?? false;
  const parsedMediaType = releaseAttributes.mediaType || null;
  const parsedTitle = releaseAttributes.title || null;
  const parsedYear = releaseAttributes.year ?? null;
  const filename = releaseAttributes.filename || hit.filename || null;

  // Filename-derived season: the parser does not extract bare SNN season
  // tokens ("Show.S01.MULTi" stores season NULL), so a season pack can
  // look season-less to the gate. A single unambiguous season token in
  // the filename fills in ONLY when the parser left season null, and
  // multi-season filenames stay ambiguous (no inference). This is
  // pack-shape evidence, never contradiction on its own: the S/E gate
  // below still judges coordinate agreement.
  let effSeason = parsedSeason;
  if (effSeason == null && filename) {
    try {
      const found = filenameSeasons(stripContainerAndGroup(filename));
      if (found.size === 1) effSeason = [...found][0];
    } catch {
      // Filename season scan must never break the gate.
    }
  }

  // Altered-content markers (wrong-content slice): third-party
  // derivations that must never present as the canonical film — fanedits,
  // fan recuts, "honest trailer" parodies, commentary tracks, redubs.
  // Scanned on the FULL filename (not the isolated portion): alteration
  // markers live in exactly the same post-year position as benign
  // residue, so portion isolation would blind the title comparison to
  // them ("...1977.READNFO.ALTERNATIVE.CUT..." must not pass as ANH).
  // First-party edition words ("Director's Cut", "Extended", "Criterion")
  // are deliberately absent: those are legitimate different
  // representations of the same media, and EDITION_WORDS already covers
  // the benign forms. Fires only on phrase markers, never single words.
  // Title-independent: a fanedit is never the canonical answer.
  if (hasAlteredContentMarker(filename)) {
    return {
      eligible: false,
      reason: `altered_content: filename carries a third-party alteration marker (${String(filename || '').slice(0, 80)})`,
      code: 'altered_content',
    };
  }

  // Title cross-check: if requested title and parsed title both exist,
  // reject candidates from a clearly different show. Runs for BOTH movies
  // and series — it is the only meaningful identity signal for movies
  // (which have no season/episode constraints to fall back on).
  // Title cross-check: if requested title and parsed title both exist,
  // reject candidates from a clearly different show. Runs for BOTH movies
  // and series — it is the only meaningful identity signal for movies
  // (which have no season/episode constraints to fall back on).
  // The wanted identity is the canonical title plus accepted aliases; a
  // candidate matching ANY of them passes, and only a candidate
  // contradicting ALL comparable aliases is rejected.
  if (requestedMediaTitle || wantedAliases.length > 0) {
    if (parsedTitle) {
      // Compare against the structurally isolated title portion when
      // computable, falling back to the full parsed title otherwise.
      //
      // TV: the series-title portion before the matching S/E token — the
      // parsed title routinely embeds the episode title after the S/E
      // token, and an episode-title token must never satisfy a series
      // comparison.
      //
      // Movies: the title portion before the known year token — everything
      // after the year is release grammar (codec, audio, source, edition,
      // language tags), never identity. This is why the fallback stays
      // strict: residue is handled structurally, not via a stoplist whose
      // blast radius cannot be bounded.
      //
      // Either isolation only adds rejections, never new acceptances
      // (fallback is the previous behavior).
      const tvShaped = querySeason != null || queryEpisode != null || effSeason != null || parsedEpisode != null;
      const seriesPortion = tvShaped ? seriesTitleBeforeEpisodeToken(filename, effSeason, parsedEpisode) : null;
      const moviePortion = !tvShaped
        ? movieTitleBeforeYearToken(filename, parsedYear ?? requestedYear)
        : null;
      const titleResult = matchWantedPortion(
        { title: requestedMediaTitle, aliases: wantedAliases },
        seriesPortion, moviePortion, parsedTitle,
      );
      if (titleResult.result === false) {
        return {
          eligible: false,
          reason: `title_mismatch: parsed title "${parsedTitle}" matches neither the requested title nor any accepted alias`,
          code: 'title_mismatch',
        };
      }

      // Low-information parsed title (parser junk such as leftover "The",
      // "Season 02", or tokenless punctuation) cannot establish identity.
      // Reject so the candidate cannot rank above verified results. This
      // deliberately runs ONLY when a mediaTitle is requested and a parsed
      // title exists — it does not affect unfiltered or series queries.
      if (titleResult.result === null && isLowInformationParsedTitle(parsedTitle)) {
        return {
          eligible: false,
          reason: `low_information_parsed_title: parsed title "${parsedTitle}" is parser residue with no comparable title evidence`,
          code: 'low_information_parsed_title',
        };
      }
    } else {
      // No parsed title at all (parser failed to extract one). If the
      // raw filename itself is parser residue (e.g. "Season 02" bare
      // filename with no extension and no real title text), the candidate
      // cannot establish identity either. Use filename as the fallback
      // evidence for the low-information check.
      if (isLowInformationParsedTitle(null, filename)) {
        return {
          eligible: false,
          reason: `low_information_parsed_title: filename "${filename || ''}" is parser residue with no comparable title evidence`,
          code: 'low_information_parsed_title',
        };
      }
    }
  }

  // Movies: no episode constraints possible.
  if (mediaType === 'movie' || !querySeason) {
    // Year disambiguation (ranker V2 fix 4, movies only): remakes share
    // titles, so a confidently-known conflicting year is an identity
    // mismatch, not a relevance penalty. Missing/unknown years on either
    // side never reject; absurd values are treated as unknown. TV is
    // excluded: series span years and season identity already gates.
    if (mediaType === 'movie' && requestedYear != null && parsedYear != null) {
      const req = Number(requestedYear);
      const got = Number(parsedYear);
      const sane = (y) => Number.isSafeInteger(y) && y >= 1900 && y <= 2100;
      if (sane(req) && sane(got) && req !== got) {
        return {
          eligible: false,
          reason: `year_mismatch: parsed year ${got} but requested ${req}`,
          code: 'year_mismatch',
        };
      }
    }
    return { eligible: true, reason: null, code: null };
  }

  // Series with specific season+episode requested
  if (querySeason != null && queryEpisode != null) {
    // A parser classification of movie is not episode evidence — UNLESS
    // the filename itself carries TV structure agreeing with the query.
    // The parser labels bare-SNN season packs as movie (no E-token to
    // key on); a filename S/E token that agrees with the query defeats
    // that classification. seriesTitleBeforeEpisodeToken succeeding means
    // exactly such an agreeing token exists. Do not allow a title-index
    // movie association to become the bindable winner for an exact TV
    // episode request.
    const tvProbeShaped = effSeason != null || parsedEpisode != null;
    const seriesProbe = tvProbeShaped
      ? seriesTitleBeforeEpisodeToken(filename, effSeason, parsedEpisode)
      : null;
    if (parsedMediaType === 'movie' && seriesProbe == null) {
      return {
        eligible: false,
        reason: 'media_type_mismatch: movie candidate for episode request',
        code: 'media_type_mismatch',
      };
    }
    // Prowlarr scope guard (ranker V2 fix 7): Prowlarr season/episode
    // query hints are unenforced by indexers (observed live: majority
    // wrong-S/E responses, plus ~40% with no parseable S/E at all).
    // Two cheap filename rules for Prowlarr-sourced rows on exact-episode
    // queries — never positional inference, only contradiction and
    // evidence-presence:
    //  1. season contradiction: an explicit S<NN>/Season <NN>/<NN>x<EE>
    //     token for a season other than the query (with no query-season
    //     token present) rejects. Multi-season packs containing the query
    //     season pass; wrong-season packs fail closed correctly.
    //  2. anonymous rows: no parseable S/E, not pack-shaped (parser flags
    //     or COMPLETE keyword), and no query-season token either — zero
    //     episode evidence from an unenforced source — rejects. Torrentio
    //     and other scoped sources keep scope trust (not prowlarr-origin).
    // Pack-shaped rows stay eligible (PATH B resolves the episode file);
    // binding still fails closed when the file is absent.
    const hitSources = hit.sources || [];
    const prowlarrSourced = hitSources.some((s) => s && s.origin === 'prowlarr');
    if (prowlarrSourced) {
      const bare = String(filename || '')
        .replace(/\.(mkv|mp4|avi|mov|m4v|mpg|mpeg|wmv|flv|webm|ts|iso|img|torrent)$/i, '')
        .replace(/-[A-Za-z0-9]{1,12}$/, '');
      const hasQuerySeasonToken = seasonTokenPresent(bare, querySeason);
      const parsedMissing = effSeason == null && parsedEpisode == null && episodeRange == null;
      const packShaped = seasonOnly === true || parsedMediaType === 'season'
        || /complete/i.test(bare);
      const otherSeason = extractOtherSeasonToken(bare, querySeason);
      if (otherSeason != null && !hasQuerySeasonToken) {
        return {
          eligible: false,
          reason: `prowlarr-season-contradiction: filename carries S${String(otherSeason).padStart(2, '0')} but requested S${String(querySeason).padStart(2, '0')}`,
          code: 'prowlarr_season_contradiction',
        };
      }
      if (parsedMissing && !packShaped && !hasQuerySeasonToken) {
        return {
          eligible: false,
          reason: 'prowlarr-episode-unverifiable: no parseable S/E, not pack-shaped, no query-season token',
          code: 'prowlarr_episode_unverifiable',
        };
      }
    }
    // Wrong season → ineligible. effSeason is the parser season, or the
    // single unambiguous filename season when the parser left it null
    // (bare-SNN packs). A filename-declared season contradicting the
    // query is proven wrong-season, not missing evidence.
    if (effSeason != null && effSeason !== querySeason) {
      return {
        eligible: false,
        reason: `season_mismatch: parsed S${String(effSeason).padStart(2, '0')} but requested S${String(querySeason).padStart(2, '0')}`,
        code: 'season_mismatch',
      };
    }

    // Wrong episode (single episode, not range)
    if (parsedEpisode != null && episodeRange == null && parsedEpisode !== queryEpisode) {
      return {
        eligible: false,
        reason: `episode_mismatch: parsed E${String(parsedEpisode).padStart(2, '0')} but requested E${String(queryEpisode).padStart(2, '0')}`,
        code: 'episode_mismatch',
      };
    }

    // Season-only pack for different season → ineligible
    if (seasonOnly === true && parsedMediaType === 'season' && effSeason != null && effSeason !== querySeason) {
      return {
        eligible: false,
        reason: `season_pack_mismatch: parsed season pack S${String(effSeason).padStart(2, '0')} but requested S${String(querySeason).padStart(2, '0')}`,
        code: 'season_pack_mismatch',
      };
    }

    return { eligible: true, reason: null, code: null };
  }

  // Series with season-only constraint (no episode)
  if (querySeason != null && queryEpisode == null) {
    if (effSeason != null && effSeason !== querySeason) {
      return {
        eligible: false,
        reason: `season_mismatch: parsed S${String(effSeason).padStart(2, '0')} but requested S${String(querySeason).padStart(2, '0')}`,
        code: 'season_mismatch',
      };
    }
    return { eligible: true, reason: null, code: null };
  }

  // No constraints at all → eligible
  return { eligible: true, reason: null, code: null };
}

/**
 * Ranking Contract:
 *   score = relevance × 0.25
 *         + quality × 0.20
 *         + releaseConfidence × 0.20
 *         + identityConfidence × 0.15
 *         + providerAvailability × 0.10
 *         + episodeMatch × 0.10
 *
 * All components are normalized to [0.0, 1.0].
 */

// Quality tiers for resolution
const RESOLUTION_QUALITY = {
  // 8K/16K are the top of the ladder. They were missing, so a correctly
  // parsed 4320p release scored ZERO for the resolution component (40% of the
  // quality score) and a 480p release outranked it. The score is capped at
  // 1.0, so 4320p and 2160p both saturate the resolution term — the
  // difference between them is not one this score is allowed to express.
  '8640p': 1.0,
  '4320p': 1.0,
  '2160p': 1.0,
  '1080p': 0.9,
  '720p': 0.7,
  '480p': 0.4,
  '360p': 0.2,
};

// Quality tiers for source type
const SOURCE_QUALITY = {
  'Remux': 1.0,
  'BluRay': 0.95,
  'WEB-DL': 0.85,
  'WEBRip': 0.75,
  'HDTV': 0.6,
  'DSRip': 0.5,
  'DVD': 0.4,
  // Theatrical captures (ranker V2 fix 3): negative contribution so a
  // high-resolution CAM can never outrank legitimate home-quality (or
  // even unknown-but-plausible) releases on resolution alone. This is a
  // ranking penalty, not an eligibility ban: explicit human requests may
  // still bind CAM when nothing else is fulfillable.
  'cam': -0.5,
};

/**
 * Canonicalize a source-class token to the SOURCE_QUALITY vocabulary
 * (ranker V2 fix 1 companion). Live discovery emits SCREAMING-CASE
 * classes ('REMUX', 'WEB-DL') while corpus rows carry parser-normalized
 * case ('Remux', 'BluRay'); scoring must not depend on which upstream
 * produced the token. Case folding only — no new source classes.
 */
function canonicalSourceQualityKey(src) {
  if (src == null) return null;
  const t = String(src).trim().toLowerCase().replace(/[\s._-]+/g, '');
  if (t === 'cam') return 'cam';
  if (t === 'remux') return 'Remux';
  if (t === 'bluray' || t === 'bdrip' || t === 'brrip') return 'BluRay';
  if (t === 'webdl' || t === 'web') return 'WEB-DL';
  if (t === 'webrip') return 'WEBRip';
  if (t === 'hdtv') return 'HDTV';
  if (t === 'dsrip' || t === 'dsr') return 'DSRip';
  if (t === 'dvd') return 'DVD';
  return null;
}

// Codec bonus (HEVC/x265 preferred for 4K)
const CODEC_BONUS = {
  'x265': 0.1,
  'x264': 0.05,
};

// Weights for composite score
const WEIGHTS = {
  relevance: 0.25,
  quality: 0.20,
  releaseConfidence: 0.20,
  identityConfidence: 0.15,
  providerAvailability: 0.10,
  episodeMatch: 0.10,
};

// Neutral value for unknown/missing data (not a penalty)
const NEUTRAL = 0.5;

/**
 * Compute quality score from release attributes.
 *
 * @param {Object} attrs - Release attributes
 * @param {string} [attrs.resolution] - Resolution (e.g., '1080p')
 * @param {string} [attrs.sourceType] - Source type (e.g., 'BluRay')
 * @param {string} [attrs.codec] - Codec (e.g., 'x264', 'x265')
 * @param {boolean|string} [attrs.hdr] - HDR flag or class
 * @param {string} [attrs.audio] - Audio class
 * @returns {number} 0.0-1.0
 */
export function qualityScore(attrs = {}) {
  let score = 0;

  // Resolution contributes 40%
  const resScore = RESOLUTION_QUALITY[attrs.resolution] || 0;
  score += resScore * 0.4;

  // Source contributes 30%
  const srcScore = SOURCE_QUALITY[canonicalSourceQualityKey(attrs.sourceType)] || 0;
  score += srcScore * 0.3;

  // Codec bonus (up to 10%)
  const codecBonus = CODEC_BONUS[attrs.codec] || 0;
  score += codecBonus;

  // Graded HDR contribution (premium tranche): DV > HDR10+ > HDR10 and
  // generic HDR > HLG > SDR. Bounded so worse-source+DV never beats
  // better-source+HDR10 on HDR alone (max swing 0.125 < source steps).
  score += hdrQualityBonus(attrs.hdr);

  // Bounded audio contribution (premium tranche): lossless-object tiers
  // down to lossy stereo. Max swing 0.025 stays below the smallest
  // resolution step (0.04) and source step (0.03), so audio only ever
  // decides close comparisons — never manufactures premium status.
  score += audioQualityBonus(attrs.audio);

  return Math.min(1.0, score);
}

/**
 * Graded HDR bonus (premium tranche). Inputs arrive in mixed shapes:
 * boolean true, 1, generic strings ('HDR'), or flavor strings
 * ('DV', 'HDR10', 'HDR10+', 'HLG', Dolby Vision variants).
 */
export function hdrQualityBonus(hdr) {
  if (hdr == null || hdr === false || hdr === 0 || hdr === '0') return 0;
  if (hdr === true || hdr === 1 || hdr === '1') return 0.10;
  const t = String(hdr).trim().toLowerCase().replace(/[\s._-]+/g, '');
  if (!t || t === 'false' || t === 'no' || t === 'sdr') return 0;
  if (t.includes('dolbyvision') || t === 'dv' || t === 'dovi') return 0.125;
  if (t === 'hdr10plus' || t === 'hdr10+') return 0.11;
  if (t === 'hdr10' || t === 'hdr') return 0.10;
  if (t === 'hlg') return 0.05;
  return 0;
}

/**
 * Bounded audio bonus (premium tranche). Compound strings
 * ('TrueHD Atmos', 'DDP Atmos 5', 'DTS-HD MA') classify by best tier
 * present. Case-insensitive; unrecognized/missing audio scores 0.
 */
export function audioQualityBonus(audio) {
  if (audio == null) return 0;
  const t = String(audio).trim().toLowerCase().replace(/[\s._-]+/g, '');
  if (!t) return 0;
  const has = (...needles) => needles.some((n) => t.includes(n));
  // Tier A: lossless object (TrueHD Atmos, DTS:X).
  if ((has('truehd') && has('atmos')) || has('dtsx') || has('dts:x')) return 0.025;
  // Tier B: lossless (TrueHD, DTS-HD MA/HDMA, FLAC, PCM).
  if (has('truehd') || has('dtshdma') || has('dtshd') || has('flac') || t === 'pcm') return 0.018;
  // Tier C: lossy object (any Atmos not already classified lossless).
  if (has('atmos')) return 0.012;
  // Tier D: discrete multichannel lossy (DD+/E-AC-3/DD/AC-3).
  if (has('eac3') || has('ddp') || has('ddplus') || has('dd+') || has('ac3') || has('dd')) return 0.006;
  return 0;
}

/**
 * Compute identity confidence from media associations.
 *
 * Semantic: measures confidence that this candidate IS the requested media.
 * Absence of associations means unknown (NEUTRAL), not low confidence.
 *
 * @param {Array<Object>} mediaAssociations - From candidate_media
 * @returns {number} 0.0-1.0 (NEUTRAL if no associations)
 */
export function identityConfidenceScore(mediaAssociations = []) {
  if (mediaAssociations.length === 0) return NEUTRAL;

  // Use the highest confidence association
  const maxConfidence = Math.max(...mediaAssociations.map(a => a.confidence || 0));
  return Math.min(1.0, maxConfidence);
}

/**
 * Compute identity confidence scoped to a specific media ID.
 *
 * For selected-media retrieval, identity confidence must come only from
 * the association to the selected media. Associations to other media
 * are never eligible and must not contribute to confidence.
 *
 * @param {Array<Object>} mediaAssociations - From candidate_media
 * @param {string} mediaId - Selected media ID to scope to
 * @returns {number} 0.0-1.0 (NEUTRAL if no association to this media)
 */
export function identityConfidenceForMedia(mediaAssociations = [], mediaId) {
  if (!mediaId || mediaAssociations.length === 0) return NEUTRAL;

  const forMedia = mediaAssociations.filter(a => a.mediaId === mediaId);
  if (forMedia.length === 0) return NEUTRAL;

  const maxConfidence = Math.max(...forMedia.map(a => a.confidence || 0));
  return Math.min(1.0, maxConfidence);
}

/**
 * Compute identity confidence from live discovery scoping.
 *
 * When live discovery is scoped to a selected media ID, the fact that
 * a live provider returned this candidate for that media IS identity
 * evidence. This is not manufactured — it reflects that the live source
 * already filtered to the requested media.
 *
 * @param {string|null} selectedMediaId - The media ID live discovery was scoped to
 * @param {Array<Object>} mediaAssociations - Existing media associations (if any)
 * @param {string|null} mediaId - The media ID being queried
 * @returns {number} 0.0-1.0
 */
export function identityConfidenceFromLiveScope(selectedMediaId, mediaAssociations = [], mediaId) {
  // If we have explicit associations, use those (higher trust)
  if (mediaAssociations.length > 0) {
    return identityConfidenceForMedia(mediaAssociations, mediaId);
  }

  // If live discovery was scoped to the queried media, that's identity evidence
  // The live provider already filtered to this media — that's meaningful
  if (selectedMediaId && selectedMediaId === mediaId) {
    // Live scope match is weaker than a persisted association
    // but stronger than unknown (NEUTRAL)
    return 0.7; // Moderate confidence from live scoping
  }

  return NEUTRAL;
}

/**
 * Compute provider availability score from observations.
 *
 * Semantic: measures evidence that this candidate is available from providers.
 * Unknown state (no observations) is NEUTRAL, not a penalty.
 *
 * @param {Array<Object>} providerObservations - From provider_observations
 * @returns {number} 0.0-1.0 (NEUTRAL if no observations)
 */
export function providerAvailabilityScore(providerObservations = []) {
  if (providerObservations.length === 0) return NEUTRAL;

  const cached = providerObservations.filter(o => o.cached === true || o.cached === 1);
  const uncached = providerObservations.filter(o => o.cached === false || o.cached === 0);

  // All cached = 1.0, all uncached = 0.0, mixed = proportional
  const total = providerObservations.length;
  if (cached.length === total) return 1.0;
  if (uncached.length === total) return 0.0;
  return cached.length / total;
}

/**
 * Compute provider availability from live discovery evidence.
 *
 * When a live provider returns a candidate, that IS availability evidence.
 * The provider has the file and is offering it. This is not manufactured —
 * it reflects real-time provider state.
 *
 * @param {Array<Object>} providerObservations - Existing provider observations
 * @param {boolean} hasLiveDiscovery - Whether this candidate came from live discovery
 * @param {Object} [liveProviderHints] - Provider hints from live discovery
 * @returns {number} 0.0-1.0
 */
export function providerAvailabilityFromLive(providerObservations = [], hasLiveDiscovery = false, liveProviderHints = null) {
  // If we have explicit observations, use those (higher trust)
  if (providerObservations.length > 0) {
    return providerAvailabilityScore(providerObservations);
  }

  // Live discovery itself is availability evidence
  // The provider returned this candidate — they have it
  if (hasLiveDiscovery) {
    // Check if we have cache hints from live source
    if (liveProviderHints && typeof liveProviderHints === 'object') {
      const hints = Object.values(liveProviderHints);
      const cachedCount = hints.filter(h => h && (h.cached === true || h.cached === 1)).length;
      if (cachedCount > 0) return 0.8; // Provider says it's cached
    }
    // Live discovery without cache hint = moderate availability evidence
    return 0.6;
  }

  return NEUTRAL;
}

/**
 * Compute relevance from identity evidence for live candidates.
 *
 * Semantic: measures how well this candidate matches the query.
 * For corpus: BM25 text relevance (exact title match).
 * For live: identity-derived relevance (scoped to selected media).
 *
 * @param {number} textRelevance - BM25-based relevance (corpus only)
 * @param {string|null} selectedMediaId - Media ID live discovery was scoped to
 * @param {string|null} mediaId - Media ID being queried
 * @returns {number} 0.0-1.0
 */
export function relevanceFromIdentity(textRelevance, selectedMediaId = null, mediaId = null) {
  // If we have text relevance (corpus), use it directly
  if (textRelevance > 0) {
    return textRelevance;
  }

  // For live candidates: if discovery was scoped to the queried media,
  // that's relevance evidence — the candidate IS for the requested media
  if (selectedMediaId && selectedMediaId === mediaId) {
    // Identity-derived relevance: live provider returned this for the requested media
    // This is not as strong as exact text match, but it's meaningful
    return 0.7;
  }

  return NEUTRAL;
}

/**
 * Compute episode match preference among ALREADY-ELIGIBLE candidates.
 *
 * Hard coverage eligibility (wrong season, wrong episode, out-of-range,
 * unknown coverage) is enforced by the episode-coverage gate BEFORE scoring
 * and must not be duplicated here. This function expresses preference tiers
 * among candidates that provably cover the requested episode:
 *
 *   - Exact single-episode match (season+episode)  → 1.0
 *   - Episode range containing the requested E     → 0.8
 *   - Season pack for the requested season         → 0.6
 *
 * When the query has no explicit season/episode intent, returns NEUTRAL.
 *
 * @param {Object} releaseAttrs - Release attributes
 * @param {number} [releaseAttrs.season] - Release season
 * @param {number} [releaseAttrs.episode] - Release episode
 * @param {string} [releaseAttrs.episodeRange] - Release episode range "start-end"
 * @param {boolean} [releaseAttrs.seasonOnly] - Parser-flagged season pack
 * @param {string} [releaseAttrs.mediaType] - Parser media type guess
 * @param {Object} [queryIntent] - Query intent (optional)
 * @param {number} [queryIntent.season] - Query season
 * @param {number} [queryIntent.episode] - Query episode
 * @returns {number} 0.0-1.0
 */
export function episodeMatchScore(releaseAttrs = {}, queryIntent = {}) {
  // Only score if query has explicit season/episode intent
  if (queryIntent.season == null || queryIntent.episode == null) return NEUTRAL;

  const { season, episode, episodeRange, seasonOnly, mediaType } = releaseAttrs;

  // Wrong season — defensive; hard gate should have rejected already.
  if (season == null || season !== queryIntent.season) return 0.0;

  // Exact single-episode match
  if (episode != null && episode === queryIntent.episode) return 1.0;

  // Episode range containing requested episode
  if (episodeRange != null) {
    const range = parseEpisodeRange(episodeRange);
    if (range && queryIntent.episode >= range.start && queryIntent.episode <= range.end) {
      return 0.8;
    }
    // Malformed or non-covering range — defensive low score
    return 0.0;
  }

  // Season pack for correct season
  if (seasonOnly === true || mediaType === 'season') return 0.6;

  // Correct season but no episode/range/pack evidence — unknown coverage
  return 0.0;
}

/**
 * Identity eligibility diagnostic — measures identity match for corpus candidates
 * without filtering or changing ranking behavior.
 *
 * Pure function: reads hit evidence, returns diagnostic snapshot.
 * Does NOT modify the candidate or ranking outcome.
 *
 * @param {Object} hit - Corpus candidate entering ranking
 * @param {string} hit.hash - InfoHash
 * @param {number|null} hit.fileIndex - File index
 * @param {string} hit.filename - Release filename
 * @param {string} [hit.releaseKey] - Pre-computed release key
 * @param {Object} [hit.releaseAttributes] - Parsed release attributes
 * @param {Array<Object>} [hit.mediaAssociations] - Media associations (candidate_media rows)
 * @param {Array<Object>} [hit.sources] - Provenance sources
 * @param {string|null} [hit.selectedMediaId] - Selected media intent provenance
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {number} [queryIntent.season] - Query season
 * @param {number} [queryIntent.episode] - Query episode
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {IdentityDiagnostic|null} Diagnostic snapshot, or null for non-corpus
 */
export function diagnoseIdentityEligibility(hit, queryIntent = {}, mediaId = null) {
  const releaseAttributes = hit.releaseAttributes || {};
  const mediaAssociations = hit.mediaAssociations || [];
  const sources = hit.sources || [];
  const isCorpus = sources.some(s => s.origin === 'corpus');

  // Only corpus candidates have persisted identity to diagnose
  if (!isCorpus) {
    return null;
  }

  const parsedTitle = releaseAttributes.title || null;
  const parsedSeason = releaseAttributes.season ?? null;
  const parsedEpisode = releaseAttributes.episode ?? null;
  const targetMediaId = mediaId || hit.selectedMediaId || null;

  let identityMatch = false;
  let rejectionReason = null;

  if (targetMediaId && mediaAssociations.length > 0) {
    const forMedia = mediaAssociations.filter(a => a.mediaId === targetMediaId);
    identityMatch = forMedia.length > 0;

    if (!identityMatch) {
      const associatedIds = [...new Set(mediaAssociations.map(a => a.mediaId))];
      rejectionReason = `identity_mismatch: associated with [${associatedIds.join(', ')}] but queried ${targetMediaId}`;
    }
  } else if (targetMediaId && mediaAssociations.length === 0) {
    rejectionReason = 'no_identity_evidence: no candidate_media rows';
  } else if (!targetMediaId) {
    rejectionReason = 'no_target_media_id: query not scoped to specific media';
  }

  let seasonEpisodeMatch = null;
  if (queryIntent.season != null && queryIntent.episode != null) {
    if (parsedSeason == null) {
      seasonEpisodeMatch = 'unknown_season';
    } else if (parsedSeason !== queryIntent.season) {
      seasonEpisodeMatch = `wrong_season: parsed=${parsedSeason}, query=${queryIntent.season}`;
    } else if (parsedEpisode != null && parsedEpisode !== queryIntent.episode) {
      seasonEpisodeMatch = `wrong_episode: parsed=${parsedEpisode}, query=${queryIntent.episode}`;
    } else {
      seasonEpisodeMatch = 'match';
    }
  }

  return {
    releaseKey: hit.releaseKey || null,
    filename: hit.filename || null,
    identityMatch,
    parsedTitle,
    parsedSeason,
    parsedEpisode,
    targetMediaId,
    rejectionReason,
    seasonEpisodeMatch,
  };
}

/**
 * Aggregate identity eligibility counts for a batch of corpus candidates.
 *
 * Pure function: calls diagnoseIdentityEligibility for each candidate,
 * returns aggregate counts. Does NOT modify any candidate or ranking.
 *
 * @param {Array<Object>} hits - Corpus candidates entering ranking
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {IdentityEligibilityCounts} Aggregate counts
 */
export function countIdentityEligibility(hits, queryIntent = {}, mediaId = null) {
  const diagnostics = hits
    .map(h => diagnoseIdentityEligibility(h, queryIntent, mediaId))
    .filter(d => d !== null);

  const total = diagnostics.length;
  const identityMatched = diagnostics.filter(d => d.identityMatch).length;
  const identityRejected = diagnostics.filter(d => !d.identityMatch && d.rejectionReason).length;
  const textOnlyMatches = diagnostics.filter(d => d.rejectionReason && d.rejectionReason.includes('no_identity_evidence')).length;
  const seasonEpisodeFailures = diagnostics.filter(d => d.seasonEpisodeMatch && d.seasonEpisodeMatch !== 'match').length;

  return {
    corpusRetrieved: total,
    identityMatched,
    identityRejected,
    textOnlyMatches,
    seasonEpisodeFailures,
    ranked: total,
  };
}

/**
 * Identity tier classification — categorizes a candidate's identity match quality.
 *
 * Pure function: reads hit evidence, returns tier classification.
 * Does NOT modify the candidate or ranking outcome.
 *
 * Tiers (in precedence order):
 * - Verified: explicit candidate_media match, confirmed filename/parser identity,
 *             or season/episode confirmation where applicable
 * - ProviderConfirmed: live mediaId scope AND strong identity evidence from filename/parser
 * - Probable: strong corpus/title metadata match
 * - ProviderScoped: live mediaId scope only, no independent identity evidence
 * - TextOnly: retrieved only because of search text similarity
 * - Rejected: identity mismatch or no target media ID
 *
 * @param {Object} hit - Candidate entering ranking
 * @param {string} hit.hash - InfoHash
 * @param {number|null} hit.fileIndex - File index
 * @param {string} hit.filename - Release filename
 * @param {number} [hit.relevance] - Title relevance from search (0.0-1.0)
 * @param {Object} [hit.releaseAttributes] - Parsed release attributes
 * @param {Array<Object>} [hit.mediaAssociations] - Media associations (candidate_media rows)
 * @param {Array<Object>} [hit.sources] - Provenance sources
 * @param {string|null} [hit.selectedMediaId] - Selected media intent provenance
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {number} [queryIntent.season] - Query season
 * @param {number} [queryIntent.episode] - Query episode
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {{IdentityTier: string, IdentityConfidence: number, IdentityEvidence: string[], RejectionReason: string|null}}
 */
export function classifyIdentityTier(hit, queryIntent = {}, mediaId = null) {
  const releaseAttributes = hit.releaseAttributes || {};
  const mediaAssociations = hit.mediaAssociations || [];
  const sources = hit.sources || [];
  const isCorpus = sources.some(s => s.origin === 'corpus');
  const isLive = sources.some(s => s.origin === 'live');

  const parsedTitle = releaseAttributes.title || null;
  const parsedSeason = releaseAttributes.season ?? null;
  const parsedEpisode = releaseAttributes.episode ?? null;
  const parsedYear = releaseAttributes.year ?? null;
  const targetMediaId = mediaId || hit.selectedMediaId || null;
  const textRelevance = hit.relevance || 0;

  // Wanted-title link: canonical title plus accepted aliases (original
  // title, localized titles, explicit aliases). Any comparable alias may
  // satisfy; contradiction requires every comparable alias to fail.
  // Bilingual "Foreign - English" constructions are handled through the
  // raw portion (see matchWantedPortion). Returns
  // { result: true|false|null, matchedAlias: string|null }.
  const wantedAliases = Array.isArray(queryIntent?.mediaTitleAliases)
    ? queryIntent.mediaTitleAliases.filter((a) => typeof a === 'string' && a.trim())
    : [];
  const wantedCount = (queryIntent?.mediaTitle ? 1 : 0) + wantedAliases.length;
  const wantedForLink = { title: queryIntent?.mediaTitle ?? null, aliases: wantedAliases };
  const wantedLink = (rawSeries, rawMovie, fallbackTitle) =>
    matchWantedPortion(wantedForLink, rawSeries, rawMovie, fallbackTitle);

  // Helper: check if filename/parser provides strong identity evidence
  // Used to distinguish ProviderConfirmed from ProviderScoped for live candidates
  // and to strengthen Verified tier for corpus candidates.
  //
  // IMPORTANT: relevance score is NOT a title match signal. For live candidates
  // relevance is hardcoded and does not reflect actual title similarity.
  // Must use actual title comparison when mediaTitle is available.
  //
  // Series-title isolation applies here exactly as in the eligibility gate:
  // the comparison runs against the title portion before the matching S/E
  // token so an episode-title suffix can never satisfy a series comparison.
  // Movies use the title portion before the known year token for the same
  // reason (post-year release grammar is never identity).
  // Source-provided IDs (e.g. Prowlarr imdbId corroboration) strengthen but
  // never substitute: an explicit source-ID agreement is strong evidence,
  // an explicit disagreement caps the tier at ProviderScoped, and neither
  // overrides a contradictory title or file coordinate.
  const sourceIdsOf = (h) => h.sourceIds || h.releaseAttributes?.sourceIds || null;
  const hasStrongIdentityEvidence = (h, intent) => {
    const attrs = h.releaseAttributes || {};
    const title = attrs.title || null;
    const season = attrs.season ?? null;
    const episode = attrs.episode ?? null;

    // Title comparison: only positive if titles actually match.
    // Returns null if we can't determine (missing title) — not evidence either way.
    const tvShaped = (intent?.season ?? null) != null || (intent?.episode ?? null) != null
      || season != null || episode != null;
    const filename = h.filename || attrs.filename || null;
    const seriesPortion = tvShaped ? seriesTitleBeforeEpisodeToken(filename, season, episode) : null;
    const moviePortion = !tvShaped
      ? movieTitleBeforeYearToken(filename, attrs.year ?? intent?.year ?? null)
      : null;
    // Alias-aware link: the canonical title or any accepted alias may
    // satisfy, including bilingual "Foreign - English" constructions.
    const link = matchWantedPortion(
      { title: intent?.mediaTitle ?? null, aliases: Array.isArray(intent?.mediaTitleAliases) ? intent.mediaTitleAliases : [] },
      seriesPortion, moviePortion, title,
    );
    const hasStrongTitle = link.result === true;

    // Parsed season/episode matching query intent
    const querySeason = intent?.season ?? null;
    const queryEpisode = intent?.episode ?? null;
    const hasMatchingSeason = querySeason != null && season === querySeason;
    const hasMatchingEpisode = queryEpisode != null && episode === queryEpisode;
    const hasMatchingSeasonEpisode = hasMatchingSeason && hasMatchingEpisode;

    // Strong identity evidence: either strong title match or matching season/episode
    return hasStrongTitle || hasMatchingSeasonEpisode;
  };

  // Live candidates: tier based on provider scope + independent identity evidence
  // Provider scope is NOT equivalent to confirmed identity.
  //
  // Source-provided IDs (Prowlarr imdbId) are source claims requiring
  // validation, not authoritative identity: agreement strengthens,
  // disagreement caps at ProviderScoped (never Confirmed on S/E alone),
  // and neither overrides a contradictory title or file coordinate (those
  // are enforced by the eligibility gate before selection).
  if (isLive && !isCorpus) {
    if (hit.selectedMediaId && hit.selectedMediaId === mediaId) {
      const claimed = sourceIdsOf(hit);
      const claimedImdb = claimed && (claimed.imdbId || claimed.imdb)
        ? String(claimed.imdbId || claimed.imdb).toLowerCase()
        : null;
      const target = targetMediaId ? String(targetMediaId).toLowerCase() : null;
      const idAgrees = claimedImdb && target ? claimedImdb === target : null;
      // Provider returned this candidate scoped to the requested mediaId
      // Check for independent identity evidence to distinguish ProviderConfirmed vs ProviderScoped
      const strong = hasStrongIdentityEvidence(hit, queryIntent);
      const idEvidence = idAgrees === true ? ['source-id-corroborated']
        : idAgrees === false ? ['source-id-mismatch'] : [];
      if (strong && idAgrees !== false) {
        return {
          IdentityTier: 'ProviderConfirmed',
          IdentityConfidence: idAgrees === true ? 0.85 : 0.8,
          IdentityEvidence: ['provider-scoped-to-media', 'strong-identity-evidence', ...idEvidence],
          RejectionReason: null,
        };
      }
      return {
        IdentityTier: 'ProviderScoped',
        IdentityConfidence: 0.4,
        IdentityEvidence: ['provider-scoped-to-media', ...idEvidence],
        RejectionReason: null,
      };
    }
    return {
      IdentityTier: 'Probable',
      IdentityConfidence: 0.5,
      IdentityEvidence: ['live-discovery'],
      RejectionReason: null,
    };
  }

  // Corpus candidates require a target media ID to classify
  if (!targetMediaId) {
    return {
      IdentityTier: 'Rejected',
      IdentityConfidence: 0.0,
      IdentityEvidence: [],
      RejectionReason: 'no_target_media_id: query not scoped to specific media',
    };
  }

  // Check for strong identity evidence from filename/parser (used for Verified tier)
  const strongIdentityEvidence = hasStrongIdentityEvidence(hit, queryIntent);

  // Pre-compute the canonical title link once, here, so both the
  // association branch (Verified guard) and the no-association branch
  // share one definition. Pure and side-effect-free.
  // (wantedAliases / wantedCount are already declared in the wanted-title
  // link block above; reuse them — do not redeclare.)
  const tvShapedForLink = queryIntent.season != null || queryIntent.episode != null
    || parsedSeason != null || parsedEpisode != null;
  const seriesPortionForLink = tvShapedForLink
    ? seriesTitleBeforeEpisodeToken(hit.filename || null, parsedSeason, parsedEpisode)
    : null;
  const moviePortionForLink = !tvShapedForLink
    ? movieTitleBeforeYearToken(hit.filename || null, parsedYear ?? queryIntent.year ?? null)
    : null;
  const canonicalTitleLink = wantedLink(seriesPortionForLink, moviePortionForLink, parsedTitle).result;

  // Alias-only authorization guard uses this in the association branch
  // below; defined here so TDZ is impossible.

  // Check explicit media association
  let explicitMatch = false;
  let identityMismatch = false;
  let associatedIds = [];

  if (mediaAssociations.length > 0) {
    const forMedia = mediaAssociations.filter(a => a.mediaId === targetMediaId);
    explicitMatch = forMedia.length > 0;
    if (!explicitMatch) {
      identityMismatch = true;
      associatedIds = [...new Set(mediaAssociations.map(a => a.mediaId))];
    }
  }

  // Season/episode match evaluation
  let seasonEpisodeMatch = null;
  if (queryIntent.season != null && queryIntent.episode != null) {
    if (parsedSeason == null) {
      seasonEpisodeMatch = 'unknown_season';
    } else if (parsedSeason !== queryIntent.season) {
      seasonEpisodeMatch = 'wrong_season';
    } else if (parsedEpisode != null && parsedEpisode !== queryIntent.episode) {
      seasonEpisodeMatch = 'wrong_episode';
    } else if (parsedEpisode != null && parsedEpisode === queryIntent.episode) {
      seasonEpisodeMatch = 'match';
    } else {
      seasonEpisodeMatch = 'unknown_episode';
    }
  }

  // Rejected: explicit mismatch
  if (identityMismatch) {
    return {
      IdentityTier: 'Rejected',
      IdentityConfidence: 0.1,
      IdentityEvidence: [`associated-with:${associatedIds.join(',')}`],
      RejectionReason: `identity_mismatch: associated with [${associatedIds.join(', ')}] but queried ${targetMediaId}`,
    };
  }

  // Verified: explicit media association match (confirmed identity).
  //
  // Trust contract (identity-correctness slice, final close): historical
  // association is supporting evidence only — it may retrieve, rank, and
  // increase confidence, but it may NEVER by itself authorize a Binding.
  // It survives only while current independent identity evidence is
  // ALSO present: a verified title/year or S-E match, a structural
  // title link, strong parser identity evidence, or an agreeing
  // source-provided media ID. When none of those exist, the association
  // alone yields TextOnly (identity_unknown / retryable) — never
  // Verified — even though the row is still retained for future
  // evaluation when metadata returns. Association alone is never
  // authoritative identity.
  if (explicitMatch) {
    // Current-title veto: when the caller asserted a wanted identity
    // (canonical title or accepted alias) and the parsed title comparably
    // contradicts ALL of them, the association loses.
    if (wantedCount > 0 && parsedTitle) {
      const tvShapedForVeto = queryIntent.season != null || queryIntent.episode != null
        || parsedSeason != null || parsedEpisode != null;
      const seriesPortionForVeto = tvShapedForVeto
        ? seriesTitleBeforeEpisodeToken(hit.filename || null, parsedSeason, parsedEpisode)
        : null;
      const moviePortionForVeto = !tvShapedForVeto
        ? movieTitleBeforeYearToken(hit.filename || null, parsedYear ?? queryIntent.year ?? null)
        : null;
      const veto = wantedLink(seriesPortionForVeto, moviePortionForVeto, parsedTitle);
      if (veto.result === false) {
        return {
          IdentityTier: 'Rejected',
          IdentityConfidence: 0.1,
          IdentityEvidence: ['media-association-match', 'title-contradiction'],
          RejectionReason: `title_mismatch: parsed title "${parsedTitle}" matches neither the requested title nor any accepted alias despite historical association`,
        };
      }
    }
    // Current-coordinate veto: an association for this media that carries
    // contradictory S/E for an exact-episode query is not this episode.
    if (seasonEpisodeMatch === 'wrong_season' || seasonEpisodeMatch === 'wrong_episode') {
      return {
        IdentityTier: 'Rejected',
        IdentityConfidence: 0.1,
        IdentityEvidence: ['media-association-match', 'coordinate-contradiction'],
        RejectionReason: `coordinate_mismatch: parsed S${String(parsedSeason ?? 0).padStart(2, '0')}E${String(parsedEpisode ?? 0).padStart(2, '0')} but queried S${String(queryIntent.season).padStart(2, '0')}E${String(queryIntent.episode).padStart(2, '0')} despite historical association`,
      };
    }

    // Association-only authorization guard: without current independent
    // identity evidence, an association cannot authorize anything.
    // Strong evidence = verified title/year link, strong parser identity,
    // matching S/E, or an agreeing source-provided media ID. Otherwise
    // the row is retained (TextOnly, identity_unknown/retryable) for
    // future re-evaluation when metadata returns.
    const sourceIds = sourceIdsOf(hit);
    const sourceIdAgrees = !!(sourceIds && targetMediaId
      && String(sourceIds.imdbId || sourceIds.imdb || '').toLowerCase() === String(targetMediaId).toLowerCase());
    const hasIndependentIdentity =
      canonicalTitleLink === true
      || strongIdentityEvidence === true
      || seasonEpisodeMatch === 'match'
      || sourceIdAgrees;
    if (!hasIndependentIdentity) {
      return {
        IdentityTier: 'TextOnly',
        IdentityConfidence: 0.2,
        IdentityEvidence: ['media-association-match', 'association-only-insufficient'],
        RejectionReason: 'association_only_insufficient: historical association without current independent identity evidence',
      };
    }

    const evidence = ['media-association-match'];
    let confidence = 0.9;

    if (seasonEpisodeMatch === 'match') {
      evidence.push('season-episode-match');
      confidence = 1.0;
    } else if (seasonEpisodeMatch === 'unknown_episode') {
      evidence.push('correct-season');
    } else if (seasonEpisodeMatch === 'unknown_season') {
      evidence.push('unknown-season');
      confidence = 0.7;
    }
    // Source-ID corroboration on an associated row strengthens further.
    if (sourceIdAgrees) evidence.push('source-id-corroborated');

    return {
      IdentityTier: 'Verified',
      IdentityConfidence: confidence,
      IdentityEvidence: evidence,
      RejectionReason: null,
    };
  }

  // No explicit media association from here on.
  //
  // Identity evidence priority (corpus branch):
  //   1. Explicit candidate_media row → already classified above (Verified / Rejected)
  //   2. Strong canonical title match (parsed title tokens compare against the
  //      requested canonical title from queryIntent.mediaTitle) → Probable
  //   3. Weak/indeterminate text-only evidence → TextOnly
  //
  // A parsed title that the parser produced but that has NO comparable tokens
  // against the canonical title (matchWantedTitle returns null — e.g. non-Latin
  // characters that normalize to nothing, or a short canonical title with no
  // meaningful tokens) is NOT canonical-identity evidence. It must not be
  // promoted to Probable just because a parse succeeded; that path lets
  // unrelated corpus rows (Покаяние, foreign-language noise, parser junk that
  // happens to be a real non-Latin word) outrank live candidates that are
  // scoped to the canonical IMDb ID.
  const hasParsedMetadata = parsedTitle || parsedSeason != null || parsedEpisode != null;

  // A null link means no comparable tokens on either side (e.g.
  // Cyrillic-only parsed title vs Latin canonical, or short canonical
  // title with no meaningful tokens) — that's indeterminate, not
  // confirming, evidence. wantedCount is computed once near the top of
  // this function (canonical title + accepted aliases).

  // Alias-aware link of the parsed title to the wanted identity. The
  // structurally isolated portion (series portion for TV, pre-year
  // portion for movies) is compared when computable so release grammar
  // can never satisfy or defeat a title comparison here either.
  // Bilingual "Foreign - English" constructions match when both halves
  // are known strings (see matchWantedPortion).
  // Reuse the canonicalTitleLink already computed above (pre-computed
  // block) instead of recomputing — both branches must agree.
  const link = { result: canonicalTitleLink, matchedAlias: null };
  const matchedAlias = link.matchedAlias; // accepted alias that satisfied, if any

  // Identity-convergence demotion: when the caller asserted a wanted
  // identity and the parsed title has no token link to it (Cyrillic vs
  // Latin, or short canonical title with no comparable tokens), demote to
  // TextOnly. This MUST run BEFORE the hasTitleMatch block below — BM25
  // text relevance is corpus-only and may be high (1.0) for the single
  // corpus row that matched a sparse query even when that row is a
  // completely different show (e.g. Cyrillic "Покаяние" matching against
  // an empty query while user requested "The Lord of the Rings").
  if (wantedCount > 0 && canonicalTitleLink === null) {
    return {
      IdentityTier: 'TextOnly',
      IdentityConfidence: 0.2,
      IdentityEvidence: ['text-similarity-only'],
      RejectionReason: 'no_canonical_title_link: parsed title has no comparable tokens to the canonical title',
    };
  }

  // Probable: strong title match but no media association.
  //
  // Trust contract: BM25 text relevance is corpus-retrieval similarity,
  // not identity evidence. When the caller asserted a wanted identity,
  // Probable requires a parsed-title token link to the canonical title
  // or an accepted alias (canonicalTitleLink === true). A high BM25
  // score alone — including the hardcoded relevance 1.0 that
  // association-retrieved corpus rows carry — must never manufacture
  // Probable. Without an asserted wanted identity there is nothing to
  // link against, so the legacy BM25 path is preserved.
  const hasTitleMatch = textRelevance >= 0.6
    && (wantedCount === 0 || canonicalTitleLink === true);
  if (hasTitleMatch) {
    const evidence = ['strong-title-match'];
    let confidence = 0.6;

    if (parsedSeason != null) {
      evidence.push('parsed-season');
      confidence += 0.1;
    }
    if (parsedEpisode != null) {
      evidence.push('parsed-episode');
      confidence += 0.1;
    }

    return {
      IdentityTier: 'Probable',
      IdentityConfidence: Math.min(0.8, confidence),
      IdentityEvidence: evidence,
      RejectionReason: null,
    };
  }

  // Probable: parsed title links back to the wanted identity (canonical
  // title or an accepted alias). This is the path that lets legitimate
  // alternate-language/stylized releases rank as Probable through explicit
  // alias evidence — never through weakened fuzzy containment.
  if (canonicalTitleLink === true) {
    const evidence = ['canonical-title-link'];
    if (matchedAlias) evidence.push(`alias:${matchedAlias.slice(0, 80)}`);
    let confidence = 0.7;

    if (parsedSeason != null) {
      evidence.push('parsed-season');
      confidence += 0.1;
    }
    if (parsedEpisode != null) {
      evidence.push('parsed-episode');
      confidence += 0.1;
    }

    return {
      IdentityTier: 'Probable',
      IdentityConfidence: Math.min(0.8, confidence),
      IdentityEvidence: evidence,
      RejectionReason: null,
    };
  }

  // When the caller asserted a canonical title, the demotion block above
  // (before hasTitleMatch) has already handled canonicalTitleLink === null.
  // By the time we reach this point, canonicalTitle is null OR
  // canonicalTitleLink === true. The remaining paths are:
  //   - hasTitleMatch (BM25-based "strong title match" path)
  //   - canonicalTitleLink === true (parsed title token link to canonical)
  //   - hasParsedMetadata with parsed season/episode (legacy loose fallback)
  //   - final TextOnly default

  // Probable: partial metadata evidence (parser ran, no parsed title, just season/episode)
  // These are corpus rows where the parser succeeded but found no title.
  // This is the legacy loose fallback: only fires when the caller did NOT
  // pass a canonical title (so we can't make a negative identity assertion)
  // AND the hit has parsed season/episode metadata. Preserved for
  // media-association-only TV lookups where the route contract is just
  // (mediaId, season, episode) without mediaTitle.
  if (hasParsedMetadata && !parsedTitle) {
    const evidence = [];
    if (parsedSeason != null) evidence.push('parsed-season');
    if (parsedEpisode != null) evidence.push('parsed-episode');

    return {
      IdentityTier: 'Probable',
      IdentityConfidence: 0.4,
      IdentityEvidence: evidence,
      RejectionReason: null,
    };
  }

  // TextOnly: retrieved only because of search text similarity
  return {
    IdentityTier: 'TextOnly',
    IdentityConfidence: 0.2,
    IdentityEvidence: ['text-similarity-only'],
    RejectionReason: 'no_identity_evidence: no candidate_media rows',
  };
}

/**
 * Evaluate identity tier for all candidates in a batch.
 *
 * Pure function: calls classifyIdentityTier for each candidate,
 * returns per-candidate evaluations. Does NOT modify any candidate or ranking.
 *
 * @param {Array<Object>} hits - Candidates entering ranking
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {Array<{IdentityTier: string, IdentityConfidence: number, IdentityEvidence: string[], RejectionReason: string|null}>}
 */
export function evaluateIdentityTiers(hits, queryIntent = {}, mediaId = null) {
  return hits.map(h => classifyIdentityTier(h, queryIntent, mediaId));
}

/**
 * Detailed identity diagnostic — shows why each candidate received its tier.
 *
 * Pure function: reads candidate evidence, returns diagnostic snapshot.
 * Does NOT modify any candidate or ranking outcome.
 *
 * Exposes evidence sources for understanding tier assignments:
 * - Candidate_media: explicit media associations from corpus
 * - Parsed_filename: title/season/episode parsed from filename
 * - MediaId_scope: whether candidate was scoped to requested mediaId
 * - Title_match: text relevance score
 * - Season_episode_match: season/episode confirmation where applicable
 *
 * @param {Object} hit - Candidate entering ranking
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {{IdentityTier: string, EvidenceSources: {Candidate_media: string[], Parsed_filename: Object, MediaId_scope: {selectedMediaId: string|null, queriedMediaId: string|null, scoped: boolean}, Title_match: {relevance: number, isStrongMatch: boolean}, Season_episode_match: {querySeason: number|null, queryEpisode: number|null, parsedSeason: number|null, parsedEpisode: number|null, matchStatus: string|null}}, ConfidenceSignals: {identityConfidence: number, parserConfidence: number, tierConfidence: number}}}
 */
export function diagnoseIdentityEvidence(hit, queryIntent = {}, mediaId = null) {
  const releaseAttributes = hit.releaseAttributes || {};
  const mediaAssociations = hit.mediaAssociations || [];
  const sources = hit.sources || {};
  const isCorpus = sources.some?.(s => s.origin === 'corpus');
  const isLive = sources.some?.(s => s.origin === 'live');

  // Classify tier
  const tier = classifyIdentityTier(hit, queryIntent, mediaId);

  // Evidence: Candidate_media (explicit media associations)
  const candidateMedia = mediaAssociations.map(a => 
    `${a.mediaId}${a.confidence ? `(${(a.confidence * 100).toFixed(0)}%)` : ''}`
  );

  // Evidence: Parsed_filename
  const parsedFilename = {
    title: releaseAttributes.title || null,
    season: releaseAttributes.season ?? null,
    episode: releaseAttributes.episode ?? null,
    resolution: releaseAttributes.resolution || null,
    sourceType: releaseAttributes.sourceType || null,
  };

  // Evidence: MediaId_scope
  const selectedMediaId = hit.selectedMediaId || null;
  const queriedMediaId = mediaId || null;
  const scoped = !!(selectedMediaId && queriedMediaId && selectedMediaId === queriedMediaId);

  // Evidence: Title_match
  const relevance = hit.relevance || 0;
  const isStrongMatch = relevance >= 0.6;

  // Evidence: Season_episode_match
  const querySeason = queryIntent?.season ?? null;
  const queryEpisode = queryIntent?.episode ?? null;
  const parsedSeason = releaseAttributes.season ?? null;
  const parsedEpisode = releaseAttributes.episode ?? null;

  let matchStatus = null;
  if (querySeason != null && queryEpisode != null) {
    if (parsedSeason == null) {
      matchStatus = 'unknown_season';
    } else if (parsedSeason !== querySeason) {
      matchStatus = 'wrong_season';
    } else if (parsedEpisode != null && parsedEpisode !== queryEpisode) {
      matchStatus = 'wrong_episode';
    } else if (parsedEpisode != null && parsedEpisode === queryEpisode) {
      matchStatus = 'exact_match';
    } else {
      matchStatus = 'season_only';
    }
  }

  // Confidence signals
  const identityConfidence = hit.identityConfidence ?? 0.5;
  const parserConfidence = hit.parserConfidence ?? 0.5;

  // Promotion failure diagnostic: why ProviderScoped failed promotion to ProviderScoped
  let promotionFailure = null;
  if (tier.IdentityTier === 'ProviderScoped') {
    const failures = [];
    if (!isStrongMatch) {
      failures.push(`weak-title-match (relevance=${relevance.toFixed(2)}, need>=0.6)`);
    }
    if (querySeason != null && parsedSeason !== querySeason) {
      failures.push(`season-mismatch (parsed=${parsedSeason}, query=${querySeason})`);
    }
    if (queryEpisode != null && parsedEpisode !== queryEpisode) {
      failures.push(`episode-mismatch (parsed=${parsedEpisode}, query=${queryEpisode})`);
    }
    if (parsedSeason == null && parsedEpisode == null) {
      failures.push('no-season-episode-parsed');
    }
    promotionFailure = {
      reason: 'insufficient-independent-identity-evidence',
      failures,
      recommendation: 'Promote to ProviderConfirmed if filename/parser confirms identity',
    };
  }

  return {
    IdentityTier: tier.IdentityTier,
    EvidenceSources: {
      Candidate_media: candidateMedia,
      Parsed_filename: parsedFilename,
      MediaId_scope: {
        selectedMediaId,
        queriedMediaId,
        scoped,
      },
      Title_match: {
        relevance,
        isStrongMatch,
      },
      Season_episode_match: {
        querySeason,
        queryEpisode,
        parsedSeason,
        parsedEpisode,
        matchStatus,
      },
    },
    ConfidenceSignals: {
      identityConfidence,
      parserConfidence,
      tierConfidence: tier.IdentityConfidence,
    },
    ...(promotionFailure && { promotionFailure }),
  };
}

/**
 * Generate detailed identity diagnostics for top N candidates.
 *
 * Pure function: calls diagnoseIdentityEvidence for each candidate.
 * Does NOT modify any candidate or ranking outcome.
 *
 * @param {Array<Object>} hits - Ranked candidates (output of rankHitsTiered)
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID being queried
 * @param {number} [topN] - Number of top candidates to diagnose (default 50)
 * @returns {Array<{rank: number, releaseKey: string, source: string, score: number, identity: Object}>}
 */
export function diagnoseTopCandidates(hits, queryIntent = {}, mediaId = null, topN = 50) {
  return hits.slice(0, topN).map((hit, i) => {
    const source = hit.sources?.some?.(s => s.origin === 'live') ? 'live' : 'corpus';
    const releaseKey = hit.releaseKey || `${hit.hash}:${hit.fileIndex ?? 'torrent'}`;
    const identity = diagnoseIdentityEvidence(hit, queryIntent, mediaId);

    return {
      rank: i + 1,
      releaseKey,
      source,
      score: hit.score ?? null,
      identity,
    };
  });
}

/**
 * Aggregate identity tier distribution for a batch of candidates.
 *
 * Pure function: calls classifyIdentityTier for each candidate,
 * returns aggregate counts. Does NOT modify any candidate or ranking.
 *
 * @param {Array<Object>} hits - Candidates entering ranking
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID being queried
 * @returns {{CorpusRetrieved: number, LiveRetrieved: number, VerifiedCount: number, ProviderMatchedCount: number, ProbableCount: number, TextOnlyCount: number, RejectedCount: number, SeasonEpisodeFailures: number, IdentityMismatches: number}}
 */
export function aggregateIdentityTiers(hits, queryIntent = {}, mediaId = null) {
  const evaluations = hits.map(h => classifyIdentityTier(h, queryIntent, mediaId));

  const corpusHits = hits.filter(h => {
    const sources = h.sources || [];
    return sources.some(s => s.origin === 'corpus');
  });
  const liveHits = hits.filter(h => {
    const sources = h.sources || [];
    return sources.some(s => s.origin === 'live');
  });

  return {
    CorpusRetrieved: corpusHits.length,
    LiveRetrieved: liveHits.length,
    VerifiedCount: evaluations.filter(e => e.IdentityTier === 'Verified').length,
    ProviderConfirmedCount: evaluations.filter(e => e.IdentityTier === 'ProviderConfirmed').length,
    ProbableCount: evaluations.filter(e => e.IdentityTier === 'Probable').length,
    ProviderScopedCount: evaluations.filter(e => e.IdentityTier === 'ProviderScoped').length,
    TextOnlyCount: evaluations.filter(e => e.IdentityTier === 'TextOnly').length,
    RejectedCount: evaluations.filter(e => e.IdentityTier === 'Rejected').length,
    SeasonEpisodeFailures: evaluations.filter(e =>
      e.IdentityEvidence && e.IdentityEvidence.some(ev =>
        ev.includes('wrong-season') || ev.includes('wrong-episode')
        || ev.includes('coordinate-contradiction')
      )
    ).length,
    IdentityMismatches: evaluations.filter(e =>
      e.RejectionReason && e.RejectionReason.includes('identity_mismatch')
    ).length,
  };
}

/**
 * Shadow ranking comparison — computes hypothetical result sets without
 * modifying the active ranking behavior.
 *
 * Pure function: reads candidates, returns comparison diagnostics.
 * Does NOT modify any candidate or the active ranking outcome.
 *
 * Three modes:
 * 1. Current: all candidates ranked together (the active behavior)
 * 2. VerifiedOnly: only Verified candidates ranked
 * 3. Tiered: Verified → ProviderMatched → Probable (active behavior)
 *
 * @param {Array<Object>} candidates - Eligible candidates (post-dedup, post-eligibility)
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping
 * @param {number} [topN] - Number of top results to compare (default 50)
 * @returns {{CurrentTopSources: string[], VerifiedOnlyTopSources: string[], TieredTopSources: string[], CurrentTopScoreRange: {min: number, max: number}|null, VerifiedOnlyTopScoreRange: {min: number, max: number}|null, CandidatesExcludedByVerifiedFilter: number, CurrentTop10: string[], VerifiedOnlyTop10: string[], TieredTop10: string[]}}
 */
export function shadowRankComparison(candidates, queryIntent = {}, mediaId = null, topN = 50) {
  const evaluations = candidates.map(c => ({
    candidate: c,
    tier: classifyIdentityTier(c, queryIntent, mediaId),
  }));

  // Current: all candidates ranked together
  const currentRanked = rankHits(candidates.map(toRankingInputShadow), queryIntent, mediaId);
  const currentTop = currentRanked.slice(0, topN);

  // VerifiedOnly: only Verified candidates
  const verifiedCandidates = evaluations
    .filter(e => e.tier.IdentityTier === 'Verified')
    .map(e => e.candidate);
  const verifiedOnlyRanked = rankHits(verifiedCandidates.map(toRankingInputShadow), queryIntent, mediaId);
  const verifiedOnlyTop = verifiedOnlyRanked.slice(0, topN);

  // Tiered: Verified → ProviderConfirmed → Probable → ProviderScoped (matches active behavior)
  const providerConfirmedCandidates = evaluations
    .filter(e => e.tier.IdentityTier === 'ProviderConfirmed')
    .map(e => e.candidate);
  const providerScopedCandidates = evaluations
    .filter(e => e.tier.IdentityTier === 'ProviderScoped')
    .map(e => e.candidate);
  const probableCandidates = evaluations
    .filter(e => e.tier.IdentityTier === 'Probable')
    .map(e => e.candidate);
  const tieredRanked = [
    ...verifiedOnlyRanked,
    ...rankHits(providerConfirmedCandidates.map(toRankingInputShadow), queryIntent, mediaId),
    ...rankHits(probableCandidates.map(toRankingInputShadow), queryIntent, mediaId),
    ...rankHits(providerScopedCandidates.map(toRankingInputShadow), queryIntent, mediaId),
  ];
  const tieredTop = tieredRanked.slice(0, topN);

  // Extract source distribution for top N
  const extractSources = (ranked) => {
    const sources = ranked.map(r => {
      const src = r.sources?.find(s => s.origin === 'live') ? 'live' : 'corpus';
      return src;
    });
    const corpusCount = sources.filter(s => s === 'corpus').length;
    const liveCount = sources.filter(s => s === 'live').length;
    return { corpus: corpusCount, live: liveCount };
  };

  // Extract score range for top N
  const scoreRange = (ranked) => {
    if (ranked.length === 0) return null;
    const scores = ranked.map(r => r.score || 0);
    return {
      min: Math.min(...scores),
      max: Math.max(...scores),
    };
  };

  // Extract top 10 releaseKeys
  const top10Keys = (ranked) => ranked.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`);

  return {
    CurrentTopSources: extractSources(currentTop),
    VerifiedOnlyTopSources: extractSources(verifiedOnlyTop),
    TieredTopSources: extractSources(tieredTop),
    CurrentTopScoreRange: scoreRange(currentTop),
    VerifiedOnlyTopScoreRange: scoreRange(verifiedOnlyTop),
    CandidatesExcludedByVerifiedFilter: candidates.length - verifiedCandidates.length,
    CurrentTop10: top10Keys(currentTop),
    VerifiedOnlyTop10: top10Keys(verifiedOnlyTop),
    TieredTop10: top10Keys(tieredTop),
  };
}

/**
 * Convert a canonical candidate to ranking input shape for shadow ranking.
 * Reuses the same transformation as the active pipeline.
 *
 * @param {Object} candidate - Canonical candidate
 * @returns {Object} Ranking input
 */
function toRankingInputShadow(candidate) {
  return {
    hash: candidate.hash,
    fileIndex: candidate.fileIndex ?? null,
    filename: candidate.filename,
    relevance: candidate.relevance ?? 0,
    releaseAttributes: candidate.releaseAttributes || {},
    parserConfidence: candidate.parserConfidence ?? 0.5,
    mediaAssociations: candidate.mediaAssociations || [],
    providerObservations: candidate.providerObservations || [],
    providerEvidence: candidate.providerEvidence || candidate.providerObservations || [],
    sources: candidate.sources || [],
    selectedMediaId: candidate.selectedMediaId ?? null,
    hasLiveDiscovery: candidate.hasLiveDiscovery ?? false,
    liveProviderHints: candidate.liveProviderHints ?? null,
    releaseKey: candidate.releaseKey,
    // Slice 7: exact per-file byte size. Shadow ranking is diagnostic only
    // (no persistence), but threading it keeps the shape consistent.
    selectedFileSize:
      Number.isSafeInteger(candidate.selectedFileSize) && candidate.selectedFileSize > 0
        ? candidate.selectedFileSize
        : null,
  };
}

/**
 * Rank a single search hit.
 *
 * Preserves provenance (sources, selectedMediaId) through the ranking boundary
 * so that merged local/live evidence survives into the final ranked result.
 *
 * Stores the actual (unrounded) weighted contributions so explainRank() can
 * report what determined the score without recomputing from rounded components.
 *
 * @param {Object} hit - Search hit with evidence
 * @param {string} hit.hash - InfoHash
 * @param {number|null} hit.fileIndex - File index
 * @param {string} hit.filename - Release filename
 * @param {number} hit.relevance - Title relevance from search (0.0-1.0)
 * @param {Object} [hit.releaseAttributes] - Parsed release attributes
 * @param {number} [hit.parserConfidence] - Parser confidence (0.0-1.0)
 * @param {Array<Object>} [hit.mediaAssociations] - Media associations
 * @param {Array<Object>} [hit.providerObservations] - Provider observations
 * @param {Array<Object>} [hit.sources] - Provenance sources for evidence
 * @param {string|null} [hit.selectedMediaId] - Selected media intent provenance
 * @param {Object} [queryIntent] - Query intent for episode matching
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping.
 *   When provided, identity confidence uses only the association to this media.
 * @returns {Object} Ranked result with component scores and raw contributions
 */
export function rankHit(hit, queryIntent = {}, mediaId = null) {
  const {
    hash,
    fileIndex = null,
    filename,
    relevance = 0,
    releaseAttributes = {},
    parserConfidence = NEUTRAL,
    mediaAssociations = [],
    providerObservations = [],
    providerEvidence = providerObservations,
    sources = [],
    selectedMediaId = null,
    hasLiveDiscovery = false,
    liveProviderHints = null,
    historicalPrior = 0,
    selectedFileSize = null,
    sourceIds = null,
  } = hit;

  // Compute component scores using semantic confidence functions.
  // Each component measures evidence quality, not data availability.
  // Theatrical-capture floor (ranker V2 fix 3): when no recognized
  // source class is present but the filename carries CAM/TS/TC/SCR
  // tokens, score as cam-class (negative contribution) rather than
  // unknown-zero — otherwise a 1080p CAM outranks a 720p REMUX on
  // resolution alone. Garbage-first: an explicit capture token always
  // wins over an absent/unknown class, but never overrides a recognized
  // home-quality class.
  const releaseAttrs = { ...releaseAttributes };
  if (canonicalSourceQualityKey(releaseAttrs.sourceType) == null
    && canonicalSourceQualityKey(releaseAttrs.source) == null) {
    const theatrical = detectTheatricalSource(filename);
    if (theatrical) releaseAttrs.sourceType = theatrical;
  }
  const quality = qualityScore(releaseAttrs);
  const releaseConfidence = Math.min(1.0, Math.max(0.0, parserConfidence));

  // Relevance: text-based for corpus, identity-derived for live
  // For live candidates scoped to the selected media, the scope itself
  // is relevance evidence (the provider returned it for this media)
  const effectiveRelevance = relevanceFromIdentity(relevance, selectedMediaId, mediaId);

  // Identity confidence: associations for corpus, live scope for live
  // Absence of associations doesn't imply low confidence — it means unknown
  const identityConfidence = mediaId
    ? identityConfidenceFromLiveScope(selectedMediaId, mediaAssociations, mediaId)
    : identityConfidenceScore(mediaAssociations);

  // Provider availability: observations for corpus, live discovery for live
  // A live provider returning a candidate IS availability evidence
  const freshProviderAvailability = providerAvailabilityFromLive(
    providerObservations,
    hasLiveDiscovery,
    liveProviderHints
  );

  // Historical availability prior: a bounded contribution from historical
  // provider evidence that is folded into the `providerAvailability`
  // component ONLY when fresh evidence is absent. This keeps the existing
  // weight structure intact (no new weight added) while allowing history
  // to modestly influence ranking of otherwise-close candidates.
  //
  // Precedence:
  //   - fresh positive → historical prior = 0 (fresh dominates)
  //   - fresh negative → historical prior = 0 (fresh suppresses optimism)
  //   - no fresh evidence → historical prior ∈ [0, maxPrior] (bounded)
  //
  // The historical prior is added to fresh availability, then clamped to
  // [0, 1]. Since fresh availability is already ≥ 0.8 for fresh cached,
  // adding a bounded prior cannot push it over 1.0 in practice — the
  // clamp is a safety net.
  const effectiveProviderAvailability = Math.max(0, Math.min(1,
    freshProviderAvailability + (historicalPrior || 0)
  ));

  const episodeMatch = episodeMatchScore(releaseAttributes, queryIntent);

  // Compute weighted contributions (raw, before rounding) — these are what
  // actually produced the score. Stored so explainRank() doesn't recompute
  // from rounded component values and drift from the true score.
  const contributions = {
    relevance: effectiveRelevance * WEIGHTS.relevance,
    quality: quality * WEIGHTS.quality,
    releaseConfidence: releaseConfidence * WEIGHTS.releaseConfidence,
    identityConfidence: identityConfidence * WEIGHTS.identityConfidence,
    providerAvailability: effectiveProviderAvailability * WEIGHTS.providerAvailability,
    episodeMatch: episodeMatch * WEIGHTS.episodeMatch,
  };

  const score = (
    contributions.relevance +
    contributions.quality +
    contributions.releaseConfidence +
    contributions.identityConfidence +
    contributions.providerAvailability +
    contributions.episodeMatch
  );

  const roundedScore = Math.round(score * 1000) / 1000;

  // Ranking justification — flight recorder for explainability.
  // Does NOT change the score. Exposes the breakdown so operators can
  // understand why a candidate won or lost.
  // Exposes the historical prior in the justification so operators can
  // answer "Candidate received +X because RD had historical evidence".
  const justification = Object.freeze({
    candidate: { hash, fileIndex, releaseKey: hit.releaseKey || `${hash}:${fileIndex ?? 'torrent'}`, filename },
    finalScore: roundedScore,
    scoreBreakdown: Object.freeze({
      cacheScore: Math.round(effectiveProviderAvailability * 1000) / 1000,
      qualityScore: Math.round(quality * 1000) / 1000,
      sourceScore: Math.round(releaseConfidence * 1000) / 1000,
      metadataScore: Math.round(identityConfidence * 1000) / 1000,
      popularityScore: Math.round(effectiveRelevance * 1000) / 1000,
      // Ranker V2 fix 5: episodeMatch contributes 10% but was invisible
      // in persisted/debug explanations. All six components now present.
      episodeMatchScore: Math.round(episodeMatch * 1000) / 1000,
      // Premium tranche: quality sub-inputs so a DV-vs-HDR10 or
      // TrueHD-vs-AAC decision is auditable without recomputation.
      qualityDetails: Object.freeze({
        resolution: releaseAttrs.resolution ?? null,
        source: releaseAttrs.source ?? releaseAttrs.sourceType ?? null,
        codec: releaseAttrs.codec ?? null,
        hdr: releaseAttrs.hdr ?? null,
        audio: releaseAttrs.audio ?? null,
        hdrBonus: hdrQualityBonus(releaseAttrs.hdr),
        audioBonus: audioQualityBonus(releaseAttrs.audio),
      }),
    }),
    weights: Object.freeze({ ...WEIGHTS }),
    historicalPrior: Math.round((historicalPrior || 0) * 1000) / 1000,
    freshProviderAvailability: Math.round(freshProviderAvailability * 1000) / 1000,
  });

  return {
    hash,
    fileIndex,
    filename,
    relevance,
    score: roundedScore,
    components: {
      relevance: Math.round(effectiveRelevance * 1000) / 1000,
      quality: Math.round(quality * 1000) / 1000,
      releaseConfidence: Math.round(releaseConfidence * 1000) / 1000,
      identityConfidence: Math.round(identityConfidence * 1000) / 1000,
      providerAvailability: Math.round(effectiveProviderAvailability * 1000) / 1000,
      episodeMatch: Math.round(episodeMatch * 1000) / 1000,
    },
    contributions,
    // Effective attributes: carries the theatrical sourceType override
    // (if any) so explanations show what was actually scored.
    releaseAttributes: releaseAttrs,
    mediaAssociations,
    providerObservations,
    providerEvidence,
    sources,
    selectedMediaId,
    // Slice 7: exact per-file byte size survives ranking so it can be
    // persisted into media_request_results. Does NOT influence score.
    selectedFileSize:
      Number.isSafeInteger(selectedFileSize) && selectedFileSize > 0
        ? selectedFileSize
        : null,
    // Source-provided media IDs ride through ranking untouched so tier
    // classification can consume them as corroboration evidence.
    ...(sourceIds ? { sourceIds } : {}),
    provenance: hit.provenance || null,
    justification,
  };
}

/**
 * DETAILED comparator — the SINGLE source of truth for ranking order.
 *
 * Every other ordering function derives from this one:
 *   - compareHits()        → returns compareHitsDetailed().order
 *   - rankHits()           → sorts using compareHits()
 *   - explainOrder()       → derives directly from compareHitsDetailed()
 *   - compareRanked()      → derives directly from explainOrder()
 *
 * There must be NO second handwritten precedence chain.
 *
 * Ordering precedence (first difference is decisive):
 * 1. Higher composite score wins
 * 2. Higher releaseConfidence wins (parser evidence strength)
 * 3. Higher quality wins (resolution/source evidence)
 * 4. Higher relevance wins (title match strength)
 * 5. Lower hash string wins (deterministic, content-derived)
 * 6. Lower fileIndex wins (null sorts after 0)
 *
 * @param {Object} a - First ranked result
 * @param {Object} b - Second ranked result
 * @returns {{order: -1|0|1, decisiveFactor: string|null, aValue: *, bValue: *, winner: 'a'|'b'|'tie', reason: string}}
 */
export function compareHitsDetailed(a, b) {
  // Primary: composite score (higher wins)
  const aScore = a.score ?? 0;
  const bScore = b.score ?? 0;
  if (aScore !== bScore) {
    const aWins = aScore > bScore;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'score',
      aValue: aScore,
      bValue: bScore,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} has higher composite score (${aScore} vs ${bScore})`,
    };
  }

  // Tie-break 1: releaseConfidence (higher wins)
  const aConf = a.components?.releaseConfidence ?? 0;
  const bConf = b.components?.releaseConfidence ?? 0;
  if (aConf !== bConf) {
    const aWins = aConf > bConf;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'releaseConfidence',
      aValue: aConf,
      bValue: bConf,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on release confidence (${aConf} vs ${bConf})`,
    };
  }

  // Tie-break 2: quality (higher wins)
  const aQual = a.components?.quality ?? 0;
  const bQual = b.components?.quality ?? 0;
  if (aQual !== bQual) {
    const aWins = aQual > bQual;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'quality',
      aValue: aQual,
      bValue: bQual,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on quality (${aQual} vs ${bQual})`,
    };
  }

  // Tie-break 3: relevance (higher wins)
  const aRel = a.components?.relevance ?? 0;
  const bRel = b.components?.relevance ?? 0;
  if (aRel !== bRel) {
    const aWins = aRel > bRel;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'relevance',
      aValue: aRel,
      bValue: bRel,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on relevance (${aRel} vs ${bRel})`,
    };
  }

  // Tie-break 4: hash (lexicographic, lower wins — deterministic)
  if (a.hash !== b.hash) {
    const aWins = a.hash < b.hash;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'hash',
      aValue: a.hash,
      bValue: b.hash,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on hash (lexicographic)`,
    };
  }

  // Tie-break 5: fileIndex (lower wins, null sorts after 0)
  const aIdx = a.fileIndex ?? Number.MAX_SAFE_INTEGER;
  const bIdx = b.fileIndex ?? Number.MAX_SAFE_INTEGER;
  if (aIdx !== bIdx) {
    const aWins = aIdx < bIdx;
    return {
      order: aWins ? -1 : 1,
      decisiveFactor: 'fileIndex',
      aValue: a.fileIndex,
      bValue: b.fileIndex,
      winner: aWins ? 'a' : 'b',
      reason: `${aWins ? 'A' : 'B'} wins tie-break on file index (${a.fileIndex} vs ${b.fileIndex})`,
    };
  }

  // Exact equality: all tie-breakers exhausted
  return {
    order: 0,
    decisiveFactor: null,
    aValue: null,
    bValue: null,
    winner: 'tie',
    reason: 'identical scores and all tie-breakers',
  };
}

/**
 * Compare two ranked results. Returns compareHitsDetailed().order.
 *
 * @param {Object} a - First ranked result
 * @param {Object} b - Second ranked result
 * @returns {number} -1 if a before b, 1 if b before a, 0 if equal
 */
export function compareHits(a, b) {
  return compareHitsDetailed(a, b).order;
}

/**
 * Explain why one result outranks another.
 *
 * Derives directly from compareHitsDetailed() — there is no second
 * handwritten precedence chain.
 *
 * @param {Object} a - First ranked result
 * @param {Object} b - Second ranked result
 * @returns {{decisiveFactor: string|null, aValue: *, bValue: *, winner: 'a'|'b'|'tie', reason: string}}
 */
export function explainOrder(a, b) {
  const d = compareHitsDetailed(a, b);
  return {
    decisiveFactor: d.decisiveFactor,
    aValue: d.aValue,
    bValue: d.bValue,
    winner: d.winner,
    reason: d.reason,
  };
}

/**
 * Rank multiple search hits.
 *
 * Uses deterministic tie-breakers so repeated identical input yields identical
 * order. Ordering is derived from compareHits() → compareHitsDetailed(),
 * the single source of truth.
 *
 * @param {Array<Object>} hits - Search hits
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping
 * @returns {Array<Object>} Ranked results sorted by score descending
 */
export function rankHits(hits, queryIntent = {}, mediaId = null) {
  const ranked = hits.map(hit => rankHit(hit, queryIntent, mediaId));
  ranked.sort(compareHits);
  // Assign rank (1-based position in sorted results)
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].justification = Object.freeze({
      ...ranked[i].justification,
      rank: i + 1,
    });
  }
  return ranked;
}

/**
 * Tiered ranking precedence — identity tier as primary sort signal.
 *
 * Ranking behavior:
 * 1. Verified candidates rank above ProviderConfirmed candidates
 * 2. ProviderConfirmed candidates rank above Probable candidates
 * 3. Probable candidates rank above TextOnly candidates
 * 4. Within each tier, existing ranking behavior is preserved (score, then tie-breakers)
 * 5. Ineligible candidates (season/episode mismatch) rank below all eligible candidates
 * 6. If a higher tier has no candidates, falls back to the next tier
 *
 * No candidates are deleted or discarded — all candidates appear in the output.
 *
 * @param {Array<Object>} hits - Search hits
 * @param {Object} [queryIntent] - Query intent
 * @param {string} [mediaId] - Selected media ID for identity confidence scoping
 * @param {Array<Object>} [eligibilityOverrides] - Per-hit eligibility results keyed by hit.releaseKey
 * @returns {{ranked: Array<Object>, tierMeta: {TieredRankingApplied: boolean, TierCounts: Object, TopResultsByTier: Object, IneligibleCount: number}}}
 */
export function rankHitsTiered(hits, queryIntent = {}, mediaId = null, eligibilityOverrides = null) {
  // Classify each candidate by identity tier
  const classified = hits.map(hit => {
    const key = hit.releaseKey || `${hit.hash}:${hit.fileIndex ?? 'torrent'}`;
    const eligibility = eligibilityOverrides?.get(key);

    if (eligibility && !eligibility.eligible) {
      return {
        hit,
        tier: {
          IdentityTier: 'Ineligible',
          IdentityConfidence: 0,
          IdentityEvidence: [eligibility.code],
          RejectionReason: eligibility.reason,
        },
        eligibility,
      };
    }

    return {
      hit,
      tier: classifyIdentityTier(hit, queryIntent, mediaId),
      eligibility: null,
    };
  });

  // Group by tier (preserve all candidates)
  const verified = classified.filter(c => c.tier.IdentityTier === 'Verified');
  const providerConfirmed = classified.filter(c => c.tier.IdentityTier === 'ProviderConfirmed');
  const probable = classified.filter(c => c.tier.IdentityTier === 'Probable');
  const providerScoped = classified.filter(c => c.tier.IdentityTier === 'ProviderScoped');
  const textOnly = classified.filter(c => c.tier.IdentityTier === 'TextOnly');
  const rejected = classified.filter(c => c.tier.IdentityTier === 'Rejected');
  const ineligible = classified.filter(c => c.tier.IdentityTier === 'Ineligible');

  // Rank within each tier using existing behavior
  const rankedVerified = rankHits(verified.map(c => c.hit), queryIntent, mediaId);
  const rankedProviderConfirmed = rankHits(providerConfirmed.map(c => c.hit), queryIntent, mediaId);
  const rankedProbable = rankHits(probable.map(c => c.hit), queryIntent, mediaId);
  const rankedProviderScoped = rankHits(providerScoped.map(c => c.hit), queryIntent, mediaId);
  const rankedTextOnly = rankHits(textOnly.map(c => c.hit), queryIntent, mediaId);
  const rankedRejected = rankHits(rejected.map(c => c.hit), queryIntent, mediaId);
  const rankedIneligible = rankHits(ineligible.map(c => c.hit), queryIntent, mediaId);

  // Concatenate: Verified → ProviderConfirmed → Probable → ProviderScoped → TextOnly → Rejected → Ineligible
  // Fallback is implicit: if a tier is empty, we simply proceed to the next
  const ranked = [
    ...rankedVerified,
    ...rankedProviderConfirmed,
    ...rankedProbable,
    ...rankedProviderScoped,
    ...rankedTextOnly,
    ...rankedRejected,
    ...rankedIneligible,
  ];

  // Attach eligibility info to each ranked hit
  for (let i = 0; i < ranked.length; i++) {
    const key = ranked[i].releaseKey || `${ranked[i].hash}:${ranked[i].fileIndex ?? 'torrent'}`;
    const classEntry = classified.find(c => {
      const cKey = c.hit.releaseKey || `${c.hit.hash}:${c.hit.fileIndex ?? 'torrent'}`;
      return cKey === key;
    });
    if (classEntry?.eligibility) {
      ranked[i].eligibility = classEntry.eligibility;
    }
    ranked[i].justification = Object.freeze({
      ...ranked[i].justification,
      rank: i + 1,
    });
  }

  // Build tier metadata for diagnostics
  const tierMeta = {
    TieredRankingApplied: true,
    TierCounts: {
      Verified: rankedVerified.length,
      ProviderConfirmed: rankedProviderConfirmed.length,
      Probable: rankedProbable.length,
      ProviderScoped: rankedProviderScoped.length,
      TextOnly: rankedTextOnly.length,
      Rejected: rankedRejected.length,
      Ineligible: rankedIneligible.length,
    },
    IneligibleCount: rankedIneligible.length,
    TopResultsByTier: {
      Verified: rankedVerified.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
      ProviderConfirmed: rankedProviderConfirmed.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
      Probable: rankedProbable.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
      ProviderScoped: rankedProviderScoped.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
      TextOnly: rankedTextOnly.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
      Ineligible: rankedIneligible.slice(0, 10).map(r => r.releaseKey || `${r.hash}:${r.fileIndex ?? 'torrent'}`),
    },
  };

  return { ranked, tierMeta };
}

/**
 * Compare two ranked results to explain why one outranks the other.
 *
 * Accepts RANKED RESULTS ONLY (output of rankHit/rankHits). Does NOT accept
 * explainRank() output, because explainRank() drops hash/fileIndex and
 * therefore cannot reproduce the final hash/fileIndex tie-breaks.
 *
 * Callers that need per-result explanations should call explainRank()
 * separately on each ranked result.
 *
 * Ordering is derived directly from explainOrder() → compareHitsDetailed(),
 * the single source of truth. Guaranteed to never drift from rankHits().
 *
 * @param {Object} a - First ranked result (rankHit/rankHits output)
 * @param {Object} b - Second ranked result (rankHit/rankHits output)
 * @returns {Object} Comparison result
 */
export function compareRanked(a, b) {
  if (!a || !b) return null;

  const order = explainOrder(a, b);
  const aComponents = a.components || {};
  const bComponents = b.components || {};
  const weights = WEIGHTS;

  // Compute weighted contribution diffs (raw, from stored contributions when available)
  const aContrib = a.contributions || {};
  const bContrib = b.contributions || {};
  const diffs = {};
  for (const key of Object.keys(weights)) {
    const aWeighted = aContrib[key] ?? (aComponents[key] || 0) * weights[key];
    const bWeighted = bContrib[key] ?? (bComponents[key] || 0) * weights[key];
    diffs[key] = Math.round((aWeighted - bWeighted) * 1000) / 1000;
  }

  return {
    winner: order.winner,
    scoreDiff: Math.round(((a.score ?? 0) - (b.score ?? 0)) * 1000) / 1000,
    componentDiffs: diffs,
    decisiveFactor: order.decisiveFactor,
    primaryReason: order.reason,
  };
}

/**
 * Build factual quality reasons from releaseAttributes.
 *
 * Describes ACTUAL release properties (resolution, source, codec, HDR),
 * never inferring resolution from the aggregate quality score.
 *
 * @param {Object} attrs - Release attributes
 * @returns {string[]} Human-readable quality reasons
 */
function buildQualityReasons(attrs = {}) {
  const reasons = [];

  // Resolution — describe what IS, not what the composite score implies
  if (attrs.resolution) {
    reasons.push(attrs.resolution);
  }

  // Source type
  if (attrs.sourceType) {
    reasons.push(attrs.sourceType);
  }

  // Codec
  if (attrs.codec) {
    reasons.push(attrs.codec);
  }

  // HDR
  if (attrs.hdr) {
    reasons.push('HDR');
  }

  return reasons;
}

/**
 * Explain a ranked result.
 *
 * Derives a deterministic explanation from the SAME component values that
 * rankHit() used. Does NOT duplicate ranking calculations — it reads the
 * components already computed by rankHit().
 *
 * Uses the ACTUAL weighted contributions stored by rankHit() (not recomputed
 * from rounded component values) so the explanation reconciles with the score.
 *
 * Quality explanations describe FACTS from releaseAttributes (resolution,
 * source, codec, HDR) — never inferring resolution from the aggregate score.
 *
 * Provider hints (non-authoritative) are never described as confirmed
 * provider availability. Only authoritative providerObservations contribute
 * to the providerAvailability component.
 *
 * @param {Object} ranked - Output of rankHit()
 * @param {number} ranked.score - Composite score
 * @param {Object} ranked.components - Component scores (relevance, quality, releaseConfidence, identityConfidence, providerAvailability, episodeMatch)
 * @param {Object} [ranked.contributions] - Raw weighted contributions (from rankHit)
 * @param {string} ranked.hash - InfoHash
 * @param {number|null} ranked.fileIndex - File index
 * @param {string} ranked.filename - Release filename
 * @param {Object} [ranked.releaseAttributes] - Parsed release attributes
 * @param {Array<Object>} [ranked.mediaAssociations] - Media associations
 * @param {Array<Object>} [ranked.providerObservations] - Provider observations
 * @param {Array<Object>} [ranked.sources] - Provenance sources
 * @param {string|null} [ranked.selectedMediaId] - Selected media intent provenance
 * @returns {Object} Deterministic explanation
 */
export function explainRank(ranked) {
  const components = ranked.components || {};
  const weights = WEIGHTS;

  // Use ACTUAL contributions from rankHit() if available (raw, unrounded).
  // These are what produced the score. Only fall back to recomputing from
  // rounded components if contributions weren't stored (backward compat).
  const contributions = ranked.contributions
    ? { ...ranked.contributions }
    : {
        relevance: components.relevance * weights.relevance,
        quality: components.quality * weights.quality,
        releaseConfidence: components.releaseConfidence * weights.releaseConfidence,
        identityConfidence: components.identityConfidence * weights.identityConfidence,
        providerAvailability: components.providerAvailability * weights.providerAvailability,
        episodeMatch: components.episodeMatch * weights.episodeMatch,
      };

  // Build deterministic human-readable reasons
  const reasons = [];

  // Relevance
  if (components.relevance >= 0.8) {
    reasons.push('strong title match');
  } else if (components.relevance >= 0.5) {
    reasons.push('moderate title match');
  } else if (components.relevance > 0) {
    reasons.push('weak title match');
  }

  // Quality — describe FACTS from releaseAttributes, not composite thresholds
  const qualityReasons = buildQualityReasons(ranked.releaseAttributes || {});
  reasons.push(...qualityReasons);

  // Release confidence (parser evidence)
  if (components.releaseConfidence >= 0.8) {
    reasons.push('high parser confidence');
  } else if (components.releaseConfidence >= 0.5) {
    reasons.push('moderate parser confidence');
  } else if (components.releaseConfidence > 0) {
    reasons.push('low parser confidence');
  }

  // Identity confidence
  if (components.identityConfidence >= 0.8) {
    reasons.push('strong identity match');
  } else if (components.identityConfidence >= 0.5) {
    reasons.push('moderate identity match');
  } else if (components.identityConfidence > 0) {
    reasons.push('weak identity match');
  }

  // Provider availability (authoritative observations only)
  const hasAuthoritativeProviders = (ranked.providerObservations || []).length > 0;
  if (hasAuthoritativeProviders) {
    if (components.providerAvailability >= 0.8) {
      reasons.push('confirmed provider availability');
    } else if (components.providerAvailability >= 0.5) {
      reasons.push('partial provider availability');
    } else if (components.providerAvailability > 0) {
      reasons.push('limited provider availability');
    } else {
      reasons.push('no provider availability');
    }
  }
  // Provider hints (non-authoritative) are intentionally NOT mentioned
  // as confirmed availability — they remain evidence only.

  // Episode match
  if (components.episodeMatch >= 0.9) {
    reasons.push('exact episode match');
  } else if (components.episodeMatch >= 0.7) {
    reasons.push('episode in range');
  } else if (components.episodeMatch >= 0.5) {
    reasons.push('season pack match');
  }

  // Deterministic summary: top contributing factors
  const sortedContributions = Object.entries(contributions)
    .sort(([, a], [, b]) => b - a);
  const topFactors = sortedContributions
    .filter(([, v]) => v > 0)
    .slice(0, 3)
    .map(([k]) => k);

  return {
    score: ranked.score,
    components: { ...components },
    contributions,
    reasons,
    summary: topFactors.length > 0
      ? `Top factors: ${topFactors.join(', ')}`
      : 'No significant ranking factors',
  };
}

/**
 * Get the default weights (for inspection/tuning).
 *
 * @returns {Object} Weight configuration
 */
export function getWeights() {
  return { ...WEIGHTS };
}
