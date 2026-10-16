/**
 * Measure and (optionally) run one bounded route-reconciliation pass.
 *
 * Two halves, both cache-only:
 *
 *   1. Classification — for every active-bound TorrentFile, what does live
 *      provider state say about its recorded routes? TorBox is asked via
 *      `checkcached` (one batched call), Real-Debrid via one `torrents` list.
 *      Durable inventory is printed alongside so the gap between the two is
 *      visible — durable rows cannot see provider-side rot.
 *
 *   2. Pass — the exact code path the background worker runs, bounded by
 *      `--limit`. The ensurer is always discover-only, so nothing here can
 *      start an uncached acquisition.
 *
 * Usage:
 *   node scripts/live-route-reconcile.mjs                 # classify only
 *   node scripts/live-route-reconcile.mjs --limit 25      # also reconcile
 */

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { checkTorBoxCached } from '../src/lib/providers/torbox.js';
import { createRealDebridClient } from '../src/lib/providers/realdebrid/client.js';
import {
  findRottedRouteTorrentFiles,
  findStaleRouteTorrentFiles,
  reconcileStaleRoutes,
  usablePlacementCount,
} from '../src/lib/control-plane/route-reconciler.js';
import { createSecondPlacementEnsurer } from '../src/lib/control-plane/second-placement.js';
import { createRouteProviderSurfaces } from '../src/lib/control-plane/route-providers.js';
import { createTorBoxProvider } from '../src/lib/providers/torbox.js';
import { createTorBoxInventoryProvider } from '../src/lib/providers/torbox-inventory.js';

const limit = Number(process.argv.includes('--limit') ? process.argv[process.argv.indexOf('--limit') + 1] : 25);
const runPass = process.argv.includes('--limit');

const store = createControlPlaneStore({ dbPath: process.env.CONTROL_PLANE_DB });
const providers = createRouteProviderSurfaces({
  torBoxProvider: createTorBoxProvider({ apiKey: process.env.TORBOX_API_KEY }),
  torBoxInventoryProvider: createTorBoxInventoryProvider({ apiKey: process.env.TORBOX_API_KEY }),
  rdClient: createRealDebridClient({ apiKey: process.env.REALDEBRID_API_KEY }),
  env: process.env,
});

const activeBindings = store.db.prepare(`SELECT COUNT(*) c FROM bindings WHERE status = 'active'`).get().c;
const recorded = store.db.prepare(`
  SELECT tf.id AS tf_id, tf.info_hash AS hash, pl.provider AS provider
  FROM torrent_files tf
  JOIN bindings b ON b.torrent_file_id = tf.id AND b.status = 'active'
  JOIN provider_files pf ON pf.torrent_file_id = tf.id AND pf.present = 1 AND pf.mapping_state = 'mapped'
  JOIN provider_placements pl ON pl.id = pf.placement_id AND pl.state <> 'removed'
`).all();
const tfsWithRoute = new Set(recorded.map((r) => r.tf_id));
console.log(`active-bound TorrentFiles: ${activeBindings}`);
console.log(`  with a recorded route: ${tfsWithRoute.size}`);
console.log(`  with no recorded route: ${activeBindings - tfsWithRoute.size}`);

const hashes = [...new Set(recorded.map((r) => String(r.hash).toLowerCase()))];
const { cached } = await checkTorBoxCached(hashes, { apiKey: process.env.TORBOX_API_KEY });
const rdList = await providers.realdebrid.listTorrents({ limit: 5000 });
const rdHashes = new Set(rdList.map((t) => String(t?.hash ?? '').toLowerCase()));

const byTf = new Map();
for (const row of recorded) {
  if (!byTf.has(row.tf_id)) byTf.set(row.tf_id, { hash: String(row.hash).toLowerCase(), providers: new Set() });
  byTf.get(row.tf_id).providers.add(row.provider);
}
let usable = 0;
let rotted = 0;
for (const info of byTf.values()) {
  const live = [...info.providers].some((p) => (p === 'torbox' ? cached.has(info.hash) : p === 'realdebrid' ? rdHashes.has(info.hash) : false));
  if (live) usable += 1; else rotted += 1;
}
console.log(`live-verified usable routes: ${usable}`);
console.log(`live-verified rotted (rotable) routes: ${rotted}`);
console.log(`durable-only criterion (blind to provider-side rot) finds: ${findStaleRouteTorrentFiles(store, { limit: 5000 }).length}`);

if (!runPass) {
  store.close();
} else {
  const rottedIds = await findRottedRouteTorrentFiles(store, { limit, providers });
  console.log(`rotted TorrentFiles this pass (limit ${limit}): ${rottedIds.length}`);
  const ensurer = createSecondPlacementEnsurer({
    store,
    torbox: providers.torbox,
    realdebrid: providers.realdebrid,
    now: () => Date.now(),
  });
  const result = await reconcileStaleRoutes({
    store, secondPlacement: ensurer, providers, limit, log: (m) => console.log(`  ${m}`),
  });
  console.log(`pass: ${JSON.stringify(result)}`);
  console.log(`usablePlacementCount for repaired ids: ${result.ids.map((id) => usablePlacementCount(store, id)).join(',') || '-'}`);
  store.close();
}
