/**
 * Preparation driver — advances durable preparations toward READY.
 *
 * One bounded tick (`advanceOnce`) processes due rows: expire overdue,
 * claim, acquire-or-poll through the provider adapter, transition state,
 * and on READY persist placement/inventory/TorrentFile then hand back to
 * the NORMAL representation pipeline for Binding (the driver never binds,
 * never chooses representation — see Part 13).
 *
 * Refusal memory (Part 8/27) lives here, process-local with TTLs, exactly
 * like the existing in-memory breaker precedent:
 * - contentBlocked: provider+Release that answered 451/policy-refusal;
 * - accountIneligible: provider whose account cannot acquire right now.
 * Neither is route death, neither touches durable evidence, both expire.
 *
 * Limits (Part 18) are enforced before any provider write: total
 * concurrency, per-provider concurrency, per-release size cap, overall
 * deadline (row expires_at), bounded attempts with backoff.
 */

import {
  PREPARE_OUTCOME,
  PREPARE_STATE,
  toPrepareOutcome,
  nextPreparationState,
  orderPrepareProviders,
} from './contract.js';

const DEFAULT_CONFIG = Object.freeze({
  maxConcurrentTotal: 2,
  maxConcurrentPerProvider: 2,
  maxSizeBytes: 100 * 1024 * 1024 * 1024,
  maxAttempts: 20,
  pollIntervalMs: 60_000,
  pollIntervalByProvider: Object.freeze({ realdebrid: 30_000, torbox: 60_000 }),
  backoffMs: [30_000, 60_000, 5 * 60_000, 15 * 60_000],
  contentBlockedTtlMs: 24 * 60 * 60 * 1000,
  accountIneligibleTtlMs: 5 * 60 * 1000,
  tickLimit: 5,
});

function backoffFor(attempts, steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 60_000;
  return steps[Math.min(Math.max(0, attempts), steps.length - 1)];
}

export function createPrepareDriver({
  store,
  controlPlaneStore = null,
  adapters = {},
  config = {},
  clock = () => Date.now(),
  log = () => {},
  notifiers = {},
} = {}) {
  if (!store) throw new Error('prepare driver requires store');
  const cfg = { ...DEFAULT_CONFIG, ...config };
  // Refusal memory: short-lived, process-local, never durable.
  const contentBlocked = new Map(); // `${provider}:${infoHash}` -> expiresAt
  const accountIneligible = new Map(); // provider -> expiresAt

  function pruneMemory(now) {
    for (const [k, v] of contentBlocked) if (v <= now) contentBlocked.delete(k);
    for (const [k, v] of accountIneligible) if (v <= now) accountIneligible.delete(k);
  }

  function memorySnapshot(now) {
    pruneMemory(now);
    const blocked = new Set();
    for (const k of contentBlocked.keys()) blocked.add(k.split(':')[0]);
    return {
      contentBlocked: blocked,
      accountIneligible: new Set(accountIneligible.keys()),
    };
  }

  function rememberContentBlocked(provider, infoHash, ttlMs = cfg.contentBlockedTtlMs) {
    contentBlocked.set(`${provider}:${String(infoHash).toLowerCase()}`, clock() + ttlMs);
  }

  function rememberAccountIneligible(provider, ttlMs = cfg.accountIneligibleTtlMs) {
    accountIneligible.set(provider, clock() + ttlMs);
  }

  function pollIntervalFor(provider) {
    return cfg.pollIntervalByProvider?.[provider] ?? cfg.pollIntervalMs;
  }

  function checkLimits(provider) {
    if (store.countActive() >= cfg.maxConcurrentTotal) {
      return `concurrency-total:${cfg.maxConcurrentTotal}`;
    }
    if (store.countActiveForProvider(provider) >= cfg.maxConcurrentPerProvider) {
      return `concurrency-provider:${provider}:${cfg.maxConcurrentPerProvider}`;
    }
    return null;
  }

  /**
   * Start (or join) preparation for one candidate across an ordered
   * provider plan. Returns { preparation, created, joined }.
   */
  function startPreparation({
    infoHash, mediaType, mediaId, season = null, episode = null, title = null,
    candidate = {}, providers = [], source = 'play', sessionId = null,
  }) {
    const ordered = orderPrepareProviders(providers, memorySnapshot(clock()));
    if (ordered.length === 0) {
      return { preparation: null, created: false, reason: 'no-eligible-provider' };
    }
    const size = Number(candidate?.size);
    if (Number.isSafeInteger(size) && size > cfg.maxSizeBytes) {
      return { preparation: null, created: false, reason: `over-size-limit:${size}` };
    }
    const withPlan = {
      ...candidate,
      providerPlan: ordered,
      providerAttempted: [],
    };
    const { preparation, created } = store.startOrJoin({
      infoHash, provider: ordered[0], mediaType, mediaId, season, episode,
      title, candidate: withPlan, source, sessionId,
    });
    return { preparation, created: !!created, joined: !created };
  }

  function readPlan(preparation) {
    try {
      const c = JSON.parse(preparation?.candidate_json ?? '{}');
      return Array.isArray(c?.providerPlan) ? c.providerPlan : [];
    } catch {
      return [];
    }
  }

  function readCandidate(preparation) {
    try {
      return JSON.parse(preparation?.candidate_json ?? '{}') ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Move to the next provider in the plan after a provider-scoped refusal.
   * Returns the new preparation row or null when the plan is exhausted.
   */
  function advanceToNextProvider(preparation, failedProvider) {
    const plan = readPlan(preparation);
    const remaining = plan.filter((p) => p !== failedProvider);
    if (remaining.length === 0) return null;
    const candidate = readCandidate(preparation);
    const { preparation: next, created } = store.startOrJoin({
      infoHash: preparation.info_hash,
      provider: remaining[0],
      mediaType: preparation.media_type,
      mediaId: preparation.media_id,
      season: preparation.season,
      episode: preparation.episode,
      title: preparation.title,
      candidate: { ...candidate, providerPlan: remaining },
      source: preparation.source,
      sessionId: preparation.session_id,
    });
    void created;
    return next;
  }

  /**
   * Persist placement + inventory + TorrentFile for a READY adapter result,
   * mirroring the request-time ensure persistence shape (same store calls,
   * same authoritativeness). Returns { placementId, torrentFileId } or
   * throws. Never binds — Binding stays with representation policy.
   */
  function persistPreparedPlacement({ preparation, adapter, result }) {
    if (!controlPlaneStore) throw new Error('prepare close requires controlPlaneStore');
    const hash = String(preparation.info_hash).toLowerCase();
    const provider = preparation.provider;
    const mapped = result.mapped;
    if (!mapped || !mapped.path || !Number.isSafeInteger(Number(mapped.size)) || Number(mapped.size) <= 0) {
      throw new Error('prepare close requires exact mapped path+size');
    }
    const files = Array.isArray(result.inventoryFiles) ? result.inventoryFiles : null;
    if (!files || files.length === 0) {
      // Never invent inventory: without the provider's own complete file
      // list the placement is unbindable (activation requires authoritative
      // complete inventory). Fail closed and let the poll path re-observe.
      throw new Error('prepare close: provider inventory missing');
    }
    const placement = controlPlaneStore.recordPlacement({
      infoHash: hash,
      provider,
      accountScope: 'default',
      providerResourceId: String(result.providerResourceId),
      state: 'ready',
      ownership: 'owned',
      provenance: `prepare-${provider}`,
    });
    controlPlaneStore.replaceProviderFileInventory(
      placement.id,
      files.map((f) => ({
        providerFileId: String(f.providerFileId),
        path: String(f.path),
        name: String(f.name ?? String(f.path).split('/').filter(Boolean).pop() ?? 'file'),
        size: Number(f.size),
        selected: String(f.providerFileId) === String(mapped.providerFileId),
      })),
      { observedAt: clock(), expiresAt: clock() + 60_000, authoritative: true, complete: true },
    );
    const tf = typeof controlPlaneStore.findTorrentFile === 'function'
      ? controlPlaneStore.findTorrentFile(hash, mapped.path)
      : null;
    if (!tf?.id) throw new Error('prepare close: TorrentFile missing after inventory persist');
    void adapter;
    return { placementId: placement.id, torrentFileId: tf.id };
  }

  /**
   * Advance one claimed row by a single provider step. Returns a small
   * report; never throws (errors become failed_temporary with backoff).
   */
  async function advanceRow(row, { rebindFn = null } = {}) {
    const t = clock();
    const adapter = adapters?.[row.provider];
    if (!adapter) {
      store.markFailed(row.id, PREPARE_STATE.FAILED_TERMINAL, { lastError: `no-adapter:${row.provider}` });
      return { id: row.id, transition: 'no-adapter' };
    }
    const candidate = readCandidate(row);
    const coord = {
      filename: candidate.filename ?? candidate.name ?? null,
      size: Number.isSafeInteger(Number(candidate.size)) ? Number(candidate.size) : null,
      season: row.season, episode: row.episode,
    };
    try {
      let result;
      if (!row.provider_resource_id) {
        const limited = checkLimits(row.provider);
        if (limited) {
          // Same capacity park as advanceOnce (advanceRow is also public).
          store.markWaiting(row.id, { nextPollAt: t + 60_000, outcome: { limited } });
          return { id: row.id, transition: 'limited' };
        }
        // Account gate before any provider write (Part 26): a refused
        // account fails once clearly instead of storming.
        if (typeof adapter.checkAccount === 'function') {
          const gate = await adapter.checkAccount();
          if (!gate?.eligible) {
            rememberAccountIneligible(row.provider);
            store.markFailed(row.id, PREPARE_STATE.FAILED_TERMINAL, {
              lastError: `account-ineligible:${gate?.reason ?? 'unknown'}`,
            });
            return { id: row.id, transition: 'account-ineligible' };
          }
        }
        result = await adapter.acquire({ infoHash: row.info_hash, magnet: candidate.magnet ?? null, ...coord });
      } else {
        result = await adapter.poll({ providerResourceId: row.provider_resource_id, ...coord });
      }
      const outcome = toPrepareOutcome(result);
      const next = nextPreparationState(row.state === 'queued' ? 'queued' : 'waiting', outcome);
      // Wire refusal memory at the decision point (never durable, TTL'd).
      if (outcome === 'content_blocked') rememberContentBlocked(row.provider, row.info_hash);
      if (outcome === 'account_ineligible') rememberAccountIneligible(row.provider);

      if (next === PREPARE_STATE.READY) {
        const closed = persistPreparedPlacement({ preparation: row, adapter, result });
        store.markReady(row.id, {
          providerResourceId: result.providerResourceId ?? row.provider_resource_id,
          outcome: { ...result, placementId: closed.placementId, torrentFileId: closed.torrentFileId },
        });
        let rebound = null;
        if (typeof rebindFn === 'function') {
          try {
            rebound = await rebindFn({
              mediaType: row.media_type, mediaId: row.media_id,
              season: row.season, episode: row.episode,
              torrentFileId: closed.torrentFileId,
            });
          } catch (err) {
            rebound = { error: String(err?.message ?? err).slice(0, 160) };
          }
        }
        try {
          if (typeof notifiers.onReady === 'function') {
            await notifiers.onReady({
              mediaType: row.media_type, mediaId: row.media_id,
              season: row.season, episode: row.episode, title: row.title,
              torrentFileId: closed.torrentFileId, placementId: closed.placementId,
              provider: row.provider, rebound,
            });
          }
          store.markNotified(row.id);
        } catch { /* notification must never fail the row */ }
        return { id: row.id, transition: 'ready', torrentFileId: closed.torrentFileId, rebound };
      }
      if (next === PREPARE_STATE.ACQUIRING || next === PREPARE_STATE.WAITING) {
        store.markWaiting(row.id, {
          providerResourceId: result.providerResourceId ?? row.provider_resource_id,
          nextPollAt: t + pollIntervalFor(row.provider),
          outcome: result,
        });
        return { id: row.id, transition: next, status: result.status ?? null };
      }
      if (next === PREPARE_STATE.FAILED_POLICY || next === PREPARE_STATE.FAILED_TERMINAL) {
        // Provider-scoped refusal with a remaining plan → chain to the next
        // backend instead of ending the media intent. The failed row stays
        // as history; the new row carries the rest of the plan.
        if ((outcome === 'content_blocked' || outcome === 'account_ineligible') && row.provider) {
          const chained = advanceToNextProvider(row, row.provider);
          if (chained) {
            store.markFailed(row.id, next, { lastError: outcome, outcome: result });
            return { id: row.id, transition: `${next}-chained`, chainedTo: chained.id };
          }
        }
        store.markFailed(row.id, next, { lastError: outcome, outcome: result });
        // Best-effort provider cleanup for resources we created.
        try {
          const createdNew = (() => { try { return JSON.parse(row.outcome_json ?? '{}')?.createdNew !== false; } catch { return true; } })();
          if (row.provider_resource_id && typeof adapter.cancel === 'function' && createdNew) {
            await adapter.cancel({ providerResourceId: row.provider_resource_id, createdByUs: true });
          }
        } catch { /* cleanup is best-effort */ }
        return { id: row.id, transition: next };
      }
      // FAILED_TEMPORARY → bounded re-drive or terminal exhaustion.
      const fresh = store.get(row.id);
      const attempts = Number(fresh?.attempts ?? row.attempts ?? 0);
      if (attempts >= cfg.maxAttempts) {
        store.markFailed(row.id, PREPARE_STATE.FAILED_TERMINAL, { lastError: `attempts-exhausted:${attempts}` });
        return { id: row.id, transition: 'exhausted' };
      }
      store.markFailed(row.id, PREPARE_STATE.FAILED_TEMPORARY, { lastError: outcome });
      store.requeue(row.id, t + backoffFor(attempts, cfg.backoffMs));
      return { id: row.id, transition: 'retry-parked' };
    } catch (err) {
      const fresh = store.get(row.id);
      const attempts = Number(fresh?.attempts ?? row.attempts ?? 0);
      if (attempts >= cfg.maxAttempts) {
        store.markFailed(row.id, PREPARE_STATE.FAILED_TERMINAL, { lastError: `error-exhausted:${String(err?.message ?? err).slice(0, 120)}` });
        return { id: row.id, transition: 'error-exhausted' };
      }
      store.markFailed(row.id, PREPARE_STATE.FAILED_TEMPORARY, { lastError: String(err?.message ?? err).slice(0, 160) });
      store.requeue(row.id, t + backoffFor(attempts, cfg.backoffMs));
      return { id: row.id, transition: 'error-parked' };
    }
  }

  /**
   * One bounded driver tick: expire, then advance up to `limit` due rows.
   * Never throws; per-row reports carry transitions.
   */
  async function advanceOnce({ limit = null, rebindFn = null } = {}) {
    const expired = store.expireOverdue(50);
    const due = store.listDue({ limit: limit ?? cfg.tickLimit });
    const reports = [];
    for (const row of due) {
      // Capacity park BEFORE the atomic claim so a capacity wait never
      // consumes the attempt budget (attempts count provider steps).
      const limited = checkLimits(row.provider);
      if (limited) {
        store.markWaiting(row.id, { nextPollAt: clock() + 60_000, outcome: { limited } });
        reports.push({ id: row.id, transition: 'limited' });
        continue;
      }
      const claimed = store.claimDue(row.id, PREPARE_STATE.ACQUIRING);
      if (!claimed) continue;
      try {
        reports.push(await advanceRow(claimed, { rebindFn }));
      } catch (err) {
        reports.push({ id: row.id, transition: 'driver-error', error: String(err?.message ?? err).slice(0, 120) });
      }
    }
    return { expired, advanced: reports.length, reports };
  }

  return {
    config: cfg,
    startPreparation, advanceOnce, advanceRow,
    rememberContentBlocked, rememberAccountIneligible,
  };
}
