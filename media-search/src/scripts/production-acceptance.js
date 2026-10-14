#!/usr/bin/env node
const mediaId = process.env.MEDIA_ID || process.argv[2];
if (!mediaId) {
  console.error('usage: npm run test:production-acceptance -- <media-id> [--season N --episode N]');
  process.exit(2);
}
const seasonArg = process.argv.indexOf('--season');
const episodeArg = process.argv.indexOf('--episode');
const body = { mediaId, mediaType: seasonArg >= 0 ? 'series' : 'movie', source: 'production-acceptance' };
if (seasonArg >= 0) body.season = Number(process.argv[seasonArg + 1]);
if (episodeArg >= 0) body.episode = Number(process.argv[episodeArg + 1]);
const base = (process.env.HASHSUCKER_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const started = performance.now();
const response = await fetch(`${base}/api/media-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10 * 60 * 1000) });
const text = await response.text();
let result; try { result = JSON.parse(text); } catch { result = { raw: text }; }
console.log(JSON.stringify({ mode: 'mutating-acceptance', request: body, status: response.status, latencyMs: Math.round(performance.now() - started), result }, null, 2));
process.exitCode = response.ok && result.fulfilled === true && result.retryOwned === false ? 0 : 1;
