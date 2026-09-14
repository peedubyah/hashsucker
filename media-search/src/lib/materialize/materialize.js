/**
 * Shared exact-byte materialization primitive (download-intent tranche).
 *
 * Promotion and download are different intent/destination policies over
 * this ONE byte path — do not fork it. Both callers stream one exact
 * TorrentFile through the data plane's existing exact-byte authority
 * (GET /files/:tfId; TorBox + Real-Debrid abstracted in Rust), verify,
 * and atomically place the result.
 *
 * Flow: preserve a contiguous `<stagingDir>/<tfId>.partial` prefix → request
 * the remaining bytes with an exact HTTP Range → exact-count gate →
 * size/sparseness verification → atomic rename to the final path. The
 * final path is written ONLY after all checks hold.
 *
 * Verification (no invented checksums — no authoritative file hash exists
 * for the exact file): exact positive size match against the durable
 * TorrentFile size, complete streamed byte count, and a non-sparse staged
 * candidate (allocated blocks cover the size).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export const PARTIAL_SUFFIX = '.partial';

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

function stagingPathFor(stagingDir, torrentFileId, stagingName = null) {
  const name = stagingName ?? `${torrentFileId}${PARTIAL_SUFFIX}`;
  if (!torrentFileId || /[/\\]/.test(String(torrentFileId))) {
    throw new Error('valid torrentFileId is required');
  }
  // Staging names are worker-chosen but never path escapes: basename only.
  const safe = String(name).split('/').pop().split('\\').pop();
  if (!safe || safe !== String(name)) throw new Error('staging name must be a plain filename');
  return path.join(stagingDir, safe);
}

/**
 * Materialize one exact TorrentFile to finalPath.
 *
 * @returns {{ ok: true, bytesComplete: number } |
 *           { ok: false, error: string, bytesComplete: number }}
 * Never throws for fetch/verify failures (returned as ok:false);
 * throws only for programmer errors (bad identity/paths).
 */
export async function materializeTorrentFile({
  torrentFileId,
  size,
  finalPath,
  stagingDir,
  stagingName = null,
  dataPlaneBaseUrl,
  fetchFn = globalThis.fetch,
  onProgress = null,
  log = () => {},
} = {}) {
  if (!torrentFileId) throw new Error('torrentFileId is required');
  if (!isValidSize(size)) throw new Error('positive TorrentFile size is required');
  if (!finalPath) throw new Error('finalPath is required');
  if (!stagingDir) throw new Error('stagingDir is required');
  if (!dataPlaneBaseUrl) throw new Error('data plane base URL is required');
  const stagingPath = stagingPathFor(stagingDir, torrentFileId, stagingName);
  let bytesComplete = 0;
  let lastProgress = 0;
  const reportProgress = () => {
    if (typeof onProgress !== 'function') return;
    if (bytesComplete !== size && bytesComplete - lastProgress < 1024 * 1024) return;
    lastProgress = bytesComplete;
    try { onProgress(bytesComplete); } catch { /* progress never fails the run */ }
  };
  const fail = async (error) => ({
    ok: false,
    error: String(error?.message ?? error),
    bytesComplete,
  });
  try {
    await fsp.mkdir(stagingDir, { recursive: true });
    let partialStat;
    try {
      partialStat = await fsp.stat(stagingPath);
      if (!partialStat.isFile()) {
        await fsp.unlink(stagingPath);
        partialStat = null;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') return fail(error);
    }
    bytesComplete = partialStat?.size ?? 0;
    if (bytesComplete > size) {
      await fsp.unlink(stagingPath);
      bytesComplete = 0;
    }
    if (bytesComplete > 0 && Number(partialStat?.blocks ?? 0) * 512 < bytesComplete) {
      await fsp.unlink(stagingPath);
      bytesComplete = 0;
    }
    reportProgress();
    if (bytesComplete === size) {
      const verdict = await verifyStagedFile(stagingPath, size);
      if (!verdict.ok) {
        await fsp.unlink(stagingPath);
        return fail(`verification failed: ${verdict.reason}`);
      }
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      await fsp.rename(stagingPath, finalPath);
      log(`[materialize] ${torrentFileId} (${size} bytes) -> ${finalPath}`);
      return { ok: true, bytesComplete };
    }

    const url = `${dataPlaneBaseUrl.replace(/\/+$/, '')}/files/${encodeURIComponent(torrentFileId)}`;
    const headers = { accept: '*/*' };
    if (bytesComplete > 0) headers.range = `bytes=${bytesComplete}-`;
    const response = await fetchFn(url, { headers });
    if (!response.ok) return fail(`data-plane fetch failed: HTTP ${response.status}`);
    if (bytesComplete > 0) {
      if (response.status !== 206) return fail(`range resume requires HTTP 206, got ${response.status}`);
      const contentRange = response.headers?.get?.('content-range') ?? response.headers?.['content-range'];
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(contentRange ?? ''));
      if (!match || Number(match[1]) !== bytesComplete || Number(match[3]) !== size) {
        return fail(`invalid Content-Range for resume at ${bytesComplete}: ${contentRange ?? 'missing'}`);
      }
    }
    if (!response.body) return fail('data-plane response has no body');
    const handle = await fsp.open(stagingPath, bytesComplete > 0 ? 'a' : 'w');
    try {
      for await (const chunk of response.body) {
        const remaining = size - bytesComplete;
        if (chunk.length > remaining) return fail(`response exceeds expected size: got chunk ${chunk.length}, remaining ${remaining}`);
        await handle.write(chunk);
        bytesComplete += chunk.length;
        reportProgress();
      }
    } finally {
      await handle.close();
    }
    if (bytesComplete !== size) return fail(`incomplete stream: got ${bytesComplete}, want ${size}`);
    const verdict = await verifyStagedFile(stagingPath, size);
    if (!verdict.ok) return fail(`verification failed: ${verdict.reason}`);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    await fsp.rename(stagingPath, finalPath);
    log(`[materialize] ${torrentFileId} (${size} bytes) -> ${finalPath}`);
    return { ok: true, bytesComplete };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Remove only explicitly identified orphan partials. Callers must supply
 * names that are not associated with a durable intent; an empty allowlist
 * intentionally preserves all restart residue for later association.
 */
export async function discardStagingPartials(stagingDir, { orphanNames = [] } = {}) {
  let removed = 0;
  for (const name of orphanNames) {
    if (!String(name).endsWith(PARTIAL_SUFFIX)) continue;
    try {
      await fsp.unlink(path.join(stagingDir, String(name)));
      removed += 1;
    } catch { /* best effort */ }
  }
  return removed;
}
