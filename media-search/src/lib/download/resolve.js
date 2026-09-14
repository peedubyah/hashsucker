/**
 * Download resolution (download-intent tranche).
 *
 * Identity in, exact TorrentFile out — no fuzzy title matching, no
 * second discovery pipeline, no ranking changes:
 *
 *   Fast path  — getPreparedDurableState: an existing healthy durable
 *                TorrentFile (stored handoff + verified TorrentFile +
 *                ≥1 serving coordinate, exact S/E match) is reused
 *                with zero provider work. This covers "/request then
 *                /download the same movie".
 *   Fresh path — searchByMedia with prepareOnly:true: the NORMAL
 *                discovery/ranking/binding pipeline persists reusable
 *                durable truth without presentation; the prepared
 *                handoff then resolves exactly like the fast path.
 *
 * TV exactness: episode identity (season/episode) is enforced by the
 * prepared-state lookup itself. A pack supplies the episode's exact
 * TorrentFile only when the handoff's torrentFileId verifies against
 * a TorrentFile with live mapped coordinates for that episode.
 */

import { getPreparedDurableState } from '../../api/media-request.js';

export function createDownloadResolver({
  searchCache,
  controlPlaneStore,
  searchByMediaFn,
  buildEnsureFns = null,
} = {}) {
  if (!searchCache) throw new Error('search cache is required');
  if (!controlPlaneStore) throw new Error('control plane store is required');
  if (typeof searchByMediaFn !== 'function') throw new Error('searchByMedia function is required');

  function prepared(params) {
    return getPreparedDurableState({
      cache: searchCache,
      controlPlaneStore,
      mediaId: params.mediaId,
      mediaType: params.mediaType,
      season: params.season ?? null,
      episode: params.episode ?? null,
    });
  }

  async function resolve({ mediaId, mediaType, season = null, episode = null }) {
    if (!mediaId) return { status: 'invalid-input', reason: 'mediaId is required' };
    const fast = prepared({ mediaId, mediaType, season, episode });
    if (fast) {
      return {
        status: 'ok',
        reused: true,
        torrentFile: fast.torrentFile,
        torrentFileId: fast.torrentFileId,
        handoff: fast.handoff,
      };
    }
    let ensureFns = {};
    if (typeof buildEnsureFns === 'function') {
      try {
        ensureFns = (await buildEnsureFns()) || {};
      } catch {
        ensureFns = {};
      }
    }
    try {
      // The pipeline's native TV type is 'series' (explicit season /
      // episode params ride along); the prepared-state read accepts
      // either form. Never pass 'episode' into discovery.
      await searchByMediaFn(searchCache, {
        mediaId,
        mediaType: mediaType === 'episode' ? 'series' : mediaType,
        season,
        episode,
        prepareOnly: true,
        source: 'download-request',
        sourceType: 'operator',
        controlPlaneStore,
        ...ensureFns,
      });
    } catch (error) {
      return { status: 'unresolvable', reason: error?.message ?? 'discovery failed' };
    }
    const fresh = prepared({ mediaId, mediaType, season, episode });
    if (!fresh) {
      return { status: 'unresolvable', reason: 'no healthy TorrentFile after discovery' };
    }
    return {
      status: 'ok',
      reused: false,
      torrentFile: fresh.torrentFile,
      torrentFileId: fresh.torrentFileId,
      handoff: fresh.handoff,
    };
  }

  return { resolve };
}
