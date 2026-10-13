/**
 * Describe a failed prepare/publish attempt from the response body.
 *
 * The endpoints return HTTP 200 for many application-level outcomes. The
 * previous label — `prepare-http-200` — discarded everything the body actually
 * said, so a "market has no bindable candidate" row was indistinguishable from
 * "no handoff was built" and from "prepared but no durable TorrentFile".
 *
 * This keeps the old label ONLY for a genuinely unknown shape, and otherwise
 * reports the body's own reason so the parked `last_error` is actionable.
 */

const UNKNOWN = (status) => `prepare-http-${status}`;

/**
 * @param {{status:number, json:any}} r — transport result
 * @returns {{ error:string, reason:string }} `reason` is a stable classification.
 */
export function describePrepareFailure(r) {
  const status = Number(r?.status) || 0;
  const json = r?.json ?? null;

  // Explicit server error is always authoritative.
  if (json?.error) return { error: String(json.error).slice(0, 200), reason: 'server-error' };

  // Transport-level: nothing useful in the body.
  if (status !== 200) return { error: UNKNOWN(status), reason: 'http-status' };

  // The two distinct ways a 200 can be a failure, in the order the caller
  // checks them, so the message matches the condition that actually failed.
  const handoffMissing = !json?.handoff;
  const noTorrentFile = !handoffMissing && !json?.handoff?.torrentFileId;
  const selReason = json?.selection?.reason || json?.reason || null;

  if (json?.prepared === true && noTorrentFile) {
    // Prepared, but nothing durable was bound — the caller cannot publish.
    return {
      error: `prepare:no-torrentfile${selReason ? `:${selReason}` : ''}`,
      reason: 'no-torrentfile',
    };
  }
  if (handoffMissing || json?.prepared !== true) {
    return {
      error: `prepare:no-handoff${selReason ? `:${selReason}` : ''}`,
      reason: 'no-handoff',
    };
  }
  return { error: UNKNOWN(status), reason: 'unknown' };
}
