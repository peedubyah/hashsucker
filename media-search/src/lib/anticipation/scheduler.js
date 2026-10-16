/**
 * Anticipatory scheduler (anticipatory tranche).
 *
 * Drives future intents through the EXISTING production machinery:
 * anticipated → POST /api/media-prepare → prepared →
 * POST /api/media-request (normal path republishes from prepared truth
 * in milliseconds, firing consumer refresh) → byte probe → playable.
 *
 * No second ranking/fulfillment implementation: the scheduler only
 * sequences HTTP calls into the proven seams. Publication happens only
 * after a finalized TorrentFile exists (the prepare response carries it;
 * the publish call republishes that same identity via reuse).
 *
 * Exhaustion (probe fails + same-hash revalidation UNCACHED) triggers
 * withdrawal through the existing safe-unpublish path; history rows are
 * preserved and no provider GC runs.
 */
import { isPrepared, isPublished, prepareFailure, probeFailure } from '../requests/prepare-outcome.js';
import { isAuthoritativePartFile, vfsPartFile } from '../plex/vfs-path.js';
import { INTENT_STATES, intentBackoffMs } from './future-intents.js';
import { DEFER_REASONS } from '../defers/seerr-defer.js';
import { judgeReleaseQuality, ANTICIPATION_QUALITY } from './quality-gate.js';
import { probeByteReady, prewarmRanges } from './prewarm.js';
import { unpublishMedia } from '../library/unpublish.js';
import { recordServiceable, recordUnserviceable } from '../vfs/byte-health.js';

const PREPARE_TIMEOUT_MS = 5 * 60 * 1000;
const PLEX_CONFIRM_ATTEMPTS = 6;
const PLEX_CONFIRM_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 6;
const PARKED_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIONS_PER_TICK = 8;
// Nominal per-tick work budget, checked BETWEEN actions. A single action is
// never interrupted mid-flight: one provider prepare can legitimately run
// ~17s (observed), so a tick may exceed this nominal bound. The cap bounds how
// many actions are STARTED, not an absolute deadline.
const MAX_TICK_WORK_MS = 30_000;
// Floor on actions per tick, applied BEFORE the wall-clock budget can stop the
// drain. Runtime evidence (2026-10-16): one slow speculative P0 row
// (published_preparing re-running the full request path, ~60s) consumed the
// whole 30s budget every tick, so `stopReason=wall-clock-cap` ended the tick
// after a single action. A due requested-season row behind it (the exact
// household demand) stayed unprocessed for ~6 hours. The budget is a
// spend-control on NEW work, not a licence for one expensive row to starve the
// rest of the due set; every tick now starts at least this many actions (still
// hard-bounded by MAX_ACTIONS_PER_TICK) so cheap/consumer-ready work is never
// starved by one slow row.
const MIN_ACTIONS_PER_TICK = 4;
const PUBLISHED_CONFIRMATION_RETRY_MS = 60 * 60 * 1000;
const PUBLICATION_UNCONFIRMED = 'consumer-publication-unconfirmed';
// Keep the per-tick scan bounded, but large enough to pass a parked/exhausted
// prefix. The loop still performs at most one actionable intent per tick.
const DUE_SCAN_LIMIT = 50;

// Fallback prepare window used by priority classification when the scheduler
// did not supply its configured windows (direct callers/tests). The scheduler
// always passes windowsFor(intent).
const DEFAULT_PREPARE_DAYS = 3;

/** Defer reasons that describe a retryable market miss rather than a defect. */
function isRetryableMarketDefer(reason) {
  return reason === DEFER_REASONS.RELEASED_NO_CANDIDATE
    || reason === DEFER_REASONS.CANDIDATE_NOT_FULFILLABLE;
}

/**
 * Cold-retry eligibility for EXHAUSTED, AIRED, STILL-SEASON-OWNED obligations.
 *
 * Ordinary one-shot exhaustion keeps the old behaviour permanently: a row with
 * no continuing season owner, or whose defer reason is not a retryable market
 * miss, stays non-actionable forever.
 *
 * An active requested-season owner is a continuing durable obligation: the
 * household asked for the season, not for one attempt. So when such a row runs
 * out of hot attempts it keeps the obligation and is reconsidered only once the
 * cold park (PARKED_MS) has elapsed — never hot. `attempts` is preserved, so a
 * cold reconsideration permits exactly one further attempt and then re-parks;
 * it never restores a fresh hot budget.
 */
export function isColdRetryEligible(intent, nowMs, maxAttempts = MAX_ATTEMPTS) {
  if (!intent) return false;
  if (intent.state !== INTENT_STATES.FAILED) return false;
  if (intent.attempts < maxAttempts) return false;      // not exhausted: ordinary path owns it
  if (!intent.season_owners) return false;             // one-shot: no continuing obligation
  if (!isRetryableMarketDefer(intent.defer_reason)) return false;
  if (intent.next_check_at == null || intent.next_check_at > nowMs) return false;  // cold park not elapsed
  return true;
}

export function classifyIntentPriority(intent, nowMs, maxAttempts = MAX_ATTEMPTS, windows = null) {
  if (!intent || intent.state === INTENT_STATES.WITHDRAWN || intent.state === INTENT_STATES.PLAYABLE) return { className: 'P5', rank: 5, actionable: false };
  // Release wake: a row classified future-not-released whose expected_at has
  // passed needs its one-time rearm (pre-release classification cleared, one
  // further attempt) before ordinary exhaustion semantics apply. Without
  // this the store surfaces the row as due but the classifier parks it, so
  // the wake never runs and the row can never fulfill.
  if (intent.state === INTENT_STATES.FAILED
    && intent.defer_reason === DEFER_REASONS.FUTURE_NOT_RELEASED
    && intent.expected_at != null && intent.expected_at <= nowMs) {
    return { className: 'P2', rank: 2, actionable: true, releasedWake: true };
  }
  if (intent.state === INTENT_STATES.FAILED && intent.attempts >= maxAttempts) {
    // Season-owned aired work stays obligated and becomes cold-actionable once
    // its park elapses; everything else keeps the old permanent exhaustion.
    if (isColdRetryEligible(intent, nowMs, maxAttempts)) {
      return { className: 'P2', rank: 2, actionable: true, coldRetry: true };
    }
    return { className: 'P5', rank: 5, actionable: false };
  }
  if (intent.defer_reason === DEFER_REASONS.FUTURE_NOT_RELEASED && intent.expected_at != null && intent.expected_at > nowMs) {
    // Unreleased, but the prepare window exists precisely so bytes are ready
    // before air. Before the window opens the row waits (its poll is parked
    // at the window start); once inside, anticipation work is due and ranked
    // with released work of the same class.
    const prepareDays = windows?.prepareDays ?? DEFAULT_PREPARE_DAYS;
    const windowStart = intent.expected_at - prepareDays * 86400 * 1000;
    if (windowStart > nowMs) {
      return { className: 'P5', rank: 5, actionable: false, awaitingPrepareWindow: true };
    }
  }
  if (intent.state === INTENT_STATES.PUBLISHED_PREPARING) return { className: 'P0', rank: 0, actionable: true };
  const airedRequested = intent.season_owners && intent.expected_at != null && intent.expected_at <= nowMs;
  if (airedRequested && intent.state === INTENT_STATES.PREPARED) {
    return { className: 'P1', rank: 1, actionable: true };
  }
  if (airedRequested && (intent.state === INTENT_STATES.ANTICIPATED || intent.state === INTENT_STATES.FAILED)) {
    return { className: 'P2', rank: 2, actionable: true };
  }
  if (intent.state === INTENT_STATES.PREPARED) return { className: 'P3', rank: 3, actionable: true };
  if (intent.state === INTENT_STATES.ANTICIPATED) return { className: 'P4', rank: 4, actionable: true };
  if (intent.state === INTENT_STATES.FAILED) return { className: 'P5', rank: 5, actionable: true };
  return { className: 'P5', rank: 5, actionable: false };
}

export function createAnticipationScheduler({
  store,
  baseUrl,
  dataPlaneBaseUrl,
  cache = null,
  controlPlaneStore = null,
  fetchFn = fetch,
  checkTorBoxCachedFn = null,
  clock = () => Date.now(),
  log = () => {},
  prepareDays = 30,
  publishDays = 7,
  // TV episodes become useful at airtime, not weeks out: much tighter
  // internal windows (no new env surface — one media-type policy).
  tvPrepareDays = 3,
  tvPublishDays = 1,
  confirmConsumerPublicationFn = null,
  notifyConsumerPublicationFn = null,
  reconcileRequestedSeasonFn = null,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Near-release quality protection horizon: the speculative-publication
  // quality floor applies while the release is upcoming or fresh.
  // Older catalog falls back to the ranker's existing behavior bit-for-bit.
  qualityHorizonDays = 90,
  // Cooperative per-action wall-clock budget. A single intent action runs the
  // full request/prepare pipeline over HTTP; one pathological action must not
  // consume the whole tick (and four of them must not blow the tick bound).
  // On expiry the in-flight HTTP call is aborted and the action surfaces as a
  // bounded failure the tick's existing handler re-parks. One layer owns retry
  // (the intent backoff); this is a bound, not a retry.
  actionBudgetMs = 60_000,
} = {}) {
  if (!store) throw new Error('anticipation scheduler requires store');
  if (!baseUrl) throw new Error('anticipation scheduler requires baseUrl');
  const now = () => clock();
  let seasonReconciledLastTick = false;
  // Signal for the action currently in flight (single-flight tick, so one at a
  // time). Set by the tick, consumed by post() so the budget aborts the HTTP
  // call cooperatively instead of abandoning it.
  let actionSignal = null;

  async function post(path, body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onExternalAbort = () => ctl.abort();
    if (actionSignal) actionSignal.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const res = await fetchFn(`${String(baseUrl).replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
      if (actionSignal) actionSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  function priorityIsActionable(row) {
    return classifyIntentPriority(row, now(), MAX_ATTEMPTS, windowsFor(row)).actionable;
  }

  function windowsFor(intent) {
    if (intent.media_type === 'series') return { prepareDays: tvPrepareDays, publishDays: tvPublishDays };
    return { prepareDays, publishDays };
  }

  /**
   * Whether the speculative-publication quality floor applies to this
   * intent right now: expected date known AND the release is upcoming
   * or fresh (inside the quality horizon). Older/undated catalog keeps
   * the ranker's existing behavior bit-for-bit — the floor protects
   * near-release anticipation, never rewrites interactive semantics.
   */
  function qualityGateActive(intent, nowMs) {
    const exp = intent.expected_at;
    if (exp == null) return false;
    return exp > nowMs - qualityHorizonDays * 86400 * 1000;
  }

  /**
   * Pick the winning candidate out of a prepare response for quality
   * judging: the ranker's SELECTED candidate matched back into results
   * (exact attrs), else the top-ranked result, else the persisted
   * handoff filename (reuse responses carry no results). Returns null
   * when nothing describes a winner.
   */
  function pickPrepareWinner(json) {
    if (!json) return null;
    const results = Array.isArray(json.results) ? json.results : [];
    const selHash = (json.selection?.selected?.infoHash || '').toLowerCase() || null;
    const selIdx = json.selection?.selected?.fileIndex ?? null;
    if (selHash) {
      const hit = results.find((r) =>
        String(r.infoHash || '').toLowerCase() === selHash
        && (selIdx == null || r.fileIndex == null || r.fileIndex === selIdx));
      if (hit) {
        return { filename: hit.filename ?? null, sourceType: hit.release?.source ?? null, infoHash: selHash };
      }
    }
    const top = results[0];
    if (top) {
      return {
        filename: top.filename ?? null,
        sourceType: top.release?.source ?? null,
        infoHash: (top.infoHash || '').toLowerCase() || null,
      };
    }
    const ho = json.handoff;
    if (ho && ho.filename) {
      return { filename: ho.filename, sourceType: null, infoHash: (ho.infoHash || '').toLowerCase() || null };
    }
    return null;
  }

  async function prepareIntent(intent) {
    const body = {
      mediaId: intent.media_id,
      mediaType: intent.media_type,
      source: 'anticipation',
      sourceType: 'future-intent',
      sourceId: `future-intent:${intent.id}`,
    };
    if (intent.season != null) body.season = intent.season;
    if (intent.episode != null) body.episode = intent.episode;
    const r = await post('/api/media-prepare', body, PREPARE_TIMEOUT_MS);
    if (!isPrepared(r)) {
      // The endpoint answers 200 for market conditions too, so describe the
      // body rather than emitting an opaque `prepare-http-200`.
      const { error, reason } = prepareFailure(r);
      return { ok: false, terminal: r.status === 400, error, reason };
    }
    return { ok: true, torrentFileId: r.json.handoff.torrentFileId, winner: pickPrepareWinner(r.json), fresh: r.json?.alreadyPrepared !== true };
  }

  /**
   * Quality probe: full discovery + ranking through the existing
   * prepare endpoint with persist:false — zero writes, zero
   * presentation. Returns the current market winner (or null when the
   * market is empty) so the scheduler can judge quality before
   * committing to publish. Transport failure → not-ok (caller re-parks;
   * never treated as market evidence).
   */
  async function probeIntent(intent) {
    const body = {
      mediaId: intent.media_id,
      mediaType: intent.media_type,
      source: 'anticipation',
      sourceType: 'future-intent-probe',
      sourceId: `future-intent:${intent.id}`,
      persist: false,
    };
    if (intent.season != null) body.season = intent.season;
    if (intent.episode != null) body.episode = intent.episode;
    const r = await post('/api/media-prepare', body, PREPARE_TIMEOUT_MS);
    if (r.status !== 200) { const f = probeFailure(r); return { ok: false, ...f }; }
    return { ok: true, winner: pickPrepareWinner(r.json) };
  }

  async function publishIntent(intent) {
    // The normal request path republishes prepared truth (reuse) with
    // zero provider work and fires consumer refresh for overlap.
    const body = {
      mediaId: intent.media_id,
      mediaType: intent.media_type,
      source: 'anticipation',
      sourceType: 'future-intent-publish',
      sourceId: `future-intent:${intent.id}`,
    };
    if (intent.season != null) body.season = intent.season;
    if (intent.episode != null) body.episode = intent.episode;
    const r = await post('/api/media-request', body, REQUEST_TIMEOUT_MS);
    if (!isPublished(r)) { const f = publishFailure(r); return { ok: false, ...f }; }
    // `fulfilled` is the normal media-request contract for consumer
    // publication: it is returned only after the configured consumer can
    // see the item. `published`/`vfsPublished` describe internal progress
    // and are intentionally insufficient for playable intent state.
    return {
      ok: true,
      torrentFileId: r.json.handoff.torrentFileId,
      reuseMode: r.json.reuseMode ?? null,
      fulfilled: r.json.fulfilled === true,
    };
  }

  async function byteProbe(torrentFileId) {
    if (!dataPlaneBaseUrl) return false;
    try {
      const ok = await probeByteReady({ dataPlaneBaseUrl, torrentFileId, fetchFn });
      // Feed the runtime serviceability registry so a published-but-unusable
      // exact TorrentFile is reported truthfully even before any consumer read.
      if (ok) recordServiceable(torrentFileId);
      else recordUnserviceable(torrentFileId, { reason: 'byte-probe-failed' });
      return ok;
    } catch {
      recordUnserviceable(torrentFileId, { reason: 'byte-probe-error' });
      return false;
    }
  }

  async function confirmConsumerPublication(intent, { initial = false } = {}) {
    if (typeof confirmConsumerPublicationFn !== 'function') return false;
    const vfsEntry = intent.media_type === 'series' && intent.season != null && intent.episode != null
      ? cache?.getVfsTvEntry?.(intent.media_id, intent.season, intent.episode)
      : null;
    // Only the authoritative VFS publication is acceptable. There is no
    // synthesised fallback: every series row that reaches confirmation carries
    // a canonical path, and a guessed path could never match the real
    // MediaPart, so a fallback would silently fail a converged publication.
    const expectedPartFile = vfsPartFile(vfsEntry?.canonicalPath ?? null);
    const attempts = initial ? PLEX_CONFIRM_ATTEMPTS : 1;
    // Hoisted out of the retry loop: the authoritative publication cannot
    // change between attempts within one call, so re-reading it per attempt is
    // a repeated identical DB lookup.
    const canonicalPath = vfsEntry?.canonicalPath ?? null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await confirmConsumerPublicationFn({
          mediaId: intent.media_id,
          season: intent.season,
          episode: intent.episode,
          expectedPartFile,
        });
        if (expectedPartFile && result?.visible === true
            && isAuthoritativePartFile(result.mediaPart?.file, canonicalPath)) return true;
      } catch {}
      if (initial && attempt + 1 < attempts) await sleepFn(PLEX_CONFIRM_INTERVAL_MS);
    }
    return false;
  }

  async function revalidateUncached(infoHashHint, torrentFileId) {
    // Same-hash availability revalidation (read-only). Without a checker
    // we cannot prove exhaustion — fail closed (no withdrawal).
    if (typeof checkTorBoxCachedFn !== 'function') return null;
    try {
      const res = await checkTorBoxCachedFn([infoHashHint].filter(Boolean));
      const states = Array.isArray(res) ? res : res?.results ?? [];
      const hit = states.find((s) => (s.infoHash || s.hash) === infoHashHint);
      const state = hit?.state;
      if (state === 'uncached') return true;
      if (state === 'cached') return false;
      return null;
    } catch {
      return null;
    }
  }

  function launchPrewarm(intent, size) {
    // Best-effort background grid fill; never blocks the tick and never
    // fails publication. Plex on-demand serve remains the fallback.
    if (!dataPlaneBaseUrl || !intent.torrent_file_id) return;
    prewarmRanges({
      dataPlaneBaseUrl, torrentFileId: intent.torrent_file_id, size: size ?? null, fetchFn,
    }).then(
      (r) => log(`anticipation prewarm done media=${intent.media_id} warmed=${r.warmed}/${r.ranges} bytes=${r.bytes}`),
      (err) => log(`anticipation prewarm failed media=${intent.media_id} err=${String(err?.message || err).slice(0, 100)}`),
    ).catch(() => {});
  }

  async function withdrawIntent(intent, evidence) {
    if (!cache || !controlPlaneStore) {
      return { ok: false, error: 'withdraw-unwired:no-stores' };
    }
    try {
      await unpublishMedia({
        cache,
        controlPlaneStore,
        mediaId: intent.media_id,
        mediaType: intent.media_type,
        season: intent.season,
        episode: intent.episode,
      });
    } catch (err) {
      return { ok: false, error: `withdraw-failed:${String(err?.message || err).slice(0, 100)}` };
    }
    store.transition(intent.id, INTENT_STATES.WITHDRAWN, {
      last_error: `exhausted:${evidence}`,
      next_check_at: now() + PARKED_MS,
    });
    return { ok: true };
  }

  async function processIntent(intent) {
    const t0 = now();
    const done = (to, patch = {}) => {
      store.transition(intent.id, to, patch);
      return { acted: true, intentId: intent.id, media: intent.media_id, from: intent.state, to, ms: now() - t0 };
    };

    if (intent.state === INTENT_STATES.ANTICIPATED) {
      // Arr-satisfied items stay known but take no fulfillment action.
      if (intent.arr_satisfied) {
        return done(INTENT_STATES.ANTICIPATED, {
          last_error: 'arr-satisfied', next_check_at: now() + PARKED_MS,
        });
      }
      // Preparation window: far-future expectations sleep until the
      // window. TV episodes use the much tighter series window so an
      // episode three weeks out costs zero discovery. The sleep reason
      // is recorded so logs explain the wait.
      if (intent.expected_at != null) {
        const windowStart = intent.expected_at - windowsFor(intent).prepareDays * 86400 * 1000;
        if (windowStart > now()) {
          return done(INTENT_STATES.ANTICIPATED, {
            last_error: 'outside-prepare-window', next_check_at: windowStart,
          });
        }
      }
      const prep = await prepareIntent(intent);
      if (prep.ok) {
        // Speculative-publication quality floor (policy hardening):
        // preparation persists whatever the ranker selects (durable
        // intelligence, zero presentation), but only an acceptable
        // release advances toward publication. Garbage/unknown winners
        // park with an explicit reason; the intent stays alive and the
        // market is re-probed on later ticks so a later WEB-DL upgrades
        // naturally. Outside the near-release quality horizon the
        // ranker's existing behavior applies bit-for-bit.
        if (!qualityGateActive(intent, now())) {
          return done(INTENT_STATES.PREPARED, { torrent_file_id: prep.torrentFileId, next_check_at: now(), last_error: null });
        }
        let verdict = ANTICIPATION_QUALITY.UNKNOWN;
        if (prep.fresh && prep.winner) {
          verdict = judgeReleaseQuality(prep.winner);
        } else {
          // Reuse responses carry no market data (already-prepared, no
          // results) — judging the stale handoff would wedge the intent
          // on yesterday's CAM forever. Probe the live market instead
          // (zero writes); a probe transport failure parks cautiously.
          const probe = await probeIntent(intent);
          verdict = (probe.ok && probe.winner) ? judgeReleaseQuality(probe.winner) : ANTICIPATION_QUALITY.UNKNOWN;
        }
        if (verdict === ANTICIPATION_QUALITY.ACCEPTABLE) {
          return done(INTENT_STATES.PREPARED, { torrent_file_id: prep.torrentFileId, next_check_at: now(), last_error: null });
        }
        return done(INTENT_STATES.ANTICIPATED, {
          last_error: `waiting-for-acceptable-quality:${verdict}`,
          next_check_at: now() + intentBackoffMs(intent.attempts),
        });
      }
      if (prep.terminal || intent.attempts + 1 >= MAX_ATTEMPTS) {
        return done(INTENT_STATES.FAILED, { last_error: prep.error, next_check_at: now() + PARKED_MS });
      }
      return done(INTENT_STATES.ANTICIPATED, {
        last_error: prep.error, next_check_at: now() + intentBackoffMs(intent.attempts),
      });
    }

    if (intent.state === INTENT_STATES.PREPARED || intent.state === INTENT_STATES.PUBLISHED_PREPARING) {
      if (intent.arr_satisfied) {
        return done(intent.state, {
          last_error: 'arr-satisfied', next_check_at: now() + PARKED_MS,
        });
      }
      // Publication window: preparation may run earlier, but consumer
      // publication + prewarm wait until use is near (prewarm costs
      // ~142 MB/title and must not be spent months ahead). TV episodes
      // use the tighter series window. The sleep reason is recorded.
      if (intent.expected_at != null) {
        const windowStart = intent.expected_at - windowsFor(intent).publishDays * 86400 * 1000;
        if (windowStart > now()) {
          return done(intent.state, {
            last_error: 'outside-publish-window', next_check_at: windowStart,
          });
        }
      }
      // Publish-side quality floor: re-probe the live market before
      // presenting. Preparation may be older than the market (a CAM
      // bound weeks ago); publication fires only with a freshly
      // observed acceptable winner. Otherwise the row stays PREPARED —
      // durable truth retained — and publication retries later.
      if (qualityGateActive(intent, now())) {
        const probe = await probeIntent(intent);
        const verdict = (probe.ok && probe.winner) ? judgeReleaseQuality(probe.winner) : ANTICIPATION_QUALITY.UNKNOWN;
        if (verdict !== ANTICIPATION_QUALITY.ACCEPTABLE) {
          return done(intent.state, {
            last_error: `waiting-for-acceptable-quality:${verdict}`,
            next_check_at: now() + intentBackoffMs(intent.attempts),
          });
        }
      }
      const pub = await publishIntent(intent);
      if (!pub.ok) {
        return done(intent.state, { last_error: pub.error, next_check_at: now() + intentBackoffMs(intent.attempts) });
      }
      if (!pub.fulfilled) {
        if (intent.last_error === PUBLICATION_UNCONFIRMED && typeof notifyConsumerPublicationFn === 'function') {
          try {
            const refresh = await notifyConsumerPublicationFn({
              mediaId: intent.media_id,
              mediaType: intent.media_type,
              season: intent.season,
              episode: intent.episode,
            });
            log(`anticipation publication retry refresh media=${intent.media_id} intent=${intent.id} result=${JSON.stringify(refresh)}`);
          } catch (error) {
            log(`anticipation publication retry refresh failed media=${intent.media_id} intent=${intent.id} error=${String(error?.message || error).slice(0, 200)}`);
          }
        }
        const initialConfirmation = intent.last_error !== PUBLICATION_UNCONFIRMED;
        const confirmed = await confirmConsumerPublication(intent, { initial: initialConfirmation });
        if (!confirmed) {
          // Handoff/VFS/byte readiness are not consumer publication. Keep the
          // exact prepared truth retryable and do not probe or mark playable.
          log(`anticipation publication not confirmed media=${intent.media_id} intent=${intent.id} mode=${initialConfirmation ? 'initial' : 'retry'}`);
          return done(INTENT_STATES.PUBLISHED_PREPARING, {
            torrent_file_id: pub.torrentFileId,
            last_error: PUBLICATION_UNCONFIRMED,
            next_check_at: now() + (initialConfirmation ? intentBackoffMs(intent.attempts) : PUBLISHED_CONFIRMATION_RETRY_MS),
          });
        }
      }
      // Divergence (not failure): prepared truth decayed between prepare
      // and publish (stale placement/coords), so the publish path bound a
      // new winner through the normal pipeline. Converge explicitly onto
      // the published winner with recorded evidence rather than wedging.
      let tfId = pub.torrentFileId;
      let note = null;
      if (intent.torrent_file_id && pub.torrentFileId !== intent.torrent_file_id) {
        note = `winner-changed:${intent.torrent_file_id}->${pub.torrentFileId}`;
      }
      let size = null;
      try {
        size = controlPlaneStore?.getTorrentFile?.(pub.torrentFileId)?.size ?? null;
      } catch {}
      launchPrewarm({ ...intent, torrent_file_id: pub.torrentFileId }, size);
      const probeOk = await byteProbe(pub.torrentFileId);
      if (probeOk) {
        return done(INTENT_STATES.PLAYABLE, {
          torrent_file_id: pub.torrentFileId, last_error: note, next_check_at: now() + PARKED_MS,
        });
      }
      return done(INTENT_STATES.PUBLISHED_PREPARING, {
        torrent_file_id: pub.torrentFileId,
        last_error: note ?? 'byte-probe-pending',
        next_check_at: now() + intentBackoffMs(0),
      });
    }

    if (intent.state === INTENT_STATES.FAILED) {
      if (intent.attempts >= MAX_ATTEMPTS) {
        // Household deferred-request tranche: a Seerr-deferred row that
        // never fulfilled is still wanted — the human decision stands.
        // Park it at the low 7-day cadence instead of letting it die.
        // Rows without a retryable defer reason (operator seeds, Arr
        // rows, deterministic failures) keep the old exhaustion behavior.
        const d = intent.defer_reason;
        if (d === DEFER_REASONS.RELEASED_NO_CANDIDATE
          || d === DEFER_REASONS.CANDIDATE_NOT_FULFILLABLE) {
          // Cold reconsideration: re-arm due now so the NEXT tick performs
          // exactly one preparation attempt. `retry` increments attempts (never
          // resets it), so a repeat market miss fails the exhaustion check
          // again and parks for another full cold interval — one attempt per
          // cold cycle, never a fresh hot budget.
          store.retry(intent.id, now());
          return { acted: true, intentId: intent.id, from: 'failed', to: 'anticipated', ms: now() - t0, rearmed: true, coldRetry: true };
        }
        if (d === DEFER_REASONS.FUTURE_NOT_RELEASED) {
          // Release wake is one-time. Clear the pre-release classification so
          // subsequent normal failures obey the ordinary released-work park
          // and cannot be reselected by the expected_at override forever.
          store.retry(intent.id, now(), DEFER_REASONS.RELEASED_NO_CANDIDATE);
          return { acted: true, intentId: intent.id, from: 'failed', to: 'anticipated', ms: now() - t0, rearmed: true, released: true };
        }
        return { acted: false, intentId: intent.id, reason: 'attempts-exhausted' };
      }
      store.retry(intent.id, now() + intentBackoffMs(intent.attempts));
      return { acted: true, intentId: intent.id, from: 'failed', to: 'anticipated', ms: now() - t0 };
    }

    return { acted: false, intentId: intent.id, reason: `no-handler-${intent.state}` };
  }

  async function checkExhaustion(intent, infoHash) {
    const uncached = await revalidateUncached(infoHash, intent.torrent_file_id);
    if (uncached !== true) return { exhausted: false, uncached };
    return { exhausted: true, ...(await withdrawIntent(intent, `probe-failed+uncached tf=${intent.torrent_file_id}`)) };
  }

  /** One bounded tick: claim a single due intent and process it. */
  async function tickOnce() {
    const ordinaryTickStartedAt = now();
    if (typeof reconcileRequestedSeasonFn === 'function' && !seasonReconciledLastTick) {
      const seasons = store.listDueRequestedSeasons?.(1) ?? [];
      if (seasons.length > 0) {
        const season = seasons[0];
        try {
          const result = await reconcileRequestedSeasonFn(season);
          store.scheduleRequestedSeason(season.id, now() + 15 * 60 * 1000);
          seasonReconciledLastTick = true;
          return { acted: true, seasonId: season.id, season: `${season.media_id}:s${season.season}`, result };
        } catch (error) {
          store.scheduleRequestedSeason(season.id, now() + intentBackoffMs(0));
          seasonReconciledLastTick = true;
          return { acted: true, seasonId: season.id, error: String(error?.message || error).slice(0, 200) };
        }
      }
    }
    seasonReconciledLastTick = false;
    // Scan a bounded window rather than the old five-row prefix. This lets
    // terminal/parked backlog rows be skipped without allowing them to pin
    // later retryable publication work indefinitely.
    const dueList = store.due({ limit: DUE_SCAN_LIMIT });
    const classified = dueList.map((row, index) => ({
      row, index, priority: classifyIntentPriority(row, now(), MAX_ATTEMPTS, windowsFor(row)),
    }));
    log(`scheduler due-snapshot limit=${DUE_SCAN_LIMIT} count=${dueList.length} ids=${dueList.map((row) => row.id).join(',')}`);
    classified.forEach(({ row, priority }) => log(`scheduler classify id=${row.id} state=${row.state} class=${priority.className} attempts=${row.attempts} actionable=${priority.actionable} cold=${priority.coldRetry === true}`));
    const orderedDue = classified
      .filter(({ priority }) => priority.actionable)
      .sort((a, b) => (a.priority.rank - b.priority.rank) || (a.index - b.index));

    // Class-fair ordering: interleave actionable rows across priority classes
    // (round-robin by class rank) so a large same-class backlog cannot
    // monopolize the whole tick. Runtime evidence (2026-10-16): 9 blocked
    // `published_preparing` episodes (P0, hourly retry, always blocked) filled
    // every tick's wall-clock budget, so `released-request-follow-up` rows (P4)
    // that must re-probe a recovered route NEVER ran (attempts stayed 0 for
    // hours). Interleaving guarantees every present class gets a turn while
    // preserving priority order within a class.
    const byClass = new Map();
    for (const item of orderedDue) {
      const key = item.priority.className;
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key).push(item);
    }
    const classOrder = [...byClass.keys()]
      .sort((a, b) => byClass.get(a)[0].priority.rank - byClass.get(b)[0].priority.rank);
    const fairOrder = [];
    for (let progressed = true; progressed;) {
      progressed = false;
      for (const key of classOrder) {
        const queue = byClass.get(key);
        if (queue.length > 0) { fairOrder.push(queue.shift()); progressed = true; }
      }
    }

    // Cheap waiting for unreleased rows. A future-not-released row whose
    // prepare window has not opened is not actionable, but without this its
    // poll stays at seed time, so every interval re-classifies it (and every
    // future episode inflates the due snapshot). Park the poll at the window
    // open — idempotent, and the row becomes due exactly when it can act.
    let parkedFuture = 0;
    for (const { row } of classified) {
      if (priorityIsActionable(row)) continue;
      if (row.state !== INTENT_STATES.ANTICIPATED) continue;
      if (row.defer_reason !== DEFER_REASONS.FUTURE_NOT_RELEASED) continue;
      if (row.expected_at == null || row.expected_at <= now()) continue;
      const windowStart = row.expected_at - windowsFor(row).prepareDays * 86400 * 1000;
      if (windowStart <= now() || row.next_check_at >= windowStart) continue;
      try {
        store.transition(row.id, INTENT_STATES.ANTICIPATED, {
          last_error: 'outside-prepare-window',
          next_check_at: windowStart,
        });
        parkedFuture += 1;
      } catch {
        // Parking is an optimization; a failed write leaves the previous
        // (more frequent) poll, never less work done.
      }
    }
    if (parkedFuture > 0) log(`scheduler parked-future count=${parkedFuture}`);

    let actions = 0;
    let lastResult = null;
    let stopReason = 'snapshot-exhausted';
    for (const { row: original, priority } of fairOrder) {
      if (actions >= MAX_ACTIONS_PER_TICK) { stopReason = 'action-cap'; break; }
      // Nominal budget: do not START another action once it is spent — but
      // never before MIN_ACTIONS_PER_TICK, so one slow row cannot starve the
      // rest of the due set. The action already in flight is allowed to finish.
      if (actions >= MIN_ACTIONS_PER_TICK && now() - ordinaryTickStartedAt >= MAX_TICK_WORK_MS) { stopReason = 'wall-clock-cap'; break; }
      let intent = original;
      // A released future-not-released row may have exhausted its pre-release
      // retry budget. Re-arm it and continue through the normal claim in this
      // same bounded tick; otherwise the rearm would add another full
      // scheduler interval before released fulfillment can begin.
      if (intent.state === INTENT_STATES.FAILED
        && intent.defer_reason === DEFER_REASONS.FUTURE_NOT_RELEASED
        && intent.expected_at != null && intent.expected_at <= now()
        && intent.attempts >= MAX_ATTEMPTS) {
        store.retry(intent.id, now(), DEFER_REASONS.RELEASED_NO_CANDIDATE);
        intent = store.findByIdentity({ mediaId: intent.media_id, season: intent.season, episode: intent.episode });
      }
      // Fresh anticipated work needs the atomic claim; mid-flow states
      // are already single-flight via the tick loop (plus crash recovery
      // in lifecycle tick semantics — a dead worker leaves a retryable
      // preparing row, reaped below).
      if (intent?.state === INTENT_STATES.ANTICIPATED) {
        if (!store.claim(intent.id)) continue;
      } else if (intent?.state === 'preparing') {
        // Orphaned preparing row (worker died after claim): requeue once.
        store.transition(intent.id, INTENT_STATES.ANTICIPATED, {
          last_error: 'orphaned-preparing-requeued',
          next_check_at: now() + intentBackoffMs(intent.attempts ?? 0),
        });
        return { acted: true, intentId: intent.id, from: 'preparing', to: 'anticipated', ms: 0 };
      }
      try {
        // Cooperative per-action budget: abort the action's in-flight HTTP
        // call once the budget expires so one pathological action cannot
        // consume (or multiply across) the tick. The abort surfaces as a
        // thrown error handled by the existing catch below (re-park + retry).
        const actionCtl = new AbortController();
        const actionTimer = setTimeout(() => actionCtl.abort(), actionBudgetMs);
        actionSignal = actionCtl.signal;
        let result;
        try {
          result = await processIntent(intent);
        } finally {
          clearTimeout(actionTimer);
          actionSignal = null;
        }
        lastResult = result;
        actions += 1;
        log(`scheduler due-row id=${intent.id} state=${intent.state} class=${priority.className} attempts=${intent.attempts} next=${intent.next_check_at} result=${JSON.stringify(result)}`);
        // Continue through the bounded due snapshot when a terminal/parked
        // row made no progress, so another episode can still advance.
        // An attempts-exhausted row is parked state, not useful work.
        if (result?.reason === 'attempts-exhausted') continue;
        if (actions >= MIN_ACTIONS_PER_TICK && now() - ordinaryTickStartedAt >= MAX_TICK_WORK_MS) { stopReason = 'wall-clock-cap'; break; }
        continue;
      } catch (err) {
        // One erroring action re-parks ITS row and the tick CONTINUES: ending
        // the whole tick on the first error let a persistently-erroring row
        // (e.g. a P1 publish that keeps failing) starve every later class —
        // the same starvation the class-fair ordering fixes for success paths.
        store.transition(intent.id, INTENT_STATES.ANTICIPATED, {
          last_error: String(err?.message || err).slice(0, 200),
          next_check_at: now() + intentBackoffMs(intent.attempts ?? 0),
        });
        actions += 1;
        lastResult = { acted: true, intentId: intent.id, from: intent.state, to: 'anticipated', ms: 0, error: true };
        log(`scheduler due-row id=${intent.id} state=${intent.state} class=${priority.className} attempts=${intent.attempts} result=error:${String(err?.message || err).slice(0, 120)}`);
        if (actions >= MIN_ACTIONS_PER_TICK && now() - ordinaryTickStartedAt >= MAX_TICK_WORK_MS) { stopReason = 'wall-clock-cap'; break; }
        continue;
      }
    }
    log(`scheduler drain actions=${actions} stopReason=${stopReason} durationMs=${now() - ordinaryTickStartedAt} nominalCapMs=${MAX_TICK_WORK_MS}`);
    return lastResult ?? { acted: actions > 0, actions, stopReason, durationMs: now() - ordinaryTickStartedAt };
  }

  return { tickOnce, processIntent, checkExhaustion, withdrawIntent, launchPrewarm };
}
