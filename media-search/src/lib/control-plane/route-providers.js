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
 * @param {Function} [params.torboxCheckCached] - Test seam for the
 *   cache-only hash probe. Production always uses the real provider call;
 *   injecting it lets a test verify reconciliation against a provider it
 *   controls without reaching the network.
 * @param {Object} [params.env]
 * @returns {{ torbox: Object|null, realdebrid: Object|null }}
 */
export function createRouteProviderSurfaces({
  torBoxProvider,
  torBoxInventoryProvider,
  rdClient,
  torboxCheckCached = null,
  env = process.env,
} = {}) {
  const torbox = (torBoxProvider && torBoxInventoryProvider)
    ? {
      // Cached-only creation semantics preserved; no new TorBox logic.
      createPlacement: (input) => torBoxProvider
        .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE).createPlacement(input),
      checkCached: (hashes) => (typeof torboxCheckCached === 'function'
        ? torboxCheckCached(hashes)
        : checkTorBoxCached(hashes, { apiKey: env.TORBOX_API_KEY })),
      lookupPlacement: (input, ctx) => torBoxInventoryProvider
        .require(PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP).lookupPlacement(input, ctx),
      // EVERY account resource for one hash. The singular lookup cannot
      // answer "is there a REPLACEMENT resource for this release?", because
      // two resources for one hash are a conflict there and a replacement
      // here.
      listPlacements: async (input, ctx) => {
        const snapshot = await torBoxInventoryProvider
          .require(PROVIDER_CAPABILITIES.MYLIST_SNAPSHOT).getMylistSnapshot(ctx);
        const hash = String(input?.infoHash ?? '').trim().toLowerCase();
        return (snapshot?.resources ?? [])
          .filter((resource) => String(resource?.infoHash ?? '').trim().toLowerCase() === hash)
          .map((resource) => ({
            providerResourceId: resource.providerResourceId,
            state: resource.downloadState ?? 'unknown',
            name: resource.name ?? null,
          }));
      },
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
