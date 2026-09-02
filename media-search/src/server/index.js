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
import {
  createDurabilityRuntime,
  resolveDurabilityMode,
} from '../lib/control-plane/durability-runtime.js';

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
});
