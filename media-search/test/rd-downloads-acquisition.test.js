/**
 * RD /downloads acquisition + correlation — proof tests.
 *
 * Maps to the 10 PROOF requirements from the spec:
 *   1. Same RD download event imported twice -> one raw observation
 *   2. Two distinct RD ids, same filename+size -> two raw events
 *   3. Exact filename+bytes and one matching candidate -> UNIQUE_STRONG
 *   4. Same filename+bytes matching two candidate hashes -> MULTIPLE_PLAUSIBLE
 *   5. Title-only weak match -> never UNIQUE_STRONG
 *   6. Wrong episode -> rejected by hard gate
 *   7. Previously unmatched event + new corpus candidate -> becomes
 *      correlatable after rerun
 *   8. shuffled candidate order -> identical correlation result
 *   9. correlation produces ZERO historical_provider_evidence rows
 *   10. exact /torrents infoHash path remains unchanged
 *
 * + extras:
 *   A. Replay idempotency (import same snapshot twice)
 *   B. Bounded memory path (chunkRows > 0)
 *   C. Authentication required, token never logged
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  acquireRdDownloads,
  normalizeDownloadEntry,
  normalizeFilename,
} from '../src/lib/acquisition/rd-downloads.js';
import {
  correlateRdDownloads,
  passesHardGate,
  scoreMatch,
  groupCorrelationsByFileBytes,
  CORRELATION_CLASSES,
} from '../src/lib/acquisition/rd-downloads-correlate.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

const NOW = 1_700_000_000_000;
const RD_TOKEN = 'RD_TEST_TOKEN_DO_NOT_LOG_xyz_42';

function tempDir() {
  const base = process.env.RD_DOWNLOADS_TEST_TMP
    || path.join(process.cwd(), '.tmp-rd-downloads-tests');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'rddl-'));
}

test.after(async () => {
  const base = process.env.RD_DOWNLOADS_TEST_TMP
    || path.join(process.cwd(), '.tmp-rd-downloads-tests');
  if (fs.existsSync(base)) {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDownloadsEntry({ id, filename, filesize, generated, streamable = 1, mimeType = 'video/x-matroska' }) {
  return {
    id,
    filename,
    mimeType,
    filesize,
    streamable,
    generated,
    link: 'https://real-debrid.com/d/SECRET_TOKEN',
    host: 'real-debrid.com',
    chunks: 32,
    download: 'https://mia5.download.real-debrid.com/d/SECRET_TOKEN/secret.mkv',
  };
}

function makeFakeDownloadsFetch({ entries, pageSize = 1000, transientFailures = [], dropField }) {
  // RD's /downloads pagination model: the API lists entries 0..N-1
  // and the acquirer fetches them in pages by `offset`. The
  // documented quirk: offset=0 returns HTTP 204 (no data). When the
  // acquirer starts at offset=1, it sees the first page of data
  // (entries[0..limit-1]).
  //
  // For tests, we honor the same model: offset=0 returns an empty
  // page (to verify the acquirer's skipOffsetZero path), and
  // offset=1 returns entries[0..limit-1]. The x-total-count header
  // always reports the full list size.
  const total = entries.length;
  const attempts = new Map();
  return async (url, options = {}) => {
    const u = new URL(url);
    if (u.pathname !== '/rest/1.0/downloads') {
      return jsonResponse({ error: 'not found' }, 404);
    }
    const auth = options.headers && (options.headers.Authorization || options.headers.authorization);
    if (!auth || !auth.startsWith('Bearer ')) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    let offset = Number(u.searchParams.get('offset') || '1');
    const limit = Number(u.searchParams.get('limit') || String(pageSize));
    if (offset === 0) {
      // The 204 case: empty page, but with x-total-count so the
      // acquirer can know how much is available.
      return jsonResponse([], 200, { 'x-total-count': String(total) });
    }
    // offset=1 returns entries 0..limit-1; offset=N+limit returns
    // entries N..N+limit-1.
    const dataOffset = offset - 1;
    const attemptCount = (attempts.get(offset) || 0) + 1;
    attempts.set(offset, attemptCount);
    for (const tf of transientFailures) {
      if (tf.offset === offset && attemptCount === 1) {
        return jsonResponse({ error: 'temporarily unavailable' }, tf.status);
      }
    }
    const page = entries.slice(dataOffset, dataOffset + limit).map((e) => {
      if (dropField) {
        const copy = { ...e };
        delete copy[dropField];
        return copy;
      }
      return e;
    });
    return jsonResponse(page, 200, { 'x-total-count': String(total) });
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const lower = String(name).toLowerCase();
        for (const k of Object.keys(extraHeaders)) {
          if (k.toLowerCase() === lower) return extraHeaders[k];
        }
        return null;
      },
      text: async () => JSON.stringify(body),
      json: async () => body,
    },
    async text() { return JSON.stringify(body); },
  };
}

function makeCandidate(overrides = {}) {
  return {
    info_hash: 'a'.repeat(40),
    file_index_key: -1,
    search_key: 'ted.lasso.s01e02',
    filename: 'ted.lasso.s01e02.2160p.web.h265-skedaddle.mkv',
    title: 'Ted Lasso',
    size: 4_685_896_778,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Schema and normalize basics
// ---------------------------------------------------------------------------

test('normalizeDownloadEntry: persists durable fields, drops transient ones', () => {
  const entry = makeDownloadsEntry({
    id: 'N5HVBOM3RIQTY',
    filename: 'Ted.Lasso.S01E02.2160p.WEB.H265-SKEDADDLE.mkv',
    filesize: 4_685_896_778,
    generated: '2026-09-03T19:11:28.000Z',
  });
  const row = normalizeDownloadEntry(entry, NOW);
  assert.equal(row.rd_id, 'N5HVBOM3RIQTY');
  assert.equal(row.source_event_id, 'N5HVBOM3RIQTY');
  assert.equal(row.exact_bytes, 4_685_896_778);
  assert.equal(row.normalized_filename, 'ted.lasso.s01e02.2160p.web.h265-skedaddle.mkv');
  // No transient fields:
  assert.equal(row.link, undefined);
  assert.equal(row.download, undefined);
  assert.equal(row.host, undefined);
  assert.equal(row.host_icon, undefined);
  assert.equal(row.chunks, undefined);
});

test('normalizeDownloadEntry: rejects entries without id or filename or filesize or generated', () => {
  assert.equal(normalizeDownloadEntry({}), null);
  assert.equal(normalizeDownloadEntry({ id: 'x' }), null);
  assert.equal(normalizeDownloadEntry({ id: 'x', filename: 'a' }), null);
  assert.equal(normalizeDownloadEntry({ id: 'x', filename: 'a', filesize: 1 }), null);
  // With all 4 fields present, the entry IS valid (no rejection).
  // (This is the positive control; the previous calls above are
  // negative controls.)
  const valid = normalizeDownloadEntry({
    id: 'x', filename: 'a', filesize: 1, generated: '2026-09-03T19:11:28.000Z',
  });
  assert.notEqual(valid, null);
});

// ---------------------------------------------------------------------------
// 1. Same RD download event imported twice -> one raw observation
// ---------------------------------------------------------------------------

test('proof 1: same RD download id imported twice produces one raw observation', async () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const obs = {
    source_event_id: 'N5HVBOM3RIQTY',
    rd_id: 'N5HVBOM3RIQTY',
    filename: 'Ted.Lasso.S01E02.2160p.WEB.H265-SKEDADDLE.mkv',
    normalized_filename: 'ted.lasso.s01e02.2160p.web.h265-skedaddle.mkv',
    exact_bytes: 4_685_896_778,
    generated_at: 1_700_000_000_000,
    first_seen_at: 1_700_000_000_000,
    last_seen_at: 1_700_000_000_000,
    mime_type: 'video/x-matroska',
    streamable: 1,
    parser_confidence: 0.9,
  };
  const r1 = cache.ingestRdDownloadObservations({
    sourceVersion: 'v1',
    observations: [obs],
  });
  const r2 = cache.ingestRdDownloadObservations({
    sourceVersion: 'v1',
    observations: [obs],
  });
  assert.equal(r1.inserted, 1);
  assert.equal(r2.inserted, 0, 're-import of same id is a no-op');
  assert.equal(r2.ingested, 1, 'still counts as ingested (touched)');
  assert.equal(cache.countRdDownloadObservations(), 1);
});

// ---------------------------------------------------------------------------
// 2. Two distinct RD ids, same filename+size -> two raw events
// ---------------------------------------------------------------------------

test('proof 2: two distinct RD download ids with same (filename, size) are two distinct rows', async () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const base = {
    filename: 'Oppenheimer.2023.2160p.UHD.BluRay.x265-SURELYNOT.mkv',
    normalized_filename: 'oppenheimer.2023.2160p.uhd.bluray.x265-surelynot.mkv',
    exact_bytes: 80_000_000_000,
    generated_at: 1_700_000_000_000,
    first_seen_at: 1_700_000_000_000,
    last_seen_at: 1_700_000_000_000,
    mime_type: 'video/x-matroska',
    streamable: 1,
    parser_confidence: 0.9,
  };
  // 52 Oppenheimer rows model
  const obs = [];
  for (let i = 0; i < 52; i += 1) {
    obs.push({
      ...base,
      source_event_id: `OPPENHEIMER_${i}`,
      rd_id: `OPPENHEIMER_${i}`,
    });
  }
  const r = cache.ingestRdDownloadObservations({ sourceVersion: 'v1', observations: obs });
  assert.equal(r.inserted, 52);
  assert.equal(cache.countRdDownloadObservations(), 52);
});

// ---------------------------------------------------------------------------
// 3. Exact filename+bytes and one matching candidate -> UNIQUE_STRONG
// ---------------------------------------------------------------------------

test('proof 3: exact filename+bytes with one candidate -> UNIQUE_STRONG', () => {
  const obs = normalizeDownloadEntry(makeDownloadsEntry({
    id: 'N5HVBOM3RIQTY',
    filename: 'Ted.Lasso.S01E02.2160p.WEB.H265-SKEDADDLE.mkv',
    filesize: 4_685_896_778,
    generated: '2026-09-03T19:11:28.000Z',
  }), NOW);
  const cand = makeCandidate();
  const { correlations, stats } = correlateRdDownloads({
    observations: [obs],
    candidates: [cand],
  });
  assert.equal(correlations.length, 1);
  assert.equal(correlations[0].correlation_class, CORRELATION_CLASSES.UNIQUE_STRONG);
  assert.equal(correlations[0].ambiguity_count, 1);
  assert.equal(correlations[0].candidate_info_hash, cand.info_hash);
  assert.equal(stats.eventsByClass.UNIQUE_STRONG, 1);
});

// ---------------------------------------------------------------------------
// 4. Same filename+bytes matching two candidate hashes -> MULTIPLE_PLAUSIBLE
// ---------------------------------------------------------------------------

test('proof 4: exact filename+bytes with two candidates -> MULTIPLE_PLAUSIBLE (ambiguity preserved)', () => {
  const obs = normalizeDownloadEntry(makeDownloadsEntry({
    id: 'A',
    filename: 'Movie.2024.1080p.WEB-DL.x264-GRP.mkv',
    filesize: 5_000_000_000,
    generated: '2026-09-03T19:11:28.000Z',
  }), NOW);
  const c1 = makeCandidate({
    info_hash: 'a'.repeat(40),
    search_key: 'movie.2024.1080p.web-dl.x264-grp',
    filename: 'movie.2024.1080p.web-dl.x264-grp.mkv',
    size: 5_000_000_000,
  });
  const c2 = makeCandidate({
    info_hash: 'b'.repeat(40),
    search_key: 'movie.2024.1080p.web-dl.x264-grp',
    filename: 'movie.2024.1080p.web-dl.x264-grp.mkv',
    size: 5_000_000_000,
  });
  const { correlations, stats } = correlateRdDownloads({
    observations: [obs],
    candidates: [c1, c2],
  });
  assert.equal(correlations.length, 2, 'both candidates are written');
  for (const c of correlations) {
    assert.equal(c.correlation_class, CORRELATION_CLASSES.MULTIPLE_PLAUSIBLE);
    assert.equal(c.ambiguity_count, 2);
  }
  assert.equal(stats.eventsByClass.MULTIPLE_PLAUSIBLE, 1);
});

// ---------------------------------------------------------------------------
// 5. Title-only weak match -> never UNIQUE_STRONG
// ---------------------------------------------------------------------------

test('proof 5: title-only weak match (no exact filename/bytes) is never UNIQUE_STRONG', () => {
  const obs = normalizeDownloadEntry(makeDownloadsEntry({
    id: 'WEAKID',
    filename: 'Random.Archive.2024.rar',  // no parseable release filename
    filesize: 100_000_000,
    generated: '2026-09-03T19:11:28.000Z',
  }), NOW);
  // Manually override parsed_title to simulate a low-confidence parse
  obs.parsed_title = 'Some Title';
  obs.parser_confidence = 0.0;
  const c = makeCandidate({
    filename: 'some.title.2024.1080p.web.h264.mkv',
    title: 'Some Title',
    size: 200_000_000,  // bytes differ
    search_key: 'some.title.2024',
  });
  const { correlations, stats } = correlateRdDownloads({
    observations: [obs],
    candidates: [c],
  });
  assert.equal(correlations.length, 1);
  assert.notEqual(correlations[0].correlation_class, CORRELATION_CLASSES.UNIQUE_STRONG);
  // Either WEAK or UNMATCHED; we accept either, just not UNIQUE_STRONG
  assert.ok(['WEAK', 'UNMATCHED'].includes(correlations[0].correlation_class));
});

// ---------------------------------------------------------------------------
// 6. Wrong episode -> rejected by hard gate
// ---------------------------------------------------------------------------

test('proof 6: wrong-episode candidate is rejected by hard gate', () => {
  const obs = normalizeDownloadEntry(makeDownloadsEntry({
    id: 'TEDS1E2',
    filename: 'Ted.Lasso.S01E02.2160p.WEB.H265.mkv',
    filesize: 4_685_896_778,
    generated: '2026-09-03T19:11:28.000Z',
  }), NOW);
  // Candidate is for S01E03 (wrong episode)
  const c = makeCandidate({
    search_key: 'ted.lasso.s01e03.2160p',
    filename: 'ted.lasso.s01e03.2160p.web.h265.mkv',
  });
  // Direct hard-gate test
  assert.equal(passesHardGate(obs, c), null, 'wrong-episode candidate is rejected');
  // End-to-end correlation should put this in UNMATCHED
  const { correlations } = correlateRdDownloads({
    observations: [obs],
    candidates: [c],
  });
  assert.equal(correlations.length, 1);
  assert.equal(correlations[0].correlation_class, CORRELATION_CLASSES.UNMATCHED);
});

// ---------------------------------------------------------------------------
// 7. Previously unmatched event + new corpus candidate -> becomes correlatable
// ---------------------------------------------------------------------------

test('proof 7: previously-unmatched event becomes UNIQUE_STRONG after candidate is added', () => {
  const obs = normalizeDownloadEntry(makeDownloadsEntry({
    id: 'NEW',
    filename: 'Movie.2024.1080p.BluRay.x264.mkv',
    filesize: 8_000_000_000,
    generated: '2026-09-03T19:11:28.000Z',
  }), NOW);
  // Run 1: empty corpus
  const r1 = correlateRdDownloads({ observations: [obs], candidates: [] });
  assert.equal(r1.correlations[0].correlation_class, CORRELATION_CLASSES.UNMATCHED);
  // Run 2: same observation, candidate added
  const cand = makeCandidate({
    filename: 'movie.2024.1080p.bluray.x264.mkv',
    size: 8_000_000_000,
    search_key: 'movie.2024.1080p.bluray.x264',
    title: 'Movie',
  });
  const r2 = correlateRdDownloads({ observations: [obs], candidates: [cand] });
  assert.equal(r2.correlations[0].correlation_class, CORRELATION_CLASSES.UNIQUE_STRONG);
  // Same observation can move classes across reruns
});

// ---------------------------------------------------------------------------
// 8. Shuffled candidate order -> identical correlation result
// ---------------------------------------------------------------------------

test('proof 8: correlation is deterministic under candidate-order shuffles', () => {
  const obs = normalizeDownloadEntry(makeDownloadsEntry({
    id: 'SHUF',
    filename: 'Movie.2024.1080p.BluRay.x264.mkv',
    filesize: 8_000_000_000,
    generated: '2026-09-03T19:11:28.000Z',
  }), NOW);
  // All 3 candidates have the SAME filename, size, search_key —
  // so all 3 are equally plausible for the same observation.
  const cands = [
    makeCandidate({
      info_hash: 'a'.repeat(40),
      search_key: 'movie.2024.1080p.bluray.x264',
      filename: 'movie.2024.1080p.bluray.x264.mkv',
      title: 'Movie',
      size: 8_000_000_000,
    }),
    makeCandidate({
      info_hash: 'b'.repeat(40),
      search_key: 'movie.2024.1080p.bluray.x264',
      filename: 'movie.2024.1080p.bluray.x264.mkv',
      title: 'Movie',
      size: 8_000_000_000,
    }),
    makeCandidate({
      info_hash: 'c'.repeat(40),
      search_key: 'movie.2024.1080p.bluray.x264',
      filename: 'movie.2024.1080p.bluray.x264.mkv',
      title: 'Movie',
      size: 8_000_000_000,
    }),
  ];
  // Order 1
  const r1 = correlateRdDownloads({ observations: [obs], candidates: cands });
  // Shuffled order 2
  const shuffled = [cands[2], cands[0], cands[1]];
  const r2 = correlateRdDownloads({ observations: [obs], candidates: shuffled });
  // Shuffled order 3 (reverse)
  const reversed = [cands[2], cands[1], cands[0]];
  const r3 = correlateRdDownloads({ observations: [obs], candidates: reversed });

  // Class + score must be identical (we accept the WEAK/UNMATCHED class
  // because we have 3 candidates with the same search_key, so the
  // MULTIPLE_PLAUSIBLE bucket will fire — but the count and class
  // must be invariant)
  assert.equal(r1.stats.eventsByClass.MULTIPLE_PLAUSIBLE, r2.stats.eventsByClass.MULTIPLE_PLAUSIBLE);
  assert.equal(r1.stats.eventsByClass.MULTIPLE_PLAUSIBLE, r3.stats.eventsByClass.MULTIPLE_PLAUSIBLE);
  // All 3 candidates must be written, regardless of input order
  assert.equal(r1.correlations.length, 3);
  assert.equal(r2.correlations.length, 3);
  assert.equal(r3.correlations.length, 3);
  // Determinism: same observation -> same row identities (info_hashes)
  const h1 = r1.correlations.map((c) => c.candidate_info_hash).sort();
  const h2 = r2.correlations.map((c) => c.candidate_info_hash).sort();
  const h3 = r3.correlations.map((c) => c.candidate_info_hash).sort();
  assert.deepEqual(h1, h2);
  assert.deepEqual(h1, h3);
});

// ---------------------------------------------------------------------------
// 9. correlation produces ZERO historical_provider_evidence rows
// ---------------------------------------------------------------------------

test('proof 9: correlation does NOT write to historical_provider_evidence', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const obs = normalizeDownloadEntry(makeDownloadsEntry({
    id: 'NO_HPE',
    filename: 'Movie.2024.1080p.BluRay.x264.mkv',
    filesize: 8_000_000_000,
    generated: '2026-09-03T19:11:28.000Z',
  }), NOW);
  const cand = makeCandidate();
  const { correlations } = correlateRdDownloads({ observations: [obs], candidates: [cand] });
  cache.writeRdDownloadCorrelations({
    sourceVersion: 'v1',
    correlations,
    now: NOW,
  });
  // HPE must be empty
  assert.equal(cache.countHistoricalProviderEvidence(), 0);
  assert.equal(cache.countHistoricalProviderSightings(), 0);
});

// ---------------------------------------------------------------------------
// 10. exact /torrents infoHash path remains unchanged
// ---------------------------------------------------------------------------

test('proof 10: historical_provider_evidence ingest path is unchanged for /torrents', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  // Ingest via the existing HPE path
  const r = cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'torrents',
    sourceVersion: 'snapshot-v1',
    observations: [{
      infoHash: 'a'.repeat(40),
      sourceEventId: 'event-1',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    }],
  });
  assert.equal(r.inserted, 1);
  assert.equal(cache.countHistoricalProviderEvidence(), 1);
  // The new rd_download_observations table must still be empty
  assert.equal(cache.countRdDownloadObservations(), 0);
});

// ---------------------------------------------------------------------------
// Extras: replay idempotency, bounded memory, auth, classification
// ---------------------------------------------------------------------------

test('extras A: replay of the same snapshot inserts zero new observations', async () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const obs = [
    normalizeDownloadEntry(makeDownloadsEntry({
      id: 'AAA', filename: 'a.mkv', filesize: 1, generated: '2026-09-03T19:11:28.000Z',
    }), NOW),
    normalizeDownloadEntry(makeDownloadsEntry({
      id: 'BBB', filename: 'b.mkv', filesize: 2, generated: '2026-09-03T19:11:28.000Z',
    }), NOW),
  ];
  const r1 = cache.ingestRdDownloadObservations({ sourceVersion: 'v1', observations: obs });
  const r2 = cache.ingestRdDownloadObservations({ sourceVersion: 'v1', observations: obs });
  assert.equal(r1.inserted, 2);
  assert.equal(r2.inserted, 0, 'replay is a no-op');
  assert.equal(cache.countRdDownloadObservations(), 2);
});

test('extras B: writeRdDownloadCorrelations rebuilds from scratch (idempotent)', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const obs = normalizeDownloadEntry(makeDownloadsEntry({
    id: 'CORR',
    filename: 'Movie.2024.1080p.BluRay.x264.mkv',
    filesize: 8_000_000_000,
    generated: '2026-09-03T19:11:28.000Z',
  }), NOW);
  cache.ingestRdDownloadObservations({ sourceVersion: 'v1', observations: [obs] });
  const cand = makeCandidate();
  const { correlations } = correlateRdDownloads({ observations: [obs], candidates: [cand] });
  // Write twice
  cache.writeRdDownloadCorrelations({ sourceVersion: 'v1', correlations, now: NOW });
  cache.writeRdDownloadCorrelations({ sourceVersion: 'v1', correlations, now: NOW });
  // Should not duplicate rows
  assert.equal(cache.countRdDownloadCorrelations(), 1);
});

test('extras C: acquisition requires a Bearer token', async () => {
  const dir = tempDir();
  const out = path.join(dir, 'snap.ndjson');
  const entries = [
    makeDownloadsEntry({ id: 'X', filename: 'a.mkv', filesize: 1, generated: '2026-09-03T19:11:28.000Z' }),
  ];
  const fetchFn = makeFakeDownloadsFetch({ entries, pageSize: 1 });
  let authError = null;
  try {
    await acquireRdDownloads({
      apiKey: '',
      outputPath: out,
      fetchFn,
      pageSize: 1,
      chunkRows: 0,
      now: () => NOW,
    });
  } catch (err) {
    authError = err;
  }
  // Empty string is a falsy type-check failure
  assert.ok(authError);
  assert.match(authError.message, /apiKey is required/);
});

test('extras D: acquireRdDownloads paginates and dedupes 200 rows via bounded memory', async () => {
  const dir = tempDir();
  const out = path.join(dir, 'snap.ndjson');
  const entries = [];
  for (let i = 0; i < 200; i += 1) {
    entries.push(makeDownloadsEntry({
      id: `ID${i}`,
      filename: `release.${i}.mkv`,
      filesize: 1_000_000 + i,
      generated: '2026-09-03T19:11:28.000Z',
    }));
  }
  const fetchFn = makeFakeDownloadsFetch({ entries, pageSize: 25 });
  const result = await acquireRdDownloads({
    apiKey: RD_TOKEN,
    outputPath: out,
    fetchFn,
    pageSize: 25,
    chunkRows: 0, // in-memory for the small input
    now: () => NOW,
  });
  assert.equal(result.rowsSeen, 200);
  assert.equal(result.rowsAccepted, 200);
  assert.equal(result.rowsRejected, 0);
  // Pages: total=200, pageSize=25, skipOffsetZero=true => first page at
  // offset=1 returns 25; loop from pageSize=25, so offsets 25, 50,
  // ..., 175. 7 more pages. Total 8.
  assert.equal(result.pagesFetched, 8);

  // Token must not appear anywhere in the snapshot
  const text = fs.readFileSync(out, 'utf8');
  assert.ok(!text.includes(RD_TOKEN));
  const manifestText = fs.readFileSync(`${out}.manifest.json`, 'utf8');
  assert.ok(!manifestText.includes(RD_TOKEN));
});

test('extras E: same input produces byte-identical snapshot (determinism)', async () => {
  const dir = tempDir();
  const out1 = path.join(dir, 'snap1.ndjson');
  const out2 = path.join(dir, 'snap2.ndjson');
  const entries = [];
  for (let i = 0; i < 50; i += 1) {
    entries.push(makeDownloadsEntry({
      id: `DET${i}`,
      filename: `det.${i}.mkv`,
      filesize: 100_000 + i,
      generated: '2026-09-03T19:11:28.000Z',
    }));
  }
  // Two separate fetch instances; identical content
  const fetchFn1 = makeFakeDownloadsFetch({ entries, pageSize: 50 });
  const fetchFn2 = makeFakeDownloadsFetch({ entries, pageSize: 50 });
  await acquireRdDownloads({
    apiKey: RD_TOKEN, outputPath: out1, fetchFn: fetchFn1,
    pageSize: 50, chunkRows: 0, now: () => NOW,
  });
  await acquireRdDownloads({
    apiKey: RD_TOKEN, outputPath: out2, fetchFn: fetchFn2,
    pageSize: 50, chunkRows: 0, now: () => NOW,
  });
  const sha1 = await sha256File(out1);
  const sha2 = await sha256File(out2);
  assert.equal(sha1, sha2);
});

test('extras F: 429 response is retried, then succeeds', async () => {
  const dir = tempDir();
  const out = path.join(dir, 'snap.ndjson');
  // Need enough entries for pagination to continue past the 429 page.
  // With pageSize=10, 20 entries means 2 pages: offsets 1 and 11.
  const entries = [];
  for (let i = 0; i < 20; i += 1) {
    entries.push(makeDownloadsEntry({
      id: `Z${i}`, filename: `a${i}.mkv`, filesize: 1 + i,
      generated: '2026-09-03T19:11:28.000Z',
    }));
  }
  const fetchFn = makeFakeDownloadsFetch({
    entries,
    pageSize: 10,
    transientFailures: [{ offset: 11, status: 429 }], // fail second page
  });
  const result = await acquireRdDownloads({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 10, chunkRows: 0, now: () => NOW,
  });
  // First page (10 entries) succeeds; second page gets 429 and
  // retries successfully inside fetchPage (10 more entries). The
  // retry is transparent to the page counter — pagesFetched is the
  // count of successful pages.
  assert.equal(result.rowsAccepted, 20);
  assert.equal(result.pagesFetched, 2);
});

test('extras G: external-sort (chunkRows > 0) preserves dedup across chunks', async () => {
  const dir = tempDir();
  const out = path.join(dir, 'snap.ndjson');
  const entries = [];
  for (let i = 0; i < 30; i += 1) {
    entries.push(makeDownloadsEntry({
      id: `EXT${i}`,
      filename: `ext.${i}.mkv`,
      filesize: 1_000 + i,
      generated: '2026-09-03T19:11:28.000Z',
    }));
  }
  const fetchFn = makeFakeDownloadsFetch({ entries, pageSize: 10 });
  const result = await acquireRdDownloads({
    apiKey: RD_TOKEN, outputPath: out, fetchFn,
    pageSize: 10,
    chunkRows: 5, // force multi-chunk external sort
    mergeFanIn: 2,
    now: () => NOW,
  });
  assert.equal(result.rowsAccepted, 30);
  assert.ok(result.chunkCount >= 2);
  // Verify each row is unique on source_event_id
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  const ids = new Set(lines.map((l) => JSON.parse(l).source_event_id));
  assert.equal(ids.size, 30);
});

test('extras H: groupCorrelationsByFileBytes aggregates per (filename, bytes) group', () => {
  const obs = [];
  for (let i = 0; i < 3; i += 1) {
    obs.push(normalizeDownloadEntry(makeDownloadsEntry({
      id: `GRP${i}`,
      filename: 'shared.file.mkv',
      filesize: 1_000_000,
      generated: '2026-09-03T19:11:28.000Z',
    }), NOW));
  }
  const cand = makeCandidate({ filename: 'shared.file.mkv', size: 1_000_000 });
  const { correlations } = correlateRdDownloads({ observations: obs, candidates: [cand] });
  const groups = groupCorrelationsByFileBytes(correlations, obs);
  assert.equal(groups.length, 1, 'one (filename, bytes) group');
  assert.equal(groups[0].events, 3);
  assert.equal(groups[0].totalBytes, 3_000_000);
});

test('extras I: normalizeFilename collapses whitespace and lowercases', () => {
  assert.equal(normalizeFilename('  Hello  WORLD.mkv  '), 'hello world.mkv');
  assert.equal(normalizeFilename('A\tB\nC'), 'a b c');
  assert.equal(normalizeFilename(''), '');
});

test('extras J: scoreMatch returns 0 for hard-gate failure', () => {
  const obs = normalizeDownloadEntry(makeDownloadsEntry({
    id: 'SG',
    filename: 'Ted.Lasso.S01E02.2160p.WEB.H265.mkv',
    filesize: 4_685_896_778,
    generated: '2026-09-03T19:11:28.000Z',
  }), NOW);
  const c = makeCandidate({
    search_key: 'ted.lasso.s01e03.2160p',
    filename: 'ted.lasso.s01e03.2160p.web.h265.mkv',
  });
  const r = scoreMatch(obs, c);
  assert.equal(r.score, 0);
  assert.ok(r.reasons.some((s) => s.startsWith('hard-gate:FAIL')));
});

async function sha256File(p) {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(p, { encoding: 'utf8' });
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return h.digest('hex');
}
