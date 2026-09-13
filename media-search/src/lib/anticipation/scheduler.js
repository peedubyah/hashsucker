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
    return { ok: true, torrentFileId: r.json.handoff.torrentFileId };
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
      // Preparation window: far-future expectations sleep until the window.
      if (intent.expected_at != null) {
        const windowStart = intent.expected_at - prepareDays * 86400 * 1000;
        if (windowStart > now()) {
          return done(INTENT_STATES.ANTICIPATED, { next_check_at: windowStart });
        }
      }
      const prep = await prepareIntent(intent);
      if (prep.ok) {
        return done(INTENT_STATES.PREPARED, { torrent_file_id: prep.torrentFileId, next_check_at: now(), last_error: null });
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
      // ~142 MB/title and must not be spent months ahead).
      if (intent.expected_at != null) {
        const windowStart = intent.expected_at - publishDays * 86400 * 1000;
        if (windowStart > now()) {
          return done(intent.state, { next_check_at: windowStart });
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
      if (intent.attempts >= MAX_ATTEMPTS) return { acted: false, intentId: intent.id, reason: 'attempts-exhausted' };
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
