/**
 * Promotion worker (promotion tranche, Phases 5/6/9).
 *
 * Byte acquisition reuses the SHARED materialization primitive
 * (lib/materialize/materialize.js): one full sequential read of the
 * data plane's GET /files/:tfId — no Range games, no provider-specific
 * download code, no second downloader. Promotion is one
 * intent/destination policy over that primitive; download intents are
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
    if (!isWithinRoot(permanentRoot, permanentPath)) {
      promotionStore.markFailed(torrentFileId, 'permanent path escapes owned root');
      return { status: 'failed', torrentFileId };
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
        const failed = promotionStore.markFailed(torrentFileId, result.error);
        log(`[promotion] failed ${torrentFileId}: ${result.error}`);
        return { status: 'failed', torrentFileId, promotion: failed };
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
