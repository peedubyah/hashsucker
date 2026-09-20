/**
 * Generic-download importer handoff (download-handoff tranche).
 *
 * Staged bytes are a transfer-of-ownership boundary, not a dead end.
 * Transfer uses the same watched-directory mechanics as the existing
 * torbox-importer queue (atomic write+rename, mv between state dirs),
 * but on a DEDICATED tree under the download root so the TorBox
 * importer never sees these manifests:
 *
 *   <root>/.handoff/outbox/    producer-written, awaiting pickup
 *   <root>/.handoff/accepted/  consumer took ownership
 *   <root>/.handoff/done/      consumer finished (may note completedPath)
 *   <root>/.handoff/failed/    consumer rejected (may note error)
 *
 * Consumers are external and pluggable (shell loop, Arr ManualImport
 * folder flow, smart HTTP-ACK client). Staged-file end of life is the
 * staged-cleanup slice: HashSucker retains the file through pending /
 * accepted / failed, and after an explicit completed ACK it unlinks the
 * staging copy once a short grace elapses (a consumer atomic move simply
 * converges — absence at cleanup time is success, not corruption).
 * HashSucker never touches the consumer's destination copy.
 *
 * Handoff id is deterministic per (request, version):
 * `dl-<downloadRequestId>-v<version>`. Only the row's current version
 * is live; superseded manifests are ignored by version guard. No
 * timers on transfer: pending pickup has no deadline and causes no
 * storm; completion is observed by poll + HTTP ACKs, and only an
 * explicit re-handoff creates a new version.
 */
import fs from 'node:fs';
import path from 'node:path';

export const HANDOFF_STATES = Object.freeze({
  NONE: 'none',
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

export const HANDOFF_DIRS = Object.freeze({
  [HANDOFF_STATES.PENDING]: 'outbox',
  [HANDOFF_STATES.ACCEPTED]: 'accepted',
  [HANDOFF_STATES.COMPLETED]: 'done',
  [HANDOFF_STATES.FAILED]: 'failed',
});

export function handoffIdFor(downloadRequestId, version) {
  return `dl-${downloadRequestId}-v${version}`;
}

/** Extract the download request id from a handoff id (null when malformed). */
export function parseHandoffRequestId(handoffId) {
  const s = String(handoffId || '');
  if (!s.startsWith('dl-')) return null;
  const cut = s.lastIndexOf('-v');
  if (cut <= 3) return null;
  const reqId = s.slice(3, cut);
  const ver = Number(s.slice(cut + 2));
  if (!reqId || !Number.isSafeInteger(ver) || ver < 1) return null;
  return reqId;
}

export function handoffDirs(root) {
  return {
    root: path.join(root, '.handoff'),
    outbox: path.join(root, '.handoff', 'outbox'),
    accepted: path.join(root, '.handoff', 'accepted'),
    done: path.join(root, '.handoff', 'done'),
    failed: path.join(root, '.handoff', 'failed'),
  };
}

export function ensureHandoffDirs(root) {
  const dirs = handoffDirs(root);
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

/** Build the manifest from a staged download row (+ optional quality). */
export function buildHandoffManifest(row, version, { quality = null, nowMs = Date.now() } = {}) {
  if (!row || row.status !== 'staged') throw new Error('handoff requires a staged download');
  if (!row.stagedPath) throw new Error('handoff requires a staged path');
  return {
    handoffId: handoffIdFor(row.downloadRequestId, version),
    version,
    downloadRequestId: row.downloadRequestId,
    mediaType: row.mediaType,
    mediaId: row.mediaId,
    season: row.season ?? null,
    episode: row.episode ?? null,
    title: row.title ?? null,
    year: row.year ?? null,
    stagedPath: row.stagedPath,
    torrentFileId: row.torrentFileId ?? null,
    expectedSize: row.expectedSize ?? null,
    qualityProfile: row.qualityProfile ?? null,
    ...(quality ? { quality } : {}),
    createdAt: nowMs,
  };
}

/** Atomic manifest write (tmp + rename, existing queue pattern). */
export function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `${manifest.handoffId}.json`);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

export function readManifest(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** List manifests in a state dir: [{ handoffId, version, downloadRequestId, file, manifest }]. */
export function listManifests(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const file = path.join(dir, name);
    const manifest = readManifest(file);
    if (!manifest || typeof manifest.handoffId !== 'string') continue;
    out.push({
      handoffId: manifest.handoffId,
      version: manifest.version ?? null,
      downloadRequestId: manifest.downloadRequestId ?? null,
      file,
      manifest,
    });
  }
  return out;
}

/**
 * Mirror an ACK into the dir tree (best-effort): move the manifest to
 * the matching state dir so file-drop polling and HTTP ACKs converge
 * on the same observable layout. Missing file (already moved by a
 * racing dumb consumer) is tolerated.
 */
export function mirrorManifestState(root, handoffId, toState) {
  const dirs = handoffDirs(root);
  const target = { accepted: dirs.accepted, completed: dirs.done, failed: dirs.failed }[toState];
  if (!target) return null;
  const name = `${handoffId}.json`;
  for (const dir of [dirs.outbox, dirs.accepted, dirs.done, dirs.failed]) {
    const from = path.join(dir, name);
    if (from === path.join(target, name)) return from;
    try {
      fs.accessSync(from);
    } catch {
      continue;
    }
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.renameSync(from, path.join(target, name));
      return path.join(target, name);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Reconcile transfer dirs against rows (poll backstop for dumb
 * consumers). Idempotent: only advances rows whose current handoff id
 * matches the manifest; superseded versions are ignored. Returns
 * counts for logs. Never resubmits, never deletes.
 */
export function pollHandoffDirs({ root, store, log = () => {} } = {}) {
  if (!root || !store) throw new Error('pollHandoffDirs requires root + store');
  const dirs = handoffDirs(root);
  const counts = { accepted: 0, completed: 0, failed: 0, ignored: 0 };
  const apply = (entry, state) => {
    const row = entry.downloadRequestId ? store.get(entry.downloadRequestId) : null;
    if (!row || row.handoffId !== entry.handoffId) {
      counts.ignored++;
      return;
    }
    if (row.handoffState === state) return;
    const detail = state === 'completed'
      ? (entry.manifest.completedPath ? `completed at ${entry.manifest.completedPath}` : 'consumer completed')
      : (state === 'failed' ? (entry.manifest.error || 'consumer rejected') : null);
    const res = store.applyHandoffEvent(row.downloadRequestId, entry.handoffId, { state, detail });
    if (res.applied) {
      counts[state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'accepted']++;
      log(`handoff ${entry.handoffId} -> ${state}`);
    } else {
      counts.ignored++;
    }
  };
  for (const entry of listManifests(dirs.accepted)) apply(entry, 'accepted');
  for (const entry of listManifests(dirs.done)) apply(entry, 'completed');
  for (const entry of listManifests(dirs.failed)) apply(entry, 'failed');
  return counts;
}
