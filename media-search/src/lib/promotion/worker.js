/**
 * Promotion worker (promotion tranche, Phases 5/6/9).
 *
 * Byte acquisition reuses HashSucker's existing exact-byte authority:
 * the Rust data plane already resolves one exact TorrentFile to
 * provider bytes behind GET /files/:tfId (S-1 control projection from
 * Node truth; TorBox + Real-Debrid abstracted inside Rust). The worker
 * performs one full sequential read of that endpoint — no Range games,
 * no provider-specific download code, no second downloader.
 *
 * Flow: claim requested row → stream response into
 * `<root>/.staging/<tfId>.partial` → count bytes → verify →
 * atomic rename to the final path → mark permanent.
 *
 * Verification (no invented checksums — no authoritative file hash
 * exists for the exact file): exact positive size match against the
 * durable TorrentFile size, complete streamed byte count, and a
 * non-sparse final candidate (allocated blocks cover the size).
 * Rename happens only after all three hold.
 *
 * Failure leaves provider-backed playback untouched: promotion is
 * additive until the permanent row commits.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { isWithinRoot, resolveStagingTarget, STAGING_DIRNAME } from './paths.js';
import { PROMOTION_STATUS } from './store.js';

function isValidSize(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Verify a staged candidate: exact size, complete count, non-sparse.
 * Returns { ok, reason? }. Pure on the filesystem; no network.
 */
export async function verifyStagedFile(stagedPath, expectedSize) {
  if (!isValidSize(expectedSize)) return { ok: false, reason: 'invalid-expected-size' };
  let stat;
  try {
    stat = await fsp.stat(stagedPath);
  } catch {
    return { ok: false, reason: 'staged-file-missing' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'staged-not-a-file' };
  if (stat.size !== expectedSize) {
    return { ok: false, reason: `size-mismatch: got ${stat.size}, want ${expectedSize}` };
  }
  // Non-sparse gate: allocated 512-byte blocks must cover the size.
  // A sparse/incomplete final file would report fewer blocks.
  const allocated = Number(stat.blocks ?? 0) * 512;
  if (allocated < expectedSize) {
    return { ok: false, reason: `sparse-file: ${allocated} allocated bytes for ${expectedSize}` };
  }
  return { ok: true };
}

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
  const inFlight = new Set();

  async function discardPartials() {
    const staging = path.join(permanentRoot, STAGING_DIRNAME);
    let entries = [];
    try {
      entries = await fsp.readdir(staging);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.partial')) continue;
      try {
        await fsp.unlink(path.join(staging, entry));
        removed += 1;
      } catch { /* best effort */ }
    }
    return removed;
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
    const stagingPath = resolveStagingTarget(permanentRoot, torrentFileId);
    try {
      await fsp.mkdir(path.dirname(stagingPath), { recursive: true });
      // Fresh fetch every attempt: partials from a dead run are
      // discarded, never resumed, so a corrupt prefix cannot survive.
      try { await fsp.unlink(stagingPath); } catch { /* absent is fine */ }

      const url = `${dataPlaneBaseUrl.replace(/\/+$/, '')}/files/${encodeURIComponent(torrentFileId)}`;
      const response = await fetchFn(url, { headers: { accept: '*/*' } });
      if (!response.ok) {
        throw new Error(`data-plane fetch failed: HTTP ${response.status}`);
      }
      const handle = await fsp.open(stagingPath, 'w');
      let bytesComplete = 0;
      try {
        for await (const chunk of response.body) {
          await handle.write(chunk);
          bytesComplete += chunk.length;
          if (bytesComplete > size) break;
        }
      } finally {
        await handle.close();
      }
      if (bytesComplete !== size) {
        throw new Error(`incomplete stream: got ${bytesComplete}, want ${size}`);
      }
      promotionStore.markVerifying(torrentFileId, bytesComplete);

      const verdict = await verifyStagedFile(stagingPath, size);
      if (!verdict.ok) throw new Error(`verification failed: ${verdict.reason}`);

      await fsp.mkdir(path.dirname(permanentPath), { recursive: true });
      await fsp.rename(stagingPath, permanentPath);
      const done = promotionStore.markPermanent(torrentFileId);
      log(`[promotion] permanent ${torrentFileId} (${size} bytes) -> ${permanentPath}`);
      return { status: 'permanent', torrentFileId, promotion: done };
    } catch (error) {
      try { await fsp.unlink(stagingPath); } catch { /* best effort */ }
      const failed = promotionStore.markFailed(torrentFileId, error?.message);
      log(`[promotion] failed ${torrentFileId}: ${error?.message}`);
      return { status: 'failed', torrentFileId, promotion: failed };
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
