/**
 * Normalize and merge Stremio stream objects into a provider-agnostic result model.
 *
 * Technical tags (resolution / codec / HDR / language) follow common scene / P2P
 * release naming (Title.Year.2160p.UHD.BluRay.…HDR10Plus.DV.x265-GROUP).
 * @see https://rendezvois.github.io/miscellaneous/naming-conventions/encodes/
 */

import { createReleaseIdentity } from '../../api/release-contract.js';
import { classifyCandidateIdentity } from '../discovery/candidate-identity.js';
import { namesAFile, splitSizeEvidence } from '../discovery/file-size-evidence.js';

const RESOLUTION_ORDER = {
  '8640p': 6,
  '4320p': 5,
  '2160p': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1,
};

/** Dot / bracket / space separators common in scene filenames */
function sceneNormalize(text) {
  return String(text || '')
    .replace(/[\[\]()]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseResolution(s) {
  // Prefer explicit p/i tokens; fall back to 4K / UHD marketing tags.
  const match = s.match(/\b(8640p|4320p|2160p|1440p|1080p|1080i|720p|576p|480p|360p|4K|UHD)\b/i);
  if (!match) return null;
  const token = match[1].toUpperCase();
  if (token === '4K' || token === 'UHD' || token === '2160P') return '2160p';
  if (token === '1080I' || token === '1080P' || token === '1440P') return '1080p';
  if (token === '720P') return '720p';
  if (token === '576P' || token === '480P' || token === '360P') return '480p';
  // Ultra-high (8K/4K variants already handled); keep lowercase p form when known.
  return `${parseInt(token, 10)}p`;
}

function parseHdr(s) {
  // Longest / most specific first (HDR10Plus before HDR10 before HDR).
  if (/\b(Dolby[\s.-]*Vision|DoVi|DV)\b/i.test(s)) return 'DV';
  if (/\b(HDR10[\s.+_-]*Plus|HDR10\+)\b/i.test(s)) return 'HDR10+';
  if (/\bHDR10\b/i.test(s)) return 'HDR10';
  if (/\bHLG\b/i.test(s)) return 'HLG';
  if (/\bHDR\b/i.test(s)) return 'HDR';
  return null;
}

function parseCodec(s) {
  // Scene WEB often uses H.265 / H.264; encodes use x265 / x264; HEVC/AVC synonyms.
  const match = s.match(/\b(x265|x264|h\.?265|h\.?264|HEVC|AVC|AV1|VP9|XviD|DivX)\b/i);
  if (!match) return null;
  const raw = match[1].toLowerCase().replace(/\./g, '');
  if (raw === 'hevc' || raw === 'h265' || raw === 'x265') return 'x265';
  if (raw === 'avc' || raw === 'h264' || raw === 'x264') return 'x264';
  if (raw === 'av1') return 'AV1';
  if (raw === 'vp9') return 'VP9';
  if (raw === 'xvid') return 'XviD';
  if (raw === 'divx') return 'DivX';
  return match[1];
}

function parseAudio(s) {
  // The codec, optionally followed by a channel count. The scene forms
  // "AAC5.1", "DD+5.1" and "DTS-X" all failed the word boundary before:
  // the channel suffix made the boundary fail, so "AAC5.1" produced NO audio
  // at all and "DDP5.1" produced "DDP5". The channel count is not the codec
  // — the codec is what the quality tiers reason about — so the suffix is
  // read and dropped.
  const match = s.match(
    /\b(TrueHD(?:[\s.-]*Atmos)?|DTS(?:-?HD(?:-?MA)?|-?X)?|Atmos|DD(?:\+|P|Plus)(?:[\s.-]*Atmos)?|EAC3|E-AC-?3|AC-?3|AAC|FLAC|Opus|LPCM|PCM)(?:[\s.-]*\d+(?:\.\d+)?)?\b/i
  );
  if (!match) return null;
  const token = match[1];
  // "DD+", "DDP" and "DD Plus" are one codec; keep one spelling so the
  // quality tiers see one value.
  if (/^DD/i.test(token)) return 'DD+';
  return token;
}

function parseQuality(s) {
  const match = s.match(
    /\b(Blu-?Ray|UHD[\s.-]*Blu-?Ray|WEB-?DL|WEBDL|WEB-?Rip|WEBRip|WEB|HDTV|REMUX|BDRip|BRRip|DVDRip|HDRip|PPVRip)\b/i
  );
  if (!match) return null;
  const t = match[1].toLowerCase().replace(/-/g, '');
  if (t.includes('bluray') || t.includes('uhd')) return 'BluRay';
  if (t === 'webdl' || t === 'web') return 'WEB-DL';
  if (t === 'webrip') return 'WEBRip';
  if (t === 'hdtv') return 'HDTV';
  if (t === 'remux') return 'REMUX';
  if (t === 'bdrip' || t === 'brrip') return 'BDRip';
  if (t === 'dvdrip') return 'DVDRip';
  return match[1];
}

function parseLanguage(s) {
  const match = s.match(
    /\b(ENG|English|Multi|DUAL|MULTi|JPN|Japanese|SPA|Spanish|FRE|French|GER|German|ITA|Italian|RUS|Russian|POR|Portuguese|CHI|Chinese|KOR|Korean|HIN|Hindi|NLD|Dutch|SWE|Swedish|NOR|Norwegian|FIN|Finnish|POL|Polish|CES|CZE|Czech|TUR|Turkish|THA|Thai|ARA|Arabic|HEB|Hebrew|VIE|Vietnamese|IND|Indonesian|MSA|Malay|UKR|Ukrainian)\b/i
  );
  return match ? match[1] : null;
}

/**
 * Parse scene / P2P style release metadata from free text (title, description, or filename).
 */
export function parseMetadata(text) {
  const s = sceneNormalize(text);
  if (!s) {
    return {
      resolution: null,
      hdr: null,
      codec: null,
      audio: null,
      quality: null,
      language: null,
    };
  }

  return {
    resolution: parseResolution(s),
    hdr: parseHdr(s),
    codec: parseCodec(s),
    audio: parseAudio(s),
    quality: parseQuality(s),
    language: parseLanguage(s),
  };
}

/**
 * The upstream addon's own parse, read as source evidence.
 *
 * The addons publish their interpretation in three places, with different
 * shapes per media kind:
 *
 *   - `behaviorHints.bingeGroup` — structured for movies
 *     ("torrentio|4k|BluRay|x265|10bit|HDR") but for a series it is usually
 *     just the infoHash, with no quality at all;
 *   - `name` (the second line) — the quality tag list
 *     ("4k DV | HDR10+ | HDR"), the only shape present for BOTH kinds;
 *   - `title` — the human title plus the seeders ("👤 186") and a human size
 *     string ("💾 6.91 GB"). Those are DISPLAY strings, not structured
 *     fields; the seeder count is carried as a display-derived hint and is
 *     never treated as a provider observation.
 *
 * Everything here is EVIDENCE about the upstream's reading of the release.
 * It may fill a fact our own parse missed. It never overwrites a fact our
 * parse established, and it never becomes schema authority: the local parser
 * remains the normalizer, for every source (the addons, the DMM corpus,
 * Torznab, and anything heterogeneous that comes later).
 */
export function readUpstreamFacts(stream) {
  const facts = {
    tags: null,
    sourceLabel: null,
    bitDepth: null,
    seeders: null,
    sizeText: null,
    resolution: null,
    source: null,
    codec: null,
    hdr: null,
  };
  if (!stream || typeof stream !== 'object') return facts;

  // Read a quality group with OUR vocabulary. The groups are the upstream's
  // own units ("4k DV", "BluRay REMUX", "1080p"), and a group may hold
  // several facts, so the local parsers run over the WHOLE group. The
  // upstream's tokens are read the way we read a filename — never with a
  // second vocabulary.
  const absorbGroup = (group) => {
    const text = String(group || '').trim();
    if (!text) return;
    if (facts.resolution == null) facts.resolution = parseResolution(text) || null;
    if (facts.source == null) facts.source = parseQuality(text) || null;
    if (facts.codec == null) facts.codec = parseCodec(text) || null;
    if (facts.hdr == null) facts.hdr = parseHdr(text) || null;
    // The bit depth has no local parser field; it is matched per token.
    if (facts.bitDepth == null) {
      const bit = /\b(\d{1,2}bit)\b/i.exec(text);
      if (bit) facts.bitDepth = bit[1].toLowerCase();
    }
  };

  // The bingeGroup: "label|resolution|source|codec|bitDepth|hdr" for movies.
  // For a series it is usually just the infoHash, which is not a quality
  // token and is ignored by the classifier.
  const group = stream.behaviorHints?.bingeGroup;
  if (typeof group === 'string' && group.includes('|')) {
    const parts = group.split('|').map((part) => part.trim());
    facts.sourceLabel = parts[0] || null;
    for (const part of parts.slice(1)) absorbGroup(part);
  }

  // The name's tag list — the only shape both media kinds publish.
  const nameLines = String(stream.name ?? '').split('\n');
  const tagLine = nameLines.slice(1).join(' ').trim();
  if (tagLine) {
    facts.tags = tagLine;
    for (const group of tagLine.split('|')) absorbGroup(group);
  }

  // Display-only extras from the human title.
  const seeders = /👤\s*([\d,]+)/.exec(String(stream.title ?? ''));
  if (seeders) facts.seeders = Number(seeders[1].replace(/,/g, ''));
  const sizeText = /💾\s*([\d.]+\s*[KMGT]?B)/.exec(String(stream.title ?? ''));
  if (sizeText) facts.sizeText = sizeText[1].trim();

  return facts;
}

/**
 * Prefer filename (authoritative scene name) over short UI title/description labels.
 */
function mergeParsedMetadata(fromLabels, fromFilename) {
  return {
    resolution: fromFilename.resolution || fromLabels.resolution,
    hdr: fromFilename.hdr || fromLabels.hdr,
    codec: fromFilename.codec || fromLabels.codec,
    audio: fromFilename.audio || fromLabels.audio,
    quality: fromFilename.quality || fromLabels.quality,
    language: fromFilename.language || fromLabels.language,
  };
}

function parseSizeFromText(text) {
  const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB|KiB|KB)/i);
  if (!match) return null;
  const n = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'GIB' || unit === 'GB') return Math.round(n * 1024 * 1024 * 1024);
  if (unit === 'MIB' || unit === 'MB') return Math.round(n * 1024 * 1024);
  if (unit === 'KIB' || unit === 'KB') return Math.round(n * 1024);
  return null;
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Decode a 32-char base32 infohash to lowercase hex (20 bytes).
 */
function decodeBase32Infohash(encoded) {
  const input = String(encoded || '')
    .replace(/=+$/, '')
    .toLowerCase();
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }

  if (bytes.length !== 20) return null;
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalize torrent infohash to lowercase hex.
 * Accepts hex (40), base32 (32), or urn:btih / magnet fragments.
 */
export function normalizeInfoHash(hash) {
  if (!hash || typeof hash !== 'string') return null;
  let cleaned = hash.trim();
  if (!cleaned) return null;

  const fromUrn = cleaned.match(/urn:btih:([a-zA-Z0-9]+)/i);
  if (fromUrn) cleaned = fromUrn[1];

  const lower = cleaned.toLowerCase();
  if (/^[a-f0-9]{40}$/.test(lower)) return lower;
  if (/^[a-z2-7]{32}$/.test(lower)) return decodeBase32Infohash(lower);
  return null;
}

function extractInfoHashFromMagnetUrl(url) {
  if (typeof url !== 'string' || !url.trim().toLowerCase().startsWith('magnet:')) {
    return null;
  }
  return normalizeInfoHash(url);
}

/**
 * Extract a torrent infohash from a Comet TorBox playback stream only when
 * Comet exposes the same validated hash in both its bingeGroup and URL path.
 */
function extractCometTorBoxInfoHash(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const bingeGroup =
    raw.behaviorHints &&
    typeof raw.behaviorHints.bingeGroup === 'string'
      ? raw.behaviorHints.bingeGroup.trim()
      : '';

  const bingeMatch = bingeGroup.match(
    /^comet\|torbox\|([a-f0-9]{40})$/i
  );

  if (!bingeMatch || typeof raw.url !== 'string') return null;

  let url;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(url.protocol)) return null;

  const pathMatch = url.pathname.match(
    /\/playback\/([a-f0-9]{40})(?:\/|$)/i
  );

  if (!pathMatch) return null;

  const bingeHash = normalizeInfoHash(bingeMatch[1]);
  const pathHash = normalizeInfoHash(pathMatch[1]);

  return bingeHash && bingeHash === pathHash ? bingeHash : null;
}

/**
 * Extract infoHash from Torrentio TorBox resolve URL format.
 * Format: https://torrentio.strem.fun/resolve/torbox/{uuid}/{infoHash}/...
 * The infoHash appears after the UUID segment in the URL path.
 */
function extractTorrentioTorBoxInfoHash(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.url !== 'string') return null;

  let url;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }

  // Look for Torrentio resolve URL pattern (RD-only tranche: TorBox
  // and Real-Debrid manifests both use /resolve/<provider>/... — the
  // middle segment differs (uuid vs key) so it is not matched literally).
  // Pattern: /resolve/torbox/{uuid}/{infoHash}/...
  //          /resolve/realdebrid/{key}/{infoHash}/...
  const pathMatch = url.pathname.match(
    /\/resolve\/(?:torbox|realdebrid)\/[^/]+\/([a-f0-9]{40})(?:\/|$)/i
  );

  if (pathMatch) {
    return normalizeInfoHash(pathMatch[1]);
  }

  return null;
}

function fingerprint(parts) {
  return parts.filter(Boolean).join('|');
}

/**
 * Streams we list in search: torrent (infoHash / magnet), usenet (nzbUrl), or http(s) url.
 * ytId / externalUrl-only / empty sources are omitted.
 * @see https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md
 */
export function isListableStream(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (normalizeInfoHash(raw.infoHash)) return true;
  if (extractInfoHashFromMagnetUrl(raw.url)) return true;
  if (typeof raw.nzbUrl === 'string' && /^https?:\/\//i.test(raw.nzbUrl.trim())) return true;
  if (typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url.trim())) return true;
  return false;
}

/** @deprecated use isListableStream — kept for tests/callers */
export function isTorboxCompatibleStream(raw) {
  return isListableStream(raw);
}

/**
 * Normalize a single raw Stremio stream from one addon.
 * Returns null when there is no listable source (infoHash, nzbUrl, or http(s)/magnet url).
 */
export function normalizeStream(raw, addonMeta = {}) {
  if (!isListableStream(raw)) return null;

  const title = raw.name || raw.title || '';
  const description = raw.description || raw.title || '';
  const behaviorHints =
    raw.behaviorHints && typeof raw.behaviorHints === 'object' ? raw.behaviorHints : {};
  const filename =
    (typeof behaviorHints.filename === 'string' && behaviorHints.filename.trim()
      ? behaviorHints.filename.trim()
      : null) ||
    (typeof raw.filename === 'string' && raw.filename.trim() ? raw.filename.trim() : null);

  // Filename is the scene/P2P release name — prefer it over short UI labels like "⚡ 4K [TB]".
  const fromLabels = parseMetadata([title, description].filter(Boolean).join('\n'));
  const fromFilename = parseMetadata(filename || '');
  const parsed = mergeParsedMetadata(fromLabels, fromFilename);

  // The upstream's own reading of the release, as EVIDENCE. It may fill a
  // fact our parse missed; it never overwrites one our parse established, and
  // the local parsers keep our vocabulary even for upstream tokens.
  const upstream = readUpstreamFacts(raw);
  const upstreamResolution = upstream.resolution ? parseResolution(upstream.resolution) : null;
  const upstreamQuality = upstream.source ? parseQuality(upstream.source) : null;
  const upstreamCodec = upstream.codec ? parseCodec(upstream.codec) : null;
  const upstreamHdr = upstream.hdr ? parseHdr(upstream.hdr) : null;

  const infoHash =
    normalizeInfoHash(raw.infoHash) ||
    extractInfoHashFromMagnetUrl(raw.url) ||
    extractCometTorBoxInfoHash(raw) ||
    extractTorrentioTorBoxInfoHash(raw);
  const nzbUrl =
    typeof raw.nzbUrl === 'string' && /^https?:\/\//i.test(raw.nzbUrl.trim())
      ? raw.nzbUrl.trim()
      : null;
  const streamUrl =
    !infoHash && typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url.trim())
      ? raw.url.trim()
      : null;

  let size = null;
  if (typeof behaviorHints.videoSize === 'number' && Number.isFinite(behaviorHints.videoSize)) {
    size = behaviorHints.videoSize;
  } else {
    size =
      parseSizeFromText(filename || '') ||
      parseSizeFromText([title, description].filter(Boolean).join('\n'));
  }

  // Slice 1.75 (correctness fix): exactFileSize is the RAW integer byte count
  // from behaviorHints.videoSize, NOT a parseSizeFromText() round. It is the
  // only authoritative source for the per-file size used by the TorBox
  // pre-publication identity binding. parseSizeFromText() rounds filenames
  // like "10.5GB" to 11274289152 — that value is fine for ranking/display
  // but is NEVER exact enough to bind a TorBox provider file. We surface the
  // exact integer (or null) under a distinct field so downstream consumers
  // can require the strict value and ignore the rounded one.
  //
  // Part 0 (size scope): the upstream's number is the FILE's size ONLY when
  // the stream identifies a file. When the stream names the RELEASE (no
  // fileIdx, and the published name carries no media extension), the number
  // is the release's TOTAL — measured against the provider's authoritative
  // file list, a release-named stream's number was per-file 0 % of the time
  // and the release total ~52 % of the time. A release total can never
  // prove a file, so it must not be offered as one. The scope decision is
  // the SOURCE's own shape, never the number.
  const upstreamVideoSize =
    Number.isSafeInteger(behaviorHints.videoSize) && behaviorHints.videoSize > 0
      ? behaviorHints.videoSize
      : null;
  const sourceFileIndex = Object.hasOwn(raw, 'fileIdx') ? raw.fileIdx : null;
  const upstreamNamesFile = sourceFileIndex !== null || namesAFile(filename);
  const { exactFileSize, releaseSizeBytes } = splitSizeEvidence({
    size: upstreamVideoSize,
    namesFile: upstreamNamesFile,
  });

  // The upstream's cache hint is scoped to the provider THE ADDON is
  // configured with, at the time of the addon's response. It is not our own
  // provider observation (that is `providerAvailabilityScore`, computed from
  // our provider observations) and it is not the addon's response cache. It
  // is therefore named for what it is and never promoted to a universal
  // "cached" fact.
  const upstreamCachedHint = behaviorHints.cached === true;
  const identity = infoHash
    ? createReleaseIdentity(infoHash, sourceFileIndex)
    : { infoHash: null, fileIndex: null, releaseKey: null };

  const key = fingerprint([
    identity.releaseKey,
    !infoHash && nzbUrl ? `nzb:${nzbUrl}` : null,
    !infoHash && !nzbUrl && streamUrl ? `url:${streamUrl}` : null,
  ]);

  if (!key) return null;

  // Fill ONLY the gaps our own parse left. The local parse stays
  // authoritative; the upstream's evidence is a fallback, and every filled
  // field says where it came from.
  const resolution = parsed.resolution || upstreamResolution || null;
  const quality = parsed.quality || upstreamQuality || null;
  const codec = parsed.codec || upstreamCodec || null;
  const hdr = parsed.hdr || upstreamHdr || null;
  const attributeOrigin = {
    resolution: parsed.resolution ? 'local' : (upstreamResolution ? 'upstream' : null),
    quality: parsed.quality ? 'local' : (upstreamQuality ? 'upstream' : null),
    codec: parsed.codec ? 'local' : (upstreamCodec ? 'upstream' : null),
    hdr: parsed.hdr ? 'local' : (upstreamHdr ? 'upstream' : null),
  };

  return {
    key,
    // The identity strength: this candidate names a file by PATH and exact
    // size, or only by its byte count. The strength travels with the
    // candidate so no consumer has to guess it.
    identityStrength: classifyCandidateIdentity({
      infoHash,
      internalPath: null,
      exactFileSize,
    }).strength,
    // The candidate's position WITHIN ITS OWN SOURCE'S RESPONSE. It is a
    // source-local ordinal, never a global rank: position 1 from one addon
    // and position 1 from another are not calibrated equivalents and are
    // never compared numerically across sources.
    sourceOrdinal: Number.isSafeInteger(addonMeta.sourceOrdinal) ? addonMeta.sourceOrdinal : null,
    sourceId: addonMeta.addonId || null,
    // The upstream's own reading of the release, kept as source evidence.
    upstreamFacts: {
      tags: upstream.tags,
      sourceLabel: upstream.sourceLabel,
      bitDepth: upstream.bitDepth,
      seeders: upstream.seeders,
      sizeText: upstream.sizeText,
    },
    // Which normalized attributes came from our parse and which were filled
    // from the upstream's evidence.
    attributeOrigin,
    addonId: addonMeta.addonId || null,
    addonName: addonMeta.addonName || null,
    observer: addonMeta.provider || addonMeta.addonId || null,
    sourceClass: addonMeta.sourceClass || 'stremio',
    addonLogo: addonMeta.addonLogo || null,
    addonSortOrder: addonMeta.sortOrder ?? 0,
    streamType: addonMeta.streamType || null,
    exactFileSize,
    // Part 0 (size scope): the upstream's number when the stream names the
    // RELEASE rather than a file. Release-level evidence, never an identity.
    releaseSizeBytes,
    role: addonMeta.role || 'discovery',
    title: title || description || 'Stream',
    description,
    filename,
    quality,
    resolution,
    codec,
    hdr,
    audio: parsed.audio,
    language: parsed.language,
    size,
    upstreamCachedHint,
    filename,
    ...identity,
    nzbUrl,
    url: streamUrl,
    behaviorHints,
    raw,
    sources: [
      {
        addonId: addonMeta.addonId || null,
        addonName: addonMeta.addonName || null,
        observer: addonMeta.provider || addonMeta.addonId || null,
        sourceClass: addonMeta.sourceClass || 'stremio',
        role: addonMeta.role || 'discovery',
        provider: addonMeta.provider || null,
      },
    ],
  };
}

function richness(stream) {
  let score = 0;
  if (stream.infoHash) score += 4;
  if (stream.nzbUrl) score += 4;
  if (stream.url) score += 2;
  if (stream.size != null) score += 1;
  if (stream.resolution) score += 1;
  if (stream.upstreamCachedHint) score += 1;
  return score;
}

/**
 * Merge a batch of normalized streams into an existing list (dedupe by key).
 */
export function mergeStreams(existing, incoming) {
  const map = new Map();
  for (const s of existing || []) {
    if (s?.key) map.set(s.key, s);
  }

  for (const s of incoming || []) {
    if (!s?.key) continue;
    const prev = map.get(s.key);
    if (!prev) {
      map.set(s.key, s);
      continue;
    }

    const keep = richness(s) > richness(prev) ? s : prev;
    const other = keep === s ? prev : s;
    const sources = [...(keep.sources || [])];
    for (const src of other.sources || []) {
      if (!sources.some((x) => x.addonId === src.addonId)) {
        sources.push(src);
      }
    }
    map.set(s.key, {
      ...keep,
      role: keep.role || other.role,
      provider: keep.provider || other.provider,
      title: keep.title || other.title,
      description: keep.description || other.description,
      quality: keep.quality || other.quality,
      resolution: keep.resolution || other.resolution,
      codec: keep.codec || other.codec,
      hdr: keep.hdr || other.hdr,
      audio: keep.audio || other.audio,
      language: keep.language || other.language,
      size: keep.size ?? other.size,
      upstreamCachedHint: keep.upstreamCachedHint || other.upstreamCachedHint,
      infoHash: keep.infoHash || other.infoHash,
      fileIndex: keep.fileIndex,
      releaseKey: keep.releaseKey || other.releaseKey,
      nzbUrl: keep.nzbUrl || other.nzbUrl,
      url: keep.url || other.url,
      filename: keep.filename || other.filename,
      sources,
    });
  }

  return [...map.values()];
}

function resolutionRank(resolution) {
  if (!resolution) return 0;
  return RESOLUTION_ORDER[resolution] || 0;
}

/**
 * Default sort: cached → resolution → size → addon order → title
 */
export function sortStreams(streams) {
  return [...(streams || [])].sort((a, b) => {
    if (Boolean(b.upstreamCachedHint) !== Boolean(a.upstreamCachedHint)) return a.upstreamCachedHint ? -1 : 1;
    const resDiff = resolutionRank(b.resolution) - resolutionRank(a.resolution);
    if (resDiff !== 0) return resDiff;
    const sizeA = a.size ?? -1;
    const sizeB = b.size ?? -1;
    if (sizeB !== sizeA) return sizeB - sizeA;
    const orderDiff = (a.addonSortOrder ?? 0) - (b.addonSortOrder ?? 0);
    if (orderDiff !== 0) return orderDiff;
    // The source-local ordinal: a WEAK tiebreak, and only WITHIN one source.
    // Position 1 from Torrentio and position 1 from Comet are not calibrated
    // equivalents, so they are never compared numerically across sources.
    // Within one source the upstream's own order is better evidence than an
    // alphabetical comparison of display titles.
    if (a.sourceId && a.sourceId === b.sourceId
      && Number.isSafeInteger(a.sourceOrdinal) && Number.isSafeInteger(b.sourceOrdinal)
      && a.sourceOrdinal !== b.sourceOrdinal) {
      return a.sourceOrdinal - b.sourceOrdinal;
    }
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

/**
 * Trigger a browser download (or open) for an http(s) stream URL.
 *
 * Cross-origin hosts ignore the `download` attribute, so video URLs often play
 * instead of saving. Always open in a new tab so the search page is preserved.
 * Same-origin / attachment responses may still download via `download` + filename.
 *
 * Do not fetch-as-blob or proxy: stream files are often multi-GB and addon hosts
 * rarely allow CORS.
 */
export function triggerBrowserDownload(url, filename) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return false;
  if (typeof document === 'undefined') return false;

  const a = document.createElement('a');
  a.href = url.trim();
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (filename) {
    a.download = filename;
  } else {
    a.download = '';
  }
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return true;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** AIOStreams Cache & Play / uncached resolve can run this long before redirecting. */
const SILENT_ADD_TIMEOUT_MS = 90_000;

/**
 * Hit an http(s) Stremio stream URL without opening a tab or triggering a download.
 *
 * TorBox-oriented addons (notably AIOStreams `/api/v1/debrid/playback/...`) add the
 * video during the request, then 302/307 to a CDN or a static "downloading" clip.
 *
 * Uses browser `fetch` + `redirect: 'manual'`:
 * - Allowed by production CSP `connect-src` (hidden iframes are blocked: `default-src 'self'`
 *   with no `frame-src`, so iframe navigations never leave the origin)
 * - Does not follow the CDN hop (avoids multi‑MB bodies from `redirect: 'follow'`)
 * - Waits long enough for AIOStreams debrid resolve (uncached titles need many seconds)
 *
 * Chromium in a page context often rejects `redirect: 'manual'` with
 * `TypeError: Failed to fetch` after a cross-origin 302 — DevTools still shows the
 * 302 and the CDN was not followed. That means the addon hop completed → success.
 *
 * @param {string} url
 * @returns {Promise<true>}
 */
export async function triggerSilentStreamAdd(url) {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Invalid stream URL');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SILENT_ADD_TIMEOUT_MS);

  try {
    const response = await fetch(trimmed, {
      method: 'GET',
      mode: 'cors',
      // Stop before the post-add CDN hop — that body is the video.
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });

    try {
      await response.body?.cancel?.();
    } catch {
      // ignore cancel errors on opaque / already-closed bodies
    }

    if (
      response.type === 'opaqueredirect' ||
      response.status === 0 ||
      REDIRECT_STATUSES.has(response.status)
    ) {
      return true;
    }

    throw new Error(
      `Stream URL did not redirect (expected 301/302/303/307/308, got ${response.status}). Refusing to read a media body.`
    );
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Silent add timed out waiting for the addon to resolve');
    }
    // Chromium page context: redirect:manual + cross-origin 302 → TypeError
    // ("Failed to fetch") even though the addon add hop completed.
    if (error instanceof TypeError) {
      return true;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Map a normalized stream to actions.
 * - infoHash / magnet → upload via TorBox API
 * - nzbUrl → upload via TorBox API
 * - http(s) url → copy + download + silent Add (hit URL; no TorBox API upload)
 * @returns {{ kind: 'magnet'|'usenet'|'link'|'none', canUpload: boolean, canSilentAdd: boolean, data?: string, name?: string, copyValue?: string }}
 */
export function streamToUploadTarget(stream) {
  const name = stream?.title || stream?.filename || 'Stream';

  if (stream?.infoHash) {
    const magnet = `magnet:?xt=urn:btih:${stream.infoHash}&dn=${encodeURIComponent(name)}`;
    return {
      kind: 'magnet',
      canUpload: true,
      canSilentAdd: false,
      data: magnet,
      name,
      copyValue: magnet,
    };
  }

  if (stream?.nzbUrl) {
    return {
      kind: 'usenet',
      canUpload: true,
      canSilentAdd: false,
      data: stream.nzbUrl,
      name,
      copyValue: stream.nzbUrl,
    };
  }

  if (stream?.url && /^https?:\/\//i.test(stream.url)) {
    return {
      kind: 'link',
      canUpload: false,
      canSilentAdd: true,
      data: stream.url,
      name,
      copyValue: stream.url,
    };
  }

  return { kind: 'none', canUpload: false, canSilentAdd: false, copyValue: '', name };
}
