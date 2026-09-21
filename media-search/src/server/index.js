import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createApp } from './app.js';
import { envNumber } from '../lib/config/env.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const discoveryCache = createDiscoveryCache(process.env.DISCOVERY_DB ? { dbPath: process.env.DISCOVERY_DB } : {});
const controlPlaneStore = createControlPlaneStore(
  process.env.CONTROL_PLANE_DB ? { dbPath: process.env.CONTROL_PLANE_DB } : {},
);

// ─── background durability V1: RETIRED (durability verdict tranche) ───
// The named-repair runtime loop (scheduler + runtime + executor +
// provider-classifier) was removed: it enrolled rows nothing read,
// performed periodic TorBox snapshots nothing needed (request-time
// verification and playback-time recovery already cover staleness),
// and never proactively repaired anything. The enroller module remains
// as an inert compatibility registry so hot paths (VFS materialize,
// TorBox delivery) stay untouched; its calls are no-ops without a
// registered scheduler, which no longer exists.


import { buildDiagnostics, summarizeForStartup } from '../lib/diagnostics/readiness.js';
import { listLibrary } from '../lib/library/listing.js';
import { readRetirementPolicy } from '../lib/consumers/eligibility.js';
import { createRealDebridClient } from '../lib/providers/realdebrid/client.js';
import { runReconcile } from '../lib/consumers/reconcile.js';
import {
  createCorpusLifecycle,
  corpusUpdateIntervalMs,
  corpusAutoBootstrap,
  corpusMaintenanceEnabled,
  bootstrapSessionPolicy,
} from '../lib/discovery/corpus-lifecycle.js';
import { createFutureIntentStore } from '../lib/anticipation/future-intents.js';
import { createPromotionStore } from '../lib/promotion/store.js';
import { createPromotionWorker } from '../lib/promotion/worker.js';
import { createDownloadStore } from '../lib/download/store.js';
import { createDownloadWorker } from '../lib/download/worker.js';
import { selectionMaxTier } from '../lib/lifecycle/quality-profiles.js';
import { getPreparedDurableState } from '../api/media-request.js';
import { createAnticipationScheduler } from '../lib/anticipation/scheduler.js';
import {
  createIdleEnrichment, enrichmentIntervalMs,
} from '../lib/discovery/idle-enrichment.js';
import {
  createCorpusHygiene, hygieneIntervalMs,
} from '../lib/discovery/corpus-hygiene.js';
import { isCorpusBusy } from '../lib/discovery/corpus-lifecycle.js';
import { getMediaById } from '../lib/metadata/unified-search.js';
import { checkTorBoxCached } from '../lib/providers/torbox.js';
import { createArrClient } from '../lib/anticipation/arr-client.js';
import { createArrSync } from '../lib/anticipation/arr-sync.js';

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
  reconcileTimer = setTimeout(async () => {
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
  corpusTimer = setTimeout(async () => {
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
const anticipationScheduler = anticipationOn
  ? createAnticipationScheduler({
    store: createFutureIntentStore({ db: discoveryCache.db }),
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
  })
  : null;
function armAnticipationTimer(delayMs) {
  anticipationTimer = setTimeout(async () => {
    try {
      if (anticipationScheduler && !anticipationInFlight) {
        anticipationInFlight = true;
        try {
          const result = await anticipationScheduler.tickOnce();
          if (result.acted) {
            console.log(`media-search: anticipation tick intent=${result.intentId} ${result.from || ''}->${result.to || result.reason || ''} (${result.ms ?? 0}ms)`);
          }
        } finally {
          anticipationInFlight = false;
        }
      }
    } catch (error) {
      console.warn('media-search: anticipation tick failed', error?.message);
    } finally {
      armAnticipationTimer(anticipationIntervalMs());
    }
  }, delayMs);
  if (anticipationTimer.unref) anticipationTimer.unref();
}
if (anticipationOn) {
  armAnticipationTimer(2 * 60_000);
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
let upgradeWatchTimer = null;
let upgradeWatchInFlight = false;
const upgradeWatchOn = (() => {
  const v = String(process.env.UPGRADE_WATCH_ENABLED ?? '').toLowerCase();
  return v !== '0' && v !== 'false';
})();
let upgradeEvaluator = null;
function armUpgradeWatchTimer(delayMs) {
  upgradeWatchTimer = setTimeout(async () => {
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
            const { retireDuePublications, observePlaybackSessions, countTemporaryPublications } =
              await import('../lib/library/retirement.js');
            // Consumption-aware retention: fold live Plex sessions into
            // temporary publications first (started extends the horizon,
            // completed shortens to a grace period). Skipped entirely
            // when nothing temporary is published (zero-cost default) or
            // Plex is unconfigured (TTL stands as fallback).
            try {
              if (countTemporaryPublications(controlPlaneStore) > 0
                && process.env.PLEX_URL && process.env.PLEX_TOKEN) {
                const { fetchPlexSessions } = await import('../lib/consumers/plex-sessions.js');
                const seen = await fetchPlexSessions({
                  plexUrl: process.env.PLEX_URL, plexToken: process.env.PLEX_TOKEN,
                });
                if (seen.ok && seen.sessions.length > 0) {
                  const adj = observePlaybackSessions({
                    controlPlaneStore, sessions: seen.sessions,
                  });
                  if (adj.observed > 0) {
                    console.log(`media-search: playback observed=${adj.observed} extended=${adj.extended} completed=${adj.completed}`);
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
  promotionTimer = setTimeout(async () => {
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
  downloadTimer = setTimeout(async () => {
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
  arrSyncTimer = setTimeout(async () => {
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
  enrichmentTimer = setTimeout(async () => {
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
  hygieneTimer = setTimeout(async () => {
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

const server = createApp({
  searchCache: discoveryCache,
  controlPlaneStore,
  // Availability tranche: a Seerr MEDIA_AVAILABLE wake that actually
  // awakened deferred intent pulls the next anticipation tick forward
  // (5 s, debounced by replacing the pending timer). The tick still
  // processes exactly one intent through the normal claim; the global
  // 15-minute cadence is untouched, and an in-flight tick is never
  // interrupted.
  schedulingNudge: () => {
    if (!anticipationOn || anticipationInFlight) return;
    try {
      if (anticipationTimer) clearTimeout(anticipationTimer);
    } catch {}
    armAnticipationTimer(5000);
  },
  enrichmentStatus: () => enrichment?.getStatus() ?? { enabled: false },
  hygieneStatus: () => hygiene?.getStatus() ?? { enabled: false },
});
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`media-search received ${signal}; shutting down`);
  if (reconcileTimer) clearTimeout(reconcileTimer);
  server.close(() => {
    discoveryCache.close();
    controlPlaneStore.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(port, host, () => {
  console.log(`media-search listening on http://${host}:${port}`);
  // One product-readiness summary at startup (background, never blocks
  // listen, never retries). Short-timeout checks only; any failure logs
  // and leaves runtime behavior unchanged.
  setTimeout(async () => {
    try {
      const diagnostics = await buildDiagnostics({
        cache: discoveryCache,
        controlPlaneStore,
        env: process.env,
        listLibraryFn: listLibrary,
        retirementPolicy: readRetirementPolicy(),
        realDebridClientFactory: (opts) => createRealDebridClient({ ...opts, minIntervalMs: 100 }),
      });
      console.log(summarizeForStartup(diagnostics));
    } catch (error) {
      console.warn('media-search: startup readiness summary failed', error?.message);
    }
  }, 5000);
});
