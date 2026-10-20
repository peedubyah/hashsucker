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

// process.hrtime is nanoseconds; this is milliseconds since an arbitrary origin.
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

/**
 * Build the mpv command line.
 *
 * @param {object} args
 * @param {string} args.url          the stable playback URL
 * @param {string} args.socketPath   the JSON IPC socket path
 * @param {boolean} args.headless    true when there is no display (no VO, no audio)
 * @returns {string[]}
 */
export function buildMpvArgs({ url, socketPath, headless }) {
  const args = [
    '--no-config',
    '--input-ipc-server=' + socketPath,
    '--msg-level=all=warn',
    '--term-playing-msg=PLAYING ${path}',
    '--msg-level=term-playing-msg=info',
  ];
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
export async function playWithMpv(url, { resume = null, keepOpen = false, measureSeconds = null, socketPath } = {}) {
  const sock = socketPath ?? `/tmp/hs-mpv-${process.pid}-${Date.now()}.sock`;
  const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const args = buildMpvArgs({ url, socketPath: sock, headless });

  const startedAt = nowMs();
  const child = spawn('mpv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const marks = { launchedAt: startedAt, firstFrameMs: null, exitCode: null };
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (marks.firstFrameMs == null && stderr.includes('PLAYING')) {
      marks.firstFrameMs = nowMs() - startedAt;
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
      if (marks.firstFrameMs == null) {
        try {
          await ipc.waitForProperty('playback-time', (v) => Number(v) > 0, { timeoutMs: 30_000, intervalMs: 20 });
          marks.firstFrameMs = nowMs() - startedAt;
        } catch { /* the term-playing-msg is the primary signal */ }
      }
      if (resume != null && Number.isFinite(resume)) {
        ipc.seekMs(Math.round(resume * 1000));
        marks.resumedToSeconds = resume;
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
