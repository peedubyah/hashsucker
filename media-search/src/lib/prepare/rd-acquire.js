/**
 * Real-Debrid prepare adapter — async acquisition beneath the neutral contract.
 *
 * Reuses the proven request-time ensure semantics (durable-first, hygienic
 * probes, exact-file mapping, fail closed) but splits them across time:
 * `acquire()` mints/keeps the resource and returns ACCEPTED while content
 * downloads; `poll()` re-observes readiness; `cancel()` cleans up. The
 * synchronous ensure (`ensure.js`) instead requires `downloaded`
 * immediately and deletes anything else — the two never interleave on one
 * resource (single-flight is per preparation row).
 *
 * Hard rules, same as ensure.js:
 * - exact path + exact positive size, or fail closed;
 * - TV requires S/E tokens on the mapped path;
 * - 451/content policy is (provider, Release)-scoped, never global, never
 *   route death, never representation;
 * - non-premium account is account capability, never route death;
 * - selectFiles chooses the mapped file ONLY (RD's selectivity is an
 *   execution capability, not a representation decision).
 */

import { RdCooldownError } from '../providers/realdebrid/client.js';
import { classifyCandidateToRdFile } from '../providers/realdebrid/resolve.js';
import { canonicalizeRdPath } from '../control-plane/rd-placement-realizer.js';

const HEX40 = /^[a-f0-9]{40}$/i;

function isValidSize(n) {
  return Number.isSafeInteger(n) && n > 0;
}

function episodeTokensPresent(rdPath, season, episode) {
  const norm = String(rdPath || '').replace(/[.\s_-]+/g, ' ');
  const s = Number(season), e = Number(episode);
  let m;
  const rePair = /\bS(\d{1,2})\s*E(\d{1,3})(?![0-9])/gi;
  while ((m = rePair.exec(norm)) !== null) {
    if (Number(m[1]) === s && Number(m[2]) === e) return true;
  }
  const seasons = new Set();
  const reS = /\bS(\d{1,2})(?![0-9])/gi;
  while ((m = reS.exec(norm)) !== null) seasons.add(Number(m[1]));
  const reWord = /\bseason\s*(\d{1,2})\b/gi;
  while ((m = reWord.exec(norm)) !== null) seasons.add(Number(m[1]));
  const reX = /\b(\d{1,2})x\d{1,3}\b/gi;
  while ((m = reX.exec(norm)) !== null) seasons.add(Number(m[1]));
  if (!seasons.has(s)) return false;
  const episodes = new Set();
  const reE = /\b(?:E|EP)(\d{1,3})(?![0-9])/gi;
  while ((m = reE.exec(norm)) !== null) episodes.add(Number(m[1]));
  const reEWord = /\bepisode\s*(\d{1,3})\b/gi;
  while ((m = reEWord.exec(norm)) !== null) episodes.add(Number(m[1]));
  return episodes.has(e);
}

function isTvCoord(season, episode) {
  return Number.isSafeInteger(season) && season >= 0 && Number.isSafeInteger(episode) && episode >= 1;
}

function classifyAddError(err) {
  if (err instanceof RdCooldownError) return { rateLimited: true };
  const code = err?.code;
  const status = err?.status;
  const msg = String(err?.message || '');
  const rdCode = err?.rdErrorCode;
  if (status === 401 || status === 403 || code === 'AUTH_ERROR') return { accountIneligible: true };
  if (code === 'infringing' || rdCode === 35 || /infringing/i.test(msg)) return { blocked: true };
  if (err?.category === 'rate-limit' || status === 429) return { rateLimited: true, retryAfterMs: err?.retryAfterMs ?? null };
  if (code === 'invalid-input' || code === 'hash-mismatch') return { retryable: false };
  return { retryable: true };
}

function fullRdPath(info, mappedPath) {
  const root = canonicalizeRdPath(info?.original_filename || info?.filename || '');
  const frag = canonicalizeRdPath(mappedPath ?? '');
  const fullPath = root ? `${root}/${frag}` : frag;
  return fullPath || null;
}

export function createRdPrepareAdapter({ store, client, now = () => Date.now(), log = () => {} } = {}) {
  if (!store) throw new Error('rd prepare adapter requires store');

  /**
   * Account gate (Part 26): premium/non-premium decides whether acquisition
   * may even be attempted. Pure read; the caller memoizes briefly.
   * Returns { eligible:boolean, reason } — never throws.
   */
  async function checkAccount() {
    if (!client) return { eligible: false, reason: 'rd-disabled' };
    try {
      const me = await client.validateAccount();
      const type = String(me?.type ?? '').toLowerCase();
      if (type && type !== 'premium') {
        return { eligible: false, reason: `account-type:${type}` };
      }
      return { eligible: true, reason: 'premium' };
    } catch (err) {
      return { eligible: false, reason: `account-unreadable:${err?.code ?? err?.status ?? 'unknown'}` };
    }
  }

  /**
   * Map one RD file tree to the exact target file. Shared by acquire (fresh
   * tree) and poll (re-observed tree) so mapping can never drift between
   * the two. Returns { rdFileId, path, size } or { error }.
   */
  function mapTargetFile(info, { filename = null, size = null, season = null, episode = null } = {}) {
    const files = Array.isArray(info?.files) ? info.files : [];
    if (files.length === 0) return { error: 'rd-no-files' };
    const classification = classifyCandidateToRdFile(
      files.map((f) => ({ id: f.id, path: f.path, filename: f.path, bytes: f.bytes })),
      { filename, size },
    );
    if (!classification?.rdFileId) {
      return { error: `rd-mapping-failed:${classification?.classification ?? 'absent'}` };
    }
    const mapped = files.find((f) => String(f.id) === String(classification.rdFileId));
    if (!mapped || !isValidSize(Number(mapped.bytes))) {
      return { error: 'rd-mapping-invalid-size' };
    }
    if (size != null && Number.isSafeInteger(Number(size)) && Number(mapped.bytes) !== Number(size)) {
      return { error: 'rd-exact-file-size-mismatch' };
    }
    const fullPath = fullRdPath(info, mapped.path);
    if (!fullPath) return { error: 'rd-mapping-empty-path' };
    if (isTvCoord(season, episode) && !episodeTokensPresent(fullPath, season, episode)) {
      return { error: 'rd-episode-unverifiable' };
    }
    return { rdFileId: String(mapped.id), path: fullPath, size: Number(mapped.bytes) };
  }

  async function cleanupQuietly(rdId, createdByUs) {
    if (!client || !rdId || !createdByUs) return false;
    try {
      await client.deleteTorrent(rdId, { resolverSafe: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Begin acquisition: durable-first reuse, account discovery, else probe
   * addMagnet + immediate tree mapping + selectFiles to START the download.
   * Never waits for readiness here; never deletes a started download.
   * Returns adapter-shape result for toPrepareOutcome().
   */
  async function acquire({ infoHash, filename = null, size = null, season = null, episode = null }) {
    let apiCalls = 0;
    const call = async (fn) => { apiCalls += 1; return fn(); };
    if (!HEX40.test(String(infoHash || ''))) return { retryable: false, apiCalls };
    if (!client) return { accountIneligible: true, apiCalls };
    const hash = String(infoHash).toLowerCase();

    // 1. Durable-first: a known placement needs no provider work.
    // (The driver checks placement truth before calling; this is the
    // belt-and-suspenders re-read for races.)
    try {
      const known = typeof store.findPlacementByInfoHash === 'function'
        ? store.findPlacementByInfoHash('realdebrid', hash)
        : null;
      if (known?.providerResourceId) {
        return { present: true, providerResourceId: String(known.providerResourceId).trim(), apiCalls };
      }
    } catch { /* fall through to discovery */ }

    // 2. Account discovery (read-only, bounded): reuse account-held content.
    try {
      const list = await call(() => client.listTorrents({ limit: 100 }));
      const matches = (Array.isArray(list) ? list : [])
        .filter((e) => String(e?.hash ?? '').trim().toLowerCase() === hash)
        .map((e) => String(e?.id ?? '').trim())
        .filter(Boolean);
      for (const candId of matches.slice(0, 3)) {
        try {
          const info = await call(() => client.getTorrentInfo(candId, { resolverSafe: true }));
          if (String(info?.hash ?? '').trim().toLowerCase() !== hash) continue;
          if (String(info?.status || '') === 'downloaded') {
            const mapped = mapTargetFile(info, { filename, size, season, episode });
            if (!mapped.error) {
              return {
                ready: true, accepted: true, providerResourceId: candId,
                status: 'downloaded', files: info.files, mapped, apiCalls,
              };
            }
          }
        } catch { /* next match */ }
      }
    } catch (err) {
      return { ...classifyAddError(err), apiCalls };
    }

    // 3. Probe addMagnet (creates a resource by design).
    let rdId = null;
    try {
      const added = await call(() => client.addMagnet(`magnet:?xt=urn:btih:${hash}`, { resolverSafe: true }));
      rdId = added?.id != null ? String(added.id) : null;
    } catch (err) {
      return { ...classifyAddError(err), apiCalls };
    }
    if (!rdId) return { retryable: true, apiCalls };

    // 4. Immediate tree mapping (metadata is usually instant post-add).
    try {
      const info = await call(() => client.getTorrentInfo(rdId, { resolverSafe: true }));
      if (String(info?.hash ?? '').trim().toLowerCase() !== hash) {
        await cleanupQuietly(rdId, true);
        return { retryable: false, apiCalls, cleaned: true };
      }
      const mapped = mapTargetFile(info, { filename, size, season, episode });
      if (mapped.error) {
        // Fail closed, but do NOT delete yet when the tree simply has not
        // resolved (empty file list right after add): the poll path will
        // re-map on every observation until the deadline.
        if (mapped.error === 'rd-no-files') {
          return { accepted: true, providerResourceId: rdId, status: String(info?.status || 'unknown'), files: [], apiCalls };
        }
        await cleanupQuietly(rdId, true);
        return { retryable: false, apiCalls, cleaned: true, detail: mapped.error };
      }
      // 5. Select ONLY the mapped file: starts the download, nothing else.
      await call(() => client.selectFiles(rdId, [mapped.rdFileId], { resolverSafe: true }));
      const info2 = await call(() => client.getTorrentInfo(rdId, { resolverSafe: true }));
      const status = String(info2?.status || '');
      if (status === 'downloaded') {
        return { ready: true, accepted: true, providerResourceId: rdId, status, files: info2.files, mapped, apiCalls };
      }
      return { accepted: true, providerResourceId: rdId, status, files: info2.files, mapped, apiCalls };
    } catch (err) {
      await cleanupQuietly(rdId, true);
      return { ...classifyAddError(err), apiCalls, cleaned: true };
    }
  }

  /**
   * Re-observe one in-flight resource. Never writes except selectFiles when
   * the mapped file is still unselected (safe: same single file).
   */
  async function poll({ providerResourceId, filename = null, size = null, season = null, episode = null }) {
    let apiCalls = 0;
    if (!client || !providerResourceId) return { retryable: false, apiCalls };
    try {
      const info = await (async () => { apiCalls += 1; return client.getTorrentInfo(providerResourceId, { resolverSafe: true }); })();
      const status = String(info?.status || '');
      if (status === 'downloaded') {
        const mapped = mapTargetFile(info, { filename, size, season, episode });
        if (mapped.error) return { retryable: false, apiCalls, detail: mapped.error };
        // Ensure the mapped file is the selected one (idempotent).
        try {
          apiCalls += 1;
          await client.selectFiles(providerResourceId, [mapped.rdFileId], { resolverSafe: true });
        } catch { /* selection state is best-effort; readiness decides */ }
        return { ready: true, accepted: true, status, files: info.files, mapped, apiCalls };
      }
      if (status === 'magnet_error' || status === 'error' || status === 'virus' || status === 'dead') {
        return { retryable: false, apiCalls, detail: `rd-status:${status}` };
      }
      const mapped = mapTargetFile(info, { filename, size, season, episode });
      return {
        accepted: true, status,
        progress: info?.progress ?? null,
        files: info?.files ?? [],
        mapped: mapped.error ? null : mapped,
        apiCalls,
      };
    } catch (err) {
      const status = err?.status;
      if (status === 404) return { retryable: false, apiCalls, detail: 'rd-resource-gone' };
      return { ...classifyAddError(err), apiCalls };
    }
  }

  async function cancel({ providerResourceId, createdByUs = true } = {}) {
    if (!client || !providerResourceId) return false;
    try {
      await client.deleteTorrent(providerResourceId, { resolverSafe: true });
      return true;
    } catch {
      return false;
    }
  }

  return { provider: 'realdebrid', checkAccount, acquire, poll, cancel, mapTargetFile };
}
