/**
 * Real-Debrid request-time durable ensure (RD-only fulfillment tranche).
 *
 * The RD equivalent of the TorBox ensure seam: given a ranked Release
 * candidate, establish (or reuse) a durable RD ProviderPlacement +
 * ProviderFile inventory + TorrentFile row that the request can bind.
 *
 * Safety contract (proven against the live API, not inferred):
 *  - Durable-first: a known healthy RD placement is revalidated with one
 *    bounded getTorrentInfo (no account writes at all).
 *  - Probes are hygienic: addMagnet creates a duplicate RD resource even
 *    for cached content, so EVERY probe resource this ensure creates that
 *    does not prove immediately-usable cached state is deleted in a
 *    finally-grade path (uncached, partial, mapping failure, timeout,
 *    exception, infringing).
 *  - Cached proof is authoritative: select ONLY the exactly-mapped file,
 *    then require status === 'downloaded'. Anything else is not cached.
 *  - Exact mapping only: movies via classifyCandidateToRdFile (fail
 *    closed on ambiguity); TV additionally requires the mapped RD path
 *    to carry the exact S/E tokens (no positional fallback).
 *  - No unrestricted links or runtime capabilities are persisted — only
 *    placement/file/TorrentFile identity truth.
 */

import { RdCooldownError } from './client.js';
import { classifyCandidateToRdFile } from './resolve.js';
import { canonicalizeRdPath } from '../../control-plane/rd-placement-realizer.js';

const HEX40 = /^[a-f0-9]{40}$/i;
const RD_PROVIDER_ID = 'realdebrid';

function isValidSize(n) {
  return Number.isSafeInteger(n) && n > 0;
}

function episodeTokensPresent(rdPath, season, episode) {
  // Numeric extraction over separator-normalized text. S01E02 has no
  // word boundary between any of its parts, so match pairs directly
  // plus standalone season/episode tokens (covers "S01 ... E02",
  // "Season 1", "1x02" layouts).
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

export function createRdEnsure({ store, client, now = () => Date.now(), log = () => {} } = {}) {
  if (!store) throw new Error('rd ensure requires store');
  const memo = new Map();
  // Request-scoped account snapshot: one bounded list call per ensure
  // lifetime, reused across candidates (mirrors the TorBox request-scoped
  // mylist memoization — never a full account-list download per verify).
  // Safe within a request: our own probe-created resources are found via
  // durable placement rows, which are read before this snapshot.
  let accountSnapshot = null;
  async function accountList(call) {
    if (!accountSnapshot) {
      accountSnapshot = await call(() => client.listTorrents({ limit: 100 }));
    }
    return accountSnapshot;
  }

  function errClass(err) {
    if (err instanceof RdCooldownError) return 'transient';
    const code = err?.code;
    const status = err?.status;
    const msg = String(err?.message || '');
    if (status === 401 || status === 403 || code === 'AUTH_ERROR') return 'hard';
    if (code === 'infringing' || err?.rdErrorCode === 35 || /infringing/i.test(msg)) return 'hard';
    if (code === 'invalid-input' || code === 'hash-mismatch') return 'hard';
    return 'transient';
  }

  async function cleanupQuietly(rdId) {
    if (!client || !rdId) return false;
    try {
      await client.deleteTorrent(rdId, { resolverSafe: true });
      return true;
    } catch {
      return false;
    }
  }

  async function run(infoHash, { filename = null, size = null, season = null, episode = null } = {}) {
    let apiCalls = 0;
    const call = async (fn) => {
      apiCalls += 1;
      return fn();
    };
    if (!HEX40.test(String(infoHash || ''))) {
      return { status: 'hard', reason: 'rd-invalid-hash', apiCalls };
    }
    const hash = String(infoHash).toLowerCase();
    if (!client) {
      return { status: 'hard', reason: 'rd-disabled', apiCalls };
    }
    const tv = Number.isSafeInteger(season) && season >= 0 && Number.isSafeInteger(episode) && episode >= 1;

    // --- 1. Durable-first: reuse a known RD placement (zero writes). ---
    let rdId = null;
    let createdByUs = false;
    try {
      const known = typeof store.findPlacementByInfoHash === 'function'
        ? store.findPlacementByInfoHash(RD_PROVIDER_ID, hash)
        : null;
      const knownId = known?.providerResourceId;
      if (typeof knownId === 'string' && knownId.trim() !== '') rdId = knownId.trim();
    } catch {
      rdId = null;
    }

    // --- 2. Account discovery: content already on the account (user-added,
    // grandfathered, or infringing-blocked for re-add) is usable WITHOUT
    // creating a duplicate resource. One bounded list call, exact-hash
    // filter; ambiguous multi-matches are tried in order below via info.
    // Never writes. Never deletes (foreign resources). When the account
    // holds the hash but no resource verifies usable, there is no point
    // probing a duplicate — report not-cached without writing.
    let accountHadIt = false;
    if (!rdId) {
      try {
        const list = await accountList(call);
        const matches = (Array.isArray(list) ? list : [])
          .filter((e) => String(e?.hash ?? '').trim().toLowerCase() === hash)
          .map((e) => String(e?.id ?? '').trim())
          .filter(Boolean);
        accountHadIt = matches.length > 0;
        for (const candId of matches.slice(0, 3)) {
          try {
            const info = await call(() => client.getTorrentInfo(candId, { resolverSafe: true }));
            if (String(info?.hash ?? '').trim().toLowerCase() === hash
              && Array.isArray(info?.files) && info.files.length > 0) {
              rdId = candId;
              break;
            }
          } catch {
            // Unreadable candidate: try the next match, if any.
          }
        }
        if (!rdId && accountHadIt) {
          return { status: 'not-cached', reason: 'rd-account-unusable', apiCalls };
        }
      } catch (err) {
        return { status: errClass(err), reason: `rd-list-failed:${errClass(err)}`, apiCalls };
      }
    }

    // --- 2. Probe: addMagnet (creates a duplicate resource by design). ---
    if (!rdId) {
      try {
        const added = await call(() => client.addMagnet(`magnet:?xt=urn:btih:${hash}`, { resolverSafe: true }));
        rdId = added?.id != null ? String(added.id) : null;
        createdByUs = !!rdId;
      } catch (err) {
        return { status: errClass(err), reason: `rd-add-failed:${errClass(err)}`, apiCalls };
      }
      if (!rdId) {
        return { status: 'transient', reason: 'rd-add-no-id', apiCalls };
      }
    }

    try {
      // --- 3. Verify hash + inventory (no selection yet, no transfer). ---
      const info = await call(() => client.getTorrentInfo(rdId, { resolverSafe: true }));
      const reported = String(info?.hash ?? '').trim().toLowerCase();
      if (reported !== hash) {
        if (createdByUs) await cleanupQuietly(rdId);
        return { status: 'hard', reason: 'rd-hash-mismatch', apiCalls, cleaned: createdByUs };
      }
      const files = Array.isArray(info?.files) ? info.files : [];
      if (files.length === 0) {
        if (createdByUs) await cleanupQuietly(rdId);
        return { status: 'not-cached', reason: 'rd-no-files', apiCalls, cleaned: createdByUs };
      }

      // --- 4. Exact file mapping (fail closed on ambiguity). ---
      const classification = classifyCandidateToRdFile(
        files.map((f) => ({ id: f.id, path: f.path, filename: f.path, bytes: f.bytes })),
        { filename, size },
      );
      if (!classification?.rdFileId) {
        if (createdByUs) await cleanupQuietly(rdId);
        return { status: 'not-cached', reason: `rd-mapping-failed:${classification?.classification ?? 'absent'}`, apiCalls, cleaned: createdByUs };
      }
      const mapped = files.find((f) => String(f.id) === String(classification.rdFileId));
      if (!mapped || !isValidSize(Number(mapped.bytes))) {
        if (createdByUs) await cleanupQuietly(rdId);
        return { status: 'not-cached', reason: 'rd-mapping-invalid-size', apiCalls, cleaned: createdByUs };
      }
      // TV: the mapped RD path must carry the exact S/E tokens. Basename
      // matching already encodes episode precision for well-formed names;
      // this is the backstop for size-only matches (no positional fallback).
      const root = canonicalizeRdPath(info.original_filename || info.filename || '');
      const frag = canonicalizeRdPath(mapped.path ?? '');
      const fullPath = root ? `${root}/${frag}` : frag;
      if (!fullPath) {
        if (createdByUs) await cleanupQuietly(rdId);
        return { status: 'not-cached', reason: 'rd-mapping-empty-path', apiCalls, cleaned: createdByUs };
      }
      if (tv && !episodeTokensPresent(fullPath, season, episode)) {
        if (createdByUs) await cleanupQuietly(rdId);
        return { status: 'not-cached', reason: 'rd-episode-unverifiable', apiCalls, cleaned: createdByUs };
      }

      // --- 5. Select ONLY the mapped file, then require downloaded. ---
      await call(() => client.selectFiles(rdId, [mapped.id], { resolverSafe: true }));
      const info2 = await call(() => client.getTorrentInfo(rdId, { resolverSafe: true }));
      if (String(info2?.status || '') !== 'downloaded') {
        if (createdByUs) await cleanupQuietly(rdId);
        return { status: 'not-cached', reason: `rd-not-downloaded:${String(info2?.status || 'unknown').slice(0, 40)}`, apiCalls, cleaned: createdByUs };
      }

      // --- 6. Persist durable truth (placement + inventory + TorrentFile). ---
      const placement = store.recordPlacement({
        infoHash: hash,
        provider: RD_PROVIDER_ID,
        accountScope: 'default',
        providerResourceId: rdId,
        state: 'ready',
        ownership: createdByUs ? 'owned' : 'reused',
        provenance: 'rd-request-ensure',
      });
      const mappedBase = String(mapped.path ?? '').split('/').filter(Boolean).pop()
        || String(filename ?? '').split('/').filter(Boolean).pop() || 'file';
      store.replaceProviderFileInventory(
        placement.id,
        (info2.files || []).map((f) => ({
          providerFileId: String(f.id),
          path: `${root ? `${root}/` : ''}${canonicalizeRdPath(f.path ?? '')}`,
          name: String(f.path ?? '').split('/').filter(Boolean).pop() || mappedBase,
          size: Number(f.bytes),
          selected: String(f.id) === String(mapped.id),
        })),
        { observedAt: now() },
      );
      const tf = typeof store.findTorrentFile === 'function'
        ? store.findTorrentFile(hash, fullPath)
        : null;
      if (!tf?.id) {
        if (createdByUs) await cleanupQuietly(rdId);
        return { status: 'hard', reason: 'rd-torrentfile-missing', apiCalls, cleaned: createdByUs };
      }
      log(`rd-ensure bound ${hash.slice(0, 12)} tf=${tf.id} rd=${rdId} calls=${apiCalls}`);
      return {
        status: 'ready',
        torrentFileId: tf.id,
        placementId: placement.id,
        providerFileId: String(mapped.id),
        size: Number(mapped.bytes),
        apiCalls,
        source: createdByUs ? 'probe' : 'durable',
      };
    } catch (err) {
      if (createdByUs) await cleanupQuietly(rdId);
      const cls = errClass(err);
      return { status: cls, reason: `rd-${cls}:${String(err?.message || err).slice(0, 80)}`, apiCalls, cleaned: createdByUs };
    }
  }

  async function ensure(args) {
    const key = String(args?.infoHash || '').toLowerCase();
    if (memo.has(key)) return memo.get(key);
    const r = await run(args?.infoHash, args);
    // Memoize terminal answers within the request lifetime; transient
    // failures stay retryable (a later candidate attempt re-probes).
    if (r.status === 'ready' || r.status === 'not-cached' || r.status === 'hard') memo.set(key, r);
    return r;
  }

  return { ensure };
}
