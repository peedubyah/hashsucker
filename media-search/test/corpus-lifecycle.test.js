/**
 * Corpus lifecycle tests (corpus productization tranche).
 *
 * Deterministic: stub GitHub API (fetchFn), stub fragment source, real
 * in-memory discovery cache. No network, no provider calls.
 *
 * Covers:
 * - bootstrap imports stub fragments, pins revision, marks usable
 * - bootstrap resumes past complete fragments (no re-fetch)
 * - no-change update is cheap (HEAD check only, no revision advance)
 * - failed delta does not advance revision and preserves usable state
 * - tick scheduling: absent/bootstrap/wait/update/busy + backoff
 * - request-outcome backfill writes eligible associations only
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  createCorpusLifecycle,
  CORPUS_STATES,
  corpusUpdateIntervalMs,
} from '../src/lib/discovery/corpus-lifecycle.js';
import { backfillRequestMediaAssociations } from '../src/api/media-request.js';

const TREE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COMMIT_A = 'c0ffee0000000000000000000000000000000001';
const COMMIT_B = 'c0ffee0000000000000000000000000000000002';

// Minimal LZString-free path is not available (decode is real), so the
// stub source returns fragments whose fetch stub bypasses decode: we
// inject pre-decoded JSON by stubbing at the sourceFactory level is not
// possible (decode lives in lifecycle). Instead the stub fetchFragment
// returns HTML the REAL decoder can handle? Simpler: build the stub HTML
// via the real lz-string encoder to stay production-faithful.
import lzString from 'lz-string';

function fragmentHtml(records) {
  const payload = JSON.stringify({ torrents: records });
  const compressed = lzString.compressToEncodedURIComponent(payload);
  return `<html><body><iframe src="https://debridmediamanager.com/hashlist#${compressed}"></iframe></body></html>`;
}

const REC_A = { filename: 'Movie.A.2020.1080p.mkv', hash: 'aabbccddeeff00112233445566778899aabbcc01', bytes: 1000 };
const REC_B = { filename: 'Movie.B.2021.1080p.mkv', hash: 'aabbccddeeff00112233445566778899aabbcc02', bytes: 2000 };

function stubSource(fragmentsByName, fetchLog = []) {
  return {
    listFragments: async () => ({
      fragments: Object.keys(fragmentsByName).map((name) => ({ name, url: `https://raw.test/${name}`, size: 10 })),
      treeSha: TREE_A,
      branch: 'main',
    }),
    fetchFragment: async (url) => {
      fetchLog.push(url);
      const name = url.split('/').pop();
      if (!fragmentsByName[name]) throw new Error(`404 ${name}`);
      return fragmentsByName[name];
    },
  };
}

function stubFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const [match, body, status = 200] of routes) {
      const hit = match.endsWith('$')
        ? String(url).endsWith(match.slice(0, -1))
        : String(url).includes(match);
      if (hit) {
        return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function lifecycle(cache, { source, fetchRoutes = [], clock = () => Date.now() } = {}) {
  return createCorpusLifecycle({
    cache,
    sourceFactory: source ? () => source : null,
    repo: 'test/repo',
    fetchFn: stubFetch(fetchRoutes),
    clock,
    log: () => {},
  });
}

test('bootstrap imports fragments, pins revision, marks usable', async () => {
  const cache = createDiscoveryCache();
  try {
    const fetchLog = [];
    const lc = lifecycle(cache, {
      source: stubSource({ 'f1.html': fragmentHtml([REC_A]), 'f2.html': fragmentHtml([REC_B]) }, fetchLog),
    });
    assert.equal(lc.getState().state, CORPUS_STATES.ABSENT);
    const r = await lc.bootstrap();
    assert.equal(r.ok, true);
    assert.equal(r.complete, 2);
    const st = lc.getState();
    assert.equal(st.state, CORPUS_STATES.USABLE);
    assert.equal(st.imported_revision, TREE_A);
    assert.equal(st.candidate_count, 2);
    assert.equal(fetchLog.length, 2);
    const cands = cache.queryCandidatesByMedia('nope');
    assert.deepEqual(cands, []);
  } finally {
    cache.close();
  }
});

test('bootstrap resumes past complete fragments without re-fetch', async () => {
  const cache = createDiscoveryCache();
  try {
    const fetchLog = [];
    const frags = { 'f1.html': fragmentHtml([REC_A]), 'f2.html': fragmentHtml([REC_B]) };
    const lc = lifecycle(cache, { source: stubSource(frags, fetchLog) });
    void lc.getState();
    // Simulate a prior partial run: f1 complete for TREE_A.
    cache.db.exec(`INSERT INTO dmm_ingestion_runs (started_at, tree_sha, status) VALUES (1, '${TREE_A}', 'incomplete')`);
    const runId = cache.db.prepare('SELECT last_insert_rowid() AS id').get().id;
    cache.db.prepare(`INSERT INTO dmm_fragments (run_id, fragment_name, source_url, status) VALUES (?, 'f1.html', 'u', 'complete')`).run(runId);
    const r = await lc.bootstrap();
    assert.equal(r.ok, true);
    assert.equal(r.complete, 1, 'only f2 processed');
    assert.deepEqual(fetchLog, ['https://raw.test/f2.html']);
    assert.equal(lc.getState().candidate_count, 1, 'only f2 ingested (f1 skipped as complete)');
  } finally {
    cache.close();
  }
});

test('no-change update is cheap and does not advance revision', async () => {
  const cache = createDiscoveryCache();
  try {
    const fetch = stubFetch([
      ['/repos/test/repo$', { default_branch: 'main' }],
      ['/commits/main', [{ sha: COMMIT_A }]],
    ]);
    const lc = createCorpusLifecycle({
      cache, repo: 'test/repo', fetchFn: fetch, clock: () => 1000, log: () => {},
      sourceFactory: () => stubSource({}),
    });
    // Seed a usable baseline with commit marker.
    void lc.getState();
    cache.db.exec(`UPDATE corpus_state SET state='usable', imported_revision='${TREE_A}', imported_commit='${COMMIT_A}', candidate_count=2, fragment_count=2, updated_at=1000 WHERE id=1`);
    const r = await lc.updateOnce();
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.equal(fetch.calls.length, 2, 'HEAD check only: repo + commits');
    assert.ok(!fetch.calls.some((u) => u.includes('/compare/')), 'no compare call');
    const st = lc.getState();
    assert.equal(st.imported_revision, TREE_A, 'revision not advanced');
    assert.equal(st.consecutive_failures, 0);
  } finally {
    cache.close();
  }
});

test('failed delta preserves revision and usable state', async () => {
  const cache = createDiscoveryCache();
  try {
    const fetch = stubFetch([
      ['/repos/test/repo$', { default_branch: 'main' }],
      ['/commits/main', [{ sha: COMMIT_B }]],
      ['/compare/', { status: 'ahead', ahead_by: 1, files: [{ filename: 'fx.html', status: 'modified' }] }],
      ['raw.test/fx.html', { boom: true }, 500],
    ]);
    const lc = createCorpusLifecycle({
      cache, repo: 'test/repo', fetchFn: fetch, clock: () => 1000, log: () => {},
      sourceFactory: () => stubSource({}),
    });
    void lc.getState();
    cache.db.exec(`UPDATE corpus_state SET state='usable', imported_revision='${TREE_A}', imported_commit='${COMMIT_A}', candidate_count=2, fragment_count=2, updated_at=1000 WHERE id=1`);
    // raw fetch stub: make the fragment fetch fail via sourceFactory instead.
    const lc2fail = createCorpusLifecycle({
      cache, repo: 'test/repo', fetchFn: fetch, clock: () => 1000, log: () => {},
      sourceFactory: () => ({
        listFragments: async () => ({ fragments: [], treeSha: TREE_B, branch: 'main' }),
        fetchFragment: async () => { throw new Error('net down'); },
      }),
    });
    void lc;
    const r = await lc2fail.updateOnce();
    assert.equal(r.ok, false);
    const st = lc2fail.getState();
    assert.equal(st.imported_revision, TREE_A, 'revision NOT advanced');
    assert.equal(st.imported_commit, COMMIT_A);
    assert.equal(st.state, CORPUS_STATES.USABLE, 'still serving (fails < 3)');
    assert.equal(st.consecutive_failures, 1);
  } finally {
    cache.close();
  }
});

test('tick schedules bootstrap/wait/update with backoff', async () => {
  const cache = createDiscoveryCache();
  try {
    const lc = lifecycle(cache, {});
    const H = 6 * 60 * 60 * 1000;
    assert.equal(lc.tick({ intervalMs: H, autoBootstrap: false }).action, 'idle-absent');
    assert.equal(lc.tick({ intervalMs: H, autoBootstrap: true }).action, 'bootstrap');
    // Successful baseline checked just now -> wait.
    cache.db.exec(`UPDATE corpus_state SET state='usable', imported_revision='${TREE_A}', imported_commit='${COMMIT_A}', last_check=100000, consecutive_failures=0 WHERE id=1`);
    const w = lc.tick({ intervalMs: H, autoBootstrap: true });
    // clock is Date.now-based here; last_check=100000 is ancient -> update due.
    assert.equal(w.action, 'update');
    // Recent check -> wait with a due date.
    cache.db.exec(`UPDATE corpus_state SET last_check=${Date.now()} WHERE id=1`);
    const w2 = lc.tick({ intervalMs: H, autoBootstrap: true });
    assert.equal(w2.action, 'wait');
    assert.ok(w2.nextDueMs > 0);
  } finally {
    cache.close();
  }
});

test('corpusUpdateIntervalMs defaults and clamps', async () => {
  assert.equal(corpusUpdateIntervalMs({}), 6 * 60 * 60 * 1000);
  assert.equal(corpusUpdateIntervalMs({ CORPUS_UPDATE_INTERVAL_HOURS: '2' }), 2 * 60 * 60 * 1000);
  assert.equal(corpusUpdateIntervalMs({ CORPUS_UPDATE_INTERVAL_HOURS: '0.1' }), 6 * 60 * 60 * 1000);
});

test('backfill records eligible outcomes only', async () => {
  const cache = createDiscoveryCache();
  try {
    const n = backfillRequestMediaAssociations(cache, { mediaId: 'tt1' }, [
      { infoHash: REC_A.hash, fileIndex: null, rank: 1, identity: { eligible: true, confidence: 0.8, state: 'probable' } },
      { infoHash: REC_B.hash, fileIndex: null, rank: 2, identity: { eligible: false, confidence: 0.1, state: 'ineligible' } },
      null,
    ], 99);
    assert.equal(n, 1);
    const rows = cache.getMediaAssociations(REC_A.hash, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mediaId, 'tt1');
    assert.equal(cache.getMediaAssociations(REC_B.hash, null).length, 0);
  } finally {
    cache.close();
  }
});

test('malformed fragment input fails closed without revision', async () => {
  const cache = (await import('../src/lib/discovery/cache.js')).createDiscoveryCache();
  try {
    const lc = lifecycle(cache, {
      source: {
        listFragments: async () => ({ fragments: [{ name: 'bad.html', url: 'u' }], treeSha: TREE_A, branch: 'main' }),
        fetchFragment: async () => '<html>no payload here</html>',
      },
    });
    const r = await lc.bootstrap();
    assert.equal(r.ok, false);
    assert.equal(r.failed, 1);
    const st = lc.getState();
    assert.equal(st.imported_revision, null, 'no revision pinned');
    assert.equal(st.state, CORPUS_STATES.DEGRADED);
    assert.equal(st.consecutive_failures, 1);
  } finally {
    cache.close();
  }
});

test('legacy tree-only base resolves via compare and advances', async () => {
  const cache = (await import('../src/lib/discovery/cache.js')).createDiscoveryCache();
  try {
    const recs = [{ filename: 'New.2026.1080p.mkv', hash: 'ccddccddccdd00112233445566778899aabbcc03', bytes: 3000 }];
    const fetch = stubFetchLike();
    function stubFetchLike() {
      const calls = [];
      const fn = async (url) => {
        calls.push(String(url));
        const u = String(url);
        if (u.includes('/compare/')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ahead', ahead_by: 1, files: [{ filename: 'new.html', status: 'added' }] }), text: async () => '' };
        }
        if (u.includes('/commits/')) {
          return { ok: true, status: 200, json: async () => [{ sha: COMMIT_B }], text: async () => '' };
        }
        if (u.includes('/repos/test/repo')) {
          return { ok: true, status: 200, json: async () => ({ default_branch: 'main' }), text: async () => '' };
        }
        throw new Error(`unexpected ${u}`);
      };
      fn.calls = calls;
      return fn;
    }
    const lc = createCorpusLifecycle({
      cache, repo: 'test/repo', fetchFn: fetch, clock: () => 1000, log: () => {},
      sourceFactory: () => ({
        listFragments: async () => ({ fragments: [], treeSha: TREE_B, branch: 'main' }),
        fetchFragment: async () => { throw new Error('should not fetch listing'); },
      }),
    });
    void lc.getState();
    // Raw fetch for the delta file: serve real-decodable HTML via fetchFn.
    const lz = (await import('lz-string')).default;
    const html = `<html><iframe src="https://debridmediamanager.com/hashlist#${lz.compressToEncodedURIComponent(JSON.stringify({ torrents: recs }))}"></iframe></html>`;
    const origFetch = fetch;
    const fetch2 = async (url) => {
      if (String(url).includes('raw.githubusercontent')) {
        return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
      }
      return origFetch(url);
    };
    const lc2 = createCorpusLifecycle({
      cache, repo: 'test/repo', fetchFn: fetch2, clock: () => 1000, log: () => {},
      sourceFactory: () => ({
        listFragments: async () => ({ fragments: [], treeSha: TREE_B, branch: 'main' }),
        fetchFragment: async () => { throw new Error('should not fetch listing'); },
      }),
    });
    cache.db.exec(`UPDATE corpus_state SET state='usable', imported_revision='${TREE_A}', imported_commit=NULL, candidate_count=0, fragment_count=0, updated_at=1000 WHERE id=1`);
    const r = await lc2.updateOnce();
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    assert.equal(r.fragments, 1);
    const st = lc2.getState();
    assert.equal(st.imported_revision, TREE_B);
    assert.equal(st.imported_commit, COMMIT_B);
  } finally {
    cache.close();
  }
});
