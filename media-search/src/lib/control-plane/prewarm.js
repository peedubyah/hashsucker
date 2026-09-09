/**
 * T6 — explicit runtime prewarm caller (Node side).
 *
 * Adapted from the proven HY4 P2G helper on m3-north-db. Given an exact
 * TorrentFile with a durable placement, lets Node ask Rust to warm the
 * named provider's runtime DeliveryCapability *before* it is needed.
 * Plumbing and lifecycle only — no automatic policy here.
 *
 * WHAT THIS DOES
 *   1. Resolves both IDs from durable Node truth (torrent_files +
 *      provider_placements + provider_files rows).
 *   2. Verifies the placement belongs to the same Release/TorrentFile
 *      lineage being requested (placement.infoHash == TF infoHash AND a
 *      present+mapped provider_files row binds that placement to that
 *      exact TF). Anything else is `invalid-identity` with zero HTTP.
 *   3. POSTs only the durable execution coordinates Rust needs
 *      ({provider, providerResourceId, providerFileId, accountScope})
 *      to POST /files/:tfId/prewarm. Never a Node UUID Rust can't
 *      resolve, never a DeliveryCapability (runtime-only, never
 *      persisted), never a new placement.
 *
 * WHAT THIS NEVER DOES
 *   - Create/repair placements, rank/score, bind media, publish,
 *     touch discovery, choose another Release, stream bytes.
 *   - Throw for Rust-side outcomes: Rust result states map through
 *     transparently. Only transport failures (unreachable Rust,
 *     non-JSON) become `request-failed`, and malformed input becomes
 *     `invalid-input`.
 *
 * Production adaptation vs the proven source: the warmed-capability
 * identifier is `capId` (production Rust reports the observability-only
 * capability id; later HY4 generations do not exist here).
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {Object} options
 * @param {Object} options.store - Control-plane store (getTorrentFile,
 *   findPlacementByInfoHash, listProviderRefsForTorrentFile).
 * @param {string} options.dataPlaneBaseUrl - e.g. http://hy4-data-plane:3001
 * @param {Function} [options.fetchFn] - Fetch implementation.
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.logger]
 */
export function createPrewarmCaller({
  store,
  dataPlaneBaseUrl,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null,
} = {}) {
  if (!store || typeof store.getTorrentFile !== 'function'
    || typeof store.findPlacementByInfoHash !== 'function'
    || typeof store.listProviderRefsForTorrentFile !== 'function') {
    throw new TypeError('prewarm caller requires a control-plane store');
  }
  if (!dataPlaneBaseUrl || typeof dataPlaneBaseUrl !== 'string') {
    throw new TypeError('prewarm caller requires dataPlaneBaseUrl');
  }
  const log = logger ?? (() => {});
  const base = String(dataPlaneBaseUrl).replace(/\/+$/, '');

  /**
   * @param {Object} params
   * @param {string} params.torrentFileId - Durable TorrentFile id.
   * @param {string} params.providerPlacementId - Durable placement id.
   */
  async function prewarmPlacement({ torrentFileId, providerPlacementId } = {}) {
    if (!torrentFileId || typeof torrentFileId !== 'string'
      || !providerPlacementId || typeof providerPlacementId !== 'string') {
      return { status: 'invalid-input', reason: 'torrentFileId and providerPlacementId are required' };
    }
    const tf = store.getTorrentFile(torrentFileId);
    if (!tf) {
      return { status: 'unknown-torrent-file', torrentFileId };
    }
    // Lineage: find the placement by (provider, infoHash) among durable
    // rows, then require its id to be the requested one AND a
    // present+mapped provider_files row binding it to this exact TF.
    // A placement for any other hash, or for this hash but a different
    // file, can never satisfy the request.
    const refs = store.listProviderRefsForTorrentFile(torrentFileId) ?? [];
    const bound = refs.find((r) => r.placementId === providerPlacementId
      && r.present !== false && r.mappingState === 'mapped');
    if (!bound) {
      return {
        status: 'invalid-identity',
        reason: 'no present mapped provider file binds this placement to this TorrentFile',
        torrentFileId,
      };
    }
    // Cross-check the placement row itself is for this Release lineage.
    // (findPlacementByInfoHash filters removed rows, mirroring delivery.)
    let placement = null;
    for (const provider of ['torbox', 'realdebrid']) {
      const candidate = typeof store.findPlacementByInfoHash === 'function'
        ? store.findPlacementByInfoHash(provider, tf.infoHash)
        : null;
      if (candidate && candidate.id === providerPlacementId) {
        placement = candidate;
        break;
      }
    }
    if (!placement) {
      return {
        status: 'invalid-identity',
        reason: 'placement is not a live same-Release placement for this TorrentFile',
        torrentFileId,
      };
    }

    const payload = {
      provider: placement.provider,
      providerResourceId: placement.providerResourceId,
      providerFileId: bound.providerFileId,
      accountScope: placement.accountScope,
    };
    let response;
    try {
      response = await fetchFn(
        `${base}/files/${encodeURIComponent(torrentFileId)}/prewarm`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      log(`[prewarm] request failed for ${torrentFileId}: ${error.message}`);
      return { status: 'request-failed', reason: error.message, torrentFileId, placementId: placement.id };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return { status: 'request-failed', reason: `non-JSON prewarm response HTTP ${response.status}`, torrentFileId, placementId: placement.id };
    }
    return {
      status: typeof body?.status === 'string' ? body.status : 'request-failed',
      torrentFileId,
      placementId: placement.id,
      provider: body?.provider ?? placement.provider,
      providerResourceId: body?.providerResourceId ?? placement.providerResourceId,
      capId: body?.capId ?? null,
      apiDelta: typeof body?.apiDelta === 'number' ? body.apiDelta : null,
      elapsedMs: typeof body?.elapsedMs === 'number' ? body.elapsedMs : null,
      tfDurableKey: body?.tfDurableKey ?? null,
      ...(body?.reason ? { reason: body.reason } : {}),
    };
  }

  return Object.freeze({ prewarmPlacement });
}
