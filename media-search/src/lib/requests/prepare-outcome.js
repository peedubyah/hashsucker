/**
 * One interpretation contract for `/api/media-prepare` and `/api/media-request`
 * results, shared by the anticipation scheduler and upgrade-watch.
 *
 * Both callers previously implemented the same three-check predicate inline
 * (`status !== 200 || prepared !== true || !handoff.torrentFileId`) with their
 * own error string. HTTP 200 is a transport fact, not a preparation fact, so
 * the failure reason must come from the body.
 *
 * This module owns the predicate and the message; it does not own policy
 * (cache-only fulfillment, cold retry, quality gating).
 */

import { describePrepareFailure } from './prepare-failure.js';

/** True when a prepare response proves a durable, bindable handoff. */
export function isPrepared(r) {
  return r?.status === 200
    && r?.json?.prepared === true
    && Boolean(r?.json?.handoff?.torrentFileId);
}

/** True when a publish/request response proves a durable handoff. */
export function isPublished(r) {
  return r?.status === 200 && Boolean(r?.json?.handoff?.torrentFileId);
}

/**
 * Failure for a prepare attempt: `{ error, reason }`.
 * `reason` is a stable machine-readable class, `error` the human/log label.
 */
export function prepareFailure(r) {
  return describePrepareFailure(r);
}

/**
 * Failure for a publish attempt. Reuses the same body-first rule but keeps the
 * `publish-http-<status>` transport label, which no caller has yet needed to
 * decompose.
 */
export function publishFailure(r) {
  if (r?.json?.error) {
    return { error: String(r.json.error).slice(0, 200), reason: 'server-error' };
  }
  return { error: `publish-http-${Number(r?.status) || 0}`, reason: 'http-status' };
}

/**
 * Failure for a quality probe. Probes never persist, so a non-200 is the only
 * interesting outcome and the body error is authoritative when present.
 */
export function probeFailure(r) {
  if (r?.json?.error) {
    return { error: String(r.json.error).slice(0, 200), reason: 'server-error' };
  }
  return { error: `probe-http-${Number(r?.status) || 0}`, reason: 'http-status' };
}
