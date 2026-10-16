/**
 * media-search composition root.
 *
 * Ownership, deliberately explicit:
 *   - THIS module: process identity (port/host), durable store
 *     construction (discovery cache + control plane), background worker
 *     startup, HTTP server construction + listen, shutdown/cleanup, and
 *     the one startup readiness summary.
 *   - src/server/workers.js: every background ticker and its env flags.
 *   - src/server/app.js: dependency injection surface for the request
 *     handler and route registration.
 *
 * No DI framework: dependencies are constructed here and passed in.
 */

import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createApp } from './app.js';
import { startBackgroundWorkers } from './workers.js';
import { createTorBoxProvider } from '../lib/providers/torbox.js';
import { createTorBoxInventoryProvider } from '../lib/providers/torbox-inventory.js';
import { createRealDebridClient } from '../lib/providers/realdebrid/client.js';
import { buildDiagnostics, summarizeForStartup } from '../lib/diagnostics/readiness.js';
import { listLibrary } from '../lib/library/listing.js';
import { readRetirementPolicy } from '../lib/consumers/eligibility.js';
import { recoverStaleCorpusState } from '../lib/discovery/corpus-lifecycle.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

// ─── durable stores ───────────────────────────────────────────────────
const discoveryCache = createDiscoveryCache(process.env.DISCOVERY_DB ? { dbPath: process.env.DISCOVERY_DB } : {});
const controlPlaneStore = createControlPlaneStore(
  process.env.CONTROL_PLANE_DB ? { dbPath: process.env.CONTROL_PLANE_DB } : {},
);

// ─── shared provider clients ──────────────────────────────────────────
// Built once here and injected into BOTH the request handler and the
// background workers, so the two can never disagree about how a provider
// surface is constructed (or how many clients exist per process).
const torBoxProvider = createTorBoxProvider({ apiKey: process.env.TORBOX_API_KEY });
const torBoxInventoryProvider = createTorBoxInventoryProvider({ apiKey: process.env.TORBOX_API_KEY });
const rdClient = process.env.REALDEBRID_API_KEY
  ? createRealDebridClient({ apiKey: process.env.REALDEBRID_API_KEY, minIntervalMs: 100 })
  : null;

// ─── background workers ───────────────────────────────────────────────
// Every ticker (reconcile, corpus maintenance, anticipation, playback
// observation, upgrade watch/retirement, promotion, downloads, *arr sync,
// enrichment, hygiene, stale-route reconciliation) is armed inside
// workers.js with its own env flag. The handles below are the only knobs
// the server surface needs.
const workers = startBackgroundWorkers({
  discoveryCache,
  controlPlaneStore,
  port,
  dependencies: { torBoxProvider, torBoxInventoryProvider, rdClient },
});

// ─── HTTP server ──────────────────────────────────────────────────────
const server = createApp({
  searchCache: discoveryCache,
  controlPlaneStore,
  torBoxProvider,
  torBoxInventoryProvider,
  rdClient,
  // Availability tranche: a Seerr MEDIA_AVAILABLE wake that actually
  // awakened deferred intent pulls the next anticipation tick forward
  // (5 s, debounced inside the worker by replacing the pending timer).
  // The tick still processes exactly one intent through the normal
  // claim; the global 15-minute cadence is untouched, and an in-flight
  // tick is never interrupted.
  schedulingNudge: workers.nudgeScheduling,
  enrichmentStatus: workers.enrichmentStatus,
  hygieneStatus: workers.hygieneStatus,
});

// ─── lifecycle ────────────────────────────────────────────────────────
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`media-search received ${signal}; shutting down`);
  workers.stop();
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
  // Stale-ownership recovery at startup: a kill mid-session leaves a
  // busy marker with no owner. Same shared detector as the tick gate;
  // a fresh heartbeat is left alone, anything older converges to the
  // last-good position without discarding ingested work.
  try {
    const rec = recoverStaleCorpusState(discoveryCache.db, {});
    if (rec.recovered) {
      console.log(`media-search: Recovered stale corpus lifecycle state (was ${rec.from}, heartbeat ${Math.round((rec.ageMs ?? 0) / 60000)}m old)`);
    }
  } catch (error) {
    console.warn('media-search: corpus stale-recovery check failed', error?.message);
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
