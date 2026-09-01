/**
 * TV Episode Resolution
 *
 * Resolves a requested season/episode pair against authoritative TorrentFiles
 * for a given release (infoHash).
 *
 * Contract:
 *   TorrentFiles (already persisted via ensureTorBoxDelivery + inventory)
 *   → filter playable video files
 *   → parse S/E from canonicalInternalPath
 *   → exactly one match → bindable
 *   → zero matches     → unbindable (EPISODE_NOT_FOUND)
 *   → multiple matches  → unbindable (EPISODE_AMBIGUOUS)
 *
 * This does NOT create placements, call TorBox, or write any control-plane state.
 * It only reads existing TorrentFiles and applies media-semantic filtering.
 *
 * Durable physical identity remains (infoHash + canonicalInternalPath + exact size).
 * TV S/E parsing from canonicalInternalPath is used as SELECTION EVIDENCE only,
 * never as the durable identity itself.
 */

import { parseFilename } from '../discovery/parser-adapter.js';

// Video extensions that qualify as playable media
const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm',
  '.m4v', '.mpg', '.mpeg', '.ts', '.m2ts', '.vob', '.ogv',
]);

function getExtension(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) return '';
  const ext = filename.slice(lastDot).toLowerCase();
  if (!/^\.[a-z0-9]{1,5}$/.test(ext)) return '';
  return ext;
}

function classifyFile(filename) {
  const ext = getExtension(filename);
  if (!ext) return 'other';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'other';
}

/**
 * @typedef {Object} TvResolutionError
 * @property {string} code  - EPISODE_NOT_PLAYABLE | EPISODE_NOT_FOUND | EPISODE_AMBIGUOUS | INVALID_COORDINATES
 * @property {string} message
 */

/**
 * Check whether a TorrentFile qualifies as a playable video file.
 *
 * @param {Object} tf - TorrentFile row
 * @returns {boolean}
 */
export function isPlayableVideoTorrentFile(tf) {
  if (!tf?.internalPath) return false;
  if (classifyFile(tf.internalPath) !== 'video') return false;
  // Reject sample files (often bundled in scene releases like 020c50).
  // A /Sample/ directory or 'sample.' in the filename indicates a non-playable
  // preview file, not the actual episode content.
  const lower = tf.internalPath.toLowerCase();
  if (lower.includes('/sample/') || lower.includes('sample.')) return false;
  if (!Number.isSafeInteger(tf.size) || tf.size <= 0) return false;
  return true;
}

/**
 * Resolve a TV episode from TorrentFiles for a release.
 *
 * @param {Object} params
 * @param {Object[]} params.torrentFiles - From controlPlaneStore.listTorrentFilesForRelease(infoHash)
 * @param {number|null} params.season   - Requested season number
 * @param {number|null} params.episode  - Requested episode number
 * @returns {{ torrentFile: Object }}  The single uniquely matched TorrentFile
 * @throws {{ code: string, message: string }} On zero or multiple matches
 */
export function resolveTvTorrentFile({ torrentFiles, season, episode }) {
  if (!Array.isArray(torrentFiles)) {
    throw { code: 'INVALID_COORDINATES', message: 'torrentFiles must be an array' };
  }
  if (!Number.isSafeInteger(season) || season < 1) {
    throw { code: 'INVALID_COORDINATES', message: `Invalid season: ${season}` };
  }
  if (!Number.isSafeInteger(episode) || episode < 1) {
    throw { code: 'INVALID_COORDINATES', message: `Invalid episode: ${episode}` };
  }

  // Filter to playable video files only
  const playable = torrentFiles.filter(isPlayableVideoTorrentFile);

  if (playable.length === 0) {
    throw { code: 'EPISODE_NOT_PLAYABLE', message: 'No playable video files in this release' };
  }

  // Parse season/episode from each playable file's canonical path
  const matched = playable.filter((tf) => {
    const parsed = parseFilename(tf.internalPath);
    if (!parsed?.parsed) return false;
    return parsed.parsed.season === season && parsed.parsed.episode === episode;
  });

  if (matched.length === 0) {
    throw { code: 'EPISODE_NOT_FOUND', message: `No playable file matches S${season}E${episode}` };
  }

  if (matched.length > 1) {
    throw {
      code: 'EPISODE_AMBIGUOUS',
      message: `${matched.length} playable files match S${season}E${episode} — refusing ambiguous selection`,
    };
  }

  return { torrentFile: matched[0] };
}
