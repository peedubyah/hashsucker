#!/usr/bin/env node
/**
 * hs — the tiny resolver client.
 *
 * One command from a media intent to playback, with no Plex, no Jellyfin, no
 * source picker and no provider URL:
 *
 *     hs play "Alien"
 *     hs play tt0078748
 *     hs play tt26545992 --season 1 --episode 5
 *
 * What it does:
 *   1. asks HashSucker to resolve the intent to a stable playback object
 *      (the server owns the corpus, the ranking, the Binding and the token),
 *   2. opens that URL in mpv, and
 *   3. measures where the time went — resolution, player startup, first frame.
 *
 * What it deliberately does NOT do: it holds no provider state, it never
 * picks a release, it never sees a provider URL, and it never decides what
 * "the same file" means. Those are the server's.
 *
 * It is a proving instrument, not a product client.
 *
 * Usage:
 *   hs play <media-id-or-title> [--season N] [--episode N] [--resume SECONDS]
 *                                  [--json] [--server URL] [--keep-open]
 *
 * Environment:
 *   HS_SERVER_URL   the HashSucker base URL (default http://localhost:8080)
 */

import { createInterface } from 'node:readline';

import { playWithMpv } from './mpv.mjs';
import {
  WATERFALL_SESSION_HEADER,
  assembleWaterfall,
  newSessionId,
} from '../../src/lib/measurement/playback-waterfall.js';

const USAGE = `hs — the tiny resolver client

Usage:
  hs play <media-id-or-title> [options]

Options:
  --season N        episode season (required for a series)
  --episode N       episode number (required for a series)
  --resume SECONDS  start at this position once the first frame is up
  --measure SECONDS play for this long, then stop cleanly (the measurement run)
  --json            print the measurement as JSON
  --server URL      the HashSucker base URL (default http://localhost:8080)
  --keep-open       leave mpv running after the measurement
`;

/** A media identity names itself: tt0903747, tmdb1396, imdb0903747. */
const MEDIA_ID = /^(tt\d{6,10}|tmdb\d+|imdb\d+)$/i;

function parseArgs(argv) {
  const args = {
    command: null, target: null, season: null, episode: null, resume: null,
    measure: null, json: false, server: null, keepOpen: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--season') args.season = Number.parseInt(argv[++i], 10);
    else if (a === '--episode') args.episode = Number.parseInt(argv[++i], 10);
    else if (a === '--resume') args.resume = Number.parseFloat(argv[++i]);
    else if (a === '--measure') args.measure = Number.parseFloat(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--server') args.server = argv[++i];
    else if (a === '--keep-open') args.keepOpen = true;
    else if (a === '--help' || a === '-h') args.command = 'help';
    else if (!a.startsWith('--')) positional.push(a);
  }
  args.command = args.command ?? positional.shift() ?? null;
  args.target = positional.shift() ?? null;
  return args;
}

// process.hrtime is nanoseconds; this is milliseconds since an arbitrary origin.
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

async function ask(base, body, sessionId = null) {
  const started = nowMs();
  const response = await fetch(`${base}/api/playback-object`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(sessionId ? { [WATERFALL_SESSION_HEADER]: sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep the raw body */ }
  return { status: response.status, json, elapsedMs: nowMs() - started };
}

/**
 * Ask the user to choose between legitimate matches. Never guesses.
 */
function disambiguate(candidates) {
  return new Promise((resolve) => {
    process.stdout.write('\nThat title matches more than one work:\n');
    candidates.forEach((c, i) => {
      const year = c.year ? ` (${c.year})` : '';
      const kind = c.mediaType === 'series' ? 'series' : 'movie';
      process.stdout.write(`  ${i + 1}) ${c.title}${year} — ${kind} — ${c.mediaId}\n`);
    });
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Choose a number (or empty to cancel): ', (answer) => {
      rl.close();
      const index = Number.parseInt(String(answer).trim(), 10);
      if (!Number.isSafeInteger(index) || index < 1 || index > candidates.length) {
        resolve(null);
        return;
      }
      resolve(candidates[index - 1]);
    });
  });
}

async function resolveIntent(base, args, measurement, sessionId = null) {
  const body = MEDIA_ID.test(String(args.target).trim())
    ? { mediaId: String(args.target).trim(), season: args.season, episode: args.episode }
    : { query: String(args.target).trim(), season: args.season, episode: args.episode };

  measurement.resolverAttempts += 1;
  let response = await ask(base, body, sessionId);
  if (response.status === 409 && response.json?.code === 'AMBIGUOUS_INTENT') {
    const chosen = await disambiguate(response.json.candidates ?? []);
    if (!chosen) {
      const error = new Error('AMBIGUOUS_INTENT: the title matches more than one work and none was chosen');
      error.code = 'AMBIGUOUS_INTENT';
      throw error;
    }
    measurement.manualActions += 1;
    measurement.resolverAttempts += 1;
    response = await ask(base, {
      mediaId: chosen.mediaId,
      mediaType: chosen.mediaType,
      season: args.season,
      episode: args.episode,
    }, sessionId);
  }
  if (response.status !== 200) {
    const error = new Error(`${response.json?.code ?? `HTTP_${response.status}`}: ${response.json?.error ?? 'the intent could not be resolved'}`);
    error.code = response.json?.code ?? `HTTP_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return { result: response.json, resolveMs: response.elapsedMs };
}

/**
 * Collect the data plane's byte stages for this session and assemble the
 * canonical waterfall.
 *
 * The data plane keeps a bounded ring of stage reports and exposes them at
 * its /metrics endpoint. The stage report carries the session id (the
 * correlation id the server forwarded) and the wall instant of its T0, which
 * is what places its monotonic offsets on the same timeline as the server's
 * and the player's.
 */
async function collectWaterfall({ base, sessionId, clientMarks }) {
  const sources = [];

  // The server's stages for this session. They live in the server's session
  // store because the intent and the player's byte request are DIFFERENT
  // HTTP requests; the store keeps one monotonic origin across them.
  const serverRecord = await readServerSession(base, sessionId);
  if (serverRecord?.marks?.length) {
    sources.push({
      process: 'server',
      anchorWallMs: serverRecord.anchorWallMs,
      marks: serverRecord.marks,
    });
  }
  if (clientMarks?.marks?.length) {
    sources.push({
      process: 'client',
      anchorWallMs: clientMarks.anchorWallMs,
      marks: clientMarks.marks,
    });
  }

  const dataPlane = await readDataPlaneStages(sessionId);
  if (dataPlane) sources.push(dataPlane);

  return assembleWaterfall({ sessionId, sources });
}

async function readServerSession(base, sessionId) {
  try {
    const res = await fetch(`${base}/api/measurement/session/${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Read the data plane's stage report for one session.
 *
 * The data plane is an internal service (it is not published on the host),
 * so it is read the way the other diagnostics read it: from inside the
 * container. The data plane's own URL may also be provided directly.
 */
async function readDataPlaneStages(sessionId) {
  const direct = process.env.HS_DATA_PLANE_URL;
  const container = process.env.HS_DATA_PLANE_CONTAINER ?? 'hashsucker-data-plane-1';
  let payload = null;
  if (direct) {
    try {
      const res = await fetch(`${direct.replace(/\/$/, '')}/metrics`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) payload = await res.json();
    } catch { /* fall through to the container read */ }
  }
  if (!payload) {
    try {
      const { execFileSync } = await import('node:child_process');
      const raw = execFileSync('docker', ['exec', container, 'sh', '-lc', 'wget -qO- http://127.0.0.1:3001/metrics'], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const reports = Array.isArray(payload?.stages_recent) ? payload.stages_recent : [];
  const mine = reports
    .filter((r) => r?.corr_id === sessionId)
    .sort((a, b) => (a?.T0_wall_ms ?? 0) - (b?.T0_wall_ms ?? 0));
  if (mine.length === 0) return null;
  // The FIRST byte request for this session is the canonical one: the
  // player issues several (a probe, then ranges), and the waterfall is
  // about the first.
  const report = mine[0];
  const off = (v) => (Number.isFinite(v) ? Number(v) : null);
  const anchorWallMs = Number.isFinite(report?.T0_wall_ms) ? report.T0_wall_ms : null;
  const marks = [
    { stage: 'first_rust_byte_request', atMs: off(report.T0_received_ms) },
    { stage: 'provider_request_start', atMs: off(report.T3_cdn_dispatched_ms) },
    { stage: 'provider_first_byte', atMs: off(report.T4_first_upstream_byte_ms) },
    { stage: 'first_byte_to_client', atMs: off(report.T5_first_client_byte_ms) },
  ].filter((m) => m.atMs != null);
  if (marks.length === 0) return null;
  return { process: 'data-plane', anchorWallMs, marks };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || !args.command) {
    process.stdout.write(USAGE);
    process.exit(args.command ? 0 : 2);
  }
  if (args.command !== 'play') {
    process.stderr.write(`hs: unknown command '${args.command}'\n${USAGE}`);
    process.exit(2);
  }
  if (!args.target) {
    process.stderr.write(`hs: play needs a media id or a title\n${USAGE}`);
    process.exit(2);
  }

  const base = (args.server ?? process.env.HS_SERVER_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
  // One session id for the whole session: the server's stages, the data
  // plane's byte stages, and the player's stages. It is minted here because
  // the client is the only party that sees all three.
  const sessionId = newSessionId();
  const measurement = {
    command: 'play',
    target: args.target,
    manualActions: 0,
    resolverAttempts: 0,
    firstSourceSuccess: false,
    startedAt: new Date().toISOString(),
    sessionId,
  };

  try {
    const resolved = await resolveIntent(base, args, measurement, sessionId);
    measurement.resolverMs = resolved.resolveMs;
    measurement.mediaId = resolved.result.mediaId;
    measurement.mediaType = resolved.result.mediaType;
    measurement.title = resolved.result.title;
    measurement.torrentFileId = resolved.result.torrentFileId;
    measurement.warm = resolved.result.warm;
    measurement.playbackUrl = resolved.result.playbackUrl;
    measurement.playbackUrlExpiresInSeconds = resolved.result.playbackUrlExpiresInSeconds ?? null;

    // The server answers with a path; the player needs an absolute URL.
    const playbackUrl = new URL(resolved.result.playbackUrl, base).toString();
    measurement.playbackUrl = playbackUrl;
    // Renew before the playback URL expires rather than discovering it as a
    // failed request. The renewal re-resolves the SAME authoritative media
    // (the server owns which TorrentFile that is) and hands back a fresh URL;
    // the playhead stays in the client.
    const renew = async (positionSeconds) => {
      measurement.resolverAttempts += 1;
      measurement.renewals = (measurement.renewals ?? 0) + 1;
      const again = await resolveIntent(base, args, measurement, sessionId);
      measurement.torrentFileId = again.result.torrentFileId;
      const fresh = new URL(again.result.playbackUrl, base).toString();
      measurement.playbackUrl = fresh;
      return fresh;
    };
    const ttlSeconds = resolved.result.playbackUrlExpiresInSeconds ?? null;
    const renewAfterMs = ttlSeconds != null && ttlSeconds > 0
      ? Math.max(1000, (ttlSeconds - 10) * 1000)
      : null;
    measurement.renewAfterMs = renewAfterMs;
    const marks = await playWithMpv(playbackUrl, {
      resume: args.resume,
      keepOpen: args.keepOpen,
      measureSeconds: args.measure,
      renew,
      renewAfterMs,
      sessionId,
    });
    measurement.playerStartupMs = marks.mediaLoadedMs ?? null;
    measurement.firstFrameMs = marks.firstFrameMs ?? null;
    measurement.cleanExit = marks.cleanExit ?? false;
    measurement.exitCode = marks.exitCode ?? null;
    measurement.firstSourceSuccess = marks.firstFrameMs != null;
    measurement.playheadSeconds = marks.playheadSeconds ?? null;
    measurement.lifecycleEvents = marks.lifecycleEvents ?? {};
    measurement.renewals = marks.renewals ?? 0;
    measurement.renewedAtPositionSeconds = marks.renewedAt ?? null;
    measurement.error = marks.error ?? null;

    // The canonical cross-process waterfall: the server's stages (from the
    // playback-object response), the player's stages (from here), and the
    // data plane's byte stages (fetched from its metrics by session id).
    measurement.waterfall = await collectWaterfall({
      base,
      sessionId,
      clientMarks: marks.waterfall,
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`);
    } else {
      const title = resolved.result.title ? `${resolved.result.title} ` : '';
      process.stdout.write(`${title}(${resolved.result.mediaId}) — ${resolved.result.mediaType}\n`);
      process.stdout.write(`  resolved in ${resolved.resolveMs} ms (${resolved.result.warm ? 'warm' : 'cold'})\n`);
      if (marks.mediaLoadedMs != null) process.stdout.write(`  player loaded in ${marks.mediaLoadedMs} ms\n`);
      if (marks.firstFrameMs != null) process.stdout.write(`  first frame in ${marks.firstFrameMs} ms\n`);
      if (measurement.error) process.stdout.write(`  player error: ${measurement.error}\n`);
    }
    process.exit(measurement.firstSourceSuccess ? 0 : 1);
  } catch (error) {
    const payload = {
      ...measurement,
      error: error?.message ?? String(error),
      code: error?.code ?? 'UNKNOWN',
    };
    if (args.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stderr.write(`hs: ${payload.code}: ${payload.error}\n`);
    }
    process.exit(1);
  }
}

main();
