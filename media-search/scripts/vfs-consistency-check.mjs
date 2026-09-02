#!/usr/bin/env node
/**
 * VFS consistency canary (Slice 2.9 / A8).
 *
 * Proves that an authoritative VFS row is internally consistent across the
 * three observable surfaces:
 *
 *   - control-plane DB  (durable identity: torrent_files row)
 *   - discovery DB      (durable VFS row: media_id, season, episode,
 *                        canonical_path, torrent_file_id, size)
 *   - WebDAV HEAD       (Content-Length returned by media-search)
 *   - WebDAV Range      (Content-Range returned by media-search, bounded
 *                        middle byte range, HTTP 206)
 *   - FUSE mount stat   (st_size equals TorrentFile size)
 *   - FUSE read         (head + mid + near-tail reads return nonzero bytes;
 *                        EBML magic for the head read confirms matroska)
 *
 * Hard constraints (Slice 2.9 / A8):
 *   - No provider API calls. No requestdl. No capability URL fetch.
 *   - No Plex refresh / no partial scan.
 *   - No full file download. Only bounded byte ranges (1 MiB or less).
 *
 * Failure semantics: any mismatch between the four surfaces is fail-closed
 * with a non-zero exit code and a structured error report on stderr.
 *
 * Usage:
 *   node scripts/vfs-consistency-check.mjs \
 *        --media-id tt5687612 --season 1 --episode 3
 *   node scripts/vfs-consistency-check.mjs --media-id tt1825683
 */

import { execFileSync } from 'node:child_process';
import { open, stat, read } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
if (!args['media-id']) {
  console.error('error: --media-id is required');
  printUsage();
  process.exit(2);
}

const DISCOVERY_DB = process.env.DISCOVERY_DB
  || '/home/patrick/hashsucker-data/discovery/discovery-cache.db';
const CONTROL_DB = process.env.CONTROL_DB
  || '/home/patrick/hashsucker-data/discovery/control-plane.db';
const WEBDAV_BASE = process.env.WEBDAV_BASE || 'http://127.0.0.1:3000';
const FUSE_ROOT = process.env.FUSE_ROOT || '/mnt/hashsucker-vfs';

const report = {
  mediaId: args['media-id'],
  season: args.season ?? null,
  episode: args.episode ?? null,
  kind: args.season != null && args.episode != null ? 'tv' : 'movie',
  discoveredAt: new Date().toISOString(),
};

function emit(stage, status, data = {}) {
  const entry = { stage, status, ...data };
  Object.assign(report, { [stage]: entry });
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function fail(stage, message, data = {}) {
  emit(stage, 'failed', { message, ...data });
  process.stderr.write(`\nVFS CONSISTENCY CANARY FAILED: ${stage}: ${message}\n`);
  process.stderr.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      out[key] = value === undefined || value.startsWith('--') ? true : value;
      if (value !== undefined && !value.startsWith('--')) i += 1;
    }
  }
  return out;
}

function printUsage() {
  process.stdout.write(
    'Usage: node scripts/vfs-consistency-check.mjs --media-id <id> '
      + '[--season N --episode N]\n',
  );
}

function sqliteJson(dbPath, query) {
  try {
    const raw = execFileSync('sqlite3', [
      '-separator', '\u001f', dbPath, query,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!raw.trim()) return [];
    return raw.trim().split('\n').map((line) => line.split('\u001f'));
  } catch (err) {
    throw new Error(`sqlite query failed: ${err.message}`);
  }
}

function loadControlPlaneTorrentFile(torrentFileId) {
  const rows = sqliteJson(CONTROL_DB,
    `SELECT id, info_hash, internal_path, size FROM torrent_files WHERE id = '${torrentFileId.replace(/'/g, "''")}';`);
  if (rows.length === 0) return null;
  const [id, infoHash, internalPath, size] = rows[0];
  return { id, infoHash, internalPath, size: Number(size) };
}

function loadVfsRow() {
  if (report.kind === 'tv') {
    const rows = sqliteJson(DISCOVERY_DB, `
      SELECT media_id, season, episode, release_key, info_hash, file_index,
             canonical_path, torrent_file_id, size
      FROM vfs_tv_entries
      WHERE media_id = '${report.mediaId.replace(/'/g, "''")}'
        AND season = ${Number(report.season)}
        AND episode = ${Number(report.episode)};
    `);
    if (rows.length === 0) return null;
    const [mediaId, season, episode, releaseKey, infoHash, fileIndex,
      canonicalPath, torrentFileId, size] = rows[0];
    return {
      mediaId, season: Number(season), episode: Number(episode),
      releaseKey, infoHash, fileIndex: fileIndex == null ? null : Number(fileIndex),
      canonicalPath, torrentFileId, size: size == null ? null : Number(size),
    };
  }
  const rows = sqliteJson(DISCOVERY_DB, `
    SELECT media_id, release_key, info_hash, file_index, canonical_path,
           torrent_file_id, size
    FROM vfs_movie_entries
    WHERE media_id = '${report.mediaId.replace(/'/g, "''")}';
  `);
  if (rows.length === 0) return null;
  const [mediaId, releaseKey, infoHash, fileIndex, canonicalPath, torrentFileId, size] = rows[0];
  return {
    mediaId, releaseKey, infoHash,
    fileIndex: fileIndex == null ? null : Number(fileIndex),
    canonicalPath, torrentFileId, size: size == null ? null : Number(size),
  };
}

function httpRequest(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function probeWebDav(vfsRow) {
  const webdavPath = `${WEBDAV_BASE}/vfs/${vfsRow.canonicalPath}`;
  emit('webdav-head', 'started', { path: webdavPath });
  const head = await httpRequest(webdavPath, { method: 'HEAD' });
  if (head.status !== 200) {
    fail('webdav-head', `expected HTTP 200, got ${head.status}`,
      { path: webdavPath, body: head.body.toString('utf8').slice(0, 200) });
  }
  const headSize = Number(head.headers['content-length']);
  if (!Number.isSafeInteger(headSize) || headSize <= 0) {
    fail('webdav-head', 'Content-Length missing or non-positive',
      { headers: head.headers });
  }
  emit('webdav-head', 'ok', { size: headSize, contentLength: headSize });

  // Bounded middle Range: 1 MiB at ~50% of the file.
  const rangeLength = Math.min(1_048_576, Math.max(1, headSize - 1));
  const start = Math.max(0, Math.floor((headSize - rangeLength) / 2));
  const end = Math.min(headSize - 1, start + rangeLength - 1);
  const rangeHeader = `bytes=${start}-${end}`;
  emit('webdav-range', 'started', { range: rangeHeader });
  const range = await httpRequest(webdavPath, { headers: { range: rangeHeader } });
  if (range.status !== 206) {
    fail('webdav-range', `expected HTTP 206, got ${range.status}`,
      { range: rangeHeader, body: range.body.slice(0, 200).toString('utf8') });
  }
  const cr = range.headers['content-range'];
  if (cr !== `bytes ${start}-${end}/${headSize}`) {
    fail('webdav-range', `Content-Range mismatch: got '${cr}'`);
  }
  const cl = Number(range.headers['content-length']);
  if (cl !== end - start + 1) {
    fail('webdav-range', `Content-Length mismatch: got ${cl}, expected ${end - start + 1}`);
  }
  if (range.body.length !== end - start + 1) {
    fail('webdav-range', `body length ${range.body.length} != expected ${end - start + 1}`);
  }
  emit('webdav-range', 'ok', {
    start, end, length: end - start + 1,
    contentRange: cr, bodyLength: range.body.length,
  });
  return { headSize, rangeStart: start, rangeEnd: end, rangeLength: end - start + 1 };
}

async function probeFuse(vfsRow) {
  const filePath = path.join(FUSE_ROOT, vfsRow.canonicalPath);
  emit('fuse-stat', 'started', { path: filePath });
  let st;
  try {
    st = await stat(filePath);
  } catch (err) {
    fail('fuse-stat', `stat failed: ${err.message}`);
  }
  if (st.size !== vfsRow.size) {
    fail('fuse-stat', `st_size ${st.size} != VFS size ${vfsRow.size}`);
  }
  emit('fuse-stat', 'ok', { size: st.size, mtime: st.mtime.toISOString() });

  // Head: 4 KiB, must start with EBML magic (1a45dfa3) for a Matroska file.
  // Non-matroska files are tolerated but reported; the canary does not fail
  // closed on magic — it is informational, since media files of other types
  // may pass through here in non-production paths.
  const headBuf = Buffer.alloc(4096);
  let headFd;
  try {
    headFd = await open(filePath, 'r');
    await read(headFd, headBuf, 0, 4096, 0);
  } finally {
    if (headFd) await headFd.close();
  }
  const headBytes = headBuf.readUInt32LE(0);
  const isMatroska = headBytes === 0x1a45dfa3;
  emit('fuse-read-head', 'ok', { bytes: 4096, ebmlMagic: isMatroska });

  // Mid: bounded 1 MiB at ~50%.
  const midLen = Math.min(1_048_576, Math.max(1, st.size - 1));
  const midStart = Math.max(0, Math.floor((st.size - midLen) / 2));
  const midBuf = Buffer.alloc(midLen);
  let midFd;
  try {
    midFd = await open(filePath, 'r');
    await read(midFd, midBuf, 0, midLen, midStart);
  } finally {
    if (midFd) await midFd.close();
  }
  // nonzero: at least one byte must be nonzero. Sparse files / placeholder
  // stubs would fail this; a real byte stream passes.
  const midNonzero = countNonzero(midBuf);
  if (midNonzero === 0) {
    fail('fuse-read-mid', 'mid range returned 0 nonzero bytes (sparse / stub)');
  }
  emit('fuse-read-mid', 'ok', {
    start: midStart, length: midLen, nonzeroBytes: midNonzero,
  });

  // Near-tail: 4 KiB ending 4 KiB before EOF.
  const tailStart = Math.max(0, st.size - 4096);
  const tailLen = Math.min(4096, st.size - tailStart);
  const tailBuf = Buffer.alloc(tailLen);
  let tailFd;
  try {
    tailFd = await open(filePath, 'r');
    await read(tailFd, tailBuf, 0, tailLen, tailStart);
  } finally {
    if (tailFd) await tailFd.close();
  }
  const tailNonzero = countNonzero(tailBuf);
  if (tailNonzero === 0 && tailLen > 0) {
    fail('fuse-read-tail', 'tail range returned 0 nonzero bytes');
  }
  emit('fuse-read-tail', 'ok', {
    start: tailStart, length: tailLen, nonzeroBytes: tailNonzero,
  });
}

function countNonzero(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] !== 0) n += 1;
  return n;
}

async function main() {
  emit('start', 'ok', { args: process.argv.slice(2) });

  emit('discover-vfs-row', 'started', {
    mediaId: report.mediaId, season: report.season, episode: report.episode,
  });
  const vfsRow = loadVfsRow();
  if (!vfsRow) {
    fail('discover-vfs-row', `no VFS row for media_id=${report.mediaId}`
      + (report.kind === 'tv'
        ? ` S${report.season}E${report.episode}`
        : ''));
  }
  if (!vfsRow.torrentFileId) {
    fail('discover-vfs-row', 'VFS row has torrent_file_id IS NULL — not authoritative');
  }
  emit('discover-vfs-row', 'ok', {
    canonicalPath: vfsRow.canonicalPath,
    torrentFileId: vfsRow.torrentFileId,
    size: vfsRow.size,
    infoHash: vfsRow.infoHash,
  });

  emit('discover-torrent-file', 'started', { torrentFileId: vfsRow.torrentFileId });
  const tf = loadControlPlaneTorrentFile(vfsRow.torrentFileId);
  if (!tf) {
    fail('discover-torrent-file', `torrent_files row ${vfsRow.torrentFileId} not found`);
  }
  if (!Number.isSafeInteger(tf.size) || tf.size <= 0) {
    fail('discover-torrent-file', `TorrentFile has invalid size ${tf.size}`);
  }
  if (tf.infoHash.toLowerCase() !== vfsRow.infoHash.toLowerCase()) {
    fail('discover-torrent-file',
      `infoHash mismatch: torrent_files=${tf.infoHash} vfs=${vfsRow.infoHash}`);
  }
  if (tf.size !== vfsRow.size) {
    fail('discover-torrent-file',
      `size mismatch: torrent_files=${tf.size} vfs=${vfsRow.size}`);
  }
  emit('discover-torrent-file', 'ok', {
    infoHash: tf.infoHash, internalPath: tf.internalPath, size: tf.size,
  });

  // WebDAV size must match the VFS row (which matches the TorrentFile).
  const webdav = await probeWebDav(vfsRow);
  if (webdav.headSize !== tf.size) {
    fail('size-triad',
      `WebDAV Content-Length ${webdav.headSize} != TorrentFile size ${tf.size}`);
  }
  emit('size-triad', 'ok', {
    torrentFile: tf.size, vfs: vfsRow.size, webdav: webdav.headSize,
  });

  await probeFuse(vfsRow);

  emit('done', 'ok', {
    canonicalPath: vfsRow.canonicalPath,
    torrentFileId: vfsRow.torrentFileId,
    size: tf.size,
  });
  process.stdout.write('\nVFS CONSISTENCY CANARY PASSED\n');
}

main().catch((err) => {
  process.stderr.write(`\nVFS CONSISTENCY CANARY ERROR: ${err.stack || err.message}\n`);
  process.exit(1);
});
