/**
 * T9 — playback redundancy activation coordinator (Node side).
 *
 * Adapted from the proven HY4 P2I/P2K coordinator on m3-north-db.
 * Coordinates, per exact TorrentFile at runtime:
 *   T7 ensureSecondPlacement
 *   + truthful T8 serving-primary attribution
 *   + T6 prewarmPlacement
 * Not wired into VFS GET yet; the VFS will call notifyForegroundDemand
 * and reportServingPrimary in a later slice.
 *
 * TRIGGER (the only playback-intent signal)
 *   notifyForegroundDemand({ torrentFileId }) starts one activation
 *   flight per TF, fire-and-forget. Never throws, never awaits
 *   provider I/O, never blocks the caller.
 *
 * STANDBY RESOLUTION (explicit, no scoring, no array-order reliance)
 *   - When T7 returns `created` with a placementId, the standby IS that
 *     T7-targeted placement (by construction the missing/other provider).
 *   - When T7 returns `already_ready`, the standby is resolved from
 *     durable placement identity: the bound placement that is NOT the
 *     actual initial serving primary (live T8 attribution, or a
 *     notify-time hint ranking below it). With no primary known there
 *     is no standby to select — the flight stays pending for a
 *     provider-backed demand instead of guessing.
 *
 * STRUCTURAL GATING (no timing guesses)
 *   The flight proceeds on two independent structural gates:
 *   (a) T7 settled (bounded by T7's own provider-work bounds), and
 *   (b) for already_ready, a VALID request-scoped primary attribution
 *       reported after flight start (or a notify-time hint, which ranks
 *       below live attribution).
 *   There is no attribution timer and no fixed fallback provider. A
 *   flight with settled T7 and no valid primary stays pending:
 *   local-only (cache-hit) demands contribute nothing, and a later
 *   provider-backed report for the same TF settles the SAME flight
 *   (single-flight dedupe routes its report to the waiter). The
 *   `created` fast path needs no attribution at all: a T7-created
 *   placement IS the standby by construction.
 *   A GC-only TTL (DEFAULT_PENDING_TTL_MS) bounds process-local state:
 *   its expiry returns the TF to inactive with zero selection and zero
 *   prewarm — never a guess, never cooldown, never a provider failure.
 *
 * LIFECYCLE (minimal, bounded)
 *   inactive -> activating -> ready | pending | unavailable | failed
 *   `pending` / `unavailable` / `failed` carry a bounded cooldown
 *   (DEFAULT_COOLDOWN_MS); a single activation never spins on RD pending
 *   state and never retries by itself. A later foreground demand after
 *   cooldown expiry may start one new flight. `ready` is sticky.
 *
 * ORDERING
 *   Node runs T7 then T6. Refresh/retry runs server-side inside the T5
 *   Rust prewarm endpoint (exactly one refresh then one prewarm retry),
 *   so Node makes no separate refresh call.
 *
 * FAILURE ISOLATION
 *   Every redundancy fault becomes bounded telemetry. Nothing here throws
 *   into the serving path.
 *
 * PRODUCTION ADAPTATION vs the proven source: warmed capabilities are
 * identified by `capId` (production Rust reports the observability-only
 * capability id; later HY4 generations do not exist here); the fixed
 * experiment standby preference/fallback exports are dropped (a fixed
 * fallback contradicts the no-guess boundary — standby is always
 * bound-minus-actual-primary); the refresh mode name reflects the T5
 * endpoint vocabulary.
 */

export const PLAYBACK_REDUNDANCY_FLAG = 'HY4_PLAYBACK_REDUNDANCY';

export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * GC-only bound on an activation flight waiting for a provider-backed
 * demand. This is garbage collection for process-local state, NOT a
 * signal: expiry returns the TF to inactive with zero standby selection
 * and zero prewarm (reason `gc_expired_waiting_for_primary`). It must
 * never mean "guess a provider", never writes cooldown/failure state,
 * and never touches provider APIs. Injectable for deterministic tests.
 */
export const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000;

// No attribution timer, no fixed fallback: standby selection is driven
// by structural events (valid attribution arrival, T7 settlement), never
// by elapsed milliseconds or a preferred-provider constant.

const KNOWN_PROVIDERS = Object.freeze(['torbox', 'realdebrid']);

export function isPlaybackRedundancyEnabled(env = process.env) {
  try {
    return env?.[PLAYBACK_REDUNDANCY_FLAG] === '1';
  } catch {
    return false;
  }
}

/**
 * @param {Object} options
 * @param {Object|null} [options.store] - Control-plane store (getTorrentFile,
 *   findPlacementByInfoHash, listProviderRefsForTorrentFile).
 * @param {Object|null} [options.ensurer] - T7 { ensureSecondPlacement }.
 * @param {Object|null} [options.prewarmCaller] - T6 { prewarmPlacement }.
 * @param {Function} [options.now]
 * @param {Function|null} [options.logger]
 * @param {number} [options.cooldownMs]
 * @param {number} [options.pendingTtlMs] - GC-only bound on a flight
 *   waiting for a provider-backed demand (default
 *   DEFAULT_PENDING_TTL_MS). Expiry returns the TF to inactive with zero
 *   selection and zero prewarm. Injectable for deterministic tests.
 * @param {boolean} [options.enabled] - HY4_PLAYBACK_REDUNDANCY gate.
 */
export function createPlaybackRedundancy({
  store = null,
  ensurer = null,
  prewarmCaller = null,
  now = () => Date.now(),
  logger = null,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  pendingTtlMs = DEFAULT_PENDING_TTL_MS,
  enabled = false,
} = {}) {
  const log = logger ?? (() => {});
  const cooldown = Math.max(0, Number(cooldownMs) || 0);
  const pendingTtl = Math.max(0, Number(pendingTtlMs) || 0);
  // Single activation flight per TF: concurrent foreground demands for the
  // same TorrentFile share one chain. This map is what makes repeated
  // demands free.
  const flights = new Map();
  // Terminal activation state per TF (ready is sticky; failures cool down).
  const states = new Map();

  function getActivationState(torrentFileId) {
    const key = String(torrentFileId ?? '');
    const entry = states.get(key);
    if (entry) return { status: entry.status, updatedAt: entry.updatedAt };
    return { status: 'inactive', updatedAt: null };
  }

  function getActivation(torrentFileId) {
    const entry = states.get(String(torrentFileId ?? ''));
    return entry?.telemetry ?? null;
  }

  function getFlight(torrentFileId) {
    return flights.get(String(torrentFileId ?? '')) ?? null;
  }

  // Request-scoped serving-primary signals. Keyed per TorrentFile; each
  // report bumps a sequence number so a flight only ever consumes
  // attribution that arrived AFTER the flight started (stale signals
  // from older pool lifetimes are ignored for exclusion, never guessed
  // from). At most one activation flight exists per TF, hence at most
  // one waiter per TF. `primaryLog` keeps the capped per-TF report
  // history so a flight whose T7 settles after several demands still
  // consumes the FIRST valid report of its lifetime ("initial serving
  // provider"), not the latest. Cap bounds process-local state.
  const primarySignals = new Map();
  const primaryWaiters = new Map();
  const primaryLog = new Map();
  const PRIMARY_LOG_CAP = 16;

  function primarySeq(torrentFileId) {
    return primarySignals.get(String(torrentFileId ?? ''))?.seq ?? 0;
  }

  function getServingPrimary(torrentFileId) {
    const entry = primarySignals.get(String(torrentFileId ?? ''));
    return entry ? { seq: entry.seq, attribution: entry.attribution, at: entry.at } : null;
  }

  /**
   * Record the request-scoped serving primary for one demand (T8
   * attribution shape: provider/providerResourceId/providerFileId/capId).
   * Called at upstream-header time, not body end. Never throws, never
   * awaits provider I/O, never blocks serving.
   *
   * A null/invalid report records a signal (sequence bump) but does NOT
   * resolve waiters: absence is "no information" (e.g. a pure cache hit
   * carried no provider), not an answer, and resolving on it would let a
   * cache-hit demand poison the flight while the real primary becomes
   * knowable a moment later. Waiters resolve only on a valid report.
   */
  function reportServingPrimary({
    torrentFileId,
    provider = null,
    providerResourceId = null,
    providerFileId = null,
    capId = null,
  } = {}) {
    try {
      const tfId = typeof torrentFileId === 'string' ? torrentFileId : '';
      if (!tfId) return { recorded: false, reason: 'invalid-input' };
      const prov = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
      const rid = typeof providerResourceId === 'string' ? providerResourceId.trim() : '';
      const valid = prov !== '' && KNOWN_PROVIDERS.includes(prov) && rid !== '';
      const attribution = valid ? {
        provider: prov,
        providerResourceId: rid,
        providerFileId: typeof providerFileId === 'string' && providerFileId.trim() !== ''
          ? providerFileId.trim()
          : null,
        capId: typeof capId === 'string' && capId.trim() !== '' ? capId.trim() : null,
      } : null;
      const prev = primarySignals.get(tfId);
      const seq = (prev?.seq ?? 0) + 1;
      const at = now();
      primarySignals.set(tfId, { seq, attribution, at });
      const logArr = primaryLog.get(tfId) ?? [];
      logArr.push({ seq, attribution, at });
      while (logArr.length > PRIMARY_LOG_CAP) logArr.shift();
      primaryLog.set(tfId, logArr);
      try {
        log(`[t9] serving-primary tf=${tfId} seq=${seq} valid=${valid} `
          + `provider=${attribution?.provider ?? 'none'} `
          + `resource=${attribution?.providerResourceId ?? 'none'} `
          + `cap=${attribution?.capId ?? '-'}`);
      } catch {
        // Telemetry logging must never break reporting.
      }
      const waiters = primaryWaiters.get(tfId);
      // Only a VALID report resolves waiters. A null report (absent or
      // malformed attribution, e.g. a pure cache hit) is recorded for
      // observability but is "no information", not an answer.
      if (attribution && waiters?.length) {
        primaryWaiters.set(tfId, []);
        for (const finish of waiters) {
          try {
            finish(attribution);
          } catch {
            // A waiter fault must never break reporting.
          }
        }
      }
      return { recorded: true, seq, valid };
    } catch {
      return { recorded: false, reason: 'report-error' };
    }
  }

  /**
   * Drain (and resolve with null) any parked waiter for a TF. Called on
   * every terminal path so no waiter closure ever outlives its flight.
   * Resolving with null is safe: the flight is over, and any future
   * flight only consumes reports newer than its own start sequence.
   */
  function drainPrimaryWaiters(torrentFileId) {
    const key = String(torrentFileId ?? '');
    const waiters = primaryWaiters.get(key) ?? [];
    primaryWaiters.set(key, []);
    for (const finish of waiters) {
      try {
        finish(null);
      } catch {
        // A waiter fault must never break cleanup.
      }
    }
  }

  /**
   * Await a VALID attribution from this flight's lifetime. If several
   * valid reports already arrived, the FIRST wins — the flight's initial
   * serving provider. Null reports never resolve. There is deliberately
   * NO timeout here: settlement is structural (valid report arrival,
   * terminal T7, or GC expiry), never elapsed milliseconds.
   */
  function awaitPrimary(torrentFileId, startSeq) {
    const key = String(torrentFileId ?? '');
    const arr = primaryLog.get(key) ?? [];
    const found = arr.find((e) => e.seq > startSeq && e.attribution);
    if (found) {
      return Promise.resolve(found.attribution);
    }
    return new Promise((resolve) => {
      function finish(attribution) {
        resolve(attribution);
      }
      const arr = primaryWaiters.get(key) ?? [];
      arr.push(finish);
      primaryWaiters.set(key, arr);
    });
  }

  /**
   * Resolve an attributed (provider, resourceId) pair to the durable
   * placement id via the same lineage check standby resolution uses
   * (provider row for this TF's infoHash + present+mapped bound ref).
   * Returns null when unresolvable: provider-level exclusion still
   * applies in that case.
   */
  function resolvePrimaryPlacement({ torrentFileId, provider, providerResourceId } = {}) {
    try {
      if (!store || typeof store.getTorrentFile !== 'function') return null;
      const tf = store.getTorrentFile(torrentFileId);
      if (!tf || typeof store.findPlacementByInfoHash !== 'function') return null;
      const placement = store.findPlacementByInfoHash(provider, tf.infoHash);
      if (!placement || String(placement.providerResourceId ?? '') !== String(providerResourceId ?? '')) {
        return null;
      }
      const refs = typeof store.listProviderRefsForTorrentFile === 'function'
        ? store.listProviderRefsForTorrentFile(torrentFileId) ?? []
        : [];
      const bound = refs.some((r) => r.placementId === placement.id
        && r.present !== false && r.mappingState === 'mapped');
      return bound ? placement.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the standby placement for an already dual-placed TF from
   * durable placement identity. Never uses coordinate array order.
   */
  function resolveStandbyPlacement({ torrentFileId, primaryProvider = null, primaryPlacementId = null } = {}) {
    if (!store || typeof store.getTorrentFile !== 'function') {
      return { status: 'no-standby', reason: 'store-unavailable' };
    }
    const tf = store.getTorrentFile(torrentFileId);
    if (!tf) return { status: 'no-standby', reason: 'unknown-torrent-file' };
    const refs = typeof store.listProviderRefsForTorrentFile === 'function'
      ? store.listProviderRefsForTorrentFile(torrentFileId) ?? []
      : [];
    const bound = [];
    for (const provider of KNOWN_PROVIDERS) {
      let placement = null;
      try {
        placement = store.findPlacementByInfoHash(provider, tf.infoHash);
      } catch {
        placement = null;
      }
      if (!placement) continue;
      const ok = refs.some((r) => r.placementId === placement.id
        && r.present !== false && r.mappingState === 'mapped');
      if (ok) bound.push({ provider, placementId: placement.id });
    }
    if (bound.length === 0) return { status: 'no-standby', reason: 'no-bound-second-placement' };
    let candidates = bound;
    const primaryId = primaryPlacementId != null ? String(primaryPlacementId) : null;
    const primaryProv = primaryProvider != null ? String(primaryProvider).trim().toLowerCase() : null;
    if (primaryId) {
      candidates = bound.filter((b) => b.placementId !== primaryId);
    } else if (primaryProv) {
      candidates = bound.filter((b) => b.provider !== primaryProv);
    }
    if (candidates.length === 0) {
      return { status: 'no-standby', reason: 'only-primary-bound' };
    }
    // Without an actual primary to exclude there is no standby to
    // select — return explicitly instead of guessing. (With the primary
    // excluded, a dual-placed TF leaves exactly one candidate, so no
    // ranking or order reliance remains.)
    if (!primaryId && !primaryProv) {
      return { status: 'no-standby', reason: 'no-attributed-primary' };
    }
    return { status: 'ok', provider: candidates[0].provider, placementId: candidates[0].placementId };
  }

  function finishFlight(torrentFileId, telemetry) {
    const key = String(torrentFileId);
    drainPrimaryWaiters(key);
    flights.delete(key);
    states.set(key, {
      status: telemetry.activationStatus,
      updatedAt: now(),
      telemetry,
    });
    try {
      log(`[t9] activation tf=${torrentFileId} result=${telemetry.activationStatus} `
        + `standby=${telemetry.standbyProvider ?? 'none'} `
        + `primary=${telemetry.primary?.provider ?? 'none'}:${telemetry.primary?.source ?? 'none'} `
        + `t7=${telemetry.t7?.status ?? 'none'}:${telemetry.t7?.apiCalls ?? 0} `
        + `prewarm=${telemetry.prewarm?.status ?? 'none'}:${telemetry.prewarm?.apiDelta ?? '-'} `
        + `elapsedMs=${telemetry.elapsedMs} waited=${telemetry.waitedOnActivation}`);
    } catch {
      // Telemetry logging must never break the serving path.
    }
    return telemetry;
  }

  /**
   * GC terminal: return a TF to inactive. Drains the waiter, removes
   * the flight, and DELETES any state entry — this is not cooldown and
   * not a provider failure, so a later demand starts a fresh flight.
   * Performs zero standby selection and zero prewarm by construction.
   * The explicit reason is carried in the returned telemetry and log.
   */
  function finishFlightInactive(torrentFileId, telemetry) {
    const key = String(torrentFileId);
    drainPrimaryWaiters(key);
    flights.delete(key);
    states.delete(key);
    try {
      log(`[t9] activation tf=${torrentFileId} result=gc-expired `
        + `reason=${telemetry?.primary?.reason ?? 'gc_expired_waiting_for_primary'} `
        + `elapsedMs=${telemetry?.elapsedMs ?? '-'}`);
    } catch {
      // Telemetry logging must never break cleanup.
    }
    return telemetry;
  }

  async function runActivation({ torrentFileId, primaryProvider, primaryPlacementId, triggerTimestamp }) {
    const t0 = now();
    const GC = 't9-gc-expired';
    // GC-only TTL: single timer from flight start. T7 and prewarm carry
    // their own tighter provider-work bounds; this timer only guards the
    // wait for a provider-backed demand, and its expiry returns the TF
    // to inactive — never a guess, never cooldown.
    let gcTimer = null;
    const gcPromise = new Promise((resolve) => {
      gcTimer = setTimeout(() => {
        drainPrimaryWaiters(torrentFileId);
        resolve(GC);
      }, pendingTtl);
      if (gcTimer && typeof gcTimer.unref === 'function') {
        try {
          gcTimer.unref();
        } catch {
          // Non-Node runtimes may lack unref; the bounded timer still fires.
        }
      }
    });
    const clearGc = () => {
      if (gcTimer) {
        clearTimeout(gcTimer);
        gcTimer = null;
      }
    };
    const done = (partial) => {
      clearGc();
      return finishFlight(torrentFileId, {
        triggerTimestamp,
        torrentFileId,
        tfDurableKey: null,
        standbyProvider: null,
        standbyPlacementId: null,
        primary: null,
        t7: null,
        refresh: { mode: 'rust-prewarm-refresh-retry' },
        prewarm: null,
        activationStatus: 'failed',
        elapsedMs: now() - t0,
        waitedOnActivation: false,
        ...partial,
      });
    };
    const tfFallbackKey = (() => {
      try {
        const tf = store?.getTorrentFile?.(torrentFileId);
        return tf ? `${tf.infoHash}:${tf.size}:${tf.internalPath}` : null;
      } catch {
        return null;
      }
    })();
    const gcDone = (t7Summary) => {
      clearGc();
      return finishFlightInactive(torrentFileId, {
        triggerTimestamp,
        torrentFileId,
        tfDurableKey: tfFallbackKey,
        standbyProvider: null,
        standbyPlacementId: null,
        primary: { source: 'none', reason: 'gc_expired_waiting_for_primary' },
        t7: t7Summary ?? null,
        refresh: { mode: 'rust-prewarm-refresh-retry' },
        prewarm: null,
        activationStatus: 'gc-expired',
        elapsedMs: now() - t0,
        waitedOnActivation: false,
      });
    };
    // SEQUENCING: T7 starts IMMEDIATELY — it never waits for
    // serving-primary attribution. Fresh (post-flight-start) attribution
    // landing during T7 is consumed below with zero extra waiting.
    const startSeq = primarySeq(torrentFileId);
    const t7Settled = ensurer.ensureSecondPlacement({ torrentFileId }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    // Fresh valid primary only: the FIRST valid report newer than
    // flight start (the flight's initial serving provider). Later
    // reports never redefine it. Stale or absent signals are never
    // consumed.
    const freshPrimary = () => {
      const arr = primaryLog.get(String(torrentFileId ?? '')) ?? [];
      const found = arr.find((e) => e.seq > startSeq && e.attribution);
      return found?.attribution ?? null;
    };
    const settled = await Promise.race([t7Settled, gcPromise]);
    if (settled === GC) return gcDone(null);
    if (!settled.ok) {
      const error = settled.error;
      const peeked = freshPrimary();
      return done({
        primary: peeked
          ? { source: 'attributed', ...peeked }
          : { source: 'none', reason: 't7-error' },
        t7: { status: 'error', apiCalls: 0, reason: error?.message ?? String(error) },
        activationStatus: 'failed',
        error: error?.message ?? String(error),
      });
    }
    const t7 = settled.value;
    const t7Summary = {
      status: t7?.status ?? 'unknown',
      apiCalls: t7?.apiCalls ?? 0,
      ...(t7?.targetProvider ? { targetProvider: t7.targetProvider } : {}),
      ...(t7?.idSource ? { idSource: t7.idSource } : {}),
      ...(t7?.reason ? { reason: t7.reason } : {}),
      ...(t7?.operation ? { operation: t7.operation } : {}),
    };

    // Terminal T7 outcomes finish IMMEDIATELY: no prewarm without a
    // usable second placement, no attribution wait, no retry inside this
    // flight. Late attribution can never resurrect them (done() drains
    // the waiter and records terminal state). A later foreground demand
    // after cooldown may start one new flight.
    if (t7?.status !== 'created' && t7?.status !== 'already_ready') {
      const terminal = t7?.status === 'pending' ? 'pending'
        : t7?.status === 'unavailable' ? 'unavailable' : 'failed';
      const peeked = freshPrimary();
      return done({
        tfDurableKey: tfFallbackKey,
        primary: peeked
          ? { source: 'attributed', ...peeked }
          : { source: 'none', reason: `t7-${terminal}` },
        t7: t7Summary,
        activationStatus: terminal,
      });
    }

    // Effective primary for standby exclusion. Live attribution (this
    // flight's actual initial serving provider) wins over the
    // notify-time hint, which ranks strictly below it. There is no
    // third option: without either, selection is explicitly refused
    // (no-attributed-primary) rather than guessed.
    const resolveEffectivePrimary = (attributed) => {
      if (attributed) {
        const placementId = resolvePrimaryPlacement({
          torrentFileId,
          provider: attributed.provider,
          providerResourceId: attributed.providerResourceId,
        });
        return {
          provider: attributed.provider,
          placementId,
          summary: {
            source: 'attributed',
            provider: attributed.provider,
            providerResourceId: attributed.providerResourceId,
            ...(attributed.providerFileId ? { providerFileId: attributed.providerFileId } : {}),
            ...(attributed.capId != null ? { capId: attributed.capId } : {}),
            ...(placementId ? { placementId } : { placementUnresolved: true }),
          },
        };
      }
      if (primaryProvider != null || primaryPlacementId != null) {
        return {
          provider: primaryProvider,
          placementId: primaryPlacementId,
          summary: {
            source: 'hint',
            ...(primaryProvider != null ? { provider: primaryProvider } : {}),
            ...(primaryPlacementId != null ? { placementId: primaryPlacementId } : {}),
          },
        };
      }
      return {
        provider: null,
        placementId: null,
        summary: { source: 'none', reason: 'no-attributed-primary' },
      };
    };

    let standbyProvider = null;
    let standbyPlacementId = null;
    let primarySummary;
    if (t7.status === 'created' && t7.placementId) {
      // CREATED FAST PATH (explicit): a T7-created placement IS the
      // standby by construction (the missing/other provider). No
      // primary attribution is required to identify it, and none is
      // awaited. A fresh signal is peeked for telemetry only.
      standbyPlacementId = t7.placementId;
      standbyProvider = t7.targetProvider ?? null;
      const peeked = freshPrimary();
      primarySummary = peeked
        ? { source: 'attributed', ...peeked }
        : { source: 'none', reason: 'not-required-created' };
    } else if (t7.status === 'already_ready') {
      // ALREADY_READY: Node must choose the other existing placement,
      // which requires the actual primary. A notify-time hint (when
      // provided) is usable immediately and ranks below live
      // attribution; otherwise park until a provider-backed demand
      // reports (GC expiry returns to inactive, never a guess).
      let attributed = freshPrimary();
      if (!attributed && primaryProvider == null && primaryPlacementId == null) {
        const raced = await Promise.race([awaitPrimary(torrentFileId, startSeq), gcPromise]);
        if (raced === GC || !raced) return gcDone(t7Summary);
        attributed = raced;
      }
      const effective = resolveEffectivePrimary(attributed);
      primarySummary = effective.summary;
      const resolved = resolveStandbyPlacement({
        torrentFileId,
        primaryProvider: effective.provider,
        primaryPlacementId: effective.placementId,
      });
      if (resolved.status !== 'ok') {
        return done({
          tfDurableKey: tfFallbackKey,
          primary: primarySummary,
          t7: t7Summary,
          activationStatus: 'failed',
          error: `standby-resolution-${resolved.reason}`,
        });
      }
      standbyProvider = resolved.provider;
      standbyPlacementId = resolved.placementId;
    } else {
      return done({
        tfDurableKey: tfFallbackKey,
        primary: { source: 'none', reason: 't7-created-without-placement' },
        t7: t7Summary,
        activationStatus: 'failed',
        error: 't7-created-without-placement',
      });
    }

    let prewarm;
    try {
      prewarm = await prewarmCaller.prewarmPlacement({
        torrentFileId,
        providerPlacementId: standbyPlacementId,
      });
    } catch (error) {
      return done({
        tfDurableKey: tfFallbackKey,
        standbyProvider,
        standbyPlacementId,
        primary: primarySummary,
        t7: t7Summary,
        activationStatus: 'failed',
        error: error?.message ?? String(error),
      });
    }
    const prewarmSummary = {
      status: prewarm?.status ?? 'unknown',
      apiDelta: prewarm?.apiDelta ?? null,
      ...(prewarm?.capId != null ? { capId: prewarm.capId } : {}),
      ...(prewarm?.elapsedMs != null ? { elapsedMs: prewarm.elapsedMs } : {}),
      ...(prewarm?.reason ? { reason: prewarm.reason } : {}),
    };
    const warmed = prewarm?.status === 'warmed' || prewarm?.status === 'already_warm';
    return done({
      tfDurableKey: prewarm?.tfDurableKey ?? tfFallbackKey,
      standbyProvider: prewarm?.provider ?? standbyProvider,
      standbyPlacementId,
      primary: primarySummary,
      t7: t7Summary,
      // Refresh/retry runs server-side inside the T5 Rust prewarm
      // endpoint (one refresh then one prewarm retry). Node makes no
      // separate refresh call; this names the mode honestly.
      refresh: { mode: 'rust-prewarm-refresh-retry' },
      prewarm: prewarmSummary,
      activationStatus: warmed ? 'ready' : 'failed',
    });
  }

  /**
   * Synchronous playback-intent entry point. Never throws, never awaits
   * provider I/O, never blocks the caller: the activation flight is
   * started fire-and-forget and the serving path continues independently.
   */
  function notifyForegroundDemand({ torrentFileId, primaryProvider = null, primaryPlacementId = null } = {}) {
    try {
      if (!enabled) return { scheduled: false, reason: 'disabled' };
      const tfId = typeof torrentFileId === 'string' ? torrentFileId : '';
      if (!tfId) return { scheduled: false, reason: 'invalid-input' };
      const existing = flights.get(tfId);
      if (existing) return { scheduled: false, reason: 'already-activating', flight: existing };
      const st = states.get(tfId);
      if (st) {
        if (st.status === 'ready') return { scheduled: false, reason: 'already-ready' };
        if (st.status !== 'inactive' && (now() - st.updatedAt) < cooldown) {
          return { scheduled: false, reason: 'cooldown', state: st.status };
        }
      }
      if (!store || !ensurer || !prewarmCaller) return { scheduled: false, reason: 'unwired' };
      const triggerTimestamp = now();
      const flight = runActivation({
        torrentFileId: tfId, primaryProvider, primaryPlacementId, triggerTimestamp,
      });
      flights.set(tfId, flight);
      // Swallow here: runActivation already records terminal telemetry in
      // `states`. An unobserved rejection must never surface to playback.
      flight.catch(() => {});
      return { scheduled: true, flight };
    } catch {
      return { scheduled: false, reason: 'notify-error' };
    }
  }

  return Object.freeze({
    notifyForegroundDemand,
    reportServingPrimary,
    getActivationState,
    getActivation,
    getFlight,
    getServingPrimary,
    resolveStandbyPlacement,
    enabled,
    cooldownMs: cooldown,
    pendingTtlMs: pendingTtl,
  });
}
