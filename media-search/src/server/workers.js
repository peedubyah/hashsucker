/**
 * Background workers — every process-local ticker the service runs.
 *
 * One owner for the product's time-driven behavior: consumer
 * reconciliation, corpus maintenance, anticipation scheduling, playback
 * observation, quality-upgrade watch (+ retirement sweep + coverage
 * escalation), permanent-storage promotion, generic download intents,
 * *arr sync, idle enrichment, and corpus hygiene.
 *
 * Contract: `startBackgroundWorkers({ discoveryCache, controlPlaneStore,
 * port })` wires and arms each worker that its env flag enables, and
 * returns handles the composition root needs:
 *   - nudgeScheduling(): pull the next anticipation tick forward
 *   - enrichmentStatus() / hygieneStatus(): operator-surface status
 *   - stop(): clear every armed timer (shutdown)
 *
 * Workers never block listen(): slow first ticks are deliberately
 * delayed, and each is single-flight with in-flight flags living here.
 */

import { envNumber } from '../lib/config/env.js';
import { runReconcile } from '../lib/consumers/reconcile.js';
import {
  createCorpusLifecycle,
  corpusUpdateIntervalMs,
  corpusAutoBootstrap,
  corpusMaintenanceEnabled,
  bootstrapSessionPolicy,
  isCorpusBusy,
} from '../lib/discovery/corpus-lifecycle.js';
import { createFutureIntentStore } from '../lib/anticipation/future-intents.js';
import { createPromotionStore } from '../lib/promotion/store.js';
import { createPromotionWorker } from '../lib/promotion/worker.js';
import { createDownloadStore } from '../lib/download/store.js';
import { createDownloadWorker } from '../lib/download/worker.js';
import { getPreparedDurableState } from '../api/media-request.js';
import { createAnticipationScheduler } from '../lib/anticipation/scheduler.js';
import { createIdleEnrichment, enrichmentIntervalMs } from '../lib/discovery/idle-enrichment.js';
import { createCorpusHygiene, hygieneIntervalMs } from '../lib/discovery/corpus-hygiene.js';
import { getMediaById } from '../lib/metadata/unified-search.js';
import { checkTorBoxCached } from '../lib/providers/torbox.js';
import { createArrClient } from '../lib/anticipation/arr-client.js';
import { createSecondPlacementEnsurer } from '../lib/control-plane/second-placement.js';
import { createRouteProviderSurfaces } from '../lib/control-plane/route-providers.js';
import {
  reconcileEvidenceDueRoutes,
  reconcileStaleRoutes,
  retireVerifiedDeadRedundantRoutes,
} from '../lib/control-plane/route-reconciler.js';
import { createArrSync } from '../lib/anticipation/arr-sync.js';
import { reconcileByteAuthority } from '../lib/vfs/byte-projection.js';
import { createSeasonReconciler } from '../lib/anticipation/season-reconciliation.js';
import { resolveSeerrSeasonEpisodes } from '../lib/intents/providers/seerr.js';
import { confirmPlexEpisode } from '../lib/consumers/plex.js';
import { notifyPlex } from '../lib/requests/plex-notifier.js';
import { createPreparationStore } from '../lib/prepare/store.js';
import { createPrepareDriver } from '../lib/prepare/driver.js';
import { createRdPrepareAdapter } from '../lib/prepare/rd-acquire.js';
import { createTorBoxPrepareAdapter } from '../lib/prepare/torbox-acquire.js';
import { createRealDebridClient } from '../lib/providers/realdebrid/client.js';

// NOTE (durability verdict tranche): background durability V1 is RETIRED.
// The named-repair runtime loop (scheduler + runtime + executor +
// provider-classifier) was removed: it enrolled rows nothing read,
// performed periodic TorBox snapshots nothing needed (request-time
// verification and playback-time recovery already cover staleness),
// and never proactively repaired anything. The enroller module remains
// as an inert compatibility registry so hot paths (VFS materialize,
// TorBox delivery) stay untouched; its calls are no-ops without a
// registered scheduler, which no longer exists.

export function startBackgroundWorkers({ discoveryCache, controlPlaneStore, port, dependencies = {} }) {
  const timers = new Set();
  // Every worker timer is tracked so stop() can clear the ones armed at
  // the time of shutdown.
  const arm = (fn, delayMs) => {
    const timer = setTimeout(fn, delayMs);
    timers.add(timer);
    if (timer.unref) timer.unref();
    return timer;
  };

// ─── consumer reconciliation ticker ─────────────────────────────────────
// Read-only consumer presence checks on a slow cadence (default 15 min,
// first run 60 s after boot so startup never blocks on consumer
// availability). One pass at a time; failures log and retry next run.
// Automatic retirement runs inside the pass only when RETIREMENT_ENABLED
// is explicitly set (default OFF).
const reconcileFlag = String(process.env.CONSUMER_RECONCILE_ENABLED ?? '').toLowerCase();
const reconcileEnabled = reconcileFlag !== '0' && reconcileFlag !== 'false';
const reconcileIntervalMs = (() => {
  const n = Number(process.env.CONSUMER_RECONCILE_INTERVAL_MS ?? 15 * 60 * 1000);
  return Number.isSafeInteger(n) && n >= 60_000 ? n : 15 * 60 * 1000;
})();
let reconcileTimer = null;
let reconcileInFlight = false;
function armReconcileTimer(delayMs) {
  reconcileTimer = arm(async () => {
    if (!reconcileInFlight) {
      reconcileInFlight = true;
      try {
        const summary = await runReconcile({ cache: discoveryCache, controlPlaneStore });
        console.log(
          `media-search: consumer reconcile pass: published=${summary.published} `
          + `eligible=${summary.eligible} retired=${summary.retired} consumers=${summary.consumers.join(',') || 'none'}`,
        );
      } catch (error) {
        console.warn('media-search: consumer reconcile pass failed', error?.message);
      } finally {
        reconcileInFlight = false;
      }
    }
    armReconcileTimer(reconcileIntervalMs);
  }, delayMs);
  if (reconcileTimer.unref) reconcileTimer.unref();
}
if (reconcileEnabled) {
  armReconcileTimer(60_000);
}

// ─── corpus maintenance ticker ──────────────────────────────────────
// Blank bootstrap + incremental DMM updates on a slow cadence (default
// 6 h, aligned to upstream sync). First tick 5 min after boot; the
// lifecycle persists last_check, so restarts never hammer GitHub.
// Single-flight via the lifecycle; failures back off boundedly and
// never destroy the serving corpus. Discovery stays live-only while
// the corpus is absent — the service never blocks on it.
// CORPUS_MAINTENANCE=0 (or CORPUS_ENABLED=0) disables both bootstrap and updates.
const corpusMaintenanceOn = corpusMaintenanceEnabled(process.env);
const corpusLifecycle = corpusMaintenanceOn
  ? createCorpusLifecycle({
    cache: discoveryCache,
    repo: process.env.CORPUS_DMM_REPO || 'debridmediamanager/hashlists',
    githubToken: process.env.CORPUS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || null,
    log: (msg) => console.log(`media-search: ${msg}`),
  })
  : null;
let corpusTimer = null;
function armCorpusTimer(delayMs) {
  corpusTimer = arm(async () => {
    try {
      if (corpusLifecycle) {
        const tick = corpusLifecycle.tick({
          intervalMs: corpusUpdateIntervalMs(process.env),
          autoBootstrap: corpusAutoBootstrap(process.env),
        });
        if (tick.action === 'bootstrap') {
          const session = bootstrapSessionPolicy();
          console.log(`media-search: corpus bootstrap session starting (max ${session.maxFragments} fragments)`);
          const result = await corpusLifecycle.bootstrap({
            maxFragments: session.maxFragments,
            maxWallMs: session.maxWallMs,
          });
          console.log(`media-search: corpus bootstrap session ok=${result.ok} complete=${result.complete ?? 0} failed=${result.failed ?? 0} quarantined=${result.quarantined ?? 0} boundedStop=${result.boundedStop ?? false} remaining=${result.remaining ?? 0}`);
          // Bounded sessions continue soon (polite pause); a finished
          // baseline returns to the cheap periodic delta cadence.
          armCorpusTimer(result.boundedStop ? session.pauseMs : corpusUpdateIntervalMs(process.env));
        } else if (tick.action === 'update') {
          const result = await corpusLifecycle.updateOnce();
          console.log(`media-search: corpus update ok=${result.ok} changed=${result.changed ?? false} reason=${result.reason ?? '-'}`);
          armCorpusTimer(corpusUpdateIntervalMs(process.env));
        } else if (tick.action === 'wait') {
          armCorpusTimer(Math.max(60_000, tick.nextDueMs));
        } else {
          armCorpusTimer(corpusUpdateIntervalMs(process.env));
        }
      }
    } catch (error) {
      console.warn('media-search: corpus tick failed', error?.message);
      armCorpusTimer(corpusUpdateIntervalMs(process.env));
    }
  }, delayMs);
  if (corpusTimer.unref) corpusTimer.unref();
}
if (corpusMaintenanceOn) {
  armCorpusTimer(5 * 60_000);
}

// ─── anticipatory scheduler ─────────────────────────────────────────
// Future intents → prepare ahead of demand → speculative publication +
// byte prewarm. One bounded tick at a time (serial: a tick fully settles
// one intent before the next begins); failures back off per intent and
// never destroy serving state. No seeded intents = fully inert.
// ANTICIPATION_ENABLED=0 disables. Interval default 15 min, first tick
// 2 min after boot.
//
// Numeric parsing goes through envNumber (lib/config/env.js): blank or
// whitespace compose values fall back to defaults instead of silently
// becoming zero. Explicit "0" still means zero where the range allows it.
function anticipationIntervalMs() {
  return envNumber(process.env, 'FUTURE_INTENT_INTERVAL_MIN', { fallback: 15, min: 1 }) * 60 * 1000;
}
function anticipationPrepareDays() {
  return envNumber(process.env, 'ANTICIPATION_PREPARE_DAYS', { fallback: 30, min: 0 });
}
function anticipationPublishDays() {
  return envNumber(process.env, 'ANTICIPATION_PUBLISH_DAYS', { fallback: 7, min: 0 });
}
const anticipationFlag = String(process.env.ANTICIPATION_ENABLED ?? '').toLowerCase();
const anticipationOn = anticipationFlag !== '0' && anticipationFlag !== 'false';
let anticipationTimer = null;
let anticipationInFlight = false;
let anticipationNudgePending = false;
let anticipationTick = 0;
// Delay used when a nudge (fresh human demand / availability wake) asks the
// scheduler to run soon. Short enough to be "immediate", long enough to
// debounce a burst of nudges into one pass.
const NUDGE_DELAY_MS = 5000;
const anticipationStore = createFutureIntentStore({ db: discoveryCache.db });
const seasonBackfill = anticipationStore.backfillRequestedSeasonsFromSeerr({ mediaIntentDb: discoveryCache.db });
console.log(`media-search: requested-season backfill seasons=${seasonBackfill.seasons} episodes=${seasonBackfill.episodes}`);
const seasonReconciler = process.env.SEERR_URL && process.env.SEERR_API_KEY
  ? createSeasonReconciler({
    store: anticipationStore,
    resolveEpisodes: (tmdbId, season) => resolveSeerrSeasonEpisodes(tmdbId, season, process.env),
  })
  : null;
const anticipationScheduler = anticipationOn
  ? createAnticipationScheduler({
    store: anticipationStore,
    cache: discoveryCache,
    controlPlaneStore,
    baseUrl: `http://127.0.0.1:${port}`,
    dataPlaneBaseUrl: process.env.DATA_PLANE_URL ?? 'http://data-plane:3001',
    prepareDays: anticipationPrepareDays(),
    publishDays: anticipationPublishDays(),
    checkTorBoxCachedFn: async (hashes) => {
      const r = await checkTorBoxCached(hashes);
      return hashes.map((h) => ({
        infoHash: h,
        state: r.cached.has(String(h).toLowerCase()) ? 'cached' : (r.failed.has(String(h).toLowerCase()) ? 'unknown' : 'uncached'),
      }));
    },
    confirmConsumerPublicationFn: confirmPlexEpisode,
    notifyConsumerPublicationFn: async ({ mediaId, mediaType, season, episode }) => {
      const entry = mediaType === 'series' || mediaType === 'tv'
        ? discoveryCache.getVfsTvEntry?.(mediaId, season, episode)
        : null;
      if (!entry?.canonicalPath) return { notified: false, error: 'missing-authoritative-vfs-path' };
      return notifyPlex({ mediaId, mediaType, canonicalPath: entry.canonicalPath });
    },
    reconcileRequestedSeasonFn: seasonReconciler
      ? (season) => seasonReconciler.reconcileSeason({
        mediaId: season.media_id,
        tmdbId: season.tmdb_id,
        season: season.season,
        source: season.source,
      })
      : null,
    log: (msg) => console.log(`media-search: ${msg}`),
  })
  : null;
console.log(`media-search: anticipation scheduler enabled=${anticipationOn} intervalMs=${anticipationIntervalMs()} initialDelayMs=120000`);
/**
 * Wake-aware re-arm: never sleep past the earliest known reason to run
 * (next poll or a future-release boundary), so a release that becomes
 * actionable between fixed ticks wakes promptly instead of waiting a
 * full interval. Overdue wakes re-arm in 60s (bounded, never a hot
 * loop); future wakes are floored at the 5s nudge delay.
 */
function anticipationDelayMs() {
  const interval = anticipationIntervalMs();
  try {
    const wake = anticipationStore.nextWakeAt?.();
    if (wake == null) return interval;
    const delay = wake - Date.now();
    if (delay <= 0) return Math.min(interval, 60_000);
    return Math.min(interval, Math.max(NUDGE_DELAY_MS, delay));
  } catch {
    return interval;
  }
}
function armAnticipationTimer(delayMs) {
  console.log(`media-search: anticipation scheduler armed delayMs=${delayMs}`);
  anticipationTimer = arm(async () => {
    const tick = ++anticipationTick;
    console.log(`media-search: anticipation tick=${tick} entered`);
    try {
      const due = anticipationStore.due({ limit: 5 });
      console.log(`media-search: anticipation tick=${tick} preflight-due-limit=5 preflight-due-count=${due.length}`);
      if (anticipationScheduler && !anticipationInFlight) {
        anticipationInFlight = true;
        try {
          const result = await anticipationScheduler.tickOnce();
          console.log(`media-search: anticipation tick=${tick} result=${JSON.stringify(result)}`);
        } finally {
          anticipationInFlight = false;
        }
      }
    } catch (error) {
      console.warn(`media-search: anticipation tick=${tick} error=${error?.stack || error?.message}`);
    } finally {
      // A nudge that arrived while this tick was in flight must NOT be dropped:
      // fresh human demand would otherwise wait a full interval after the tick.
      if (anticipationNudgePending) {
        anticipationNudgePending = false;
        armAnticipationTimer(NUDGE_DELAY_MS);
        console.log(`media-search: anticipation tick=${tick} completed nextMs=${NUDGE_DELAY_MS} (nudge-pending)`);
      } else {
        const nextMs = anticipationDelayMs();
        armAnticipationTimer(nextMs);
        console.log(`media-search: anticipation tick=${tick} completed nextMs=${nextMs}`);
      }
    }
  }, delayMs);
}
if (anticipationOn) {
  armAnticipationTimer(2 * 60_000);
}

// ─── preparation ticker (moonshot vertical) ─────────────────────────────
// Advances durable provider-neutral preparations toward READY: expire
// overdue, poll in-flight acquisitions, persist exact-file closure on
// readiness, run notify hooks. Persist + notify ONLY — Binding always
// happens through request-driven pipeline runs (status-endpoint rebind,
// next Play, season scheduler), never a background timer.
// PREPARE_ENABLED=1 arms (default OFF = today's exact behavior).
// Interval default 30 s, first tick 15 s after boot. One driver +
// adapters built once and reused across ticks: adapter rate-limiters and
// refusal memory must survive between ticks.
const prepareFlag = String(process.env.PREPARE_ENABLED ?? '0').toLowerCase();
const prepareOn = prepareFlag === '1' || prepareFlag === 'true';
const prepareTickMs = (() => {
  const n = Number(process.env.PREPARE_TICK_MS ?? 30_000);
  return Number.isSafeInteger(n) && n >= 5_000 ? n : 30_000;
})();
let prepareTimer = null;
let prepareInFlight = false;
let prepareTick = 0;
let prepareDriverSingleton = null;
function prepareDriverOnce() {
  if (prepareDriverSingleton) return prepareDriverSingleton;
  if (!controlPlaneStore) return null;
  const adapters = {};
  if (process.env.TORBOX_API_KEY) {
    adapters.torbox = createTorBoxPrepareAdapter({ apiKey: process.env.TORBOX_API_KEY });
  }
  if (process.env.REALDEBRID_API_KEY) {
    adapters.realdebrid = createRdPrepareAdapter({
      store: controlPlaneStore,
      client: createRealDebridClient({ apiKey: process.env.REALDEBRID_API_KEY }),
    });
  }
  if (Object.keys(adapters).length === 0) return null;
  const num = (name, fallback, min) => {
    const n = Number(process.env[name]);
    return Number.isSafeInteger(n) && n >= min ? n : fallback;
  };
  prepareDriverSingleton = createPrepareDriver({
    store: createPreparationStore({
      db: controlPlaneStore.db,
      config: {
        preparationTimeoutMs: num('PREPARE_TIMEOUT_MS', 6 * 60 * 60 * 1000, 60_000),
      },
    }),
    controlPlaneStore,
    adapters,
    config: {
      maxConcurrentTotal: num('PREPARE_MAX_CONCURRENT', 2, 1),
      maxConcurrentPerProvider: num('PREPARE_MAX_PER_PROVIDER', 2, 1),
      maxSizeBytes: num('PREPARE_MAX_SIZE_BYTES', 100 * 1024 * 1024 * 1024, 1),
      maxAttempts: num('PREPARE_MAX_ATTEMPTS', 20, 1),
      pollIntervalByProvider: {
        torbox: num('PREPARE_POLL_MS_TORBOX', 60_000, 5_000),
        realdebrid: num('PREPARE_POLL_MS_RD', 30_000, 5_000),
      },
    },
    log: (msg) => console.log(`media-search: prepare ${msg}`),
  });
  return prepareDriverSingleton;
}
function armPrepareTimer(delayMs) {
  console.log(`media-search: preparation ticker armed delayMs=${delayMs}`);
  prepareTimer = arm(async () => {
    const tick = ++prepareTick;
    console.log(`media-search: preparation tick=${tick} entered`);
    try {
      const driver = prepareDriverOnce();
      if (!driver) {
        console.log(`media-search: preparation tick=${tick} skipped (no adapters/control plane)`);
      } else if (!prepareInFlight) {
        prepareInFlight = true;
        try {
          const summary = await driver.advanceOnce({ limit: 5 });
          console.log(`media-search: preparation tick=${tick} expired=${summary.expired} advanced=${summary.advanced}`);
        } finally {
          prepareInFlight = false;
        }
      }
    } catch (error) {
      console.warn(`media-search: preparation tick=${tick} error=${error?.stack || error?.message}`);
    } finally {
      armPrepareTimer(prepareTickMs);
    }
  }, delayMs);
}
if (prepareOn) {
  armPrepareTimer(15_000);
}

// ─── quality-upgrade watch ──────────────────────────────────────────
// Published-below-terminal items re-probe the live market on a slow
// cadence (default hourly, one row per tick) and switch publication to
// a strictly-higher tier through the existing prepare/publish seams.
// UPGRADE_WATCH_ENABLED=0 disables. First tick 10 min after boot
// (staggered past anticipation). No seeded rows = fully inert.
function upgradeWatchIntervalMs() {
  return envNumber(process.env, 'UPGRADE_WATCH_INTERVAL_MIN', { fallback: 60, min: 5 }) * 60 * 1000;
}
const playbackObservationIntervalMs = envNumber(process.env, 'PLAYBACK_OBSERVATION_INTERVAL_SEC', { fallback: 2, min: 2 }) * 1000;
let playbackObservationTimer = null;
let playbackObservationInFlight = false;
let playbackObservationTick = 0;
async function observePlaybackOnce() {
  const tick = ++playbackObservationTick;
  console.log(`media-search: playback observer tick=${tick} entered`);
  if (playbackObservationInFlight || !process.env.PLEX_URL || !process.env.PLEX_TOKEN) {
    console.log(`media-search: playback observer tick=${tick} skipped`);
    return;
  }
  playbackObservationInFlight = true;
  try {
    const { countPlaybackObservablePublications } = await import('../lib/library/retirement.js');
    const gateCount = countPlaybackObservablePublications(controlPlaneStore);
    console.log(`media-search: playback observer tick=${tick} gate=${gateCount}`);
    if (gateCount <= 0) return;
    const { observePlaybackSessions } = await import('../lib/library/retirement.js');
    const { fetchPlexSessions } = await import('../lib/consumers/plex-sessions.js');
    const { recordAcceptedPlayback } = await import('../lib/consumers/accepted-playback.js');
    console.log(`media-search: playback observer tick=${tick} fetch=start`);
    const seen = await fetchPlexSessions({ plexUrl: process.env.PLEX_URL, plexToken: process.env.PLEX_TOKEN });
    console.log(`media-search: playback observer tick=${tick} fetch=${seen.ok ? 'ok' : `failed:${seen.reason}`} sessions=${seen.sessions.length}`);
    if (seen.ok && seen.sessions.length > 0) {
      const qualifying = seen.sessions.filter((session) => session.progress > 0 && session.partFile);
      console.log(`media-search: playback session-count=${seen.sessions.length} qualifying=${qualifying.length}`);
      const adj = observePlaybackSessions({ controlPlaneStore, sessions: seen.sessions });
      const results = seen.sessions.map((session) => {
        const accepted = recordAcceptedPlayback({ controlPlaneStore, session });
        console.log(`media-search: playback session mediaId=${session.mediaId} season=${session.season ?? ''} episode=${session.episode ?? ''} ratingKey=${session.ratingKey ?? ''} part=${session.partId ?? ''} progress=${session.progress} accepted=${accepted ? 'yes' : 'no'}`);
        return accepted;
      });
      const accepted = results.filter(Boolean).length;
      if (adj.observed > 0 || accepted > 0) console.log(`media-search: playback observed=${adj.observed} accepted=${accepted}`);
    } else if (!seen.ok) {
      console.warn(`media-search: playback observation failed: ${seen.reason}`);
    }
  } catch (error) {
    console.warn('media-search: playback observation failed', error?.stack || error?.message);
  } finally {
    playbackObservationInFlight = false;
  }
}
let playbackObservationLogged = false;
function armPlaybackObservation(delayMs) {
  if (!playbackObservationLogged) {
    playbackObservationLogged = true;
    console.log(`media-search: playback observer enabled intervalMs=${playbackObservationIntervalMs}`);
  }
  playbackObservationTimer = arm(async () => {
    console.log('media-search: playback observer timer fired');
    try {
      await observePlaybackOnce();
    } catch (error) {
      console.warn('media-search: playback observer tick failed', error?.stack || error?.message);
    } finally {
      console.log(`media-search: playback observer next tick scheduled delayMs=${playbackObservationIntervalMs}`);
      armPlaybackObservation(playbackObservationIntervalMs);
    }
  }, delayMs);
}
armPlaybackObservation(5_000);
let upgradeWatchTimer = null;
let upgradeWatchInFlight = false;
const upgradeWatchOn = (() => {
  const v = String(process.env.UPGRADE_WATCH_ENABLED ?? '').toLowerCase();
  return v !== '0' && v !== 'false';
})();
let upgradeEvaluator = null;
function armUpgradeWatchTimer(delayMs) {
  upgradeWatchTimer = arm(async () => {
    try {
      if (upgradeEvaluator && !upgradeWatchInFlight) {
        upgradeWatchInFlight = true;
        try {
          // Temporary publication retirement rides this publication-domain
          // tick (hourly, bounded, restart-safe): due watch-once items
          // unpublish via the existing primitive; owned (promoted) items
          // adopt permanent instead. Runs before upgrade evaluation so
          // retired items are never seeded.
          try {
            const { retireDuePublications, observePlaybackSessions, countTemporaryPublications, countPlaybackObservablePublications } =
              await import('../lib/library/retirement.js');
            // Consumption-aware retention: fold live Plex sessions into
            // temporary publications first (started extends the horizon,
            // completed shortens to a grace period). The same bounded polling
            // pass records accepted exact TorrentFiles for any published item.
            try {
              if ((countTemporaryPublications(controlPlaneStore) > 0 || countPlaybackObservablePublications(controlPlaneStore) > 0)
                && process.env.PLEX_URL && process.env.PLEX_TOKEN) {
                const { fetchPlexSessions } = await import('../lib/consumers/plex-sessions.js');
                const { recordAcceptedPlayback } = await import('../lib/consumers/accepted-playback.js');
                const seen = await fetchPlexSessions({
                  plexUrl: process.env.PLEX_URL, plexToken: process.env.PLEX_TOKEN,
                });
                if (seen.ok && seen.sessions.length > 0) {
                  const adj = observePlaybackSessions({
                    controlPlaneStore, sessions: seen.sessions,
                  });
                  const accepted = seen.sessions.map((session) => recordAcceptedPlayback({ controlPlaneStore, session })).filter(Boolean).length;
                  if (adj.observed > 0 || accepted > 0) {
                    console.log(`media-search: playback observed=${adj.observed} accepted=${accepted} extended=${adj.extended} completed=${adj.completed}`);
                  }
                }
              }
            } catch (error) {
              console.warn('media-search: playback observation failed', error?.message);
            }
            const retired = await retireDuePublications({
              cache: discoveryCache, controlPlaneStore,
              promotionStore: promotionStore ?? null,
              log: (msg) => console.log(`media-search: ${msg}`),
            });
            if (retired.retired > 0 || retired.adopted > 0) {
              console.log(`media-search: retirement retired=${retired.retired} adopted=${retired.adopted}`);
            }
          } catch (error) {
            console.warn('media-search: retirement sweep failed', error?.message);
          }
          const result = await upgradeEvaluator.tickOnce();
          if (result.acted || result.seeded) {
            console.log(`media-search: upgrade tick ${result.rowId ?? ''} ${result.to || result.reason || ''} seeded=${result.seeded ?? 0} (${result.ms ?? 0}ms)`);
          }
          // Storm-escalation pass (same hourly tick, at most one TF):
          // published single-provider TFs with recent delivery pain get
          // one bounded second-placement attempt. Quiet when nothing
          // qualifies (the common case).
          try {
            const escRes = await fetch(`http://127.0.0.1:${port}/api/internal/coverage-escalate`, {
              method: 'POST',
              signal: AbortSignal.timeout(5 * 60 * 1000),
            });
            const esc = await escRes.json().catch(() => null);
            if (esc?.acted) {
              console.log(`media-search: coverage escalation ${esc.candidate?.torrentFileId ?? ''} -> ${esc.status} providers=${(esc.providers || []).join(',')}`);
            }
          } catch (error) {
            console.warn('media-search: coverage escalation failed', error?.message);
          }
        } finally {
          upgradeWatchInFlight = false;
        }
      }
    } catch (error) {
      console.warn('media-search: upgrade tick failed', error?.message);
    } finally {
      armUpgradeWatchTimer(upgradeWatchIntervalMs());
    }
  }, delayMs);
  if (upgradeWatchTimer.unref) upgradeWatchTimer.unref();
}
if (upgradeWatchOn) {
  (async () => {
    try {
      const { createUpgradeWatchStore, createUpgradeEvaluator } = await import('../lib/lifecycle/upgrade-watch.js');
      upgradeEvaluator = createUpgradeEvaluator({
        store: createUpgradeWatchStore({ db: discoveryCache.db }),
        cache: discoveryCache,
        controlPlaneStore,
        baseUrl: `http://127.0.0.1:${port}`,
        dataPlaneBaseUrl: process.env.DATA_PLANE_URL ?? 'http://data-plane:3001',
        log: (msg) => console.log(`media-search: ${msg}`),
      });
      armUpgradeWatchTimer(10 * 60_000);
    } catch (err) {
      console.warn('media-search: upgrade watch unavailable', err?.message);
    }
  })();
}

// ─── permanent-storage promotion worker ─────────────────────────────
// Human-decision promotion only: POST /api/library/:id/promote enqueues
// one exact TorrentFile; this ticker materializes bytes through the
// data plane's existing exact-byte authority (GET /files/:tfId, TorBox
// + RD abstracted in Rust). Unset HASHSUCKER_PERMANENT_PATH = fully
// inert: the promote API refuses and no timer is armed.
//
// Boot recovery (Phase 9): rows stranded in transient states return to
// requested; the shared materializer validates and resumes their named
// .staging partial. Unknown/orphan partials are still discarded. Failure
// is additive-only: provider-backed playback is untouched throughout.
const permanentRoot = (process.env.HASHSUCKER_PERMANENT_PATH ?? '').trim() || null;
const promotionStore = permanentRoot ? createPromotionStore({ db: controlPlaneStore.db }) : null;
const promotionWorker = promotionStore
  ? createPromotionWorker({
    promotionStore,
    dataPlaneBaseUrl: process.env.DATA_PLANE_URL ?? 'http://data-plane:3001',
    permanentRoot,
    log: (msg) => console.log(`media-search: ${msg}`),
  })
  : null;
if (promotionWorker) {
  (async () => {
    try {
      const reset = promotionStore.resetStale();
      const purged = await promotionWorker.discardPartials();
      if (reset > 0 || purged > 0) {
        console.log(`media-search: promotion recovery reset=${reset} partials=${purged}`);
      }
    } catch (error) {
      console.warn('media-search: promotion recovery failed', error?.message);
    }
  })();
}
let promotionTimer = null;
let promotionInFlight = false;
function armPromotionTimer(delayMs) {
  promotionTimer = arm(async () => {
    try {
      if (promotionWorker && !promotionInFlight) {
        promotionInFlight = true;
        try {
          const result = await promotionWorker.tick();
          if (result.status !== 'idle') {
            console.log(`media-search: promotion tick ${result.torrentFileId ?? ''} ${result.status}`);
          }
        } finally {
          promotionInFlight = false;
        }
      }
    } catch (error) {
      console.warn('media-search: promotion tick failed', error?.message);
    } finally {
      armPromotionTimer(30_000);
    }
  }, delayMs);
  if (promotionTimer.unref) promotionTimer.unref();
}
if (promotionWorker) {
  armPromotionTimer(15_000);
}

// ─── generic download-intent worker ─────────────────────────────────
// External systems name the media; HashSucker stages verified bytes.
// Same shared byte primitive as promotion; different intent policy.
// Resolution is two-tier (mirroring the anticipation scheduler's
// baseUrl pattern): fast path reads durable truth in-process (zero
// provider work); the fresh path drives the NORMAL pipeline over HTTP
// POST /api/media-prepare so request-scoped ensure fns (TorBox/RD
// identity seams) are built server-side exactly once, with no
// duplicated provider wiring here. Unset HASHSUCKER_DOWNLOAD_PATH =
// fully inert.
const downloadRoot = (process.env.HASHSUCKER_DOWNLOAD_PATH ?? '').trim() || null;
const downloadStore = downloadRoot ? createDownloadStore({ db: controlPlaneStore.db }) : null;
const downloadWorker = downloadStore
  ? createDownloadWorker({
    downloadStore,
    // Two-tier resolution: fast path reads durable truth in-process
    // (zero provider work); the fresh path drives the NORMAL pipeline
    // over HTTP POST /api/media-prepare so request-scoped ensure fns
    // (TorBox/RD identity seams) are built server-side, with no
    // duplicated provider wiring here. Same pattern as the
    // anticipation scheduler's baseUrl.
    resolveFn: async ({ mediaId, mediaType, season = null, episode = null, qualityProfile = null }) => {
      if (!mediaId) return { status: 'invalid-input', reason: 'mediaId is required' };
      const readPrepared = () => getPreparedDurableState({
        cache: discoveryCache,
        controlPlaneStore,
        mediaId,
        mediaType,
        season,
        episode,
      });
      const fast = readPrepared();
      if (fast) {
        return {
          status: 'ok', reused: true, torrentFile: fast.torrentFile,
          torrentFileId: fast.torrentFileId, handoff: fast.handoff,
        };
      }
      try {
        const prepareResponse = await fetch(`http://127.0.0.1:${port}/api/media-prepare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The pipeline's native TV type is 'series'; never send 'episode'.
          // Intent profile rides along as a tier cap so staged downloads
          // honor the same bounded selection as explicit requests
          // (uncapped when omitted; garbage falls back to balanced).
          body: JSON.stringify({
            mediaId,
            mediaType: mediaType === 'episode' ? 'series' : mediaType,
            season,
            episode,
            maxTier: selectionMaxTier(qualityProfile),
          }),
        });
        if (!prepareResponse.ok) {
          return { status: 'unresolvable', reason: `prepare failed: HTTP ${prepareResponse.status}` };
        }
      } catch (error) {
        return { status: 'unresolvable', reason: error?.message ?? 'prepare failed' };
      }
      const fresh = readPrepared();
      if (!fresh) {
        return { status: 'unresolvable', reason: 'no healthy TorrentFile after discovery' };
      }
      return {
        status: 'ok', reused: false, torrentFile: fresh.torrentFile,
        torrentFileId: fresh.torrentFileId, handoff: fresh.handoff,
      };
    },
    stagingRoot: downloadRoot,
    dataPlaneBaseUrl: process.env.DATA_PLANE_URL ?? 'http://data-plane:3001',
    log: (msg) => console.log(`media-search: ${msg}`),
  })
  : null;
if (downloadWorker) {
  (async () => {
    try {
      const reset = downloadStore.resetStale();
      const purged = await downloadWorker.discardPartials();
      if (reset > 0 || purged > 0) {
        console.log(`media-search: download recovery reset=${reset} partials=${purged}`);
      }
    } catch (error) {
      console.warn('media-search: download recovery failed', error?.message);
    }
  })();
}
let downloadTimer = null;
let downloadInFlight = false;
function armDownloadTimer(delayMs) {
  downloadTimer = arm(async () => {
    try {
      if (downloadWorker && !downloadInFlight) {
        downloadInFlight = true;
        try {
          const result = await downloadWorker.tick();
          if (result.status !== 'idle') {
            console.log(`media-search: download tick ${result.downloadRequestId ?? ''} ${result.status}`
              + (result.reused ? ' (reused TorrentFile)' : ''));
          }
          // Handoff poll backstop (same loop, no new scheduler): observe
          // dumb-consumer file moves (accepted/done/failed) into rows.
          // Bounded dir lists, no resubmits, no deletes.
          try {
            const { pollHandoffDirs } = await import('../lib/download/handoff.js');
            const observed = pollHandoffDirs({
              root: downloadRoot, store: downloadStore,
              log: (msg) => console.log(`media-search: ${msg}`),
            });
            const n = observed.accepted + observed.completed + observed.failed;
            if (n > 0) console.log(`media-search: handoff poll +${n} transfer events`);
          } catch (error) {
            console.warn('media-search: handoff poll failed', error?.message);
          }
          // Post-consumption staged cleanup (same loop, no new daemon):
          // forget staged artifacts whose handoff completed past the
          // grace. Bounded eligible-row list, owned-root unlinks only,
          // no discovery/provider calls.
          try {
            const swept = await downloadWorker.sweepStagedCleanup(10);
            const n = swept.removed + swept.converged + swept.deferred;
            if (n > 0) {
              console.log(`media-search: staged cleanup removed=${swept.removed} converged=${swept.converged} deferred=${swept.deferred} skipped=${swept.skipped}`);
            }
          } catch (error) {
            console.warn('media-search: staged cleanup failed', error?.message);
          }
        } finally {
          downloadInFlight = false;
        }
      }
    } catch (error) {
      console.warn('media-search: download tick failed', error?.message);
    } finally {
      armDownloadTimer(30_000);
    }
  }, delayMs);
  if (downloadTimer.unref) downloadTimer.unref();
}
if (downloadWorker) {
  armDownloadTimer(15_000);
}

// ─── Arr intent sync ────────────────────────────────────────────────
// Sonarr/Radarr are sensors, not fulfillment authorities: periodic batch
// reconciliation (default 6 h, first run 3 min after boot) imports
// monitored/upcoming items as future intents. URL without key (or bad
// key) is a degraded config error, never silent. Neither configured =
// disabled. Failures leave existing intents intact; restarts do not
// hammer Arr (last sync persists in arr_sync_state).
function arrSyncIntervalMs() {
  return envNumber(process.env, 'ARR_SYNC_INTERVAL_HOURS', { fallback: 6, min: 0.5 }) * 60 * 60 * 1000;
}
// ─── stale ProviderPlacement reconciliation ────────────────────────────
// Durable route inventory drifts (provider frees a cached resource, account
// rotation). A stale placement is still recorded `ready`, so presentProviders()
// keeps covering that provider and nothing re-probes it. On a slow cadence,
// TorrentFiles whose recorded routes are all unusable get a bounded,
// cache-only alternate-route lookup (the existing second-placement
// discover-only surface). No uncached acquisition, no identity change.
//
// Two operators, one probe set, one single-flight:
//   - request-time recovery is Rust's own (same-TorrentFile failover inside a
//     read) and never routes through here, so the worker cannot fight it and
//     cannot duplicate a provider pull: reconciliation is cache-only control
//     reads plus discover-only lookups;
//   - retirement only ever fires for a placement the provider has objectively
//     disproven AND that has a live sibling route, so an outage, a timeout or
//     a rate limit can never retire durable inventory.
/**
 * Build the reconciliation runner bound to one store + provider set.
 *
 * The runner is the single owner of the single-flight guard, so the periodic
 * worker and any operator/test invocation share one in-flight pass instead of
 * starting a second one that would duplicate provider probes.
 *
 * @returns {{run: (options?: {limit?: number}) => Promise<object>, runRecovery: (options?: {limit?: number}) => Promise<object>, inFlight: () => boolean}}
 */
function createRouteReconcileRunner({ store, dependencies, env = process.env }) {
  let inFlight = null;
  // The repair attempt throttle, per TorrentFile: a route that stays dead
  // is re-checked on a cooldown, not every minute.
  const repairAttempts = new Map();
  /**
   * Not `async`: returning the shared promise object is the point. An async
   * wrapper would hand each caller a DIFFERENT promise for the same pass, so
   * identity could not be used to prove single-flight.
   */
  function run({ limit } = {}) {
    if (!store) return Promise.resolve({ scanned: 0, repaired: 0, unavailable: 0, failed: 0, ids: [], retired: 0 });
    if (inFlight) return inFlight;
    const pass = runPass({ limit });
    inFlight = pass;
    pass.then(
      () => { if (inFlight === pass) inFlight = null; },
      () => { if (inFlight === pass) inFlight = null; },
    );
    return pass;
  }
  async function runPass({ limit, evidenceOnly = false } = {}) {
    {
      const surfaces = createRouteProviderSurfaces({
        torBoxProvider: dependencies.torBoxProvider ?? null,
        torBoxInventoryProvider: dependencies.torBoxInventoryProvider ?? null,
        rdClient: dependencies.rdClient ?? null,
        torboxCheckCached: dependencies.torboxCheckCached ?? null,
        env,
      });
      const ensurer = createSecondPlacementEnsurer({
        store, ...surfaces, now: () => Date.now(),
      });
      const batch = limit ?? envNumber(env, 'ROUTE_RECONCILE_BATCH', { fallback: 25, min: 1, max: 500 });
      // FAILURE-DRIVEN recovery first: the durable evidence says which
      // TorrentFiles have no live route, and that IS the work. The
      // discovery sweep (a TorrentFile with NO route at all) follows.
      const due = await reconcileEvidenceDueRoutes({
        store,
        secondPlacement: ensurer,
        limit: batch,
        now: Date.now(),
        log: (msg) => console.log(`media-search: ${msg}`),
        // The repair attempt throttle: a route that stays dead must not
        // spend an account-sized provider read every minute.
        lastAttemptAt: repairAttempts,
      });
      const stale = evidenceOnly
        ? { scanned: 0, repaired: 0, unavailable: 0, failed: 0, ids: [] }
        : await reconcileStaleRoutes({
          store,
          secondPlacement: ensurer,
          limit: batch,
          now: Date.now(),
          log: (msg) => console.log(`media-search: ${msg}`),
        });
      const recovery = {
        scanned: due.scanned + stale.scanned,
        repaired: due.repaired + stale.repaired,
        unavailable: due.unavailable + stale.unavailable,
        failed: due.failed + stale.failed,
        ids: [...due.ids, ...stale.ids],
      };
      // Hygiene: retire placements the provider disproved, but only where a
      // live sibling route exists (route-reconciler.js holds the guards).
      const retireFlag = String(env.ROUTE_RECONCILE_RETIRE ?? '1').toLowerCase();
      let retired = 0;
      if (retireFlag !== '0' && retireFlag !== 'false') {
        const outcome = await retireVerifiedDeadRedundantRoutes({
          store,
          limit: batch,
          // The store's clock: freshness is compared against the clock that
          // wrote the rows.
          now: () => store.now(),
          log: (msg) => console.log(`media-search: ${msg}`),
        });
        retired = outcome.retired.length;
        if (outcome.deferred > 0) {
          console.log(`media-search: route retire deferred=${outcome.deferred} (probe unanswered)`);
        }
      }
      return { ...recovery, retired };
    }
  }
  return { run, inFlight: () => inFlight !== null };
}

function routeReconcileIntervalMs(env = process.env) {
  return envNumber(env, 'ROUTE_RECONCILE_INTERVAL_MIN', { fallback: 360, min: 30 }) * 60 * 1000;
}

/**
 * Failure-driven recovery cadence.
 *
 * The evidence-driven pass is LOCAL until work is due: the candidate set is
 * a read of the durable delivery evidence, and the provider is consulted
 * only when a TorrentFile's routes are proven dead. It can therefore run
 * often — the cost of an idle pass is one indexed query, and the latency
 * of a dead route's recovery follows the FAILURE, not a timer.
 */
function routeRecoveryIntervalMs(env = process.env) {
  return envNumber(env, 'ROUTE_RECOVERY_INTERVAL_SEC', { fallback: 60, min: 10 }) * 1000;
}
const routeReconcileOn = (() => {
  const v = String(process.env.ROUTE_RECONCILE_ENABLED ?? '1').toLowerCase();
  return v !== '0' && v !== 'false';
})();
const routeReconcileRunner = controlPlaneStore
  ? createRouteReconcileRunner({ store: controlPlaneStore, dependencies })
  : null;

// ─── byte authority: the VFS projects the active Binding ──────────────────
//
// A VFS row's byte identity is a projection of the active Binding's
// TorrentFile. The two live in different databases, so a publication that
// crashed between them could leave the row naming a TorrentFile the
// authority does not name. This pass converges that: it reads the control
// plane and the discovery cache, and writes the VFS row.
//
// It is LOCAL by construction: no discovery, no ranking, no provider
// call, no metadata lookup, no consumer call.
const byteAuthorityRunner = (controlPlaneStore && discoveryCache)
  ? { reconcile: () => reconcileByteAuthority({ store: controlPlaneStore, cache: discoveryCache }) }
  : null;
let byteAuthorityTimer = null;
function byteAuthorityIntervalMs(env = process.env) {
  return envNumber(env, 'BYTE_AUTHORITY_RECONCILE_INTERVAL_SEC', { fallback: 300, min: 60 }) * 1000;
}
function armByteAuthorityTimer(delayMs) {
  byteAuthorityTimer = arm(async () => {
    if (byteAuthorityRunner) {
      try {
        const result = byteAuthorityRunner.reconcile({ dryRun: false });
        if (result.repaired.length > 0) {
          console.log(`media-search: byte authority projected=${result.repaired.length} skipped=${result.skipped.length}`);
        }
      } catch (error) {
        console.warn('media-search: byte authority reconcile failed', error?.message);
      }
    }
    armByteAuthorityTimer(byteAuthorityIntervalMs());
  }, delayMs);
}
if (byteAuthorityRunner) {
  // The first pass runs shortly after boot: a crash between a Binding
  // commit and the VFS projection must converge on restart, not at the
  // next publication.
  armByteAuthorityTimer(envNumber(process.env, 'BYTE_AUTHORITY_FIRST_DELAY_SEC', { fallback: 30, min: 5 }) * 1000);
  console.log(`media-search: byte authority reconcile armed intervalMs=${byteAuthorityIntervalMs()}`);
}
let routeReconcileTimer = null;
function armRouteReconcileTimer(delayMs) {
  routeReconcileTimer = arm(async () => {
    if (routeReconcileOn && routeReconcileRunner) {
      try {
        const result = await routeReconcileRunner.run();
        // Always logged: a zero-candidate pass is the expected steady state,
        // and an operator needs to see the reconciler is alive and verifying
        // rather than silently idle.
        console.log(`media-search: route reconcile scanned=${result.scanned} repaired=${result.repaired} unavailable=${result.unavailable} failed=${result.failed} retired=${result.retired}`);
      } catch (error) {
        console.warn('media-search: route reconcile pass failed', error?.message);
      }
    }
    armRouteReconcileTimer(routeReconcileIntervalMs());
  }, delayMs);
}
if (routeReconcileOn && routeReconcileRunner) {
  armRouteReconcileTimer(envNumber(process.env, 'ROUTE_RECONCILE_FIRST_DELAY_MIN', { fallback: 10, min: 1 }) * 60 * 1000);
  console.log(`media-search: route reconcile armed intervalMs=${routeReconcileIntervalMs()}`);
}

// ─── failure-driven route recovery ────────────────────────────────────────
// The durable delivery evidence IS the work item: a TorrentFile whose
// recorded routes are all proven dead needs another route. This pass reads
// that evidence (local) and only calls a provider when a repair is really
// due. It also covers the restart case: evidence written just before a
// crash is still there, so the repair resumes without waiting for the
// six-hourly sweep.
let routeRecoveryTimer = null;
function armRouteRecoveryTimer(delayMs) {
  routeRecoveryTimer = arm(async () => {
    if (routeReconcileOn && routeReconcileRunner) {
      try {
        const result = await routeReconcileRunner.run({ evidenceOnly: true });
        if (result.scanned > 0) {
          console.log(`media-search: route recovery scanned=${result.scanned} repaired=${result.repaired} unavailable=${result.unavailable} failed=${result.failed}`);
        }
      } catch (error) {
        console.warn('media-search: route recovery pass failed', error?.message);
      }
    }
    armRouteRecoveryTimer(routeRecoveryIntervalMs());
  }, delayMs);
}
if (routeReconcileOn && routeReconcileRunner) {
  // A short first delay: the durable evidence may already name work that a
  // previous process could not finish.
  armRouteRecoveryTimer(envNumber(process.env, 'ROUTE_RECOVERY_FIRST_DELAY_SEC', { fallback: 15, min: 5 }) * 1000);
  console.log(`media-search: route recovery armed intervalMs=${routeRecoveryIntervalMs()}`);
}

const arrSyncClients = (() => {
  const out = {};
  if (process.env.RADARR_URL) {
    out.radarr = {
      client: createArrClient({ baseUrl: process.env.RADARR_URL, apiKey: process.env.RADARR_API_KEY || null }),
      configured: true,
      keyPresent: !!process.env.RADARR_API_KEY,
    };
  }
  if (process.env.SONARR_URL) {
    out.sonarr = {
      client: createArrClient({ baseUrl: process.env.SONARR_URL, apiKey: process.env.SONARR_API_KEY || null }),
      configured: true,
      keyPresent: !!process.env.SONARR_API_KEY,
    };
  }
  return out;
})();
const arrSync = (arrSyncClients.radarr || arrSyncClients.sonarr)
  ? createArrSync({
    db: discoveryCache.db,
    radarr: arrSyncClients.radarr?.keyPresent ? arrSyncClients.radarr.client : null,
    sonarr: arrSyncClients.sonarr?.keyPresent ? arrSyncClients.sonarr.client : null,
  })
  : null;
let arrSyncTimer = null;
let arrSyncInFlight = false;
function armArrSyncTimer(delayMs) {
  arrSyncTimer = arm(async () => {
    try {
      if (arrSync && !arrSyncInFlight) {
        arrSyncInFlight = true;
        try {
          const intentStore = createFutureIntentStore({ db: discoveryCache.db });
          const summary = await arrSync.syncOnce({ store: intentStore });
          for (const [name, result] of Object.entries(summary)) {
            if (!result) continue;
            console.log(`media-search: arr sync ${name} ok=${result.ok} `
              + (result.ok ? `intents=${result.intents}` : `error=${result.error}`));
          }
        } finally {
          arrSyncInFlight = false;
        }
      }
    } catch (error) {
      console.warn('media-search: arr sync failed', error?.message);
    } finally {
      armArrSyncTimer(arrSyncIntervalMs());
    }
  }, delayMs);
  if (arrSyncTimer.unref) arrSyncTimer.unref();
}
if (arrSync) {
  armArrSyncTimer(3 * 60_000);
}

// ─── idle corpus enrichment ─────────────────────────────────────────
// Opportunistic discovery-evidence gathering during quiet periods: one
// bounded live-discovery query per tick through the normal pipeline
// seams (ingest/associate/attributes), never acquisition. Default hourly,
// first tick 15 min after boot (staggered past anticipation/corpus/
// upgrade). ENRICHMENT_ENABLED=0 disables. No durable crawl queue —
// targets rebuild from intents/requests/library every tick, so restarts
// resume naturally. See lib/discovery/idle-enrichment.js.
const enrichmentOn = (() => {
  const v = String(process.env.ENRICHMENT_ENABLED ?? '').toLowerCase();
  return v !== '0' && v !== 'false';
})();
const enrichment = enrichmentOn ? createIdleEnrichment({
  cache: discoveryCache,
  controlPlaneStore,
  downloadStore,
  futureIntentStore: createFutureIntentStore({ db: discoveryCache.db }),
  getMediaById,
  busyHints: () => ({
    anticipation: anticipationInFlight,
    download: downloadInFlight,
    upgradeWatch: upgradeWatchInFlight,
  }),
  isCorpusBusy: async () => isCorpusBusy(discoveryCache.db),
  env: process.env,
}) : null;
let enrichmentTimer = null;
let enrichmentInFlight = false;
function armEnrichmentTimer(delayMs) {
  enrichmentTimer = arm(async () => {
    try {
      if (enrichment && !enrichmentInFlight) {
        enrichmentInFlight = true;
        try {
          const result = await enrichment.tickOnce();
          if (result.acted || !String(result.reason ?? '').startsWith('idle')) {
            console.log(`media-search: enrichment tick ${result.reason ?? 'ok'}`
              + (result.added != null ? ` +${result.added} ~${result.refreshed ?? 0} x${result.rejected ?? 0}` : ''));
          }
        } finally {
          enrichmentInFlight = false;
        }
      }
    } catch (error) {
      console.warn('media-search: enrichment tick failed', error?.message);
    } finally {
      armEnrichmentTimer(enrichmentIntervalMs(process.env));
    }
  }, delayMs);
  if (enrichmentTimer.unref) enrichmentTimer.unref();
}
if (enrichment) {
  const firstTickMin = (() => {
    const v = Number(process.env.ENRICHMENT_FIRST_TICK_MIN);
    return Number.isFinite(v) && v >= 0 ? v : 15;
  })();
  armEnrichmentTimer(firstTickMin * 60_000);
}

// ─── corpus hygiene audit ───────────────────────────────────────────
// Conservative repair of provably-wrong media associations (one small
// batch per idle tick through the shared quiet gate). Deletes only the
// wrong association row — never Releases, TorrentFiles, placements, or
// currently-bound hashes. HYGIENE_ENABLED=0 disables. Default every
// 2h, first tick 20 min after boot (staggered past enrichment).
// See lib/discovery/corpus-hygiene.js.
const hygieneOn = (() => {
  const v = String(process.env.HYGIENE_ENABLED ?? '').toLowerCase();
  return v !== '0' && v !== 'false';
})();
const hygiene = hygieneOn ? createCorpusHygiene({
  cache: discoveryCache,
  controlPlaneStore,
  downloadStore,
  busyHints: () => ({
    anticipation: anticipationInFlight,
    download: downloadInFlight,
    upgradeWatch: upgradeWatchInFlight,
  }),
  isCorpusBusy: async () => isCorpusBusy(discoveryCache.db),
  recordEvent: null,
  env: process.env,
}) : null;
let hygieneTimer = null;
let hygieneInFlight = false;
function armHygieneTimer(delayMs) {
  hygieneTimer = arm(async () => {
    try {
      if (hygiene && !hygieneInFlight) {
        hygieneInFlight = true;
        try {
          const result = await hygiene.tickOnce();
          if (result.acted || (result.flagged ?? 0) > 0) {
            console.log(`media-search: hygiene tick checked=${result.checked} repaired=${result.repaired} flagged=${result.flagged}`);
          }
        } finally {
          hygieneInFlight = false;
        }
      }
    } catch (error) {
      console.warn('media-search: hygiene tick failed', error?.message);
    } finally {
      armHygieneTimer(hygieneIntervalMs(process.env));
    }
  }, delayMs);
  if (hygieneTimer.unref) hygieneTimer.unref();
}
if (hygiene) {
  const firstTickMin = (() => {
    const v = Number(process.env.HYGIENE_FIRST_TICK_MIN);
    return Number.isFinite(v) && v >= 0 ? v : 20;
  })();
  armHygieneTimer(firstTickMin * 60_000);
}


  return {
    /**
     * The reconciliation pass the worker runs, exposed so tests and
     * operational tooling share one implementation and one single-flight.
     * `run()` joins an in-flight pass rather than starting a second.
     */
    runRouteReconcilePass: (options) => (routeReconcileRunner
      ? routeReconcileRunner.run(options)
      : Promise.resolve({ scanned: 0, repaired: 0, unavailable: 0, failed: 0, ids: [], retired: 0 })),
    // The failure-driven pass: evidence-driven only, no discovery sweep.
    runRouteRecoveryPass: (options) => (routeReconcileRunner
      ? routeReconcileRunner.run({ ...(options ?? {}), evidenceOnly: true })
      : Promise.resolve({ scanned: 0, repaired: 0, unavailable: 0, failed: 0, ids: [], retired: 0 })),
    // The in-flight pass itself, so a caller can await the SAME promise a
    // periodic tick is already running instead of starting a second one.
    routeReconcileInFlight: () => Boolean(routeReconcileRunner?.inFlight()),
    nudgeScheduling: () => {
      if (!anticipationOn) return;
      // In-flight tick: remember the nudge so the tick re-arms immediately on
      // completion instead of silently dropping fresh human demand behind a
      // full interval.
      if (anticipationInFlight) { anticipationNudgePending = true; return; }
      try {
        if (anticipationTimer) clearTimeout(anticipationTimer);
      } catch {}
      armAnticipationTimer(NUDGE_DELAY_MS);
    },
    enrichmentStatus: () => enrichment?.getStatus() ?? { enabled: false },
    hygieneStatus: () => hygiene?.getStatus() ?? { enabled: false },
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
