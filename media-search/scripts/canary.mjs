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

const sample = sampleRandomRelease({ dbPath: process.env.DISCOVERY_DB });
if (!sample) {
  fail('canary.no_sample', { reason: 'Corpus empty or no valid entries' });
}

const { infoHash: KNOWN_HASH, filename: rowFilename, title: rowTitle, size: rowSize, identity } = sample;
const row = { title: rowTitle, filename: rowFilename, size: rowSize };

stageResults.sample = {
  infoHash: KNOWN_HASH,
  filename: row.filename,
  identity: identity ? { mediaId: identity.mediaId, state: identity.resolutionState, confidence: identity.confidence } : null,
  duration: Date.now() - sampleStart,
};

emit('canary.identity', {
  hash: KNOWN_HASH,
  filename: row.filename,
  size: row.size,
  source: 'corpus_sampler',
  identity: stageResults.sample.identity,
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: TorBox cache check
// ═══════════════════════════════════════════════════════════════════════════════
if (!TORBOX_API_KEY) {
  fail('canary.torbox_no_key', { hash: KNOWN_HASH });
}

const cacheRes = await fetch(
  `${TORBOX_API_URL}/torrents/checkcached?hash=${KNOWN_HASH}&format=list`,
  { headers: { Authorization: `Bearer ${TORBOX_API_KEY}` } }
);
const cacheData = await cacheRes.json();

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
const createData = await createRes.json();

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

// Get file inventory
const listRes = await fetch(`${TORBOX_API_URL}/torrents/mylist?bypass_cache=true`, {
  headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
});
const listData = await listRes.json();
const torrent = listData.data?.find((t) => t.id === torrentId);

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
// STEP 4: Build stream URL
// ═══════════════════════════════════════════════════════════════════════════════
const streamUrl = fileId !== null
  ? `${TORBOX_API_URL}/torrents/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrentId}&file_id=${fileId}&redirect=true`
  : `${TORBOX_API_URL}/torrents/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrentId}&redirect=true`;

emit('canary.stream_url', {
  hash: KNOWN_HASH,
  torrent_id: torrentId,
  file_id: fileId,
  url: streamUrl,
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: Materialize .strm
// ═══════════════════════════════════════════════════════════════════════════════
const titleForStrm = row.title.replace(/^\[.*?\]\s*/, '').replace(/\.[a-zA-Z]{3,4}$/, '').trim();
const yearMatch = row.title.match(/\b(19|20)\d{2}\b/);
const yearStr = yearMatch ? yearMatch[0] : '';

const materializationStart = Date.now();

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

// Find the .strm file
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

const strmFile = findStrm(STRM_OUTPUT);
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

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════════════
const totalDuration = Date.now() - sampleStart;

const result = {
  status: 'passed',
  eventsEmitted: events.length,
  artifact: strmFile,
  url: streamUrl,
  sample: stageResults.sample,
  handoff: stageResults.handoff,
  queue: stageResults.queue,
  materialization: stageResults.materialization,
  totalDuration,
};

console.log('\nCANARY PASSED');
console.log(JSON.stringify(result, null, 2));

// Clean up temp dir (but not the .strm)
fs.rmSync(tmpRoot, { recursive: true, force: true });

process.exit(0);
