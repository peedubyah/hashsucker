/**
 * Provider route surfaces for durable-route reconciliation.
 *
 * One construction of the read-mostly provider surfaces both the request
 * handler and the background route reconciler need, so the two can never
 * disagree about how a provider is probed.
 *
 * Surfaces deliberately expose only what route reconciliation requires:
 *   - TorBox: cached-only create, cache check, placement lookup, file
 *     inventory. Cached-only semantics are preserved (addOnlyIfCached);
 *     nothing here can start an uncached TorBox download.
 *   - Real-Debrid: listTorrents + getTorrentInfo are all the discover-only
 *     reconcile path uses. addMagnet/selectFiles are exposed for interface
 *     parity with the existing second-placement ensurer but the reconciler
 *     never invokes them (it passes discoverOnly).
 */

import { PROVIDER_CAPABILITIES } from '../providers/capabilities.js';
import { checkTorBoxCached } from '../providers/torbox.js';

/**
 * @param {Object} params
 * @param {Object|null} params.torBoxProvider
 * @param {Object|null} params.torBoxInventoryProvider
 * @param {Object|null} params.rdClient
 * @param {Object} [params.env]
 * @returns {{ torbox: Object|null, realdebrid: Object|null }}
 */
export function createRouteProviderSurfaces({
  torBoxProvider,
  torBoxInventoryProvider,
  rdClient,
  env = process.env,
} = {}) {
  const torbox = (torBoxProvider && torBoxInventoryProvider)
    ? {
      // Cached-only creation semantics preserved; no new TorBox logic.
      createPlacement: (input) => torBoxProvider
        .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE).createPlacement(input),
      checkCached: (hashes) => checkTorBoxCached(hashes, { apiKey: env.TORBOX_API_KEY }),
      lookupPlacement: (input, ctx) => torBoxInventoryProvider
        .require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP).lookupPlacement(input, ctx),
      getFileInventory: (resource, ctx) => torBoxInventoryProvider
        .require(PROVIDER_CAPABILITIES.FILE_INVENTORY).getFileInventory(resource, ctx),
    }
    : null;

  const realdebrid = rdClient
    ? {
      listTorrents: (args) => rdClient.listTorrents(args),
      getTorrentInfo: (id, opts) => rdClient.getTorrentInfo(id, opts),
      addMagnet: (magnet, opts) => rdClient.addMagnet(magnet, opts),
      selectFiles: (id, ids, opts) => rdClient.selectFiles(id, ids, opts),
    }
    : null;

  return { torbox, realdebrid };
}
