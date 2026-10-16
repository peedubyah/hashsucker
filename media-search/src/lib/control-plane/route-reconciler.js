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
 * `findRottedRouteTorrentFiles` when live provider truth is available.
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
 * Find active-bound TorrentFiles whose recorded routes are all unusable,
 * verified against live provider state with cache-only reads.
 *
 * Durable inventory cannot see a route whose row still looks healthy while
 * the provider freed the resource — `presentProviders()` and this module's
 * durable-only criterion share that blind spot by construction. So when
 * provider surfaces are supplied, every recorded route is verified: TorBox
 * `checkcached` answers "the account still has these bytes", RD `torrents`
 * answers the same for the account's downloaded list.
 *
 * A probe that cannot be answered is UNKNOWN, never stale: the pass defers
 * those TorrentFiles rather than minting work (or teardown) from a network
 * failure.
 *
 * @returns {Promise<string[]>} TorrentFile ids with no live recorded route
 */
export async function findRottedRouteTorrentFiles(store, {
  limit = 25,
  providers,
  log = () => {},
} = {}) {
  const max = Math.max(1, Math.trunc(Number(limit) || 25));
  if (!store || typeof store.db?.prepare !== 'function' || !providers) return [];

  const rows = store.db.prepare(`
    SELECT DISTINCT tf.id AS torrent_file_id, tf.info_hash AS info_hash,
           pl.provider AS provider, pl.provider_resource_id AS resource_id
    FROM torrent_files tf
    JOIN bindings b ON b.torrent_file_id = tf.id AND b.status = 'active'
    JOIN provider_files pf ON pf.torrent_file_id = tf.id AND pf.present = 1
      AND pf.mapping_state = 'mapped'
    JOIN provider_placements pl ON pl.id = pf.placement_id AND pl.state <> 'removed'
    ORDER BY b.valid_from ASC, b.id ASC
  `).all();
  if (rows.length === 0) return [];

  const byTf = new Map();
  for (const row of rows) {
    if (!byTf.has(row.torrent_file_id)) byTf.set(row.torrent_file_id, { infoHash: row.info_hash, routes: [] });
    byTf.get(row.torrent_file_id).routes.push({ provider: row.provider, resourceId: row.resource_id });
  }

  const hashes = [...new Set([...byTf.values()].map((v) => String(v.infoHash ?? '').trim().toLowerCase()).filter(Boolean))];
  const torboxCached = await readTorBoxCached(providers, hashes, log);
  const rdHashes = await readRdHashes(providers, log);

  const rotted = [];
  for (const [torrentFileId, info] of byTf) {
    const hash = String(info.infoHash ?? '').trim().toLowerCase();
    if (!hash) continue; // no exact identity recorded: nothing to verify
    let live = false;
    let unknown = false;
    for (const route of info.routes) {
      const provider = String(route.provider ?? '').toLowerCase();
      if (provider === 'torbox') {
        if (!torboxCached) unknown = true;
        else if (torboxCached.has(hash)) live = true;
      } else if (provider === 'realdebrid') {
        if (!rdHashes) unknown = true;
        else if (rdHashes.has(hash)) live = true;
      }
    }
    if (live) continue;
    if (unknown) {
      // A route we could not verify is not a rotted route. Defer it.
      continue;
    }
    rotted.push(torrentFileId);
    if (rotted.length >= max) break;
  }
  return rotted;
}

async function readTorBoxCached(providers, hashes, log) {
  const probe = providers?.torbox?.checkCached ?? providers?.checkCached;
  if (typeof probe !== 'function') return null;
  try {
    const result = await probe(hashes);
    if (result instanceof Set) return result;
    if (result?.cached instanceof Set) return result.cached;
    log(`route-reconcile torbox cache probe returned unusable payload`);
    return null;
  } catch (error) {
    log(`route-reconcile torbox cache probe failed: ${error?.message ?? error}`);
    return null;
  }
}

async function readRdHashes(providers, log) {
  const probe = providers?.realdebrid?.listTorrents;
  if (typeof probe !== 'function') return null;
  try {
    const listed = await probe({ limit: 5000 });
    return new Set(
      (Array.isArray(listed) ? listed : [])
        .map((entry) => String(entry?.hash ?? '').trim().toLowerCase())
        .filter(Boolean),
    );
  } catch (error) {
    log(`route-reconcile rd torrents probe failed: ${error?.message ?? error}`);
    return null;
  }
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
export async function reconcileStaleRoutes({
  store,
  secondPlacement,
  providers = null,
  limit = 25,
  log = () => {},
} = {}) {
  const result = { scanned: 0, repaired: 0, unavailable: 0, failed: 0, ids: [] };
  if (!store || !secondPlacement) return result;
  const ensure = typeof secondPlacement.ensureSecondPlacementCoalesced === 'function'
    ? secondPlacement.ensureSecondPlacementCoalesced.bind(secondPlacement)
    : (typeof secondPlacement.ensureSecondPlacement === 'function'
      ? secondPlacement.ensureSecondPlacement.bind(secondPlacement)
      : null);
  if (!ensure) return result;

  const stale = providers
    ? await findRottedRouteTorrentFiles(store, { limit, providers, log })
    : findStaleRouteTorrentFiles(store, { limit });
  for (const torrentFileId of stale) {
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
