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
import pathPosix from 'node:path';

const PLEX_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 150;
const DEFAULT_DRAIN_MS = 5_000;

export const SCAN_ACTIVITY_TYPES = Object.freeze([
  'library.update.section',
]);

export const INGEST_ERRORS = Object.freeze({
  // Local, pre-PMS. A bad path fails here and is never sent to PMS.
  INVALID_PATH: 'INGEST_INVALID_PATH',
  PATH_NOT_FOUND: 'INGEST_PATH_NOT_FOUND',
  // Transport / PMS.
  REFRESH_REJECTED: 'INGEST_REFRESH_REJECTED',
  SCAN_NOT_STARTED: 'INGEST_SCAN_NOT_STARTED',
  SCAN_NOT_COMPLETED: 'INGEST_SCAN_NOT_COMPLETED',
  // Resulting item.
  ITEM_NOT_FOUND: 'INGEST_ITEM_NOT_FOUND',
  WRONG_PART_PATH: 'INGEST_WRONG_PART_PATH',
  WRONG_PART_SIZE: 'INGEST_WRONG_PART_SIZE',
  NOT_PLAYBACK_READY: 'INGEST_NOT_PLAYBACK_READY',
  // Concurrency.
  SCAN_BUSY: 'INGEST_SCAN_BUSY',
});

export function ingestError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function isPlexEnabled(env = process.env) {
  return Boolean(env.PLEX_URL && env.PLEX_TOKEN);
}

/**
 * Section id for a media type.
 *
 * The accepted values are `'movie'` and `'series'` only — that is the contract
 * enforced by `playback-handoff.js` and consumed by `plex-notifier.js`. `'episode'`
 * is NOT a mediaType for this purpose: it is a coordinate qualifier
 * (season+episode) on a series. Passing `'episode'` here yields null.
 */
export function sectionIdFor(mediaType, env = process.env) {
  if (mediaType === 'movie') return env.PLEX_MOVIES_SECTION_ID || null;
  if (mediaType === 'series') return env.PLEX_TV_SECTION_ID || null;
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

/* ── Path validation (invalid-path guard) ──────────────────────────────────── */

const SEASON_DIR_RE = /^Season \d{1,4}$/;
const VFS_WEBDAV_PREFIX = 'vfs/';
const MOVIE_ROOT_RE = /^\/mnt\/hashsucker-vfs\/(Movies|TV)$/;

/**
 * Validate a refresh target locally, before anything is sent to PMS.
 *
 * PMS accepts ANY path with HTTP 200 — including one that does not exist — and
 * then logs `Failed to create parent iterator` and **`Marking media not
 * available`**, i.e. it silently takes real media out of service. So the path
 * must be proven safe locally first, and a bad path must fail here.
 *
 * Predicates, all required:
 *   1. canonical path is relative, has no traversal, and is inside the
 *      configured section root (no alias / escape);
 *   2. the derived scan path sits directly under a section root;
 *   3. it is a season directory (series) or the item's own directory (movie);
 *   4. the path is visible through HashSucker's own VFS view.
 *
 * Returns `{ ok: true, scanPath, vfsUrl }`, or throws with INGEST_INVALID_PATH /
 * INGEST_PATH_NOT_FOUND.
 */
export function validateRefreshPath({ mediaType, canonicalPath, sectionRoot, vfsBaseUrl, collection = null } = {}) {
  if (!canonicalPath || typeof canonicalPath !== 'string') {
    throw ingestError(INGEST_ERRORS.INVALID_PATH, 'canonicalPath is required');
  }
  if (!sectionRoot || typeof sectionRoot !== 'string') {
    throw ingestError(INGEST_ERRORS.INVALID_PATH, 'sectionRoot is required');
  }
  const root = sectionRoot.replace(/\/+$/, '');
  const segments = canonicalPath.split('/');
  if (pathPosix.isAbsolute(canonicalPath)) {
    throw ingestError(INGEST_ERRORS.INVALID_PATH, 'canonicalPath must be relative to the section root');
  }
  if (segments.some((s) => !s || s === '.' || s === '..')) {
    throw ingestError(INGEST_ERRORS.INVALID_PATH, 'canonicalPath contains an empty or traversal segment');
  }
  if (segments.length < 3) {
    throw ingestError(INGEST_ERRORS.INVALID_PATH, `canonicalPath is too shallow: ${canonicalPath}`);
  }
  // Strip the collection segment (e.g. "TV") and the filename, leaving
  // <show>/Season NN — the narrowest correct scan target.
  const inner = segments.slice(1, -1);
  if (inner.some((s) => !s || s === '.' || s === '..')) {
    throw ingestError(INGEST_ERRORS.INVALID_PATH, 'derived scan directory contains an empty or traversal segment');
  }
  const scanPath = `${root}/${inner.join('/')}`;
  if (!scanPath.startsWith(`${root}/`) || scanPath.includes('..')) {
    throw ingestError(INGEST_ERRORS.INVALID_PATH, 'derived scan path escapes the section root');
  }
  if (mediaType === 'series' && !SEASON_DIR_RE.test(inner[inner.length - 1] || '')) {
    throw ingestError(INGEST_ERRORS.INVALID_PATH, `series scan target must be a "Season NN" directory, got ${inner[inner.length - 1]}`);
  }
  const vfsRelative = `${collection && collection !== '' ? `${collection}/` : ''}${inner.join('/')}`;
  const vfsUrl = vfsBaseUrl ? `${vfsBaseUrl.replace(/\/+$/, '')}/${VFS_WEBDAV_PREFIX}${encodeSegmentPath(vfsRelative)}/` : null;
  return { ok: true, scanPath, vfsRelative, vfsUrl, sectionRoot: root };
}

/** Encode each path segment without encoding the separators. */
function encodeSegmentPath(p) {
  return p.split('/').map((s) => encodeURIComponent(s)).join('/');
}

/** Confirm the directory is visible through HashSucker's own VFS. */
export async function vfsDirectoryExists(vfsUrl, { timeoutMs = 10_000, fetchFn = fetch } = {}) {
  if (!vfsUrl) throw ingestError(INGEST_ERRORS.PATH_NOT_FOUND, 'no vfsBaseUrl configured to verify the path');
  try {
    const response = await fetchFn(vfsUrl, { method: 'PROPFIND', headers: { Depth: '1' }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 207) return true;
    if (response.status === 404) return false;
    throw ingestError(INGEST_ERRORS.PATH_NOT_FOUND, `VFS returned ${response.status} for ${vfsUrl}`);
  } catch (err) {
    if (err instanceof Error && err.code === INGEST_ERRORS.PATH_NOT_FOUND) throw err;
    throw ingestError(INGEST_ERRORS.PATH_NOT_FOUND, `VFS check failed: ${err?.message || err}`);
  }
}

/* ── Single-flight observation ─────────────────────────────────────────────── */

/**
 * Because the activity object carries no path, an observed
 * `library.update.section` is only attributable to a specific request when it is
 * the only outstanding one for that section. This enforces that invariant and
 * refuses, rather than guessing.
 *
 * Per-section is the correct level: PMS serialises scans per section, and the
 * activity reports the section. Per-path single-flight would be unsound because
 * a second path's scan would still produce a section activity we could not
 * distinguish from ours.
 */
export function createIngestFlight() {
  const inFlight = new Map(); // sectionId -> { path, startedAt, promise }
  const queued = [];

  const runExclusive = async (sectionId, path, fn) => {
    const existing = inFlight.get(sectionId);
    if (existing) {
      if (existing.path === path) {
        throw ingestError(INGEST_ERRORS.SCAN_BUSY, `an ingest is already running for section ${sectionId} path ${path}`);
      }
      throw ingestError(INGEST_ERRORS.SCAN_BUSY, `section ${sectionId} is scanning ${existing.path}; refusing to start ${path} (no path correlation exists)`);
    }
    const entry = { path, startedAt: Date.now(), promise: null };
    entry.promise = (async () => {
      try {
        return await fn();
      } finally {
        inFlight.delete(sectionId);
        const next = queued.shift();
        if (next) next();
      }
    })();
    inFlight.set(sectionId, entry);
    return entry.promise;
  };

  return {
    runExclusive,
    get busy() { return Object.fromEntries([...inFlight].map(([k, v]) => [k, v.path])); },
    get size() { return inFlight.size; },
  };
}

/* ── Full transaction ──────────────────────────────────────────────────────── */

/**
 * The complete, bounded ingest transaction:
 *
 *   validatePath → waitForScanQuiet → requestSectionRefresh → observeScanStart
 *   → observeScanEnd → waitForResultingItem
 *
 * Every stage has its own failure class so a caller can tell an invalid local
 * path from a PMS rejection from a scan that never ran from a scan that hung
 * from a missing item from an item with the wrong Part or size.
 *
 * Item-readiness predicate: ratingKey + Part id + exact `MediaPart.file` +
 * exact `Part.size`. Duration is NOT required, because for direct play PMS
 * resolves the source and creates a session from the Part, and HashSucker
 * already holds the authoritative size — but size is required because a Part
 * with no size means media analysis never committed it and the item is not yet
 * durable in PMS.
 */
export async function requestLibraryIngest({
  // section + path
  mediaType,
  canonicalPath,
  sectionRoot,
  vfsBaseUrl,
  collection = null,
  sectionIdOverride = null,
  // pms
  plexUrl,
  plexToken,
  // expected result (for verification)
  verify = null, // { mediaId, season, episode, expectedPartFile, expectedSize }
  // result lookup
  findResult = null, // async () => { ratingKey, partId, file, size, duration }
  // bounds
  flight = null,
  timeoutMs = 300_000,
  pollMs = 250,
  fetchFn,
  // injectable seams (tests / diagnostics); default to the real ones
  vfsExistsFn = vfsDirectoryExists,
  quietFn = waitForScanQuiet,
  observeFn = observeScan,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  // 1. validate locally; a bad path must never reach PMS
  const plan = validateRefreshPath({ mediaType, canonicalPath, sectionRoot, vfsBaseUrl, collection });
  const exists = await vfsExistsFn(plan.vfsUrl, { timeoutMs: Math.min(10_000, Math.max(1000, remaining())), fetchFn });
  if (!exists) {
    throw ingestError(INGEST_ERRORS.PATH_NOT_FOUND, `scan path is not visible through the VFS: ${plan.scanPath}`);
  }

  const sectionId = sectionIdOverride || sectionIdFor(mediaType);
  if (!sectionId) {
    throw ingestError(INGEST_ERRORS.REFRESH_REJECTED, `no Plex section id for mediaType ${mediaType}`);
  }

  const run = async () => {
    // 2. quiesce so the activity we observe is attributable to this request
    const quiet = await quietFn({ plexUrl, plexToken, timeoutMs: Math.min(120_000, remaining()), pollMs, fetchFn });
    if (!quiet) throw ingestError(INGEST_ERRORS.SCAN_BUSY, `PMS was still scanning before the ingest could start (section ${sectionId})`);

    // 3. request + observe the scan phase
    const scan = await observeFn({ plexUrl, plexToken, sectionId, path: plan.scanPath, pollMs, timeoutMs: Math.max(1000, remaining()), fetchFn });
    const tScan = Date.now();

    // 4/5. resulting item, verified
    if (!findResult) return { plan, scan, item: null };
    let item = null;
    const itemDeadline = Date.now() + Math.min(120_000, remaining());
    while (Date.now() < itemDeadline) {
      const found = await findResult();
      if (found && found.partId && found.file) {
        const kind = classifyResultingItem(found, verify);
        if (kind) throw ingestError(kind.code, kind.message);
        item = { ...found, verifiedAt: Date.now() };
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (!item) {
      throw ingestError(INGEST_ERRORS.ITEM_NOT_FOUND, `no Plex item with a Part appeared for ${verify?.mediaId || plan.scanPath} after the scan`);
    }
    return { plan, scan, item, scanToItemMs: (item.verifiedAt ?? itemDeadline) - tScan };
  };

  if (flight) return flight.runExclusive(sectionId, plan.scanPath, run);
  return run();
}

/** Maps a resulting item to a failure class, or null when it is correct. */
export function classifyResultingItem(found, verify) {
  if (!verify) return null;
  if (verify.expectedPartFile && found.file !== verify.expectedPartFile) {
    return {
      code: INGEST_ERRORS.WRONG_PART_PATH,
      message: `Plex Part path does not match the publication: ${found.file} !== ${verify.expectedPartFile}`,
    };
  }
  if (verify.expectedSize != null) {
    if (found.size == null) {
      return { code: INGEST_ERRORS.NOT_PLAYBACK_READY, message: 'Plex Part has no size yet (media analysis has not committed it)' };
    }
    if (Number(found.size) !== Number(verify.expectedSize)) {
      return {
        code: INGEST_ERRORS.WRONG_PART_SIZE,
        message: `Plex Part size does not match the publication: ${found.size} !== ${verify.expectedSize}`,
      };
    }
  }
  // Explicit playback-readiness floor, separate from identity: without an id
  // for the Part there is nothing for a session to attach to.
  if (!found.partId) {
    return { code: INGEST_ERRORS.NOT_PLAYBACK_READY, message: 'Plex item has no Part id (not playback-ready)' };
  }
  return null;
}
