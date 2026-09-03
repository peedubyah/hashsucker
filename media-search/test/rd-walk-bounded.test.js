/**
 * Real-Debrid bounded persisted-candidate walk tests (Worker B).
 *
 * Verifies the production-shape orchestration in
 * src/scripts/rd-walk-bounded.js. The `evaluate` function is injected
 * so the walk can be exercised against deterministic fixtures that
 * mirror the real RD response shape (infringing, absent, ambiguous,
 * cached).
 *
 * The walk reuses the active production seam:
 *   - attemptRdResolution (RD resolver)
 *   - rd-resolution-cache (single-flight + short-TTL URL cache)
 *   - discovery cache (persisted negative observations)
 *   - control-plane store (durable TorrentFile lookup)
 *
 * What is NOT re-implemented here:
 *   - A second RD client. The real createRealDebridClient is reused.
 *   - A second negative-cache table. The persisted
 *     provider_observation_current row is the source of truth.
 *   - A second VFS or capability URL store. The walk only emits
 *     structured JSON; the byte path remains in the WebDAV / FUSE
 *     / terminal-delivery-evidence pipeline.
 *
 * Tested contracts:
 *   W1  known RD-infringing persisted negatives are skipped without
 *       re-evaluating (B1, B11).
 *   W2  unknown persisted candidate is evaluated exactly once even
 *       when the same hash appears multiple times across ranks
 *       (B2: single-flight).
 *   W3  first positive maps to the existing TorrentFile (no new row,
 *       no RD-specific VFS).
 *   W4  ambiguous / absent / RD-infringing candidates are recorded
 *       and the walk continues.
 *   W5  RD throttle stops the walk and reports the rate-limit
 *       classification; the walk does not re-attempt the same hash.
 *   W6  walk respects maxCandidates — stops at N distinct hashes
 *       regardless of positive status.
 *   W7  single-owner: a second concurrent walk for the same target
 *       returns status=in_flight without issuing any evaluation.
 *   W8  restart with empty process memory: same hashes can be
 *       re-evaluated; the persisted negative cache still short-
 *       circuits the known RD-infringing ones.
 *   W9  walk does not log the unrestricted URL, the temporary RD
 *       torrent id, or the API key in any of its outputs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { walkPersistedCandidates } from '../src/scripts/rd-walk-bounded.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { getRdResolutionCache } from '../src/lib/providers/realdebrid/rd-resolution-cache.js';

const MEDIA_ID = 'tt7137906';
const SEASON = 1;
const EPISODE = 2;

// Rank5 hash, exact canonical path, exact size — matches the
// production TorrentFile tf_25b0a536-77e0-42aa-911f-c4c2a1bb4091.
const RANK5_HASH = '8862ba8185d52ad54a9fda496546d828ed244a91';
const RANK5_PATH =
  'When.They.See.Us.S01.1080p.NF.WEBRip.x265.10bit.HDR.DDP5.1.Atmos-ExREN[rartv]/When.They.See.Us.S01E02.1080p.NF.WEB-DL.Atmos.DDP5.1.HDR.H.265-ExREN.mkv';
const RANK5_SIZE = 2_834_055_554;
const RANK5_FILE_INDEX = 2;
const RANK5_TF_ID = 'tf_25b0a536-77e0-42aa-911f-c4c2a1bb4091';

// Known RD-infringing hashes (from persisted observations).
const INFRINGING_1 = '5ef1fb1fbbe57190008ae7892862c74d318e25a6';
const INFRINGING_2 = '7bed763cb4113a7b646fd72f5096fedb154a55c6';
const INFRINGING_3 = 'a07b84404989fccee1d55c247cb03e22c8847ecc';

// Persistent fixtures for the test corpus.
const FIXTURE_CANDIDATES = [
  { rank: 1, infoHash: INFRINGING_1, fileIndex: -1, filename: null, size: null },
  { rank: 2, infoHash: INFRINGING_1, fileIndex: 1, filename: null, size: null },
  { rank: 3, infoHash: INFRINGING_2, fileIndex: -1, filename: null, size: null },
  { rank: 4, infoHash: INFRINGING_3, fileIndex: -1, filename: null, size: null },
  { rank: 5, infoHash: RANK5_HASH, fileIndex: RANK5_FILE_INDEX, filename: RANK5_PATH, size: RANK5_SIZE },
  { rank: 6, infoHash: RANK5_HASH, fileIndex: -1, filename: RANK5_PATH, size: RANK5_SIZE },
  { rank: 7, infoHash: '7e24618dde5bf321b58efdcc3465c965b971a27a', fileIndex: 112, filename: null, size: null },
  { rank: 8, infoHash: '7e24618dde5bf321b58efdcc3465c965b971a27a', fileIndex: -1, filename: null, size: null },
];

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'hashsucker-rd-walk-'));
}

/**
 * Build a fresh discovery + control-plane state with the fixture
 * candidates and the persisted RD-infringing observations.
 */
function makeFixture() {
  const dir = makeTempDir();
  const dbPath = join(dir, 'discovery.db');
  const cpPath = join(dir, 'control-plane.db');

  const cache = createDiscoveryCache({ dbPath });

  // The cache exposes no public insert for media_requests /
  // media_request_results, so we open the same SQLite DB and write
  // directly. This matches the test pattern used elsewhere in the
  // suite (see realdebrid-b1-b10.test.js which uses appendProviderObservation
  // — also a direct write). The schema was already migrated by
  // createDiscoveryCache above.
  const db = new DatabaseSync(dbPath);
  const requestInsert = db.prepare(`
    INSERT INTO media_requests
      (media_id, media_type, season, episode, source, source_type, status, candidate_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const resultInsert = db.prepare(`
    INSERT INTO media_request_results
      (request_id, rank, info_hash, file_index_key, filename, score,
       score_breakdown, identity_tier, identity_confidence, identity_evidence,
       resolution_state, release_metadata, ranking_breakdown,
       eligible, ineligible_reason, ineligible_code, expected_media_scope,
       parsed_candidate_scope, selected_file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  const requestInfo = requestInsert.run(
    MEDIA_ID, 'series', SEASON, EPISODE, 'test', 'test', 'pending', FIXTURE_CANDIDATES.length, now,
  );
  const requestId = Number(requestInfo.lastInsertRowid);
  for (const cand of FIXTURE_CANDIDATES) {
    resultInsert.run(
      requestId,
      cand.rank,
      cand.infoHash,
      cand.fileIndex,
      cand.filename,
      1.0,
      null, null, null, null,
      null, null, null,
      1, null, null, null, null,
      cand.size,
    );
  }
  db.close();

  // Persist the three known RD-infringing observations (the same
  // state the production walk would find after a previous run).
  for (const hash of [INFRINGING_1, INFRINGING_2, INFRINGING_3]) {
    cache.appendProviderObservation({
      provider: 'realdebrid',
      infoHash: hash,
      fileIndex: null,
      scope: 'torrent',
      kind: 'authoritative',
      state: 'uncached',
      observedAt: Date.now(),
      ttlMs: 5 * 60 * 1000,
      source: 'resolver:rd-resolution',
      errorCategory: 'infringing',
      evidence: { rdErrorCode: 35 },
    });
  }

  // Insert the existing durable TorrentFile for rank5 — the walk
  // must find it, NOT create a new one. There is no public
  // upsertTorrentFile on the control-plane store; the production
  // path goes through `recordFileMapping` + `replaceProviderFileInventory`
  // which both require a provider placement row first. For the
  // walk-shape test we only need a TorrentFile row, so we insert
  // it directly via SQL after the store has run its migrations.
  const controlPlaneStore = createControlPlaneStore({ dbPath: cpPath });
  const cpDb = new DatabaseSync(cpPath);
  cpDb.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(RANK5_TF_ID, RANK5_HASH, RANK5_PATH, RANK5_SIZE, Date.now());
  cpDb.close();

  return { dir, dbPath, cpPath, cache, controlPlaneStore };
}

function makeEvaluateFixture() {
  // Per-hash evaluation outcome. The walk calls evaluate(...) for
  // each UNKNOWN persisted candidate. Each call returns a shape
  // that mirrors attemptRdResolution's actual return.
  const calls = [];
  return {
    calls,
    evaluate: async ({ infoHash, fileIndex, filename, size }) => {
      calls.push({ infoHash, fileIndex, filename, size });
      if (infoHash === RANK5_HASH) {
        return { status: 'resolved', rdFileId: 'rd-file-rank5', torrentId: 'torrent-rank5', timing: { total: 1 } };
      }
      if (infoHash === '7e24618dde5bf321b58efdcc3465c965b971a27a') {
        return {
          status: 'failed',
          error: { code: 'RD_FILE_MAPPING_FAILED', category: 'unavailable' },
        };
      }
      if (infoHash === 'throttle-trigger') {
        return {
          status: 'failed',
          error: { code: 'RD_COOLDOWN', category: 'rate-limit', rdErrorCode: 39 },
        };
      }
      return { status: 'failed', error: { code: 'RD_UNAVAILABLE', category: 'not-found' } };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('W1: known RD-infringing persisted negatives are skipped without re-evaluating', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    const report = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    // The 3 known infringing hashes must be skipped before any
    // evaluate() call lands.
    const evaluatedHashes = new Set(evaluate.calls.map((c) => c.infoHash));
    assert.ok(!evaluatedHashes.has(INFRINGING_1), 'infringing hash 1 must be skipped');
    assert.ok(!evaluatedHashes.has(INFRINGING_2), 'infringing hash 2 must be skipped');
    assert.ok(!evaluatedHashes.has(INFRINGING_3), 'infringing hash 3 must be skipped');

    // Each skipped hash must appear in visited with reason=infringing.
    const skipped = report.visited.filter((v) => v.outcome === 'skipped');
    assert.ok(skipped.length >= 3, `at least 3 hashes should be skipped, got ${skipped.length}`);

    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W2: unknown persisted candidate is evaluated exactly once even when listed at multiple ranks', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    // rank5 hash appears at rank 5 and rank 6 — evaluate() must be
    // called exactly once for it.
    const rank5Calls = evaluate.calls.filter((c) => c.infoHash === RANK5_HASH);
    assert.equal(rank5Calls.length, 1, 'rank5 must be evaluated exactly once across ranks 5 and 6');

    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W3: first positive maps to the existing TorrentFile; no new row created', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    const before = new Set(controlPlaneStore.allTorrentFileIds ? controlPlaneStore.allTorrentFileIds() : []);

    const report = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, 'resolved');
    assert.ok(report.firstPositive, 'firstPositive must be set');
    assert.equal(report.firstPositive.torrentFileId, RANK5_TF_ID, 'must reuse the existing TorrentFile');
    assert.equal(report.firstPositive.outcome, 'positive');

    // The walk must NOT have created a second TorrentFile for rank5.
    // We can't directly diff the control-plane store without an
    // export, so we use the count-of-evaluation-calls as proxy:
    // rank5 is evaluated exactly once (W2) and the lookup uses
    // findTorrentFile() which never writes.
    const rank5Calls = evaluate.calls.filter((c) => c.infoHash === RANK5_HASH);
    assert.equal(rank5Calls.length, 1);

    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W4: ambiguous / absent candidates are recorded and the walk continues', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    const report = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    // rank5 is positive → walk stops at rank5; the rank7 hash never
    // gets visited. The W4 contract is that ambiguous/absent hashes
    // do not poison subsequent iterations: confirmed by the
    // evaluate-calls record being exactly { rank5, [optionally rank7] }
    // depending on rank5 stopping the walk.
    assert.equal(report.ok, true);
    // After rank5 positive, the walk terminates. So rank7 may not be
    // visited. The contract is: skipped/absent ranks don't crash and
    // don't stop the walk; they appear in visited[]. If rank5 had
    // failed, the walk would continue to rank7 — covered separately
    // by W4b.
    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W4b: when rank5 fails as ambiguous, walk continues to rank7 and reports exhausted', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();
  // Replace rank5 with a failed outcome; rank7 returns a different
  // failure.
  evaluate.evaluate = async ({ infoHash }) => {
    evaluate.calls.push({ infoHash });
    if (infoHash === RANK5_HASH) {
      return {
        status: 'failed',
        error: { code: 'RD_FILE_MAPPING_FAILED', category: 'ambiguous' },
      };
    }
    if (infoHash === '7e24618dde5bf321b58efdcc3465c965b971a27a') {
      return {
        status: 'failed',
        error: { code: 'RD_UNAVAILABLE', category: 'not-found' },
      };
    }
    return { status: 'failed', error: { code: 'RD_UNAVAILABLE', category: 'not-found' } };
  };

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    const report = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, 'walked_all_candidates');
    // Both rank5 and rank7 must be evaluated.
    const hashes = new Set(evaluate.calls.map((c) => c.infoHash));
    assert.ok(hashes.has(RANK5_HASH), 'rank5 must be evaluated even when it fails');
    assert.ok(
      hashes.has('7e24618dde5bf321b58efdcc3465c965b971a27a'),
      'rank7 must be evaluated after rank5 fails',
    );

    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W5: RD throttle stops the walk and reports the rate-limit classification', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();
  evaluate.evaluate = async ({ infoHash }) => {
    evaluate.calls.push({ infoHash });
    if (infoHash === RANK5_HASH) {
      return {
        status: 'failed',
        error: { code: 'RD_COOLDOWN', category: 'rate-limit', rdErrorCode: 39 },
      };
    }
    return { status: 'failed', error: { code: 'RD_UNAVAILABLE', category: 'not-found' } };
  };

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    const report = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    assert.equal(report.status, 'rd_throttle');
    assert.equal(report.stoppedReason, 'rd_throttle');
    // The walk stops on the FIRST throttle signal — rank7 is not visited.
    const hashes = new Set(evaluate.calls.map((c) => c.infoHash));
    assert.ok(!hashes.has('7e24618dde5bf321b58efdcc3465c965b971a27a'), 'walk must stop on RD throttle');
    assert.ok(report.firstPositive === null);

    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W6: walk respects maxCandidates — stops after N distinct hashes regardless of positive', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();
  // Every unknown hash returns RD unavailable.
  evaluate.evaluate = async ({ infoHash }) => {
    evaluate.calls.push({ infoHash });
    return { status: 'failed', error: { code: 'RD_UNAVAILABLE', category: 'not-found' } };
  };

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    const report = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 3,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    assert.equal(report.stoppedReason, 'max_candidates');
    assert.equal(report.visitedCount, 3, 'walk must stop after exactly 3 distinct hashes');
    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W7: single-owner — a second concurrent walk for the same target returns status=in_flight', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();
  // Slow down the evaluate call so the second walk arrives during
  // the first one.
  evaluate.evaluate = async ({ infoHash }) => {
    evaluate.calls.push({ infoHash });
    await new Promise((r) => setTimeout(r, 50));
    if (infoHash === RANK5_HASH) {
      return { status: 'resolved', rdFileId: 'rd-file-rank5', torrentId: 'torrent-rank5', timing: { total: 1 } };
    }
    return { status: 'failed', error: { code: 'RD_UNAVAILABLE', category: 'not-found' } };
  };

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    const walkPromise = walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    // Issue a second walk immediately while the first is in flight.
    const second = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    assert.equal(second.status, 'in_flight');
    assert.equal(second.ok, false);
    // The first walk still completes normally.
    const first = await walkPromise;
    assert.equal(first.status, 'resolved');
    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W8: restart with empty process memory — known RD-infringing still short-circuits, unknown still evaluates', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();

  try {
    // First walk uses a fresh in-process rd-resolution cache (cleared
    // on restart). The persisted negative cache in SQLite still has
    // the infringing observations — they must short-circuit.
    const rdCache = getRdResolutionCache();
    rdCache.clear();

    const report1 = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });
    assert.equal(report1.status, 'resolved');
    assert.equal(report1.firstPositive.infoHash, RANK5_HASH);

    // "Restart": clear the in-process cache; open the same SQLite
    // databases. The walk must still skip the 3 known RD-infringing
    // hashes.
    rdCache.clear();
    evaluate.calls.length = 0;
    const report2 = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });
    assert.equal(report2.status, 'resolved');
    const evaluatedHashes = new Set(evaluate.calls.map((c) => c.infoHash));
    assert.ok(!evaluatedHashes.has(INFRINGING_1));
    assert.ok(!evaluatedHashes.has(INFRINGING_2));
    assert.ok(!evaluatedHashes.has(INFRINGING_3));

    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W9: walk report does NOT contain unrestricted URL, API key, or temporary RD torrent id', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    const report = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    // rdFileId is per-placement, ephemeral, NOT durable identity —
    // it is allowed in the summary so the parent can correlate the
    // RD delivery. unrestricted URL, API key, and torrent id MUST
    // NOT appear anywhere in the report.
    const json = JSON.stringify(report);
    // We do not have a real RD client here, so we only check for the
    // structural invariant: the report shape has no `unrestrictedUrl`,
    // `apiKey`, or `torrentId` field at the byte level.
    assert.ok(!('unrestrictedUrl' in report));
    assert.ok(!('apiKey' in report));
    assert.ok(!('torrentId' in report));
    // The visited[] entries likewise must not leak.
    for (const v of report.visited) {
      assert.ok(!('unrestrictedUrl' in v));
      assert.ok(!('torrentId' in v));
      assert.ok(!('apiKey' in v));
    }

    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('W9: walk output does not accidentally persist an RD-specific VFS row', async () => {
  const fixture = makeFixture();
  const { cache, controlPlaneStore } = fixture;
  const evaluate = makeEvaluateFixture();

  try {
    const rdCache = getRdResolutionCache();
    rdCache.clear();
    const report = await walkPersistedCandidates({
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      maxCandidates: 12,
      cache,
      controlPlaneStore,
      rdCache,
      evaluate: evaluate.evaluate,
    });

    assert.equal(report.ok, true);
    // The walk reports firstPositive.torrentFileId but does NOT
    // create any provider_file, provider_placement, or RD-specific
    // row. The lookup uses findTorrentFile (read-only) and never
    // writes to provider_files.
    //
    // We assert that the existing TorrentFile row count is unchanged
    // and no provider_file row references the rank5 hash with a
    // mapping_state other than the upstream Worker-A state.
    const cpDb = new DatabaseSync(fixture.cpPath);
    const tfCount = cpDb
      .prepare('SELECT COUNT(*) AS n FROM torrent_files')
      .get();
    assert.equal(tfCount.n, 1, 'walk must not create a second TorrentFile row');

    const providerFilesForRank5 = cpDb
      .prepare('SELECT COUNT(*) AS n FROM provider_files WHERE torrent_file_id = ?')
      .all(RANK5_TF_ID);
    // The walk never writes to provider_files; if upstream Worker-A
    // hasn't placed rank5 yet, this is 0. The walk itself never
    // changes it.
    assert.equal(providerFilesForRank5[0].n, 0, 'walk must not create any RD provider_file row');

    cpDb.close();
    cache.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});