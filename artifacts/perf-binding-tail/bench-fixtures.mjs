#!/usr/bin/env node
/**
 * Scratch: cold-request benchmark over a fixture set, measured through the
 * real production path (media-search HTTP → provider → Binding → VFS → Plex).
 *
 *   node bench-fixtures.mjs <tag> <imdbId,imdbId,...>
 *
 * Per fixture (live pipeline: live discovery → availability → selection →
 * Binding → VFS → .strm → Plex):
 *   1. POST /api/media-request (liveOnly)  → request→Binding (wall)
 *   2. poll Plex for the item Part          → request→Part
 *   3. GET the Part with a Range            → request→206
 *
 * No unpublish: the live pipeline re-publishes over the existing projection,
 * so the presentation (VFS path, .strm) stays stable.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const TAG = process.argv[2] || 'run';
const FIXTURES = (process.argv[3] || '').split(',').filter(Boolean);
const OUT = '/var/tmp/patrick/hashsucker/perf-binding-tail';
const BASE = 'http://127.0.0.1:3000';
const PLEX = process.env.PLEX_URL || 'http://192.168.2.4:32400';
const TOKEN = process.env.PLEX_TOKEN || '';
const PLEX_HEADERS = { accept: 'application/json', 'X-Plex-Token': TOKEN };

async function plexItem(imdbId) {
  const sections = await (await fetch(`${PLEX}/library/sections`, { headers: PLEX_HEADERS })).json();
  for (const dir of sections.MediaContainer.Directory ?? []) {
    const items = await (await fetch(`${PLEX}/library/sections/${dir.key}/all?includeGuids=1`, { headers: PLEX_HEADERS })).json();
    for (const m of items.MediaContainer.Metadata ?? []) {
      const guids = (m.Guid ?? []).map((g) => g.id).join(' ');
      if (!guids.includes(imdbId) && !String(m.guid ?? '').includes(imdbId)) continue;
      const parts = (m.Media ?? []).flatMap((media) => media.Part ?? []);
      return { ratingKey: m.ratingKey, title: m.title, parts };
    }
  }
  return null;
}

async function waitForPart(imdbId, expectedSize, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const item = await plexItem(imdbId);
    const part = (item?.parts ?? []).find((p) => Number(p.size) === Number(expectedSize));
    if (part) return { part, ratingKey: item.ratingKey };
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function probe206(partKey) {
  const response = await fetch(`${PLEX}${partKey}`, {
    headers: { 'X-Plex-Token': TOKEN, Range: 'bytes=0-65535' },
    signal: AbortSignal.timeout(120_000),
  });
  const buf = await response.arrayBuffer();
  return { status: response.status, bytes: buf.byteLength };
}

const results = [];
for (const mediaId of FIXTURES) {
  const since = new Date(Date.now() - 2000).toISOString();

  const t0 = Date.now();
  const response = await fetch(`${BASE}/api/media-request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaId, mediaType: 'movie', liveOnly: true, source: 'perf-bench' }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = await response.json();
  const tBinding = Date.now() - t0;

  const binding = body.handoff?.torrentFileIdentity ?? null;
  const expectedSize = binding?.size ?? null;
  const found = expectedSize != null ? await waitForPart(mediaId, expectedSize) : null;
  const tPart = found ? Date.now() - t0 : null;

  let probe = null;
  let t206 = null;
  if (found?.part?.key) {
    probe = await probe206(found.part.key);
    t206 = Date.now() - t0;
  }

  const logLines = execFileSync('docker', ['logs', '--since', since, 'hashsucker-media-search-1'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
    .split('\n');
  const perf = logLines.filter((l) => l.startsWith('[perf]')).map((l) => {
    try { return JSON.parse(l.slice(6)); } catch { return null; }
  }).filter(Boolean);
  const rid = perf.find((l) => l.n === 'request.start' && l.mediaId === mediaId)?.rid ?? null;
  const scoped = rid ? perf.filter((l) => l.rid === rid) : [];

  const row = {
    mediaId,
    requestToBindingMs: tBinding,
    requestToPartMs: tPart,
    requestTo206Ms: t206,
    probe,
    selected: body.selection?.selected?.infoHash ?? null,
    torrentFileId: binding?.torrentFileId ?? null,
    providerFileId: binding?.providerFileId ?? null,
    bindingStatus: binding?.status ?? null,
    selectionReason: body.selection?.reason ?? null,
    serviceability: body.serviceability ?? null,
    published: body.published ?? null,
    partFile: found?.part?.file ?? null,
    rid,
    stages: scoped.filter((l) => ['stage.live_discovery', 'stage.availability', 'stage.selection', 'stage.handoff_build', 'binding.activate', 'request.route_done'].includes(l.n)),
    providerHttp: scoped.filter((l) => l.n === 'provider.http').map((l) => ({ endpoint: l.endpoint, ms: l.ms, status: l.status })),
  };
  results.push(row);
  console.log(JSON.stringify({ ...row, stages: undefined, providerHttp: row.providerHttp }));
  fs.writeFileSync(`${OUT}/fixtures-${TAG}.json`, JSON.stringify(results, null, 2));
}
console.log(`\n== ${TAG} ==`);
for (const r of results) {
  console.log(`${r.mediaId}  binding=${String(r.requestToBindingMs).padStart(6)}ms  part=${String(r.requestToPartMs).padStart(7)}ms  206=${String(r.requestTo206Ms).padStart(7)}ms  ${r.selectionReason}  ${r.selected}`);
}
