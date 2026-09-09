/**
 * T7 — proactive second-placement readiness for the same exact TorrentFile.
 *
 * Adapted from the proven HY4 P2F helper on m3-north-db. Lets Node ensure
 * that a TorrentFile has a second durable provider placement available
 * *before* it is needed, so Rust can later warm/use a cross-provider
 * standby without inventing provider state itself. This slice is about
 * durable placement readiness, not scheduler behavior — nothing here
 * pre-opens a DeliveryCapability and nothing here calls prewarm.
 *
 * WHAT IS REUSED (no new machinery)
 *   - control-plane/store.js — getTorrentFile(),
 *     findPlacementByInfoHash(), recordPlacement(),
 *     replaceProviderFileInventory(),
 *     recordPlacementLookupObservation(). The store's UNIQUE constraints
 *     ((provider,account_scope,provider_resource_id),
 *     (placement_id,provider_file_id)) are what make repeat calls
 *     idempotent at the durable layer.
 *   - TorBox cached-only creation semantics (durable-first, passive
 *     recovery, addOnlyIfCached, ambiguous-timeout recovery lookup).
 *     No delivery URL, no file-mapping tables, no VFS binding here.
 *   - Real-Debrid discovery semantics: durable-first knownResourceId,
 *     one bounded list call, hash-verified info, exact path+size match.
 *     Creation (addMagnet/selectFiles/bounded poll) uses only the
 *     existing realdebrid client surface.
 *
 * IDENTITY RULES (never violated)
 *   - The TorrentFile is resolved from durable Node truth by id, and every
 *     placement/file row is bound by exact (infoHash, canonical path, exact
 *     positive size). A provider torrent for any OTHER hash is filtered
 *     out and can never satisfy the request.
 *   - Release/TorrentFile rows are never mutated (reuse-or-conflict inside
 *     replaceProviderFileInventory); no ranking, discovery, binding,
 *     exposure, candidate-mapping, or VFS writes.
 *   - Nothing here persists a DeliveryCapability or calls unrestrict /
 *     requestdl.
 *
 * PROVIDER ASYMMETRY (explicit, not faked)
 *   - TorBox creation is cached-only: if the account lacks the torrent AND
 *     it is not in the TorBox cache, the result is `unavailable` — we
 *     refuse to manufacture an uncached download.
 *   - Real-Debrid creation via addMagnet creates real account state (the
 *     torrent is added; only the exact matched file id is selected to
 *     keep the footprint minimal). If it is not downloaded within the
 *     bounded poll, a truthful `pending` placement anchor is persisted so
 *     repeats resume instead of duplicating, and the result reports it.
 *
 * BOUNDED API WORK (worst case per ensure call)
 *   - TorBox: mylist lookup (1) + checkcached (1) + create (1) + recovery
 *     lookup on ambiguous create error (1) + inventory (1) = 5 calls; any
 *     durable-first hit skips its whole phase (already_ready = 0 calls).
 *   - Real-Debrid: list (1) + info (1) + addMagnet (1) + selectFiles (1) +
 *     bounded info polls (<= maxAttempts) = 5 + maxAttempts calls.
 *
 * PRODUCTION ADAPTATION vs the proven source: this store has no
 * listDataPlaneCoordinates reader, so provider presence is derived from
 * existing APIs — one live placement per provider via
 * findPlacementByInfoHash plus a present+mapped provider_files row for
 * this exact TorrentFile (the same predicate the store SQL encodes).
 * Everything else is verbatim proven behavior.
 */

const HEX40 = /^[0-9a-f]{40}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOOKUP_LIMIT = 100;
const RD_POLL_MAX_ATTEMPTS = 10;
const RD_POLL_DELAY_MS = 2000;

const PROVIDERS = Object.freeze(['torbox', 'realdebrid']);

/** RD status -> provider_placements.state. Mirrors rd-placement-realizer. */
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

function normalizeInfoHash(value) {
  const h = String(value ?? '').trim().toLowerCase();
  if (!HEX40.test(h)) throw new TypeError(`invalid infoHash: ${value}`);
  return h;
}

function isValidSize(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function stripLeadingSlash(value) {
  const s = String(value ?? '');
  if (s.startsWith('/')) return s.slice(1);
  if (s.startsWith('./')) return s.slice(2);
  return s;
}

/**
 * @param {Object} options
 * @param {Object} options.store - Control-plane store.
 * @param {Object|null} [options.torbox] - { createPlacement({magnet,addOnlyIfCached}), checkCached(hashes)->{cached:Set}, lookupPlacement({infoHash}), getFileInventory(placement) }.
 * @param {Object|null} [options.realdebrid] - RD client { listTorrents({limit}), getTorrentInfo(id), addMagnet(magnet), selectFiles(id, ids) }.
 * @param {string} [options.accountScope='default']
 * @param {Function} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.lookupLimit]
 * @param {Object} [options.rdPoll] - { maxAttempts, delayMs, sleep }
 * @param {Function} [options.logger]
 */
export function createSecondPlacementEnsurer({
  store,
  torbox = null,
  realdebrid = null,
  accountScope = 'default',
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  lookupLimit = DEFAULT_LOOKUP_LIMIT,
  rdPoll = {},
  logger = null,
} = {}) {
  if (!store || typeof store.getTorrentFile !== 'function'
    || typeof store.findPlacementByInfoHash !== 'function'
    || typeof store.recordPlacement !== 'function'
    || typeof store.replaceProviderFileInventory !== 'function') {
    throw new TypeError('second-placement requires a control-plane store');
  }
  const log = logger ?? (() => {});
  const poll = {
    maxAttempts: Math.max(1, Math.trunc(Number(rdPoll.maxAttempts) || RD_POLL_MAX_ATTEMPTS)),
    delayMs: Math.max(0, Number(rdPoll.delayMs ?? RD_POLL_DELAY_MS)),
    sleep: typeof rdPoll.sleep === 'function' ? rdPoll.sleep : ((ms) => new Promise((r) => setTimeout(r, ms))),
  };

  // Single-flight per TorrentFile: concurrent ensures for the same id
  // share one execution (prevents duplicate account-side torrents).
  const inFlight = new Map();

  // Provider presence from existing readers: one live (non-removed)
  // placement per provider plus a present+mapped provider_files row
  // binding it to this exact TorrentFile. `lookupLimit` is accepted for
  // interface parity with the proven helper and is unused here.
  void lookupLimit;
  function presentProviders(torrentFileId, infoHash) {
    const refs = typeof store.listProviderRefsForTorrentFile === 'function'
      ? store.listProviderRefsForTorrentFile(torrentFileId) ?? []
      : [];
    const present = new Set();
    for (const provider of PROVIDERS) {
      const placement = typeof store.findPlacementByInfoHash === 'function'
        ? store.findPlacementByInfoHash(provider, infoHash)
        : null;
      if (!placement) continue;
      const bound = refs.find((r) => r.placementId === placement.id
        && r.present !== false && r.mappingState === 'mapped');
      if (!bound) continue;
      present.add(String(provider).toLowerCase());
    }
    return { present };
  }

  function observeLookup({ provider, infoHash, state, placementId, observedAt, expiresAt, source }) {
    if (typeof store.recordPlacementLookupObservation !== 'function') return;
    try {
      store.recordPlacementLookupObservation({
        provider, accountScope, infoHash,
        observationState: state, placementId: placementId ?? null,
        observedAt, expiresAt, source,
      });
    } catch (error) {
      log(`[second-placement] lookup observation skipped: ${error.message}`);
    }
  }

  /**
   * Exact file verdict from durable truth: the mapped, present provider
   * file row for THIS TorrentFile under the given placement. The store —
   * not string comparison here — is the authority on mapping.
   */
  function mappedFileFor(placementId, torrentFileId) {
    const refs = typeof store.listProviderRefsForTorrentFile === 'function'
      ? store.listProviderRefsForTorrentFile(torrentFileId) ?? []
      : [];
    return refs.find((r) => r.placementId === placementId && r.present !== false
      && r.mappingState === 'mapped') ?? null;
  }

  function persistInventory(placementId, files, evidence) {
    return store.replaceProviderFileInventory(placementId, files, {
      authoritative: true,
      complete: false,
      expiresAt: now() + ttlMs,
      evidence,
    });
  }

  // ---- TorBox ensure (cached-only creation) ----
  async function ensureTorBox(torrentFile, infoHash) {
    let apiCalls = 0;
    const observedAt = now();
    const expiresAt = observedAt + ttlMs;
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;

    // Durable-first: reuse what we already recorded.
    let placement = store.findPlacementByInfoHash('torbox', infoHash);
    if (placement) {
      try {
        apiCalls += 1;
        const inventory = await torbox.getFileInventory({
          provider: 'torbox', accountScope, providerResourceId: placement.providerResourceId,
        });
        persistInventory(placement.id, inventory.files, {
          source: 'second-placement', providerResourceId: placement.providerResourceId,
        });
      } catch (error) {
        return { status: 'provider-error', operation: 'file-inventory', reason: error.message, apiCalls };
      }
      const mapped = mappedFileFor(placement.id, torrentFile.id);
      if (mapped) {
        return { status: 'created', provider: 'torbox', idSource: 'durable', apiCalls, placementId: placement.id, providerFileId: mapped.providerFileId };
      }
      return { status: 'failed', reason: 'no-exact-match', apiCalls, placementId: placement.id };
    }

    // Passive recovery: an account placement we never recorded.
    try {
      apiCalls += 1;
      const observed = await torbox.lookupPlacement({ infoHash });
      if (observed) {
        placement = store.recordPlacement({
          provider: 'torbox', accountScope, infoHash,
          providerResourceId: observed.providerResourceId,
          state: observed.state ?? 'unknown',
          ownership: observed.ownership ?? 'external',
          ownerKey: observed.ownerKey ?? null,
          provenance: 'second-placement',
          observedAt, expiresAt,
        });
        observeLookup({ provider: 'torbox', infoHash, state: 'present', placementId: placement.id, observedAt, expiresAt, source: 'second-placement' });
        try {
          apiCalls += 1;
          const inventory = await torbox.getFileInventory({
            provider: 'torbox', accountScope, providerResourceId: placement.providerResourceId,
          });
          persistInventory(placement.id, inventory.files, {
            source: 'second-placement', providerResourceId: placement.providerResourceId,
          });
        } catch (error) {
          return { status: 'provider-error', operation: 'file-inventory', reason: error.message, apiCalls, placementId: placement.id };
        }
        const mapped = mappedFileFor(placement.id, torrentFile.id);
        if (mapped) {
          return { status: 'created', provider: 'torbox', idSource: 'recovered', apiCalls, placementId: placement.id, providerFileId: mapped.providerFileId };
        }
        return { status: 'failed', reason: 'no-exact-match', apiCalls, placementId: placement.id };
      }
    } catch (error) {
      return { status: 'provider-error', operation: 'placement-lookup', reason: error.message, apiCalls };
    }

    // Cached-only creation gate: never manufacture an uncached download.
    let cached = false;
    try {
      apiCalls += 1;
      const checked = await torbox.checkCached([infoHash]);
      cached = checked?.cached?.has?.(infoHash) === true;
    } catch (error) {
      return { status: 'provider-error', operation: 'checkcached', reason: error.message, apiCalls };
    }
    if (!cached) {
      observeLookup({ provider: 'torbox', infoHash, state: 'missing', placementId: null, observedAt, expiresAt, source: 'second-placement' });
      return { status: 'unavailable', reason: 'not-cached', apiCalls };
    }

    // Create (cached → instant, ready, no download) with one ambiguous-
    // timeout recovery lookup, mirroring torbox-delivery.
    let created;
    try {
      apiCalls += 1;
      created = await torbox.createPlacement({ magnet, addOnlyIfCached: true });
    } catch (error) {
      try {
        apiCalls += 1;
        const observed = await torbox.lookupPlacement({ infoHash });
        if (!observed) throw error;
        placement = store.recordPlacement({
          provider: 'torbox', accountScope, infoHash,
          providerResourceId: observed.providerResourceId,
          state: observed.state ?? 'unknown',
          ownership: observed.ownership ?? 'external',
          ownerKey: observed.ownerKey ?? null,
          provenance: 'second-placement',
          observedAt, expiresAt,
        });
      } catch {
        return { status: 'failed', operation: 'create-placement', reason: error.message, apiCalls };
      }
    }
    if (!placement) {
      placement = store.recordPlacement({
        provider: 'torbox', accountScope, infoHash,
        providerResourceId: String(created.providerResourceId),
        state: 'ready',
        ownership: 'owned',
        ownerKey: `second-placement-${observedAt}`,
        provenance: 'second-placement',
        observedAt, expiresAt,
      });
    }
    observeLookup({ provider: 'torbox', infoHash, state: 'present', placementId: placement.id, observedAt, expiresAt, source: 'second-placement' });
    try {
      apiCalls += 1;
      const inventory = await torbox.getFileInventory({
        provider: 'torbox', accountScope, providerResourceId: placement.providerResourceId,
      });
      persistInventory(placement.id, inventory.files, {
        source: 'second-placement', providerResourceId: placement.providerResourceId,
      });
    } catch (error) {
      return { status: 'provider-error', operation: 'file-inventory', reason: error.message, apiCalls, placementId: placement.id };
    }
    const mapped = mappedFileFor(placement.id, torrentFile.id);
    if (mapped) {
      return { status: 'created', provider: 'torbox', idSource: 'added', apiCalls, placementId: placement.id, providerFileId: mapped.providerFileId };
    }
    return { status: 'failed', reason: 'no-exact-match', apiCalls, placementId: placement.id };
  }

  // ---- Real-Debrid ensure (discover, else bounded addMagnet flow) ----
  function matchRdFile(info, torrentFile) {
    const expectedPath = stripLeadingSlash(torrentFile.internalPath);
    const expectedSize = torrentFile.size;
    const root = stripLeadingSlash(info.original_filename || info.filename || '');
    const exact = [];
    for (const file of info.files ?? []) {
      if (!file || typeof file !== 'object') continue;
      if (!Number.isSafeInteger(Number(file.bytes)) || Number(file.bytes) <= 0) continue;
      const fullPath = root ? `${root}/${stripLeadingSlash(file.path ?? '')}` : stripLeadingSlash(file.path ?? '');
      if (fullPath !== expectedPath) continue;
      if (Number(file.bytes) !== expectedSize) continue;
      exact.push({ file, fullPath });
    }
    if (exact.length === 1) return { status: 'matched', file: exact[0].file, fullPath: exact[0].fullPath };
    if (exact.length === 0) return { status: 'no-exact-match' };
    return { status: 'ambiguous', count: exact.length };
  }

  function persistRdPlacement({ rdId, rdStatus, owned, observedAt, expiresAt, info, matchedFile, fullPath }) {
    const placement = store.recordPlacement({
      provider: 'realdebrid', accountScope, infoHash: normalizeInfoHash(info.hash),
      providerResourceId: String(rdId),
      state: RD_STATE_MAP[String(rdStatus ?? '')] ?? 'unknown',
      ownership: owned ? 'owned' : 'external',
      ownerKey: owned ? `second-placement-${observedAt}` : null,
      provenance: 'second-placement',
      observedAt, expiresAt,
    });
    const files = matchedFile ? [{
      providerFileId: String(matchedFile.id),
      path: fullPath,
      name: String(fullPath).split('/').filter(Boolean).pop(),
      size: Number(matchedFile.bytes),
      selected: matchedFile.selected === 1,
      corpusFileIndex: Number(matchedFile.id),
      evidence: { source: 'second-placement', rdTorrentId: String(rdId), matchedBy: 'exact-path-and-exact-size' },
    }] : [];
    if (files.length > 0) {
      persistInventory(placement.id, files, {
        source: 'second-placement', rdTorrentId: String(rdId),
      });
    }
    return placement;
  }

  async function fetchRdInfoChecked(rd, rdId, infoHash) {
    const info = await rd.getTorrentInfo(rdId);
    if (!info || typeof info !== 'object') return { status: 'unavailable' };
    const reported = String(info.hash ?? '').trim().toLowerCase();
    if (reported !== infoHash) return { status: 'hash-mismatch', reported };
    if (!Array.isArray(info.files) || info.files.length === 0) return { status: 'no-files' };
    return { status: 'ok', info };
  }

  async function ensureRealDebrid(torrentFile, infoHash) {
    let apiCalls = 0;
    const observedAt = now();
    const expiresAt = observedAt + ttlMs;
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;

    // Durable-first: reuse the recorded RD torrent id (no list call).
    let known = null;
    if (typeof store.findPlacementByInfoHash === 'function') {
      const p = store.findPlacementByInfoHash('realdebrid', infoHash);
      const id = p?.providerResourceId;
      if (typeof id === 'string' && id.trim() !== '') known = id.trim();
    }

    // Bounded discovery: one list call, exact-hash filter. Anything for
    // another hash is ignored and can never satisfy this request.
    let rdId = known;
    let idSource = known ? 'durable' : null;
    if (!rdId) {
      let list;
      try {
        apiCalls += 1;
        list = await realdebrid.listTorrents({ limit: 100 });
      } catch (error) {
        return { status: 'provider-error', operation: 'torrents-list', reason: error.message, apiCalls };
      }
      const matches = (Array.isArray(list) ? list : []).filter(
        (entry) => String(entry?.hash ?? '').trim().toLowerCase() === infoHash,
      );
      const ids = [...new Set(matches.map((m) => String(m?.id ?? '').trim()).filter(Boolean))];
      if (ids.length === 0) {
        rdId = null;
      } else if (ids.length !== 1) {
        return { status: 'unavailable', reason: 'ambiguous-account-torrents', apiCalls, ids };
      } else {
        rdId = ids[0];
        idSource = 'discovered';
      }
    }

    // Known or discovered torrent: verify, match, persist (no addMagnet).
    if (rdId) {
      let verified;
      try {
        apiCalls += 1;
        verified = await fetchRdInfoChecked(realdebrid, rdId, infoHash);
      } catch (error) {
        return { status: 'provider-error', operation: 'torrents-info', rdId, reason: error.message, apiCalls };
      }
      if (verified.status !== 'ok') {
        return { status: verified.status === 'unavailable' ? 'provider-error' : 'failed', reason: verified.status, rdId, apiCalls, reported: verified.reported ?? null };
      }
      const match = matchRdFile(verified.info, torrentFile);
      if (match.status !== 'matched') {
        return { status: match.status === 'ambiguous' ? 'unavailable' : 'failed', reason: match.status, rdId, apiCalls };
      }
      const placement = persistRdPlacement({
        rdId, rdStatus: verified.info.status, owned: false,
        observedAt, expiresAt, info: verified.info,
        matchedFile: match.file, fullPath: match.fullPath,
      });
      observeLookup({ provider: 'realdebrid', infoHash, state: 'present', placementId: placement.id, observedAt, expiresAt, source: 'second-placement' });
      const mapped = mappedFileFor(placement.id, torrentFile.id);
      if (mapped) {
        return { status: 'created', provider: 'realdebrid', idSource, apiCalls, placementId: placement.id, providerFileId: mapped.providerFileId };
      }
      return { status: 'failed', reason: 'no-exact-match', rdId, apiCalls, placementId: placement.id };
    }

    // Absent: bounded addMagnet flow. This creates real account state, so
    // only the exact matched file id is ever selected (minimal footprint).
    let addedId;
    try {
      apiCalls += 1;
      const added = await realdebrid.addMagnet(magnet);
      addedId = String(added?.id ?? '').trim();
      if (!addedId) throw new Error('Real-Debrid addMagnet response missing id');
    } catch (error) {
      return { status: 'provider-error', operation: 'add-magnet', reason: error.message, apiCalls };
    }
    const anchorPending = (rdStatus) => persistRdPlacement({
      rdId: addedId, rdStatus, owned: true, observedAt, expiresAt,
      info: { hash: infoHash }, matchedFile: null, fullPath: null,
    });
    let initial;
    try {
      apiCalls += 1;
      initial = await fetchRdInfoChecked(realdebrid, addedId, infoHash);
    } catch (error) {
      const placement = anchorPending('magnet_conversion');
      return { status: 'provider-error', operation: 'torrents-info', reason: error.message, apiCalls, placementId: placement.id, rdId: addedId };
    }
    if (initial.status !== 'ok') {
      const placement = anchorPending('magnet_conversion');
      return { status: 'pending', reason: initial.status, apiCalls, placementId: placement.id, rdId: addedId };
    }
    const match = matchRdFile(initial.info, torrentFile);
    if (match.status !== 'matched') {
      const placement = anchorPending(initial.info.status);
      return { status: match.status === 'ambiguous' ? 'unavailable' : 'failed', reason: match.status, apiCalls, placementId: placement.id, rdId: addedId };
    }
    try {
      apiCalls += 1;
      await realdebrid.selectFiles(addedId, [match.file.id]);
    } catch (error) {
      const placement = anchorPending(initial.info.status);
      return { status: 'provider-error', operation: 'select-files', reason: error.message, apiCalls, placementId: placement.id, rdId: addedId };
    }
    let current = initial.info;
    for (let attempt = 0; attempt < poll.maxAttempts; attempt += 1) {
      const st = String(current.status ?? '');
      if (st === 'downloaded') break;
      if (st === 'error' || st === 'dead' || st === 'virus') {
        const placement = persistRdPlacement({
          rdId: addedId, rdStatus: st, owned: true, observedAt, expiresAt,
          info: current, matchedFile: match.file, fullPath: match.fullPath,
        });
        return { status: 'failed', reason: `rd-status-${st}`, apiCalls, placementId: placement.id, rdId: addedId };
      }
      if (attempt + 1 >= poll.maxAttempts) break;
      await poll.sleep(poll.delayMs);
      try {
        apiCalls += 1;
        const next = await fetchRdInfoChecked(realdebrid, addedId, infoHash);
        if (next.status === 'ok') current = next.info;
        else {
          const placement = anchorPending('magnet_conversion');
          return { status: 'provider-error', operation: 'torrents-info-poll', reason: next.status, apiCalls, placementId: placement.id, rdId: addedId };
        }
      } catch (error) {
        const placement = anchorPending('magnet_conversion');
        return { status: 'provider-error', operation: 'torrents-info-poll', reason: error.message, apiCalls, placementId: placement.id, rdId: addedId };
      }
    }
    if (String(current.status ?? '') !== 'downloaded') {
      const placement = persistRdPlacement({
        rdId: addedId, rdStatus: current.status, owned: true, observedAt, expiresAt,
        info: current, matchedFile: match.file, fullPath: match.fullPath,
      });
      observeLookup({ provider: 'realdebrid', infoHash, state: 'present', placementId: placement.id, observedAt, expiresAt, source: 'second-placement' });
      return { status: 'pending', reason: 'not-downloaded-within-bound', apiCalls, placementId: placement.id, rdId: addedId };
    }
    const placement = persistRdPlacement({
      rdId: addedId, rdStatus: current.status, owned: true, observedAt, expiresAt,
      info: current, matchedFile: match.file, fullPath: match.fullPath,
    });
    observeLookup({ provider: 'realdebrid', infoHash, state: 'present', placementId: placement.id, observedAt, expiresAt, source: 'second-placement' });
    const mapped = mappedFileFor(placement.id, torrentFile.id);
    if (mapped) {
      return { status: 'created', provider: 'realdebrid', idSource: 'added', apiCalls, placementId: placement.id, providerFileId: mapped.providerFileId };
    }
    return { status: 'failed', reason: 'no-exact-match', apiCalls, placementId: placement.id, rdId: addedId };
  }

  /**
   * Ensure a second durable provider placement exists for one exact
   * TorrentFile. Never throws for provider faults (they become bounded
   * `failed`/`provider-error`/`unavailable` results); validates input.
   *
   * @param {Object} params
   * @param {string} params.torrentFileId - Durable TorrentFile id.
   * @param {string} [params.preferredProvider] - 'torbox'|'realdebrid' when
   *   exactly one side is missing and the caller wants that side first.
   */
  async function ensureSecondPlacement({ torrentFileId, preferredProvider = null } = {}) {
    if (!torrentFileId || typeof torrentFileId !== 'string') {
      return { status: 'invalid-input', reason: 'torrentFileId is required' };
    }
    const torrentFile = store.getTorrentFile(torrentFileId);
    if (!torrentFile) {
      return { status: 'unknown-torrent-file', torrentFileId };
    }
    let infoHash;
    try {
      infoHash = normalizeInfoHash(torrentFile.infoHash);
    } catch (error) {
      return { status: 'invalid-input', reason: error.message, torrentFileId };
    }
    if (!isValidSize(torrentFile.size) || !torrentFile.internalPath) {
      return { status: 'invalid-input', reason: 'TorrentFile needs internalPath and positive size', torrentFileId };
    }
    const preferred = preferredProvider == null ? null : String(preferredProvider).trim().toLowerCase();
    if (preferred !== null && !PROVIDERS.includes(preferred)) {
      return { status: 'invalid-input', reason: `unknown provider: ${preferredProvider}`, torrentFileId };
    }

    const before = presentProviders(torrentFile.id, infoHash);
    const providers = [...before.present].sort();
    if (before.present.has('torbox') && before.present.has('realdebrid')) {
      // No provider mutation of any kind on this path.
      return { status: 'already_ready', torrentFileId: torrentFile.id, infoHash, providers, apiCalls: 0 };
    }
    const missing = PROVIDERS.filter((p) => !before.present.has(p));
    const target = preferred !== null && missing.includes(preferred) ? preferred : missing[0];

    const clients = { torbox, realdebrid: realdebrid };
    if (target === 'torbox' && !clients.torbox) {
      return { status: 'unavailable', reason: 'torbox-client-unconfigured', torrentFileId, infoHash, providers, targetProvider: target, apiCalls: 0 };
    }
    if (target === 'realdebrid' && !clients.realdebrid) {
      return { status: 'unavailable', reason: 'realdebrid-client-unconfigured', torrentFileId, infoHash, providers, targetProvider: target, apiCalls: 0 };
    }

    let outcome;
    try {
      outcome = target === 'torbox'
        ? await ensureTorBox(torrentFile, infoHash)
        : await ensureRealDebrid(torrentFile, infoHash);
    } catch (error) {
      log(`[second-placement] unexpected failure for ${torrentFile.id}: ${error.message}`);
      return { status: 'error', reason: error.message, torrentFileId, infoHash, providers, targetProvider: target, apiCalls: 0 };
    }
    const after = presentProviders(torrentFile.id, infoHash);
    return {
      status: outcome.status,
      torrentFileId: torrentFile.id,
      infoHash,
      providers: [...after.present].sort(),
      targetProvider: target,
      placementId: outcome.placementId ?? null,
      providerFileId: outcome.providerFileId ?? null,
      apiCalls: outcome.apiCalls ?? 0,
      ...(outcome.idSource ? { idSource: outcome.idSource } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.operation ? { operation: outcome.operation } : {}),
      ...(outcome.rdId ? { rdId: outcome.rdId } : {}),
    };
  }

  function ensureSecondPlacementCoalesced({ torrentFileId, preferredProvider = null } = {}) {
    const key = `${String(torrentFileId ?? '')}`;
    if (!key) return Promise.resolve({ status: 'invalid-input', reason: 'torrentFileId is required' });
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = ensureSecondPlacement({ torrentFileId, preferredProvider }).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, task);
    return task;
  }

  return Object.freeze({
    ensureSecondPlacement: ensureSecondPlacementCoalesced,
    ensureSecondPlacementUncoalesced: ensureSecondPlacement,
  });
}
