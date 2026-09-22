import { parseFilename } from './parser-adapter.js';

const EXTENSION = /\.(?:mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|iso|img)$/i;
const STRUCTURAL = new RegExp([
  '2160p', '1080p', '720p', '480p', '360p', '8k', '4k', '4kuhd', 'uhd',
  'blu[- ]?ray', 'bdrip', 'brrip', 'web[- ]?dl', 'webrip', 'web', 'hdtv', 'hd[- ]?dvd',
  'dvd', 'dsr', 'dsrip', 'hdtvrip', 'pdtv', 'tvrip', 'vhsrip', 'vhs', 'internal',
  'repack', 'proper', 'rerip', 'remux', 'x264', 'x265', 'h[.]?264', 'h[.]?265',
  'hevc', 'avc', 'divx', 'xvid', 'mpeg[- ]?2', 'vc[- ]?1', 'aac(?:\d(?:[.]\d)?)?',
  'ac[- ]?3(?:\d(?:[.]\d)?)?', 'ddp?(?:\d(?:[.]\d)?)?', 'dts(?:[- ]?hd)?(?:\d(?:[.]\d)?)?',
  'truehd', 'atmos', 'mp3', 'flac', 'ogg', 'wma', 'pcm', 'hdr(?:10)?', 'dolby[.]?vision',
  'hlg', 'nf', 'amzn', 'dsnp', 'hmax', 'atvp', 'hulu', 'disney', 'netflix', 'hbo',
  'apple', 'paramount', 'english', 'french', 'spanish', 'german', 'italian', 'dutch',
  'swedish', 'norwegian', 'danish', 'finnish', 'polish', 'russian', 'japanese',
  'korean', 'chinese', 'multi', 'extended', 'director[’\']?s[ -]?cut', 'unrated',
  'theatrical', 'remastered', 'ultimate', 'collector[’\']?s', 'real', 'repack',
].join('|'), 'gi');

const SEASON = /\bS\d{1,2}(?:E\d{1,2}(?:[-~]E?\d{1,2})?|(?:[- ]S?\d{1,2}))?\b|\bSeason\s*\d{1,2}(?:\s*Episode\s*\d{1,2})?\b|\bEpisode\s*\d{1,2}\b/gi;
const YEAR = /\b(?:19[3-9]\d|20[0-3]\d)\b/g;

function cleanTokenText(value) {
  return String(value ?? '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._-]+|[\s._-]+$/g, '')
    .trim();
}

/**
 * Extract the deterministic media-title portion of a release filename.
 * This is query-independent: requested metadata is never consulted.
 *
 * The helper removes only known release grammar. Regional identity tokens such
 * as US/UK/Australia remain intact.
 */
export function canonicalReleaseTitle(release) {
  const raw = typeof release === 'string' ? release : release?.filename ?? release?.title ?? '';
  let value = String(raw).split('/').pop()?.replace(EXTENSION, '') ?? '';
  const parsed = parseFilename(value)?.parsed ?? {};

  // Remove common indexer wrappers only when they are a delimited prefix.
  value = value.replace(/^\s*www\.[a-z0-9.-]+\s*[-–—]\s*/i, '');
  value = value.replace(/\[[^\]]*\]\s*$/g, '');
  value = value.replace(/\s*\([^)]*\)\s*$/g, (match) => /complete|season|series|\d{4}/i.test(match) ? ' ' : match);
  value = value.replace(SEASON, ' ');
  value = value.replace(YEAR, ' ');
  value = value.replace(STRUCTURAL, ' ');

  // Complete is structural only in explicit pack grammar. Do not erase a
  // legitimate title merely because it contains the word Complete.
  if (parsed.season != null || /\b(?:season|series)\b/i.test(value) && !parsed.year || /\bcomplete\b/i.test(value) && /\b(?:S\d{1,2}|Season\s*\d{1,2})\b/i.test(String(raw))) {
    value = value.replace(/\bcomplete(?:\s+series)?\b/gi, ' ');
  }
  value = value.replace(/\bseason\s*\d{0,2}\b/gi, ' ');

  // A trailing release group is structural when introduced by a dash or when
  // parser evidence identified it. Preserve ordinary identity words.
  const group = parsed.releaseGroup;
  if (group && /\s-\s*[^-]+\s*$/i.test(value)) {
    value = value.replace(new RegExp(`\\s+-\\s*${group.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}\\s*$`, 'i'), ' ');
  }
  value = value.replace(/\s+-\s*[A-Za-z0-9]+\s*$/g, ' ');
  value = value.replace(/\b(?:web)[- ]?dl\b/gi, ' ');

  return cleanTokenText(value) || null;
}
