/**
 * Safe library unpublish.
 *
 * Removes presentation/publication state for an exact movie or exact TV
 * episode (or a whole season, unit by unit) without touching durable
 * identity: Release, TorrentFile, provider placements/files, handoffs,
 * candidates, and request history are all preserved so a later re-request
 * cheaply republishes (or falls through to discovery when truth expired).
 *
 * Per unit the transition is:
 *   library_items.desired_state -> 'absent' + active bindings superseded
 *   VFS entry row deleted (scoped exact)
 *   matching .strm files deleted (content-matched by resolver URL)
 *
 * Idempotent: repeated calls converge (deletes are scoped, desired_state
 * is a plain upsert target, strm sweep matches by content). Sibling
 * episodes are never touched: every mutation is keyed by the unit's exact
 * identity (mediaId [+ season/episode]).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { createLibraryIdentityKey } from '../control-plane/canonical-path.js';

function strmRoot() {
  return process.env.STRM_OUTPUT_PATH || '/strm';
}

function parseResolverUrl(content) {
  const firstLine = String(content || '').split('\n')[0].trim();
  let url;
  try {
    url = new URL(firstLine);
  } catch {
    return null;
  }
  const movieMatch = url.pathname.match(/^\/stream\/movie\/([^/]+)$/);
  if (movieMatch) {
    return { mediaType: 'movie', mediaId: movieMatch[1], season: null, episode: null };
  }
  const seriesMatch = url.pathname.match(/^\/stream\/series\/([^/]+)$/);
  if (seriesMatch) {
    const season = url.searchParams.has('season') ? Number(url.searchParams.get('season')) : null;
    const episode = url.searchParams.has('episode') ? Number(url.searchParams.get('episode')) : null;
    return {
      mediaType: 'series',
      mediaId: seriesMatch[1],
      season: Number.isSafeInteger(season) ? season : null,
      episode: Number.isSafeInteger(episode) ? episode : null,
    };
  }
  return null;
}

function unitMatchesUrl(unit, parsed) {
  if (!parsed || parsed.mediaId !== unit.mediaId) return false;
  if (unit.season == null && unit.episode == null) {
    return parsed.mediaType === 'movie';
  }
  return parsed.season === unit.season && parsed.episode === unit.episode;
}

async function deleteStrmForUnit(root, unit) {
  const deleted = [];
  for (const collection of ['Movies', 'TV Shows']) {
    const base = path.join(root, collection);
    let showDirs;
    try {
      showDirs = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const show of showDirs) {
      if (!show.isDirectory()) continue;
      const showDir = path.join(base, show.name);
      let entries;
      try {
        entries = await fs.readdir(showDir, { withFileTypes: true, recursive: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.strm')) continue;
        const file = path.join(entry.parentPath ?? showDir, entry.name);
        let content;
        try {
          content = await fs.readFile(file, 'utf8');
        } catch {
          continue;
        }
        if (!unitMatchesUrl(unit, parseResolverUrl(content))) continue;
        try {
          await fs.unlink(file);
          deleted.push(file);
        } catch {
          // Best effort; a concurrent republish wins.
        }
      }
    }
  }
  return deleted;
}

/**
 * Unpublish one exact movie or episode, or every published episode of one
 * season. See module docs for the state contract.
 *
 * @returns {Promise<Object>} Per-unit summary; never deletes provider data.
 */
export async function unpublishMedia({
  cache,
  controlPlaneStore,
  mediaId,
  mediaType,
  season = null,
  episode = null,
}) {
  const mid = String(mediaId || '').trim();
  if (!mid) throw new Error('mediaId is required');
  const s = season ?? null;
  const e = episode ?? null;
  const wantSeason = s != null && e == null
    && (mediaType === 'series' || mediaType === 'tv' || mediaType == null);
  const wantEpisode = s != null && e != null;
  const wantMovie = !wantSeason && !wantEpisode;
  if (!wantMovie && !wantEpisode && !wantSeason) {
    throw new Error('mediaType/season/episode do not describe a movie, episode, or season');
  }

  let units;
  if (wantSeason) {
    const rows = cache.listTvPlaybackHandoffs().filter(
      (h) => h.mediaId === mid && h.season === s,
    );
    units = rows.map((h) => ({ mediaId: mid, season: h.season, episode: h.episode }));
  } else if (wantEpisode) {
    units = [{ mediaId: mid, season: s, episode: e }];
  } else {
    units = [{ mediaId: mid, season: null, episode: null }];
  }

  const results = [];
  for (const unit of units) {
    const identityKey = createLibraryIdentityKey({
      mediaType: unit.season == null ? 'movie' : 'episode',
      mediaId: unit.mediaId,
      season: unit.season,
      episode: unit.episode,
    });
    let storeResult = null;
    if (controlPlaneStore && typeof controlPlaneStore.unpublishLibraryItem === 'function') {
      storeResult = controlPlaneStore.unpublishLibraryItem(identityKey);
    }
    let vfsDeleted = 0;
    if (unit.season == null) {
      vfsDeleted = cache.deleteVfsMovieEntry(unit.mediaId);
    } else {
      vfsDeleted = cache.deleteVfsTvEntry(unit.mediaId, unit.season, unit.episode);
    }
    const strmDeleted = await deleteStrmForUnit(strmRoot(), unit);
    results.push({
      mediaId: unit.mediaId,
      season: unit.season,
      episode: unit.episode,
      identityKey,
      libraryItem: storeResult,
      vfsDeleted,
      strmDeleted,
    });
  }
  return { mediaId: mid, unpublished: true, units: results };
}
