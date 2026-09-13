/**
 * Rollout readiness diagnostics.
 *
 * Answers "can this system serve households?" without SQLite archaeology:
 * storage, data-plane, providers, consumers, publication, and lifecycle
 * state in one compact payload. No UI; logs + JSON only.
 *
 * Rules:
 * - Cheap checks only: single-hash cache probe, account-info calls,
 *   public/info endpoints, local filesystem stats. Never a full
 *   inventory scan or torrent-list download.
 * - Secrets never enter the output (presence booleans only). The
 *   configured credentials are used for authenticated probes but only
 *   endpoint reachability and HTTP status shape the result.
 * - Optional integrations are never fatal: unconfigured → skipped,
 *   broken → degraded with a distinct reason.
 * - Status: not_ready (fatal: DBs, STRM writability, data-plane),
 *   degraded (provider/consumer/publication non-fatal errors),
 *   ready (possibly with warnings).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const FETCH_TIMEOUT_MS = 4000;

function timedFetch(fetchFn, url, options = {}) {
  const { timeoutMs, ...rest } = options;
  return fetchFn(url, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs ?? FETCH_TIMEOUT_MS),
  });
}

function redactUrl(url) {
  // Host + path only; never credentials, query, or token material.
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '<invalid-url>';
  }
}

async function checkFileWritable(dir, tag) {
  try {
    await fs.access(dir, fs.constants.W_OK);
  } catch {
    return { state: 'error', detail: `${tag} root not writable` };
  }
  const probe = path.join(dir, `.hs-write-probe-${process.pid}`);
  try {
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.unlink(probe);
    return { state: 'ok', detail: `${tag} root writable` };
  } catch (err) {
    return { state: 'error', detail: `${tag} probe failed` };
  }
}

async function checkDbFile(envValue, tag) {
  if (!envValue || envValue === ':memory:') {
    return { state: 'warning', detail: `${tag}: ${envValue ? 'in-memory' : 'not configured'}` };
  }
  try {
    await fs.access(envValue, fs.constants.R_OK | fs.constants.W_OK);
    const stat = await fs.stat(envValue);
    if (!stat.isFile()) return { state: 'error', detail: `${tag}: not a file` };
    return { state: 'ok', detail: `${tag}: readable/writable` };
  } catch {
    return { state: 'error', detail: `${tag}: not accessible` };
  }
}

async function checkDataPlane(dataPlaneUrl, fetchFn) {
  if (!dataPlaneUrl) return { state: 'error', detail: 'data-plane URL not configured' };
  try {
    const response = await timedFetch(fetchFn, `${redactUrl(dataPlaneUrl)}/metrics`);
    if (!response.ok) return { state: 'error', detail: `data-plane HTTP ${response.status}` };
    return { state: 'ok', detail: 'data-plane reachable' };
  } catch (err) {
    return { state: 'error', detail: 'data-plane unreachable' };
  }
}

function classifyHttpError(err, service) {
  const message = String(err?.message ?? err);
  const status = err?.status;
  if (status === 401 || status === 403 || /401|unauthorized/i.test(message)) {
    return { state: 'error', reason: `${service}_AUTH_FAILED`, detail: `${service}: credential rejected` };
  }
  if (status === 429 || /429|rate/i.test(message)) {
    return { state: 'error', reason: `${service}_RATE_LIMITED`, detail: `${service}: rate limited` };
  }
  return { state: 'error', reason: `${service}_UNREACHABLE`, detail: `${service}: unreachable` };
}

async function checkTorBox(env, fetchFn) {
  if (!env.TORBOX_API_KEY) return { state: 'skipped', detail: 'TORBOX_API_KEY not set' };
  try {
    const params = new URLSearchParams({ format: 'object', list_files: 'false' });
    params.append('hash', '0'.repeat(40));
    const response = await timedFetch(
      fetchFn,
      `https://api.torbox.app/v1/api/torrents/checkcached?${params}`,
      {
        headers: {
          Authorization: `Bearer ${env.TORBOX_API_KEY}`,
          Accept: 'application/json',
          'User-Agent': 'media-search/0.1.0',
        },
        timeoutMs: FETCH_TIMEOUT_MS,
      },
    );
    if (!response.ok) {
      const err = new Error(`TorBox HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return { state: 'ok', detail: 'TorBox reachable, credential accepted' };
  } catch (err) {
    return classifyHttpError(err, 'TORBOX');
  }
}

async function checkRealDebrid(env, fetchFn, clientFactory) {
  if (!env.REALDEBRID_API_KEY) return { state: 'skipped', detail: 'REALDEBRID_API_KEY not set' };
  try {
    const client = clientFactory({ apiKey: env.REALDEBRID_API_KEY });
    await client.validateAccount();
    return { state: 'ok', detail: 'Real-Debrid reachable, credential accepted' };
  } catch (err) {
    return classifyHttpError(err, 'REALDEBRID');
  }
}

async function checkJellyfin(env, fetchFn) {
  if (!env.JELLYFIN_URL || !env.JELLYFIN_API_KEY) {
    return { state: 'skipped', detail: 'Jellyfin not configured' };
  }
  const base = redactUrl(env.JELLYFIN_URL);
  const key = env.JELLYFIN_API_KEY;
  const authed = async (p) => timedFetch(
    fetchFn,
    `${base}${p}${p.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`,
  );
  try {
    const pub = await timedFetch(fetchFn, `${base}/System/Info/Public`);
    if (!pub.ok) throw Object.assign(new Error(`Jellyfin HTTP ${pub.status}`), { status: pub.status });
  } catch (err) {
    return { state: 'error', reason: 'JELLYFIN_UNREACHABLE', detail: 'Jellyfin unreachable', endpoint: base };
  }
  let realtime = null;
  try {
    const response = await authed('/Library/VirtualFolders');
    if (!response.ok) {
      const err = new Error(`Jellyfin HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const libs = await response.json();
    realtime = {};
    for (const lib of libs) {
      const monitor = lib.LibraryOptions?.EnableRealtimeMonitor;
      if (typeof monitor === 'boolean') {
        realtime[lib.Name || lib.ItemId || 'library'] = {
          realtimeMonitor: monitor,
          locations: (lib.Locations || []).length,
        };
      }
    }
  } catch (err) {
    return {
      state: 'error', reason: 'JELLYFIN_AUTH_FAILED', detail: 'Jellyfin credential rejected', endpoint: base,
    };
  }
  const warnings = [];
  for (const [name, info] of Object.entries(realtime)) {
    if (info.realtimeMonitor === false) {
      warnings.push(
        `Jellyfin ${name} library reachable, but realtime filesystem monitoring is disabled. `
        + 'New HashSucker STRM files may not appear until scheduled scan.',
      );
    }
  }
  return {
    state: 'ok',
    detail: 'Jellyfin reachable, credential accepted',
    endpoint: base,
    realtimeMonitor: realtime,
    warnings,
  };
}

async function checkPlex(env, fetchFn) {
  if (!env.PLEX_URL || !env.PLEX_TOKEN) {
    return { state: 'skipped', detail: 'Plex not configured' };
  }
  const base = redactUrl(env.PLEX_URL);
  try {
    const identity = await timedFetch(fetchFn, `${base}/identity`);
    if (!identity.ok) throw Object.assign(new Error(`Plex HTTP ${identity.status}`), { status: identity.status });
  } catch (err) {
    return { state: 'error', reason: 'PLEX_UNREACHABLE', detail: 'Plex unreachable', endpoint: base };
  }
  try {
    const sections = await timedFetch(fetchFn, `${base}/library/sections`, {
      headers: { 'X-Plex-Token': env.PLEX_TOKEN, Accept: 'application/json' },
    });
    if (!sections.ok) {
      const err = new Error(`Plex HTTP ${sections.status}`);
      err.status = sections.status;
      throw err;
    }
    return { state: 'ok', detail: 'Plex reachable, credential accepted', endpoint: base };
  } catch (err) {
    return { state: 'error', reason: 'PLEX_AUTH_FAILED', detail: 'Plex credential rejected', endpoint: base };
  }
}

export {
  redactUrl,
  checkDbFile,
  checkFileWritable,
  checkDataPlane,
  classifyHttpError,
  checkTorBox,
  checkRealDebrid,
  checkJellyfin,
  checkPlex,
};

/**
 * Prepared-but-unpublished items (preparation tranche): distinct media
 * items whose LATEST playback handoff names a TorrentFile but which have
 * no VFS row (movie or episode). Pure durable-truth distinction — no new
 * model, no human approval. Returns { state, count }.
 */
function countPreparedRows(cache) {
  try {
    const db = cache?.db;
    if (!db) return { state: 'error', detail: 'handoff store unavailable' };
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT h.media_id AS media_id, h.season AS season, h.episode AS episode, MAX(h.id) AS hid
        FROM playback_handoffs h
        GROUP BY h.media_id, h.season, h.episode
      ) latest
      JOIN playback_handoffs h2 ON h2.id = latest.hid
      WHERE h2.torrent_file_id IS NOT NULL AND h2.torrent_file_id != ''
        AND NOT EXISTS (
          SELECT 1 FROM vfs_movie_entries v
          WHERE v.media_id = latest.media_id AND latest.season IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM vfs_tv_entries t
          WHERE t.media_id = latest.media_id
            AND t.season = latest.season AND t.episode = latest.episode)
    `).get();
    return { state: 'ok', count: row?.n ?? 0 };
  } catch {
    return { state: 'error', detail: 'prepared count unreadable' };
  }
}

function countVfsRows(cache) {
  try {
    const db = cache?.db;
    if (!db) return { state: 'error', detail: 'VFS store unavailable' };
    const movies = db.prepare('SELECT COUNT(*) AS n FROM vfs_movie_entries').get()?.n ?? 0;
    const episodes = db.prepare('SELECT COUNT(*) AS n FROM vfs_tv_entries').get()?.n ?? 0;
    return { state: 'ok', detail: `${movies} movies, ${episodes} episodes`, movies, episodes };
  } catch {
    return { state: 'error', detail: 'VFS tables unreadable' };
  }
}

function lifecycleSummary({ cache, controlPlaneStore, listLibraryFn, retirementPolicy }) {
  try {
    const { items } = listLibraryFn({ cache, controlPlaneStore, limit: 500 });
    const states = { published: 0, absent: 0, incomplete: 0 };
    for (const item of items) {
      if (states[item.state] == null) states[item.state] = 0;
      states[item.state] += 1;
    }
    let eligible = 0;
    if (retirementPolicy.enabled) {
      eligible = -1;
    }
    return {
      state: 'ok',
      library: { total: items.length, ...states },
      prepared: countPreparedRows(cache).count ?? 0,
      retirement: {
        enabled: retirementPolicy.enabled,
        absenceGraceMs: retirementPolicy.absenceGraceMs,
        requiredConsumers: retirementPolicy.requiredConsumers,
        eligible,
      },
    };
  } catch (err) {
    return { state: 'error', detail: 'lifecycle unreadable' };
  }
}

/**
 * Corpus lifecycle state (corpus productization tranche): state machine
 * position, pinned upstream revision, check/update timestamps, and stored
 * counts. All values come from the corpus_state row — no live COUNT(*),
 * no network. Absent table (pre-migration DB) reports state unknown.
 */
function corpusSummary(cache, env = process.env) {
  // Maintenance switch mirror (canonical lives in corpus-lifecycle.js;
  // duplicated here to avoid pulling provider modules into diagnostics).
  const off = (v) => {
    const s = String(v ?? '').toLowerCase();
    return s === '0' || s === 'false';
  };
  const enabled = !(off(env.CORPUS_MAINTENANCE) || off(env.CORPUS_ENABLED));
  try {
    const db = cache?.db;
    if (!db) return { enabled, state: 'unknown', detail: 'corpus store unavailable' };
    const tbl = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='corpus_state'").get();
    if (!tbl) return { enabled, state: 'absent', detail: 'no corpus baseline imported' };
    const row = db.prepare('SELECT * FROM corpus_state WHERE id = 1').get();
    if (!row) return { enabled, state: 'absent', detail: 'no corpus baseline imported' };
    const out = {
      enabled,
      state: row.state ?? 'unknown',
      revision: row.imported_revision ?? null,
      revisionCommit: row.imported_commit ?? null,
      upstreamHeadCommit: row.upstream_head_commit ?? null,
      lastCheck: row.last_check ?? null,
      lastSuccess: row.last_success ?? null,
      lastError: row.last_error ?? null,
      consecutiveFailures: row.consecutive_failures ?? 0,
      candidates: row.candidate_count ?? null,
      fragments: row.fragment_count ?? null,
    };
    // Association intelligence (cheap indexed counts on small tables).
    try {
      out.associated = db.prepare('SELECT COUNT(*) AS n FROM candidate_media').get()?.n ?? 0;
      out.associatedMedia = db.prepare('SELECT COUNT(DISTINCT media_id) AS n FROM candidate_media').get()?.n ?? 0;
    } catch {
      out.associated = 0;
      out.associatedMedia = 0;
    }
    try {
      out.enrichmentQueued = db.prepare("SELECT COUNT(*) AS n FROM identity_enrichment_queue WHERE status = 'pending'").get()?.n ?? 0;
    } catch {
      out.enrichmentQueued = 0;
    }
    // Live progress while a run is in flight.
    if (row.state === 'bootstrapping' || row.state === 'updating') {
      try {
        const run = db.prepare(`SELECT id, fragments_discovered AS total FROM dmm_ingestion_runs
          WHERE status = 'running' ORDER BY id DESC LIMIT 1`).get();
        if (run) {
          const done = db.prepare(`SELECT COUNT(*) AS n FROM dmm_fragments WHERE run_id = ? AND status = 'complete'`).get(run.id)?.n ?? 0;
          out.progress = { complete: done, total: run.total ?? null };
        }
      } catch {
        // Progress is best-effort.
      }
    }
    return out;
  } catch {
    return { state: 'unknown', detail: 'corpus state unreadable' };
  }
}

function reconcileSummary(controlPlaneStore) {
  try {
    const rows = controlPlaneStore.listConsumerObservations();
    const byConsumer = {};
    for (const row of rows) {
      const entry = byConsumer[row.consumer] ?? {
        observations: 0, present: 0, absent: 0, unknown: 0, lastCheckedAt: 0,
      };
      entry.observations += 1;
      if (row.present === 1) entry.present += 1;
      else if (row.present === 0) entry.absent += 1;
      else entry.unknown += 1;
      if ((row.lastCheckedAt ?? 0) > entry.lastCheckedAt) entry.lastCheckedAt = row.lastCheckedAt;
      byConsumer[row.consumer] = entry;
    }
    return { state: 'ok', consumers: byConsumer };
  } catch {
    return { state: 'error', detail: 'observations unreadable' };
  }
}

/**
 * Build the full readiness payload. All fetchers injectable for tests.
 */
export async function buildDiagnostics({
  cache,
  controlPlaneStore,
  env = process.env,
  fetchFn = fetch,
  realDebridClientFactory = null,
  listLibraryFn = null,
  retirementPolicy = null,
  dataPlaneUrl = null,
  strmRoot = null,
} = {}) {
  const warnings = [];
  const dpUrl = dataPlaneUrl ?? env.DATA_PLANE_URL ?? 'http://data-plane:3001';
  const root = strmRoot ?? env.STRM_OUTPUT_PATH ?? '/strm';

  const [discoveryDb, controlDb, strm, dataPlane, vfs] = await Promise.all([
    checkDbFile(env.DISCOVERY_DB, 'discovery-cache'),
    checkDbFile(env.CONTROL_PLANE_DB ?? null, 'control-plane'),
    checkFileWritable(root, 'STRM'),
    checkDataPlane(dpUrl, fetchFn),
    Promise.resolve(countVfsRows(cache)),
  ]);
  const [torbox, realdebrid, jellyfin, plex] = await Promise.all([
    checkTorBox(env, fetchFn),
    realDebridClientFactory
      ? checkRealDebrid(env, fetchFn, realDebridClientFactory)
      : Promise.resolve(
        env.REALDEBRID_API_KEY
          ? { state: 'unknown', detail: 'Real-Debrid client unavailable' }
          : { state: 'skipped', detail: 'REALDEBRID_API_KEY not set' },
      ),
    checkJellyfin(env, fetchFn),
    checkPlex(env, fetchFn),
  ]);
  for (const w of jellyfin.warnings ?? []) warnings.push(w);

  const storage = { discoveryDb, controlDb };
  const publication = { vfs: vfs, strm, dataPlane: dataPlane.state };
  const providers = { torbox, realdebrid };
  const consumers = { jellyfin, plex };

  let lifecycle = { state: 'unknown', detail: 'listing unavailable' };
  if (listLibraryFn && retirementPolicy) {
    lifecycle = lifecycleSummary({ cache, controlPlaneStore, listLibraryFn, retirementPolicy });
  }
  const reconcile = controlPlaneStore && typeof controlPlaneStore.listConsumerObservations === 'function'
    ? reconcileSummary(controlPlaneStore)
    : { state: 'unknown', detail: 'observations unavailable' };
  const corpus = corpusSummary(cache, env);
  if (retirementPolicy && !retirementPolicy.enabled) {
    warnings.push('Automatic retirement is disabled (default safe state).');
  }

  const fatal = [discoveryDb, controlDb, strm, dataPlane].filter((c) => c.state === 'error');
  const soft = [torbox, realdebrid, jellyfin, plex, vfs]
    .filter((c) => c.state === 'error');
  const status = fatal.length > 0 ? 'not_ready' : (soft.length > 0 ? 'degraded' : 'ready');

  return {
    status,
    warnings,
    storage,
    dataPlane: { url: redactUrl(dpUrl), ...dataPlane },
    providers,
    consumers,
    publication,
    lifecycle: { ...lifecycle, reconcile },
    corpus,
  };
}

/**
 * One concise startup summary for logs. Pure formatting over a payload.
 */
export function summarizeForStartup(diagnostics) {
  const lines = ['HashSucker readiness: ' + diagnostics.status];
  const flat = (label, check) => {
    const extra = check?.reason ?? check?.detail ?? null;
    return `  ${label}: ${check?.state ?? 'unknown'}${extra ? ' — ' + extra : ''}`;
  };
  lines.push(flat('discovery DB', diagnostics.storage?.discoveryDb));
  lines.push(flat('control-plane DB', diagnostics.storage?.controlDb));
  lines.push(flat('data-plane', diagnostics.dataPlane));
  lines.push(flat('TorBox', diagnostics.providers?.torbox));
  lines.push(flat('Real-Debrid', diagnostics.providers?.realdebrid));
  lines.push(flat('STRM', diagnostics.publication?.strm));
  lines.push(flat('VFS', diagnostics.publication?.vfs));
  const consumers = diagnostics.consumers ?? {};
  for (const [name, check] of Object.entries(consumers)) {
    lines.push(flat(name, check));
  }
  const retirement = diagnostics.lifecycle?.retirement;
  if (retirement) {
    lines.push(`  retirement: ${retirement.enabled ? 'ENABLED' : 'disabled'}`);
  }
  for (const warning of diagnostics.warnings ?? []) {
    lines.push(`  warning: ${warning}`);
  }
  return lines.join('\n');
}
