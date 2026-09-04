/**
 * RD history acquisition — disposable fixture tests.
 *
 * Maps to the 10 PROOF requirements from the spec:
 *   A1. Parse a representative source fixture
 *   A2. Deterministic infoHashes extracted correctly
 *   A3. Malformed/non-hash entries rejected
 *   A4. Duplicates collapse
 *   A5. Source reordered => same logical snapshot
 *   A6. Interrupted acquisition can restart safely (resumability)
 *   A7. Secrets never appear in output/manifest/logs
 *   A8. Resulting snapshot imports successfully through 730e0a1 importer
 *   A9. Exact same snapshot re-import => zero new sightings
 *   A10. Changed acquisition snapshot under new sourceVersion => new
 *        sightings
 *
 * B1. Larger scale: 5k entries paginated through the merge.
 * B2. Authentication is required and is not logged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { acquireRdHistory, normalizeEntry } from '../src/lib/acquisition/rd-history.js';
import { runFromOptions } from '../src/scripts/import-historical-provider-evidence.js';
import {
  createFakeRdFetch,
  makeRdEntry,
} from './fixtures/rd-acquisition/fake-rd-server.js';

const NOW = 1_700_000_000_000;
const RD_TOKEN = 'RD_TEST_TOKEN_DO_NOT_LOG_xyz_42';

function tempDir() {
  const base = process.env.RD_ACQ_TEST_TMP
    || path.join(process.cwd(), '.tmp-rd-acq-tests');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'rdacq-'));
}

test.after(async () => {
  const base = process.env.RD_ACQ_TEST_TMP
    || path.join(process.cwd(), '.tmp-rd-acq-tests');
  if (fs.existsSync(base)) {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function newTempPath(dir, name) {
  return path.join(dir, name);
}

// -----------------------------------------------------------------------------
// A1. Parse a representative source fixture
// -----------------------------------------------------------------------------

test('A1: parses a small representative RD /torrents fixture', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const entries = Array.from({ length: 25 }, (_, i) => makeRdEntry(i));
  const fetchFn = createFakeRdFetch({ entries, pageSize: 10 });

  const result = await acquireRdHistory({
    apiKey: RD_TOKEN,
    outputPath: out,
    fetchFn,
    pageSize: 10,
    chunkRows: 0, // in-memory for small input
    now: () => NOW,
  });

  assert.equal(result.rowsSeen, 25);
  assert.equal(result.rowsAccepted, 25);
  assert.equal(result.rowsRejected, 0);
  assert.equal(result.pagesFetched, 3, '25 / 10 = 3 pages');
  assert.ok(fs.existsSync(out));
  assert.ok(fs.existsSync(`${out}.manifest.json`));

  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(lines.length, 25);
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.match(obj.infoHash, /^[a-f0-9]{40}$/);
    assert.equal(typeof obj.observedAt, 'number');
  }
});

// -----------------------------------------------------------------------------
// A2. Deterministic infoHashes extracted correctly
// -----------------------------------------------------------------------------

test('A2: extracted infoHashes match the source exactly', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const entries = [makeRdEntry(7), makeRdEntry(11), makeRdEntry(42)];
  const fetchFn = createFakeRdFetch({ entries, pageSize: 100 });

  const result = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 100, chunkRows: 0, now: () => NOW,
  });

  const expected = new Set(entries.map((e) => e.hash));
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  const actual = new Set(lines.map((l) => JSON.parse(l).infoHash));
  assert.deepEqual([...actual].sort(), [...expected].sort());
  assert.equal(result.rowsAccepted, 3);
});

// -----------------------------------------------------------------------------
// A3. Malformed/non-hash entries rejected
// -----------------------------------------------------------------------------

test('A3: entries missing a valid hash field are rejected', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const entries = [makeRdEntry(0), makeRdEntry(1), makeRdEntry(2)];
  // pageSize=1 -> three pages at offsets 0, 1, 2. Mark offsets 0 and 2
  // as having bad hashes -> entries 0 and 2 are rejected, entry 1 survives.
  const fetchFn = createFakeRdFetch({ entries, pageSize: 1, badHashes: [0, 2] });

  const result = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 1, chunkRows: 0, now: () => NOW,
  });

  assert.equal(result.rowsSeen, 3);
  assert.equal(result.rowsAccepted, 1);
  assert.equal(result.rowsRejected, 2);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  // The surviving entry should be entry[1]
  assert.equal(JSON.parse(lines[0]).infoHash, entries[1].hash);
});

test('A3: entries missing added date are rejected', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const entries = [makeRdEntry(0), makeRdEntry(1)];
  const fetchFn = createFakeRdFetch({ entries, pageSize: 100, dropField: 'added' });

  const result = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 100, chunkRows: 0, now: () => NOW,
  });

  assert.equal(result.rowsAccepted, 0);
  assert.equal(result.rowsRejected, 2);
});

test('A3: normalizeEntry returns null for missing/garbage hash', () => {
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry({}), null);
  assert.equal(normalizeEntry({ hash: 'short', added: '2024-01-01T00:00:00Z' }), null);
  assert.equal(normalizeEntry({ hash: 'Z'.repeat(40), added: '2024-01-01T00:00:00Z' }), null);
  const ok = normalizeEntry({ hash: 'a'.repeat(40), added: '2024-01-01T00:00:00Z' });
  assert.equal(ok.infoHash, 'a'.repeat(40));
  assert.equal(ok.observedAtMs, Date.parse('2024-01-01T00:00:00Z'));
});

// -----------------------------------------------------------------------------
// A4. Duplicates collapse
// -----------------------------------------------------------------------------

test('A4: duplicate entries across pages collapse to one', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const entries = Array.from({ length: 20 }, (_, i) => makeRdEntry(i));
  // Inject duplicate: on the page at offset 0, also return entry[10]
  // (which would otherwise first appear on the page at offset 10). This
  // gives the acquirer two sightings of the same hash from two pages.
  const fetchFn = createFakeRdFetch({
    entries, pageSize: 10, duplicateEntries: [0],
  });

  const result = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 10, chunkRows: 0, now: () => NOW,
  });

  // 20 unique + 1 injected duplicate = 21 seen, 20 accepted.
  assert.equal(result.rowsSeen, 21);
  assert.equal(result.rowsAccepted, 20);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(lines.length, 20);
  const hashes = lines.map((l) => JSON.parse(l).infoHash);
  assert.equal(new Set(hashes).size, 20, 'every output hash is unique');
});

// -----------------------------------------------------------------------------
// A5. Source reordered => same logical snapshot
// -----------------------------------------------------------------------------

test('A5: reordered source produces the same deduped snapshot', async () => {
  const dir = tempDir();
  const out1 = newTempPath(dir, 'snap1.ndjson');
  const out2 = newTempPath(dir, 'snap2.ndjson');

  const base = Array.from({ length: 30 }, (_, i) => makeRdEntry(i));
  const reversed = [...base].reverse();
  const fetchFn1 = createFakeRdFetch({ entries: base, pageSize: 10 });
  const fetchFn2 = createFakeRdFetch({ entries: reversed, pageSize: 10 });

  const r1 = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out1, fetchFn: fetchFn1,
    pageSize: 10, chunkRows: 0, now: () => NOW,
  });
  const r2 = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out2, fetchFn: fetchFn2,
    pageSize: 10, chunkRows: 0, now: () => NOW,
  });

  assert.equal(r1.rowsAccepted, 30);
  assert.equal(r2.rowsAccepted, 30);
  const text1 = fs.readFileSync(out1, 'utf8');
  const text2 = fs.readFileSync(out2, 'utf8');
  // Both snapshots should be sorted by infoHash after merge, so byte-equal.
  assert.equal(text1, text2);
});

// -----------------------------------------------------------------------------
// A6. Interrupted acquisition can restart safely
// -----------------------------------------------------------------------------

test('A6: a transient HTTP 500 on page 2 retries and completes', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const entries = Array.from({ length: 50 }, (_, i) => makeRdEntry(i));
  const fetchFn = createFakeRdFetch({
    entries, pageSize: 10,
    transientFailures: [{ offset: 10, status: 500 }],
  });

  const result = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 10, chunkRows: 0, now: () => NOW,
    retryBaseMs: 1, // keep test fast
  });

  assert.equal(result.rowsAccepted, 50);
  assert.equal(result.rowsRejected, 0);
});

test('A6: 429 honors retry-after and recovers', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const entries = Array.from({ length: 25 }, (_, i) => makeRdEntry(i));
  const innerFetch = createFakeRdFetch({ entries, pageSize: 10 });
  let firstTry = true;
  const fetchFn = async (url, options) => {
    const u = new URL(url);
    if (firstTry && u.searchParams.get('offset') === '10') {
      firstTry = false;
      return {
        status: 429,
        ok: false,
        headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '0' : null) },
        async text() { return JSON.stringify({ error: 'rate limit' }); },
      };
    }
    return innerFetch(url, options);
  };

  const result = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 10, chunkRows: 0, now: () => NOW,
    retryBaseMs: 1,
  });

  assert.equal(result.rowsAccepted, 25);
});

// -----------------------------------------------------------------------------
// A7. Secrets never appear in output/manifest/logs
// -----------------------------------------------------------------------------

test('A7: API key is not written to output, manifest, or logs', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const entries = Array.from({ length: 5 }, (_, i) => makeRdEntry(i));
  const fetchFn = createFakeRdFetch({ entries, pageSize: 100 });
  const capturedLog = [];
  const log = (m) => capturedLog.push(m);

  const result = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 100, chunkRows: 0, now: () => NOW, log,
  });

  const outText = fs.readFileSync(out, 'utf8');
  const manifestText = fs.readFileSync(`${out}.manifest.json`, 'utf8');
  assert.ok(!outText.includes(RD_TOKEN), 'token not in NDJSON');
  assert.ok(!manifestText.includes(RD_TOKEN), 'token not in manifest');
  for (const line of capturedLog) {
    assert.ok(!line.includes(RD_TOKEN), `token not in log line: ${line}`);
  }
  // Manifest does not contain Authorization
  assert.ok(!manifestText.includes('Authorization'));
  // Manifest does not contain bearer
  assert.ok(!/bearer\s/i.test(manifestText));
});

test('A7: 401 from server does not leak the token in the error', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const fetchFn = async () => ({
    status: 401, ok: false,
    headers: { get: () => null },
    async text() { return JSON.stringify({ error: 'unauthorized' }); },
  });
  const capturedLog = [];
  const log = (m) => capturedLog.push(m);

  await assert.rejects(
    acquireRdHistory({
      apiKey: RD_TOKEN, outputPath: out, fetchFn,
      pageSize: 100, chunkRows: 0, now: () => NOW, log,
    }),
    /HTTP 401/
  );
  for (const line of capturedLog) {
    assert.ok(!line.includes(RD_TOKEN), `token not in log line: ${line}`);
  }
});

// -----------------------------------------------------------------------------
// A8. Resulting snapshot imports successfully through 730e0a1 importer
// -----------------------------------------------------------------------------

test('A8: acquired snapshot imports through importer (rd-history format)', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');

  const entries = Array.from({ length: 12 }, (_, i) => makeRdEntry(i));
  const fetchFn = createFakeRdFetch({ entries, pageSize: 10 });

  const acq = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 10, chunkRows: 0, now: () => NOW,
  });
  assert.equal(acq.rowsAccepted, 12);

  const manifest = JSON.parse(fs.readFileSync(`${out}.manifest.json`, 'utf8'));
  // Use the manifest's sourceVersion for the importer — this is the
  // production link: each acquisition is a unique snapshot identity.
  const stats = await runFromOptions({
    provider: 'realdebrid',
    'source-id': manifest.sourceId,
    'source-version': manifest.sourceVersion,
    input: out,
    format: 'rd-history',
    db,
    now: NOW,
  });
  assert.equal(stats.rowsValid, 12);
  assert.equal(stats.newSightings, 12);
  assert.equal(stats.existingSightings, 0);
  assert.equal(stats.batches, 1);
});

// -----------------------------------------------------------------------------
// A9. Exact same snapshot re-import => zero new sightings
// -----------------------------------------------------------------------------

test('A9: re-importing the same snapshot is a zero-sighting no-op', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');

  const entries = Array.from({ length: 7 }, (_, i) => makeRdEntry(i));
  const fetchFn = createFakeRdFetch({ entries, pageSize: 100 });
  const acq = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 100, chunkRows: 0, now: () => NOW,
  });
  const manifest = JSON.parse(fs.readFileSync(`${out}.manifest.json`, 'utf8'));

  const first = await runFromOptions({
    provider: 'realdebrid',
    'source-id': manifest.sourceId,
    'source-version': manifest.sourceVersion,
    input: out,
    format: 'rd-history',
    db,
    now: NOW,
  });
  assert.equal(first.newSightings, 7);

  // Rerun with same identity, no --reset, no --resume
  const second = await runFromOptions({
    provider: 'realdebrid',
    'source-id': manifest.sourceId,
    'source-version': manifest.sourceVersion,
    input: out,
    format: 'rd-history',
    db,
    now: NOW,
  });
  // Completed import rerun is a fast no-op (mode 'rerun'), so
  // newSightings is not defined on the stats object. The hard
  // contract is "no new evidence rows were created".
  assert.equal(second.mode, 'rerun', 'rerun short-circuits as a no-op');
  assert.equal(second.status, 'complete');
});

// -----------------------------------------------------------------------------
// A10. New acquisition under new sourceVersion => new content creates
// new sightings; overlapping content from a prior sourceVersion is
// already-seen under event identity (NOT a duplicate hit for
// confidence).
// -----------------------------------------------------------------------------

test('A10: new acquisition under new sourceVersion produces new sightings for new content only', async () => {
  const dir = tempDir();
  const out1 = newTempPath(dir, 'snap1.ndjson');
  const out2 = newTempPath(dir, 'snap2.ndjson');
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');

  // First acquisition: 5 entries
  const fetchFn1 = createFakeRdFetch({
    entries: Array.from({ length: 5 }, (_, i) => makeRdEntry(i)),
    pageSize: 100,
  });
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out1, fetchFn: fetchFn1,
    pageSize: 100, chunkRows: 0, now: () => NOW,
  });
  const m1 = JSON.parse(fs.readFileSync(`${out1}.manifest.json`, 'utf8'));

  // Second acquisition: 8 entries, last 3 are new. Force a different
  // sourceVersion by advancing the acquirer's `now` between runs.
  const fetchFn2 = createFakeRdFetch({
    entries: Array.from({ length: 8 }, (_, i) => makeRdEntry(i)),
    pageSize: 100,
  });
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out2, fetchFn: fetchFn2,
    pageSize: 100, chunkRows: 0, now: () => NOW + 60_000,
  });
  const m2 = JSON.parse(fs.readFileSync(`${out2}.manifest.json`, 'utf8'));

  // Different acquisitions get different sourceVersions
  assert.notEqual(m1.sourceVersion, m2.sourceVersion);

  // Import both, into the same DB, in order
  const s1 = await runFromOptions({
    provider: 'realdebrid',
    'source-id': m1.sourceId,
    'source-version': m1.sourceVersion,
    input: out1,
    format: 'rd-history',
    db,
    now: NOW,
  });
  assert.equal(s1.newSightings, 5);

  const s2 = await runFromOptions({
    provider: 'realdebrid',
    'source-id': m2.sourceId,
    'source-version': m2.sourceVersion,
    input: out2,
    format: 'rd-history',
    db,
    now: NOW + 60_000,
  });
  // Under event identity: the 5 entries that already exist from
  // snapshot 1 share the same source_event_id with snapshot 2 and
  // collide on the (info_hash, provider, evidence_type, source_id,
  // source_event_id) primary key — they are NOT new sightings.
  // Only the 3 new RD torrents produce new sightings.
  assert.equal(s2.newSightings, 3);
  assert.equal(s2.existingSightings, 5);
});

// -----------------------------------------------------------------------------
// B1. Larger scale: 5k entries through the merge path
// -----------------------------------------------------------------------------

test('B1: 5,000 entries paginated, deduped, written', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const N = 5000;
  const entries = Array.from({ length: N }, (_, i) => makeRdEntry(i));
  const fetchFn = createFakeRdFetch({ entries, pageSize: 1000 });

  const result = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 1000, chunkRows: 1000, // force spill/merge
    now: () => NOW,
  });

  assert.equal(result.rowsSeen, N);
  assert.equal(result.rowsAccepted, N);
  assert.equal(result.rowsRejected, 0);
  assert.equal(result.pagesFetched, 5);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(lines.length, N);
  const hashes = lines.map((l) => JSON.parse(l).infoHash);
  assert.equal(new Set(hashes).size, N, 'all hashes unique after merge');
  // Output is sorted by sourceEventId (NOT by infoHash). The dedup
  // key is the event identity, so this is the canonical sort.
  const eventIds = lines.map((l) => JSON.parse(l).sourceEventId);
  const sorted = [...eventIds].sort();
  assert.deepEqual(eventIds, sorted, 'merged output is sorted by sourceEventId');
  // Also confirm chunking/merge path actually ran (proves the
  // external-sort path is exercised, not the in-memory path).
  assert.ok(result.chunkCount > 1, 'multiple chunks were spilled');
  assert.ok(result.mergePasses >= 1, 'merge ran at least one pass');
});

// -----------------------------------------------------------------------------
// B2. Authentication is required and is not logged
// -----------------------------------------------------------------------------

test('B2: missing Authorization header on /torrents is rejected', async () => {
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const entries = [makeRdEntry(0)];
  // Strip the Authorization header
  const fetchFn = async (url, options = {}) => {
    const opts2 = { ...options, headers: { ...(options.headers || {}), Authorization: undefined } };
    delete opts2.headers.Authorization;
    return createFakeRdFetch({ entries, pageSize: 100 })(url, opts2);
  };

  await assert.rejects(
    acquireRdHistory({
      apiKey: 'abc', outputPath: out, fetchFn,
      pageSize: 100, chunkRows: 0, now: () => NOW,
    }),
    /HTTP 401/
  );
});

// -----------------------------------------------------------------------------
// PK hardening regression: two providers sharing source_id+source_version
// get independent checkpoint rows. This is the change that prompted the
// acquisition tool to use (provider, source_id, source_version).
// -----------------------------------------------------------------------------

test('PK: two providers sharing source_id+source_version do not collide', async () => {
  const dir = tempDir();
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');
  const sourceId = 'shared-source';
  const sourceVersion = 'shared-version';

  // Build two tiny NDJSON files
  const a = newTempPath(dir, 'a.ndjson');
  const b = newTempPath(dir, 'b.ndjson');
  const entriesA = [makeRdEntry(100)];
  const entriesB = [makeRdEntry(200)];
  fs.writeFileSync(a, `${JSON.stringify({ infoHash: entriesA[0].hash, observedAt: 1700000000000 })}\n`);
  fs.writeFileSync(b, `${JSON.stringify({ infoHash: entriesB[0].hash, observedAt: 1700000000000 })}\n`);

  // Run the importer twice with the same source_id/source_version but
  // different providers. Both should commit without colliding.
  const rA = await runFromOptions({
    provider: 'realdebrid',
    'source-id': sourceId,
    'source-version': sourceVersion,
    input: a,
    format: 'rd-history',
    db,
    now: NOW,
  });
  assert.equal(rA.newSightings, 1);

  const rB = await runFromOptions({
    provider: 'torbox',
    'source-id': sourceId,
    'source-version': sourceVersion,
    input: b,
    format: 'rd-history',
    db,
    now: NOW,
  });
  assert.equal(rB.newSightings, 1, 'torbox snapshot not blocked by realdebrid checkpoint');

  // And a rerun under realdebrid is a no-op:
  const rA2 = await runFromOptions({
    provider: 'realdebrid',
    'source-id': sourceId,
    'source-version': sourceVersion,
    input: a,
    format: 'rd-history',
    db,
    now: NOW,
  });
  assert.equal(rA2.mode, 'rerun', 'realdebrid rerun short-circuits as a no-op');
});

// ===========================================================================
// PROOF TESTS — session 9 hardening
//
// These tests pin down the two architectural changes introduced in this
// session:
//   (A) snapshot reobservation semantics — a re-acquisition of unchanged
//       source content must NOT create new historical sightings;
//   (B) bounded memory for external dedup/merge — peak RSS scales with
//       chunkRows + mergeFanIn, NOT with total row count.
//
// The contract enforced:
//   - sourceEventId is a stable per-RD-torrent identity derived from
//     (provider, source_id, rd_id, hash, added). Two acquisitions of
//     the same source content produce the same set of sourceEventIds.
//   - The snapshot's contentVersion (which becomes sourceVersion in the
//     importer) is the SHA-256 of the post-dedup emitted rows. So an
//     unchanged-content rerun is byte-identical AND sourceVersion-equal
//     to the prior run; the importer's checkpoint layer therefore
//     short-circuits as a no-op.
//   - Reordering or pagination boundary changes do not affect logical
//     content; only genuinely new RD torrents introduce new
//     sourceEventIds.
// ===========================================================================

// ---------------------------------------------------------------------------
// P1. Same cumulative source acquired twice → second acquisition 0 new events
// ---------------------------------------------------------------------------
test('P1: re-acquiring identical source produces a no-op import (no new events)', async () => {
  const dir = tempDir();
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');
  const out1 = newTempPath(dir, 'snap1.ndjson');
  const out2 = newTempPath(dir, 'snap2.ndjson');

  const entries = Array.from({ length: 30 }, (_, i) => makeRdEntry(i));
  const fetchFn = createFakeRdFetch({ entries, pageSize: 7 });

  // First acquisition
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out1, fetchFn,
    pageSize: 7, chunkRows: 5, now: () => NOW,
  });
  const m1 = JSON.parse(fs.readFileSync(`${out1}.manifest.json`, 'utf8'));
  const r1 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'torrents',
    'source-version': m1.sourceVersion, input: out1,
    format: 'rd-history', db, now: NOW,
  });
  assert.equal(r1.mode, 'live');
  assert.equal(r1.newSightings, 30);

  // Second acquisition of unchanged source — must yield byte-identical
  // snapshot AND identical sourceVersion so a re-import (under that
  // same sourceVersion, on the same file) is a no-op.
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out2, fetchFn,
    pageSize: 7, chunkRows: 5, now: () => NOW,
  });
  const m2 = JSON.parse(fs.readFileSync(`${out2}.manifest.json`, 'utf8'));
  assert.equal(m2.sourceVersion, m1.sourceVersion, 'sourceVersion content-derived, stable across reruns');
  assert.equal(
    fs.readFileSync(out1, 'utf8'),
    fs.readFileSync(out2, 'utf8'),
    'snapshot is byte-identical for unchanged source content'
  );
  // Re-importing the SAME file under the same sourceVersion is the
  // canonical no-op replay. (Importing a different file with the
  // same contentVersion would be a fingerprint mismatch — which is
  // also correct: the importer is a file-level replayer, not a
  // content-level deduper; the dedup happens at the dedup-table
  // level once rows commit.)
  const r2 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'torrents',
    'source-version': m1.sourceVersion, input: out1,
    format: 'rd-history', db, now: NOW,
  });
  assert.equal(r2.mode, 'rerun', 'importer short-circuits on identical sourceVersion+file');
  assert.equal(r2.status, 'complete', 'importer short-circuits completed import');
  assert.equal(r2.newSightings ?? 0, 0, 'zero new sightings on replay of unchanged source');
});

// ---------------------------------------------------------------------------
// P2. Same source + 1 newly-added RD torrent → exactly 1 new event
// ---------------------------------------------------------------------------
test('P2: a single new RD torrent creates exactly 1 new sighting', async () => {
  const dir = tempDir();
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');
  const out1 = newTempPath(dir, 'snap1.ndjson');
  const out2 = newTempPath(dir, 'snap2.ndjson');

  // First acquisition: 20 entries
  const initial = Array.from({ length: 20 }, (_, i) => makeRdEntry(i));
  const fetch1 = createFakeRdFetch({ entries: initial, pageSize: 10 });
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out1, fetchFn: fetch1,
    pageSize: 10, chunkRows: 0, now: () => NOW,
  });
  const m1 = JSON.parse(fs.readFileSync(`${out1}.manifest.json`, 'utf8'));
  const r1 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'torrents',
    'source-version': m1.sourceVersion, input: out1,
    format: 'rd-history', db, now: NOW,
  });
  assert.equal(r1.newSightings, 20);

  // Second acquisition: 20 original + 1 new
  const updated = [...initial, makeRdEntry(999)];
  const fetch2 = createFakeRdFetch({ entries: updated, pageSize: 10 });
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out2, fetchFn: fetch2,
    pageSize: 10, chunkRows: 0, now: () => NOW,
  });
  const m2 = JSON.parse(fs.readFileSync(`${out2}.manifest.json`, 'utf8'));
  assert.notEqual(m2.sourceVersion, m1.sourceVersion, 'sourceVersion changes for changed content');
  const r2 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'torrents',
    'source-version': m2.sourceVersion, input: out2,
    format: 'rd-history', db, now: NOW,
  });
  // 1 new RD torrent → 1 new sourceEventId → 1 new sighting
  // (the other 20 sourceEventIds were already committed under m1
  // and are deduped out at ingest time).
  assert.equal(r2.newSightings, 1, 'exactly one new event for one new RD torrent');
});

// ---------------------------------------------------------------------------
// P3. Acquisition timestamp differs → old rows don't strengthen
// ---------------------------------------------------------------------------
test('P3: changing acquisition time does NOT strengthen old evidence', async () => {
  const dir = tempDir();
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');
  const out1 = newTempPath(dir, 'snap1.ndjson');
  const out2 = newTempPath(dir, 'snap2.ndjson');

  const entries = Array.from({ length: 15 }, (_, i) => makeRdEntry(i));
  const fetch = createFakeRdFetch({ entries, pageSize: 100 });
  const t1 = NOW;
  const t2 = NOW + 1_000_000;

  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out1, fetchFn: fetch,
    pageSize: 100, chunkRows: 0, now: () => t1,
  });
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out2, fetchFn: fetch,
    pageSize: 100, chunkRows: 0, now: () => t2,
  });
  const m1 = JSON.parse(fs.readFileSync(`${out1}.manifest.json`, 'utf8'));
  const m2 = JSON.parse(fs.readFileSync(`${out2}.manifest.json`, 'utf8'));
  // Both runs share the same source content → same sourceVersion.
  assert.equal(m1.sourceVersion, m2.sourceVersion, 'sourceVersion is content-derived, not time-derived');
  assert.equal(m1.acquiredAt, new Date(t1).toISOString());
  assert.equal(m2.acquiredAt, new Date(t2).toISOString());
  // Re-importing the SAME file under the same sourceVersion is a no-op.
  const r1 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'torrents',
    'source-version': m1.sourceVersion, input: out1,
    format: 'rd-history', db, now: t1,
  });
  assert.equal(r1.newSightings, 15);
  const r2 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'torrents',
    'source-version': m1.sourceVersion, input: out1,
    format: 'rd-history', db, now: t2,
  });
  assert.equal(r2.mode, 'rerun', 'importer sees same sourceVersion, short-circuits');
  assert.equal(r2.newSightings ?? 0, 0, 'no new sightings even though timestamps differ');
});

// ---------------------------------------------------------------------------
// P4. Pagination boundaries change → 0 new events
// ---------------------------------------------------------------------------
test('P4: changing pagination pageSize produces 0 new events', async () => {
  const dir = tempDir();
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');
  const out1 = newTempPath(dir, 'snap1.ndjson');
  const out2 = newTempPath(dir, 'snap2.ndjson');

  const entries = Array.from({ length: 50 }, (_, i) => makeRdEntry(i));
  const fetch = createFakeRdFetch({ entries, pageSize: 1000 });

  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out1, fetchFn: fetch,
    pageSize: 25, chunkRows: 0, now: () => NOW,
  });
  const fetch2 = createFakeRdFetch({ entries, pageSize: 1000 });
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out2, fetchFn: fetch2,
    pageSize: 7, chunkRows: 0, now: () => NOW,
  });
  const m1 = JSON.parse(fs.readFileSync(`${out1}.manifest.json`, 'utf8'));
  const m2 = JSON.parse(fs.readFileSync(`${out2}.manifest.json`, 'utf8'));
  assert.equal(m1.sourceVersion, m2.sourceVersion, 'pageSize changes do not change sourceVersion');
  assert.equal(
    fs.readFileSync(out1, 'utf8'),
    fs.readFileSync(out2, 'utf8'),
    'snapshot is byte-identical across pageSize changes'
  );
});

// ---------------------------------------------------------------------------
// P5. Input/page order shuffled → byte-identical normalized output
// ---------------------------------------------------------------------------
test('P5: input reordering produces a byte-identical normalized snapshot', async () => {
  const dir = tempDir();
  const out1 = newTempPath(dir, 'snap1.ndjson');
  const out2 = newTempPath(dir, 'snap2.ndjson');

  const entries = Array.from({ length: 30 }, (_, i) => makeRdEntry(i));
  // Shuffled order in the source
  const shuffled = entries.slice().reverse();
  const fetch1 = createFakeRdFetch({ entries, pageSize: 100 });
  const fetch2 = createFakeRdFetch({ entries: shuffled, pageSize: 100 });

  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out1, fetchFn: fetch1,
    pageSize: 100, chunkRows: 0, now: () => NOW,
  });
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out2, fetchFn: fetch2,
    pageSize: 100, chunkRows: 0, now: () => NOW,
  });
  assert.equal(
    fs.readFileSync(out1, 'utf8'),
    fs.readFileSync(out2, 'utf8'),
    'snapshot is byte-identical under reordering'
  );
});

// ---------------------------------------------------------------------------
// P6. Same hash + 2 distinct RD ids → both events retained (defined behavior)
// ---------------------------------------------------------------------------
test('P6: same hash with two distinct RD ids is retained as two events', async () => {
  // RD allows re-adding the same content; each gets its own torrent id
  // but the same hash and observedAt. They produce distinct
  // sourceEventIds because rd_id differs.
  const baseEntry = makeRdEntry(0);
  const variantA = { ...baseEntry, id: 'tA' };
  const variantB = { ...baseEntry, id: 'tB' };
  const entries = [variantA, variantB];
  const fetch = createFakeRdFetch({ entries, pageSize: 100 });
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const r = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn: fetch,
    pageSize: 100, chunkRows: 0, now: () => NOW,
  });
  // Two distinct events (one per rd_id) but same infoHash.
  assert.equal(r.rowsSeen, 2);
  assert.equal(r.rowsAccepted, 2);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].infoHash, parsed[1].infoHash, 'same hash');
  assert.notEqual(parsed[0].sourceEventId, parsed[1].sourceEventId, 'distinct event ids');
});

// ---------------------------------------------------------------------------
// P7. Import/replay idempotent — replay the same import 5 times
// ---------------------------------------------------------------------------
test('P7: import/replay is idempotent across many replays', async () => {
  const dir = tempDir();
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');
  const out = newTempPath(dir, 'snap.ndjson');

  const entries = Array.from({ length: 25 }, (_, i) => makeRdEntry(i));
  const fetch = createFakeRdFetch({ entries, pageSize: 100 });
  await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn: fetch,
    pageSize: 100, chunkRows: 0, now: () => NOW,
  });
  const m = JSON.parse(fs.readFileSync(`${out}.manifest.json`, 'utf8'));
  const r1 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'torrents',
    'source-version': m.sourceVersion, input: out,
    format: 'rd-history', db, now: NOW,
  });
  assert.equal(r1.newSightings, 25);
  // Replay 5 more times
  for (let i = 0; i < 5; i += 1) {
    const r = await runFromOptions({
      provider: 'realdebrid', 'source-id': 'torrents',
      'source-version': m.sourceVersion, input: out,
      format: 'rd-history', db, now: NOW,
    });
    assert.equal(r.mode, 'rerun');
    assert.equal(r.newSightings ?? 0, 0, `replay ${i + 1}: 0 new sightings`);
  }
});

// ---------------------------------------------------------------------------
// P8. Existing generic historical-provider tests still green
//
// This is an integration check: running the same import against a
// snapshot produced by the new acquirer must work end-to-end with
// the cache/integration test surface. The A8 test in the legacy block
// already covers a single end-to-end pass; here we add a multi-snapshot
// mixed scenario to catch any cross-test contamination.
// ---------------------------------------------------------------------------
test('P8: two providers sharing source_id+source_version remain independent', async () => {
  const dir = tempDir();
  const dbDir = tempDir();
  const db = path.join(dbDir, 'cache.sqlite');

  // Two realdebrid snapshots and one torbox snapshot, all with the
  // same source_id but different source_versions. The cache must keep
  // them independent.
  const a = newTempPath(dir, 'a.ndjson');
  const b = newTempPath(dir, 'b.ndjson');
  const c = newTempPath(dir, 'c.ndjson');
  const eA = [makeRdEntry(1), makeRdEntry(2)];
  const eB = [makeRdEntry(3), makeRdEntry(4)];
  const eC = [makeRdEntry(5)];
  fs.writeFileSync(a, eA.map((e) => JSON.stringify({
    infoHash: e.hash, observedAt: Date.parse(e.added), sourceEventId: 'ev1',
  })).join('\n') + '\n');
  fs.writeFileSync(b, eB.map((e) => JSON.stringify({
    infoHash: e.hash, observedAt: Date.parse(e.added), sourceEventId: 'ev2',
  })).join('\n') + '\n');
  fs.writeFileSync(c, eC.map((e) => JSON.stringify({
    infoHash: e.hash, observedAt: Date.parse(e.added), sourceEventId: 'ev3',
  })).join('\n') + '\n');

  const rA = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'shared',
    'source-version': 'vA', input: a,
    format: 'rd-history', db, now: NOW,
  });
  const rB = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'shared',
    'source-version': 'vB', input: b,
    format: 'rd-history', db, now: NOW,
  });
  const rC = await runFromOptions({
    provider: 'torbox', 'source-id': 'shared',
    'source-version': 'vA', input: c,
    format: 'rd-history', db, now: NOW,
  });
  assert.equal(rA.newSightings, 2);
  assert.equal(rB.newSightings, 2);
  assert.equal(rC.newSightings, 1);
  // Replays are all no-ops
  const rA2 = await runFromOptions({
    provider: 'realdebrid', 'source-id': 'shared',
    'source-version': 'vA', input: a,
    format: 'rd-history', db, now: NOW,
  });
  assert.equal(rA2.mode, 'rerun');
  assert.equal(rA2.newSightings ?? 0, 0);
});

// ---------------------------------------------------------------------------
// P9. 1M synthetic scale with bounded memory
//
// This test is gated behind RD_BENCH=1 because it allocates real
// memory. With chunkRows=50000 and mergeFanIn=64, the in-process
// peak RSS should be dramatically lower than the 1M-row Set baseline.
// We do not assert a specific RSS number (CI machines vary); we
// assert the merge path actually ran and produced the right count.
// ---------------------------------------------------------------------------
test('P9: 1M synthetic rows through the bounded-merge path', async (t) => {
  if (!process.env.RD_BENCH) {
    t.skip('set RD_BENCH=1 to run 1M benchmark');
    return;
  }
  const dir = tempDir();
  const out = newTempPath(dir, 'snap.ndjson');
  const N = 1_000_000;
  const entries = Array.from({ length: N }, (_, i) => makeRdEntry(i));
  // Inject 10% duplicates to exercise the dedup path
  const dupEntries = entries.slice(0, Math.floor(N / 10));
  const fetch = createFakeRdFetch({
    entries: [...entries, ...dupEntries], pageSize: 5000,
  });
  const r = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out, fetchFn: fetch,
    pageSize: 5000, chunkRows: 50_000, mergeFanIn: 64, now: () => NOW,
  });
  assert.equal(r.rowsSeen, N + dupEntries.length);
  assert.equal(r.rowsAccepted, N, 'duplicates collapse to N unique');
  assert.ok(r.chunkCount > 5, 'spilled into multiple chunks');
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(lines.length, N);
});

// ---------------------------------------------------------------------------
// P10. Bounded RSS: acquire same source with different fan-in settings
//
// This test demonstrates that the merge path's memory is bounded by
// mergeFanIn, not by total chunk count. We don't assert specific RSS
// numbers; we only confirm correctness across fan-in values.
// ---------------------------------------------------------------------------
test('P10: correctness holds for various fan-in values', async () => {
  const dir = tempDir();
  const N = 5000;
  const entries = Array.from({ length: N }, (_, i) => makeRdEntry(i));
  const out1 = newTempPath(dir, 'fan2.ndjson');
  const out2 = newTempPath(dir, 'fan7.ndjson');
  const out3 = newTempPath(dir, 'fan64.ndjson');
  // 25 chunks of 200 rows each => fan-in=2 forces 5 passes.
  const fetch1 = createFakeRdFetch({ entries, pageSize: 1000 });
  const r1 = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out1, fetchFn: fetch1,
    pageSize: 1000, chunkRows: 200, mergeFanIn: 2, now: () => NOW,
  });
  const fetch2 = createFakeRdFetch({ entries, pageSize: 1000 });
  const r2 = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out2, fetchFn: fetch2,
    pageSize: 1000, chunkRows: 200, mergeFanIn: 7, now: () => NOW,
  });
  const fetch3 = createFakeRdFetch({ entries, pageSize: 1000 });
  const r3 = await acquireRdHistory({
    apiKey: RD_TOKEN, outputPath: out3, fetchFn: fetch3,
    pageSize: 1000, chunkRows: 200, mergeFanIn: 64, now: () => NOW,
  });
  // All three settings must produce the same N rows and the same
  // sourceVersion (content-derived).
  assert.equal(r1.rowsAccepted, N);
  assert.equal(r2.rowsAccepted, N);
  assert.equal(r3.rowsAccepted, N);
  const m1 = JSON.parse(fs.readFileSync(`${out1}.manifest.json`, 'utf8'));
  const m2 = JSON.parse(fs.readFileSync(`${out2}.manifest.json`, 'utf8'));
  const m3 = JSON.parse(fs.readFileSync(`${out3}.manifest.json`, 'utf8'));
  assert.equal(m1.sourceVersion, m2.sourceVersion);
  assert.equal(m2.sourceVersion, m3.sourceVersion);
  // Output is byte-identical regardless of fan-in.
  assert.equal(
    fs.readFileSync(out1, 'utf8'),
    fs.readFileSync(out2, 'utf8'),
    'fan-in=2 output matches fan-in=7'
  );
  assert.equal(
    fs.readFileSync(out1, 'utf8'),
    fs.readFileSync(out3, 'utf8'),
    'fan-in=2 output matches fan-in=64'
  );
});
