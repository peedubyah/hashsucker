/**
 * P19 — Real-Debrid automatic placement realization.
 *
 * Closes the RD half of the placement lifecycle so that a real RD torrent
 * already present in the account produces, through the NORMAL Node /
 * control-plane lifecycle:
 *
 *     real RD observation
 *       -> exact durable TorrentFile identity (infoHash + canonicalInternalPath + exact positive size)
 *       -> ProviderPlacement
 *       -> ProviderFile
 *       -> S-1 coordinate
 *
 * without the one-off operator script
 * (src/scripts/p13a-realize-rd-placement.js, which required manual
 * --rd-torrent-id and --tf-id arguments).
 *
 * WHAT IS REUSED (no new machinery)
 *   - providers/realdebrid/client.js  — the existing RD REST client
 *   - control-plane/store.js          — recordPlacement(),
 *                                       replaceProviderFileInventory(),
 *                                       findPlacementByInfoHash(),
 *                                       listDataPlaneCoordinates()
 *
 * IDENTITY RULES (never violated)
 *   A TorrentFile is only ever matched by BOTH
 *     1. exact canonical internal path, and
 *     2. exact positive size.
 *   File index, filename-only, and size-only matching are never used. The
 *   RD inventory itself is the sole source of the provider file identity,
 *   taken from GET /torrents/info/{id}.
 *
 * NEGATIVE CONTRACTS
 *   - No synthetic rows: every row written is derived from a live RD response.
 *   - No bulk account scan loop: at most ONE bounded GET /torrents request,
 *     hard-capped by `lookupLimit`, with no offset/pagination loop.
 *   - No duplicate TorrentFile identities: replaceProviderFileInventory()
 *     dedups on (infoHash, canonical path) and reuses the existing row.
 *   - No duplicate placements: recordPlacement() upserts on
 *     (provider, account_scope, provider_resource_id).
 *   - No DeliveryCapability persistence: nothing here writes delivery
 *     capability or a restricted/unrestricted URL.
 *   - TorBox path unchanged: this module is purely additive and never
 *     touches a torbox placement, file, or coordinate.
 *
 * BOUNDED API WORK
 *   Worst case per realization: 2 RD calls (1 list + 1 info). When a durable
 *   RD resource id is already known the list call is skipped entirely
 *   (1 call). When a fresh S-1 RD coordinate already exists, ZERO calls.
 */

import { createRealDebridClient } from '../providers/realdebrid/client.js';

export const RD_PROVIDER_ID = 'realdebrid';
export const RD_REALIZER_PROVENANCE = 'rd-placement-realizer';

const HEX40 = /^[0-9a-f]{40}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOOKUP_LIMIT = 100;
const MAX_LOOKUP_LIMIT = 5000;

/** RD status -> provider_placements.state. Mirrors realdebrid/placement.js. */
const RD_STATE_MAP = Object.freeze({
  downloaded: 'ready',
  magnet_conversion: 'pending',
  waiting_files_selection: 'pending',
  queued: 'pending',
  downloading: 'pending',
  compressing: 'pending',
  uploading: 'pending',
  error: 'failed',
  dead: 'failed',
  virus: 'failed',
});

/**
 * Canonicalize an RD path fragment. RD reports file paths with a leading
 * "/" and the torrent root lives in `original_filename`; TorBox (and
 * therefore torrent_files.internal_path) carries the full torrent-relative
 * path. Stripping the leading separator is what makes the two comparable.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalizeRdPath(value) {
  const s = String(value ?? '');
  if (s.startsWith('/')) return s.slice(1);
  if (s.startsWith('./')) return s.slice(2);
  return s;
}

function normalizeInfoHash(value) {
  const h = String(value ?? '').trim().toLowerCase();
  if (!HEX40.test(h)) throw new TypeError(`invalid infoHash: ${value}`);
  return h;
}

function isValidSize(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * @param {Object} options
 * @param {Object} options.store - Control-plane store.
 * @param {Object} [options.client] - Injected RD client (tests).
 * @param {string} [options.apiKey] - RD API key; falls back to env.
 * @param {string} [options.accountScope='default']
 * @param {Function} [options.now]
 * @param {number} [options.ttlMs] - Placement/inventory freshness TTL.
 * @param {number} [options.lookupLimit] - Hard cap on the single /torrents page.
 * @param {Function} [options.logger]
 */
export function createRdPlacementRealizer({
  store,
  client = null,
  apiKey = process.env.REALDEBRID_API_KEY ?? null,
  accountScope = 'default',
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  lookupLimit = DEFAULT_LOOKUP_LIMIT,
  logger = null,
} = {}) {
  if (!store || typeof store.recordPlacement !== 'function'
    || typeof store.replaceProviderFileInventory !== 'function') {
    throw new TypeError('rd-placement-realizer requires a control-plane store');
  }
  const log = logger ?? (() => {});
  const boundedLimit = Math.min(Math.max(1, Math.trunc(Number(lookupLimit) || DEFAULT_LOOKUP_LIMIT)), MAX_LOOKUP_LIMIT);
  const rd = client ?? (apiKey ? createRealDebridClient({ apiKey }) : null);

  // Single-flight: two concurrent materializations for the same infoHash
  // must issue exactly one realization.
  const inFlight = new Map();

  const isEnabled = () => rd != null;

  /**
   * Durable-first resource-id resolution. If we already know the RD torrent
   * id for this infoHash, reuse it — that removes the list call entirely and
   * is what makes repeat observation idempotent and cheap.
   */
  function knownResourceId(infoHash) {
    if (typeof store.findPlacementByInfoHash !== 'function') return null;
    const placement = store.findPlacementByInfoHash(RD_PROVIDER_ID, infoHash);
    const id = placement?.providerResourceId;
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
  }

  /**
   * Bounded discovery. ONE request, no offset, no pagination loop.
   * Returns { status, id?, ids? }.
   */
  async function discoverResourceId(infoHash) {
    const list = await rd.listTorrents({ limit: boundedLimit });
    if (!Array.isArray(list)) return { status: 'absent' };
    const matches = list.filter(
      (entry) => String(entry?.hash ?? '').trim().toLowerCase() === infoHash,
    );
    if (matches.length === 0) return { status: 'absent' };
    const ids = matches.map((m) => String(m?.id ?? '').trim()).filter(Boolean);
    const unique = [...new Set(ids)];
    if (unique.length !== 1) return { status: 'ambiguous', ids: unique };
    return { status: 'found', id: unique[0] };
  }

  /**
   * Authoritative inventory for one RD torrent. Verifies the infoHash so we
   * can never bind a TorrentFile to a different torrent.
   */
  async function fetchVerifiedInfo(rdId, infoHash) {
    const info = await rd.getTorrentInfo(rdId);
    if (!info || typeof info !== 'object') {
      return { status: 'unavailable' };
    }
    const reported = String(info.hash ?? '').trim().toLowerCase();
    if (reported !== infoHash) {
      return { status: 'hash-mismatch', reported };
    }
    if (!Array.isArray(info.files) || info.files.length === 0) {
      return { status: 'no-files' };
    }
    return { status: 'ok', info };
  }

  /**
   * Exact identity match: canonical internal path AND exact positive size.
   * Never file index, never filename-only, never size-only.
   */
  function matchExactFile(info, torrentFile) {
    const expectedPath = canonicalizeRdPath(torrentFile.internalPath);
    const expectedSize = torrentFile.size;
    const root = canonicalizeRdPath(info.original_filename || info.filename || '');

    const exact = [];
    for (const file of info.files) {
      if (!file || typeof file !== 'object') continue;
      if (!isValidSize(Number(file.bytes))) continue;
      const fragment = canonicalizeRdPath(file.path ?? '');
      const fullPath = root ? `${root}/${fragment}` : fragment;
      if (fullPath !== expectedPath) continue;
      if (Number(file.bytes) !== expectedSize) continue;
      exact.push({ file, fullPath });
    }

    if (exact.length === 1) {
      return {
        status: 'matched',
        file: exact[0].file,
        fullPath: exact[0].fullPath,
        root,
      };
    }
    if (exact.length === 0) {
      return {
        status: 'no-exact-match',
        root,
        expectedPath,
        expectedSize,
        candidates: info.files.map((f) => ({
          id: f?.id ?? null,
          path: root ? `${root}/${canonicalizeRdPath(f?.path ?? '')}` : canonicalizeRdPath(f?.path ?? ''),
          bytes: f?.bytes ?? null,
        })),
      };
    }
    return { status: 'ambiguous', count: exact.length, root, expectedPath };
  }

  /**
   * Realize (or refresh) the RD placement + provider file for one durable
   * TorrentFile. Idempotent: repeat calls repair rather than duplicate.
   *
   * @param {Object} torrentFile - { id, infoHash, internalPath, size }
   * @returns {Promise<Object>} Structured result; never throws for provider faults.
   */
  async function realizeForTorrentFile(torrentFile) {
    if (!torrentFile || typeof torrentFile !== 'object') {
      return { status: 'invalid-input', reason: 'torrentFile is required' };
    }
    if (!torrentFile.id) {
      return { status: 'invalid-input', reason: 'torrentFile.id is required' };
    }
    let infoHash;
    try {
      infoHash = normalizeInfoHash(torrentFile.infoHash);
    } catch (error) {
      return { status: 'invalid-input', reason: error.message };
    }
    if (!isValidSize(torrentFile.size)) {
      return { status: 'invalid-input', reason: `torrentFile.size must be a positive safe integer, got ${torrentFile.size}` };
    }
    if (!torrentFile.internalPath || String(torrentFile.internalPath).trim() === '') {
      return { status: 'invalid-input', reason: 'torrentFile.internalPath is required' };
    }
    if (!isEnabled()) {
      return { status: 'disabled', reason: 'Real-Debrid client is not configured' };
    }

    const observedAt = now();
    const expiresAt = observedAt + ttlMs;

    // --- 1. Resolve the RD torrent id (at most one bounded list call) ---
    let rdId = knownResourceId(infoHash);
    let idSource = rdId ? 'durable' : null;
    let apiCalls = 0;

    if (!rdId) {
      let discovery;
      try {
        apiCalls += 1;
        discovery = await discoverResourceId(infoHash);
      } catch (error) {
        log(`[rd-realize] list failed for ${infoHash.slice(0, 12)}: ${error.message}`);
        return { status: 'provider-error', operation: 'torrents-list', reason: error.message, apiCalls };
      }
      if (discovery.status !== 'found') {
        // No row is written. An absent/ambiguous RD torrent is a fact, not
        // a synthetic placement.
        return { status: discovery.status, infoHash, apiCalls, ids: discovery.ids ?? null };
      }
      rdId = discovery.id;
      idSource = 'discovered';
    }

    // --- 2. Authoritative inventory + hash verification ---
    let verified;
    try {
      apiCalls += 1;
      verified = await fetchVerifiedInfo(rdId, infoHash);
    } catch (error) {
      log(`[rd-realize] info failed for rd=${rdId}: ${error.message}`);
      return { status: 'provider-error', operation: 'torrents-info', rdId, reason: error.message, apiCalls };
    }
    if (verified.status !== 'ok') {
      return { status: verified.status, rdId, apiCalls, reported: verified.reported ?? null };
    }
    const info = verified.info;

    // --- 3. Exact identity match: path AND size ---
    const match = matchExactFile(info, torrentFile);
    if (match.status !== 'matched') {
      log(`[rd-realize] no exact identity match rd=${rdId} tf=${torrentFile.id}: ${match.status}`);
      return { status: match.status, rdId, apiCalls, detail: match };
    }

    // --- 4. Placement upsert (repair, never duplicate) ---
    const rdStatus = String(info.status ?? '');
    const placement = store.recordPlacement({
      provider: RD_PROVIDER_ID,
      accountScope,
      infoHash,
      providerResourceId: rdId,
      state: RD_STATE_MAP[rdStatus] ?? 'unknown',
      // We did not place this torrent; it already existed on the account.
      ownership: 'external',
      ownerKey: null,
      provenance: RD_REALIZER_PROVENANCE,
      observedAt,
      expiresAt,
    });

    // --- 5. Inventory replace (dedups to the existing TorrentFile) ---
    const matchedFile = match.file;
    const files = [{
      providerFileId: String(matchedFile.id),
      path: match.fullPath,
      name: match.fullPath.split('/').filter(Boolean).pop(),
      size: Number(matchedFile.bytes),
      selected: matchedFile.selected === 1,
      corpusFileIndex: Number(matchedFile.id),
      evidence: {
        source: RD_REALIZER_PROVENANCE,
        rdTorrentId: rdId,
        rdStatus,
        rdOriginalBytes: info.original_bytes ?? null,
        rdBytes: info.bytes ?? null,
        matchedBy: 'exact-path-and-exact-size',
      },
    }];
    const inventory = store.replaceProviderFileInventory(placement.id, files, {
      authoritative: true,
      // Siblings that have no durable TorrentFile are deliberately not
      // materialized, so this snapshot is intentionally partial.
      complete: false,
      expiresAt,
      evidence: {
        source: RD_REALIZER_PROVENANCE,
        rdTorrentId: rdId,
        siblingCount: Math.max(0, info.files.length - 1),
      },
    });

    const mapped = inventory.find((pf) => pf.torrentFileId === torrentFile.id) ?? null;

    return {
      status: 'realized',
      infoHash,
      torrentFileId: torrentFile.id,
      rdId,
      idSource,
      apiCalls,
      placementId: placement.id,
      providerFileId: String(matchedFile.id),
      mappingState: mapped?.mappingState ?? null,
      mappedTorrentFileId: mapped?.torrentFileId ?? null,
      rdStatus,
      placementState: placement.state,
    };
  }

  /**
   * True when S-1 already exposes a fresh RD coordinate for this TorrentFile.
   * Used to keep the warm materialization path free of RD API calls.
   */
  function hasFreshCoordinate(torrentFile, at = now()) {
    if (typeof store.listDataPlaneCoordinates !== 'function') return false;
    const coords = store.listDataPlaneCoordinates(torrentFile.id) ?? [];
    return coords.some((c) => c.provider === RD_PROVIDER_ID
      && (!Number.isSafeInteger(c.expiresAt) || c.expiresAt > at));
  }

  /** Awaited realization, coalesced per (torrentFileId). */
  function ensureRealization(torrentFile) {
    const key = String(torrentFile?.id ?? '');
    if (!key) return Promise.resolve({ status: 'invalid-input', reason: 'torrentFile.id is required' });
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = (async () => {
      try {
        if (hasFreshCoordinate(torrentFile)) {
          return { status: 'skipped-fresh', torrentFileId: key, apiCalls: 0 };
        }
        return await realizeForTorrentFile(torrentFile);
      } catch (error) {
        log(`[rd-realize] unexpected failure for ${key}: ${error.message}`);
        return { status: 'error', torrentFileId: key, reason: error.message };
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, task);
    return task;
  }

  /**
   * Non-blocking trigger for the materialization path. Never rejects and
   * never delays playback; a realization failure only costs an RD coordinate.
   */
  function kickRealization(torrentFile) {
    if (!isEnabled()) return;
    if (!torrentFile?.id) return;
    if (hasFreshCoordinate(torrentFile)) return;
    void ensureRealization(torrentFile).catch((error) => {
      log(`[rd-realize] background realization failed for ${torrentFile.id}: ${error.message}`);
    });
  }

  return Object.freeze({
    provider: RD_PROVIDER_ID,
    isEnabled,
    realizeForTorrentFile,
    ensureRealization,
    kickRealization,
    hasFreshCoordinate,
    knownResourceId,
  });
}

/**
 * Build a realizer bound to the process environment, or null when RD is not
 * configured. Materialization uses this so an unconfigured deployment is a
 * no-op rather than an error.
 */
export function createDefaultRdPlacementRealizer(store, options = {}) {
  if (!process.env.REALDEBRID_API_KEY && !options.client) return null;
  return createRdPlacementRealizer({ store, ...options });
}
