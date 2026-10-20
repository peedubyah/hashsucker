/**
 * Route classification: ONE view of a TorrentFile's routes, composed from
 * the three durable facts that answer three different questions.
 *
 *   ProviderPlacement  — which route identities do we KNOW?
 *   ProviderFile       — which provider-side file maps to this TorrentFile?
 *   delivery evidence  — what have we OBSERVED about that route's ability
 *                        to deliver right now?
 *
 * These are not the same fact and must not be collapsed. A placement can
 * exist while the provider has freed the resource; a provider file can be
 * mapped while the route cannot deliver; and a route can be unknown
 * (nobody observed it) without being dead.
 *
 * The classification is therefore per ROUTE (an exact capability tuple),
 * and the per-provider view is the best of that provider's routes:
 *
 *   serviceable — a recent positive observation (it delivered bytes)
 *   retryable  — a recent temporary observation (the provider said wait)
 *                or no observation at all: the route may still work and
 *                the next read will try it
 *   dead       — a fresh TERMINAL observation (the provider answered
 *                "gone")
 *
 * A terminal observation is NOT eternal truth: it expires with the
 * evidence's own horizon, and a successful delivery or a fresh inventory
 * observation of that route supersedes it.
 *
 * The module is deliberately small and answers concrete questions:
 *   - which routes of this TorrentFile are dead (so recovery can target
 *     the provider that lost the route, not the one that happens to lack
 *     a second placement);
 *   - does this TorrentFile have any route that can still be attempted;
 *   - which routes may the byte path be offered.
 */

/** The per-route states, best first. */
export const ROUTE_STATES = Object.freeze({
  SERVICEABLE: 'serviceable',
  RETRYABLE: 'retryable',
  DEAD: 'dead',
});

const STATE_RANK = Object.freeze({
  [ROUTE_STATES.SERVICEABLE]: 0,
  [ROUTE_STATES.RETRYABLE]: 1,
  [ROUTE_STATES.DEAD]: 2,
});

/**
 * @param {Object} store - control-plane store
 * @param {Object} params
 * @param {string} params.torrentFileId
 * @param {number} [params.now]
 * @returns {{
 *   routes: Array<{provider:string,accountScope:string,placementId:string,
 *     providerResourceId:string,providerFileId:string,size:number,
 *     state:string,evidence:string|null,evidenceExpiresAt:number|null}>,
 *   byProvider: Record<string, {state:string, routes:Array}>,
 *   serviceable: Array, retryable: Array, dead: Array,
 *   hasServableRoute: boolean, hasRetryableRoute: boolean, allRoutesDead: boolean
 * }}
 */
export function classifyRoutesForTorrentFile(store, { torrentFileId, now = Date.now() } = {}) {
  const all = classifyRoutesForTorrentFiles(store, { torrentFileIds: [torrentFileId], now });
  return all.get(torrentFileId) ?? emptyClassification();
}

/**
 * The same classification for MANY TorrentFiles in ONE query.
 *
 * A reconciliation pass walks every actively bound TorrentFile; asking the
 * database once is the difference between a linear read and thousands of
 * round trips.
 *
 * @param {Object} store
 * @param {Object} params
 * @param {string[]} params.torrentFileIds
 * @param {number} [params.now]
 * @returns {Map<string, Object>} one classification per TorrentFile id
 */
export function classifyRoutesForTorrentFiles(store, { torrentFileIds = [], now = Date.now() } = {}) {
  const out = new Map();
  const ids = [...new Set(torrentFileIds.filter((id) => typeof id === 'string' && id))];
  if (!store || typeof store.db?.prepare !== 'function' || ids.length === 0) return out;

  const rows = store.db.prepare(`
    SELECT DISTINCT
      pf.torrent_file_id AS torrent_file_id,
      pl.provider AS provider,
      pl.account_scope AS account_scope,
      pl.provider_resource_id AS provider_resource_id,
      pl.id AS placement_id,
      pf.provider_file_id AS provider_file_id,
      pf.size AS size,
      ev.state AS evidence_state,
      ev.expires_at AS evidence_expires_at,
      ev.observed_at AS evidence_observed_at
    FROM provider_files pf
    JOIN provider_placements pl ON pl.id = pf.placement_id
    LEFT JOIN provider_delivery_evidence ev
      ON ev.provider = pl.provider
      AND ev.account_scope = pl.account_scope
      AND ev.placement_id = pl.id
      AND ev.provider_file_id = pf.provider_file_id
    WHERE pf.torrent_file_id IN (${ids.map(() => '?').join(',')})
      AND pf.present = 1
      AND pf.mapping_state = 'mapped'
      AND pl.state <> 'removed'
  `).all(...ids);

  const byTorrentFile = new Map(ids.map((id) => [id, []]));
  for (const row of rows) {
    const list = byTorrentFile.get(row.torrent_file_id);
    if (list) list.push(row);
  }
  for (const [id, list] of byTorrentFile) out.set(id, classifyRows(list, now));
  return out;
}

function emptyClassification() {
  return {
    routes: [], byProvider: {}, serviceable: [], retryable: [], dead: [],
    hasServableRoute: false, hasRetryableRoute: false, allRoutesDead: false,
  };
}

function classifyRows(rows, now) {
  const routes = rows.map((row) => {
    const evidence = row.evidence_state ?? null;
    const fresh = evidence != null && Number(row.evidence_expires_at) > now;
    let state;
    if (fresh && evidence === 'terminal') state = ROUTE_STATES.DEAD;
    else if (fresh && evidence === 'usable') state = ROUTE_STATES.SERVICEABLE;
    else state = ROUTE_STATES.RETRYABLE;
    return {
      provider: String(row.provider ?? '').toLowerCase(),
      accountScope: String(row.account_scope ?? 'default'),
      placementId: row.placement_id,
      providerResourceId: row.provider_resource_id,
      providerFileId: row.provider_file_id,
      size: row.size == null ? null : Number(row.size),
      state,
      evidence,
      evidenceExpiresAt: row.evidence_expires_at == null ? null : Number(row.evidence_expires_at),
      evidenceObservedAt: row.evidence_observed_at == null ? null : Number(row.evidence_observed_at),
    };
  });

  const byProvider = {};
  for (const route of routes) {
    const current = byProvider[route.provider];
    if (!current) {
      byProvider[route.provider] = { state: route.state, routes: [route] };
      continue;
    }
    current.routes.push(route);
    if (STATE_RANK[route.state] < STATE_RANK[current.state]) current.state = route.state;
  }

  const serviceable = routes.filter((r) => r.state === ROUTE_STATES.SERVICEABLE);
  const retryable = routes.filter((r) => r.state === ROUTE_STATES.RETRYABLE);
  const dead = routes.filter((r) => r.state === ROUTE_STATES.DEAD);

  return {
    routes,
    byProvider,
    serviceable,
    retryable,
    dead,
    hasServableRoute: serviceable.length > 0,
    hasRetryableRoute: retryable.length > 0,
    allRoutesDead: routes.length > 0 && dead.length === routes.length,
  };
}

/**
 * The providers that still need a route for this TorrentFile: the ones
 * with no route at all, or whose every route is proven dead.
 *
 * A provider whose route is merely unknown or temporarily unavailable is
 * NOT a target: the route may still work, and the next read tries it.
 */
export function providersNeedingRoute(classification) {
  const dead = [];
  const absent = [];
  for (const provider of ['torbox', 'realdebrid']) {
    const view = classification?.byProvider?.[provider];
    if (!view) {
      absent.push(provider);
      continue;
    }
    if (view.state === ROUTE_STATES.DEAD) {
      dead.push(provider);
      continue;
    }
  }
  // The providers that LOST a route come first: they are the repair
  // targets. The providers that never had one are enrichment targets.
  return [...dead, ...absent];
}
