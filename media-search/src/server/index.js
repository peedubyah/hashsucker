import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createApp } from './app.js';
import { createTorBoxInventoryProvider } from '../lib/providers/torbox-inventory.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const discoveryCache = createDiscoveryCache(process.env.DISCOVERY_DB ? { dbPath: process.env.DISCOVERY_DB } : {});
const controlPlaneStore = createControlPlaneStore(
  process.env.CONTROL_PLANE_DB ? { dbPath: process.env.CONTROL_PLANE_DB } : {},
);

// ─── background durability V1 (named-repair runtime seam) ────────────────
//
// The runtime is only constructed when BACKGROUND_DURABILITY_MODE is
// explicitly set to 'observe' or 'execute'. Default is 'disabled', so a
// production deploy produces ZERO live provider calls: no scheduler
// pass, no TorBox snapshot adapter, no library scan. Persistence
// schema migration is idempotent and applied only when the scheduler
// is constructed; no startup storm is performed (per the
// durability-scheduler invariant: the constructor does not touch
// durable rows). Real-Debrid is never wired into the background seam.

import { createDurabilityScheduler } from '../lib/control-plane/durability-scheduler.js';
import { buildDiagnostics, summarizeForStartup } from '../lib/diagnostics/readiness.js';
import { listLibrary } from '../lib/library/listing.js';
import { readRetirementPolicy } from '../lib/consumers/eligibility.js';
import { createRealDebridClient } from '../lib/providers/realdebrid/client.js';
import {
  createDurabilityRuntime,
  resolveDurabilityMode,
} from '../lib/control-plane/durability-runtime.js';
import { runReconcile } from '../lib/consumers/reconcile.js';
import {
  createCorpusLifecycle,
  corpusUpdateIntervalMs,
  corpusAutoBootstrap,
} from '../lib/discovery/corpus-lifecycle.js';

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
// CORPUS_MAINTENANCE=0 disables both bootstrap and updates.
const corpusMaintenanceFlag = String(process.env.CORPUS_MAINTENANCE ?? '').toLowerCase();
const corpusMaintenanceEnabled = corpusMaintenanceFlag !== '0' && corpusMaintenanceFlag !== 'false';
const corpusLifecycle = corpusMaintenanceEnabled
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
          console.log('media-search: corpus bootstrap starting (absent baseline)');
          const result = await corpusLifecycle.bootstrap();
          console.log(`media-search: corpus bootstrap done ok=${result.ok} complete=${result.complete ?? 0} failed=${result.failed ?? 0}`);
          armCorpusTimer(corpusUpdateIntervalMs(process.env));
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
if (corpusMaintenanceEnabled) {
  armCorpusTimer(5 * 60_000);
}

const durabilityMode = resolveDurabilityMode(process.env);
let durabilityRuntime = null;
let durabilityScheduler = null;
let durabilityTimer = null;
if (durabilityMode === 'observe' || durabilityMode === 'execute') {
  durabilityScheduler = createDurabilityScheduler({
    controlPlaneStore,
    mode: durabilityMode,
  });
  // The TorBox snapshot adapter is wired only when the torbox-inventory
  // module is loadable AND the BACKGROUND_DURABILITY_TORBOX env flag is
  // explicitly set; otherwise no background-safe provider is configured
  // and the runtime correctly produces zero provider work.
  let torboxInventoryProvider = null;
  if (process.env.BACKGROUND_DURABILITY_TORBOX === '1'
    || process.env.BACKGROUND_DURABILITY_TORBOX === 'true') {
    try {
      torboxInventoryProvider = createTorBoxInventoryProvider();
    } catch (error) {
      console.warn('media-search: torbox inventory unavailable for background durability', error?.message);
    }
  }
  durabilityRuntime = createDurabilityRuntime({
    controlPlaneStore,
    durabilityScheduler,
    torboxInventoryProvider,
  });
  // Persisted next_pass_at governs startup: a setTimeout fires only
  // when the persisted next_pass_at is in the past. No immediate
  // full-library scan, no provider call.
  const state = controlPlaneStore.db.prepare(
    'SELECT next_pass_at FROM durability_scheduler_state WHERE id = 1',
  ).get();
  const delayMs = state?.next_pass_at
    ? Math.max(0, state.next_pass_at - Date.now())
    : 0;
  if (delayMs === 0) {
    // Bootstrap: run one pass immediately, then schedule the next.
    durabilityRuntime.runOnePass().catch((error) => {
      console.warn('media-search: durability bootstrap pass failed', error?.message);
    });
  }
  durabilityTimer = setTimeout(() => {
    const tick = () => {
      if (!durabilityRuntime) return;
      durabilityRuntime.runOnePass().catch((error) => {
        console.warn('media-search: durability pass failed', error?.message);
      });
      const next = controlPlaneStore.db.prepare(
        'SELECT next_pass_at FROM durability_scheduler_state WHERE id = 1',
      ).get();
      const ms = next?.next_pass_at
        ? Math.max(1000, next.next_pass_at - Date.now())
        : 6 * 60 * 60 * 1000;
      durabilityTimer = setTimeout(tick, ms);
      if (durabilityTimer.unref) durabilityTimer.unref();
    };
    tick();
  }, delayMs);
  if (durabilityTimer.unref) durabilityTimer.unref();
}

const server = createApp({ searchCache: discoveryCache, controlPlaneStore });
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`media-search received ${signal}; shutting down`);
  if (durabilityTimer) clearTimeout(durabilityTimer);
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
  if (durabilityMode !== 'disabled') {
    console.log(`media-search: background durability mode=${durabilityMode}`);
  }
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
