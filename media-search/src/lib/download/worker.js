/**
 * Download worker (download-intent tranche).
 *
 * Intent/destination policy over the SHARED materialization primitive
 * (lib/materialize/materialize.js) — the same sequential data-plane
 * read, .partial behavior, byte-count verification, sparse protection,
 * atomic rename, and restart recovery promotion uses. Do not fork.
 *
 * One bounded tick handles one intent: claim requested → resolve to an
 * exact TorrentFile (fast reuse or fresh prepare) → materialize into
 * the staging tree → staged. Staged rows are terminal and never
 * re-touched: if a downstream importer moves the file, the row stays
 * staged and nothing is recreated until a new intent arrives.
 */

import path from 'node:path';

import {
  materializeTorrentFile, discardStagingPartials, PARTIAL_SUFFIX,
} from '../materialize/materialize.js';
import { DOWNLOAD_STATUS } from './store.js';
import { resolveStagedTarget, isWithinRoot, STAGING_DIRNAME } from './paths.js';

export function createDownloadWorker({
  downloadStore,
  resolveFn,
  stagingRoot,
  dataPlaneBaseUrl,
  fetchFn = globalThis.fetch,
  log = () => {},
} = {}) {
  if (!downloadStore) throw new Error('download store is required');
  if (typeof resolveFn !== 'function') throw new Error('resolve function is required');
  if (!stagingRoot) throw new Error('staging root is required');
  if (!dataPlaneBaseUrl) throw new Error('data plane base URL is required');
  const stagingDir = path.join(stagingRoot, STAGING_DIRNAME);
  const inFlight = new Set();

  async function discardPartials() {
    return discardStagingPartials(stagingDir);
  }

  function stagedTargetFor(download, torrentFile, handoff = null) {
    return resolveStagedTarget({
      root: stagingRoot,
      mediaType: download.mediaType,
      title: handoff?.canonicalTitle ?? download.title ?? download.mediaId,
      year: handoff?.canonicalYear ?? download.year,
      season: download.season,
      episode: download.episode,
      internalPath: torrentFile.internalPath,
    });
  }

  async function processOne(download) {
    const id = download.downloadRequestId;
    if (inFlight.has(id)) return { status: 'in-flight', downloadRequestId: id };
    if (!downloadStore.claimResolving(id)) {
      return { status: 'already-claimed', downloadRequestId: id };
    }
    inFlight.add(id);
    try {
      const resolved = await resolveFn({
        mediaId: download.mediaId,
        mediaType: download.mediaType,
        season: download.season,
        episode: download.episode,
      });
      if (!resolved || resolved.status !== 'ok') {
        const failed = downloadStore.markFailed(id, resolved?.reason ?? 'unresolvable');
        return { status: 'failed', downloadRequestId: id, download: failed };
      }
      const { torrentFile, torrentFileId } = resolved;
      let stagedPath;
      try {
        stagedPath = stagedTargetFor(downloadStore.get(id), torrentFile, resolved.handoff ?? null);
      } catch (error) {
        const failed = downloadStore.markFailed(id, error?.message);
        return { status: 'failed', downloadRequestId: id, download: failed };
      }
      if (!isWithinRoot(stagingRoot, stagedPath)) {
        const failed = downloadStore.markFailed(id, 'staged path escapes owned root');
        return { status: 'failed', downloadRequestId: id, download: failed };
      }
      const materialized = downloadStore.markMaterializing(id, {
        torrentFileId,
        expectedSize: torrentFile.size,
        stagedPath,
      });
      void materialized;
      const result = await materializeTorrentFile({
        torrentFileId,
        size: torrentFile.size,
        finalPath: stagedPath,
        stagingDir,
        stagingName: `${id}${PARTIAL_SUFFIX}`,
        dataPlaneBaseUrl,
        fetchFn,
        onProgress: (bytesComplete) => downloadStore.noteProgress(id, bytesComplete),
        log,
      });
      if (!result.ok) {
        const failed = downloadStore.markFailed(id, result.error);
        log(`[download] failed ${id}: ${result.error}`);
        return { status: 'failed', downloadRequestId: id, download: failed };
      }
      const done = downloadStore.markStaged(id);
      log(`[download] staged ${id} (${torrentFile.size} bytes) -> ${stagedPath}`);
      return { status: 'staged', downloadRequestId: id, download: done, reused: !!resolved.reused };
    } finally {
      inFlight.delete(id);
    }
  }

  /** One bounded tick: claim and process a single requested intent. */
  async function tick() {
    const [next] = downloadStore.listClaimable(1);
    if (!next) return { status: 'idle' };
    return processOne(next);
  }

  return { tick, processOne, discardPartials };
}
