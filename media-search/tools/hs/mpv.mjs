/**
 * The mpv half of the tiny client.
 *
 * Kept in its own module so the invocation can be unit-tested without
 * spawning a player. The measurement signals are deliberately the same ones
 * the production Plex HTPC canary uses: the player's own "playing" message
 * for the first frame, and `file-loaded` for "the media is in".
 */

import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';

import { connectMpvIpc } from '../../src/lib/plex-htpc/mpv-ipc.js';
import {
  WATERFALL_SESSION_HEADER,
  createWaterfallRecorder,
  newSessionId,
} from '../../src/lib/measurement/playback-waterfall.js';

// process.hrtime is nanoseconds; this is milliseconds since an arbitrary origin.
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

/**
 * Build the mpv command line.
 *
 * @param {object} args
 * @param {string} args.url          the stable playback URL
 * @param {string} args.socketPath   the JSON IPC socket path
 * @param {boolean} args.headless    true when there is no display (no VO, no audio)
 * @param {string} [args.sessionId]  the cross-process session id, if any
 * @returns {string[]}
 */
export function buildMpvArgs({ url, socketPath, headless, sessionId = null }) {
  const args = [
    '--no-config',
    '--input-ipc-server=' + socketPath,
    '--msg-level=all=warn',
    '--term-playing-msg=PLAYING ${path}',
    '--msg-level=term-playing-msg=info',
  ];
  // The session id travels on the player's own HTTP request, so the byte
  // request the server forwards to the data plane carries it too. It is a
  // correlation handle: it names a measurement run and grants nothing.
  if (sessionId) args.push(`--http-header-fields=${WATERFALL_SESSION_HEADER}:${sessionId}`);
  if (headless) args.push('--vo=null', '--no-audio');
  args.push(url);
  return args;
}

/**
 * Open the playback URL in mpv and measure the startup stages.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number|null} [options.resume]  a start position in seconds
 * @param {boolean} [options.keepOpen]    leave mpv running
 * @param {string} [options.socketPath]   the JSON IPC socket path
 * @returns {Promise<object>} the marks
 */
export async function playWithMpv(url, {
  resume = null, keepOpen = false, measureSeconds = null, socketPath = null,
  renew = null, renewAfterMs = null, sessionId = null,
} = {}) {
  const sock = socketPath ?? `/tmp/hs-mpv-${process.pid}-${Date.now()}.sock`;
  const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const args = buildMpvArgs({ url, socketPath: sock, headless, sessionId });

  const startedAt = nowMs();
  // The player's own marks, on the same monotonic clock as every other
  // process, so the waterfall can place them on one timeline.
  const waterfall = createWaterfallRecorder({ sessionId });
  const child = spawn('mpv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  waterfall.mark('player_launched');
  const marks = {
    launchedAt: startedAt, firstFrameMs: null, exitCode: null,
    playheadSeconds: null, renewals: 0, renewedAt: null, playerExited: null,
    lifecycleEvents: {},
    waterfall,
  };
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (marks.firstFrameMs == null && stderr.includes('PLAYING')) {
      marks.firstFrameMs = nowMs() - startedAt;
      // The player's own "playing" message: a frame is on screen.
      waterfall.mark('first_frame');
    }
  });
  child.stdout.on('data', () => {});

  // mpv creates the IPC socket asynchronously; wait for it to appear.
  let ipc = null;
  for (let attempt = 0; attempt < 100 && ipc == null; attempt += 1) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      ipc = connectMpvIpc({ socketPath: sock, timeoutMs: 2000 });
    } catch {
      ipc = null;
    }
  }

  if (ipc) {
    try {
      // "first media loaded" is a file-level fact: the player knows the
      // duration once it has read the container. (mpv's `file-loaded` is an
      // EVENT, not a property — polling it waits for the full timeout.)
      await ipc.waitForProperty('duration', (v) => Number(v) > 0, { timeoutMs: 60_000, intervalMs: 20 });
      marks.mediaLoadedMs = nowMs() - startedAt;
      // "file-loaded" is the player's own fact: the media is in and its
      // container has been read.
      waterfall.mark('player_file_loaded');
      if (marks.firstFrameMs == null) {
        try {
          await ipc.waitForProperty('playback-time', (v) => Number(v) > 0, { timeoutMs: 30_000, intervalMs: 20 });
          marks.firstFrameMs = nowMs() - startedAt;
          // A progressing playhead is a rendered frame: the decoder produced
          // picture, not just a decoded buffer.
          waterfall.mark('first_frame');
        } catch { /* the term-playing-msg is the primary signal */ }
      }
      if (resume != null && Number.isFinite(resume)) {
        ipc.seekMs(Math.round(resume * 1000));
        marks.resumedToSeconds = resume;
      }

      // Track the playhead in the CLIENT. The player position, the decoder
      // state and the selected tracks are client/session state; HashSucker
      // is told nothing and the Binding, the TorrentFile and the route
      // authority are untouched by any of this.
      const trackPlayhead = setInterval(() => {
        ipc.get('playback-time').then((msg) => {
          if (msg?.error === 'success' && msg.data != null) {
            marks.playheadSeconds = Number(msg.data);
          }
        }).catch(() => {});
      }, 500);

      // Renew the playback object BEFORE it expires: the same authoritative
      // media, a fresh URL, and the player is moved onto it at its current
      // position. The URL changes; the represented TorrentFile does not.
      if (renew && renewAfterMs != null) {
        const timer = setTimeout(async () => {
          try {
            const position = marks.playheadSeconds ?? 0;
            const fresh = await renew(position);
            if (!fresh) return;
            marks.renewals += 1;
            marks.renewedAt = position;
            // mpv's loadfile takes per-file options: "start=<seconds>" puts
            // the reopened media at the position the player had reached.
            await ipc.command('loadfile', fresh, 'replace', '0', `start=${position}`);
          } catch (error) {
            // A failed renewal is recorded, not hidden: the player itself
            // will report a broken stream, but the client must be able to
            // say WHY the renewal did not happen.
            marks.renewalError = error?.message ?? String(error);
          }
        }, renewAfterMs);
        marks.renewalTimer = timer;
      }
      if (measureSeconds != null && Number.isFinite(measureSeconds)) {
        // The measurement run: play for a bounded time, then stop cleanly.
        await new Promise((r) => setTimeout(r, Math.max(0, measureSeconds * 1000)));
        try { ipc.stop(); } catch { /* the player may already be gone */ }
        await new Promise((resolve) => { child.on('exit', resolve); });
        marks.exitCode = child.exitCode;
        marks.cleanExit = child.exitCode === 0;
      } else if (!keepOpen) {
        await new Promise((resolve) => { child.on('exit', resolve); });
        marks.exitCode = child.exitCode;
        marks.cleanCode = child.exitCode === 0;
      }
      clearInterval(trackPlayhead);
      marks.renewalTimer && clearTimeout(marks.renewalTimer);
      marks.lifecycleEvents = ipc.events ? ipc.events() : {};
    } catch (error) {
      marks.error = error?.message ?? String(error);
      marks.playerStderr = stderr.split('\n').filter((l) => l.trim()).slice(-4);
    } finally {
      try { ipc.close(); } catch { /* already closed */ }
    }
  } else {
    marks.error = 'mpv IPC socket did not appear';
  }

  if (!keepOpen && marks.exitCode == null) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise((r) => child.on('exit', r));
  }
  try { unlinkSync(sock); } catch { /* mpv may have removed it */ }
  return marks;
}
