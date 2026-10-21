/**
 * SESSION-SCOPED MEASUREMENT RECORDS.
 *
 * One playback session spans several HTTP requests: the intent arrives on
 * /api/playback-object, and the player's byte request arrives later on
 * /play/:token (or /bytes/:tfId). The server's marks for the session are
 * therefore measured across requests, and they must share ONE monotonic
 * origin — otherwise "the gap between the token being minted and the
 * player's request arriving" could not be computed.
 *
 * This store owns that origin. It is:
 *   - BOUNDED (a small ring of the most recent sessions),
 *   - MEASUREMENT-ONLY (nothing in the product path reads it),
 *   - CORRELATION-ONLY (a session id names a measurement run; it grants no
 *     authority and is not part of any identity, routing or cache key).
 *
 * The client asks for its session's record over a diagnostic endpoint once
 * the playback is done, and places the server's stages on the same timeline
 * as the player's and the data plane's.
 */

import { monotonicMs } from './playback-waterfall.js';

/** How many sessions are retained. A session lives only for one playback. */
const MAX_SESSIONS = 64;

/** sessionId -> { sessionId, originNs, anchorWallMs, marks } */
const sessions = new Map();

/**
 * Open (or reopen) a session and return its record.
 *
 * Reopening keeps the FIRST anchor: the session's clock starts when the
 * intent was accepted, not when the byte request arrives.
 *
 * @param {string|null} sessionId
 * @returns {Object|null} the session record, or null without a session id
 */
export function openSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const record = {
    sessionId,
    originNs: process.hrtime.bigint(),
    anchorWallMs: Date.now(),
    marks: [],
  };
  sessions.set(sessionId, record);
  // Bounded: the oldest session is dropped when the ring is full.
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
  return record;
}

/**
 * Stamp one stage on a session.
 *
 * The mark's offset is measured from the session's origin, so marks taken in
 * different requests are comparable.
 *
 * FIRST STAMP WINS. A player issues several byte requests for one media
 * (a probe, then ranges), and the canonical waterfall has ONE stage per
 * moment: the first HTTP request, the first byte request, the first byte
 * delivered. A later request of the same kind is not a new stage; it is
 * detail of the same moment.
 *
 * @param {string|null} sessionId
 * @param {string} stage
 * @param {Object} [fields]
 * @returns {Object|null} the mark, or null when the session is unknown
 */
export function markSession(sessionId, stage, fields = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const record = sessions.get(sessionId);
  if (!record) return null;
  if (record.marks.some((m) => m.stage === stage)) return null;
  const atMs = Number((process.hrtime.bigint() - record.originNs) / 1_000_000n);
  const mark = { stage, atMs, wallMs: record.anchorWallMs + atMs, ...fields };
  record.marks.push(mark);
  return mark;
}

/**
 * Read one session's record.
 *
 * @param {string|null} sessionId
 * @returns {Object|null}
 */
export function readSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const record = sessions.get(sessionId);
  if (!record) return null;
  return {
    sessionId: record.sessionId,
    anchorWallMs: record.anchorWallMs,
    marks: record.marks,
  };
}

/** Drop every retained session. Test-only. */
export function clearSessions() {
  sessions.clear();
}
