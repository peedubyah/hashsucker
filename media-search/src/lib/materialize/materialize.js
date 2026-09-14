/**
 * Shared exact-byte materialization primitive (download-intent tranche).
 *
 * Promotion and download are different intent/destination policies over
 * this ONE byte path — do not fork it. Both callers stream one exact
 * TorrentFile through the data plane's existing exact-byte authority
 * (GET /files/:tfId; TorBox + Real-Debrid abstracted in Rust), verify,
 * and atomically place the result.
 *
 * Flow: stream response into `<stagingDir>/<tfId>.partial` → count
 * bytes → exact-count gate → size/sparseness verification → atomic
 * rename to the final path. The final path is written ONLY after all
 * checks hold. Partials from a dead run are discarded, never resumed,
 * so a corrupt prefix cannot survive a restart.
 *
 * Verification (no invented checksums — no authoritative file hash
 * exists for the exact file): exact positive size match against the
 * durable TorrentFile size, complete streamed byte count, and a
 * non-sparse staged candidate (allocated blocks cover the size).
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
  const fail = async (error) => {
    try { await fsp.unlink(stagingPath); } catch { /* best effort */ }
    return { ok: false, error: String(error?.message ?? error), bytesComplete };
  };
  try {
    await fsp.mkdir(stagingDir, { recursive: true });
    // Fresh fetch every attempt: partials from a dead run are
    // discarded, never resumed, so a corrupt prefix cannot survive.
    try { await fsp.unlink(stagingPath); } catch { /* absent is fine */ }

    const url = `${dataPlaneBaseUrl.replace(/\/+$/, '')}/files/${encodeURIComponent(torrentFileId)}`;
    const response = await fetchFn(url, { headers: { accept: '*/*' } });
    if (!response.ok) {
      return fail(`data-plane fetch failed: HTTP ${response.status}`);
    }
    const handle = await fsp.open(stagingPath, 'w');
    try {
      for await (const chunk of response.body) {
        await handle.write(chunk);
        bytesComplete += chunk.length;
        if (typeof onProgress === 'function') {
          try { onProgress(bytesComplete); } catch { /* progress never fails the run */ }
        }
        if (bytesComplete > size) break;
      }
    } finally {
      await handle.close();
    }
    if (bytesComplete !== size) {
      return fail(`incomplete stream: got ${bytesComplete}, want ${size}`);
    }
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

/** Discard all orphan partials in a staging dir. Returns removed count. */
export async function discardStagingPartials(stagingDir) {
  let entries = [];
  try {
    entries = await fsp.readdir(stagingDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(PARTIAL_SUFFIX)) continue;
    try {
      await fsp.unlink(path.join(stagingDir, entry));
      removed += 1;
    } catch { /* best effort */ }
  }
  return removed;
}
