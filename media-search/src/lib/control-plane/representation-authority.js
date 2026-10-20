/**
 * REPRESENTATION AUTHORITY — who may choose the TorrentFile.
 *
 * Two policy domains live in this system, and they were not separated:
 *
 *   ROUTE policy answers "how may these bytes be reached?" — which
 *   placement, which provider file, is the route dead, is another route
 *   known. It operates INSIDE one exact TorrentFile.
 *
 *   REPRESENTATION policy answers "which TorrentFile represents this
 *   media intent?" — the ranking's choice, a quality upgrade, an
 *   identity correction, the delivery-exhaustion fallback, an operator's
 *   explicit request.
 *
 * The leak this closes: a ROUTE-level mechanism (the routine
 * reconciler's rebind, the provider's "current file", a rediscovery)
 * could activate a Binding for a DIFFERENT TorrentFile. That is a
 * representation decision made by a route mechanism, and it moved the
 * bytes a published item served.
 *
 * THE RULE
 *
 *   A Binding may name a different TorrentFile than the Binding it
 *   replaces ONLY with an explicit representation reason, and only one of
 *   the reasons below exists.
 *
 * A route-scoped caller has no reason to give: it may not change the
 * representation at all. That is enforced at the one place a Binding is
 * written (`activateBinding`), so the rule cannot be bypassed by adding a
 * new caller.
 */

/** The legal reasons a Binding may name a different TorrentFile. */
export const REPRESENTATION_CHANGE_REASONS = Object.freeze({
  /** The first Binding for a media intent: the request's selection. */
  INITIAL_SELECTION: 'initial-selection',
  /** A quality/upgrade policy chose a better representation. */
  QUALITY_UPGRADE: 'quality-upgrade',
  /** The bound representation was proven invalid and is replaced. */
  REJECTION_SUPERSEDE: 'rejection-supersede',
  /** The authoritative representation's routes are exhausted and the
   *  representation policy authorized the persisted candidate. */
  DELIVERY_EXHAUSTION_FALLBACK: 'delivery-exhaustion-fallback',
  /** An operator or an explicit user request chose it. */
  MANUAL_OVERRIDE: 'manual-override',
});

/** Who owns each reason. The owner is the only legitimate source. */
export const REPRESENTATION_CHANGE_OWNERS = Object.freeze({
  [REPRESENTATION_CHANGE_REASONS.INITIAL_SELECTION]: 'request-selection',
  [REPRESENTATION_CHANGE_REASONS.QUALITY_UPGRADE]: 'upgrade-policy',
  [REPRESENTATION_CHANGE_REASONS.REJECTION_SUPERSEDE]: 'publication-policy',
  [REPRESENTATION_CHANGE_REASONS.DELIVERY_EXHAUSTION_FALLBACK]: 'representation-policy',
  [REPRESENTATION_CHANGE_REASONS.MANUAL_OVERRIDE]: 'operator',
});

/** The reasons a ROUTE-scoped mechanism may never use. */
export const ROUTE_SCOPED_REASONS = Object.freeze([]);

/**
 * May this caller change the representation?
 *
 * @param {Object} params
 * @param {string|null} params.currentTorrentFileId - the active Binding's TorrentFile
 * @param {string|null} params.nextTorrentFileId - the TorrentFile being activated
 * @param {string|null} params.reason - the claimed representation reason
 * @param {string} [params.caller] - for the error message
 * @returns {{changed: boolean, reason: string|null}}
 * @throws {Error} when the representation would change without a legal reason
 */
export function assertRepresentationChangeAllowed({
  currentTorrentFileId = null,
  nextTorrentFileId = null,
  reason = null,
  caller = 'unknown',
} = {}) {
  const changed = Boolean(currentTorrentFileId)
    && Boolean(nextTorrentFileId)
    && currentTorrentFileId !== nextTorrentFileId;
  if (!changed) return { changed: false, reason: reason ?? null };
  if (!reason || !Object.hasOwn(REPRESENTATION_CHANGE_OWNERS, reason)) {
    const legal = Object.keys(REPRESENTATION_CHANGE_REASONS).join(', ');
    throw new Error(
      `Representation change refused (${caller}): `
      + `${currentTorrentFileId} -> ${nextTorrentFileId} has no representation reason. `
      + `Legal reasons: ${legal}. A route-scoped mechanism may not choose a representation.`,
    );
  }
  return { changed: true, reason };
}

/**
 * The reason a handoff carries, or null when it does not claim one.
 */
export function representationReasonOf(handoff) {
  const reason = typeof handoff?.representationReason === 'string'
    ? handoff.representationReason.trim()
    : '';
  if (!reason) return null;
  if (!Object.hasOwn(REPRESENTATION_CHANGE_OWNERS, reason)) return null;
  return reason;
}
