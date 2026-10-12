#!/usr/bin/env node
/**
 * Plex HTPC production playback canary (hybrid native/app).
 *
 * Control surface, in order of preference:
 *   1. libmpv native IPC socket — position, duration, pause state, seek execution
 *   2. PMS session API — session existence, identity, viewOffset progression
 *   3. HashSucker data-plane metrics — exact TorrentFile byte attribution
 *
 * The Plex application layer is driven for exactly two operations, because only
 * those configure real Plex playback state:
 *
 *   - `loadfile` on the mpv socket starts decoding bytes but does not create a
 *     PMS playback session, so it cannot stand in for app-level start.
 *   - raw mpv `stop` unloads the file without notifying the application layer,
 *     so the PMS session survives; teardown must be app-level.
 *
 * Both facts were verified against this client build; see
 * src/PRODUCTION-PLAYBACK-TESTING.md.
 *
 * Acceptance-only: never restarts PMS, mutates publication/binding/VFS state,
 * or repairs product state.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { APP_ERRORS, connectPlexApp } from '../lib/plex-htpc/plex-app.js';
import { MPV_ERRORS, connectMpvIpc } from '../lib/plex-htpc/mpv-ipc.js';

const repo = '/home/patrick/src/hashsucker';
const canonicalCommand = 'cd /home/patrick/src/hashsucker/media-search && npm run test:production-canary';
if (existsSync('/.dockerenv') || existsSync('/run/.dockerenv')) {
  console.error(`CANARY_INFRA_FAILURE: production HTPC canary must run in the host namespace; run: ${canonicalCommand}`);
  process.exit(2);
}

const PLEX_URL = (process.env.PLEX_URL || '').replace(/\/$/, '');
const PLEX_TOKEN = process.env.PLEX_TOKEN || '';
const PLEX_USERDATA_DIR = process.env.PLEX_STORAGE_INI_DIR
  || process.env.PLEX_USERDATA_DIR
  || '/home/patrick/.local/share/hashsucker-playback-canary/plex';
const PLEX_HTPC_EXE = '/opt/plex-htpc/bin/Plex';
const PLEX_CLIENT_ID = '1iu21f4816xfz8urti7gfc9r';
const MPV_SOCK = process.env.HS_MPV_IPC_SOCK || '/tmp/hs-mpv-ipc.sock';
const CDP_URL = process.env.HS_PLEX_CDP_URL || 'http://127.0.0.1:9222';
const DATA_PLANE_CONTAINER = process.env.HS_DATA_PLANE_CONTAINER || 'hashsucker-data-plane-1';
const CANARY_SERVICE = 'hashsucker-plex-canary.service';
const DEFAULT_PLAN = ['e01', 'e05', 'e08', 'mobland'];
const CHUNK = 67108864; // data-plane read chunk size; matches the delivery path
const timeoutMs = Number(process.env.HASHSUCKER_CANARY_TIMEOUT_MS || 90000);

export const FIXTURES = {
  e01: { label: 'Lanterns S01E01', ratingKey: '497', part: '1042', tf: 'tf_426aa723-3dfc-427a-8cc2-3871f231ff6c', path: '/mnt/hashsucker-vfs/TV/tt26545992/Season 01/tt26545992 - S01E01.mkv', server: '1c622b259a95aebb46228e9661409b7656539c53', grandparent: '495', parent: '496' },
  e05: { label: 'Lanterns S01E05', ratingKey: '514', part: '1061', tf: 'tf_1355e37f-143d-4703-8a53-23827089afbe', path: '/mnt/hashsucker-vfs/TV/tt26545992/Season 01/tt26545992 - S01E05.mp4', server: '1c622b259a95aebb46228e9661409b7656539c53', grandparent: '495', parent: '496' },
  e08: { label: 'Lanterns S01E08', ratingKey: '520', part: '1067', tf: 'tf_8eb97c57-b426-4a69-b082-3109a31745bd', path: '/mnt/hashsucker-vfs/TV/tt26545992/Season 01/tt26545992 - S01E08.mp4', server: '1c622b259a95aebb46228e9661409b7656539c53', grandparent: '495', parent: '496' },
  mobland: { label: 'MobLand S02E02', ratingKey: '512', part: '1057', tf: 'tf_8d9d4437-03e9-440b-8b80-db36f9dd22af', path: '/mnt/hashsucker-vfs/TV/MobLand/Season 02/MobLand - S02E02.mkv', server: '1c622b259a95aebb46228e9661409b7656539c53', grandparent: '509', parent: '510' },
  e04: { label: 'MobLand S02E04', ratingKey: '534', part: '1085', tf: 'tf_ca408d82-ffa6-442e-88ef-19c72e35ae02', path: '/mnt/hashsucker-vfs/TV/tt31510819/Season 02/tt31510819 - S02E04.mkv', server: '1c622b259a95aebb46228e9661409b7656539c53', grandparent: '509', parent: '510' },
};

export const CANARY_FAILURE_CLASSES = [
  'PREFLIGHT', 'EVIDENCE_UNAVAILABLE', 'STALE_SESSION',
  'MPV_IPC_UNAVAILABLE', 'MPV_IPC_NOT_PLEX', 'MPV_IPC_DISCONNECTED', 'MPV_IPC_COMMAND_FAILED',
  'APP_BRIDGE_UNAVAILABLE', 'APP_START_FAILED', 'APP_STOP_FAILED',
  'PMS_SESSION_NOT_CREATED', 'PLEX_IDENTITY_MISMATCH', 'MPV_IDENTITY_MISMATCH',
  'PLAYBACK_START_TIMEOUT', 'NO_POST_SESSION_READ', 'NO_PROGRESSION', 'BYTE_CORRELATION',
  'SEEK_FORWARD', 'SEEK_BACKWARD', 'SEEK_NEAR_EOF',
  'CLEAN_STOP', 'PMS_TEARDOWN_FAILED', 'TIMEOUT', 'UNKNOWN_WITH_SNAPSHOT',
];

const CLASSIFY = {
  CANARY_INFRA_FAILURE: 'PREFLIGHT',
  CANARY_EVIDENCE_UNAVAILABLE: 'EVIDENCE_UNAVAILABLE',
  STALE_SESSION_BEFORE_START: 'STALE_SESSION',
  [MPV_ERRORS.UNAVAILABLE]: 'MPV_IPC_UNAVAILABLE',
  [MPV_ERRORS.NOT_PLEX]: 'MPV_IPC_NOT_PLEX',
  [MPV_ERRORS.DISCONNECTED]: 'MPV_IPC_DISCONNECTED',
  [MPV_ERRORS.COMMAND_FAILED]: 'MPV_IPC_COMMAND_FAILED',
  [APP_ERRORS.CDP_UNAVAILABLE]: 'APP_BRIDGE_UNAVAILABLE',
  [APP_ERRORS.PAGE_EXCEPTION]: 'APP_BRIDGE_UNAVAILABLE',
  [APP_ERRORS.REGISTRY_UNAVAILABLE]: 'APP_BRIDGE_UNAVAILABLE',
  [APP_ERRORS.START_FAILED]: 'APP_START_FAILED',
  [APP_ERRORS.STOP_FAILED]: 'APP_STOP_FAILED',
  PMS_SESSION_NOT_CREATED: 'PMS_SESSION_NOT_CREATED',
  PLEX_IDENTITY_MISMATCH: 'PLEX_IDENTITY_MISMATCH',
  MPV_IDENTITY_MISMATCH: 'MPV_IDENTITY_MISMATCH',
  PLAYBACK_START_TIMEOUT: 'PLAYBACK_START_TIMEOUT',
  NO_POST_SESSION_READ: 'NO_POST_SESSION_READ',
  NO_PROGRESSION: 'NO_PROGRESSION',
  BYTE_CORRELATION_FAILURE: 'BYTE_CORRELATION',
  SEEK_FORWARD_FAILED: 'SEEK_FORWARD',
  SEEK_BACKWARD_FAILED: 'SEEK_BACKWARD',
  SEEK_NEAR_EOF_FAILED: 'SEEK_NEAR_EOF',
  APP_STOP_FAILED: 'CLEAN_STOP',
  PMS_TEARDOWN_FAILED: 'PMS_TEARDOWN_FAILED',
  CANARY_TIMEOUT: 'TIMEOUT',
};

export function classify(err) {
  return CLASSIFY[err?.code] || 'UNKNOWN_WITH_SNAPSHOT';
}

export function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * Canary evidence contains resolved Plex media URLs and client error messages,
 * both of which embed `X-Plex-Token`. Redact before anything is printed; Plex
 * tokens are runtime secrets and must never reach logs or transcripts.
 */
const SECRET_PATTERNS = [
  [/(X-Plex-Token|X-Plex-Client-Token|token|access_token|api[_-]?key)(\s*[=:]\s*)[^&"\s,;}]+/gi, '$1$2<redacted>'],
];
export function redactSecrets(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = redactSecrets(val);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ utilities */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', timeout: opts.timeout || 120000, ...opts });

async function waitFor(fn, timeout, label, code) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= until) throw fail(code || 'CANARY_TIMEOUT', `${label} did not occur within ${timeout}ms`);
    await sleep(250);
  }
}

/* ------------------------------------------- Plex user-data mpv.conf wiring */

/**
 * Deterministically enable the client's libmpv IPC socket through the
 * Plex-specific user-data config (never machine-wide ~/.config/mpv). Idempotent
 * upsert of the one option line so unrelated tuning is preserved.
 */
export function ensureMpvConfig({ userDataDir = PLEX_USERDATA_DIR, socketPath = MPV_SOCK } = {}) {
  const file = `${userDataDir}/mpv.conf`;
  const header = [
    '# HashSucker canary: expose this Plex HTPC client libmpv JSON control socket.',
    '# The socket is the player truth source for the playback canary; it is not a',
    '# general mpv configuration and is specific to this Plex user-data directory.',
  ].join('\n');
  const line = `input-ipc-server=${socketPath}`;
  mkdirSync(userDataDir, { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  // drop a previous canary header so re-running cannot accumulate duplicates
  let body = existing.replace(/^# HashSucker canary:.*(?:\n# .*)*\n/m, '');
  body = body.replace(/^input-ipc-server=.*\n?/gm, '');
  if (body && !body.endsWith('\n')) body += '\n';
  writeFileSync(file, `${header}\n${line}\n${body}`, { mode: 0o600 });
  return file;
}

/* --------------------------------------------------- PMS session (evidence) */

async function plexSessions() {
  if (!PLEX_URL || !PLEX_TOKEN) throw fail('CANARY_INFRA_FAILURE', 'PLEX_URL/PLEX_TOKEN are not in the canary environment');
  const res = await fetch(`${PLEX_URL}/status/sessions`, {
    headers: { 'X-Plex-Token': PLEX_TOKEN, Accept: 'application/json' },
  });
  if (!res.ok) throw fail('CANARY_INFRA_FAILURE', `PMS /status/sessions returned ${res.status}`);
  return (await res.json()).MediaContainer?.Metadata || [];
}

const sessionFor = async (ratingKey) => (await plexSessions()).find((s) => String(s.ratingKey) === String(ratingKey));

/* ----------------------------------------- HashSucker data-plane (evidence) */

/**
 * One long-lived `docker exec` shell for the whole run. The previous canary
 * spawned a fresh `docker exec` for every metrics poll, several times a second
 * inside seek loops.
 */
export function createDataPlaneReader({ container = DATA_PLANE_CONTAINER } = {}) {
  const child = spawn('docker', ['exec', '-i', container, 'sh'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n__HS__\n')) !== -1) {
      const body = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 8);
      const waiter = waiters.shift();
      if (waiter) waiter(body);
    }
  });
  child.on('exit', (code) => {
    for (const waiter of waiters) waiter(`__HS_ERROR__ exit=${code}`);
    waiters.length = 0;
  });
  let requests = 0;
  return {
    get requests() { return requests; },
    async events() {
      if (child.exitCode != null) throw fail('CANARY_EVIDENCE_UNAVAILABLE', 'data-plane reader has exited');
      requests += 1;
      const body = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(fail('CANARY_EVIDENCE_UNAVAILABLE', 'data-plane metrics poll timed out')), 45000);
        waiters.push((b) => { clearTimeout(timer); resolve(b); });
        child.stdin.write("wget -qO- http://127.0.0.1:3001/metrics; echo; echo __HS__\n");
      });
      if (body.startsWith('__HS_ERROR__')) throw fail('CANARY_EVIDENCE_UNAVAILABLE', body);
      let json;
      try {
        json = JSON.parse(body);
      } catch (err) {
        throw fail('CANARY_EVIDENCE_UNAVAILABLE', `data-plane metrics is not JSON: ${String(err.message).slice(0, 120)}`, { cause: err });
      }
      return json.stages_by_tf || [];
    },
    close() {
      try {
        child.stdin.end();
        child.kill();
      } catch { /* the client may already be gone */ }
    },
  };
}

export const stageKey = (x) => `${x.corr_id || ''}:${x.request?.start}:${x.request?.end}:${x.T0_received_ms || ''}`;
export const freshFor = (rows, before, tf) => rows.filter((x) => x.tf_id === tf && x.request && !before.has(stageKey(x)));

/**
 * Find the backend read attributable to a seek.
 *
 * The delivery path reads in 64 MiB chunks and reads ahead of the exact
 * requested position — observed up to ~370 MiB (≈36 s of media) past a target —
 * so an exact byte window produces false negatives for seeks that land close to
 * already-buffered data. The bar is therefore: a read genuinely distant from the
 * start of the file (a plain offset-0 probe never satisfies it) whose implied
 * media position is within `toleranceMs` of the requested target. The match is
 * classified `strict` when it also falls inside a single 64 MiB window of the
 * exact expected offset, so the evidence stays auditable.
 */
export function findSeekRead(rows, { targetMs, durationMs, mediaSize, toleranceMs = 180000 }) {
  const expected = durationMs > 0 && mediaSize > 0 ? Math.floor((mediaSize * targetMs) / durationMs) : null;
  if (!expected) return [null, null];
  const impliedMs = (r) => Math.floor((r.request.start / mediaSize) * durationMs);
  const inWindow = (r) => r.request.start <= expected + CHUNK && r.request.end >= Math.max(0, expected - CHUNK);
  const byCloseness = (a, b) => Math.abs(impliedMs(a) - targetMs) - Math.abs(impliedMs(b) - targetMs);
  const distant = rows.filter((r) => r.request.start > 1e8 && Math.abs(impliedMs(r) - targetMs) <= toleranceMs);
  const miss = distant.filter((r) => r.cache_hit !== true).sort(byCloseness);
  const cache = distant.filter((r) => r.cache_hit === true).sort(byCloseness);
  const match = miss[0] || cache[0] || null;
  if (!match) return [null, null];
  return [{ ...match, strictWindow: inWindow(match) }, cache[0] || null];
}

export function classifyRead(read) {
  if (!read) return { classification: 'SEEK_PASS_BUFFERED', backendRequired: false };
  return {
    classification: read.cache_hit ? 'BYTE_PATH_CACHE' : 'BYTE_PATH_READ',
    cacheHit: Boolean(read.cache_hit),
    strictWindow: Boolean(read.strictWindow),
    request: read.request,
  };
}

/* ---------------------------------------------------- libmpv player surface */

export function createPlayer(ipc) {
  const secondsToMs = (value) => (value == null ? null : Math.round(value * 1000));
  return {
    ipc,
    path: () => ipc.text('path'),
    async positionMs() { const r = await ipc.get('time-pos'); return r.error === 'success' ? secondsToMs(r.data) : null; },
    async durationMs() { const r = await ipc.get('duration'); return r.error === 'success' ? secondsToMs(r.data) : null; },
    async isPaused() { const r = await ipc.get('pause'); return r.error === 'success' ? r.data : null; },
    isIdle: () => ipc.isIdle(),
    seekMs: (targetMs) => ipc.seekMs(targetMs),
  };
}

/* ------------------------------------------------------------- canary core */

async function ensureMpvIpc({ allowRestart = true } = {}) {
  const tryConnect = () => {
    try {
      return connectMpvIpc({ socketPath: MPV_SOCK, expectedExe: PLEX_HTPC_EXE });
    } catch (err) {
      if (err.code === MPV_ERRORS.UNAVAILABLE || err.code === MPV_ERRORS.NOT_PLEX) return null;
      throw err;
    }
  };
  const ready = tryConnect();
  if (ready) return ready;
  if (!allowRestart) throw fail(MPV_ERRORS.UNAVAILABLE, `libmpv IPC socket ${MPV_SOCK} is not available`);
  const result = sh('systemctl', ['--user', 'restart', CANARY_SERVICE]);
  if (result.status !== 0) throw fail('CANARY_INFRA_FAILURE', 'could not restart the isolated Plex HTPC canary');
  return waitFor(() => tryConnect(), 150000, `libmpv IPC socket ${MPV_SOCK}`, MPV_ERRORS.UNAVAILABLE);
}

/** The player surface mutates, so the runner owns reconnection, not the module. */
async function ensurePlayerAlive(player) {
  try {
    await player.ipc.get('idle-active');
    return player;
  } catch (err) {
    if (err.code !== MPV_ERRORS.DISCONNECTED && err.code !== MPV_ERRORS.COMMAND_FAILED) throw err;
  }
  const fresh = await ensureMpvIpc({ allowRestart: false });
  Object.assign(player, createPlayer(fresh));
  return player;
}

/**
 * Stop whatever the client currently has playing, via the application layer.
 * A near-EOF seek can auto-advance into the next episode of the play queue, so
 * every controller the session manager still holds is stopped rather than only
 * the video one, with a retry because the first stop may not take effect while a
 * transition is in flight.
 */
async function stopEverything(app, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    let stoppedAny = false;
    try {
      stoppedAny = Boolean(await app.stopPlayback());
    } catch {
      stoppedAny = false;
    }
    if ((await plexSessions()).length === 0) return;
    if (!stoppedAny && i === 0) return;
    await sleep(1000);
  }
}

async function preflight() {
  for (const service of ['hashsucker-plex-xvfb.service', 'hashsucker-plex-audio.service', CANARY_SERVICE]) {
    if (sh('systemctl', ['--user', 'is-active', service]).stdout.trim() !== 'active') {
      const result = sh('systemctl', ['--user', 'start', service]);
      if (result.status !== 0) throw fail('CANARY_INFRA_FAILURE', `could not start ${service}`);
    }
  }
  if (!PLEX_URL || !PLEX_TOKEN) throw fail('CANARY_INFRA_FAILURE', 'PLEX_URL/PLEX_TOKEN missing');
  await plexSessions();
  ensureMpvConfig();
}

/**
 * One fixture attempt. `app` is the minimal Plex application bridge, `player` the
 * native libmpv surface, `dataPlane` the byte-evidence reader.
 */
async function runFixture(runNo, { app, player, dataPlane, fixture: fx }) {
  const marks = { start: Date.now() };
  const phases = {};
  const counters = { cdpEvaluates: app.evaluations, dataPlanePolls: dataPlane.requests };

  // 1. Deterministic baseline: no prior playback, and nothing pre-session is
  //    later mistaken for playback proof.
  await ensurePlayerAlive(player);
  await app.ensureReady();
  await stopEverything(app);
  await waitFor(async () => ((await plexSessions()).length === 0 ? true : null), 25000, 'prior PMS session teardown', 'STALE_SESSION_BEFORE_START');
  const beforeReads = new Set((await dataPlane.events()).map(stageKey));

  // 2. App-level start (exactly one CDP evaluate).
  marks.startCmd = Date.now();
  const route = await app.startPlayback({
    metadataSourceUri: `server://${fx.server}/com.plexapp.plugins.library/library/metadata/${fx.ratingKey}`,
    itemKey: `/library/metadata/${fx.ratingKey}`,
    grandparentKey: `/library/metadata/${fx.grandparent}`,
    parentKey: `/library/metadata/${fx.parent}`,
  });

  // 3. PMS session creation and identity.
  const active = await waitFor(() => sessionFor(fx.ratingKey), timeoutMs, 'PMS session creation', 'PMS_SESSION_NOT_CREATED');
  marks.session = Date.now();
  const part = (active.Media || []).flatMap((m) => m.Part || []).find((p) => String(p.id) === String(fx.part));
  const clientInfo = active.Player || {};
  if (!part || part.file !== fx.path || String(clientInfo.machineIdentifier) !== PLEX_CLIENT_ID) {
    throw fail('PLEX_IDENTITY_MISMATCH', 'PMS session identity drifted from the fixture', {
      evidence: { ratingKey: active.ratingKey, part: part?.id, file: part?.file, client: clientInfo.machineIdentifier },
    });
  }
  const durationMs = Number(active.duration || 0);
  const mediaSize = Number(part.size || 0);

  // 4. Native player truth: the mpv socket must be playing the expected Part.
  const playerPath = await waitFor(() => player.path(), timeoutMs, 'libmpv source load', 'PLAYBACK_START_TIMEOUT');
  marks.playerLoaded = Date.now();
  if (!playerPath.includes(`/library/parts/${fx.part}/`)) {
    throw fail('MPV_IDENTITY_MISMATCH', 'libmpv is not playing the expected Part', {
      evidence: { playerPath: String(playerPath).slice(0, 200), expectedPart: fx.part },
    });
  }
  await waitFor(async () => ((await player.isPaused()) === false ? true : null), timeoutMs, 'libmpv play state', 'PLAYBACK_START_TIMEOUT');

  // 5. First real byte read, strictly after the PMS session existed.
  //    The data-plane records relative timings only (T0_received_ms is always
  //    0), so wall-clock numbers here are canary OBSERVATION latencies. The byte
  //    path's own timing comes from the record (T5/total_open_ttfb) and is
  //    reported separately.
  const firstRead = await waitFor(async () => {
    if (Date.now() < marks.session) return null;
    return freshFor(await dataPlane.events(), beforeReads, fx.tf)[0] || null;
  }, timeoutMs, 'first post-session HashSucker byte read', 'NO_POST_SESSION_READ');
  marks.firstRead = Date.now();
  phases.observedSessionToFirstRead = marks.firstRead - marks.session;

  // 6. Natural progression: player position AND PMS viewOffset.
  const initial = Number(active.viewOffset || 0);
  await waitFor(async () => {
    const position = await player.positionMs();
    return position != null && position > initial + 4000 ? true : null;
  }, 45000, 'playback progression', 'NO_PROGRESSION');
  await waitFor(async () => {
    const sess = await sessionFor(fx.ratingKey);
    if (sess && Number(sess.viewOffset || 0) > initial + 4000) return sess;
    return null;
  }, 30000, 'PMS viewOffset progression', 'NO_PROGRESSION');
  marks.progressed = Date.now();
  phases.startToProgress = marks.progressed - marks.startCmd;

  const forwardTarget = Math.min(900000, Math.max(600000, durationMs - 120000));
  const backwardTarget = Math.max(300000, forwardTarget - 600000);
  const nearEofTarget = Math.max(120000, durationMs - 180000);

  // 7. Seek: native execution, then proven against PMS state and backend bytes.
  async function runSeek(direction, code, targetMs) {
    const before = new Set((await dataPlane.events()).map(stageKey));
    const t0 = Date.now();
    await player.seekMs(targetMs);
    // native truth: the player itself is at the requested position
    const reached = await waitFor(async () => {
      const position = await player.positionMs();
      return position != null && Math.abs(position - targetMs) < 30000 ? { position, at: Date.now() } : null;
    }, 45000, `player position after ${direction} seek`, code);
    phases[`${direction}SeekToPlayer`] = reached.at - t0;
    // consumer truth: PMS viewOffset follows the player. The client reports its
    // timeline periodically, so this waits for the next report rather than
    // expecting an immediate update.
    const converging = direction === 'backward'
      ? (v) => v <= targetMs + 15000
      : (v) => v >= targetMs - 15000;
    const pms = await waitFor(async () => {
      const sess = await sessionFor(fx.ratingKey);
      const viewOffset = sess ? Number(sess.viewOffset || 0) : null;
      if (viewOffset != null && converging(viewOffset)) return { viewOffset, at: Date.now() };
      return null;
    }, 45000, `PMS viewOffset after ${direction} seek`, code);
    phases[`${direction}SeekToPms`] = pms.at - t0;
    const byteRead = await waitFor(async () => {
      const rows = freshFor(await dataPlane.events(), before, fx.tf);
      return findSeekRead(rows, { targetMs, durationMs, mediaSize })[0] || null;
    }, 45000, `backend byte read after ${direction} seek`, code);
    return { targetMs, playerMs: reached.position, pmsViewOffset: pms.viewOffset, byteRead };
  }

  const forward = await runSeek('forward', 'SEEK_FORWARD_FAILED', forwardTarget);
  const backward = await runSeek('backward', 'SEEK_BACKWARD_FAILED', backwardTarget);
  const nearEof = await runSeek('nearEof', 'SEEK_NEAR_EOF_FAILED', nearEofTarget);

  // 8. Exact-TorrentFile attribution across the whole run.
  const allRows = freshFor(await dataPlane.events(), beforeReads, fx.tf);
  if (!allRows.length || !allRows.some((x) => x.request.start > 1e8)) {
    throw fail('BYTE_CORRELATION_FAILURE', `no distant exact-TorrentFile reads for ${fx.tf}`, {
      evidence: { fresh: allRows.length, starts: allRows.slice(0, 8).map((x) => x.request.start) },
    });
  }

  // 9. App-level stop (exactly one CDP evaluate) + PMS teardown.
  marks.stop = Date.now();
  const stopResult = await app.stopPlayback();
  await waitFor(async () => ((await plexSessions()).length === 0 ? true : null), 20000, 'PMS session teardown', 'PMS_TEARDOWN_FAILED');
  marks.gone = Date.now();
  phases.stopToPmsGone = marks.gone - marks.stop;
  await waitFor(() => player.isIdle(), 20000, 'libmpv idle after app-level stop', 'APP_STOP_FAILED');
  phases.stopToIdle = Date.now() - marks.stop;

  return {
    run: runNo,
    status: 'PASS',
    fixture: fx.label,
    ratingKey: fx.ratingKey,
    part: fx.part,
    tf: fx.tf,
    route: route.name,
    stopSource: stopResult.source,
    identity: { file: part.file, client: clientInfo.machineIdentifier, playerPath: String(playerPath).slice(0, 160) },
    durationMs,
    mediaSize,
    startViewOffsetMs: initial,
    seekTargets: { forwardMs: forward.targetMs, backwardMs: backward.targetMs, nearEofMs: nearEof.targetMs },
    seekResults: {
      forward: { playerMs: forward.playerMs, pmsViewOffsetMs: forward.pmsViewOffset },
      backward: { playerMs: backward.playerMs, pmsViewOffsetMs: backward.pmsViewOffset },
      nearEof: { playerMs: nearEof.playerMs, pmsViewOffsetMs: nearEof.pmsViewOffset },
    },
    seekEvidence: {
      forward: classifyRead(forward.byteRead),
      backward: classifyRead(backward.byteRead),
      nearEof: classifyRead(nearEof.byteRead),
    },
    readCount: allRows.length,
    distantRead: Math.max(...allRows.map((x) => x.request.start)),
    bytePath: {
      firstReadTtfbMs: numberOrNull(firstRead?.T5_first_client_byte_ms ?? firstRead?.total_open_ttfb_ms),
      firstReadBytes: numberOrNull(firstRead?.bytes_delivered),
      seekTtfbMs: {
        forward: numberOrNull(forward.byteRead?.T5_first_client_byte_ms ?? forward.byteRead?.total_open_ttfb_ms),
        backward: numberOrNull(backward.byteRead?.T5_first_client_byte_ms ?? backward.byteRead?.total_open_ttfb_ms),
        nearEof: numberOrNull(nearEof.byteRead?.T5_first_client_byte_ms ?? nearEof.byteRead?.total_open_ttfb_ms),
      },
    },
    latencyMs: Date.now() - marks.start,
    phases,
    control: {
      cdpEvaluates: app.evaluations - counters.cdpEvaluates,
      dataPlanePolls: dataPlane.requests - counters.dataPlanePolls,
    },
  };
}

/* ---------------------------------------------------------------------- main */

async function main() {
  const argv = process.argv.slice(2);
  const fast = argv.includes('--fast');
  const explicit = argv.find((x) => x.startsWith('--fixture='))?.split('=')[1];
  const rotate = explicit === 'rotate' || argv.includes('--rotate');
  const quiet = argv.includes('--quiet') || process.env.HASHSUCKER_CANARY_QUIET === '1';
  const runs = Number(process.env.HASHSUCKER_CANARY_RUNS || (fast || rotate ? 1 : 3));
  const requested = rotate ? 'e01' : (explicit || 'e01');
  if (explicit && !rotate && !FIXTURES[explicit]) {
    console.error(`CANARY_HARNESS_FAILURE: INVALID_FIXTURE ${explicit}; use ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(2);
  }
  const plan = rotate || (!explicit && !fast) ? DEFAULT_PLAN : [requested];

  await preflight();
  const ipc = await ensureMpvIpc();
  const player = createPlayer(ipc);
  const app = await connectPlexApp({ cdpUrl: CDP_URL });
  const bridgeSetupCdpEvaluates = app.evaluations;
  const dataPlane = createDataPlaneReader();
  const results = [];

  try {
    for (const key of plan) {
      for (let run = 1; run <= runs; run += 1) {
        try {
          const result = await runFixture(run, { app, player, dataPlane, fixture: FIXTURES[key] });
          const abnormal = result.phases.observedSessionToFirstRead >= 15000 || result.latencyMs >= 60000;
          results.push({ ...result, fixture: key, abnormal });
          if (!quiet || abnormal) {
            console.log(JSON.stringify(redactSecrets({
              fixture: key, run, status: 'PASS', ratingKey: result.ratingKey, part: result.part,
              latencyMs: result.latencyMs, observedSessionToFirstRead: result.phases.observedSessionToFirstRead,
              teardownMs: result.phases.stopToPmsGone, abnormal, control: result.control,
            })));
          }
        } catch (err) {
          let diagnostic = null;
          try {
            diagnostic = {
              app: await app.diagnose(),
              sessions: await plexSessions(),
              player: { idle: await player.isIdle(), path: await player.path() },
            };
          } catch { /* best-effort evidence capture */ }
          try { await stopEverything(app); } catch { /* cleanup is best-effort */ }
          results.push(redactSecrets({
            fixture: key, run, status: 'FAIL',
            classification: classify(err), code: err?.code || null,
            reason: String(err?.message || err).slice(0, 400),
            ...(err?.evidence ? { evidence: err.evidence } : {}),
            ...(diagnostic ? { diagnostic } : {}),
          }));
          console.error(JSON.stringify(results[results.length - 1]));
          break;
        }
      }
    }
  } finally {
    dataPlane.close();
    app.close();
    player.ipc.close();
  }

  const expected = plan.length * runs;
  const pass = results.length === expected && results.every((x) => x.status === 'PASS');
  const summary = {
    mode: quiet ? 'hybrid-quiet' : (fast ? 'hybrid-fast' : 'hybrid-full'),
    plan,
    runsRequested: runs,
    controlSurface: {
      appLevelStart: 'connectPlexApp.startPlayback — 1 CDP evaluate',
      appLevelStop: 'connectPlexApp.stopPlayback — 1 CDP evaluate',
      playback: 'libmpv native IPC socket',
      evidence: ['PMS /status/sessions', 'HashSucker data-plane /metrics'],
      bridgeSetupCdpEvaluates,
    },
    results: redactSecrets(quiet
      ? results.map((x) => ({
        fixture: x.fixture, run: x.run, status: x.status, classification: x.classification || null,
        latencyMs: x.latencyMs || null, observedSessionToFirstRead: x.phases?.observedSessionToFirstRead ?? null,
        abnormal: x.abnormal || false,
      }))
      : results),
    pass,
  };
  console.log(JSON.stringify(summary, null, quiet ? 0 : 2));
  process.exitCode = pass ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] || '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(JSON.stringify(redactSecrets({
      event: 'FAIL', classification: classify(err), code: err?.code || null,
      reason: String(err?.message || err).slice(0, 500),
    })));
    process.exitCode = 1;
  });
}
