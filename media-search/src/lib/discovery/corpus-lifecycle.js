/**
 * Corpus lifecycle: blank bootstrap, revision-pinned incremental DMM
 * updates, and health states for the discovery corpus.
 *
 * States: absent → bootstrapping → usable ⇄ updating; degraded preserves
 * the last-good usable corpus (a failed update never destroys it).
 *
 * Revision model: upstream GitHub tree SHA (what serves) + commit SHA
 * (for the compare API). Revision advances only after every expected
 * fragment in the tree is either successfully ingested or explicitly
 * quarantined under the bounded invalid-fragment policy below (a claimed
 * revision with quarantines is honestly partial, never silent loss:
 * quarantine rows name the fragment, reason, and tree).
 * Deltas are non-destructive: upstream removals are counted
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
  // Partially bootstrapped but serving: candidates imported, revision
  // not yet fully covered. Requests work (live sources carry); the
  // scheduler keeps running bounded sessions until usable.
  USABLE_PARTIAL: 'usable-partial',
  USABLE: 'usable',
  UPDATING: 'updating',
  DEGRADED: 'degraded',
});

// Bounded bootstrap sessions (first-run tranche): measured ~250
// fragments/min on reference hardware; 1000 fragments ≈ 4 min of polite
// background work, then checkpoint + yield. Crash/restart loses at most
// the current session (fragment provenance is per-fragment durable).
const BOOTSTRAP_SESSION_FRAGMENTS = 1000;
const BOOTSTRAP_SESSION_MAX_MS = 8 * 60 * 1000;
const BOOTSTRAP_SESSION_PAUSE_MS = 2 * 60 * 1000;
// Attribute pass per session: measured ~4000 rows/s (regex parse +
// release_attributes upsert incl. FTS trigger), so 100k rows ≈ 25 s —
// a small fraction of a session while letting searchability converge
// alongside fragment fetching instead of lagging it by days. Idempotent
// (skips attributed rows); memory is O(unattributed) regardless of limit.
const BOOTSTRAP_ATTRIBUTE_LIMIT = 100000;

/** Session policy for first-run bootstrap (single source for ticker + tests). */
export function bootstrapSessionPolicy() {
  return {
    maxFragments: BOOTSTRAP_SESSION_FRAGMENTS,
    maxWallMs: BOOTSTRAP_SESSION_MAX_MS,
    pauseMs: BOOTSTRAP_SESSION_PAUSE_MS,
    attributeLimit: BOOTSTRAP_ATTRIBUTE_LIMIT,
  };
}

// Quarantine policy (invalid-fragment tranche): a fragment that fails
// with a DETERMINISTIC content-invalid outcome on several consecutive
// sessions is quarantined for the current tree instead of retried
// forever. Observed poison (GitHub 404 pages, empty iframe shells,
// index.html placeholders served as HTTP 200) failed 11-22 consecutive
// sessions; 5 is conservative — far above flake runs (1-2), far below
// observed poison — and each counted failure is a fresh full GET, so a
// single corrupted transfer can never trip it. Transient transport
// failures (429/5xx/timeout/network/DB) never count and reset the chain.
export const QUARANTINE_AFTER_CONSECUTIVE = 5;

/**
 * Classify a per-fragment failure as deterministic (content-invalid:
 * safe to count toward tree-scoped quarantine) or transient (retry
 * with normal backoff; never quarantined). Unknown shapes fail closed
 * to transient — only positively-identified invalidity quarantines.
 */
export function classifyFragmentFailure(err) {
  const msg = String(err?.message || err || '');
  if (/No payload in /.test(msg)) return { kind: 'deterministic', reason: 'no-payload' };
  if (/Decompress failed for /.test(msg)) return { kind: 'deterministic', reason: 'decompress-failed' };
  const statusMatch = msg.match(/(?:fetch |error: | )(\d{3})\b/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 404 || status === 410) return { kind: 'deterministic', reason: `http-${status}` };
  return { kind: 'transient', reason: status ? `http-${status}` : 'transport-or-unknown' };
}

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
-- Tree-scoped invalid-fragment quarantine (invalid-fragment tranche).
-- A fragment is quarantined only after QUARANTINE_AFTER_CONSECUTIVE
-- consecutive DETERMINISTIC failures (fresh GET each session); transient
-- failures reset the chain and can never trip it. PK includes the tree
-- SHA so a new upstream tree re-evaluates every path from zero — healed
-- content is never shadowed by stale quarantine. Quarantined fragments
-- are skipped (not fetched) and do not block the claim gate, but are
-- never treated as ingested: claim statistics name them explicitly.
CREATE TABLE IF NOT EXISTS corpus_fragment_quarantine (
  tree_sha TEXT NOT NULL,
  fragment_name TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  last_error TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tree_sha, fragment_name)
);
`;

function readState(db) {
  try {
    ensureSchema(db);
  } catch {
    return { state: 'unknown', dbError: true };
  }
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

  function recordFragment(runId, { name, url, status, rawRecords, accepted, error, category }) {
    try {
      db.prepare(`INSERT INTO dmm_fragments
        (run_id, fragment_name, source_url, status, attempt_count, started_at, completed_at,
          raw_records, accepted_records, error_category, error_message)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
        .run(runId, name, url ?? '', status, now(), now(), rawRecords ?? 0, accepted ?? 0,
          category ?? (error ? 'fetch-or-decode' : null), error ? String(error).slice(0, 300) : null);
    } catch {}
  }

  /** Quarantined fragment names for one exact tree (skipped, never fetched). */
  function quarantinedForTree(treeSha) {
    try {
      const rows = db.prepare(`SELECT fragment_name, last_reason FROM corpus_fragment_quarantine
        WHERE tree_sha = ? AND quarantined = 1`).all(treeSha);
      return new Map(rows.map((r) => [r.fragment_name, r.last_reason]));
    } catch {
      return new Map();
    }
  }

  function quarantinedCountForTree(treeSha) {
    try {
      return db.prepare(`SELECT COUNT(*) AS n FROM corpus_fragment_quarantine
        WHERE tree_sha = ? AND quarantined = 1`).get(treeSha)?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Record one fragment outcome against the quarantine policy. Returns
   * { quarantinedNow } — true only on the session that trips the
   * threshold. Success clears the row (completion always wins over
   * quarantine); transient failures reset the consecutive chain.
   */
  function noteFragmentQuarantine(treeSha, name, { ok, classification, errorMsg }) {
    try {
      if (ok) {
        db.prepare('DELETE FROM corpus_fragment_quarantine WHERE tree_sha = ? AND fragment_name = ?')
          .run(treeSha, name);
        return { quarantinedNow: false };
      }
      if (!classification || classification.kind !== 'deterministic') {
        db.prepare(`INSERT INTO corpus_fragment_quarantine
            (tree_sha, fragment_name, consecutive_failures, last_reason, last_error, quarantined, updated_at)
          VALUES (?, ?, 0, ?, ?, 0, ?)
          ON CONFLICT(tree_sha, fragment_name) DO UPDATE SET
            consecutive_failures = 0, last_reason = excluded.last_reason,
            last_error = excluded.last_error, updated_at = excluded.updated_at`)
          .run(treeSha, name, classification?.reason ?? 'transient', String(errorMsg || '').slice(0, 300), now());
        return { quarantinedNow: false };
      }
      const row = db.prepare(`SELECT consecutive_failures, quarantined FROM corpus_fragment_quarantine
        WHERE tree_sha = ? AND fragment_name = ?`).get(treeSha, name);
      const consecutive = (row?.consecutive_failures ?? 0) + 1;
      const already = row?.quarantined === 1;
      const trip = !already && consecutive >= QUARANTINE_AFTER_CONSECUTIVE;
      db.prepare(`INSERT INTO corpus_fragment_quarantine
          (tree_sha, fragment_name, consecutive_failures, last_reason, last_error, quarantined, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tree_sha, fragment_name) DO UPDATE SET
          consecutive_failures = excluded.consecutive_failures, last_reason = excluded.last_reason,
          last_error = excluded.last_error, quarantined = excluded.quarantined, updated_at = excluded.updated_at`)
        .run(treeSha, name, consecutive, classification.reason, String(errorMsg || '').slice(0, 300), trip || already ? 1 : 0, now());
      if (trip) {
        log(`corpus fragment quarantined tree=${String(treeSha).slice(0, 8)} name=${name} reason=${classification.reason} consecutive=${consecutive}`);
      }
      return { quarantinedNow: trip };
    } catch {
      return { quarantinedNow: false };
    }
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
     * are skipped; candidate upserts are idempotent.
     *
     * Bounded sessions (first-run tranche): maxFragments caps fragments
     * per call and maxWallMs caps wall time; reaching either stops the
     * session WITHOUT claiming the revision (boundedStop=true) so the
     * scheduler can checkpoint, yield, and resume. Only a session that
     * covers every remaining fragment with zero unresolved failures
     * advances the revision to usable (deterministic-invalid fragments
     * quarantined under the tree-scoped policy count as resolved, and
     * are named in the claim — never silent). Partial progress advertises usable-partial
     * (serving) rather than wedging on bootstrapping or crying degraded.
     */
    async bootstrap({ maxFragments = null, maxWallMs = null, onProgress = null } = {}) {
      if (inFlight) return { ok: false, reason: 'already-in-flight' };
      inFlight = true;
      const prior = readState(db);
      // Session start must not lie about serving state: when candidates
      // are already imported (resume/continuation), the session runs
      // under usable-partial, not bootstrapping, so diagnostics keep
      // reporting usable:true while the corpus improves. Single-flight
      // within the process is still guarded by inFlight above.
      let servingAlready = !!prior.imported_revision
        || (prior.candidate_count ?? 0) > 0 || (prior.fragment_count ?? 0) > 0;
      if (!servingAlready) {
        try {
          servingAlready = !!db.prepare('SELECT 1 AS ok FROM candidates LIMIT 1').get();
        } catch {}
      }
      writeState(db, {
        state: prior.imported_revision ? prior.state : (servingAlready ? CORPUS_STATES.USABLE_PARTIAL : CORPUS_STATES.BOOTSTRAPPING),
        last_error: null, last_check: now(),
      }, now);
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
        // Tree-scoped quarantine: invalid fragments are skipped (not
        // fetched) and do not consume session budget. New trees start
        // clean — healed content is re-evaluated, never shadowed.
        const quarantined = quarantinedForTree(treeSha);
        let skippedQuarantined = 0;
        if (quarantined.size > 0) {
          const before = fragments.length;
          fragments = fragments.filter((f) => !quarantined.has(f.name || f.url));
          skippedQuarantined = before - fragments.length;
        }
        const remainingTotal = fragments.length;
        if (maxFragments != null) fragments = fragments.slice(0, maxFragments);
        log(`corpus bootstrap tree=${String(treeSha).slice(0, 8)} fragments=${fragments.length} skipped=${done.size}${skippedQuarantined > 0 ? ` quarantined-skipped=${skippedQuarantined}` : ''}`);
        // Record the session-start backlog (pre-slice) as the run total so
        // progress displays against the tree, not the session slice.
        runId = openRun({ treeSha, discovered: remainingTotal });
        const failures = [];
        const baseFragmentCount = prior.fragment_count ?? 0;
        let cappedByWall = false;
        let quarantinedNew = 0;
        for (const fragment of fragments) {
          if (maxWallMs != null && now() - t0 >= maxWallMs) {
            cappedByWall = true;
            break;
          }
          const name = fragment.name || fragment.url;
          try {
            const html = await source.fetchFragment(fragment.url);
            const json = decodeFragment(html, name);
            const r = ingestJson(json);
            rawRecords += r.raw; accepted += r.accepted;
            recordFragment(runId, { name, url: fragment.url, status: 'complete', rawRecords: r.raw, accepted: r.accepted });
            noteFragmentQuarantine(treeSha, name, { ok: true });
            try {
              db.prepare('INSERT INTO corpus_fragment_shas (fragment_name, tree_sha, blob_sha, bytes, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(fragment_name) DO UPDATE SET tree_sha=excluded.tree_sha, bytes=excluded.bytes, updated_at=excluded.updated_at')
                .run(name, treeSha, fragment.sha ?? null, html.length, now());
            } catch {}
            complete++;
          } catch (err) {
            const msg = String(err?.message || err).slice(0, 120);
            const classification = classifyFragmentFailure(err);
            const note = noteFragmentQuarantine(treeSha, name, { ok: false, classification, errorMsg: msg });
            recordFragment(runId, {
              name, url: fragment.url, status: 'failed', error: msg,
              category: classification.kind === 'deterministic' ? classification.reason : undefined,
            });
            if (note.quarantinedNow) {
              quarantinedNew++;
            } else {
              failed++;
              failures.push(`${name}: ${msg}`);
            }
          }
          // Periodic durable progress so a kill loses at most the current
          // batch and diagnostics can report between sessions.
          if ((complete + failed) % 50 === 0) {
            try {
              writeState(db, { fragment_count: baseFragmentCount + complete }, now);
            } catch {}
          }
          if (onProgress) onProgress({ complete, failed, total: fragments.length });
        }
        // Attribute parsing over newly-ingested candidates (idempotent,
        // bounded per session so the pass cannot dominate a session).
        let attrStats = null;
        try {
          const { runAttributeWorker } = await import('./attribute-worker.js');
          attrStats = await runAttributeWorker(cache, { limit: BOOTSTRAP_ATTRIBUTE_LIMIT });
        } catch (err) {
          log(`corpus bootstrap attribute pass failed: ${err?.message || err}`);
        }
        const candidateCount = db.prepare('SELECT COUNT(*) AS n FROM candidates').get()?.n ?? null;
        // Claim gate (invalid-fragment tranche): a tree claims when every
        // expected fragment is successfully ingested OR explicitly
        // quarantined for this exact tree, with zero UNRESOLVED failures.
        // Newly-quarantined-this-session counts as resolved (named, not
        // silent); transient/below-threshold failures still block, exactly
        // as before. Claim statistics distinguish perfect from
        // quarantine-bearing revisions.
        const resolved = complete + quarantinedNew;
        const coveredAll = !cappedByWall && (resolved + failed) >= remainingTotal;
        const status = failed === 0 && coveredAll ? 'complete' : 'incomplete';
        closeRun(runId, { complete, failed, rawRecords, accepted, status });
        const boundedStop = !coveredAll;
        const hasServing = complete > 0 || (candidateCount ?? 0) > 0 || prior.imported_revision;
        const quarantinedTotal = quarantinedCountForTree(treeSha);
        if (failed === 0 && coveredAll) {
          const quarantinedNames = [...quarantined.keys()];
          // Re-read names so fragments quarantined DURING this session are
          // named too (the pre-session map above predates them).
          let claimNames = quarantinedNames;
          try {
            claimNames = db.prepare(`SELECT fragment_name FROM corpus_fragment_quarantine
              WHERE tree_sha = ? AND quarantined = 1 ORDER BY fragment_name`).all(treeSha).map((r) => r.fragment_name);
          } catch {}
          log(`corpus bootstrap tree=${String(treeSha).slice(0, 8)} claimed complete=${complete} quarantined=${quarantinedTotal}${claimNames.length > 0 ? ` [${claimNames.slice(0, 20).join(', ')}]` : ''}`);
          writeState(db, {
            state: CORPUS_STATES.USABLE, imported_revision: treeSha,
            last_success: now(), last_error: null, consecutive_failures: 0,
            candidate_count: candidateCount, fragment_count: baseFragmentCount + complete,
          }, now);
        } else if (boundedStop && failed === 0) {
          // Clean session slice, not a failure: keep the serving position
          // (usable-partial once anything is imported), never claim a
          // revision the session did not fully cover, and do NOT touch
          // failure accounting or raise degraded. The scheduler resumes
          // shortly on the session cadence.
          writeState(db, {
            state: hasServing && !prior.imported_revision
              ? CORPUS_STATES.USABLE_PARTIAL
              : (prior.state ?? CORPUS_STATES.ABSENT),
            candidate_count: candidateCount, fragment_count: baseFragmentCount + complete,
          }, now);
        } else if (hasServing) {
          // Genuine failures with something serving: usable-partial when
          // no revision is claimed yet, else keep the existing usable
          // baseline. Never claim a revision the session did not cover.
          writeState(db, {
            state: prior.imported_revision ? CORPUS_STATES.USABLE : CORPUS_STATES.USABLE_PARTIAL,
            last_error: `bootstrap ${complete} ok / ${failed} failed: ${failures.slice(0, 3).join('; ')}`,
            consecutive_failures: (prior.consecutive_failures ?? 0) + 1,
            candidate_count: candidateCount, fragment_count: baseFragmentCount + complete,
          }, now);
        } else {
          // Nothing serving and nothing new: prior usable baseline keeps
          // serving, otherwise degraded (live-only discovery continues).
          writeState(db, {
            state: prior.imported_revision ? CORPUS_STATES.USABLE : CORPUS_STATES.DEGRADED,
            last_error: `bootstrap ${complete} ok / ${failed} failed: ${failures.slice(0, 3).join('; ')}`,
            consecutive_failures: (prior.consecutive_failures ?? 0) + 1,
          }, now);
        }
        return { ok: failed === 0, boundedStop, remaining: Math.max(0, remainingTotal - complete - failed - quarantinedNew), treeSha, complete, failed, quarantined: quarantinedTotal, quarantinedNew, rawRecords, accepted, wallMs: now() - t0, attrStats: attrStats ? true : false };
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
        // Tree-scoped quarantine applies to deltas exactly as to
        // bootstrap: permanently-invalid changed files must not wedge
        // incremental mode either. New head tree → clean evaluation.
        const deltaQuarantined = quarantinedForTree(headTree);
        let quarantinedNew = 0;
        for (const f of changed) {
          if (deltaQuarantined.has(f.filename)) continue;
          try {
            const html = await fetchRaw(f.filename, branch);
            const json = decodeFragment(html, f.filename);
            const r = ingestJson(json);
            rawRecords += r.raw; accepted += r.accepted;
            recordFragment(runId, { name: f.filename, url: f.filename, status: 'complete', rawRecords: r.raw, accepted: r.accepted });
            noteFragmentQuarantine(headTree, f.filename, { ok: true });
            try {
              db.prepare('INSERT INTO corpus_fragment_shas (fragment_name, tree_sha, blob_sha, bytes, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(fragment_name) DO UPDATE SET tree_sha=excluded.tree_sha, bytes=excluded.bytes, updated_at=excluded.updated_at')
                .run(f.filename, headTree, null, html.length, now());
            } catch {}
            complete++;
          } catch (err) {
            const msg = String(err?.message || err).slice(0, 120);
            const classification = classifyFragmentFailure(err);
            const note = noteFragmentQuarantine(headTree, f.filename, { ok: false, classification, errorMsg: msg });
            recordFragment(runId, {
              name: f.filename, url: f.filename, status: 'failed', error: msg,
              category: classification.kind === 'deterministic' ? classification.reason : undefined,
            });
            if (note.quarantinedNow) {
              quarantinedNew++;
              log(`corpus update quarantined ${f.filename} reason=${classification.reason}; delta continues`);
            } else {
              failed++;
              failures.push(`${f.filename}: ${msg}`);
            }
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
        const deltaQuarantinedTotal = quarantinedCountForTree(headTree);
        if (deltaQuarantinedTotal > 0 || quarantinedNew > 0) {
          log(`corpus update claimed head=${String(headTree).slice(0, 8)} complete=${complete} quarantined=${deltaQuarantinedTotal}`);
        }
        return { ok: true, changed: true, headCommit, headTree, fragments: complete, removed: removed.length, quarantined: deltaQuarantinedTotal, quarantinedNew, rawRecords, accepted };
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
      // Crash recovery: a kill mid-bootstrap/update leaves the persisted
      // state behind while inFlight is gone. Recover to the last-good
      // position (usable when a revision exists, else absent) so the
      // scheduler resumes instead of wedging on 'busy' forever.
      // Fragment-level resume data makes the retry cheap.
      let cur = readState(db);
      if (!inFlight && (cur.state === CORPUS_STATES.UPDATING || cur.state === CORPUS_STATES.BOOTSTRAPPING)) {
        try {
          // Resume position: usable when a revision exists, usable-partial
          // when candidates were imported but no revision is claimed yet,
          // else absent. Candidate presence is an O(1) existence probe
          // (state counters may predate partial imports from older code).
          // Fragment-level resume data makes the retry cheap.
          let partial = !cur.imported_revision
            && ((cur.candidate_count ?? 0) > 0 || (cur.fragment_count ?? 0) > 0);
          if (!partial && !cur.imported_revision) {
            try {
              partial = !!db.prepare('SELECT 1 AS ok FROM candidates LIMIT 1').get();
            } catch {}
          }
          writeState(db, {
            state: cur.imported_revision ? CORPUS_STATES.USABLE : (partial ? CORPUS_STATES.USABLE_PARTIAL : CORPUS_STATES.ABSENT),
            last_error: `recovered stuck ${cur.state} after restart`,
          }, now);
        } catch {
          return { action: 'wait', nextDueMs: intervalMs };
        }
        cur = readState(db);
      }
      if (inFlight || cur.state === CORPUS_STATES.UPDATING || cur.state === CORPUS_STATES.BOOTSTRAPPING) {
        return { action: 'busy' };
      }
      if (cur.dbError) return { action: 'wait', nextDueMs: intervalMs };
      const backoff = Math.min(cur.consecutive_failures ?? 0, 3);
      const dueIn = (cur.last_check ?? 0) + intervalMs * 2 ** backoff - now();
      if (!cur.imported_revision) {
        // Absent or partially bootstrapped (no claimed revision): bootstrap
        // when due, never in a hot loop. Bounded sessions continue on a
        // SHORT cadence (session pause, backed off under persistent
        // failure) — not the 6 h steady-state cadence — so a fresh install
        // converges in about an hour of polite background work instead of
        // one giant foreground run. Discovery stays live-only meanwhile.
        if (!autoBootstrap) return { action: 'idle-absent' };
        const sessionDueIn = (cur.last_check ?? 0)
          + BOOTSTRAP_SESSION_PAUSE_MS * 2 ** backoff - now();
        if (sessionDueIn > 0) return { action: 'wait', nextDueMs: sessionDueIn };
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

/**
 * Maintenance master switch. CORPUS_ENABLED is canonical;
 * CORPUS_MAINTENANCE is honored as a legacy alias. Default ON.
 */
export function corpusMaintenanceEnabled(env = process.env) {
  const off = (v) => {
    const s = String(v ?? '').toLowerCase();
    return s === '0' || s === 'false';
  };
  if (off(env.CORPUS_MAINTENANCE)) return false;
  if (off(env.CORPUS_ENABLED)) return false;
  return true;
}
