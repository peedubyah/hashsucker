/**
 * Plex library-ingest observation.
 *
 * PMS exposes a structured activity object for library scans, which is the only
 * observable signal stronger than "we asked". It proves scanStarted and
 * scanCompleted for a section, with a stable uuid:
 *
 *   GET /activities → Activity[{ type: "library.update.section",
 *                                  title: "Scanning <Section>",
 *                                  uuid, progress, Context: { librarySectionID } }]
 *
 * Proven characteristics (measured against PMS 1.43.3, 2026-10-12):
 *
 *   - Requesting `GET /library/sections/<id>/refresh?path=<dir>` returns HTTP 200
 *     with an EMPTY body in ~1 ms and merely QUEUES work. It proves nothing.
 *   - PMS validates nothing: a nonexistent path also returns 200, then logs
 *     `Failed to create parent iterator` and `Marking media not available`.
 *     A silent, permanent library-damage trap. Never treat 200 as success.
 *   - The activity appears within ~10 ms of the request and disappears when the
 *     scan phase ends. Observed 6/6 reliable across distinct targets.
 *   - `progress` stays 0 for the whole scan — it carries no information.
 *   - `Context` carries ONLY `librarySectionID`. There is no path correlation,
 *     so the object cannot prove the requested path was scanned.
 *   - Duplicate refreshes do NOT coalesce: each spawns a fresh activity uuid.
 *   - The `path=` parameter restrains the walk: from quiescence, a season dir
 *     or a single file both make PMS process exactly ONE directory; a show dir
 *     processes two. (Observed full-section walks only when another scan was
 *     already running concurrently.)
 *   - After the activity disappears, PMS spawns a SEPARATE
 *     `Plex Media Scanner --analyze --item <ids>` subprocess that opens the file
 *     with FFMPEG and commits duration/size/hash. The activity object does NOT
 *     cover that phase.
 *   - `/library/changestamp` is NOT a completion signal: it increments once per
 *     second with zero library activity (it behaves like a clock).
 *
 * Therefore this module proves only: a section scan was started and the scan
 * PHASE completed. Result correlation (ratingKey / Part / exact file) stays with
 * the caller, e.g. `confirmPlexEpisode`, which queries PMS metadata directly.
 */
const PLEX_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 150;
const DEFAULT_DRAIN_MS = 5_000;

export const SCAN_ACTIVITY_TYPES = Object.freeze([
  'library.update.section',
]);

export const INGEST_ERRORS = Object.freeze({
  SCAN_NOT_STARTED: 'INGEST_SCAN_NOT_STARTED',
  SCAN_NOT_COMPLETED: 'INGEST_SCAN_NOT_COMPLETED',
  REFRESH_REJECTED: 'INGEST_REFRESH_REJECTED',
});

export function ingestError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function isPlexEnabled(env = process.env) {
  return Boolean(env.PLEX_URL && env.PLEX_TOKEN);
}

/** Section id for a media type, from the existing environment contract. */
export function sectionIdFor(mediaType, env = process.env) {
  if (mediaType === 'movie') return env.PLEX_MOVIES_SECTION_ID || null;
  if (mediaType === 'series' || mediaType === 'tv' || mediaType === 'episode') return env.PLEX_TV_SECTION_ID || null;
  return null;
}

/** Single convention everywhere: `fetchFn(url, options)` → { ok, status, json() }. */
async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeoutMs || PLEX_TIMEOUT_MS),
  });
  if (!response.ok) throw ingestError(INGEST_ERRORS.REFRESH_REJECTED, `PMS returned ${response.status}`);
  return response.json();
}

/** Current library-scan activities, empty when PMS is not scanning. */
export async function activeScans({ plexUrl, plexToken, fetchFn = fetchJson } = {}) {
  const data = await fetchFn(`${plexUrl}/activities`, { headers: { 'X-Plex-Token': plexToken } });
  return (data?.MediaContainer?.Activity ?? []).filter((a) => SCAN_ACTIVITY_TYPES.includes(a.type));
}

/** True when no library scan is running. */
export async function isScanQuiet({ plexUrl, plexToken, fetchFn } = {}) {
  return (await activeScans({ plexUrl, plexToken, fetchFn })).length === 0;
}

/**
 * Queue a targeted section refresh for `path`. Returns the HTTP status; the body
 * is empty and meaningless, so callers MUST observe the activity to learn
 * anything real.
 */
export async function requestSectionRefresh({ plexUrl, plexToken, sectionId, path, fetchFn = fetch } = {}) {
  if (!sectionId) throw ingestError(INGEST_ERRORS.REFRESH_REJECTED, 'no section id for this media type');
  if (!path) throw ingestError(INGEST_ERRORS.REFRESH_REJECTED, 'a scan path is required');
  const url = `${plexUrl}/library/sections/${sectionId}/refresh?path=${encodeURIComponent(path)}`;
  const response = await fetchFn(url, { method: 'GET', headers: { 'X-Plex-Token': plexToken } });
  if (!response.ok) throw ingestError(INGEST_ERRORS.REFRESH_REJECTED, `PMS refresh returned ${response.status}`);
  return { status: response.status };
}

/**
 * Observe the scan that follows a refresh.
 *
 * Returns `{ started, uuid, completed, elapsedMs }`:
 *   - `started` — a library.update.section activity was observed
 *   - `uuid`    — that activity's id (note: no path correlation exists)
 *   - `completed` — the activity disappeared, i.e. the scan PHASE finished
 *   - `elapsedMs` — accept → activity gone
 *
 * Throws INGEST_SCAN_NOT_STARTED / INGEST_SCAN_NOT_COMPLETED. It deliberately
 * does NOT claim media analysis completed — PMS runs that in a separate
 * subprocess this endpoint does not describe.
 */
export async function observeScan({
  plexUrl,
  plexToken,
  sectionId = null,
  path = null,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = 120_000,
  fetchFn = fetchJson,
  requestFn = requestSectionRefresh,
} = {}) {
  const t0 = Date.now();
  await requestFn({ plexUrl, plexToken, sectionId, path });

  const seen = [];
  let started = false;
  let uuid = null;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const acts = await activeScans({ plexUrl, plexToken, fetchFn });
    if (acts.length) {
      if (!started) {
        started = true;
        uuid = acts[0].uuid ?? null;
        seen.push({ at: Date.now() - t0, uuid });
      }
    } else if (started) {
      return { started: true, uuid, completed: true, elapsedMs: Date.now() - t0 };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!started) throw ingestError(INGEST_ERRORS.SCAN_NOT_STARTED, 'no library.update.section activity appeared after refresh');
  throw ingestError(INGEST_ERRORS.SCAN_NOT_COMPLETED, `scan activity still running after ${timeoutMs}ms`);
}

/**
 * Wait until PMS is not scanning. Used as a pre-flight guard so a caller never
 * queues an ingest into the middle of an unrelated scan, where the walk is not
 * confined to the requested subdir.
 */
export async function waitForScanQuiet({ plexUrl, plexToken, timeoutMs = DEFAULT_DRAIN_MS, pollMs = DEFAULT_POLL_MS, fetchFn } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await isScanQuiet({ plexUrl, plexToken, fetchFn })) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}
