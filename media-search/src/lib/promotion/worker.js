/**
 * Promotion worker (promotion tranche, Phases 5/6/9).
 *
 * Byte acquisition reuses the SHARED materialization primitive
 * (lib/materialize/materialize.js): one sequential data-plane read with
 * exact Range resume, verification, and atomic placement. Promotion is
 * one intent/destination policy over that primitive; download intents are
 * the other. Do not fork this implementation.
 *
 * Failure leaves provider-backed playback untouched: promotion is
 * additive until the permanent row commits.
 */

import path from 'node:path';

import {
  materializeTorrentFile, discardStagingPartials, verifyStagedFile,
} from '../materialize/materialize.js';
import { isWithinRoot, STAGING_DIRNAME } from './paths.js';
import { PROMOTION_STATUS } from './store.js';
import { classifyJobFailure, recordJobFailure } from '../lifecycle/job-retry.js';

export { verifyStagedFile };

export function createPromotionWorker({
  promotionStore,
  dataPlaneBaseUrl,
  permanentRoot,
  fetchFn = globalThis.fetch,
  log = () => {},
} = {}) {
  if (!promotionStore) throw new Error('promotion store is required');
  if (!dataPlaneBaseUrl) throw new Error('data plane base URL is required');
  if (!permanentRoot) throw new Error('permanent storage root is required');
  const stagingDir = path.join(permanentRoot, STAGING_DIRNAME);
  const inFlight = new Set();

  async function discardPartials() {
    return discardStagingPartials(stagingDir);
  }

  async function materializeOne(promotion) {
    const { torrentFileId, size, permanentPath } = promotion;
    const failJob = (classification, error) => {
      const recorded = recordJobFailure(promotionStore, torrentFileId, classification, error);
      if (recorded.outcome === 'retry') {
        log(`[promotion] retry ${torrentFileId} attempt=${recorded.row.attempts} next=${new Date(recorded.row.nextDueAt).toISOString()} (${classification.category})`);
        return { status: 'retry_wait', torrentFileId, promotion: recorded.row };
      }
      log(`[promotion] failed ${torrentFileId}: ${String(error?.message ?? error).slice(0, 120)}`);
      return { status: 'failed', torrentFileId, promotion: recorded.row };
    };
    if (!isWithinRoot(permanentRoot, permanentPath)) {
      return failJob(
        classifyJobFailure({ stage: 'target', error: 'permanent path escapes owned root' }),
        'permanent path escapes owned root');
    }
    if (inFlight.has(torrentFileId)) return { status: 'in-flight', torrentFileId };
    if (!promotionStore.claimMaterializing(torrentFileId)) {
      return { status: 'already-claimed', torrentFileId };
    }
    inFlight.add(torrentFileId);
    try {
      const result = await materializeTorrentFile({
        torrentFileId,
        size,
        finalPath: permanentPath,
        stagingDir,
        dataPlaneBaseUrl,
        fetchFn,
        onProgress: (bytesComplete) => promotionStore.noteProgress(torrentFileId, bytesComplete),
        log,
      });
      if (!result.ok) {
        return failJob(classifyJobFailure({ stage: 'materialize', error: result.error }), result.error);
      }
      promotionStore.markVerifying(torrentFileId, result.bytesComplete);
      const done = promotionStore.markPermanent(torrentFileId);
      log(`[promotion] permanent ${torrentFileId} (${size} bytes) -> ${permanentPath}`);
      return { status: 'permanent', torrentFileId, promotion: done };
    } finally {
      inFlight.delete(torrentFileId);
    }
  }

  /** One bounded tick: claim and materialize a single requested row. */
  async function tick() {
    const [next] = promotionStore.listClaimable(1);
    if (!next) return { status: 'idle' };
    if (next.status === PROMOTION_STATUS.PERMANENT) return { status: 'idle' };
    return materializeOne(next);
  }

  return { tick, materializeOne, discardPartials };
}
