import path from 'node:path';

import {
  addDeterministicCollisionSuffix,
  buildPreferredCanonicalPath,
} from '../control-plane/canonical-path.js';

function releaseKeyFor(handoff) {
  return `${handoff.infoHash.toLowerCase()}:${handoff.fileIndex == null ? 'torrent' : handoff.fileIndex}`;
}

function movieIdentity(filename, mediaId) {
  const basename = path.posix.basename(String(filename || '').replaceAll('\\', '/'));
  const parsed = path.posix.parse(basename);
  const stem = parsed.name || basename || mediaId;
  const yearMatch = stem.match(/(?:^|[. _-])((?:19|20)\d{2})(?=$|[. _-])/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const titlePart = yearMatch ? stem.slice(0, yearMatch.index).trim() : stem.trim();
  const title = titlePart
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || mediaId;
  const extension = /^\.[a-z0-9]{1,10}$/i.test(parsed.ext) ? parsed.ext : '.mkv';
  return { title, year, extension };
}

function episodeIdentity(filename, mediaId) {
  const basename = path.posix.basename(String(filename || '').replaceAll('\\', '/'));
  const parsed = path.posix.parse(basename);
  const base = parsed.name || basename || mediaId;
  const title = base
    .replace(/[._-]+/g, ' ')
    .replace(/\s+S\d+E\d+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || mediaId;
  const extension = /^\.[a-z0-9]{1,10}$/i.test(parsed.ext) ? parsed.ext : '.mkv';
  return { title, extension };
}

/**
 * Materialize and return the durable VFS entry for a playback handoff.
 * This is the sole owner of release filename to canonical VFS path mapping.
 */
export function materializeVfsEntry(searchCache, handoff, now = () => Date.now()) {
  if (handoff.mediaType === 'movie') {
    const existing = searchCache.getVfsMovieEntry(handoff.mediaId);
    if (existing) return existing;
    if (handoff.releaseKey !== releaseKeyFor(handoff)) {
      throw new Error(`Durable movie handoff identity is inconsistent for ${handoff.mediaId}`);
    }

    const movie = movieIdentity(handoff.filename, handoff.mediaId);
    let canonicalPath = buildPreferredCanonicalPath({
      mediaType: 'movie',
      mediaId: handoff.mediaId,
      title: movie.title,
      year: movie.year,
    }, { extension: movie.extension });
    const usedPaths = new Set(searchCache.listVfsMovieEntries().map((entry) => entry.canonicalPath));
    if (usedPaths.has(canonicalPath)) {
      canonicalPath = addDeterministicCollisionSuffix(canonicalPath, handoff.releaseKey);
    }
    const timestamp = now();
    const created = searchCache.createVfsMovieEntry({
      mediaId: handoff.mediaId,
      releaseKey: handoff.releaseKey,
      infoHash: handoff.infoHash,
      fileIndex: handoff.fileIndex,
      canonicalPath,
      size: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    console.log(`[vfs] materialized media=${created.mediaId} path="${created.canonicalPath}" release=${created.releaseKey}`);
    return created;
  }

  if (!['series', 'tv'].includes(handoff.mediaType)
    || !Number.isSafeInteger(handoff.season)
    || !Number.isSafeInteger(handoff.episode)) {
    throw new Error(`Unsupported VFS handoff identity for ${handoff.mediaId}`);
  }

  const existing = searchCache.getVfsTvEntry(handoff.mediaId, handoff.season, handoff.episode);
  if (existing) return existing;
  const episode = episodeIdentity(handoff.filename, handoff.mediaId);
  let canonicalPath = buildPreferredCanonicalPath({
    mediaType: 'episode',
    mediaId: handoff.mediaId,
    title: episode.title,
    season: handoff.season,
    episode: handoff.episode,
  }, { extension: episode.extension });
  const usedPaths = new Set(searchCache.listVfsTvEntries().map((entry) => entry.canonicalPath));
  if (usedPaths.has(canonicalPath)) {
    canonicalPath = addDeterministicCollisionSuffix(canonicalPath, handoff.releaseKey);
  }
  const timestamp = now();
  const created = searchCache.createVfsTvEntry({
    mediaId: handoff.mediaId,
    season: handoff.season,
    episode: handoff.episode,
    releaseKey: handoff.releaseKey,
    infoHash: handoff.infoHash,
    fileIndex: handoff.fileIndex,
    canonicalPath,
    size: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  console.log(`[vfs-tv] materialized media=${created.mediaId} S${created.season}E${created.episode} path="${created.canonicalPath}" release=${created.releaseKey}`);
  return created;
}
