/**
 * Historical Evidence Importer — disposable fixture tests
 *
 * Proves the 12 PROOF requirements from the importer spec:
 *   P1.  10 valid hashes import correctly
 *   P2.  Malformed hashes rejected
 *   P3.  Duplicate lines within same snapshot create one sighting
 *   P4.  Exact same snapshot rerun creates zero new sightings
 *   P5.  Same source / new version creates new sightings but same independent source
 *   P6.  Different source creates independent corroboration
 *   P7.  Release-level NULL and file-level:0 remain distinct
 *   P8.  Dry-run creates zero DB rows/checkpoints
 *   P9.  Forced failure mid-batch: committed prior batches remain,
 *        failed batch not checkpointed, resume produces same final
 *        logical state as uninterrupted import
 *   P10. Changed file with same source/version/fingerprint mismatch
 *        is rejected
 *   P11. Completed import rerun is safe
 *   P12. Shuffled duplicate input produces same logical evidence state
 *
 * Each test uses a fresh temp DB and temp input file. Tests do NOT
 * mutate any production path.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runFromOptions } from '../src/scripts/import-historical-provider-evidence.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tempDir() {
  // Use a workspace-local tmp dir because the system /tmp may be a
  // full tmpfs on this box. We keep the dir inside the repo for the
  // duration of the test run; tests are responsible for not leaking
  // them (see afterEach-style cleanup at end of each test).
  const base = process.env.HPE_TEST_TMP
    || path.join(process.cwd(), '.tmp-hpe-tests');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'hpe-'));
}

// Best-effort cleanup so test runs do not accumulate state in the repo.
test.after(async () => {
  const base = process.env.HPE_TEST_TMP
    || path.join(process.cwd(), '.tmp-hpe-tests');
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

function makeHash(prefix, i) {
  // 40-char SHA-1 hex: prefix + zero-padded index → sliced to 40.
  // Padding: target total length is 40, prefix length is len(prefix).
  // We pad hex to (40 - len(prefix)) chars, which may be up to 39.
  const total = 40;
  const padLen = total - prefix.length;
  const hex = i.toString(16).padStart(padLen, '0');
  return (prefix + hex).slice(0, total);
}

function writeInput(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

function buildDbPath(dir) {
  return path.join(dir, 'cache.db');
}

// Convenience: count historical evidence rows
function getRawDb(cache) {
  return cache.getRawDb();
}

function countSightings(cache, sourceId, sourceVersion) {
  return getRawDb(cache).prepare(
    `SELECT COUNT(*) AS n FROM historical_provider_evidence_sightings
     WHERE source_id = ? AND source_version = ?`
  ).get(sourceId, sourceVersion).n;
}

function countAggregate(cache, sourceId) {
  return getRawDb(cache).prepare(
    `SELECT COUNT(*) AS n FROM historical_provider_evidence
     WHERE source_id = ?`
  ).get(sourceId).n;
}

function countAllSightings(cache) {
  return getRawDb(cache).prepare(
    `SELECT COUNT(*) AS n FROM historical_provider_evidence_sightings`
  ).get().n;
}

function countAllEvidence(cache) {
  return getRawDb(cache).prepare(
    `SELECT COUNT(*) AS n FROM historical_provider_evidence`
  ).get().n;
}

function getCheckpoint(cache, sourceId, sourceVersion) {
  return getRawDb(cache).prepare(
    `SELECT * FROM import_checkpoints
     WHERE source_id = ? AND source_version = ?`
  ).get(sourceId, sourceVersion);
}

function distinctSnapshotCountFor(cache, infoHash, fileIndexKey, sourceId) {
  return getRawDb(cache).prepare(
    `SELECT distinct_snapshot_count FROM historical_provider_evidence
     WHERE info_hash = ? AND file_index_key = ? AND source_id = ?`
  ).get(infoHash, fileIndexKey, sourceId)?.distinct_snapshot_count ?? null;
}

// =============================================================================
// P1. 10 valid hashes import correctly
// =============================================================================
test('P1. 10 valid hashes import correctly (3 unique sightings, no errors)', async () => {
  const dir = tempDir();
  const hashes = [];
  for (let i = 0; i < 10; i += 1) hashes.push(makeHash('a', i));
  const input = writeInput(dir, 'snap.txt', hashes.join('\n') + '\n');
  const db = buildDbPath(dir);
  const r = await runFromOptions({
    provider: 'realdebrid',
    'source-id': 'rd-history',
    'source-version': 'V1',
    input,
    db,
    'batch-size': 100,
    now: NOW,
  });
  assert.equal(r.mode, 'live');
  assert.equal(r.rowsRead, 10);
  assert.equal(r.rowsValid, 10);
  assert.equal(r.rowsInvalid, 0);
  assert.equal(r.rowsDuplicate, 0);
  assert.equal(r.newSightings, 10);
  // We need to close the cache the importer opened to read state, but
  // the importer closes it on completion. We open a new one to inspect.
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect = createDiscoveryCache({ dbPath: db });
  try {
    assert.equal(countSightings(inspect, 'rd-history', 'V1'), 10);
    assert.equal(countAggregate(inspect, 'rd-history'), 10);
    const ckpt = getCheckpoint(inspect, 'rd-history', 'V1');
    assert.equal(ckpt.status, 'complete');
    assert.equal(ckpt.batches_committed, 1);
  } finally {
    inspect.close();
  }
});

// =============================================================================
// P2. Malformed hashes rejected
// =============================================================================
test('P2. Malformed hashes rejected; valid ones still imported', async () => {
  const dir = tempDir();
  const lines = [
    makeHash('b', 0),                              // valid
    'not-a-hash',                                  // invalid (10 chars)
    'g'.repeat(39),                                // invalid (39 chars)
    'h'.repeat(41),                                // invalid (41 chars)
    'F'.repeat(40),                                // valid (uppercase F is hex)
    'g'.repeat(40) + 'X',                          // invalid (non-hex char)
    makeHash('b', 1),                              // valid
  ];
  const input = writeInput(dir, 'snap.txt', lines.join('\n') + '\n');
  const db = buildDbPath(dir);
  const r = await runFromOptions({
    provider: 'realdebrid',
    'source-id': 'rd-history',
    'source-version': 'V1',
    input,
    db,
    'batch-size': 100,
    now: NOW,
  });
  assert.equal(r.rowsRead, 7);
  assert.equal(r.rowsValid, 3); // the two real hashes + the all-F hash
  assert.equal(r.rowsInvalid, 4);
  assert.equal(r.newSightings, 3);
});

// =============================================================================
// P3. Duplicate lines within same snapshot create one sighting
// =============================================================================
test('P3. Duplicate lines within same snapshot create one sighting', async () => {
  const dir = tempDir();
  const H = makeHash('c', 0);
  const body = [H, H, H, H, H].join('\n') + '\n';
  const input = writeInput(dir, 'snap.txt', body);
  const db = buildDbPath(dir);
  const r = await runFromOptions({
    provider: 'realdebrid',
    'source-id': 'rd-history',
    'source-version': 'V1',
    input,
    db,
    'batch-size': 100,
    now: NOW,
  });
  assert.equal(r.rowsRead, 5);
  assert.equal(r.rowsValid, 5);
  assert.equal(r.rowsDuplicate, 4);
  assert.equal(r.newSightings, 1);

  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect = createDiscoveryCache({ dbPath: db });
  try {
    // Sightings PK enforces one row per (infoHash, fileIndex, snapshot)
    assert.equal(countSightings(inspect, 'rd-history', 'V1'), 1);
  } finally {
    inspect.close();
  }
});

// =============================================================================
// P4. Exact same snapshot rerun creates zero new sightings
// =============================================================================
test('P4. Exact same snapshot rerun is a no-op for evidence tables', async () => {
  const dir = tempDir();
  const hashes = [];
  for (let i = 0; i < 10; i += 1) hashes.push(makeHash('d', i));
  const input = writeInput(dir, 'snap.txt', hashes.join('\n') + '\n');
  const db = buildDbPath(dir);
  // First run
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 100, now: NOW,
  });
  // Second run: must be fast no-op (no --resume)
  const r2 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 100, now: NOW,
  });
  assert.equal(r2.mode, 'rerun');
  assert.equal(r2.status, 'complete');
  // Inspect
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect = createDiscoveryCache({ dbPath: db });
  try {
    assert.equal(countSightings(inspect, 'rd-history', 'V1'), 10);
    assert.equal(countAggregate(inspect, 'rd-history'), 10);
  } finally {
    inspect.close();
  }
});

// =============================================================================
// P5. Same source / new version creates new sightings but same independent source
// =============================================================================
test('P5. New version of same source creates new sightings; aggregate distinct_snapshot_count bumps', async () => {
  const dir = tempDir();
  const hashes = [];
  for (let i = 0; i < 5; i += 1) hashes.push(makeHash('e', i));
  const input = writeInput(dir, 'snap.txt', hashes.join('\n') + '\n');
  const db = buildDbPath(dir);
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 100, now: NOW,
  });
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V2',
    input, db, 'batch-size': 100, now: NOW + DAY,
  });
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect = createDiscoveryCache({ dbPath: db });
  try {
    // Sightings: 5 in V1 + 5 in V2 = 10
    assert.equal(countSightings(inspect, 'rd-history', 'V1'), 5);
    assert.equal(countSightings(inspect, 'rd-history', 'V2'), 5);
    // Aggregate: one row per hash, distinct_snapshot_count = 2
    assert.equal(countAggregate(inspect, 'rd-history'), 5);
    const dsc = distinctSnapshotCountFor(inspect, makeHash('e', 0), -1, 'rd-history');
    assert.equal(dsc, 2);
  } finally {
    inspect.close();
  }
});

// =============================================================================
// P6. Different source creates independent corroboration
// =============================================================================
test('P6. Different source_id creates independent corroboration row', async () => {
  const dir = tempDir();
  const H = makeHash('f', 0);
  const input = writeInput(dir, 'snap.txt', `${H}\n`);
  const db = buildDbPath(dir);
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 100, now: NOW,
  });
  // Different source_id (e.g. another scraper) for the same hash
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-export-2', 'source-version': 'V1',
    input, db, 'batch-size': 100, now: NOW,
  });
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect = createDiscoveryCache({ dbPath: db });
  try {
    // 2 aggregate rows for the same hash (one per independent source)
    const rows = inspect.getHistoricalProviderEvidence(H, null);
    assert.equal(rows.length, 2);
    const sourceIds = rows.map((r) => r.source_id).sort();
    assert.deepEqual(sourceIds, ['rd-export-2', 'rd-history']);
  } finally {
    inspect.close();
  }
});

// =============================================================================
// P7. Release-level NULL and file-level:0 remain distinct
// =============================================================================
test('P7. Release-level NULL and file-level:0 remain distinct sightings', async () => {
  const dir = tempDir();
  const H = makeHash('7', 7);
  const body = [
    H,                 // release-level (fileIndex null)
    `${H},0`,          // file-level index 0
    `${H},0`,          // dup of file-level:0
    `${H},1`,          // file-level index 1
  ].join('\n') + '\n';
  const input = writeInput(dir, 'snap.txt', body);
  const db = buildDbPath(dir);
  const r = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 100, now: NOW,
  });
  assert.equal(r.rowsRead, 4);
  assert.equal(r.rowsValid, 4);
  assert.equal(r.rowsDuplicate, 1);
  assert.equal(r.newSightings, 3);

  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect = createDiscoveryCache({ dbPath: db });
  try {
    assert.equal(countSightings(inspect, 'rd-history', 'V1'), 3);
    // release-level: -1, file-level: 0, file-level: 1
    const release = getRawDb(inspect).prepare(
      `SELECT * FROM historical_provider_evidence_sightings
       WHERE info_hash = ? AND file_index_key = -1`
    ).get(H);
    assert.ok(release, 'release-level sighting must exist');
    const file0 = getRawDb(inspect).prepare(
      `SELECT * FROM historical_provider_evidence_sightings
       WHERE info_hash = ? AND file_index_key = 0`
    ).get(H);
    assert.ok(file0, 'file-level:0 sighting must exist');
    const file1 = getRawDb(inspect).prepare(
      `SELECT * FROM historical_provider_evidence_sightings
       WHERE info_hash = ? AND file_index_key = 1`
    ).get(H);
    assert.ok(file1, 'file-level:1 sighting must exist');
  } finally {
    inspect.close();
  }
});

// =============================================================================
// P8. Dry-run creates zero DB rows/checkpoints
// =============================================================================
test('P8. Dry-run creates zero DB rows and zero checkpoints', async () => {
  const dir = tempDir();
  const hashes = [];
  for (let i = 0; i < 20; i += 1) hashes.push(makeHash('8', i));
  const input = writeInput(dir, 'snap.txt', hashes.join('\n') + '\n');
  // Use a db path that must NOT be created on disk. Dry-run opens an
  // in-memory cache, so the user-supplied path is irrelevant for state.
  const db = path.join(dir, 'must-not-exist.db');
  assert.equal(fs.existsSync(db), false);
  const r = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 5, 'dry-run': true, now: NOW,
  });
  assert.equal(r.mode, 'dry-run');
  assert.equal(r.rowsRead, 20);
  assert.equal(r.rowsValid, 20);
  assert.equal(r.rowsInvalid, 0);
  assert.equal(r.rowsDuplicate, 0);
  assert.equal(r.batches, 0);
  assert.equal(r.newSightings, 0);
  // Dry-run must not create a file at the user-supplied path.
  assert.equal(fs.existsSync(db), false, 'dry-run must not create the DB file');
});

// =============================================================================
// P9. Forced failure mid-batch: committed prior batches remain, failed batch
//     not checkpointed, resume produces same final logical state
// =============================================================================
test('P9. Mid-batch failure leaves prior batches committed; resume completes', async () => {
  const dir = tempDir();
  const N = 25;
  const hashes = [];
  for (let i = 0; i < N; i += 1) hashes.push(makeHash('9', i));
  const input = writeInput(dir, 'snap.txt', hashes.join('\n') + '\n');
  const db = buildDbPath(dir);

  // First run: batch-size=10 → 3 batches (10, 10, 5). We'll inject a
  // failure into the ingest call after the first batch commits.
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const cache = createDiscoveryCache({ dbPath: db });
  const realIngest = cache.ingestHistoricalProviderEvidence.bind(cache);
  let calls = 0;
  cache.ingestHistoricalProviderEvidence = (opts) => {
    calls += 1;
    if (calls === 2) {
      // Simulate a crash BEFORE the second batch commits: the importer
      // should not advance the checkpoint and the prior batch (10 rows)
      // should be the only committed work.
      throw new Error('simulated mid-import crash');
    }
    return realIngest(opts);
  };

  await assert.rejects(
    () => runFromOptions({
      provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
      input, db, 'batch-size': 10, now: NOW, _cache: cache,
    }),
    /simulated mid-import crash/,
  );
  cache.close();

  // Reopen and verify: 1 batch committed (10 sightings), checkpoint at
  // lines_seen=10 with status='failed'.
  const inspect1 = createDiscoveryCache({ dbPath: db });
  try {
    assert.equal(countSightings(inspect1, 'rd-history', 'V1'), 10);
    const ckpt = getCheckpoint(inspect1, 'rd-history', 'V1');
    assert.equal(ckpt.status, 'failed');
    assert.equal(ckpt.batches_committed, 1);
    assert.equal(ckpt.lines_seen, 10);
  } finally {
    inspect1.close();
  }

  // Resume with the unmodified importer (no failure injection).
  const r2 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 10, resume: true, now: NOW,
  });
  assert.equal(r2.mode, 'live');
  assert.equal(r2.resumedFromLine, 10);
  // All N=25 rows in the final state.
  const inspect2 = createDiscoveryCache({ dbPath: db });
  try {
    assert.equal(countSightings(inspect2, 'rd-history', 'V1'), N);
    assert.equal(countAggregate(inspect2, 'rd-history'), N);
    const ckpt = getCheckpoint(inspect2, 'rd-history', 'V1');
    assert.equal(ckpt.status, 'complete');
  } finally {
    inspect2.close();
  }
});

// =============================================================================
// P10. Changed file with same source/version/fingerprint mismatch is rejected
// =============================================================================
test('P10. Changed file with same source/version is rejected without --reset', async () => {
  const dir = tempDir();
  const H = makeHash('a', 10);
  const input1 = writeInput(dir, 'snap1.txt', `${H}\n`);
  const db = buildDbPath(dir);
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input: input1, db, 'batch-size': 100, now: NOW,
  });
  // Mutate the file (different content → different fingerprint)
  const input2 = writeInput(dir, 'snap2.txt', `${makeHash('a', 11)}\n`);
  await assert.rejects(
    () => runFromOptions({
      provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
      input: input2, db, 'batch-size': 100, now: NOW,
    }),
    /input fingerprint mismatch/,
  );
});

// =============================================================================
// P11. Completed import rerun is safe (replay-idempotent)
// =============================================================================
test('P11. Completed import rerun is safe and produces a fast no-op report', async () => {
  const dir = tempDir();
  const hashes = [];
  for (let i = 0; i < 50; i += 1) hashes.push(makeHash('b', i));
  const input = writeInput(dir, 'snap.txt', hashes.join('\n') + '\n');
  const db = buildDbPath(dir);
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 25, now: NOW,
  });
  // 5 reruns back-to-back. All must be fast no-ops.
  for (let i = 0; i < 5; i += 1) {
    const r = await runFromOptions({
      provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
      input, db, 'batch-size': 25, now: NOW,
    });
    assert.equal(r.mode, 'rerun');
    assert.equal(r.status, 'complete');
  }
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect = createDiscoveryCache({ dbPath: db });
  try {
    assert.equal(countSightings(inspect, 'rd-history', 'V1'), 50);
  } finally {
    inspect.close();
  }
});

// =============================================================================
// P12. Shuffled duplicate input produces same logical evidence state
// =============================================================================
test('P12. Shuffled duplicate input produces identical aggregate state', async () => {
  const dir = tempDir();
  const H = makeHash('c', 0);
  const ordered = [H, H, H, makeHash('c', 1), H, makeHash('c', 2), H].join('\n') + '\n';
  const shuffled = [makeHash('c', 2), H, makeHash('c', 1), H, H, H, H].join('\n') + '\n';

  const input1 = writeInput(dir, 'snap-ordered.txt', ordered);
  const db1 = buildDbPath(dir) + '.ordered';
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input: input1, db: db1, 'batch-size': 100, now: NOW,
  });

  const input2 = writeInput(dir, 'snap-shuffled.txt', shuffled);
  const db2 = buildDbPath(dir) + '.shuffled';
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input: input2, db: db2, 'batch-size': 100, now: NOW,
  });

  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const a = createDiscoveryCache({ dbPath: db1 });
  const b = createDiscoveryCache({ dbPath: db2 });
  try {
    const ha = a.getHistoricalProviderEvidence(H, null);
    const hb = b.getHistoricalProviderEvidence(H, null);
    assert.equal(ha.length, hb.length);
    assert.equal(ha[0].distinct_snapshot_count, hb[0].distinct_snapshot_count);
    assert.equal(ha[0].first_seen_at, hb[0].first_seen_at);
    assert.equal(ha[0].last_seen_at, hb[0].last_seen_at);
    assert.equal(countSightings(a, 'rd-history', 'V1'), countSightings(b, 'rd-history', 'V1'));
  } finally {
    a.close();
    b.close();
  }
});

// =============================================================================
// Bonus: CSV format
// =============================================================================
test('B1. CSV format with header is detected and parsed', async () => {
  const dir = tempDir();
  const H1 = makeHash('c', 100);
  const H2 = makeHash('c', 101);
  const body = [
    'info_hash,file_index,observed_at',
    `${H1},0,${NOW}`,
    `${H2},,${NOW + 1000}`,
  ].join('\n') + '\n';
  const input = writeInput(dir, 'snap.csv', body);
  const db = buildDbPath(dir);
  const r = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 100, now: NOW,
  });
  assert.equal(r.rowsValid, 2);
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect = createDiscoveryCache({ dbPath: db });
  try {
    const f0 = getRawDb(inspect).prepare(
      `SELECT * FROM historical_provider_evidence_sightings WHERE info_hash = ? AND file_index_key = 0`
    ).get(H1);
    const fneg = getRawDb(inspect).prepare(
      `SELECT * FROM historical_provider_evidence_sightings WHERE info_hash = ? AND file_index_key = -1`
    ).get(H2);
    assert.ok(f0, 'file-level:0 row must exist');
    assert.ok(fneg, 'release-level row must exist');
  } finally {
    inspect.close();
  }
});

// =============================================================================
// Bonus: Lowercase normalization
// =============================================================================
test('B2. Uppercase hashes are normalized to lowercase', async () => {
  const dir = tempDir();
  const H = makeHash('d', 200).toUpperCase();
  const input = writeInput(dir, 'snap.txt', `${H}\n`);
  const db = buildDbPath(dir);
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 100, now: NOW,
  });
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect = createDiscoveryCache({ dbPath: db });
  try {
    const row = getRawDb(inspect).prepare(
      `SELECT info_hash FROM historical_provider_evidence_sightings WHERE info_hash = ?`
    ).get(H.toLowerCase());
    assert.ok(row, 'uppercase hash must be stored as lowercase');
  } finally {
    inspect.close();
  }
});

// =============================================================================
// Bonus: --reset wipes prior snapshot and re-imports
// =============================================================================
test('B3. --reset wipes prior snapshot and re-imports', async () => {
  const dir = tempDir();
  const H = makeHash('e', 0);
  const input = writeInput(dir, 'snap.txt', `${H}\n`);
  const db = buildDbPath(dir);
  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 100, now: NOW,
  });
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const inspect1 = createDiscoveryCache({ dbPath: db });
  assert.equal(countSightings(inspect1, 'rd-history', 'V1'), 1);
  inspect1.close();

  await runFromOptions({
    provider: 'realdebrid', 'source-id': 'rd-history', 'source-version': 'V1',
    input, db, 'batch-size': 100, reset: true, now: NOW,
  });
  const inspect2 = createDiscoveryCache({ dbPath: db });
  try {
    assert.equal(countSightings(inspect2, 'rd-history', 'V1'), 1);
    // Status must be 'complete' after a successful --reset run
    const ckpt = getCheckpoint(inspect2, 'rd-history', 'V1');
    assert.equal(ckpt.status, 'complete');
  } finally {
    inspect2.close();
  }
});
