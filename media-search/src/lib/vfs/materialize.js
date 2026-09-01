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

function torrentFileForHandoff(controlPlaneStore, handoff, allowLegacy) {
  if (!handoff.torrentFileId) {
    if (allowLegacy) return null;
    throw new Error(`TorrentFile identity is required for new VFS publication of ${handoff.mediaId}`);
  }
  if (!controlPlaneStore || typeof controlPlaneStore.getTorrentFile !== 'function') {
    throw new Error(`TorrentFile validation is unavailable for ${handoff.mediaId}`);
  }
  const torrentFile = controlPlaneStore.getTorrentFile(handoff.torrentFileId);
  if (!torrentFile) {
    throw new Error(`TorrentFile ${handoff.torrentFileId} does not exist for ${handoff.mediaId}`);
  }
  if (!Number.isSafeInteger(torrentFile.size) || torrentFile.size <= 0) {
    throw new Error(`TorrentFile ${torrentFile.id} has invalid physical size`);
  }
  if (typeof torrentFile.internalPath !== 'string' || !torrentFile.internalPath) {
    throw new Error(`TorrentFile ${torrentFile.id} has invalid internal path`);
  }
  if (typeof torrentFile.infoHash !== 'string'
    || torrentFile.infoHash.toLowerCase() !== handoff.infoHash.toLowerCase()) {
    throw new Error(`TorrentFile ${torrentFile.id} infoHash does not match handoff ${handoff.mediaId}`);
  }
  return torrentFile;
}

function assertExistingIdentity(existing, handoff, torrentFile) {
  if (!torrentFile) return;
  if (existing.torrentFileId !== torrentFile.id
    || existing.infoHash.toLowerCase() !== torrentFile.infoHash.toLowerCase()
    || existing.size !== torrentFile.size) {
    throw new Error(`Durable VFS entry conflicts with TorrentFile ${torrentFile.id}`);
  }
}

/**
 * Materialize and return the durable VFS entry for a playback handoff.
 * TorrentFile supplies physical identity; handoff media fields supply the
 * stable library alias. New publication callers pass allowLegacy=false;
 * default compatibility preserves existing direct callers and WebDAV readback.
 */
export function materializeVfsEntry(
  searchCache,
  handoff,
  controlPlaneStore = null,
  now = () => Date.now(),
  { allowLegacy = true } = {},
) {
  const torrentFile = torrentFileForHandoff(controlPlaneStore, handoff, allowLegacy);
  if (handoff.mediaType === 'movie') {
    const existing = searchCache.getVfsMovieEntry(handoff.mediaId);
    if (existing) {
      assertExistingIdentity(existing, handoff, torrentFile);
      return existing;
    }
    if (handoff.releaseKey !== releaseKeyFor(handoff)) {
      throw new Error(`Durable movie handoff identity is inconsistent for ${handoff.mediaId}`);
    }

    // Prefer the canonical request identity (e.g. "Dune: Part Two", 2024
    // from the Seerr detail body) for the Plex-facing VFS path. Fall back
    // to the provider release filename only when no canonical identity
    // was supplied. The provider-backed `filename` and `infoHash` are
    // unchanged either way.
    const movie = movieIdentity(handoff.filename, handoff.mediaId);
    const physicalFile = movieIdentity(torrentFile?.internalPath ?? handoff.filename, handoff.mediaId);
    const presentationTitle = typeof handoff.canonicalTitle === 'string' && handoff.canonicalTitle.trim()
      ? handoff.canonicalTitle.trim()
      : (torrentFile ? handoff.mediaId : movie.title);
    const presentationYear = Number.isSafeInteger(handoff.canonicalYear) && handoff.canonicalYear >= 0
      ? handoff.canonicalYear
      : (torrentFile ? null : movie.year);
    let canonicalPath = buildPreferredCanonicalPath({
      mediaType: 'movie',
      mediaId: handoff.mediaId,
      title: presentationTitle,
      year: presentationYear,
    }, { extension: physicalFile.extension });
    const usedPaths = new Set(searchCache.listVfsMovieEntries().map((entry) => entry.canonicalPath));
    if (usedPaths.has(canonicalPath)) {
      canonicalPath = addDeterministicCollisionSuffix(
        canonicalPath,
        torrentFile?.id ?? handoff.releaseKey,
      );
    }
    const timestamp = now();
    const created = searchCache.createVfsMovieEntry({
      mediaId: handoff.mediaId,
      releaseKey: handoff.releaseKey,
      infoHash: torrentFile?.infoHash ?? handoff.infoHash,
      fileIndex: torrentFile ? null : handoff.fileIndex,
      canonicalPath,
      torrentFileId: torrentFile?.id ?? null,
      size: torrentFile?.size ?? null,
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
  if (existing) {
    assertExistingIdentity(existing, handoff, torrentFile);
    return existing;
  }
  const episode = episodeIdentity(torrentFile?.internalPath ?? handoff.filename, handoff.mediaId);
  const presentationTitle = typeof handoff.canonicalTitle === 'string' && handoff.canonicalTitle.trim()
    ? handoff.canonicalTitle.trim()
    : (torrentFile ? handoff.mediaId : episode.title);
  let canonicalPath = buildPreferredCanonicalPath({
    mediaType: 'episode',
    mediaId: handoff.mediaId,
    title: presentationTitle,
    season: handoff.season,
    episode: handoff.episode,
  }, { extension: episode.extension });
  const usedPaths = new Set(searchCache.listVfsTvEntries().map((entry) => entry.canonicalPath));
  if (usedPaths.has(canonicalPath)) {
    canonicalPath = addDeterministicCollisionSuffix(
      canonicalPath,
      torrentFile?.id ?? handoff.releaseKey,
    );
  }
  const timestamp = now();
  const created = searchCache.createVfsTvEntry({
    mediaId: handoff.mediaId,
    season: handoff.season,
    episode: handoff.episode,
    releaseKey: handoff.releaseKey,
    infoHash: torrentFile?.infoHash ?? handoff.infoHash,
    fileIndex: torrentFile ? null : handoff.fileIndex,
    canonicalPath,
    torrentFileId: torrentFile?.id ?? null,
    size: torrentFile?.size ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  console.log(`[vfs-tv] materialized media=${created.mediaId} S${created.season}E${created.episode} path="${created.canonicalPath}" release=${created.releaseKey}`);
  return created;
}
