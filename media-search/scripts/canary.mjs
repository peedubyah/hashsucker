#!/usr/bin/env node
/**
 * Startup Canary — proves one release survives the pipeline.
 *
 * Uses structured events for all output.
 *
 * Samples a random release from the corpus (via sampleRandomRelease).
 * Pipeline behavior is unchanged from previous hardcoded version.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STRM_WRITER = path.join(ROOT, '..', 'torbox-importer', 'scripts', 'strm-writer.sh');

// ─── Load .env ───────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(ROOT, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const TORBOX_API_URL = 'https://api.torbox.app/v1/api';

// ─── Structured Events ──────────────────────────────────────────────────────
const events = [];
const stageResults = {};

function emit(event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...data,
  };
  events.push(entry);
  console.log(JSON.stringify(entry));
  return entry;
}

function fail(event, data = {}) {
  emit(event, { status: 'failed', ...data });
  console.log('\nCANARY FAILED');
  console.log('Stage results:', JSON.stringify(stageResults, null, 2));
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function findStrm(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findStrm(full);
      if (found) return found;
    } else if (entry.name.endsWith('.strm')) {
      return full;
    }
  }
  return null;
}

// ─── Temp dirs ───────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-'));
const REQUESTS_ROOT = path.join(tmpRoot, 'requests');
const STRM_OUTPUT = process.env.STRM_OUTPUT_PATH || '/home/patrick/hashsucker-data/strm';
fs.mkdirSync(STRM_OUTPUT, { recursive: true });
fs.mkdirSync(path.join(REQUESTS_ROOT, 'incoming'), { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 0: Sample random release from corpus
// ═══════════════════════════════════════════════════════════════════════════════
const sampleStart = Date.now();

const { sampleRandomRelease } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'discovery', 'corpus-sampler.js')).href);

// Retry loop: find a cached release (random sampler may pick uncached ones)
let sample = null;
let cacheCheckAttempts = 0;
const maxCacheAttempts = 5;
while (!sample && cacheCheckAttempts < maxCacheAttempts) {
  cacheCheckAttempts++;
  const candidate = sampleRandomRelease({ dbPath: process.env.DISCOVERY_DB });
  if (!candidate) {
    fail('canary.no_sample', { reason: 'Corpus empty or no valid entries' });
  }
  try {
    const cacheRes = await fetch(
      `${TORBOX_API_URL}/torrents/checkcached?hash=${candidate.infoHash}&format=list`,
      { headers: { Authorization: `Bearer ${TORBOX_API_KEY}` } }
    );
    const cacheData = await cacheRes.json();
    if (cacheData.data?.some(d => d.hash === candidate.infoHash)) {
      sample = candidate;
    }
  } catch (err) {
    // Transient API error — try next candidate
    emit('canary.cache_check_retry', { hash: candidate.infoHash, error: err.message });
  }
}
if (!sample) {
  fail('canary.no_cached_sample', { reason: `No cached release found in ${maxCacheAttempts} attempts` });
}

const { infoHash: KNOWN_HASH, filename: rowFilename, title: rowTitle, size: rowSize, identity } = sample;
const row = { title: rowTitle, filename: rowFilename, size: rowSize };

stageResults.sample = {
  infoHash: KNOWN_HASH,
  filename: row.filename,
  identity: identity ? { mediaId: identity.mediaId, state: identity.resolutionState, confidence: identity.confidence } : null,
  duration: Date.now() - sampleStart,
  cacheCheckAttempts,
};

emit('canary.identity', {
  hash: KNOWN_HASH,
  filename: row.filename,
  size: row.size,
  source: 'corpus_sampler',
  identity: stageResults.sample.identity,
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: TorBox cache check (already validated in sampling loop)
// ═══════════════════════════════════════════════════════════════════════════════
if (!TORBOX_API_KEY) {
  fail('canary.torbox_no_key', { hash: KNOWN_HASH });
}

const cacheRes = await fetch(
  `${TORBOX_API_URL}/torrents/checkcached?hash=${KNOWN_HASH}&format=list`,
  { headers: { Authorization: `Bearer ${TORBOX_API_KEY}` } }
);
let cacheData;
try {
  cacheData = await cacheRes.json();
} catch (err) {
  fail('canary.torbox_cache_error', { hash: KNOWN_HASH, error: err.message });
}

const isCached = cacheData.data?.some(d => d.hash === KNOWN_HASH);
if (!isCached) {
  fail('canary.torbox_not_cached', { hash: KNOWN_HASH });
}

emit('canary.torbox_cache', {
  hash: KNOWN_HASH,
  cached: true,
  status: 'cached',
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: Create torrent in TorBox → resolve torrent_id + file_id
// ═══════════════════════════════════════════════════════════════════════════════
const magnet = `magnet:?xt=urn:btih:${KNOWN_HASH}`;

const createRes = await fetch(`${TORBOX_API_URL}/torrents/createtorrent`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${TORBOX_API_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ magnet }).toString(),
});
let createData;
try {
  createData = await createRes.json();
} catch (err) {
  fail('canary.torrent_create_failed', {
    error: `API returned non-JSON: ${err.message}`,
  });
}

if (!createData.success || !createData.data?.torrent_id) {
  fail('canary.torrent_create_failed', {
    error: createData.detail || createData.error,
  });
}

const torrentId = createData.data.torrent_id;
emit('canary.torrent_created', {
  hash: KNOWN_HASH,
  torrent_id: torrentId,
});

// Poll mylist until torrent appears (TorBox propagation delay)
async function waitForTorrentInList(torrentId, maxRetries = 15, delayMs = 750) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const listRes = await fetch(`${TORBOX_API_URL}/torrents/mylist?bypass_cache=true`, {
        headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
      });
      const listData = await listRes.json();
      const torrent = listData.data?.find((t) => t.id === torrentId);
      if (torrent) return torrent;
    } catch (err) {
      // Transient API error — retry
      emit('canary.mylist_retry', { torrent_id: torrentId, attempt: i, error: err.message });
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return null;
}

const torrent = await waitForTorrentInList(torrentId);

let fileId = null;
let handlingMode = 'stream';

if (!torrent) {
  fail('canary.torrent_not_in_list', { torrent_id: torrentId });
}

const files = torrent.files || [];
if (files.length > 0) {
  const sortedFiles = [...files].sort((a, b) => b.size - a.size);
  fileId = sortedFiles[0].id;
}

emit('canary.files_resolved', {
  hash: KNOWN_HASH,
  torrent_id: torrentId,
  file_id: fileId,
  file_count: files.length,
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: Build handoff → queue
// ═══════════════════════════════════════════════════════════════════════════════
const { createHandoff } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'requests', 'handoff.js')).href);
const { queueHandoff } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'requests', 'queue.js')).href);
const { createRequestIntent } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'requests', 'intent.js')).href);

const intent = identity && identity.mediaId
  ? createRequestIntent({ type: 'series', mediaId: identity.mediaId })
  : createRequestIntent({ type: 'movie', mediaId: 'tt0111161' });

const release = {
  infoHash: KNOWN_HASH,
  fileIndex: null,
  releaseKey: sample.releaseKey,
  title: row.title,
  filename: row.filename,
  size: row.size,
  resolution: '2160p',
  quality: 'BluRay',
  codec: 'x265',
  hdr: 'HDR',
};

const handoffStart = Date.now();

const handoff = createHandoff({
  intent,
  release,
  provider: 'torbox',
  handlingMode,
});

stageResults.handoff = {
  requestId: handoff.requestId,
  hash: KNOWN_HASH,
  handlingMode,
  provider: 'torbox',
  duration: Date.now() - handoffStart,
};

emit('canary.handoff', stageResults.handoff);

const handoffPath = await queueHandoff(handoff, {
  requestDir: path.join(REQUESTS_ROOT, 'incoming'),
});

stageResults.queue = {
  requestId: handoff.requestId,
  path: handoffPath,
};

emit('canary.queued', stageResults.queue);

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3b: Set up resolver state + start local server
// ═══════════════════════════════════════════════════════════════════════════════
const { createDiscoveryCache } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'discovery', 'cache.js')).href);
const { createControlPlaneStore } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'control-plane', 'store.js')).href);
const { createApp } = await import(pathToFileURL(path.join(ROOT, 'src', 'server', 'app.js')).href);

const resolverCache = createDiscoveryCache();
const resolverControlPlane = createControlPlaneStore();

const mediaId = identity && identity.mediaId ? identity.mediaId : 'tt0111161';
const releaseKey = sample.releaseKey;

// Persist media request (required for playback handoff FK)
const requestId = resolverCache.persistMediaRequest(
  {
    mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    source: 'canary',
  },
  [{
    infoHash: KNOWN_HASH,
    fileIndex: null,
    filename: row.filename,
    score: 0.95,
    rank: 1,
    release: { infoHash: KNOWN_HASH, fileIndex: null, releaseKey },
  }]
);

// Persist playback handoff so resolver can find a selection
resolverCache.persistPlaybackHandoff({
  requestId,
  mediaId,
  mediaType: 'movie',
  season: null,
  episode: null,
  releaseKey,
  infoHash: KNOWN_HASH,
  fileIndex: null,
  filename: row.filename,
  provider: 'torbox',
  providerState: 'cached',
  identityTier: 'Verified',
  resolutionState: 'confirmed',
  selectionReason: 'canary selection',
  selectedAt: Date.now(),
});

// Provider observation so selection is usable
resolverCache.appendProviderObservation({
  provider: 'torbox',
  accountScope: 'primary',
  scope: 'candidate',
  infoHash: KNOWN_HASH,
  fileIndex: null,
  state: 'cached',
  kind: 'authoritative',
  observedAt: Date.now(),
  expiresAt: Date.now() + 3600000,
  source: 'canary',
});

// TorBox placement (torrent_id = provider_resource_id)
const placement = resolverControlPlane.recordPlacement({
  provider: 'torbox',
  accountScope: 'primary',
  infoHash: KNOWN_HASH,
  providerResourceId: String(torrentId),
  state: 'ready',
  ownership: 'owned',
  provenance: 'canary',
});

// Provider file inventory (must exist before file mapping)
resolverControlPlane.replaceProviderFileInventory(placement.id, [{
  providerFileId: String(fileId),
  path: `/${row.filename}`,
  name: row.filename,
  size: row.size,
  selected: true,
}], { authoritative: true, complete: true });

// File mapping (releaseKey + placementId → providerFileId)
resolverControlPlane.recordFileMapping({
  infoHash: KNOWN_HASH,
  fileIndex: null,
  fileIndexKey: -1,
  releaseKey,
  placementId: placement.id,
  providerFileId: String(fileId),
  state: 'mapped',
  method: 'canary',
  authoritative: true,
});

// Start local resolver server on ephemeral port
const resolverServer = createApp({ searchCache: resolverCache, controlPlaneStore: resolverControlPlane });
await new Promise((resolve, reject) => {
  resolverServer.listen(0, '127.0.0.1', resolve);
  resolverServer.on('error', reject);
});
const resolverPort = resolverServer.address().port;
const resolverBaseUrl = `http://127.0.0.1:${resolverPort}`;

stageResults.resolverSetup = {
  mediaId,
  releaseKey,
  hash: KNOWN_HASH,
  torrentId: String(torrentId),
  fileId: String(fileId),
  resolverBaseUrl,
  resolverPort,
};

emit('canary.resolver_setup', stageResults.resolverSetup);

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: Build stream URL (local resolver)
// ═══════════════════════════════════════════════════════════════════════════════
const streamUrl = `${resolverBaseUrl}/stream/movie/${mediaId}`;

emit('canary.stream_url', {
  hash: KNOWN_HASH,
  torrent_id: torrentId,
  file_id: fileId,
  url: streamUrl,
  resolver: true,
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: Materialize .strm
// ═══════════════════════════════════════════════════════════════════════════════
const titleForStrm = row.title.replace(/^\[.*?\]\s*/, '').replace(/\.[a-zA-Z]{3,4}$/, '').trim();
const yearMatch = row.title.match(/\b(19|20)\d{2}\b/);
const yearStr = yearMatch ? yearMatch[0] : '';

const materializationStart = Date.now();

// Compute expected .strm path (mirrors strm-writer.sh output structure)
function sanitize(s) {
  return s.replace(/\//g, '_').replace(/:/g, '_').replace(/\?/g, '_')
    .replace(/"/g, '_').replace(/\*/g, '_').replace(/</g, '_')
    .replace(/>/g, '_');
}
const safeTitle = sanitize(titleForStrm);
const yearPart = yearStr ? ` (${yearStr})` : '';
const expectedStrmPath = path.join(STRM_OUTPUT, 'Movies', `${safeTitle}${yearPart}`, `${safeTitle}${yearPart}.strm`);

// Idempotency: if the expected .strm already exists with correct content, treat as success
let strmFile = null;
if (fs.existsSync(expectedStrmPath)) {
  const existingContent = fs.readFileSync(expectedStrmPath, 'utf8').trim();
  if (existingContent === streamUrl) {
    strmFile = expectedStrmPath;
    stageResults.materialization = {
      path: strmFile,
      url: streamUrl,
      size: existingContent.length,
      duration: Date.now() - materializationStart,
      idempotent: true,
    };
    emit('canary.strm_written', stageResults.materialization);
  } else {
    fail('canary.strm_content_mismatch', {
      expected: streamUrl,
      actual: existingContent.slice(0, 100),
      path: expectedStrmPath,
    });
  }
} else {
  const strmResult = spawnSync('sh', [
    STRM_WRITER,
    titleForStrm,
    yearStr,
    'movie',
    streamUrl,
    STRM_OUTPUT,
  ], { encoding: 'utf8' });

  if (strmResult.status !== 0) {
    fail('canary.materialize_failed', {
      error: strmResult.stderr.trim() || `exit code ${strmResult.status}`,
    });
  }

  // Find the newly written .strm
  if (fs.existsSync(expectedStrmPath)) {
    strmFile = expectedStrmPath;
  } else {
    // Fallback: search for any .strm (shouldn't happen)
    strmFile = findStrm(STRM_OUTPUT);
  }

  if (!strmFile) {
    fail('canary.strm_not_found', {});
  }

  // Verify content
  const strmContent = fs.readFileSync(strmFile, 'utf8').trim();
  if (strmContent !== streamUrl) {
    fail('canary.strm_content_mismatch', {
      expected: streamUrl,
      actual: strmContent.slice(0, 100),
    });
  }

  stageResults.materialization = {
    path: strmFile,
    url: streamUrl,
    size: strmContent.length,
    duration: Date.now() - materializationStart,
  };

  emit('canary.strm_written', stageResults.materialization);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7: Validate resolver redirect
// ═══════════════════════════════════════════════════════════════════════════════
const redirectStart = Date.now();

// GET the resolver URL from the local server
const redirectRes = await fetch(streamUrl, { redirect: 'manual' });

// Must be HTTP 307
if (redirectRes.status !== 307) {
  fail('canary.redirect_not_307', {
    status: redirectRes.status,
    expectedStatus: 307,
    mediaId,
    releaseKey,
  });
}

// Location must be a valid TorBox requestdl permalink
const location = redirectRes.headers.get('location');
if (!location) {
  fail('canary.redirect_no_location', {
    status: redirectRes.status,
    mediaId,
    releaseKey,
  });
}

const locationUrl = new URL(location);
if (!locationUrl.pathname.includes('torrents/requestdl')) {
  fail('canary.redirect_invalid_location', {
    location: location.slice(0, 100),
    reason: 'missing requestdl path',
  });
}
if (locationUrl.searchParams.get('torrent_id') !== String(torrentId)) {
  fail('canary.redirect_wrong_torrent', {
    expectedTorrentId: String(torrentId),
    actualTorrentId: locationUrl.searchParams.get('torrent_id'),
  });
}
if (locationUrl.searchParams.get('file_id') !== String(fileId)) {
  fail('canary.redirect_wrong_file', {
    expectedFileId: String(fileId),
    actualFileId: locationUrl.searchParams.get('file_id'),
  });
}
if (!locationUrl.searchParams.has('token')) {
  fail('canary.redirect_missing_token', {
    location: location.slice(0, 100),
  });
}

// Capture revalidation telemetry headers
const availabilitySource = redirectRes.headers.get('x-availability-source');
const providerCheckOccurred = redirectRes.headers.get('x-provider-check-occurred');

stageResults.redirect = {
  status: redirectRes.status,
  location,
  mediaId,
  releaseKey,
  hash: KNOWN_HASH,
  torrentId: String(torrentId),
  fileId: String(fileId),
  availabilitySource,
  providerCheckOccurred,
  duration: Date.now() - redirectStart,
};

emit('canary.redirect', stageResults.redirect);

// Validate fresh path: zero provider checks
if (availabilitySource === 'stored-fresh' && providerCheckOccurred === 'false') {
  emit('canary.revalidation_fresh_path', {
    message: 'Fresh observation path validated — zero provider checks',
    availabilitySource,
    providerCheckOccurred,
  });
} else {
  emit('canary.revalidation_path', {
    message: 'Revalidation path used',
    availabilitySource,
    providerCheckOccurred,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════════════
const totalDuration = Date.now() - sampleStart;

const result = {
  status: 'passed',
  eventsEmitted: events.length,
  artifact: stageResults.materialization?.path,
  url: streamUrl,
  mediaId,
  releaseKey,
  hash: KNOWN_HASH,
  provider: 'torbox',
  selectedFileId: String(fileId),
  resolverUrl: streamUrl,
  redirectStatus: stageResults.redirect?.status,
  sample: stageResults.sample,
  handoff: stageResults.handoff,
  queue: stageResults.queue,
  resolverSetup: stageResults.resolverSetup,
  materialization: stageResults.materialization,
  redirect: stageResults.redirect,
  totalDuration,
};

console.log('\nCANARY PASSED');
console.log(JSON.stringify(result, null, 2));

// Clean up resolver server + DBs
resolverServer.close();
resolverCache.close();
resolverControlPlane.close();

// Clean up temp dir (but not the .strm)
fs.rmSync(tmpRoot, { recursive: true, force: true });

process.exit(0);
