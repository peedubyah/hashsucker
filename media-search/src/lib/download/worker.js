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
import { classifyJobFailure, recordJobFailure } from '../lifecycle/job-retry.js';
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

  /** Record a failure with bounded retry: transient schedules, permanent
   * (or exhausted budget) goes terminal. Returns the worker outcome. */
  function failJob(id, classification, error) {
    const recorded = recordJobFailure(downloadStore, id, classification, error);
    if (recorded.outcome === 'retry') {
      log(`[download] retry ${id} attempt=${recorded.row.attempts} next=${new Date(recorded.row.nextDueAt).toISOString()} (${classification.category}: ${String(error?.message ?? error).slice(0, 100)})`);
      return { status: 'retry_wait', downloadRequestId: id, download: recorded.row };
    }
    log(`[download] failed ${id}: ${String(error?.message ?? error).slice(0, 120)}`);
    return { status: 'failed', downloadRequestId: id, download: recorded.row };
  }

  async function processOne(download) {
    const id = download.downloadRequestId;
    if (inFlight.has(id)) return { status: 'in-flight', downloadRequestId: id };
    if (!downloadStore.claimResolving(id)) {
      return { status: 'already-claimed', downloadRequestId: id };
    }
    inFlight.add(id);
    try {
      let resolved;
      try {
        resolved = await resolveFn({
          mediaId: download.mediaId,
          mediaType: download.mediaType,
          season: download.season,
          episode: download.episode,
          qualityProfile: download.qualityProfile ?? null,
        });
      } catch (error) {
        // Previously an uncaught throw stranded the row in resolving
        // until boot recovery. Now it classifies (fail-closed transient)
        // and retries boundedly.
        return failJob(id, classifyJobFailure({ stage: 'unexpected', error }), error);
      }
      if (!resolved || resolved.status !== 'ok') {
        const reason = resolved?.reason ?? 'unresolvable';
        return failJob(id, classifyJobFailure({ stage: 'resolve', error: reason }), reason);
      }
      const { torrentFile, torrentFileId } = resolved;
      let stagedPath;
      try {
        stagedPath = stagedTargetFor(downloadStore.get(id), torrentFile, resolved.handoff ?? null);
      } catch (error) {
        return failJob(id, classifyJobFailure({ stage: 'target', error }), error?.message);
      }
      if (!isWithinRoot(stagingRoot, stagedPath)) {
        return failJob(id, classifyJobFailure({ stage: 'target', error: 'staged path escapes owned root' }), 'staged path escapes owned root');
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
        return failJob(id, classifyJobFailure({ stage: 'materialize', error: result.error }), result.error);
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
