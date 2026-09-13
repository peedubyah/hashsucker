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
import { INTENT_STATES, intentBackoffMs } from './future-intents.js';
import { DEFER_REASONS } from '../defers/seerr-defer.js';
import { judgeReleaseQuality, ANTICIPATION_QUALITY } from './quality-gate.js';
import { probeByteReady, prewarmRanges } from './prewarm.js';
import { unpublishMedia } from '../library/unpublish.js';

const PREPARE_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const PARKED_MS = 7 * 24 * 60 * 60 * 1000;

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
  // Near-release quality protection horizon: the speculative-publication
  // quality floor applies while the release is upcoming or fresh.
  // Older catalog falls back to the ranker's existing behavior bit-for-bit.
  qualityHorizonDays = 90,
} = {}) {
  if (!store) throw new Error('anticipation scheduler requires store');
  if (!baseUrl) throw new Error('anticipation scheduler requires baseUrl');
  const now = () => clock();

  async function post(path, body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
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
    }
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
    if (r.status !== 200 || r.json?.prepared !== true || !r.json?.handoff?.torrentFileId) {
      return { ok: false, terminal: r.status === 400, error: r.json?.error || `prepare-http-${r.status}` };
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
    if (r.status !== 200) {
      return { ok: false, error: r.json?.error || `probe-http-${r.status}` };
    }
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
    if (r.status !== 200 || !r.json?.handoff?.torrentFileId) {
      return { ok: false, error: r.json?.error || `publish-http-${r.status}` };
    }
    return { ok: true, torrentFileId: r.json.handoff.torrentFileId, reuseMode: r.json.reuseMode ?? null };
  }

  async function byteProbe(torrentFileId) {
    if (!dataPlaneBaseUrl) return false;
    try {
      return await probeByteReady({ dataPlaneBaseUrl, torrentFileId, fetchFn });
    } catch {
      return false;
    }
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
          || d === DEFER_REASONS.CANDIDATE_NOT_FULFILLABLE
          || d === DEFER_REASONS.FUTURE_NOT_RELEASED) {
          store.retry(intent.id, now() + PARKED_MS);
          return { acted: true, intentId: intent.id, from: 'failed', to: 'anticipated', ms: now() - t0, rearmed: true };
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
    const dueList = store.due(5);
    for (const intent of dueList) {
      // Fresh anticipated work needs the atomic claim; mid-flow states
      // are already single-flight via the tick loop (plus crash recovery
      // in lifecycle tick semantics — a dead worker leaves a retryable
      // preparing row, reaped below).
      if (intent.state === INTENT_STATES.ANTICIPATED) {
        if (!store.claim(intent.id)) continue;
      } else if (intent.state === 'preparing') {
        // Orphaned preparing row (worker died after claim): requeue once.
        store.transition(intent.id, INTENT_STATES.ANTICIPATED, {
          last_error: 'orphaned-preparing-requeued',
          next_check_at: now() + intentBackoffMs(intent.attempts ?? 0),
        });
        return { acted: true, intentId: intent.id, from: 'preparing', to: 'anticipated', ms: 0 };
      }
      try {
        return await processIntent(intent);
      } catch (err) {
        store.transition(intent.id, INTENT_STATES.ANTICIPATED, {
          last_error: String(err?.message || err).slice(0, 200),
          next_check_at: now() + intentBackoffMs(intent.attempts ?? 0),
        });
        return { acted: true, intentId: intent.id, from: intent.state, to: 'anticipated', ms: 0, error: true };
      }
    }
    return { acted: false };
  }

  return { tickOnce, processIntent, checkExhaustion, withdrawIntent, launchPrewarm };
}
