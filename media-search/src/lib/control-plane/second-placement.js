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

import {
  classifyRoutesForTorrentFile,
  providersNeedingRoute,
  ROUTE_STATES,
} from './route-classification.js';

const HEX40 = /^[0-9a-f]{40}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOOKUP_LIMIT = 100;
const RD_POLL_MAX_ATTEMPTS = 10;
const RD_POLL_DELAY_MS = 2000;

const PROVIDERS = Object.freeze(['torbox', 'realdebrid']);

/** TorBox download state -> provider_placements.state. Mirrors the
 * provider adapter's readiness derivation: a cached torrent is a READY
 * placement, an in-flight one is PENDING, and an unknown state is
 * UNKNOWN (never a guess). */
export const TORBOX_STATE_MAP = Object.freeze({
  cached: 'ready',
  completed: 'ready',
  downloaded: 'ready',
  ready: 'ready',
  seeding: 'ready',
  uploading: 'ready',
  queued: 'pending',
  checking_resume_data: 'pending',
  downloading: 'pending',
  meta_downloading: 'pending',
  pending: 'pending',
  error: 'error',
  failed: 'error',
});

/** RD status -> provider_placements.state. Mirrors rd-placement-realizer. */
export const RD_STATE_MAP = Object.freeze({
  downloaded: 'ready',
  magnet_conversion: 'pending',
  waiting_files_selection: 'pending',
  queued: 'pending',
  downloading: 'pending',
  compressing: 'pending',
  uploading: 'pending',
  // NOTE: 'failed' is NOT a valid provider_placements.state (CHECK
  // allows pending/ready/degraded/error/removed/unknown). RD terminal
  // statuses land on 'error' — writing anything else throws
  // SQLITE_CONSTRAINT_CHECK mid-request instead of failing cleanly.
  error: 'error',
  dead: 'error',
  virus: 'error',
});

function normalizeInfoHash(value) {
  const h = String(value ?? '').trim().toLowerCase();
  if (!HEX40.test(h)) throw new TypeError(`invalid infoHash: ${value}`);
  return h;
}

function isValidSize(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Did the provider say "this resource is gone" (as opposed to "I could
 * not answer")? A gone resource is a fact to move past; anything else is
 * an error to report.
 */
function isGoneError(error) {
  if (!error) return false;
  if (error.category === 'not-found' || error.category === 'gone') return true;
  const status = Number(error.status);
  return status === 404 || status === 410;
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
  // The account listing is multi-megabyte and its read time is variable
  // (measured 0.4 s - 5.8 s for a 5.5 MB account). The budget for that
  // read is therefore larger than the budget for a targeted read, and it
  // is spent only where the provider's hash index is genuinely needed.
  const accountReadTimeoutMs = Number(process.env.ROUTE_REPAIR_ACCOUNT_READ_TIMEOUT_MS ?? 20_000);
  const poll = {
    maxAttempts: Math.max(1, Math.trunc(Number(rdPoll.maxAttempts) || RD_POLL_MAX_ATTEMPTS)),
    delayMs: Math.max(0, Number(rdPoll.delayMs ?? RD_POLL_DELAY_MS)),
    sleep: typeof rdPoll.sleep === 'function' ? rdPoll.sleep : ((ms) => new Promise((r) => setTimeout(r, ms))),
  };

  // Single-flight per TorrentFile: concurrent ensures for the same id
  // share one execution (prevents duplicate account-side torrents).
  const inFlight = new Map();

  // Provider presence from the SHARED route view: a provider is present
  // when it has a route to this exact TorrentFile that is not proven dead.
  //
  // The previous predicate asked "does a ProviderPlacement row exist for
  // this provider and hash" — which counts a TERMINALLY DEAD route as
  // healthy redundancy and then looks for a SECOND provider instead of the
  // provider that actually lost the route. `lookupLimit` is accepted for
  // interface parity with the proven helper and is unused here.
  void lookupLimit;
  /**
   * The provider resource ids whose routes are proven DEAD.
   *
   * A dead route is not a repair candidate: reusing it would report a
   * repair that did not happen. It is also not a candidate when the
   * provider is asked for a replacement — that is a different resource id
   * for the same release, which is a NEW route.
   */
  function deadResourceIdsFor(view, provider) {
    const providerView = view?.byProvider?.[provider];
    if (!providerView) return new Set();
    return new Set(providerView.routes
      .filter((route) => route.state === ROUTE_STATES.DEAD)
      .map((route) => route.providerResourceId));
  }

  function presentProviders(torrentFileId, infoHash) {
    const view = classifyRoutesForTorrentFile(store, {
      torrentFileId,
      infoHash,
      now: now(),
    });
    const present = new Set();
    for (const provider of PROVIDERS) {
      const providerView = view.byProvider[provider];
      if (!providerView) continue;
      // A route that is merely unknown or temporarily unavailable still
      // counts as present: it may work, and the next read tries it. Only a
      // route proven dead does not.
      if (providerView.state === ROUTE_STATES.DEAD) continue;
      present.add(provider);
    }
    return { present, view };
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

  /**
   * The provider resources that hold THIS release, minus the ones whose
   * route is proven dead (a dead route is not a replacement for itself).
   *
   * The account listing is the provider's only hash index: it is the only
   * way to learn that a release was re-created under a new resource id.
   * It is therefore read ONLY on the repair path, and with a budget that
   * fits an account-sized read.
   */
  async function listAccountResources(provider, infoHash, { deadResourceIds = new Set(), apiCalls = () => 0 } = {}) {
    const budgetMs = accountReadTimeoutMs;
    if (provider === 'torbox') {
      if (typeof torbox?.listPlacements === 'function') {
        try {
          apiCalls();
          const listed = await torbox.listPlacements(
            { infoHash },
            { signal: AbortSignal.timeout(budgetMs) },
          );
          const resources = (Array.isArray(listed) ? listed : [])
            .map((r) => ({
              providerResourceId: String(r?.providerResourceId ?? '').trim(),
              state: r?.state ?? 'unknown',
            }))
            .filter((r) => r.providerResourceId && !deadResourceIds.has(r.providerResourceId));
          return { resources };
        } catch (error) {
          return { resources: [], error: error.message };
        }
      }
      // Fallback (test doubles, older surfaces): the singular lookup.
      try {
        apiCalls();
        const observed = await torbox.lookupPlacement(
          { infoHash },
          { signal: AbortSignal.timeout(budgetMs) },
        );
        if (!observed) return { resources: [] };
        const id = String(observed.providerResourceId ?? '').trim();
        if (!id || deadResourceIds.has(id)) return { resources: [] };
        return { resources: [{ providerResourceId: id, state: observed.state ?? 'unknown' }] };
      } catch (error) {
        return { resources: [], error: error.message };
      }
    }
    return { resources: [] };
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
  async function ensureTorBox(torrentFile, infoHash, { deadResourceIds = new Set() } = {}) {
    let apiCalls = 0;
    const observedAt = now();
    const expiresAt = observedAt + ttlMs;
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;

    // EVERY recorded placement for the hash is considered, not just one: a
    // provider that re-created the release under a new resource id has two
    // routes, and the singular lookup would hide the replacement behind
    // the dead one.
    //
    // A route that is proven DEAD is re-observed here rather than trusted
    // or discarded: the targeted inventory read is the cheapest proof of
    // whether the resource is really gone. If it is still there, the fresh
    // observation supersedes the terminal verdict and the route is alive
    // again; if it is gone, the read says so and the search continues.
    const durable = typeof store.listPlacementsByInfoHash === 'function'
      ? store.listPlacementsByInfoHash('torbox', infoHash)
      : [store.findPlacementByInfoHash('torbox', infoHash)].filter(Boolean);
    let placement = null;
    for (const candidate of durable) {
      let inventory;
      try {
        apiCalls += 1;
        inventory = await torbox.getFileInventory({
          provider: 'torbox', accountScope, providerResourceId: candidate.providerResourceId,
        });
        // The inventory write is the RE-OBSERVATION: a route that is still
        // listed is not dead, and the fresh observation supersedes the
        // terminal verdict (the store does that, in the same write).
        persistInventory(candidate.id, inventory.files, {
          source: 'second-placement', providerResourceId: candidate.providerResourceId,
        });
      } catch (error) {
        if (isGoneError(error)) continue; // the resource is gone: try the next one
        return { status: 'provider-error', operation: 'file-inventory', reason: error.message, apiCalls };
      }
      const mapped = mappedFileFor(candidate.id, torrentFile.id);
      if (mapped) {
        placement = candidate;
        return {
          status: 'created', provider: 'torbox',
          idSource: deadResourceIds.has(candidate.providerResourceId) ? 're-observed' : 'durable',
          apiCalls, placementId: candidate.id, providerFileId: mapped.providerFileId,
        };
      }
      // The resource exists but does not carry this exact file: it is not
      // a route to this TorrentFile. Keep looking.
    }

    // Passive recovery: an account resource we never recorded, or a
    // REPLACEMENT for a route that died.
    //
    // The account listing is the provider's only hash index, so it is read
    // ONLY here — and with a budget that fits the account it reads (the
    // observed account is multi-megabyte and its read time is variable).
    const accountResources = await listAccountResources('torbox', infoHash, { deadResourceIds, apiCalls: () => apiCalls });
    if (accountResources.error) {
      return { status: 'provider-error', operation: 'placement-lookup', reason: accountResources.error, apiCalls };
    }
    for (const resource of accountResources.resources) {
      const existing = durable.find((p) => p.providerResourceId === resource.providerResourceId);
      if (existing) continue; // already tried above
      placement = store.recordPlacement({
        provider: 'torbox', accountScope, infoHash,
        providerResourceId: resource.providerResourceId,
        state: TORBOX_STATE_MAP[String(resource.state ?? '').trim().toLowerCase()] ?? 'unknown',
        ownership: 'external',
        ownerKey: null,
        provenance: 'second-placement',
        observedAt, expiresAt,
      });
      observeLookup({ provider: 'torbox', infoHash, state: 'present', placementId: placement.id, observedAt, expiresAt, source: 'second-placement' });
      let inventory;
      try {
        apiCalls += 1;
        inventory = await torbox.getFileInventory({
          provider: 'torbox', accountScope, providerResourceId: placement.providerResourceId,
        });
        persistInventory(placement.id, inventory.files, {
          source: 'second-placement', providerResourceId: placement.providerResourceId,
        });
      } catch (error) {
        if (isGoneError(error)) continue; // the account listed a resource that is not there
        return { status: 'provider-error', operation: 'file-inventory', reason: error.message, apiCalls, placementId: placement.id };
      }
      const mapped = mappedFileFor(placement.id, torrentFile.id);
      if (mapped) {
        return { status: 'created', provider: 'torbox', idSource: 'recovered', apiCalls, placementId: placement.id, providerFileId: mapped.providerFileId };
      }
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
      // A genuine negative: the provider was asked about THIS release
      // and answered that it does not have it cached.
      return { status: 'unavailable', reason: 'not-cached', negative: true, apiCalls };
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

  async function ensureRealDebrid(torrentFile, infoHash, { discoverOnly = false, deadResourceIds = new Set() } = {}) {
    let apiCalls = 0;
    const observedAt = now();
    const expiresAt = observedAt + ttlMs;
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;

    // Durable-first: re-observe EVERY recorded RD torrent id for this
    // hash, not just the first row: a provider that re-created the release
    // under a new id has two routes, and the singular lookup would hide
    // the replacement behind the dead one.
    //
    // A route that is proven DEAD is re-observed rather than trusted: the
    // info read is the cheapest proof of whether the torrent is still
    // there, and a fresh observation supersedes the terminal verdict.
    const durableRd = typeof store.listPlacementsByInfoHash === 'function'
      ? store.listPlacementsByInfoHash('realdebrid', infoHash)
      : [store.findPlacementByInfoHash('realdebrid', infoHash)].filter(Boolean);
    for (const candidate of durableRd) {
      const id = String(candidate?.providerResourceId ?? '').trim();
      if (!id) continue;
      let verified;
      try {
        apiCalls += 1;
        verified = await fetchRdInfoChecked(realdebrid, id, infoHash);
      } catch (error) {
        if (isGoneError(error)) continue; // the torrent is gone: try the next one
        return { status: 'provider-error', operation: 'torrents-info', rdId: id, reason: error.message, apiCalls };
      }
      if (verified.status === 'unavailable') continue; // the torrent is gone
      if (verified.status !== 'ok') {
        return { status: 'failed', reason: verified.status, rdId: id, apiCalls, reported: verified.reported ?? null };
      }
      const match = matchRdFile(verified.info, torrentFile);
      if (match.status !== 'matched') {
        // 'ambiguous' is NOT a negative: the file exists, we just cannot
        // bind it to one provider file id.
        return { status: 'failed', reason: match.status, rdId: id, apiCalls };
      }
      const placement = persistRdPlacement({
        rdId: id, rdStatus: verified.info.status, owned: false,
        observedAt, expiresAt, info: verified.info,
        matchedFile: match.file, fullPath: match.fullPath,
      });
      observeLookup({ provider: 'realdebrid', infoHash, state: 'present', placementId: placement.id, observedAt, expiresAt, source: 'second-placement' });
      const mapped = mappedFileFor(placement.id, torrentFile.id);
      if (mapped) {
        return {
          status: 'created', provider: 'realdebrid',
          idSource: deadResourceIds.has(id) ? 're-observed' : 'durable',
          apiCalls, placementId: placement.id, providerFileId: mapped.providerFileId,
        };
      }
      return { status: 'failed', reason: 'no-exact-match', rdId: id, apiCalls, placementId: placement.id };
    }

    // Bounded discovery: one list call, exact-hash filter. Anything for
    // another hash is ignored and can never satisfy this request.
    let rdId = null;
    let idSource = null;
    {
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
      // A route that died and was re-created appears here as a SECOND id
      // for the same hash. The dead id is not a candidate (it is gone);
      // the remaining id is a REPLACEMENT route, not an ambiguity.
      const allIds = [...new Set(matches.map((m) => String(m?.id ?? '').trim()).filter(Boolean))];
      const ids = allIds.filter((id) => !deadResourceIds.has(id));
      if (allIds.length > 0 && ids.length === 0) {
        // Every id we know for this hash is proven dead: the account does
        // not hold a usable copy. That is a negative, not an ambiguity.
        return { status: 'unavailable', reason: 'not-cached', negative: true, apiCalls, ids: allIds };
      }
      if (ids.length === 0) {
        rdId = null;
      } else if (ids.length !== 1) {
        // NOT a negative: the account may well hold this release, we just
        // cannot tell which torrent is it. Treating this as "not cached"
        // would let a representation switch happen on a false negative.
        return { status: 'failed', reason: 'ambiguous-account-torrents', apiCalls, ids };
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
        // 'ambiguous' is NOT a negative either: the file exists, we just
        // cannot bind it to one provider file id.
        return { status: 'failed', reason: match.status, rdId, apiCalls };
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
    // Discover-only callers (background enrichment) stop here instead:
    // manufacturing an uncached download is never automatic.
    if (discoverOnly) {
      // The account was searched (the list call above) and does not hold
      // this release: a genuine negative. The reason it was not acquired is
      // the cache-only policy, not a provider failure.
      return { status: 'unavailable', reason: 'discover-only', negative: true, apiCalls };
    }
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
   * @param {boolean} [params.discoverOnly=false] - when true, the RD path
   *   stops after account discovery instead of addMagnet: background
   *   enrichment never manufactures an uncached download automatically.
   *   The TorBox path is unaffected (already cached-gated). */
  async function ensureSecondPlacement({ torrentFileId, preferredProvider = null, discoverOnly = false } = {}) {
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
    // The providers that still NEED a route: the ones with no route at
    // all, and the ones whose every route is proven DEAD. A provider whose
    // route is unknown or temporarily unavailable is not a target — the
    // route may still work and the next read tries it.
    const missing = providersNeedingRoute(before.view);
    const target = preferred !== null && missing.includes(preferred) ? preferred : missing[0];
    if (!target) {
      // Every provider has a route that is not proven dead: nothing to do.
      return { status: 'already_ready', torrentFileId: torrentFile.id, infoHash, providers, apiCalls: 0 };
    }

    const clients = { torbox, realdebrid: realdebrid };
    // The candidates are the providers that need a route. The FIRST one is
    // the target (the provider that lost its route); the others are the
    // providers that have no route at all for this release.
    //
    // Why the others are consulted too: "this release has no cached copy"
    // is a claim about EVERY candidate account, not about the one we
    // happened to ask first. A negative that covers one provider only is
    // not the completeness proof the representation policy needs — it could
    // authorize replacing an authoritative representation while a working
    // route exists in the other account.
    const candidates = missing;
    const consulted = [];
    const negatives = [];
    let apiCalls = 0;
    let outcome = null;
    for (const candidate of candidates) {
      if (candidate === 'torbox' && !clients.torbox) {
        // Not a negative: nobody was asked. Keep going — another account
        // may still hold the release.
        consulted.push({ provider: candidate, status: 'skipped', reason: 'client-unconfigured' });
        continue;
      }
      if (candidate === 'realdebrid' && !clients.realdebrid) {
        consulted.push({ provider: candidate, status: 'skipped', reason: 'client-unconfigured' });
        continue;
      }
      let providerOutcome;
      try {
        providerOutcome = candidate === 'torbox'
          ? await ensureTorBox(torrentFile, infoHash, { deadResourceIds: deadResourceIdsFor(before.view, candidate) })
          : await ensureRealDebrid(torrentFile, infoHash, {
            discoverOnly, deadResourceIds: deadResourceIdsFor(before.view, candidate),
          });
      } catch (error) {
        log(`[second-placement] unexpected failure for ${torrentFile.id}: ${error.message}`);
        providerOutcome = { status: 'error', reason: error.message, apiCalls: 0 };
      }
      apiCalls += providerOutcome.apiCalls ?? 0;
      consulted.push({ provider: candidate, status: providerOutcome.status, reason: providerOutcome.reason ?? null });
      if (providerOutcome.status === 'created') {
        outcome = providerOutcome;
        break;
      }
      if (providerOutcome.negative === true) {
        negatives.push({ provider: candidate, reason: providerOutcome.reason ?? 'not-cached' });
        continue;
      }
      // Inconclusive: the provider could not answer. The negative is NOT
      // complete, so it may not be used as a completeness proof.
      outcome = providerOutcome;
      break;
    }
    const after = presentProviders(torrentFile.id, infoHash);
    if (!outcome) {
      // Every candidate that could be consulted answered "not cached".
      const complete = negatives.length > 0 && negatives.length === candidates.length;
      const last = negatives[negatives.length - 1];
      outcome = {
        status: 'unavailable',
        reason: !complete
          ? 'no-candidate-account-available'
          : (candidates.length === 1 ? last.reason : 'not-cached-in-any-candidate-account'),
        negative: complete,
        apiCalls: 0,
      };
    }
    return {
      status: outcome.status,
      torrentFileId: torrentFile.id,
      infoHash,
      providers: [...after.present].sort(),
      targetProvider: target,
      providersConsulted: consulted,
      // The completeness proof: every candidate account was searched for
      // this exact release and none of them has it cached.
      negativeComplete: outcome.negative === true,
      placementId: outcome.placementId ?? null,
      providerFileId: outcome.providerFileId ?? null,
      apiCalls,
      ...(outcome.idSource ? { idSource: outcome.idSource } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.operation ? { operation: outcome.operation } : {}),
      ...(outcome.rdId ? { rdId: outcome.rdId } : {}),
    };
  }

  function ensureSecondPlacementCoalesced({ torrentFileId, preferredProvider = null, discoverOnly = false } = {}) {
    const key = `${String(torrentFileId ?? '')}|${preferredProvider ?? ''}|${discoverOnly ? '1' : ''}`;
    if (!String(torrentFileId ?? '')) return Promise.resolve({ status: 'invalid-input', reason: 'torrentFileId is required' });
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = ensureSecondPlacement({ torrentFileId, preferredProvider, discoverOnly }).finally(() => {
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
