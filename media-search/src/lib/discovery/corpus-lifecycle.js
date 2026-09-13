/**
 * Corpus lifecycle: blank bootstrap, revision-pinned incremental DMM
 * updates, and health states for the discovery corpus.
 *
 * States: absent → bootstrapping → usable ⇄ updating; degraded preserves
 * the last-good usable corpus (a failed update never destroys it).
 *
 * Revision model: upstream GitHub tree SHA (what serves) + commit SHA
 * (for the compare API). Revision advances only after a fully successful
 * transaction. Deltas are non-destructive: upstream removals are counted
 * and logged, candidate rows are retained (availability checks gate
 * serving, not corpus presence).
 *
 * All external access (GitHub API, fragment fetch, clock) is injectable
 * for deterministic tests. Production wiring lives in server/index.js
 * (scheduler) and server/app.js (POST /api/corpus/update).
 */
import { DMMHashListSource, extractPayload, streamParseDMM, transformDMMRecord } from './dmm-ingestion-runner.js';
import { decodeDmmPayload } from './adapters/dmm.js';
import { ingestCandidates } from './ingest.js';
import { runAttributeWorker } from './attribute-worker.js';

export const CORPUS_STATES = Object.freeze({
  ABSENT: 'absent',
  BOOTSTRAPPING: 'bootstrapping',
  USABLE: 'usable',
  UPDATING: 'updating',
  DEGRADED: 'degraded',
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS corpus_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL DEFAULT 'absent',
  imported_revision TEXT,
  imported_commit TEXT,
  upstream_head TEXT,
  upstream_head_commit TEXT,
  last_check INTEGER,
  last_success INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER,
  fragment_count INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS corpus_fragment_shas (
  fragment_name TEXT PRIMARY KEY,
  tree_sha TEXT,
  blob_sha TEXT,
  bytes INTEGER,
  updated_at INTEGER NOT NULL
);
-- Run/fragment provenance (same shape as dmm-rebuild; IF NOT EXISTS so
-- operator-built databases keep their rows).
CREATE TABLE IF NOT EXISTS dmm_ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  tree_sha TEXT,
  fragments_discovered INTEGER NOT NULL DEFAULT 0,
  fragments_complete INTEGER NOT NULL DEFAULT 0,
  fragments_failed INTEGER NOT NULL DEFAULT 0,
  raw_records_decoded INTEGER NOT NULL DEFAULT 0,
  accepted_records INTEGER NOT NULL DEFAULT 0,
  rejected_records INTEGER NOT NULL DEFAULT 0,
  unique_candidates INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE TABLE IF NOT EXISTS dmm_fragments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  fragment_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  raw_records INTEGER NOT NULL DEFAULT 0,
  accepted_records INTEGER NOT NULL DEFAULT 0,
  rejected_records INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  error_message TEXT,
  FOREIGN KEY (run_id) REFERENCES dmm_ingestion_runs(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dmm_fragments_run_name
  ON dmm_fragments(run_id, fragment_name);
`;

function readState(db) {
  ensureSchema(db);
  let row = null;
  try {
    row = db.prepare('SELECT * FROM corpus_state WHERE id = 1').get();
  } catch {
    row = null;
  }
  if (!row) return { state: CORPUS_STATES.ABSENT };
  return row;
}

function ensureSchema(db) {
  db.exec(SCHEMA);
  const n = db.prepare('SELECT COUNT(*) AS n FROM corpus_state WHERE id = 1').get()?.n ?? 0;
  if (n === 0) {
    db.prepare('INSERT INTO corpus_state (id, state, updated_at) VALUES (1, ?, ?)').run(CORPUS_STATES.ABSENT, Date.now());
  }
}

function writeState(db, patch, now) {
  ensureSchema(db);
  const cur = readState(db);
  const next = { ...cur, ...patch, id: 1, updated_at: now() };
  const cols = ['state', 'imported_revision', 'imported_commit', 'upstream_head', 'upstream_head_commit', 'last_check', 'last_success', 'last_error', 'consecutive_failures', 'candidate_count', 'fragment_count', 'updated_at'];
  db.prepare(`UPDATE corpus_state SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = 1`)
    .run(...cols.map((c) => next[c] ?? null));
  return next;
}

export function createCorpusLifecycle({
  cache,
  sourceFactory = null,
  repo = 'debridmediamanager/hashlists',
  githubToken = null,
  fetchFn = fetch,
  clock = () => Date.now(),
  log = () => {},
  batchSize = 1000,
} = {}) {
  if (!cache?.db) throw new Error('corpus lifecycle requires cache.db');
  const db = cache.db;
  const now = () => clock();
  let inFlight = false;

  function makeSource() {
    if (sourceFactory) return sourceFactory();
    return new DMMHashListSource({ repo, githubToken });
  }

  async function githubJson(url) {
    const headers = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'HashSucker/1.0' };
    if (githubToken) headers.Authorization = `token ${githubToken}`;
    const resp = await fetchFn(url, { headers });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status} for ${url}`);
    return resp.json();
  }

  async function resolveHeadCommit() {
    const repoData = await githubJson(`https://api.github.com/repos/${repo}`);
    const branch = repoData.default_branch || 'main';
    const data = await githubJson(`https://api.github.com/repos/${repo}/commits/${branch}?per_page=1`);
    const commit = Array.isArray(data) ? data[0] : data;
    const sha = commit?.sha;
    if (!sha) throw new Error('GitHub HEAD commit unresolvable');
    return { headCommit: sha, branch };
  }

  /**
   * Recover the commit SHA for a legacy revision marker. The recorded
   * revision is usually itself a commit SHA (listFragments echoes the
   * HEAD commit); rarely it may be a bare tree SHA, matched on the
   * commit's tree field instead. Walks up to 3 pages (~2 months).
   */
  async function recoverCommitForTree(treeSha) {
    const repoData = await githubJson(`https://api.github.com/repos/${repo}`);
    const branch = repoData.default_branch || 'main';
    for (let page = 1; page <= 3; page++) {
      const commits = await githubJson(`https://api.github.com/repos/${repo}/commits?sha=${branch}&per_page=100&page=${page}`);
      const list = Array.isArray(commits) ? commits : [];
      const hit = list.find((c) => c?.sha === treeSha || c?.commit?.tree?.sha === treeSha);
      if (hit?.sha) return hit.sha;
      if (list.length < 100) break;
    }
    return null;
  }

  async function compareResolves(base, head) {
    try {
      const headers = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'HashSucker/1.0' };
      if (githubToken) headers.Authorization = `token ${githubToken}`;
      const resp = await fetchFn(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, { headers });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async function compareCommits(base, head) {
    const data = await githubJson(`https://api.github.com/repos/${repo}/compare/${base}...${head}`);
    return {
      status: data.status ?? 'unknown',
      aheadBy: data.ahead_by ?? null,
      files: (data.files ?? []).map((f) => ({ filename: f.filename, status: f.status })),
    };
  }

  function decodeFragment(html, fragmentName) {
    const compressed = extractPayload(html);
    if (!compressed) throw new Error(`No payload in ${fragmentName}`);
    const json = decodeDmmPayload(compressed);
    if (!json) throw new Error(`Decompress failed for ${fragmentName}`);
    return json;
  }

  function ingestJson(json) {
    const batch = [];
    let raw = 0, accepted = 0;
    const flush = () => {
      if (batch.length === 0) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        // No generationId/fragmentName: per-record source observations are
        // unread by serving code; fragment provenance lives in
        // dmm_fragments + corpus_fragment_shas. Keeps ingest lean.
        const result = ingestCandidates(cache, { source: 'dmm-hashlist', entries: batch });
        accepted += result.inserted || 0;
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
      batch.length = 0;
    };
    for (const record of streamParseDMM(json)) {
      raw++;
      const entry = transformDMMRecord(record);
      if (!entry) continue;
      batch.push(entry);
      if (batch.length >= batchSize) flush();
    }
    flush();
    return { raw, accepted };
  }

  function openRun({ treeSha, discovered }) {
    const info = db.prepare(`INSERT INTO dmm_ingestion_runs
      (started_at, tree_sha, fragments_discovered, status)
      VALUES (?, ?, ?, 'running')`).run(now(), treeSha ?? null, discovered ?? 0);
    return info.lastInsertRowid;
  }

  function closeRun(runId, { complete, failed, rawRecords, accepted, status }) {
    db.prepare(`UPDATE dmm_ingestion_runs SET completed_at = ?, fragments_complete = ?,
      fragments_failed = ?, raw_records_decoded = ?, accepted_records = ?, status = ?
      WHERE id = ?`).run(now(), complete ?? 0, failed ?? 0, rawRecords ?? 0, accepted ?? 0, status ?? 'complete', runId);
  }

  function recordFragment(runId, { name, url, status, rawRecords, accepted, error }) {
    try {
      db.prepare(`INSERT INTO dmm_fragments
        (run_id, fragment_name, source_url, status, attempt_count, started_at, completed_at,
         raw_records, accepted_records, error_category, error_message)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
        .run(runId, name, url ?? '', status, now(), now(), rawRecords ?? 0, accepted ?? 0,
          error ? 'fetch-or-decode' : null, error ? String(error).slice(0, 300) : null);
    } catch {}
  }

  function completedForTree(treeSha) {
    try {
      const rows = db.prepare(`
        SELECT f.fragment_name AS name FROM dmm_fragments f
        JOIN dmm_ingestion_runs r ON r.id = f.run_id
        WHERE r.tree_sha = ? AND f.status = 'complete'`).all(treeSha);
      return new Set(rows.map((r) => r.name));
    } catch {
      return new Set();
    }
  }

  async function fetchRaw(path, branch) {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
    const resp = await fetchFn(url, { headers: { 'User-Agent': 'HashSucker/1.0' } });
    if (!resp.ok) throw new Error(`raw fetch ${resp.status} for ${path}`);
    return resp.text();
  }

  return {
    getState: () => readState(db),

    /**
     * Bootstrap from an empty (or partial) data directory to a usable
     * corpus. Resumable: fragments already complete for the target tree
     * are skipped; candidate upserts are idempotent. Never advertises
     * partial state as usable.
     */
    async bootstrap({ maxFragments = null, onProgress = null } = {}) {
      if (inFlight) return { ok: false, reason: 'already-in-flight' };
      inFlight = true;
      const prior = readState(db);
      writeState(db, { state: CORPUS_STATES.BOOTSTRAPPING, last_error: null, last_check: now() }, now);
      const t0 = now();
      let runId = null;
      let complete = 0, failed = 0, rawRecords = 0, accepted = 0;
      try {
        const source = makeSource();
        const listing = await source.listFragments();
        const treeSha = listing.treeSha;
        const branch = listing.branch || 'main';
        let fragments = listing.fragments || [];
        const done = completedForTree(treeSha);
        fragments = fragments.filter((f) => !done.has(f.name || f.url));
        if (maxFragments != null) fragments = fragments.slice(0, maxFragments);
        log(`corpus bootstrap tree=${String(treeSha).slice(0, 8)} fragments=${fragments.length} skipped=${done.size}`);
        runId = openRun({ treeSha, discovered: fragments.length });
        const failures = [];
        for (const fragment of fragments) {
          const name = fragment.name || fragment.url;
          try {
            const html = await source.fetchFragment(fragment.url);
            const json = decodeFragment(html, name);
            const r = ingestJson(json);
            rawRecords += r.raw; accepted += r.accepted;
            recordFragment(runId, { name, url: fragment.url, status: 'complete', rawRecords: r.raw, accepted: r.accepted });
            try {
              db.prepare('INSERT INTO corpus_fragment_shas (fragment_name, tree_sha, blob_sha, bytes, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(fragment_name) DO UPDATE SET tree_sha=excluded.tree_sha, bytes=excluded.bytes, updated_at=excluded.updated_at')
                .run(name, treeSha, fragment.sha ?? null, html.length, now());
            } catch {}
            complete++;
          } catch (err) {
            failed++;
            const msg = String(err?.message || err).slice(0, 120);
            failures.push(`${name}: ${msg}`);
            recordFragment(runId, { name, url: fragment.url, status: 'failed', error: msg });
          }
          if (onProgress) onProgress({ complete, failed, total: fragments.length });
        }
        // Attribute parsing over newly-ingested candidates (idempotent).
        let attrStats = null;
        try {
          const { runAttributeWorker } = await import('./attribute-worker.js');
          attrStats = await runAttributeWorker(cache, { limit: undefined });
        } catch (err) {
          log(`corpus bootstrap attribute pass failed: ${err?.message || err}`);
        }
        const candidateCount = db.prepare('SELECT COUNT(*) AS n FROM candidates').get()?.n ?? null;
        const status = failed === 0 ? 'complete' : 'incomplete';
        closeRun(runId, { complete, failed, rawRecords, accepted, status });
        if (failed === 0) {
          writeState(db, {
            state: CORPUS_STATES.USABLE, imported_revision: treeSha,
            last_success: now(), last_error: null, consecutive_failures: 0,
            candidate_count: candidateCount, fragment_count: complete,
          }, now);
        } else {
          // Partial bootstrap: keep prior usable state if one existed,
          // otherwise degraded (live-only discovery continues).
          writeState(db, {
            state: prior.imported_revision ? CORPUS_STATES.USABLE : CORPUS_STATES.DEGRADED,
            last_error: `bootstrap ${complete} ok / ${failed} failed: ${failures.slice(0, 3).join('; ')}`,
            consecutive_failures: (prior.consecutive_failures ?? 0) + 1,
          }, now);
        }
        return { ok: failed === 0, treeSha, complete, failed, rawRecords, accepted, wallMs: now() - t0, attrStats: attrStats ? true : false };
      } catch (err) {
        try {
          if (runId != null) closeRun(runId, { complete, failed, rawRecords, accepted, status: 'incomplete' });
        } catch {}
        writeState(db, {
          state: prior.imported_revision ? CORPUS_STATES.USABLE : CORPUS_STATES.DEGRADED,
          last_error: String(err?.message || err).slice(0, 300),
          consecutive_failures: (prior.consecutive_failures ?? 0) + 1,
        }, now);
        return { ok: false, reason: String(err?.message || err).slice(0, 200) };
      } finally {
        inFlight = false;
      }
    },

    /**
     * Incremental update: HEAD check (cheap), compare-based delta, atomic
     * revision advance only on full success. Failures preserve the
     * last-good usable corpus.
     */
    async updateOnce() {
      if (inFlight) return { ok: false, reason: 'already-in-flight' };
      const cur = readState(db);
      if (!cur.imported_revision) {
        return { ok: false, reason: 'no-baseline-use-bootstrap' };
      }
      inFlight = true;
      try {
        const { headCommit } = await resolveHeadCommit();
        writeState(db, { upstream_head_commit: headCommit, last_check: now() }, now);
        // Legacy revision without a commit marker: the recorded revision
        // itself is often compare-resolvable (DMM sync commits); verify
        // with one cheap call before walking commit history.
        let baseCommit = cur.imported_commit;
        if (!baseCommit) {
          if (await compareResolves(cur.imported_revision, headCommit)) {
            baseCommit = cur.imported_revision;
          } else {
            baseCommit = await recoverCommitForTree(cur.imported_revision);
          }
          if (baseCommit && baseCommit !== cur.imported_commit) writeState(db, { imported_commit: baseCommit }, now);
        }
        if (baseCommit && headCommit === baseCommit) {
          return { ok: true, changed: false, headCommit };
        }
        // No usable base (tree too old for the commit window): fall back to
        // a full refresh under the new machinery exactly once, which also
        // establishes commit tracking. This is the one-time legacy cost.
        // Recorded as a note, not a failure (upstream rotated history).
        if (!baseCommit) {
          writeState(db, { last_error: `legacy base ${String(cur.imported_revision).slice(0, 8)} outside commit window; bootstrap required for delta tracking` }, now);
          return { ok: false, reason: 'legacy-base-unrecoverable-use-bootstrap' };
        }
        writeState(db, { state: CORPUS_STATES.UPDATING }, now);
        const cmp = await compareCommits(baseCommit, headCommit);
        const changed = (cmp.files || []).filter((f) => f.filename.endsWith('.html') && f.status !== 'removed');
        const removed = (cmp.files || []).filter((f) => f.filename.endsWith('.html') && f.status === 'removed');
        // Upstream removals are classified and counted, never destructive:
        // candidate rows are historical prevalence evidence and stay;
        // availability checks gate serving.
        // Resolve HEAD tree for raw fetch paths + revision pinning.
        const source = makeSource();
        const listing = await source.listFragments();
        const headTree = listing.treeSha;
        const branch = listing.branch || 'main';
        const runId = openRun({ treeSha: headTree, discovered: changed.length });
        let complete = 0, failed = 0, rawRecords = 0, accepted = 0;
        const failures = [];
        for (const f of changed) {
          try {
            const html = await fetchRaw(f.filename, branch);
            const json = decodeFragment(html, f.filename);
            const r = ingestJson(json);
            rawRecords += r.raw; accepted += r.accepted;
            recordFragment(runId, { name: f.filename, url: f.filename, status: 'complete', rawRecords: r.raw, accepted: r.accepted });
            try {
              db.prepare('INSERT INTO corpus_fragment_shas (fragment_name, tree_sha, blob_sha, bytes, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(fragment_name) DO UPDATE SET tree_sha=excluded.tree_sha, bytes=excluded.bytes, updated_at=excluded.updated_at')
                .run(f.filename, headTree, null, html.length, now());
            } catch {}
            complete++;
          } catch (err) {
            failed++;
            const msg = String(err?.message || err).slice(0, 120);
            failures.push(`${f.filename}: ${msg}`);
            recordFragment(runId, { name: f.filename, url: f.filename, status: 'failed', error: msg });
          }
        }
        try {
          const { runAttributeWorker } = await import('./attribute-worker.js');
          await runAttributeWorker(cache, { limit: undefined });
        } catch (err) {
          log(`corpus update attribute pass failed: ${err?.message || err}`);
        }
        const candidateCount = db.prepare('SELECT COUNT(*) AS n FROM candidates').get()?.n ?? null;
        if (failed > 0) {
          closeRun(runId, { complete, failed, rawRecords, accepted, status: 'incomplete' });
          throw new Error(`delta ${complete} ok / ${failed} failed: ${failures.slice(0, 3).join('; ')}`);
        }
        closeRun(runId, { complete, failed, rawRecords, accepted, status: 'complete' });
        writeState(db, {
          state: CORPUS_STATES.USABLE, imported_revision: headTree, imported_commit: headCommit,
          upstream_head: headTree, upstream_head_commit: headCommit,
          last_success: now(), last_error: null, consecutive_failures: 0,
          candidate_count: candidateCount, fragment_count: (cur.fragment_count ?? 0) + complete,
        }, now);
        return { ok: true, changed: true, headCommit, headTree, fragments: complete, removed: removed.length, rawRecords, accepted };
      } catch (err) {
        const fails = (cur.consecutive_failures ?? 0) + 1;
        writeState(db, {
          state: fails >= 3 ? CORPUS_STATES.DEGRADED : CORPUS_STATES.USABLE,
          last_error: String(err?.message || err).slice(0, 300),
          consecutive_failures: fails,
        }, now);
        return { ok: false, reason: String(err?.message || err).slice(0, 200) };
      } finally {
        inFlight = false;
      }
    },

    /**
     * Scheduler tick: returns an action descriptor; the caller sleeps
     * until nextDueMs. Cheap no-change path, bounded backoff, restart
     * does not hammer (last_check persists).
     */
    tick({ intervalMs, autoBootstrap }) {
      const cur = readState(db);
      if (inFlight || cur.state === CORPUS_STATES.UPDATING || cur.state === CORPUS_STATES.BOOTSTRAPPING) {
        return { action: 'busy' };
      }
      const backoff = Math.min(cur.consecutive_failures ?? 0, 3);
      const dueIn = (cur.last_check ?? 0) + intervalMs * 2 ** backoff - now();
      if (!cur.imported_revision) {
        // Absent (or failed bootstrap with nothing usable): bootstrap when
        // due, never in a hot loop. Discovery stays live-only meanwhile.
        if (!autoBootstrap) return { action: 'idle-absent' };
        if (dueIn > 0) return { action: 'wait', nextDueMs: dueIn };
        return { action: 'bootstrap' };
      }
      if (dueIn > 0) return { action: 'wait', nextDueMs: dueIn };
      return { action: 'update' };
    },
  };
}

export function corpusUpdateIntervalMs(env = process.env) {
  const hours = Number(env.CORPUS_UPDATE_INTERVAL_HOURS ?? 6);
  const safe = Number.isFinite(hours) && hours >= 0.5 ? hours : 6;
  return safe * 60 * 60 * 1000;
}

export function corpusAutoBootstrap(env = process.env) {
  const v = String(env.CORPUS_AUTO_BOOTSTRAP ?? '1').toLowerCase();
  return v !== '0' && v !== 'false';
}
