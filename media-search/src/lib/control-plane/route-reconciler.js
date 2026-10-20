/**
 * Stale ProviderPlacement reconciliation.
 *
 * Durable route inventory drifts: a provider frees a cached resource, an
 * account is rotated, a torrent is deleted. When that happens the recorded
 * ProviderPlacement stays `ready` forever, `presentProviders()` keeps
 * reporting the provider as covered, and every consumer of the S-1
 * projection (the Rust data plane, Binding activation, the second-placement
 * ensurer) keeps routing at a route that no longer exists.
 *
 * This reconciler closes that loop with cache-only reads:
 *
 *   1. find active-bound TorrentFiles whose recorded placements are all
 *      unusable (no live placement carrying a present+mapped file row);
 *   2. ask the existing second-placement ensurer to look for the SAME
 *      exact representation on any provider that already has it cached
 *      (`discoverOnly: true` — it never calls addMagnet);
 *   3. record whatever durable placement it creates.
 *
 * What it does NOT do:
 *   - change Release/TorrentFile identity (route inventory only);
 *   - acquire uncached content on any provider;
 *   - mark a placement removed because one request failed transiently
 *     (removal is a runtime durability verdict, handled where the failure
 *     is observed);
 *   - probe providers for TorrentFiles that already have a usable route.
 *
 * Same exact TorrentFile bytes on another provider = another
 * ProviderPlacement. Same episode from a different release is a
 * representation question for ranking/Binding, never resolved here.
 */

/** A recorded placement is usable when it is live AND carries a present,
 * mapped provider-file row bound to the exact TorrentFile. This mirrors the
 * authoritative S-1 projection (`listDataPlaneCoordinates`): a placement in
 * state `removed` is a runtime durability verdict, never a route. */
import {
  findEvidenceProvenDeadPlacements,
  findEvidenceRepairDueTorrentFiles,
} from './route-recovery.js';

export function usablePlacementCount(store, torrentFileId) {
  if (!store || typeof store.db?.prepare !== 'function') return 0;
  const row = store.db.prepare(`
    SELECT COUNT(DISTINCT pl.id) AS n
    FROM provider_files pf
    JOIN provider_placements pl ON pl.id = pf.placement_id
    WHERE pf.torrent_file_id = ?
      AND pf.present = 1
      AND pf.mapping_state = 'mapped'
      AND pl.state <> 'removed'
  `).get(torrentFileId);
  return Number(row?.n ?? 0);
}

/**
 * Durable-only staleness: active-bound TorrentFiles with no recorded route
 * that a non-removed placement can still deliver (no present+mapped
 * provider-file row). Cheap and offline-safe, but it shares
 * `presentProviders()`'s blind spot — a row that still looks healthy after
 * the provider freed the resource reads as usable. Use
 *
 * Bounded by `limit`, oldest-binding first. The bound counts stale
 * candidates only: healthy inventory is never re-examined.
 */
export function findStaleRouteTorrentFiles(store, { limit = 25 } = {}) {
  if (!store || typeof store.db?.prepare !== 'function') return [];
  const rows = store.db.prepare(`
    SELECT DISTINCT tf.id AS torrent_file_id
    FROM torrent_files tf
    JOIN bindings b ON b.torrent_file_id = tf.id AND b.status = 'active'
    WHERE NOT EXISTS (
      SELECT 1
      FROM provider_files pf
      JOIN provider_placements pl ON pl.id = pf.placement_id
      WHERE pf.torrent_file_id = tf.id
        AND pf.present = 1
        AND pf.mapping_state = 'mapped'
        AND pl.state <> 'removed'
    )
    ORDER BY b.valid_from ASC, b.id ASC
    LIMIT @limit
  `).all({ limit: Math.max(1, Math.trunc(Number(limit) || 25)) });
  return rows.map((row) => row.torrent_file_id);
}

/**
 * Bounded retirement of placements the provider has objectively disproven.
 *
 * Removal is a durability verdict, so it is allowed only for PROVEN route
 * death: the route's own delivery evidence is terminal (the provider
 * answered "gone"), and a sibling route of the same TorrentFile is proven
 * alive (its evidence is usable — it delivered bytes). Two guards keep it
 * safe:
 *
 *   - REDUNDANT ONLY. A placement is retired only when the same TorrentFile
 *     has at least one other PROVEN-ALIVE route. Retiring a title's last
 *     route would un-serve it for as long as discovery takes to find a
 *     replacement.
 *   - PROVEN, NOT INFERRED. A route with no evidence, or a temporary one,
 *     is never a removal reason, so an outage cannot retire inventory.
 *
 * No provider call is made: the evidence already proves what a provider
 * probe would have been asked to prove. Idempotent: a retired placement is
 * already `removed` in durable truth and disappears from the S-1
 * projection, so a later pass finds nothing to do.
 *
 * @returns {Promise<{retired: Array<{torrentFileId,provider,resourceId,placementId}>, deferred:number}>}
 */
export async function retireVerifiedDeadRedundantRoutes({
  store,
  limit = 25,
  now = null,
  log = () => {},
} = {}) {
  // Freshness is compared against the SAME clock that wrote the rows.
  const at = typeof now === 'function' ? now() : (now ?? (typeof store?.now === 'function' ? store.now() : Date.now()));
  const result = { retired: [], deferred: 0 };
  const max = Math.max(1, Math.trunc(Number(limit) || 25));
  for (const route of findEvidenceProvenDeadPlacements(store, { now: at, limit: max })) {
    if (result.retired.length >= max) return result;
    try {
      store.markPlacementRemoved(route.placementId, {
        reason: 'route-terminal-evidence',
        observedAt: at,
      });
    } catch (error) {
      log(`route-reconcile retire skipped placement=${route.placementId}: ${error?.message ?? error}`);
      continue;
    }
    result.retired.push({
      torrentFileId: route.torrentFileId,
      provider: route.provider,
      resourceId: route.resourceId,
      placementId: route.placementId,
    });
    log(`route-reconcile retired placement=${route.placementId} provider=${route.provider} `
      + `resource=${route.resourceId} tf=${route.torrentFileId} reason=terminal-evidence`);
  }
  return result;
}

/**
 * One bounded reconciliation pass.
 *
 * @param {Object} params
 * @param {Object} params.store - control-plane store
 * @param {Object} params.secondPlacement - ensurer with
 *   `ensureSecondPlacementCoalesced` or `ensureSecondPlacement`
 * @param {Object} [params.providers] - live provider surfaces (TorBox/RD
 *   cache-only readers). When supplied, staleness is verified against the
 *   provider instead of trusting durable inventory alone.
 * @param {number} [params.limit=25] - max TorrentFiles per pass
 * @param {Function} [params.log]
 * @returns {Promise<{scanned:number, repaired:number, unavailable:number, failed:number, ids:string[]}>}
 */
async function repairCandidates({ store, secondPlacement, candidates, limit, log }) {
  const result = { scanned: 0, repaired: 0, unavailable: 0, failed: 0, ids: [] };
  if (!store || !secondPlacement) return result;
  const ensure = typeof secondPlacement.ensureSecondPlacementCoalesced === 'function'
    ? secondPlacement.ensureSecondPlacementCoalesced.bind(secondPlacement)
    : (typeof secondPlacement.ensureSecondPlacement === 'function'
      ? secondPlacement.ensureSecondPlacement.bind(secondPlacement)
      : null);
  if (!ensure) return result;
  for (const torrentFileId of candidates) {
    if (result.scanned >= limit) break;
    result.scanned += 1;
    let outcome;
    try {
      outcome = await ensure({ torrentFileId, discoverOnly: true });
    } catch (error) {
      result.failed += 1;
      log(`route-reconcile error tf=${torrentFileId}: ${error?.message ?? error}`);
      continue;
    }
    const status = String(outcome?.status ?? '');
    if (status === 'created') {
      result.repaired += 1;
      result.ids.push(torrentFileId);
      log(`route-reconcile repaired tf=${torrentFileId} provider=${outcome.targetProvider} source=${outcome.idSource} apiCalls=${outcome.apiCalls}`);
    } else if (status === 'unavailable') {
      // The representation exists but nothing already has it cached. This is
      // the honest negative result: the reconciler must never acquire it.
      result.unavailable += 1;
      log(`route-reconcile no-cached-route tf=${torrentFileId} provider=${outcome.targetProvider} reason=${outcome.reason ?? status}`);
    } else {
      // 'failed' = no exact same-representation match (never a repair);
      // 'provider-error' / anything else = the probe could not answer.
      result.failed += 1;
      log(`route-reconcile error tf=${torrentFileId} status=${status} reason=${outcome?.reason ?? ''}`);
    }
  }
  return result;
}

/**
 * FAILURE-DRIVEN recovery: the TorrentFiles whose repair is DUE because the
 * durable delivery evidence says every recorded route is dead.
 *
 * This pass is LOCAL until work is due: the candidate set is a read of the
 * evidence, and the provider is consulted only for the discovery the repair
 * itself needs ("is there another resource for this exact TorrentFile?").
 * A terminal fact is never re-proved.
 */
export async function reconcileEvidenceDueRoutes({
  store,
  secondPlacement,
  limit = 25,
  now = null,
  log = () => {},
} = {}) {
  const at = typeof now === 'function' ? now() : (now ?? (typeof store?.now === 'function' ? store.now() : Date.now()));
  const due = findEvidenceRepairDueTorrentFiles(store, { limit, now: at }).map((r) => r.torrentFileId);
  if (due.length === 0) {
    return { scanned: 0, repaired: 0, unavailable: 0, failed: 0, ids: [] };
  }
  return repairCandidates({ store, secondPlacement, candidates: due, limit, log });
}

/**
 * DISCOVERY sweep: actively bound TorrentFiles with NO recorded route at
 * all. Their release may have appeared in an account since we last looked,
 * and only the provider can answer that. A slow cadence is correct: nothing
 * is broken, the item simply is not available yet.
 */
export async function reconcileStaleRoutes({
  store,
  secondPlacement,
  limit = 25,
  now = Date.now(),
  log = () => {},
} = {}) {
  const stale = findStaleRouteTorrentFiles(store, { limit });
  if (stale.length === 0) {
    return { scanned: 0, repaired: 0, unavailable: 0, failed: 0, ids: [] };
  }
  return repairCandidates({ store, secondPlacement, candidates: stale, limit, log });
}
