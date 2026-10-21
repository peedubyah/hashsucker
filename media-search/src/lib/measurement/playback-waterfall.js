/**
 * THE CANONICAL PLAYBACK WATERFALL.
 *
 * A playback session crosses three processes, and the question the slice
 * exists to answer is: WHERE DID THE SECONDS GO? "Somewhere between the
 * request and the picture" is not an answer. The waterfall exists so every
 * second is attributable to a named stage, in one ordered list, under one
 * session id.
 *
 * The stages, in the order they must occur:
 *
 *   1  intent_accepted          the server accepted the media intent
 *   2  binding_resolved         the authoritative Binding (TorrentFile) is known
 *   3  playback_object_minted   the playback object (token) exists
 *   4  player_launched          the player process exists
 *   5  first_http               the player's first HTTP request reached the server
 *   6  first_rust_byte_request  the data plane received the byte request
 *   7  provider_request_start   the provider request was dispatched
 *   8  provider_first_byte      the provider's first byte arrived
 *   9  first_byte_to_client     the first byte was delivered to the client
 *  10  player_file_loaded       the player has the media (container read)
 *  11  first_frame              a frame is on screen (progressing)
 *
 * The owners are the processes that hold the time:
 *   - server     the Node service (identity, Binding, token, byte proxy)
 *   - data-plane the Rust data plane (capability, cache, provider bytes)
 *   - client     the player process (mpv) and the measuring client
 *
 * CLOCKS. Each process measures with a MONOTONIC clock — process.hrtime in
 * Node, Instant in Rust — because a wall clock can step backwards and a
 * backwards step in a latency waterfall is a lie. Each process also reports
 * the WALL-CLOCK instant of its own anchor, so the marks from different
 * processes can be placed on one timeline. The cross-process alignment error
 * is then bounded by the difference between the two anchor samples, taken
 * microseconds-to-milliseconds apart on one host.
 *
 * The session id is what ties the processes together. It travels as an HTTP
 * header: the client mints it, the server reads it and forwards it to the
 * data plane, and the data plane records it as the correlation id on its
 * stage report. One id, one timeline, one story.
 */

/** The header that carries the session id across processes. */
export const WATERFALL_SESSION_HEADER = 'x-hs-session';

/** The process that holds the time for a stage. */
export const WATERFALL_OWNER = Object.freeze({
  SERVER: 'server',
  DATA_PLANE: 'data-plane',
  CLIENT: 'client',
});

/**
 * The canonical stage list, in order.
 *
 * `owner` is the process whose work the elapsed time BEFORE this stage is
 * charged to. A gap between stage N and stage N+1 is the work of stage
 * N+1's owner that had not finished when stage N was stamped.
 */
export const WATERFALL_STAGES = Object.freeze([
  { stage: 'intent_accepted', owner: WATERFALL_OWNER.SERVER },
  { stage: 'binding_resolved', owner: WATERFALL_OWNER.SERVER },
  { stage: 'playback_object_minted', owner: WATERFALL_OWNER.SERVER },
  { stage: 'player_launched', owner: WATERFALL_OWNER.CLIENT },
  { stage: 'first_http', owner: WATERFALL_OWNER.SERVER },
  { stage: 'first_rust_byte_request', owner: WATERFALL_OWNER.DATA_PLANE },
  { stage: 'provider_request_start', owner: WATERFALL_OWNER.DATA_PLANE },
  { stage: 'provider_first_byte', owner: WATERFALL_OWNER.DATA_PLANE },
  { stage: 'first_byte_to_client', owner: WATERFALL_OWNER.DATA_PLANE },
  { stage: 'player_file_loaded', owner: WATERFALL_OWNER.CLIENT },
  { stage: 'first_frame', owner: WATERFALL_OWNER.CLIENT },
]);

/** The stage names, in canonical order. */
export const WATERFALL_STAGE_NAMES = Object.freeze(WATERFALL_STAGES.map((s) => s.stage));

/** The owner of each stage, by name. */
const OWNER_BY_STAGE = new Map(WATERFALL_STAGES.map((s) => [s.stage, s.owner]));

/**
 * A gap at or above this size is a BUCKET: a second or more of time in
 * one place. Buckets are what the slice must explain.
 */
export const WATERFALL_BUCKET_MS = 1000;

/**
 * Monotonic milliseconds since an arbitrary origin.
 *
 * process.hrtime is nanoseconds and monotonic. It never steps backwards, so
 * a difference of two readings is always a true elapsed duration.
 */
export function monotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Create a recorder for one process.
 *
 * The recorder measures with the monotonic clock and reports each mark with
 * BOTH its monotonic offset from the recorder's own anchor and the wall-clock
 * instant of that anchor, so marks from several processes can be placed on
 * one timeline.
 *
 * @param {Object} [options]
 * @param {string|null} [options.sessionId] - the cross-process session id
 * @param {number} [options.anchorWallMs] - wall clock at the anchor
 * @returns {{sessionId: string|null, anchorWallMs: number, mark: Function, marks: Array}}
 */
export function createWaterfallRecorder({ sessionId = null, anchorWallMs = Date.now() } = {}) {
  const originMs = monotonicMs();
  const marks = [];
  return {
    sessionId,
    anchorWallMs,
    /**
     * Stamp one stage.
     *
     * @param {string} stage - a stage name from WATERFALL_STAGE_NAMES
     * @param {Object} [fields] - extra JSON-safe fields (never identity)
     */
    mark(stage, fields = {}) {
      const atMs = monotonicMs() - originMs;
      marks.push({ stage, atMs, wallMs: anchorWallMs + atMs, ...fields });
      return marks[marks.length - 1];
    },
    marks,
  };
}

/**
 * Read the session id from an incoming request's headers.
 *
 * @param {Object} headers - a Node IncomingMessage headers object
 * @returns {string|null}
 */
export function readSessionId(headers) {
  const raw = headers?.[WATERFALL_SESSION_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // A session id is a correlation handle, not free text: it is echoed into
  // logs and stage reports, so it is kept to a short, boring shape.
  return /^[A-Za-z0-9._:-]{1,64}$/.test(trimmed) ? trimmed : null;
}

/**
 * Build a session id for a measurement run.
 *
 * @param {string} [prefix]
 * @returns {string}
 */
export function newSessionId(prefix = 'hs') {
  const rand = Math.floor(Math.random() * 0xffffff).toString(36).padStart(5, '0');
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/**
 * Place every process's marks on one timeline and order them.
 *
 * Each source contributes marks measured with ITS OWN monotonic clock plus
 * the wall-clock instant of ITS anchor. The wall instant is the alignment
 * point; the monotonic offsets are the truth within a process.
 *
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {Object[]} params.sources - [{ process, anchorWallMs, marks: [{stage, atMs, ...}] }]
 * @returns {Object} the assembled waterfall
 */
export function assembleWaterfall({ sessionId, sources }) {
  const placed = [];
  for (const source of sources ?? []) {
    const anchor = Number.isFinite(source?.anchorWallMs) ? source.anchorWallMs : null;
    for (const mark of source?.marks ?? []) {
      if (!mark || typeof mark.stage !== 'string') continue;
      const atMs = Number.isFinite(mark.atMs) ? mark.atMs : null;
      placed.push({
        stage: mark.stage,
        process: source.process ?? null,
        owner: OWNER_BY_STAGE.get(mark.stage) ?? null,
        atMs,
        wallMs: anchor != null && atMs != null ? anchor + atMs : (Number.isFinite(mark.wallMs) ? mark.wallMs : null),
        fields: mark.fields ?? null,
      });
    }
  }
  placed.sort((a, b) => (a.wallMs ?? 0) - (b.wallMs ?? 0));

  const stages = placed.map((mark) => ({
    ...mark,
    gapMs: null,
  }));
  for (let i = 1; i < stages.length; i += 1) {
    const prev = stages[i - 1];
    const cur = stages[i];
    if (prev.wallMs == null || cur.wallMs == null) continue;
    cur.gapMs = cur.wallMs - prev.wallMs;
  }

  // A bucket is a second or more between two consecutive stages. Its owner
  // is the process that owned the work in that interval: the process of the
  // LATER stage had not finished when the earlier stage was stamped.
  const buckets = stages
    .filter((s) => s.gapMs != null && s.gapMs >= WATERFALL_BUCKET_MS)
    .map((s, i) => {
      const index = stages.indexOf(s);
      const prev = index > 0 ? stages[index - 1] : null;
      return {
        after: prev?.stage ?? null,
        before: s.stage,
        gapMs: s.gapMs,
        owner: s.owner,
        process: s.process,
      };
    });

  const missing = WATERFALL_STAGE_NAMES.filter((name) => !stages.some((s) => s.stage === name));

  return {
    sessionId,
    stages,
    buckets,
    missingStages: missing,
    totalMs: stages.length >= 2 && stages[0].wallMs != null && stages[stages.length - 1].wallMs != null
      ? stages[stages.length - 1].wallMs - stages[0].wallMs
      : null,
  };
}
