#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createFutureIntentStore } from '../lib/anticipation/future-intents.js';
import { confirmPlexEpisode } from '../lib/consumers/plex.js';
import { loadDiscoveryAddons } from '../lib/stremio/search.js';
import { isPlayableVideoTorrentFile } from '../lib/resolver/tv-episode-resolver.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = {
  mediaId: process.env.PRODUCTION_TEST_MEDIA_ID || 'tt26545992',
  season: Number(process.env.PRODUCTION_TEST_SEASON || 1),
  episode: Number(process.env.PRODUCTION_TEST_EPISODE || 1),
};
const discoveryPath = process.env.DISCOVERY_DB || '/data/discovery-cache.db';
const controlPath = process.env.CONTROL_PLANE_DB || '/data/control-plane.db';
const dataPlaneUrl = (process.env.DATA_PLANE_URL || (process.env.DISCOVERY_DB?.startsWith('/data/') ? 'http://data-plane:3001' : 'http://127.0.0.1:3001')).replace(/\/$/, '');
const mediaUrl = (process.env.HASHSUCKER_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const plexUrl = String(process.env.PLEX_URL || '').replace(/\/$/, '');
const plexToken = process.env.PLEX_TOKEN || '';
const started = performance.now();
const checks = [];
const timings = {};
const pass = (name, detail = null) => checks.push({ name, pass: true, detail });
const fail = (name, detail) => checks.push({ name, pass: false, detail });
async function timed(name, fn) { const t = performance.now(); try { const value = await fn(); timings[name] = Math.round(performance.now() - t); return value; } catch (error) { timings[name] = Math.round(performance.now() - t); throw error; } }
async function jsonFetch(url, options = {}) { const response = await fetch(url, { signal: AbortSignal.timeout(30_000), ...options }); const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch {} return { response, json, text }; }
async function probeRange(url, start, end) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(180_000) });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, range: response.headers.get('content-range'), length: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}
function identityKey(item) { return `${item.mediaId}|${item.season ?? ''}|${item.episode ?? ''}`; }
async function main() {
  const dc = createDiscoveryCache({ dbPath: discoveryPath });
  const cp = createControlPlaneStore({ dbPath: controlPath });
  const fi = createFutureIntentStore({ db: dc.db });
  try {
    const health = await timed('health', async () => jsonFetch(`${mediaUrl}/health`));
    health.json ? pass('HEALTH', health.json) : fail('HEALTH', health.response.status);
  } catch (error) { fail('HEALTH', error.message); }
  try {
    const ready = await timed('readiness', async () => jsonFetch(`${mediaUrl}/health/ready`));
    ready.response.ok ? pass('READINESS', ready.json) : fail('READINESS', ready.json || ready.response.status);
  } catch (error) { fail('READINESS', error.message); }
  try {
    const dp = await timed('dataPlaneHealth', async () => jsonFetch(`${dataPlaneUrl}/metrics`));
    dp.response.ok ? pass('DATA_PLANE', dp.json || dp.text.slice(0, 200)) : fail('DATA_PLANE', dp.response.status);
  } catch (error) { fail('DATA_PLANE', error.message); }
  const routeBase = process.env.PRODUCTION_TEST_MEDIA_BASE_URL || mediaUrl;
  let plexResult = null;
  try { plexResult = await timed('plex', () => confirmPlexEpisode(fixture)); plexResult.visible ? pass('PLEX', plexResult) : fail('PLEX', plexResult); } catch (error) { fail('PLEX', error.message); }
  try {
    const addons = await timed('discoveryRoutes', () => loadDiscoveryAddons());
    const routes = await Promise.all(addons.filter((addon) => addon.enabled !== false).map(async (addon) => {
      const url = addon.manifestUrl || addon.manifest_url;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      return { id: addon.id || addon.addon_id, status: response.status };
    }));
    routes.every((route) => route.status >= 200 && route.status < 300)
      ? pass('DISCOVERY_ROUTES', routes)
      : fail('DISCOVERY_ROUTES', routes);
  } catch (error) { fail('DISCOVERY_ROUTES', error.message); }
  try {
    const corpus = dc.db.prepare('SELECT * FROM corpus_state WHERE id = 1').get();
    corpus?.last_success ? pass('CORPUS', { state: corpus.state, lastCheck: corpus.last_check, lastSuccess: corpus.last_success, upstream: corpus.upstream_head_commit, imported: corpus.imported_commit, lastError: corpus.last_error }) : fail('CORPUS', 'no successful corpus state');
  } catch (error) { fail('CORPUS', error.message); }
  const items = cp.db.prepare("SELECT * FROM library_items WHERE desired_state != 'absent' ORDER BY identity_key LIMIT 10000").all().map((row) => ({
    id: row.id, identityKey: row.identity_key, mediaId: row.media_id, mediaType: row.media_type,
    season: row.season, episode: row.episode, desiredState: row.desired_state,
  }));
  const activeBindings = [];
  const ownership = [];
  let invalid = 0;
  for (const item of items) {
    if (item.desiredState === 'absent') continue;
    const binding = cp.getActiveBindingForLibraryItem(item.id);
    const libraryPath = cp.getActiveCanonicalPath(item.id);
    if (binding) {
      const tf = binding.torrentFile;
      const vfs = item.season != null ? dc.getVfsTvEntry(item.mediaId, item.season, item.episode) : dc.getVfsMovieEntry(item.mediaId);
      const mismatch = !tf || tf.size <= 0 || !libraryPath || !vfs || vfs.torrentFileId !== tf.id;
      if (mismatch) fail('BINDING_VFS', { identity: item.identityKey, torrentFileId: tf?.id, vfsTorrentFileId: vfs?.torrentFileId, path: libraryPath?.canonicalPath });
      else activeBindings.push({ identity: item.identityKey, torrentFileId: tf.id, path: libraryPath.canonicalPath });
      const bad = !isPlayableVideoTorrentFile(tf)
        || !/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|m2ts|vob|ogv)$/i.test(libraryPath?.canonicalPath || '');
      if (bad) invalid++;
    }
    const observation = cp.listConsumerObservations({ mediaId: item.mediaId }).find((row) => (row.season ?? null) === (item.season ?? null) && (row.episode ?? null) === (item.episode ?? null) && row.consumer === 'plex');
    if (observation?.present === 0 && !fi.findByIdentity({ mediaId: item.mediaId, season: item.season, episode: item.episode })) ownership.push({ identity: item.identityKey, state: 'PLEX_ABSENT_NO_OWNER' });
  }
  ownership.length === 0 ? pass('DURABLE_OWNERSHIP', { checked: items.length }) : fail('DURABLE_OWNERSHIP', ownership);
  activeBindings.every((entry) => entry.torrentFileId && entry.path) ? pass('BINDING_VFS', { checked: activeBindings.length }) : fail('BINDING_VFS', activeBindings);
  invalid === 0 ? pass('INVALID_PUBLICATIONS') : fail('INVALID_PUBLICATIONS', { count: invalid });
  const future = fi.list({ limit: 10000 }).filter((row) => row.expected_at != null && row.state !== 'withdrawn');
  const premature = [];
  for (const row of future) { const visible = await confirmPlexEpisode({ mediaId: row.media_id, season: row.season, episode: row.episode }).catch(() => ({ visible: false })); if (row.expected_at > Date.now() && visible.visible) premature.push(row.id); }
  premature.length === 0 ? pass('FUTURE_AUDIT', { count: future.length }) : fail('FUTURE_AUDIT', premature);
  const fixtureItem = items.find((item) => item.mediaId === fixture.mediaId && item.season === fixture.season && item.episode === fixture.episode);
  const fixtureBinding = fixtureItem ? cp.getActiveBindingForLibraryItem(fixtureItem.id) : null;
  const fixtureVfs = dc.getVfsTvEntry(fixture.mediaId, fixture.season, fixture.episode);
  if (!fixtureBinding || !fixtureVfs || fixtureVfs.torrentFileId !== fixtureBinding.torrentFile.id || !plexResult?.visible) fail('BYTE_PROBE', { fixture, binding: fixtureBinding?.torrentFile?.id, vfs: fixtureVfs?.torrentFileId, plex: plexResult });
  else {
    const size = fixtureBinding.torrentFile.size; const ranges = [[0, 1048575], [Math.max(0, Math.floor(size / 2)), Math.max(0, Math.floor(size / 2) + 1048575)], [size - 1048576, size - 1]]; const vfsPath = `${routeBase}/vfs/${fixtureVfs.canonicalPath.split('/').map(encodeURIComponent).join('/')}`; const results = [];
    for (const [start, end] of ranges) { const v = await probeRange(vfsPath, start, end); const d = await probeRange(`${dataPlaneUrl}/files/${fixtureBinding.torrentFile.id}`, start, end); results.push({ start, end, vfs: v, dataPlane: d, match: v.sha256 === d.sha256 && v.status === 206 && d.status === 206 }); }
    results.every((r) => r.match) ? pass('BYTE_PROBE', { fixture, ranges: results }) : fail('BYTE_PROBE', results);
  }
  const reuseStart = performance.now();
  try {
    const reuse = await jsonFetch(`${routeBase}/api/media-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fixture, mediaType: 'series', mediaTitle: process.env.PRODUCTION_TEST_MEDIA_TITLE || 'Lanterns', source: 'production-smoke-reuse' }) });
    const valid = reuse.response.ok && reuse.json?.fulfilled === true && reuse.json?.retryOwned === false; valid ? pass('HEALTHY_REUSE', { requestId: reuse.json.requestId, latencyMs: Math.round(performance.now() - reuseStart), reuseMode: reuse.json.reuseMode || null }) : fail('HEALTHY_REUSE', reuse.json || reuse.response.status);
  } catch (error) { fail('HEALTHY_REUSE', error.message); }
  const orderedChecks = checks.map((check) => ({ name: check.name, status: check.pass ? 'PASS' : 'FAIL', detail: check.detail }));
  const result = { mode: 'read-mostly', writes: ['healthy reuse invokes the normal request API and may persist request/history timestamps'], fixture, checks: orderedChecks, timings, total: orderedChecks.length, passed: orderedChecks.filter((c) => c.status === 'PASS').length, failed: orderedChecks.filter((c) => c.status === 'FAIL').length, durationMs: Math.round(performance.now() - started) };
  console.log(orderedChecks.map((check) => `${check.name.padEnd(24)} ${check.status}`).join('\n'));
  console.log(`TOTAL                    ${result.passed}/${result.total}`);
  console.log(JSON.stringify(result, null, 2));
  console.error(`production-smoke: ${result.passed}/${result.total} passed (${result.durationMs}ms)`);
  process.exitCode = result.failed ? 1 : 0;
}
main().catch((error) => { console.error(JSON.stringify({ mode: 'read-only', fatal: error.message }, null, 2)); process.exitCode = 1; });
