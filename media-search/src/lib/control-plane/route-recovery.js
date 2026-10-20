/**
 * Route recovery: the durable evidence is the input.
 *
 * The route reconciler used to rediscover route failure by asking the
 * providers: every pass listed the TorBox cache for every bound hash and
 * the whole Real-Debrid account, then compared the answer with the
 * recorded inventory. That re-proved facts the control plane already
 * knows, on a six-hour timer, so a route that died at 10:00 was not
 * noticed until 16:00 — and a route already proven dead was proven dead
 * again, and again.
 *
 * The durable delivery evidence (`provider_delivery_evidence`) already
 * records, per capability tuple, what was observed and when:
 *
 *   unknown   no row: nobody observed this route
 *   usable    the route delivered bytes
 *   temporary the provider said wait (throttle/timeout) — NOT death
 *   terminal  the route answered "gone" — death, and it survives a restart
 *
 * This module turns that record into WORK, using the SHARED route
 * classification (`classifyRoutesForTorrentFile`) so that route
 * availability has exactly ONE definition in the codebase:
 *
 *   - a TorrentFile whose every route is proven dead has a repair DUE.
 *     The due fact IS the evidence; no new table, no queue.
 *   - a route proven dead may be retired once a SIBLING route is not
 *     proven dead — from evidence, with no provider call.
 *   - everything else is not work. A route nobody observed, a route that
 *     merely throttled, and a TorrentFile with a healthy route are left
 *     alone: the byte path retries them naturally.
 *
 * The evidence is provider truth, never representation truth: nothing here
 * reads or writes a Binding.
 */

import {
  classifyRoutesForTorrentFiles,
  ROUTE_STATES,
} from './route-classification.js';

/**
 * TorrentFiles whose repair is DUE because every recorded route of an
 * actively bound TorrentFile is proven dead.
 *
 * "Every recorded route" is the honest bound: the durable inventory is
 * not a proof that no other route exists anywhere (that needs the provider
 * account index — the same-TorrentFile discovery step, which the recovery
 * itself runs). It IS a proof that no KNOWN route can serve.
 *
 * @param {Object} store - control-plane store
 * @param {Object} [options]
 * @param {number} [options.limit=25]
 * @param {number} [options.now]
 * @returns {Array<{torrentFileId: string, infoHash: string, deadRoutes: number}>}
 */
export function findEvidenceRepairDueTorrentFiles(store, {
  limit = 25,
  now = Date.now(),
} = {}) {
  if (!store || typeof store.db?.prepare !== 'function') return [];
  const bound = store.db.prepare(`
    SELECT DISTINCT b.torrent_file_id AS torrent_file_id, tf.info_hash AS info_hash
    FROM bindings b
    JOIN torrent_files tf ON tf.id = b.torrent_file_id
    WHERE b.status = 'active'
    ORDER BY b.valid_from ASC, b.id ASC
  `).all();

  const max = Math.max(1, Math.trunc(Number(limit) || 25));
  const due = [];
  for (const row of bound) {
    if (due.length >= max) break;
    const view = classifyRoutesForTorrentFiles(store, {
      torrentFileIds: [row.torrent_file_id],
      now,
    }).get(row.torrent_file_id);
    if (!view?.allRoutesDead) continue;
    due.push({
      torrentFileId: row.torrent_file_id,
      infoHash: row.info_hash,
      deadRoutes: view.dead.length,
    });
  }
  return due;
}

/**
 * Placements whose route is proven dead AND that have a sibling route that
 * is not proven dead. Those are the only placements that may be retired
 * without a provider call: the dead one is proven gone, and the survivor
 * is not proven gone.
 *
 * @param {Object} store
 * @param {Object} [options]
 * @param {number} [options.now]
 * @param {number} [options.limit=25]
 * @returns {Array<{torrentFileId:string,provider:string,resourceId:string,placementId:string}>}
 */
export function findEvidenceProvenDeadPlacements(store, {
  now = Date.now(),
  limit = 25,
} = {}) {
  if (!store || typeof store.db?.prepare !== 'function') return [];
  const bound = store.db.prepare(`
    SELECT DISTINCT b.torrent_file_id AS torrent_file_id
    FROM bindings b
    WHERE b.status = 'active'
  `).all();

  const out = [];
  const max = Math.max(1, Math.trunc(Number(limit) || 25));
  const views = classifyRoutesForTorrentFiles(store, {
    torrentFileIds: bound.map((row) => row.torrent_file_id),
    now,
  });
  for (const row of bound) {
    const view = views.get(row.torrent_file_id);
    if (!view || view.dead.length === 0) continue;
    const hasSurvivor = view.routes.some((route) => route.state !== ROUTE_STATES.DEAD);
    if (!hasSurvivor) continue; // never retire a title's last route
    for (const route of view.dead) {
      out.push({
        torrentFileId: row.torrent_file_id,
        provider: route.provider,
        resourceId: route.providerResourceId,
        placementId: route.placementId,
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}
