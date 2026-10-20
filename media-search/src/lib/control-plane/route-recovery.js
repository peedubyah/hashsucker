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
 * This module turns that record into WORK:
 *
 *   - a TorrentFile whose every recorded route is proven dead has a
 *     repair DUE. The due fact IS the evidence; no new table, no queue.
 *   - a route proven dead may be retired once a SIBLING route is proven
 *     alive — both from evidence, with no provider call.
 *   - everything else is not work. A route nobody observed, a route that
 *     merely throttled, and a TorrentFile with a healthy route are left
 *     alone: the byte path retries them naturally.
 *
 * The evidence is provider truth, never representation truth: nothing here
 * reads or writes a Binding.
 */

/** How long a terminal record proves a route dead. */
const DEFAULT_EVIDENCE_HORIZON_MS = 10 * 60 * 1000;

/**
 * TorrentFiles whose repair is DUE because every recorded route of an
 * actively bound TorrentFile is proven dead.
 *
 * "Every recorded route" is the honest bound: the durable inventory is
 * not a proof that no other route exists anywhere (that needs the
 * provider account index — the same-TF discovery step, which the recovery
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
  const rows = store.db.prepare(`
    WITH route_evidence AS (
      SELECT DISTINCT
        tf.id AS torrent_file_id,
        tf.info_hash AS info_hash,
        pl.id AS placement_id,
        ev.state AS evidence_state,
        ev.expires_at AS evidence_expires_at,
        ev.observed_at AS evidence_observed_at
      FROM torrent_files tf
      JOIN bindings b ON b.torrent_file_id = tf.id AND b.status = 'active'
      JOIN provider_files pf ON pf.torrent_file_id = tf.id
        AND pf.present = 1 AND pf.mapping_state = 'mapped'
      JOIN provider_placements pl ON pl.id = pf.placement_id AND pl.state <> 'removed'
      LEFT JOIN provider_delivery_evidence ev
        ON ev.provider = pl.provider
        AND ev.account_scope = pl.account_scope
        AND ev.placement_id = pl.id
        AND ev.provider_file_id = pf.provider_file_id
    )
    SELECT torrent_file_id, info_hash,
           COUNT(*) AS route_count,
           MIN(evidence_observed_at) AS oldest_failure_at
    FROM route_evidence
    GROUP BY torrent_file_id, info_hash
    HAVING SUM(
      CASE WHEN evidence_state = 'terminal' AND evidence_expires_at > @now THEN 1 ELSE 0 END
    ) = COUNT(*)
    ORDER BY oldest_failure_at ASC
    LIMIT @limit
  `).all({ now, limit: Math.max(1, Math.trunc(Number(limit) || 25)) });
  return rows.map((row) => ({
    torrentFileId: row.torrent_file_id,
    infoHash: row.info_hash,
    deadRoutes: Number(row.route_count ?? 0),
  }));
}

/**
 * Placements whose route is proven dead AND that have a sibling route
 * proven alive. Those are the only placements that may be retired without
 * a provider call: the dead one is proven gone, and the survivor is
 * proven working.
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
  const rows = store.db.prepare(`
    WITH routes AS (
      SELECT DISTINCT
        tf.id AS torrent_file_id,
        pl.id AS placement_id,
        pl.provider AS provider,
        pl.account_scope AS account_scope,
        pl.provider_resource_id AS resource_id,
        pf.provider_file_id AS provider_file_id,
        ev.state AS evidence_state,
        ev.expires_at AS evidence_expires_at
      FROM torrent_files tf
      JOIN bindings b ON b.torrent_file_id = tf.id AND b.status = 'active'
      JOIN provider_files pf ON pf.torrent_file_id = tf.id
        AND pf.present = 1 AND pf.mapping_state = 'mapped'
      JOIN provider_placements pl ON pl.id = pf.placement_id AND pl.state <> 'removed'
      LEFT JOIN provider_delivery_evidence ev
        ON ev.provider = pl.provider
        AND ev.account_scope = pl.account_scope
        AND ev.placement_id = pl.id
        AND ev.provider_file_id = pf.provider_file_id
    ),
    dead AS (
      SELECT * FROM routes
      WHERE evidence_state = 'terminal' AND evidence_expires_at > @now
    ),
    alive AS (
      SELECT DISTINCT torrent_file_id, placement_id FROM routes
      WHERE evidence_state = 'usable' AND evidence_expires_at > @now
    )
    SELECT d.torrent_file_id, d.provider, d.resource_id, d.placement_id
    FROM dead d
    WHERE EXISTS (
      SELECT 1 FROM alive a
      WHERE a.torrent_file_id = d.torrent_file_id AND a.placement_id <> d.placement_id
    )
    ORDER BY d.placement_id ASC
    LIMIT @limit
  `).all({ now, limit: Math.max(1, Math.trunc(Number(limit) || 25)) });
  return rows.map((row) => ({
    torrentFileId: row.torrent_file_id,
    provider: row.provider,
    resourceId: row.resource_id,
    placementId: row.placement_id,
  }));
}

/**
 * The evidence horizon a terminal record is trusted for. Exposed so the
 * caller can reason about staleness without reaching into the table.
 */
export const ROUTE_EVIDENCE_HORIZON_MS = DEFAULT_EVIDENCE_HORIZON_MS;
