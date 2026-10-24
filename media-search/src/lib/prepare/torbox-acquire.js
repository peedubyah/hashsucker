/**
 * TorBox prepare adapter — async acquisition beneath the neutral contract.
 *
 * TorBox semantics, stated honestly (no file-select fiction):
 * - `createtorrent` with `addOnlyIfCached:false` starts a WHOLE-torrent
 *   download. There is no per-file selection; a 100 GB season pack
 *   downloads 100 GB to play one episode. The adapter reports this, it
 *   does not hide it.
 * - Readiness comes from `mylist?id=` download states. There is no
 *   progressive-streaming endpoint: assume full download required.
 * - Cleanup is `controltorrent` delete.
 * - Exact path + exact positive size mapping is mandatory (fail closed),
 *   same bar as the RD adapter. TV S/E tokens enforced like ensure.js.
 */

import { getTorBoxTorrent, controlTorBoxTorrent, createTorBoxProvider } from '../providers/torbox.js';
import { PROVIDER_CAPABILITIES } from '../providers/capabilities.js';

const HEX40 = /^[a-f0-9]{40}$/i;

function isValidSize(n) {
  return Number.isSafeInteger(n) && n > 0;
}

function readyState(raw) {
  const s = String(raw ?? '').toLowerCase().replaceAll(' ', '_');
  if (['cached', 'completed', 'downloaded', 'ready', 'seeding', 'uploading'].includes(s)) return 'ready';
  if (['queued', 'checking_resume_data', 'downloading', 'meta_downloading', 'pending', 'checking'].includes(s)) return 'pending';
  if (['error', 'failed'].includes(s)) return 'error';
  return 'unknown';
}

function episodeTokensPresent(tbPath, season, episode) {
  const norm = String(tbPath || '').replace(/[.\s_-]+/g, ' ');
  const s = Number(season), e = Number(episode);
  let m;
  const rePair = /\bS(\d{1,2})\s*E(\d{1,3})(?![0-9])/gi;
  while ((m = rePair.exec(norm)) !== null) {
    if (Number(m[1]) === s && Number(m[2]) === e) return true;
  }
  return false;
}

function isTvCoord(season, episode) {
  return Number.isSafeInteger(season) && season >= 0 && Number.isSafeInteger(episode) && episode >= 1;
}

function authFailure(err) {
  const status = err?.status;
  const category = err?.category;
  return status === 401 || status === 403 || category === 'authentication' || category === 'authorization';
}

export function createTorBoxPrepareAdapter({ apiKey, fetchFn = fetch, timeoutMs, createPlacementFn = null, now = () => Date.now(), log = () => {} } = {}) {
  // Placement creation goes through the ONE existing construction path
  // (provider surface → PLACEMENT_CREATE capability), only with acquisition
  // allowed. Injectable for tests; production passes the real surface.
  async function doCreatePlacement(magnet) {
    if (typeof createPlacementFn === 'function') {
      return createPlacementFn({ magnet, addOnlyIfCached: false });
    }
    const provider = createTorBoxProvider({ apiKey, fetchFn, timeoutMs });
    return provider.require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE).createPlacement({
      magnet,
      addOnlyIfCached: false,
    });
  }
  async function checkAccount() {
    if (!apiKey) return { eligible: false, reason: 'torbox-disabled' };
    // TorBox documents no add-gate by tier; endpoint failures map
    // per-call. A cheap mylist read proves the credential works.
    try {
      const { checkTorBoxCached } = await import('./torbox.js');
      await checkTorBoxCached(['00'.repeat(20)], { apiKey, fetchFn, timeoutMs });
      return { eligible: true, reason: 'credential-ok' };
    } catch (err) {
      if (authFailure(err)) return { eligible: false, reason: 'account-ineligible' };
      return { eligible: true, reason: 'credential-unverified' };
    }
  }

  /**
   * Map one TorBox file tree to the exact target file. Shared by acquire
   * and poll so mapping can never drift between the two.
   */
  function mapTargetFile(files, { filename = null, size = null, season = null, episode = null } = {}) {
    const list = Array.isArray(files) ? files : [];
    if (list.length === 0) return { error: 'tb-no-files' };
    const norm = (f) => ({
      id: String(f?.id ?? f?.file_id ?? ''),
      path: String(f?.name ?? f?.path ?? ''),
      size: Number(f?.size ?? f?.bytes ?? NaN),
    });
    const named = list.map(norm).filter((f) => f.id && f.path && isValidSize(f.size));
    if (named.length === 0) return { error: 'tb-no-mappable-files' };
    let picked = null;
    if (named.length === 1) {
      picked = named[0];
      if (size != null && Number.isSafeInteger(Number(size)) && picked.size !== Number(size)) {
        return { error: 'tb-exact-file-size-mismatch' };
      }
    } else {
      const base = (p) => p.split('/').filter(Boolean).pop().toLowerCase();
      const wantBase = filename ? String(filename).split('/').filter(Boolean).pop().toLowerCase() : null;
      const byName = wantBase ? named.filter((f) => base(f.path) === wantBase) : [];
      const pool = byName.length > 0 ? byName : named;
      const bySize = size != null ? pool.filter((f) => f.size === Number(size)) : [];
      const winners = bySize.length > 0 ? bySize : (wantBase && byName.length === 1 ? byName : []);
      if (winners.length !== 1) return { error: 'tb-mapping-ambiguous' };
      picked = winners[0];
    }
    if (isTvCoord(season, episode) && !episodeTokensPresent(picked.path, season, episode)) {
      return { error: 'tb-episode-unverifiable' };
    }
    return { rdFileId: picked.id, providerFileId: picked.id, path: picked.path, size: picked.size };
  }

  async function cleanupQuietly(torrentId, createdByUs) {
    if (!apiKey || !torrentId || !createdByUs) return false;
    try {
      return await controlTorBoxTorrent(torrentId, 'delete', { apiKey, fetchFn, timeoutMs });
    } catch {
      return false;
    }
  }

  async function acquire({ infoHash, magnet = null, filename = null, size = null, season = null, episode = null }) {
    let apiCalls = 0;
    if (!HEX40.test(String(infoHash || ''))) return { retryable: false, apiCalls };
    if (!apiKey) return { accountIneligible: true, apiCalls };
    const hash = String(infoHash).toLowerCase();
    const mg = magnet || `magnet:?xt=urn:btih:${hash}`;

    // 1. Durable-first is the driver's job (existing placement check
    // before adapter selection). This adapter always mints.
    // 2. Create with acquisition allowed (NOT cache-only).
    let torrentId = null;
    try {
      const res = await doCreatePlacement(mg);
      torrentId = res?.providerResourceId ?? null;
      apiCalls += 1;
    } catch (err) {
      if (authFailure(err)) return { accountIneligible: true, apiCalls };
      if (err?.code === 'RATE_LIMITED' || err?.category === 'rate-limit' || err?.status === 429) {
        return { rateLimited: true, apiCalls };
      }
      return { retryable: true, apiCalls, detail: String(err?.message ?? err).slice(0, 120) };
    }
    if (!torrentId) return { retryable: true, apiCalls };

    // 3. Immediate tree mapping (metadata is usually instant post-add).
    try {
      apiCalls += 1;
      const t = await getTorBoxTorrent(torrentId, { apiKey, fetchFn, timeoutMs });
      if (!t) {
        await cleanupQuietly(torrentId, true);
        return { retryable: false, apiCalls, cleaned: true };
      }
      const state = readyState(t.download_state ?? t.state ?? t.status);
      const mapped = mapTargetFile(t.files, { filename, size, season, episode });
      if (mapped.error) {
        if (state === 'pending' && (t.files ?? []).length === 0) {
          // Tree not resolved yet — poll path re-maps until deadline.
          return { accepted: true, providerResourceId: String(torrentId), status: state, files: [], apiCalls };
        }
        await cleanupQuietly(torrentId, true);
        return { retryable: false, apiCalls, cleaned: true, detail: mapped.error };
      }
      if (state === 'ready') {
        return { ready: true, accepted: true, providerResourceId: String(torrentId), status: state, files: t.files, mapped, apiCalls };
      }
      if (state === 'error') {
        await cleanupQuietly(torrentId, true);
        return { retryable: false, apiCalls, cleaned: true, detail: 'tb-status-error' };
      }
      return { accepted: true, providerResourceId: String(torrentId), status: state, files: t.files ?? [], mapped, apiCalls };
    } catch (err) {
      await cleanupQuietly(torrentId, true);
      if (authFailure(err)) return { accountIneligible: true, apiCalls, cleaned: true };
      return { retryable: true, apiCalls, cleaned: true };
    }
  }

  async function poll({ providerResourceId, filename = null, size = null, season = null, episode = null }) {
    let apiCalls = 0;
    if (!apiKey || !providerResourceId) return { retryable: false, apiCalls };
    try {
      apiCalls += 1;
      const t = await getTorBoxTorrent(providerResourceId, { apiKey, fetchFn, timeoutMs });
      if (!t) return { retryable: false, apiCalls, detail: 'tb-resource-gone' };
      const state = readyState(t.download_state ?? t.state ?? t.status);
      if (state === 'ready') {
        const mapped = mapTargetFile(t.files, { filename, size, season, episode });
        if (mapped.error) return { retryable: false, apiCalls, detail: mapped.error };
        return { ready: true, accepted: true, status: state, files: t.files, mapped, apiCalls };
      }
      if (state === 'error') return { retryable: false, apiCalls, detail: 'tb-status-error' };
      const mapped = mapTargetFile(t.files, { filename, size, season, episode });
      return {
        accepted: true, status: state,
        progress: t.progress ?? null,
        files: t.files ?? [],
        mapped: mapped.error ? null : mapped,
        apiCalls,
      };
    } catch (err) {
      if (authFailure(err)) return { accountIneligible: true, apiCalls };
      return { retryable: true, apiCalls };
    }
  }

  async function cancel({ providerResourceId, createdByUs = true } = {}) {
    if (!apiKey || !providerResourceId) return false;
    try {
      return await controlTorBoxTorrent(providerResourceId, 'delete', { apiKey, fetchFn, timeoutMs });
    } catch {
      return false;
    }
  }

  return { provider: 'torbox', checkAccount, acquire, poll, cancel, mapTargetFile };
}
