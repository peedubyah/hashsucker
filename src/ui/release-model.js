const RESOLUTION_RANK = { '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1 };
const RESOLUTION_FILTERS = [
  ['2160p', '2160p / 4K'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p'],
];
const CODEC_FILTERS = [
  ['hevc', 'HEVC / x265'], ['avc', 'AVC / x264'], ['av1', 'AV1'], ['vp9', 'VP9'],
];
const HDR_FILTERS = [['hdr', 'HDR / HDR10'], ['dv', 'Dolby Vision'], ['hlg', 'HLG']];

function resolutionCategory(release) {
  return RESOLUTION_FILTERS.some(([value]) => value === release.resolution) ? release.resolution : null;
}
function codecCategory(release) {
  const codec = String(release.codec || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['x265', 'h265', 'hevc'].includes(codec)) return 'hevc';
  if (['x264', 'h264', 'avc'].includes(codec)) return 'avc';
  if (codec === 'av1') return 'av1';
  if (codec === 'vp9') return 'vp9';
  return null;
}
function hdrCategory(release) {
  const hdr = String(release.hdr || '').toUpperCase();
  if (hdr === 'DV') return 'dv';
  if (hdr === 'HLG') return 'hlg';
  if (hdr.startsWith('HDR')) return 'hdr';
  return null;
}

export function prepareReleases(releases) {
  const seen = new Set();
  return (releases || []).filter((release) => {
    const hash = String(release.infoHash || '').toLowerCase();
    if (!hash || seen.has(hash)) return false;
    seen.add(hash);
    return true;
  }).map((release, index) => ({ ...release, _order: index })).sort((a, b) => {
    const cache = Number(b.providers?.torbox?.cached === true) - Number(a.providers?.torbox?.cached === true);
    if (cache) return cache;
    const resolution = (RESOLUTION_RANK[b.resolution] || 0) - (RESOLUTION_RANK[a.resolution] || 0);
    if (resolution) return resolution;
    const size = (b.size ?? -1) - (a.size ?? -1);
    return size || a._order - b._order;
  });
}

export function filterReleases(releases, filters) {
  return releases.filter((release) => {
    if (filters.cached && release.providers?.torbox?.cached !== true) return false;
    if (filters.resolution && resolutionCategory(release) !== filters.resolution) return false;
    if (filters.codec && codecCategory(release) !== filters.codec) return false;
    if (filters.hdr && hdrCategory(release) !== filters.hdr) return false;
    if (filters.maxSizeGb != null && (release.size == null || release.size > filters.maxSizeGb * 1024 ** 3)) return false;
    return true;
  });
}

export function summarizeReleases(releases) {
  return {
    total: releases.length,
    cached: releases.filter((release) => release.providers?.torbox?.cached === true).length,
    resolutions: Object.fromEntries([...new Set(releases.map((release) => release.resolution).filter(Boolean))]
      .map((resolution) => [resolution, releases.filter((release) => release.resolution === resolution).length])),
  };
}

export function releaseFilterOptions(releases) {
  const present = (category) => new Set((releases || []).map(category).filter(Boolean));
  const resolutionValues = present(resolutionCategory); const codecValues = present(codecCategory); const hdrValues = present(hdrCategory);
  return {
    resolutions: RESOLUTION_FILTERS.filter(([value]) => resolutionValues.has(value)).map(([value, label]) => ({ value, label })),
    codecs: CODEC_FILTERS.filter(([value]) => codecValues.has(value)).map(([value, label]) => ({ value, label })),
    hdr: HDR_FILTERS.filter(([value]) => hdrValues.has(value)).map(([value, label]) => ({ value, label })),
  };
}

export function isReleaseSelected(release, selectedRelease) {
  if (!selectedRelease) return false;
  const hash = String(release?.infoHash || '').toLowerCase();
  const selectedHash = String(selectedRelease.infoHash || '').toLowerCase();
  return Boolean(hash) && hash === selectedHash;
}

export function requestPaneView(status, episodeLabel) {
  if (status === 'done') return { heading: 'Request complete', message: `${episodeLabel} imported successfully.`, terminal: true, failed: false };
  if (status === 'failed') return { heading: 'Request failed', message: `${episodeLabel} could not be completed.`, terminal: true, failed: true };
  return { heading: 'Request in progress', message: `${episodeLabel} is ${status}.`, terminal: false, failed: false };
}

export function releaseUtilityActions(release) {
  const infoHash = String(release?.infoHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) return null;
  const name = release.filename || release.title || 'Release';
  return { infoHash, magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}` };
}
