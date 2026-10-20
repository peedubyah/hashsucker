#!/usr/bin/env node
/**
 * PLAYBACK LATENCY — how long does "press play" take, and what does the
 * client actually see?
 *
 * This is the reusable measurement for the resolver-first surface. It
 * answers three questions with one bounded request each:
 *
 *   1. RESOLVE   — how long does the resolver take, and where does it point?
 *   2. FIRST BYTE — how long until the first byte of the playback response
 *      arrives (time-to-first-byte, not time-to-first-frame)?
 *   3. LEAKAGE   — did any response in the chain expose a provider URL or a
 *      provider credential? (The resolver-first claim is that it does not.)
 *
 * With --mpv it additionally measures the first FRAME, by driving the real
 * external player (mpv) against the same URL and timing mpv's own
 * "playing" message. mpv is the reference client; no player code lives in
 * this repository.
 *
 * Usage:
 *   node src/scripts/playback-latency.mjs --url <url> [--mpv] [--json]
 *                                             [--bytes <n>] [--timeout-ms <n>]
 *
 * The URL may be a resolver URL (/stream/...) or a playback object URL
 * (/play/...). Both are measured: the resolver hop is reported separately
 * from the byte hop.
 *
 * Read-only: it fetches bytes and never mutates product state.
 */

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

const has = (name) => args.includes(name);

const url = argValue('--url');
const asJson = has('--json');
const useMpv = has('--mpv');
const byteBudget = Number.parseInt(argValue('--bytes', '1048576'), 10);
const timeoutMs = Number.parseInt(argValue('--timeout-ms', '30000'), 10);

/**
 * Provider hosts whose appearance in a response would mean the client was
 * handed something it must never see. This is a guard, not a parser.
 */
const PROVIDER_HOST_PATTERNS = [
  /real-debrid\./i,
  /realdebrid\./i,
  /torbox\./i,
  /premiumize\./i,
  /alldebrid\./i,
  /debrid-link\./i,
  /offcloud\./i,
  /\/rest\/1\.0\//i,
  /\/api\/v1\/torrents\//i,
];

/**
 * Follow one redirect hop, recording where it points and what it exposed.
 *
 * @param {string} target
 * @returns {Promise<object>}
 */
async function resolveHop(target) {
  const started = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { range: 'bytes=0-0' },
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const headers = Object.fromEntries(response.headers.entries());
    const location = response.headers.get('location');
    return {
      url: target,
      status: response.status,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      location,
      byteRoute: response.headers.get('x-hashsucker-byte-route'),
      torrentId: response.headers.get('x-torrent-id'),
      headers,
      leaked: PROVIDER_HOST_PATTERNS.some((pattern) => pattern.test(
        `${location ?? ''} ${JSON.stringify(headers)}`,
      )),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the first byte of a playback response.
 *
 * @param {string} target
 * @returns {Promise<object>}
 */
async function firstByte(target) {
  const started = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, { redirect: 'manual', signal: controller.signal });
    const headersMs = Number(process.hrtime.bigint() - started) / 1e6;
    let firstByteMs = null;
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      const chunk = await reader.read();
      if (!chunk.done) {
        firstByteMs = Number(process.hrtime.bigint() - started) / 1e6;
        bytes = chunk.value?.length ?? 0;
        await reader.cancel();
      }
    }
    const headers = Object.fromEntries(response.headers.entries());
    return {
      url: target,
      status: response.status,
      headersMs: Number(headersMs.toFixed(1)),
      firstByteMs: firstByteMs == null ? null : Number(firstByteMs.toFixed(1)),
      bytes,
      contentRange: response.headers.get('content-range'),
      contentLength: response.headers.get('content-length'),
      acceptRanges: response.headers.get('accept-ranges'),
      contentType: response.headers.get('content-type'),
      headers,
      leaked: PROVIDER_HOST_PATTERNS.some((pattern) => pattern.test(JSON.stringify(headers))),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drive mpv against the URL and time its own "playing" message.
 *
 * @param {string} target
 * @returns {Promise<object>}
 */
function mpvFirstFrame(target) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let settled = false;
    const child = spawn('mpv', [
      '--no-config',
      '--vo=null',
      '--no-audio',
      '--msg-level=all=warn',
      '--term-playing-msg=PLAYING ${path}',
      '--msg-level=term-playing-msg=info',
      target,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({
      ok: false, firstFrameMs: null, reason: 'timeout', output: out.slice(-500),
    }), timeoutMs);

    const absorb = (data) => {
      out += data.toString();
      if (out.includes('PLAYING')) {
        finish({
          ok: true,
          firstFrameMs: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)),
          output: out.slice(-500),
        });
      }
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);
    child.on('error', (error) => finish({
      ok: false, firstFrameMs: null, reason: error.message, output: out.slice(-500),
    }));
    child.on('exit', (code) => finish({
      ok: false, firstFrameMs: null, reason: `mpv exited ${code}`, output: out.slice(-500),
    }));
  });
}

if (!url) {
  console.error('usage: node src/scripts/playback-latency.mjs --url <url> [--mpv] [--json]');
  process.exit(2);
}

const report = { generatedAt: new Date().toISOString(), url, resolve: null, bytes: null, mpv: null };

try {
  const hop = await resolveHop(url);
  report.resolve = hop;
  const playbackTarget = hop.status === 307 && hop.location
    ? new URL(hop.location, url).toString()
    : url;
  report.playbackUrl = playbackTarget;
  report.bytes = await firstByte(playbackTarget);
  if (useMpv) report.mpv = await mpvFirstFrame(playbackTarget);
} catch (error) {
  report.error = error?.message ?? String(error);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`url            ${report.url}`);
  if (report.resolve) {
    console.log(`resolve        ${report.resolve.status} in ${report.resolve.elapsedMs} ms`
      + (report.resolve.location ? ` -> ${report.resolve.location}` : ''));
    console.log(`byte route     ${report.resolve.byteRoute ?? '(none)'}`);
  }
  if (report.bytes) {
    console.log(`first byte     ${report.bytes.firstByteMs} ms `
      + `(headers ${report.bytes.headersMs} ms, status ${report.bytes.status}, ${report.bytes.bytes} bytes)`);
    console.log(`content-range  ${report.bytes.contentRange ?? '(none)'}`);
  }
  if (report.mpv) {
    console.log(`mpv first frame${report.mpv.ok ? ` ${report.mpv.firstFrameMs} ms` : ` (${report.mpv.reason})`}`);
  }
  const leaked = [report.resolve?.leaked, report.bytes?.leaked].filter(Boolean).length > 0;
  console.log(`provider leak  ${leaked ? 'DETECTED' : 'none'}`);
  if (report.error) console.log(`error          ${report.error}`);
}
